# Raipur Safe Map

Raipur has a crime problem that nobody talks about openly. Women deal with it every day harassment, chain snatching, worse and the only official data is a national report published once a year that tells you nothing about which street is dangerous at 10pm.

I built this because I live here and wanted to actually see the pattern. Where does it happen. When. How often at night versus during the day. The kind of information that should exist but doesn't in any usable form.

**https://saferaipur.vercel.app**

---

## What it does

It puts crime incidents on a map of Raipur. You can switch between day and night to see how the risk pattern changes. Hotspots pulse on the map so you can see clusters, not just scattered dots. There's a risk score for the city, a breakdown by incident type, and an anonymous reporting button so people can add incidents that never made the news.

The data comes from local news, public records, and those anonymous reports. Incidents fade out over time so recent ones matter more than something from two years ago.

---

## Built with

FastAPI, PostgreSQL with PostGIS, React, Leaflet. Deployed on Vercel and Render with Supabase as the database.

---

## Running it locally

Everything you need is in `SETUP_GUIDE.md`. Short version: you need Docker, Python, and Node. Start the database with Docker, run the Python backend, run the React frontend. The guide has exact commands for each step.

---

## A note on the data

Areas with fewer reported incidents are not necessarily safer. A lot goes unreported. This map reflects what was documented, not everything that happened. Use it as one input, not a guarantee.


## Still in development

This is a work in progress. A few things are placeholders right now:
