"""
ORM models. Two tables:

  incidents       — every known incident (news-scraped or seed)
  user_reports    — anonymous user-submitted reports

We keep them separate because:
  - user_reports need moderation before they count toward the heatmap
  - they have different trust levels in the risk formula
"""

from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean, Text
from sqlalchemy.sql import func
from geoalchemy2 import Geometry

from database import Base


class Incident(Base):
    __tablename__ = "incidents"

    id = Column(Integer, primary_key=True, index=True)
    type = Column(String(50), nullable=False, index=True)
    severity = Column(Integer, nullable=False)
    area = Column(String(200))
    description = Column(Text)
    source = Column(String(50))            # "news" | "ncrb" | "manual"
    source_url = Column(String(500))
    occurred_at = Column(DateTime(timezone=True), nullable=False, index=True)
    # PostGIS geometry column — SRID 4326 = WGS84 (lat/lng standard)
    location = Column(Geometry("POINT", srid=4326), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class UserReport(Base):
    __tablename__ = "user_reports"

    id = Column(Integer, primary_key=True, index=True)
    type = Column(String(50), nullable=False)
    severity = Column(Integer, nullable=False)
    time_of_day = Column(String(10))       # "day" | "night"
    occurred_at = Column(DateTime(timezone=True), server_default=func.now())
    location = Column(Geometry("POINT", srid=4326), nullable=False)
    # Trust signals
    is_verified = Column(Boolean, default=False)
    corroboration_count = Column(Integer, default=1)
    # Anonymous user tracking — we hash a device fingerprint, never store identity
    anonymous_id = Column(String(64), index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PoliceStation(Base):
    __tablename__ = "police_stations"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(20))
    location = Column(Geometry("POINT", srid=4326), nullable=False)
