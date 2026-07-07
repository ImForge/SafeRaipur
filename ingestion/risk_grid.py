"""
Risk grid — the same KDE math from backend/services/kde.py, but PRECOMPUTED.

Old world: every /api/risk-grid request recomputed 2,500–10,000 cells × every
incident in pure Python on a sleepy 512 MB Render box. Slow, and it's what
made the server heavy.

New world: this runs once per ingestion cycle (every 30 min) in GitHub
Actions, and writes the finished grid into the risk_cells table. The map
reads a finished answer. Nothing can time out.

Formula per cell (unchanged from v1 — your original math):
  score(cell) = Σ over incidents [ severity × exp(-λ·days_old) × trust
                                   × exp(-dist² / 2σ²) ]
  λ = 0.00385  → 180-day half-life
  σ = 0.002°   → ~220 m Gaussian bandwidth
  trust: news/seed = 1.0, unverified community report = 0.5, verified = 1.0
Scores are normalized 0..1 per time-of-day grid so the frontend gradient
is stable regardless of how much data exists.
"""

import math
from datetime import datetime, timezone

LAMBDA = 0.00385
BANDWIDTH = 0.002
BBOX = (21.10, 81.54, 21.38, 81.80)   # min_lat, min_lng, max_lat, max_lng
RESOLUTION = 60                        # 60×60 = 3,600 cells


def _decay(occurred_at: datetime) -> float:
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    days = (datetime.now(timezone.utc) - occurred_at).total_seconds() / 86400
    return math.exp(-LAMBDA * days)


def _is_night(dt: datetime) -> bool:
    return dt.hour < 6 or dt.hour >= 19


def compute_grid(points, time_of_day: str):
    """
    points: list of dicts {lat, lng, severity, occurred_at(datetime), trust}
    Returns list of {time_of_day, lat, lng, score} — only non-trivial cells,
    so we don't store thousands of zero rows.
    """
    pts = [p for p in points
           if (_is_night(p["occurred_at"]) if time_of_day == "night"
               else not _is_night(p["occurred_at"]))]

    min_lat, min_lng, max_lat, max_lng = BBOX
    dlat = (max_lat - min_lat) / RESOLUTION
    dlng = (max_lng - min_lng) / RESOLUTION
    two_sigma_sq = 2 * BANDWIDTH * BANDWIDTH
    cutoff = BANDWIDTH * 4  # beyond 4σ contribution is ~0 — skip the math

    # Precompute per-incident weight once
    weighted = [
        (p["lat"], p["lng"], p["severity"] * _decay(p["occurred_at"]) * p["trust"])
        for p in pts
    ]

    cells = []
    max_score = 0.0
    for i in range(RESOLUTION):
        clat = min_lat + (i + 0.5) * dlat
        for j in range(RESOLUTION):
            clng = min_lng + (j + 0.5) * dlng
            s = 0.0
            for plat, plng, w in weighted:
                d_lat = clat - plat
                d_lng = clng - plng
                if abs(d_lat) > cutoff or abs(d_lng) > cutoff:
                    continue
                dist_sq = d_lat * d_lat + d_lng * d_lng
                s += w * math.exp(-dist_sq / two_sigma_sq)
            if s > 0.01:
                cells.append({"time_of_day": time_of_day,
                              "lat": round(clat, 5), "lng": round(clng, 5),
                              "score": s})
                max_score = max(max_score, s)

    # Normalize 0..1
    if max_score > 0:
        for c in cells:
            c["score"] = round(c["score"] / max_score, 4)
    return cells
