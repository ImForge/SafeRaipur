"""Pydantic schemas for API I/O."""

from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel, Field


class IncidentOut(BaseModel):
    id: int
    type: str
    severity: int
    area: Optional[str] = None
    description: Optional[str] = None
    source: Optional[str] = None
    lat: float
    lng: float
    occurred_at: datetime

    class Config:
        from_attributes = True


class ReportIn(BaseModel):
    type: str = Field(..., description="harassment | stalking | chain_snatching | theft | assault | sexual_assault | suspicious")
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    time_of_day: str = Field("night", pattern="^(day|night)$")
    description: Optional[str] = Field(None, max_length=500)
    # Anonymous device fingerprint hash from client (e.g. browser+install id sha256)
    anonymous_id: Optional[str] = None


class ReportOut(BaseModel):
    id: int
    type: str
    severity: int
    lat: float
    lng: float
    is_verified: bool
    occurred_at: datetime

    class Config:
        from_attributes = True


class Hotspot(BaseModel):
    area: str
    lat: float
    lng: float
    score: int
    incident_count: int


class RiskCell(BaseModel):
    lat: float
    lng: float
    weight: float


class RiskGrid(BaseModel):
    time_of_day: str
    cells: List[RiskCell]


class PoliceStationOut(BaseModel):
    id: int
    name: str
    phone: Optional[str] = None
    lat: float
    lng: float
