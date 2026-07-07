"""
Database connection — SQLAlchemy + PostGIS-enabled PostgreSQL.

We use the GeoAlchemy2 extension so SQLAlchemy understands the
PostGIS `geometry` type. Every incident row stores a Point geometry
so we can do spatial queries like "all incidents within 500m".
"""

import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# Read from env so the same code works locally and in Docker / production.
DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg2://postgres:postgres@localhost:5432/raipur_safemap",
)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def get_db():
    """FastAPI dependency that yields a DB session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
