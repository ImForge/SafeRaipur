"""
/api/risk-grid    — returns a grid of weighted points for the frontend heatmap
/api/hotspots     — returns top N clustered hotspots
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List

from database import get_db
from models import Incident, UserReport
from schemas import RiskGrid, RiskCell, Hotspot
from services.kde import (
    compute_kde_grid,
    cluster_hotspots,
    filter_by_time_of_day,
    is_night_hour,
)

router = APIRouter()


def _gather_incidents(db: Session, time_of_day: str, include_unverified: bool = False):
    """Pull incidents + verified user reports into a single list with lat/lng."""
    class _Pt:
        """Minimal struct that looks like an Incident to our KDE code."""
        def __init__(self, lat, lng, severity, occurred_at, source, area=""):
            self.lat = lat
            self.lng = lng
            self.severity = severity
            self.occurred_at = occurred_at
            self.source = source
            self.area = area

    rows = db.query(
        func.ST_Y(Incident.location).label("lat"),
        func.ST_X(Incident.location).label("lng"),
        Incident.severity, Incident.occurred_at, Incident.source, Incident.area,
    ).all()
    items = [_Pt(r.lat, r.lng, r.severity, r.occurred_at, r.source, r.area) for r in rows]

    user_q = db.query(
        func.ST_Y(UserReport.location).label("lat"),
        func.ST_X(UserReport.location).label("lng"),
        UserReport.severity, UserReport.occurred_at,
    )
    if not include_unverified:
        user_q = user_q.filter(UserReport.is_verified == True)
    for r in user_q.all():
        items.append(_Pt(r.lat, r.lng, r.severity, r.occurred_at, "crowd", "User report"))

    # Time-of-day filter
    return filter_by_time_of_day(items, time_of_day)


@router.get("/risk-grid", response_model=RiskGrid)
def get_risk_grid(
    time_of_day: str = Query("night", pattern="^(day|night)$"),
    min_lat: float = 21.10,
    min_lng: float = 81.54,
    max_lat: float = 21.38,
    max_lng: float = 81.80,
    resolution: int = Query(50, ge=10, le=100),
    db: Session = Depends(get_db),
):
    """Compute KDE risk surface over a bounding box."""
    incidents = _gather_incidents(db, time_of_day)
    cells = compute_kde_grid(
        incidents,
        bbox=(min_lat, min_lng, max_lat, max_lng),
        resolution=resolution,
    )
    return RiskGrid(
        time_of_day=time_of_day,
        cells=[RiskCell(**c) for c in cells],
    )


@router.get("/hotspots", response_model=List[Hotspot])
def get_hotspots(
    time_of_day: str = Query("night", pattern="^(day|night)$"),
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
):
    """DBSCAN-clustered hotspots, top N by total risk score."""
    incidents = _gather_incidents(db, time_of_day)
    hotspots = cluster_hotspots(incidents)
    return [Hotspot(**h) for h in hotspots[:limit]]