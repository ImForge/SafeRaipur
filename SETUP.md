# SafeRaipur v2 — Deployment Guide

Read this top to bottom once, then follow it step by step. Total time: ~45 minutes.

## What changed and why

**v1 problem:** the FastAPI backend lived on Render's free tier. Render shares
~750 free instance-hours/month across your WHOLE account (Meanie was eating
into the same budget), free Supabase direct DB connections are IPv6-only
(Render can't reach them), and `main.py` crashed on boot whenever the DB was
unreachable. UptimeRobot was pinging a crash-looping process.

**v2 answer:** there is no server anymore.

| Feature | v1 (Render) | v2 |
|---|---|---|
| Data API | FastAPI on Render (sleeps/dies) | Supabase PostgREST (always on) |
| Report submission | POST /api/reports | `submit_report()` DB function — validated, rate-limited |
| Live updates | none (manual refresh) | Supabase Realtime websockets |
| News ingestion | manual script | GitHub Actions cron, every 30 min |
| Risk heatmap | computed per-request (slow) | precomputed `risk_cells` table (instant) |
| Surge detection | didn't exist | pg_cron + ST_ClusterDBSCAN, every 10 min |
| Safe route | hardcoded placeholder | ORS/OSRM alternatives scored vs risk grid |
| Uptime dependencies | Render + UptimeRobot + Supabase | Vercel + Supabase + GitHub — none of which sleep |

The `backend/` folder is now **legacy** — keep it for reference/college-report
purposes, but nothing deploys from it.

---

## Step 1 — Supabase project (10 min)

1. Go to https://supabase.com → your existing org → **New project**
   (or reuse the old SafeRaipur project — the migration won't touch old tables
   with different names, but a fresh project is cleaner).
2. Region: `ap-south-1 (Mumbai)` — closest to Raipur users.
3. Once ready: **SQL Editor → New query** → paste the ENTIRE contents of
   `supabase/migrations/0001_saferaipur_v2.sql` → **Run**.
   - If you see `extension "pg_cron" is not available` → Dashboard →
     **Database → Extensions** → enable `pg_cron` and `postgis`, then re-run.
   - If you re-run the file later and see `relation is already member of
     publication` on the Realtime lines — that's fine, it means it already worked.
4. Verify: **Table Editor** should show `incidents`, `user_reports`,
   `risk_cells`, `alerts`, `police_stations`, `ingest_log` (stations pre-seeded
   with 20 rows).
5. Grab your keys: **Settings → API**
   - `Project URL` → this is `SUPABASE_URL`
   - `anon public` key → frontend
   - `service_role` key → GitHub Actions ONLY. Never in frontend code, never
     committed. It bypasses all RLS.

## Step 2 — Seed the map (5 min)

The original 102 seed incidents + the first heatmap:

```bash
cd ingestion
pip install -r requirements.txt
set SUPABASE_URL=theykey
export SUPABASE_SERVICE_KEY=eyJ...service-role-key...
python seed.py
```

Safe to re-run — dedupe is built in.

## Step 3 — GitHub Actions ingestion (5 min)

1. Push this repo to GitHub (the workflow file is at
   `.github/workflows/ingest.yml`).
2. Repo → **Settings → Secrets and variables → Actions** → add:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
3. Repo → **Actions** tab → "Ingest crime data" → **Run workflow** (manual
   trigger) → watch the log. From then on it self-runs every 30 minutes.
4. Debug from Supabase: every run writes a row to `ingest_log`
   (articles seen / inserted / skipped / errors). If `inserted` stays 0 for
   days, the gazetteer is probably missing a locality that keeps appearing —
   add it to `ingestion/gazetteer.json`, commit, done.

Note: GitHub pauses scheduled workflows on repos with no commits for 60 days —
any commit resets the clock. You commit more often than that anyway.

## Step 4 — Frontend on Vercel (10 min)

1. `cd frontend && cp .env.example .env` → fill in `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` → `npm install && npm run dev` → check it works
   locally (heatmap from seed data should render).
2. Optional but recommended: free OpenRouteService key from
   https://openrouteservice.org → `VITE_ORS_API_KEY` (walking routes,
   2,000/day). Without it, routing falls back to the public OSRM demo server.
