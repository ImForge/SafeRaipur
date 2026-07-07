"""
Risk scoring service.

Given a list of incidents, produce a per-point or per-grid risk score
using kernel density estimation (KDE) with:

  1. Severity weights  — sexual assault counts more than theft
  2. Time decay        — old incidents fade out exponentially
  3. Spatial spread    — each incident becomes a Gaussian bump,
                         not a single dot

This is what makes the heatmap look smooth and meaningful instead of
just a bunch of disconnected dots.
"""

import math
from datetime import datetime, timezone
from typing import List, Dict, Tuple


# How fast incidents fade. The constant 0.00385 gives a half-life of ~180 days
# (because exp(-0.00385 * 180) ≈ 0.5). Tune this for your needs.
TIME_DECAY_LAMBDA = 0.00385

# Spatial bandwidth in degrees (~ 200m at Raipur's latitude).
# 1 degree of latitude ≈ 111km, so 0.002° ≈ 222m.
KDE_BANDWIDTH_DEG = 0.002


def time_decay(occurred_at: datetime) -> float:
    """Exponential decay based on how many days ago this happened."""
    now = datetime.now(timezone.utc)
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    days_old = (now - occurred_at).total_seconds() / 86400
    return math.exp(-TIME_DECAY_LAMBDA * days_old)


def incident_weight(severity: int, occurred_at: datetime, source: str = "news") -> float:
    """
    Combine severity with time decay and source-trust weighting.
    News-reported and NCRB-data weight = 1.0
    Unverified user reports weight = 0.5 (until corroborated by others)
    """
    trust = 1.0 if source in ("news", "ncrb", "manual") else 0.5
    return severity * time_decay(occurred_at) * trust


def is_night_hour(hour: int) -> bool:
    """7pm–6am is 'night'. Adjust if you want different windows."""
    return hour < 6 or hour >= 19


def filter_by_time_of_day(incidents: list, time_of_day: str) -> list:
    """Return only incidents matching the requested time-of-day."""
    def match(inc):
        h = inc.occurred_at.hour
        return is_night_hour(h) if time_of_day == "night" else not is_night_hour(h)
    return [i for i in incidents if match(i)]


def compute_kde_grid(
    incidents: list,
    bbox: Tuple[float, float, float, float],
    resolution: int = 50,
) -> List[Dict]:
    """
    Compute risk score on an N×N grid over the bounding box.

    bbox = (min_lat, min_lng, max_lat, max_lng)

    For each grid cell we sum the contribution of every incident,
    where contribution = weight * gaussian(distance / bandwidth).
    """
    min_lat, min_lng, max_lat, max_lng = bbox
    lat_step = (max_lat - min_lat) / resolution
    lng_step = (max_lng - min_lng) / resolution
    cells = []

    # Precompute incident positions and weights (so we don't redo it per cell)
    inc_data = []
    for inc in incidents:
        # Geometry column comes back as WKB; in real code use to_shape().
        # Here we assume the caller passes lat/lng tuples for simplicity.
        lat = getattr(inc, "lat", None) or inc.location.y  # fallback
        lng = getattr(inc, "lng", None) or inc.location.x
        w = incident_weight(inc.severity, inc.occurred_at, getattr(inc, "source", "news"))
        inc_data.append((lat, lng, w))

    h2 = KDE_BANDWIDTH_DEG ** 2

    for i in range(resolution):
        for j in range(resolution):
            cy = min_lat + (i + 0.5) * lat_step
            cx = min_lng + (j + 0.5) * lng_step
            total = 0.0
            for lat, lng, w in inc_data:
                d2 = (lat - cy) ** 2 + (lng - cx) ** 2
                # Gaussian kernel — drops off quickly past the bandwidth
                total += w * math.exp(-d2 / (2 * h2))
            if total > 0.05:  # skip near-zero cells for payload size
                cells.append({"lat": cy, "lng": cx, "weight": total})

    return cells


def cluster_hotspots(incidents: list, eps_meters: float = 400, min_samples: int = 3) -> List[Dict]:
    """
    Tiny DBSCAN-lite. Groups nearby incidents into hotspots.

    For production you'd swap this for sklearn.cluster.DBSCAN with a
    haversine metric on radians-converted coordinates. This pure-python
    version is fine for the scale of a single city.
    """
    def haversine(a, b):
        R = 6_371_000
        dlat = math.radians(b[0] - a[0])
        dlng = math.radians(b[1] - a[1])
        x = (math.sin(dlat/2) ** 2 +
             math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) *
             math.sin(dlng/2) ** 2)
        return 2 * R * math.asin(math.sqrt(x))

    points = []
    for inc in incidents:
        lat = getattr(inc, "lat", None) or inc.location.y
        lng = getattr(inc, "lng", None) or inc.location.x
        points.append((lat, lng, inc))

    visited = [False] * len(points)
    clusters = []

    for i, p in enumerate(points):
        if visited[i]:
            continue
        neighbors = [j for j, q in enumerate(points)
                     if haversine((p[0], p[1]), (q[0], q[1])) < eps_meters]
        if len(neighbors) < min_samples:
            visited[i] = True
            continue

        # New cluster
        cluster = []
        queue = list(neighbors)
        while queue:
            k = queue.pop()
            if visited[k]:
                continue
            visited[k] = True
            cluster.append(points[k])
            knbrs = [j for j, q in enumerate(points)
                     if haversine((points[k][0], points[k][1]), (q[0], q[1])) < eps_meters]
            if len(knbrs) >= min_samples:
                queue.extend(knbrs)
        clusters.append(cluster)

    # Score each cluster
    results = []
    for c in clusters:
        lat = sum(p[0] for p in c) / len(c)
        lng = sum(p[1] for p in c) / len(c)
        score = sum(incident_weight(p[2].severity, p[2].occurred_at,
                                    getattr(p[2], "source", "news")) for p in c)
        # Use the most common area name from incidents in this cluster
        areas = [p[2].area or "Unknown" for p in c]
        area_name = max(set(areas), key=areas.count)
        results.append({
            "area": area_name,
            "lat": lat,
            "lng": lng,
            "score": round(score * 4),  # scale to 0–100ish
            "incident_count": len(c),
        })

    return sorted(results, key=lambda h: h["score"], reverse=True)
