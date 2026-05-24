# Raipur Safe Map

Raipur has a crime problem that nobody talks about openly. Women deal with it every day, harassment, chain snatching, worse, and the only official data is a national report published once a year that tells you nothing about which street is dangerous at 10pm.

I built this because I live here and wanted to actually see the pattern. Where does it happen. When. How often at night versus during the day. The kind of information that should exist but doesn't in any usable form.

**https://saferaipur.vercel.app**

---

## What it does

It puts crime incidents on a map of Raipur. You can switch between day and night to see how the risk pattern changes. Hotspots pulse on the map so you can see clusters, not just scattered dots. There's a risk score for the city, a breakdown by incident type, and an anonymous reporting button so people can add incidents that never made the news.

The data comes from local news, public records, and those anonymous reports. Incidents fade out over time so recent ones matter more than something from two years ago.

---

## Why the numbers look small

The map shows a few dozen incidents. The real number in a city this size is far higher. What you are seeing is not all the crime in Raipur, it is the small fraction that got documented somewhere.

Most incidents never reach the police. Harassment, stalking, eve-teasing, groping in crowds, a huge share of women never file a report. Fear of not being believed, fear of being blamed, the police station itself feeling unsafe, family pressure to stay quiet, or simply knowing nothing will come of it. So it never enters any official record.

Most incidents that are reported never reach the news. Media covers what is dramatic. A woman followed home from a bus stand is not treated as news, so no article is written, so it stays invisible.

This gap is the entire reason the anonymous reporting button exists. It is there to capture what official data structurally cannot. An area looking quiet on this map does not mean it is safe. It often just means people there stay silent.

---

## Built with

FastAPI, PostgreSQL with PostGIS, React, Leaflet. Deployed on Vercel and Render with Supabase as the database.

---


## Still in development

This is a work in progress. A few things are placeholders right now.

The weather display is static. It shows a fixed temperature and condition, not live data.

The Plot Safest Route button draws a demo route on the map. It does not calculate a real path or actual risk along roads yet. That feature is being built.

Everything else, the heatmap, incident data, day and night toggle, filters, search, and anonymous reporting, works.