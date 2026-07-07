-- ============================================================================
-- SafeRaipur v2 — Complete database schema for Supabase
-- ============================================================================
-- This ONE file replaces the entire FastAPI/Render backend.
--
-- How to run: Supabase Dashboard → SQL Editor → paste → Run.
--
-- Architecture after this migration:
--   • Frontend talks DIRECTLY to Supabase (PostgREST auto-API + Realtime)
--   • Reports go through the submit_report() function (validated + rate-limited)
--   • Surge detection runs INSIDE Postgres every 10 min via pg_cron
--   • The Python ingestion job (GitHub Actions) writes with the service key
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. EXTENSIONS
-- ---------------------------------------------------------------------------
-- postgis  → spatial types + functions (ST_ClusterDBSCAN, ST_DWithin, ...)
-- pg_cron  → scheduled jobs inside the database (our surge detector)
create extension if not exists postgis;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------------
-- Design decision: we store lat/lng as PLAIN double precision columns
-- (easy for supabase-js to read/write — no PostGIS parsing on the client)
-- and derive the geometry as a GENERATED column (so spatial SQL still works).
-- Best of both worlds, zero sync bugs.

-- 2a. incidents — news-scraped + seeded events (written only by service key)
create table if not exists public.incidents (
  id          bigint generated always as identity primary key,
  type        text not null,                       -- harassment | theft | assault | ...
  severity    int  not null check (severity between 1 and 10),
  area        text,                                -- human-readable locality name
  title       text,                                -- headline from the news article
  description text,
  source      text not null default 'news',        -- news | ncrb | manual | seed
  source_url  text,
  url_hash    text unique,                         -- md5(source_url) → dedupe key for the scraper
  occurred_at timestamptz not null,
  lat         double precision not null,
  lng         double precision not null,
  location    geometry(Point, 4326) generated always as
                (st_setsrid(st_makepoint(lng, lat), 4326)) stored,
  created_at  timestamptz not null default now()
);

create index if not exists incidents_location_gix on public.incidents using gist (location);
create index if not exists incidents_occurred_ix  on public.incidents (occurred_at desc);
create index if not exists incidents_type_ix      on public.incidents (type);

-- 2b. user_reports — anonymous community reports (INSERT only via RPC below)
create table if not exists public.user_reports (
  id            bigint generated always as identity primary key,
  type          text not null,
  severity      int  not null check (severity between 1 and 10),
  time_of_day   text check (time_of_day in ('day','night')),
  area          text,                              -- reverse-matched locality (optional)
  occurred_at   timestamptz not null default now(),
  lat           double precision not null,
  lng           double precision not null,
  location      geometry(Point, 4326) generated always as
                  (st_setsrid(st_makepoint(lng, lat), 4326)) stored,
  is_verified   boolean not null default false,    -- admin moderation flag
  is_hidden     boolean not null default false,    -- admin kill-switch for spam
  anon_hash     text not null,                     -- md5(device id + server salt) — never raw
  created_at    timestamptz not null default now()
);

create index if not exists reports_location_gix on public.user_reports using gist (location);
create index if not exists reports_created_ix   on public.user_reports (created_at desc);
create index if not exists reports_anon_ix      on public.user_reports (anon_hash);

-- 2c. risk_cells — PRECOMPUTED heatmap grid (written by the ingestion job)
-- The frontend fetches this in one query. Nothing is computed at request time,
-- which is why the map now loads instantly and can never time out.
create table if not exists public.risk_cells (
  id          bigint generated always as identity primary key,
  time_of_day text not null check (time_of_day in ('day','night')),
  lat         double precision not null,
  lng         double precision not null,
  score       real not null,                       -- normalized 0..1
  computed_at timestamptz not null default now(),
  unique (time_of_day, lat, lng)
);

create index if not exists risk_cells_tod_ix on public.risk_cells (time_of_day);