3. Vercel → your SafeRaipur project → **Settings → Environment Variables** →
   add all three `VITE_*` vars → redeploy.
   Root directory should be `frontend/`.

## Step 5 — Kill the old infra (2 min, the satisfying part)

1. Render dashboard → delete the SafeRaipur service. (Meanie now gets the
   full free-hour budget to itself, if you keep it.)
2. UptimeRobot → delete the monitor. Nothing needs keeping-alive anymore.

## Step 6 — Test the whole loop (5 min)

1. Open the deployed site on your phone AND your PC at the same time.
2. On the phone: Report Incident → tap the map → submit.
   → The pin should appear on the PC **within ~1 second** (Realtime).
3. Submit a 4th report within an hour → you should get the rate-limit error.
   That's the DB protecting itself.
4. Surge test: from Supabase SQL Editor, insert 4 fake reports near one point:
   ```sql
   insert into user_reports (type, severity, time_of_day, lat, lng, anon_hash)
   select 'theft', 2, 'night', 21.2467 + (random()-0.5)*0.003,
          81.6442 + (random()-0.5)*0.003, 'test-' || i
   from generate_series(1,4) i;
   select detect_surges();  -- run manually instead of waiting 10 min
   ```
   → surge ring + banner should appear live on every open client.
   Clean up: `delete from user_reports where anon_hash like 'test-%';
   update alerts set status='dismissed' where status='active';`
5. Route test: Plot Safest Route → tap A → tap B → 1–3 routes appear,
   safest in teal with real distance/time/risk stats.
6. PWA: open the site on Android Chrome → menu → **Add to Home screen**.

## Moderation (do this weekly, seriously)

Community data can be wrong or malicious, and a false surge can scare a
neighborhood for no reason. Two flags exist for exactly this:

- `user_reports.is_hidden = true` → report vanishes from map, feed, grid, and
  surge detection.
- `user_reports.is_verified = true` → report gets full weight (1.0 instead of
  0.5) in the risk grid.

Quick review query (Supabase SQL Editor):
```sql
select id, type, area, occurred_at, lat, lng
from user_reports
where created_at > now() - interval '7 days' and not is_verified
order by created_at desc;
```
Later this becomes an admin panel; for now the SQL editor IS the admin panel.

## Tuning knobs (all in one place)

| What | Where | Default |
|---|---|---|
| Surge threshold | `detect_surges()` → `minpoints` + `having count(*) >= 4` | 4 events / 6 h / ~500 m |
| Surge frequency | `cron.schedule(... '*/10 * * * *')` | 10 min |
| Report rate limit | `submit_report()` → `v_recent >= 3` | 3/hour/device |
| Risk half-life | `risk_grid.py` → `LAMBDA` | 180 days |
| Heat bandwidth | `risk_grid.py` → `BANDWIDTH` | ~220 m |
| Grid resolution | `risk_grid.py` → `RESOLUTION` | 60×60 |
| Scraper queries | `ingestion/scrape.py` → `QUERIES` | 10 feeds EN+HI |
| Localities | `ingestion/gazetteer.json` | ~60 areas |

## Known honest limitations (say these in your demo — it makes you credible)

- Gazetteer coordinates are approximate locality centroids; a news incident
  pins to the locality, not the exact street.
- The classifier is keyword-based; some articles get mistyped. The skip-list
  filters statistics/policy articles but isn't perfect.
- Community reports are unverified by default and weighted at 0.5 until
  moderated — the map explicitly labels sources.
- Safest route ranks by *historical* data. It's a suggestion, not a guarantee,
  an