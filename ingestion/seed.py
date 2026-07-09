"""
One-time seed — pushes the original 102 seed incidents from
backend/data/seed_incidents.json into Supabase, then computes the FIRST
risk grid so the map has a heatmap before the news pipeline has run.

Run locally once, after applying the SQL migration:

    cd ingestion
    export SUPABASE_URL=https://YOUR-PROJECT.supabase.co
    export SUPABASE_SERVICE_KEY=eyJ...service-role-key...
    pip install -r requirements.txt
    python seed.py
"""

import hashlib
import json
import os
import pathlib
from datetime import datetime, timezone

import requests

from risk_grid import compute_grid, IST

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
HEADERS = {
    "apikey": SERVICE_KEY,
    "Content-Type": "application/json",
}
# Key-format compatibility: legacy Supabase keys are JWTs ("eyJ...") and need
# an Authorization: Bearer header too. The NEW keys ("sb_secret_...") must be
# sent in apikey ONLY — putting them in Authorization makes PostgREST try to
# parse them as a JWT and reply 401 Unauthorized.
if not SERVICE_KEY.startswith("sb_"):
    HEADERS["Authorization"] = f"Bearer {SERVICE_KEY}"

SEED_PATH = pathlib.Path(__file__).parent.parent / "backend" / "data" / "seed_incidents.json"


def run():
    data = json.loads(SEED_PATH.read_text(encoding="utf-8"))
    rows = []
    for inc in data["incidents"]:
        # deterministic hash so re-running seed.py never duplicates rows
        h = hashlib.md5(f"seed-{inc['id']}".encode()).hexdigest()
        rows.append({
            "type": inc["type"], "severity": inc["severity"],
            "area": inc.get("area"), "source": "seed",
            # seed times are authored in Raipur local time — attach IST so
            # Postgres stores the correct moment instead of assuming UTC
            "url_hash": h, "occurred_at": inc["datetime"] + "+05:30",
            "lat": inc["lat"], "lng": inc["lng"],
        })

    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/incidents?on_conflict=url_hash",
        headers={**HEADERS, "Prefer": "resolution=ignore-duplicates,return=representation"},
        json=rows, timeout=30)
    r.raise_for_status()
    print(f"seeded {len(r.json())} new incidents (of {len(rows)} in file)")

    # first risk grid
    points = [{
        "lat": x["lat"], "lng": x["lng"], "severity": x["severity"],
        "occurred_at": datetime.fromisoformat(x["occurred_at"]).replace(tzinfo=IST),
        "trust": 1.0,
    } for x in rows]
    cells = compute_grid(points, "night") + compute_grid(points, "day")

    requests.delete(f"{SUPABASE_URL}/rest/v1/risk_cells?id=gt.0",
                    headers=HEADERS, timeout=30).raise_for_status()
    for i in range(0, len(cells), 500):
        requests.post(f"{SUPABASE_URL}/rest/v1/risk_cells",
                      headers=HEADERS, json=cells[i:i + 500], timeout=30).raise_for_status()
    print(f"risk grid seeded: {len(cells)} cells")
    print("done — open the site, the heatmap should be live")


if __name__ == "__main__":
    run()