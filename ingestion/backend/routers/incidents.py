"""
/api/incidents — list and filter incidents.

Demonstrates PostGIS in action:
  - ST_X / ST_Y to pull lat/lng back out of the geometry column
  - EXTRACT(HOUR FROM ...) for time-of-day filtering
  - A spatial bounding-box filter so we don't ship every incident
    to the client when they only want one neighborhood
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, text
from typing import Optional, List

from database import get_db
from models import Incident
from schemas import IncidentOut

router = APIRouter()


@router.get("/incidents", response_model=List[IncidentOut])
def list_incidents(
    time_of_day: Optional[str] = Query(None, pattern="^(day|night)$"),
    min_lat: Optional[float] = None,
    min_lng: Optional[float] = None,
    max_lat: Optional[float] = None,
    max_lng: Optional[float] = None,
    db: Session = Depends(get_db),
):
    """
    Return incidents, optionally filtered by:
      - time_of_day  ('day' or 'night')
      - bounding box (min_lat, min_lng, max_lat, max_lng)
    """
    # Build the SELECT with lat/lng extracted from geometry
    q = db.query(
        Incident.id,
        Incident.type,
        Incident.severity,
        Incident.area,
        Incident.description,
        Incident.source,
        Incident.occurred_at,
        func.ST_Y(Incident.location).label("lat"),
        func.ST_X(Incident.location).label("lng"),
    )

    # Time-of-day filter: night = hour < 6 OR hour >= 19
    if time_of_day == "night":
        q = q.filter(text("EXTRACT(HOUR FROM occurred_at) < 6 "
                          "OR EXTRACT(HOUR FROM occurred_at) >= 19"))
    elif time_of_day == "day":
        q = q.filter(text("EXTRACT(HOUR FROM occurred_at) >= 6 "
                          "AND EXTRACT(HOUR FROM occurred_at) < 19"))

    # Spatial bounding box (PostGIS ST_MakeEnvelope + && operator)
    if all(v is not None for v in (min_lat, min_lng, max_lat, max_lng)):
        q = q.filter(text(
            "location && ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, 4326)"
        )).params(minx=min_lng, miny=min_lat, maxx=max_lng, maxy=max_lat)

    return [
        IncidentOut(
            id=r.id, type=r.type, severity=r.severity, area=r.area,
            description=r.description, source=r.source,
            lat=r.lat, lng=r.lng, occurred_at=r.occurred_at,
        )
        for r in q.all()
    ]
