-- Raipur Safe Map — database initialization.
-- Run once on a fresh Postgres database before launching the backend.
--   psql -U postgres -d raipur_safemap -f db/init.sql

-- Enable the PostGIS extension. Without this, the geometry columns won't work.
CREATE EXTENSION IF NOT EXISTS postgis;

-- SQLAlchemy will create the actual tables on first run, but we add
-- spatial indexes here that aren't easy to get from SQLAlchemy declaratively.
-- These indexes make spatial queries (ST_DWithin etc.) O(log n) instead of O(n).

-- Run these AFTER the backend has created the tables:
--
-- CREATE INDEX IF NOT EXISTS incidents_location_idx
--   ON incidents USING GIST (location);
-- CREATE INDEX IF NOT EXISTS user_reports_location_idx
--   ON user_reports USING GIST (location);
-- CREATE INDEX IF NOT EXISTS police_stations_location_idx
--   ON police_stations USING GIST (location);
--
-- CREATE INDEX IF NOT EXISTS incidents_occurred_at_idx
--   ON incidents (occurred_at);

SELECT PostGIS_Version();