-- 2d. alerts — SURGE detections (written by the pg_cron job below)
create table if not exists public.alerts (
  id            bigint generated always as identity primary key,
  lat           double precision not null,          -- cluster centroid
  lng           double precision not null,
  radius_m      int not null default 500,
  report_count  int not null,
  max_severity  int not null,
  area          text,
  window_hours  int not null default 6,
  status        text not null default 'active'      -- active | expired | dismissed
                check (status in ('active','expired','dismissed')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '6 hours'
);

create index if not exists alerts_status_ix on public.alerts (status, created_at desc);

-- 2e. police_stations — static reference layer
create table if not exists public.police_stations (
  id    bigint generated always as identity primary key,
  name  text not null,
  phone text,
  lat   double precision not null,
  lng   double precision not null
);

-- 2f. ingest_log — every scraper run writes a row here so you can debug
-- the pipeline from the Supabase dashboard without touching GitHub.
create table if not exists public.ingest_log (
  id           bigint generated always as identity primary key,
  ran_at       timestamptz not null default now(),
  articles_seen int default 0,
  inserted     int default 0,
  skipped      int default 0,
  errors       text
);

-- ---------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
-- Philosophy:
--   anon key (the browser) → can READ public safety data, can INSERT reports
--                            ONLY through the validated RPC (not raw table)
--   service key (GitHub Actions / you) → bypasses RLS entirely
alter table public.incidents       enable row level security;
alter table public.user_reports    enable row level security;
alter table public.risk_cells      enable row level security;
alter table public.alerts          enable row level security;
alter table public.police_stations enable row level security;
alter table public.ingest_log      enable row level security;

-- Public read on everything the map needs
create policy "public read incidents"  on public.incidents       for select using (true);
create policy "public read cells"      on public.risk_cells      for select using (true);
create policy "public read stations"   on public.police_stations for select using (true);
create policy "public read alerts"     on public.alerts          for select using (status = 'active');
-- Reports are visible only if not hidden by a moderator
create policy "public read reports"    on public.user_reports    for select using (is_hidden = false);
-- NOTE: no INSERT/UPDATE/DELETE policies for anon anywhere.
-- The ONLY write path from the browser is the submit_report() function below,
-- which runs as SECURITY DEFINER (i.e., with elevated rights, but only doing
-- exactly what its body says). ingest_log has no anon policy at all.

-- ---------------------------------------------------------------------------
-- 4. REPORT SUBMISSION RPC — validation + rate limiting in one place
-- ---------------------------------------------------------------------------
-- Raipur bounding box (generous, covers Naya Raipur too):
--   lat 21.05 .. 21.42   lng 81.50 .. 81.85
-- Rate limit: max 3 reports per device per hour. Severity is assigned
-- server-side from the type so clients can't inflate it.
create or replace function public.submit_report(
  p_type        text,
  p_lat         double precision,
  p_lng         double precision,
  p_time_of_day text,
  p_anon_id     text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash     text;
  v_recent   int;
  v_severity int;
begin
  -- 1) Geographic sanity: must be inside greater Raipur
  if p_lat is null or p_lng is null
     or p_lat < 21.05 or p_lat > 21.42
     or p_lng < 81.50 or p_lng > 81.85 then
    return json_build_object('ok', false, 'error', 'Location is outside Raipur');
  end if;

  -- 2) Type whitelist → server-side severity (client can't choose severity)
  v_severity := case p_type
    when 'sexual_assault'  then 10
    when 'assault'         then 6
    when 'stalking'        then 4
    when 'chain_snatching' then 3
    when 'harassment'      then 2
    when 'theft'           then 2
    when 'suspicious'      then 1
    else null
  end;
  if v_severity is null then
    return json_build_object('ok', false, 'error', 'Unknown incident type');
  end if;

  if p_time_of_day not in ('day','night') then
    return json_build_object('ok', false, 'error', 'Invalid time of day');
  end if;

  -- 3) Hash the device id with a server-side salt so the raw id never
  --    touches the table. Change 'sr_salt_v2' once, then never again.
  v_hash := md5(coalesce(p_anon_id,'') || 'sr_salt_v2');

  -- 4) Rate limit: 3 per rolling hour per device
  select count(*) into v_recent
  from public.user_reports
  where anon_hash = v_hash
    and created_at > now() - interval '1 hour';
  if v_recent >= 3 then
    return json_build_object('ok', false, 'error', 'Rate limit: max 3 reports per hour');
  end if;

  insert into public.user_reports (type, severity, time_of_day, lat, lng, anon_hash)
  values (p_type, v_severity, p_time_of_day, p_lat, p_lng, v_hash);

  return json_build_object('ok', true);
end;
$$;

