-- ============================================================================
-- SafeRaipur — GUARDIAN MODE: POLICE DISPATCH ROUTING (apply AFTER 0004)
-- ============================================================================
-- The anti-flood dispatch chain:
--
--   emergency goes live ──► offered to the NEAREST registered station
--        │                        │
--        │                 accept │ decline (busy) or 120 s silence
--        ▼                        ▼
--   ASSIGNED ◄──────────── offered to the NEXT nearest ──► ... until someone
--   (victim's screen:                                      accepts, or every
--    "🚓 <station> accepted")                               station is
--                                                           exhausted →
--                                                           UNASSIGNED (loud)
--
-- Design rules:
--   • ONE station holds the offer at a time. That is the whole anti-flood
--     mechanism: a control room never sees a wall of every city emergency,
--     only the ones routed to IT, one card at a time. Declining is a
--     first-class, guilt-free action — it just moves the chain along.
--   • This runs IN PARALLEL with the contact ladder, starting the moment the
--     countdown expires (never during it — a PIN-cancelled false alarm must
--     never reach a control room).
--   • A contact's ack does NOT stand the police down — a friend responding
--     is not confirmed safety. Only a PIN resolve/cancel withdraws the offer
--     ("stood down", the station sees why). Duress NEVER stands down.
--   • Every offer, decline, timeout, and acceptance is on the receipt tape.
--   • The dashboard is a later build; every RPC it needs ships here, so the
--     dashboard will be pure rendering.
--
-- "Which station is this dashboard?" — stations self-register once with an
-- enrollment code you control, choosing their identity + coordinates
-- (prefilled from the police_stations seed table where possible). They get a
-- station secret; the future dashboard stores it exactly like the gateway
-- phone stores its own.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. CONFIG
-- ---------------------------------------------------------------------------
insert into public.guardian_config (key, value) values
  ('dispatch_enabled',       'on'),
  ('dispatch_offer_seconds', '120'),                 -- silence = auto-advance
  ('station_enroll_code',    'CHANGE-ME-station-code')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------------

