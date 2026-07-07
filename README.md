# SafeRaipur — Live City Safety Grid

Real-time crime awareness for Raipur: a live heatmap built from news + community
reports, anonymous incident reporting with instant city-wide updates, automatic
surge detection, and safest-route navigation.

**Live:** https://saferaipur.vercel.app

## Architecture (v2 — serverless)

```
┌─────────────┐   Realtime WS + REST   ┌──────────────────────────┐
│  React app   │◄──────────────────────►│  Supabase                │
│  (Vercel)    │   submit_report RPC    │  Postgres + PostGIS      │
│  Leaflet map │                        │  RLS · Realtime · pg_cron│
└──────┬──────┘                        └───────────▲──────────────┘
       │ route alternatives                        │ service key
       ▼                                           │
┌─────────────┐                        ┌───────────┴──────────────┐
│ ORS / OSRM  │                        │ GitHub Actions (30 min)  │
│ routing API │                        │ RSS scrape → classify →  │
└─────────────┘                        │ geocode → risk grid      │
                                       └──────────────────────────┘
```

No always-on server anywhere. Nothing to keep alive. Nothing that sleeps.

- **Live reports** — anonymous, validated + rate-limited inside Postgres,
  pushed to every open map over websockets within a second.
- **Live news ingestion** — Google News RSS (English + Hindi) every 30 minutes,
  keyword-classified, geocoded against a curated Raipur locality gazetteer.
- **Surge detection** — pg_cron runs DBSCAN clustering every 10 minutes; a
  cluster of 4+ events in ~6 hours raises a live alert with a pulsing map ring.
- **Risk heatmap** — KDE (severity × 180-day exponential decay × source trust),
  precomputed into a grid table, rendered instantly.
- **Safest route** — up to 3 walking alternatives from ORS/OSRM, each scored
  against the risk grid; safest highlighted with distance/time/risk stats.
- **PWA** — installable on Android/iOS home screens.

## Repo layout

```
frontend/     React + Vite + Leaflet + supabase-js  → deploys to Vercel
supabase/     migrations (schema, RLS, RPCs, surge cron)
ingestion/    Python pipeline (scrape/classify/geocode/risk grid/seed)
.github/      Actions workflow — the pipeline's scheduler
backend/      LEGACY v1 FastAPI service — kept for reference, not deployed
```

## Setup

Full step-by-step guide: [SETUP.md](./SETUP.md)

## Disclaimer

Community reports are unverified by default and clearly labeled. Route
suggestions rank alternatives by historical data — stay alert regardless.
Built as a civic-tech student project by [Forge](https://imforge.xyz).
