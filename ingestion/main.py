"""
SafeRaipur ingestion — the whole pipeline in one run.

  1. Pull fresh crime articles (Google News RSS, EN + HI)
  2. Classify each → (crime_type, severity)          [classify.py]
  3. Geocode each → Raipur locality lat/lng           [geocode.py]
  4. Upsert into Supabase `incidents` (dedupe on url_hash)
  5. Pull ALL incidents + reports back down
  6. Recompute day + night risk grids                 [risk_grid.py]
  7. Replace `risk_cells`
  8. Write a row to `ingest_log` so you can watch it from the dashboard

Runs in GitHub Actions every 30 minutes (see .github/workflows/ingest.yml).
Needs two env vars (stored as GitHub repo secrets):
  SUPABASE_URL          e.g. https://abcdxyz.supabase.co
  SUPABASE_SERVICE_KEY  the service_role key (Settings → API) — server only,
                        NEVER put this in the frontend
"""

import os
import sys
from datetime import datetime, timezone

import requests

from classify import classify
from geocode import geocode
from scrape import fetch_articles
from risk_grid import compute_grid

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}


def sb(path: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{path}"


def upsert_incidents(rows):
    """Insert new incidents; rows with an existing url_hash are ignored."""
    if not rows:
        return 0
    r = requests.post(
        sb("incidents?on_conflict=url_hash"),
        headers={**HEADERS,
                 "Prefer": "resolution=ignore-duplicates,return=representation"},
        json=rows, timeout=30,
    )
    r.raise_for_status()
    return len(r.json())


def fetch_all_points():
    """Pull incidents + visible reports for the grid recompute."""
    points = []

    r = requests.get(
        sb("incidents?select=lat,lng,severity,occurred_at&limit=5000"),
        headers=HEADERS, timeout=30)
    r.raise_for_status()
    for row in r.json():
        points.append({
            "lat": row["lat"], "lng": row["lng"], "severity": row["severity"],
            "occurred_at": datetime.fromisoformat(row["occurred_at"].replace("Z", "+00:00")),
            "trust": 1.0,
        })

    r = requests.get(
        sb("user_reports?select=lat,lng,severity,occurred_at,is_verified"
           "&is_hidden=eq.false&limit=5000"),
        headers=HEADERS, timeout=30)
    r.raise_for_status()
    for row in r.json():
        points.append({
            "lat": row["lat"], "lng": row["lng"], "severity": row["severity"],
            "occurred_at": datetime.fromisoformat(row["occurred_at"].replace("Z", "+00:00")),
            "trust": 1.0 if row["is_verified"] else 0.5,
        })
    return points


def replace_risk_cells(cells):
    """Wipe and rewrite the grid. Two calls, atomic enough for our use."""
    requests.delete(sb("risk_cells?id=gt.0"), headers=HEADERS, timeout=30).raise_for_status()
    for i in range(0, len(cells), 500):  # chunk large payloads
        r = requests.post(sb("risk_cells"), headers=HEADERS,
                          json=cells[i:i + 500], timeout=30)
        r.raise_for_status()


def log_run(seen, inserted, skipped, errors=""):
    requests.post(sb("ingest_log"), headers=HEADERS, json={
        "articles_seen": seen, "inserted": inserted,
        "skipped": skipped, "errors": errors[:2000],
    }, timeout=15)


def run():
    print("── SafeRaipur ingest ──", datetime.now(timezone.utc).isoformat())
    seen = inserted = skipped = 0
    rows = []

    for art in fetch_articles():
        seen += 1
        text = f"{art['title']} {art['snippet']}"

        crime_type, severity = classify(text)
        if crime_type is None:
            skipped += 1
            continue

        geo = geocode(text)
        if geo is None:
            skipped += 1  # crime article, but we can't place it → can't map it
            continue
        area, lat, lng = geo

        rows.append({
            "type": crime_type, "severity": severity, "area": area,
            "title": art["title"][:300], "description": art["snippet"][:1000],
            "source": "news", "source_url": art["url"][:500],
            "url_hash": art["url_hash"],
            "occurred_at": art["published_at"].isoformat(),
            "lat": lat, "lng": lng,
        })

    try:
        inserted = upsert_incidents(rows)
        print(f"  articles seen={seen} mapped={len(rows)} newly inserted={inserted}")

        points = fetch_all_points()
        cells = compute_grid(points, "night") + compute_grid(points, "day")
        replace_risk_cells(cells)
        print(f"  risk grid rewritten: {len(cells)} cells from {len(points)} points")

        log_run(seen, inserted, skipped)
    except Exception as e:
        log_run(seen, inserted, skipped, errors=str(e))
        print("  ! pipeline error:", e)
        sys.exit(1)


if __name__ == "__main__":
    run()