-- anon (the browser) may call the function — but nothing else
revoke all on function public.submit_report from public;
grant execute on function public.submit_report(text, double precision, double precision, text, text)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. SURGE DETECTION — runs inside Postgres every 10 minutes
-- ---------------------------------------------------------------------------
-- Logic:
--   1. Take all reports + incidents from the last 6 hours
--   2. Cluster them spatially: ST_ClusterDBSCAN, eps ≈ 500 m, minpoints 4
--      (Raipur is at ~21°N, so 0.0045° ≈ 500 m; DBSCAN works in degrees here,
--       which is fine at city scale)
--   3. For each cluster of ≥ 4 events → that's a surge
--   4. Skip if an active alert already exists within 700 m (no duplicates)
--   5. Insert into alerts → Supabase Realtime pushes it to every open map
create or replace function public.detect_surges()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new int := 0;
  rec record;
begin
  -- expire old alerts first
  update public.alerts set status = 'expired'
  where status = 'active' and expires_at < now();

  for rec in
    with recent as (
      select location, severity, coalesce(area,'') as area
      from public.user_reports
      where created_at > now() - interval '6 hours' and is_hidden = false
      union all
      select location, severity, coalesce(area,'') as area
      from public.incidents
      where occurred_at > now() - interval '6 hours'
    ),
    clustered as (
      select *,
             st_clusterdbscan(location, eps := 0.0045, minpoints := 4) over () as cid
      from recent
    )
    select cid,
           count(*)                          as n,
           max(severity)                     as max_sev,
           avg(st_y(location))               as clat,
           avg(st_x(location))               as clng,
           (array_agg(area) filter (where area <> ''))[1] as sample_area
    from clustered
    where cid is not null
    group by cid
    having count(*) >= 4
  loop
    -- dedupe: is there already an active alert within ~700 m?
    if not exists (
      select 1 from public.alerts a
      where a.status = 'active'
        and st_dwithin(
              st_setsrid(st_makepoint(a.lng, a.lat), 4326)::geography,
              st_setsrid(st_makepoint(rec.clng, rec.clat), 4326)::geography,
              700)
    ) then
      insert into public.alerts (lat, lng, report_count, max_severity, area)
      values (rec.clat, rec.clng, rec.n, rec.max_sev, rec.sample_area);
      v_new := v_new + 1;
    end if;
  end loop;

  return v_new;
end;
$$;

-- Schedule it. (If re-running this migration, unschedule first to avoid dupes.)
select cron.unschedule(jobid) from cron.job where jobname = 'saferaipur-surge';
select cron.schedule('saferaipur-surge', '*/10 * * * *', $$select public.detect_surges()$$);

-- ---------------------------------------------------------------------------
-- 6. REALTIME — broadcast inserts on reports + alerts to connected clients
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.user_reports;
alter publication supabase_realtime add table public.alerts;

-- ---------------------------------------------------------------------------
-- 7. SEED — police stations (from the old hardcoded frontend list)
-- ---------------------------------------------------------------------------
insert into public.police_stations (name, lat, lng) values
  ('Telibandha',              21.2362, 81.6498),
  ('Civil Lines',             21.2587, 81.6378),
  ('Kotwali',                 21.2371, 81.6358),
  ('Gol Bazar',               21.2390, 81.6432),
  ('Tikrapara',               21.2538, 81.6234),
  ('Pandri',                  21.2467, 81.6442),
  ('Mowa',                    21.2790, 81.6815),
  ('Gudhiyari',               21.2364, 81.6111),
  ('Ganj',                    21.2415, 81.6450),
  ('Mandir Hasaud',           21.2156, 81.7372),
  ('Khamhardih',              21.2533, 81.6759),
  ('Devendra Nagar',          21.2473, 81.6557),
  ('New Raipur (Atal Nagar)', 21.1400, 81.7300),
  ('Devpuri',                 21.2170, 81.5870),
  ('Tatibandh',               21.2850, 81.6490),
  ('Urla',                    21.2720, 81.5760),
  ('Birgaon',                 21.2900, 81.7100),
  ('Pachpedi Naka',           21.2180, 81.6180),
  ('Bhanpuri',                21.3050, 81.6500),
  ('Sarona',                  21.2100, 81.7100)
on conflict do nothing;
