"""
Raipur Safe Map — FastAPI backend.

This service exposes:
  GET  /api/incidents            — list incidents, optionally filtered by time-of-day
  POST /api/reports              — submit an anonymous incident report
  GET  /api/risk-grid            — get a grid of risk scores for map rendering
  GET  /api/hotspots             — cluster top hotspots
  GET  /api/police-stations      — list police stations
  POST /api/safe-route           — minimal stub for safe-route routing (Phase 5)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import incidents, reports, risk
from database import engine
from models import Base

# create tables on startup if they don't exist
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Raipur Safe Map API",
    description="Backend for Raipur women's safety mapping app.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(incidents.router, prefix="/api", tags=["incidents"])
app.include_router(reports.router, prefix="/api", tags=["reports"])
app.include_router(risk.router, prefix="/api", tags=["risk"])


@app.get("/")
def root():
    return {
        "service": "Raipur Safe Map API",
        "version": "0.1.0",
        "docs": "/docs",
    }


@app.get("/health")
def health():
    return {"status": "ok"}