-- 2a. Registered station accounts. Self-contained (own name/coords/phone) so
-- dispatch never depends on the news-ingestion seed table; police_station_id
-- links back to the map's seed row when the station picked itself from it.
create table if not exists public.station_accounts (
  id                bigint generated always as identity primary key,
  police_station_id bigint references public.police_stations(id),
  name              text not null unique,
  phone             text,
  lat               double precision not null,
  lng               double precision not null,
  secret            text not null unique,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

-- 2b. One dispatch chain per emergency.
create table if not exists public.dispatches (
  id               bigint generated always as identity primary key,
  emergency_id     uuid not null unique references public.emergencies(id) on delete cascade,
  status           text not null default 'routing' check (status in
                     ('routing',      -- walking the nearest-station chain
                      'assigned',     -- a station accepted
                      'unassigned',   -- every station declined/timed out
                      'stood_down')), -- emergency resolved/cancelled
  current_offer_id bigint,            -- fk added below (offers references us)
  attempt          int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- 2c. Every rung of the chain — the audit of who was asked and what they said.
create table if not exists public.dispatch_offers (
  id           bigint generated always as identity primary key,
  dispatch_id  bigint not null references public.dispatches(id) on delete cascade,
  station_id   bigint not null references public.station_accounts(id),
  distance_m   numeric,               -- null when the victim had no location
  status       text not null default 'offered' check (status in
                 ('offered','accepted','declined','timed_out','withdrawn')),
  note         text,                  -- decline reason, free text
  offered_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  unique (dispatch_id, station_id)    -- a station is asked at most once
);

alter table public.dispatches
  drop constraint if exists dispatches_current_offer_fk;
alter table public.dispatches
  add constraint dispatches_current_offer_fk
  foreign key (current_offer_id) references public.dispatch_offers(id);

create index if not exists dispatch_offers_open_ix
  on public.dispatch_offers (expires_at) where status = 'offered';

alter table public.station_accounts enable row level security;
alter table public.dispatches       enable row level security;
alter table public.dispatch_offers  enable row level security;
-- (no policies: RPC-only, like every Guardian table)

-- ---------------------------------------------------------------------------
-- 3. THE CHAIN-ADVANCER — offer the next nearest station, or go loud
-- ---------------------------------------------------------------------------
create or replace function public.g_offer_next(p_dispatch_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_d       public.dispatches;
  v_e       public.emergencies;
  v_station record;
  v_offer   bigint;
begin
  select * into v_d from public.dispatches where id = p_dispatch_id for update;
  if v_d.id is null or v_d.status <> 'routing' then return; end if;
  select * into v_e from public.emergencies where id = v_d.emergency_id;

  -- nearest ACTIVE station not yet asked on this chain. No victim location →
  -- fall back to registration order (police with a phone number still help).
  select sa.id, sa.name,
         case when v_e.location is null then null
              else st_distance(v_e.location::geography,
                     st_setsrid(st_makepoint(sa.lng, sa.lat), 4326)::geography)
         end as dist_m
  into v_station
  from public.station_accounts sa
  where sa.active
    and not exists (select 1 from public.dispatch_offers o
                    where o.dispatch_id = v_d.id and o.station_id = sa.id)
  order by dist_m nulls last, sa.id
  limit 1;

  if v_station.id is null then
    -- chain exhausted: the loudest possible receipt. The 112 blast (0004)
    -- remains the floor; the future dashboard shows these at max severity.
    update public.dispatches
    set status = 'unassigned', current_offer_id = null, updated_at = now()
    where id = v_d.id;
    perform public.g_log(v_d.emergency_id, 'DISPATCH_UNASSIGNED',
      json_build_object('stations_tried', v_d.attempt)::jsonb);
    return;
  end if;

  insert into public.dispatch_offers (dispatch_id, station_id, distance_m, expires_at)
  values (v_d.id, v_station.id, round(v_station.dist_m::numeric),
          now() + make_interval(secs => public.gcfg('dispatch_offer_seconds')::int))
  returning id into v_offer;

  update public.dispatches
  set current_offer_id = v_offer, attempt = attempt + 1, updated_at = now()
  where id = v_d.id;

  perform public.g_log(v_d.emergency_id, 'DISPATCH_OFFERED', json_build_object(
    'station', v_station.name,
    'distance_km', case when v_station.dist_m is null then null
                        else round((v_station.dist_m / 1000.0)::numeric, 1) end,
    'attempt', v_d.attempt + 1)::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. THE ROUTER — pg_cron every 15 s, three sweeps
-- ---------------------------------------------------------------------------
create or replace function public.route_dispatches()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_n int := 0;
  rec record;
begin
  if public.gcfg('dispatch_enabled') <> 'on' then return 0; end if;

  -- 4a. NEW: live emergencies (past countdown) with no chain yet
  for rec in
    select e.id from public.emergencies e
    where e.status in ('escalating', 'acknowledged', 'escalated_112')
      and not exists (select 1 from public.dispatches d where d.emergency_id = e.id)
    for update skip locked
  loop
    insert into public.dispatches (emergency_id) values (rec.id);
    perform public.g_log(rec.id, 'DISPATCH_STARTED', null);
    perform public.g_offer_next(
      (select id from public.dispatches where emergency_id = rec.id));
    v_n := v_n + 1;
  end loop;

  -- 4b. TIMEOUTS: a silent control room is a busy control room — advance
  for rec in
    select o.id as offer_id, o.dispatch_id, o.station_id, d.emergency_id
    from public.dispatch_offers o
    join public.dispatches d on d.id = o.dispatch_id
    where o.status = 'offered' and o.expires_at <= now()
      and d.status = 'routing'
    for update of o skip locked
  loop
    update public.dispatch_offers
    set status = 'timed_out', responded_at = now() where id = rec.offer_id;
    perform public.g_log(rec.emergency_id, 'DISPATCH_TIMED_OUT', json_build_object(
      'station', (select name from public.station_accounts where id = rec.station_id))::jsonb);
    perform public.g_offer_next(rec.dispatch_id);
    v_n := v_n + 1;
  end loop;

  -- 4c. STAND-DOWNS: emergency ended by PIN → withdraw and close the chain.
  --     (acknowledged does NOT stand down — a friend coming ≠ confirmed safe)
  for rec in
    select d.id as dispatch_id, d.current_offer_id, d.emergency_id, d.status as dstatus
    from public.dispatches d
    join public.emergencies e on e.id = d.emergency_id
    where d.status in ('routing','assigned')
      and e.status in ('resolved','cancelled')
      and not e.duress                          -- duress NEVER stands down
    for update of d skip locked
  loop
    if rec.current_offer_id is not null then
      update public.dispatch_offers
      set status = 'withdrawn', responded_at = now(),
          note = 'emergency resolved by user PIN'
      where id = rec.current_offer_id and status in ('offered','accepted');
    end if;
    update public.dispatches
    set status = 'stood_down', updated_at = now() where id = rec.dispatch_id;
    perform public.g_log(rec.emergency_id, 'DISPATCH_STOOD_DOWN', null);
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'guardian-dispatch';
select cron.schedule('guardian-dispatch', '15 seconds',
  $$select public.route_dispatches()$$);

-- ---------------------------------------------------------------------------
-- 5. STATION RPCs — everything the future dashboard needs, ready today
-- ---------------------------------------------------------------------------

-- 5a. One-time self-registration: "this dashboard is Civil Lines PS".
-- Gated by an enrollment code YOU set; the seed value is refused, same
-- pattern as the gateway secret.
create or replace function public.station_register(
  p_code  text,
  p_name  text,
  p_phone text,
  p_lat   double precision,
  p_lng   double precision
) returns json
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_secret text := encode(gen_random_bytes(24), 'hex');
  v_seed   bigint;
begin
  if p_code is distinct from public.gcfg('station_enroll_code')
     or public.gcfg('station_enroll_code') = 'CHANGE-ME-station-code' then
    return json_build_object('ok', false, 'error', 'Invalid enrollment code');
  end if;
  if coalesce(trim(p_name),'') = '' or p_lat is null or p_lng is null then
    return json_build_object('ok', false, 'error', 'Name and coordinates required');
  end if;

  -- link back to the map's seed row when names match (best-effort)
  select id into v_seed from public.police_stations
  where lower(name) = lower(trim(p_name)) limit 1;

  insert into public.station_accounts (police_station_id, name, phone, lat, lng, secret)
  values (v_seed, trim(p_name), p_phone, p_lat, p_lng, v_secret)
  on conflict (name) do update
    set phone = excluded.phone, lat = excluded.lat, lng = excluded.lng,
        secret = excluded.secret, active = true;

  -- shown once; the dashboard stores it like the gateway stores its secret
  return json_build_object('ok', true, 'station_secret', v_secret);
end;
$$;

-- 5b. The dashboard's feed: my pending offer(s) + my assigned emergencies,
-- each with the victim info + REACH PROOF computed from 0004's receipts.
create or replace function public.station_feed(p_secret text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_station public.station_accounts;
  v_out     json;
begin
  select * into v_station from public.station_accounts
  where secret = p_secret and active;
  if v_station.id is null then
    return json_build_object('ok', false, 'error', 'Unknown station');
  end if;

  select json_build_object(
    'ok', true,
    'station', v_station.name,
    'offers', coalesce((
      select json_agg(json_build_object(
        'offer_id',    o.id,
        'offered_at',  o.offered_at,
        'expires_at',  o.expires_at,
        'distance_km', case when o.distance_m is null then null
                            else round((o.distance_m / 1000.0)::numeric, 1) end,
        'assigned',    (o.status = 'accepted'),
        'emergency', json_build_object(
          'id',         e.id,
          'status',     e.status,
          'created_at', e.created_at,
          'victim',     u.name,
          'phone',      u.phone,
          'lat',        e.lat,
          'lng',        e.lng,
          'note',       e.note,
          'duress',     e.duress,          -- the silent-alarm flag: top priority
          -- REACH PROOF — the "did anyone even receive this?" answer:
          'contact_reached', exists (
             select 1 from public.gateway_commands gc
             where gc.emergency_id = e.id
               and ((gc.action = 'wa'  and gc.delivered_at is not null)
                 or (gc.action = 'sms' and gc.status = 'done'))),
          'acked_by', (select json_build_object(
                         'name', c2.name,
                         'channel', e.ack_channel,
                         'verified', (e.ack_channel = 'whatsapp'))
                       from public.guardian_contacts c2
                       where c2.id = e.acked_by)))
        order by o.offered_at desc)
      from public.dispatch_offers o
      join public.dispatches d  on d.id = o.dispatch_id
      join public.emergencies e on e.id = d.emergency_id
      join public.guardian_users u on u.id = e.user_id
      where o.station_id = v_station.id
        and ((o.status = 'offered' and d.status = 'routing')
          or (o.status = 'accepted' and d.status = 'assigned'))
    ), '[]'::json))
  into v_out;
  return v_out;
end;
$$;

-- 5c. Accept or decline. Declining is guilt-free by design — it advances the
-- chain to the next nearest station IMMEDIATELY, not on the next cron tick.
create or replace function public.station_respond(
  p_secret   text,
  p_offer_id bigint,
  p_action   text,          -- 'accept' | 'decline'
  p_note     text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_station public.station_accounts;
  v_offer   public.dispatch_offers;
  v_d       public.dispatches;
  v_e       public.emergencies;
  v_user    public.guardian_users;
begin
  select * into v_station from public.station_accounts
  where secret = p_secret and active;
  if v_station.id is null then
    return json_build_object('ok', false, 'error', 'Unknown station');
  end if;

  select * into v_offer from public.dispatch_offers
  where id = p_offer_id and station_id = v_station.id
  for update;
  if v_offer.id is null then
    return json_build_object('ok', false, 'error', 'Offer not found');
  end if;
  if v_offer.status <> 'offered' then
    return json_build_object('ok', false, 'error', 'Offer already ' || v_offer.status);
  end if;

  select * into v_d from public.dispatches where id = v_offer.dispatch_id for update;
  if v_d.status <> 'routing' then
    return json_build_object('ok', false, 'error', 'Dispatch already ' || v_d.status);
  end if;
  select * into v_e from public.emergencies where id = v_d.emergency_id;
  select * into v_user from public.guardian_users where id = v_e.user_id;

  if p_action = 'accept' then
    update public.dispatch_offers
    set status = 'accepted', responded_at = now(), note = p_note
    where id = v_offer.id;
    update public.dispatches
    set status = 'assigned', updated_at = now() where id = v_d.id;
    perform public.g_log(v_e.id, 'DISPATCH_ACCEPTED',
      json_build_object('station', v_station.name)::jsonb);

    -- tell the victim police accepted — HER SCREEN shows this line.
    -- Suppressed under duress (the attacker may be reading her phone; the
    -- LIVE screen is faking "cancelled" — an SMS would blow the cover).
    if not v_e.duress then
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      values (v_e.id, 'sms', v_user.phone,
        'SafeRaipur: ' || v_station.name || ' police have accepted your alert and were given your location.');
    end if;
    return json_build_object('ok', true, 'status', 'accepted');

  elsif p_action = 'decline' then
    update public.dispatch_offers
    set status = 'declined', responded_at = now(), note = p_note
    where id = v_offer.id;
    perform public.g_log(v_e.id, 'DISPATCH_DECLINED', json_build_object(
      'station', v_station.name, 'reason', left(coalesce(p_note,''), 200))::jsonb);
    perform public.g_offer_next(v_d.id);   -- next nearest, right now
    return json_build_object('ok', true, 'status', 'declined');
  end if;

  return json_build_object('ok', false, 'error', 'action must be accept or decline');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. GRANTS
-- ---------------------------------------------------------------------------
revoke all on function public.station_register(text, text, text, double precision, double precision) from public;
revoke all on function public.station_feed(text) from public;
revoke all on function public.station_respond(text, bigint, text, text) from public;
grant execute on function public.station_register(text, text, text, double precision, double precision) to anon, authenticated;
grant execute on function public.station_feed(text) to anon, authenticated;
grant execute on function public.station_respond(text, bigint, text, text) to anon, authenticated;
