"""
/api/reports — accept anonymous incident reports from users.

Critical ethical/safety logic lives here:

  - We never store identifying data; only an anonymous device hash
  - We rate-limit per anonymous_id (simple in-memory bucket here;
    use Redis in production)
  - A single report is *unverified*. Once N other reports land
    within R meters and T days, we flip is_verified = True and the
    report starts influencing the public heatmap.

This corroboration step is what stops a single bad actor from
defacing your map by spamming reports.
"""

from collections import defaultdict
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func, text

from database import get_db
from models import UserReport
from schemas import ReportIn, ReportOut

router = APIRouter()


# Severity defaults per incident type. The client can't pick its own severity
# — we set it server-side to prevent abuse.
TYPE_TO_SEVERITY = {
    "harassment": 2,
    "stalking": 4,
    "chain_snatching": 3,
    "theft": 2,
    "assault": 6,
    "sexual_assault": 10,
    "suspicious": 1,
}

# Corroboration parameters
CORROBORATION_RADIUS_M = 200       # within 200m
CORROBORATION_WINDOW_DAYS = 30     # within last 30 days
CORROBORATION_THRESHOLD = 2        # need 2+ matching reports total

# Simple in-memory rate limit. Replace with Redis in production.
_recent_submissions = defaultdict(list)
RATE_LIMIT_PER_HOUR = 5


def _check_rate_limit(anonymous_id: str):
    if not anonymous_id:
        return
    now = datetime.utcnow()
    cutoff = now - timedelta(hours=1)
    _recent_submissions[anonymous_id] = [
        t for t in _recent_submissions[anonymous_id] if t > cutoff
    ]
    if len(_recent_submissions[anonymous_id]) >= RATE_LIMIT_PER_HOUR:
        raise HTTPException(429, "Too many reports from this device. Please try later.")
    _recent_submissions[anonymous_id].append(now)


@router.post("/reports", response_model=ReportOut)
def create_report(payload: ReportIn, db: Session = Depends(get_db)):
    _check_rate_limit(payload.anonymous_id or "")

    severity = TYPE_TO_SEVERITY.get(payload.type, 3)

    # Create the new report
    new_report = UserReport(
        type=payload.type,
        severity=severity,
        time_of_day=payload.time_of_day,
        anonymous_id=payload.anonymous_id,
        location=func.ST_SetSRID(func.ST_MakePoint(payload.lng, payload.lat), 4326),
    )
    db.add(new_report)
    db.flush()  # so we get the id

    # Check for corroboration nearby
    cutoff = datetime.utcnow() - timedelta(days=CORROBORATION_WINDOW_DAYS)
    nearby_count = db.execute(
        text("""
            SELECT COUNT(*) FROM user_reports
            WHERE id != :rid
              AND type = :type
              AND occurred_at > :cutoff
              AND ST_DWithin(
                location::geography,
                ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography,
                :radius
              )
        """),
        {
            "rid": new_report.id,
            "type": payload.type,
            "cutoff": cutoff,
            "lat": payload.lat,
            "lng": payload.lng,
            "radius": CORROBORATION_RADIUS_M,
        },
    ).scalar()

    if nearby_count + 1 >= CORROBORATION_THRESHOLD:
        new_report.is_verified = True
        new_report.corroboration_count = nearby_count + 1

    db.commit()
    db.refresh(new_report)

    return ReportOut(
        id=new_report.id,
        type=new_report.type,
        severity=new_report.severity,
        lat=payload.lat,
        lng=payload.lng,
        is_verified=new_report.is_verified,
        occurred_at=new_report.occurred_at,
    )
