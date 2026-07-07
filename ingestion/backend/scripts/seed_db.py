"""
One-shot seed script — populates the database from data/seed_incidents.json.

Run this once after creating the schema:

    cd backend
    python -m scripts.seed_db
"""

import json
import sys
import pathlib

# Allow running as script from backend/
sys.path.append(str(pathlib.Path(__file__).resolve().parent.parent))

from datetime import datetime
from sqlalchemy import func
from database import SessionLocal, engine, Base
from models import Incident, PoliceStation


# Map seed-data type strings to severity weights
DEFAULT_SEVERITY = {
    "harassment": 2,
    "stalking": 4,
    "chain_snatching": 3,
    "theft": 2,
    "assault": 6,
    "sexual_assault": 10,
    "suspicious_death": 8,
}


def main():
    # Create tables if they don't exist
    Base.metadata.create_all(bind=engine)

    seed_path = pathlib.Path(__file__).resolve().parent.parent / "data" / "seed_incidents.json"
    with open(seed_path) as f:
        data = json.load(f)

    db = SessionLocal()
    try:
        # Wipe existing rows so re-running is idempotent
        db.query(Incident).delete()
        db.query(PoliceStation).delete()
        db.commit()

        # Police stations
        for ps in data["police_stations"]:
            db.add(PoliceStation(
                name=ps["name"],
                phone=ps.get("phone"),
                location=func.ST_SetSRID(func.ST_MakePoint(ps["lng"], ps["lat"]), 4326),
            ))

        # Incidents
        for inc in data["incidents"]:
            severity = inc.get("severity") or DEFAULT_SEVERITY.get(inc["type"], 3)
            db.add(Incident(
                type=inc["type"],
                severity=severity,
                area=inc.get("area"),
                description=inc.get("description"),
                source=inc.get("source", "manual"),
                source_url=inc.get("url"),
                occurred_at=datetime.fromisoformat(inc["datetime"]),
                location=func.ST_SetSRID(func.ST_MakePoint(inc["lng"], inc["lat"]), 4326),
            ))

        db.commit()
        print(f"✓ Seeded {len(data['incidents'])} incidents "
              f"and {len(data['police_stations'])} police stations.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
