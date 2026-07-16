-- ============================================================================
-- SafeRaipur v4 — GUARDIAN MODE — Emergency escalation engine
-- ============================================================================
-- This ONE file adds the entire Guardian Mode backend on top of 0001.
--
-- How to run: Supabase Dashboard → SQL Editor → paste → Run.
--
-- Architecture after this migration:
--   • A user triggers an emergency → row in `emergencies`, status 'countdown'
--   • THE DATABASE OWNS THE CLOCK. escalate_emergencies() runs via pg_cron
--     every 15 seconds and advances any emergency past its deadline.
--   • Escalation does NOT call/text anything directly (Postgres can't).
--     It queues rows into `gateway_commands`. A cheap Android phone with a
--     SIM (the "gateway") polls that queue and physically places the calls
--     and SMS. If the phone dies, the queue keeps filling and the system
--     KNOWS the phone died (heartbeat) — nothing fails silently.
--   • Contacts acknowledge by simply REPLYING to the SMS. The gateway
--     forwards every inbound SMS to gateway_inbound(); any reply from a
--     listed contact halts the ladder.
--   • If NOBODY acks after every contact was tried → status 'escalated_112'
--     and everyone gets a "CALL 112 NOW" blast. Auto-dialing 112 from the
--     gateway exists but ships OFF (see guardian_config) — turning it on is
--     a deliberate human decision, not a default.
--
-- FAIL-LOUD LAWS enforced here:
--   1. Every state transition writes an emergency_events row. Receipts.
--   2. guardian_trigger() returns gateway health IN THE RESPONSE — if the
--      gateway is stale, the victim's screen can say "DIAL 112 YOURSELF"
--      within one second of pressing the button.
--   3. A failed CALL command auto-queues an SMS fallback and logs the error.
--   4. The 112 instruction is the floor, never skipped.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONS — pgcrypto provides gen_random_bytes() for device secrets.
--    (Enabled by default on Supabase, in the `extensions` schema — which is
--    why the one function that uses it includes `extensions` in search_path.)
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. CONFIG — tunables live in a table so you can change them from the
--    dashboard mid-demo without redeploying anything.
-- ---------------------------------------------------------------------------
create table if not exists public.guardian_config (
  key   text primary key,
  value text not null
);

insert into public.guardian_config (key, value) values
  ('countdown_seconds',     '60'),   -- grace period to PIN-cancel a false trigger
  ('level_timeout_seconds', '90'),   -- how long each contact gets to respond
  ('gateway_stale_seconds', '60'),   -- no heartbeat for this long = degraded
  ('auto_dial_112',         'off'),  -- 'on' makes the gateway literally dial 112.
                                     -- SHIPS OFF. Flipping this is a policy
                                     -- decision with legal weight — the SMS
                                     -- "CALL 112 NOW" blast happens regardless.
  ('otp_ttl_seconds',       '300')
on conflict (key) do nothing;

create or replace function public.gcfg(p_key text)
returns text language sql stable as
$$ select value from public.guardian_config where key = p_key $$;

-- ---------------------------------------------------------------------------
-- 2. TABLES
-- ---------------------------------------------------------------------------

-- 2a. guardian_users — LIGHTWEIGHT accounts, keyed by phone number.
-- Deliberately NOT Supabase Auth: no email, no password, no third-party
-- login. Your phone number is your identity, an SMS OTP proves you own it,
-- and a random device_secret (returned once, stored on the device) signs
-- every later call. Anonymous map reporting from 0001 is untouched —
-- accounts exist ONLY for people who opt into Guardian protection.
create table if not exists public.guardian_users (
  id            uuid primary key default gen_random_uuid(),
  phone         text not null unique,              -- normalized: last 10 digits
  name          text not null,
  pin_hash      text not null,                     -- md5(pin+salt) — cancel PIN
  device_secret text,                              -- issued after OTP verify
  verified      boolean not null default false,
  otp_code      text,                              -- current OTP (sent via gateway SMS)
  otp_expires   timestamptz,
  created_at    timestamptz not null default now()
);

-- 2b. guardian_contacts — the escalation ladder, one rung per row.
-- priority 1 gets called first. Number of contacts = number of levels.
create table if not exists public.guardian_contacts (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.guardian_users(id) on delete cascade,
  name       text not null,
  phone      text not null,                        -- normalized: last 10 digits
  priority   int  not null check (priority between 1 and 5),
  created_at timestamptz not null default now(),
  unique (user_id, priority)
);

create index if not exists gcontacts_phone_ix on public.guardian_contacts (phone);

-- 2c. emergencies — THE STATE MACHINE. One row per incident.
-- next_action_at is the single source of truth for time: the cron job
-- simply asks "which rows are past their deadline?" and advances them.
create table if not exists public.emergencies (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.guardian_users(id),
  status         text not null default 'countdown' check (status in
                   ('countdown',      -- grace period, cancellable by PIN
                    'escalating',     -- working through the contact ladder
                    'acknowledged',   -- a contact replied — ladder halted
                    'escalated_112',  -- ladder exhausted — 112 blast sent
                    'resolved',       -- user marked safe (PIN required)
                    'cancelled')),    -- PIN-cancelled during countdown
  current_level  int not null default 0,           -- which contact rung we're on
  lat            double precision,
  lng            double precision,
  location       geometry(Point, 4326) generated always as
                   (case when lat is null then null
                         else st_setsrid(st_makepoint(lng, lat), 4326) end) stored,
  note           text,
  next_action_at timestamptz,                      -- the cron job's alarm clock
  acked_by       bigint references public.guardian_contacts(id),
  gateway_ok     boolean not null default true,    -- was the gateway alive at trigger?
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists emergencies_pending_ix
  on public.emergencies (next_action_at)
  where status in ('countdown','escalating');

-- 2d. emergency_events — APPEND-ONLY audit log. Every transition, every
-- command result, every failure lands here. This is the "receipt" law:
-- after an incident you can reconstruct exactly what the system did and
-- when, to the second. Never updated, never deleted.
create table if not exists public.emergency_events (
  id           bigint generated always as identity primary key,
  emergency_id uuid not null references public.emergencies(id) on delete cascade,
  event        text not null,                      -- TRIGGERED | LEVEL_1 | ACKED | ...
  detail       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists eevents_emergency_ix on public.emergency_events (emergency_id, id);

-- 2e. gateway_devices — the physical phones. Prototype = exactly one (yours).
-- SETUP (one-time, run in SQL editor with your own value):
--   update public.gateway_devices
--     set secret = '<paste 32+ random chars>' where label = 'primary';
create table if not exists public.gateway_devices (
  id           bigint generated always as identity primary key,
  label        text not null unique,
  secret       text not null,                      -- CHANGE THE SEED VALUE. Really.
  sim_number   text,                               -- the gateway SIM's own number
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

insert into public.gateway_devices (label, secret)
values ('primary', 'CHANGE-ME-before-first-run')
on conflict (label) do nothing;

-- 2f. gateway_commands — the work queue. Postgres writes, the phone executes.
create table if not exists public.gateway_commands (
  id           bigint generated always as identity primary key,
  emergency_id uuid references public.emergencies(id) on delete set null,
  action       text not null check (action in ('sms','call')),
  to_phone     text not null,
  body         text,                               -- sms text (null for calls)
  status       text not null default 'pending' check (status in
                 ('pending','sent','done','failed')),
  attempts     int not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  done_at      timestamptz
);

create index if not exists gcommands_pending_ix
  on public.gateway_commands (id) where status = 'pending';

-- ---------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY — same philosophy as 0001, stricter tables.
-- NOTHING here is publicly readable. Emergencies are private by definition.
-- The ONLY access paths are the SECURITY DEFINER RPCs below, each of which
-- authenticates with a secret before touching anything.
-- ---------------------------------------------------------------------------
alter table public.guardian_config   enable row level security;
alter table public.guardian_users    enable row level security;
alter table public.guardian_contacts enable row level security;
alter table public.emergencies       enable row level security;
alter table public.emergency_events  enable row level security;
alter table public.gateway_devices   enable row level security;
alter table public.gateway_commands  enable row level security;
-- (no policies created = anon sees nothing, ever)

-- ---------------------------------------------------------------------------
-- 4. HELPERS
-- ---------------------------------------------------------------------------

-- Normalize any Indian phone format to its last 10 digits.
-- '+91 98765 43210', '098765-43210', '9876543210' → '9876543210'
create or replace function public.g_norm_phone(p text)
returns text language sql immutable as
$$ select right(regexp_replace(coalesce(p,''), '\D', '', 'g'), 10) $$;

-- Salted hash, matching the 0001 style. Change the salt once, never again.
create or replace function public.g_hash(p text)
returns text language sql immutable as
$$ select md5(coalesce(p,'') || 'guardian_salt_v1') $$;

-- One place that decides "is the gateway alive right now?"
create or replace function public.g_gateway_alive()
returns boolean language sql stable as
$$ select exists (
     select 1 from public.gateway_devices
     where last_seen_at > now() - make_interval(secs => public.gcfg('gateway_stale_seconds')::int)
   ) $$;

-- Append a receipt. Used by every function below.
create or replace function public.g_log(p_emergency uuid, p_event text, p_detail jsonb default null)
returns void language sql as
$$ insert into public.emergency_events (emergency_id, event, detail)
   values (p_emergency, p_event, p_detail) $$;

-- ---------------------------------------------------------------------------
-- 5. REGISTRATION RPCs — phone + OTP, dogfooding our own gateway for the SMS
-- ---------------------------------------------------------------------------

-- 5a. Register: creates the account and queues the OTP text THROUGH THE
-- GATEWAY ITSELF. First proof the pipe works end-to-end.
create or replace function public.guardian_register(
  p_phone text,
  p_name  text,
  p_pin   text
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_phone text := public.g_norm_phone(p_phone);
  v_otp   text := lpad((floor(random() * 1000000))::int::text, 6, '0');
begin
  if length(v_phone) < 10 then
    return json_build_object('ok', false, 'error', 'Invalid phone number');
  end if;
  if p_pin !~ '^\d{4,6}$' then
    return json_build_object('ok', false, 'error', 'PIN must be 4-6 digits');
  end if;
  if coalesce(trim(p_name), '') = '' then
    return json_build_object('ok', false, 'error', 'Name required');
  end if;

  insert into public.guardian_users (phone, name, pin_hash, otp_code, otp_expires)
  values (v_phone, trim(p_name), public.g_hash(p_pin), v_otp,
          now() + make_interval(secs => public.gcfg('otp_ttl_seconds')::int))
  on conflict (phone) do update
    set otp_code    = excluded.otp_code,
        otp_expires = excluded.otp_expires,
        -- re-registering an UNVERIFIED number may refresh name/pin;
        -- a verified account's identity is frozen against takeover.
        name     = case when guardian_users.verified then guardian_users.name     else excluded.name end,
        pin_hash = case when guardian_users.verified then guardian_users.pin_hash else excluded.pin_hash end;

  insert into public.gateway_commands (action, to_phone, body)
  values ('sms', v_phone,
          'SafeRaipur Guardian code: ' || v_otp || '. Expires in 5 minutes.');

  -- FAIL LOUD: if the gateway is dead, say so NOW, not after 5 confused minutes.
  return json_build_object('ok', true, 'gateway_ok', public.g_gateway_alive());
end;
$$;

-- 5b. Verify OTP → issue the device_secret (shown exactly once).
create or replace function public.guardian_verify(
  p_phone text,
  p_otp   text
) returns json
-- search_path includes `extensions` because Supabase installs pgcrypto there;
-- on plain Postgres (local testing) the missing schema is silently skipped.
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_user   public.guardian_users;
  v_secret text := encode(gen_random_bytes(24), 'hex');
begin
  select * into v_user from public.guardian_users
  where phone = public.g_norm_phone(p_phone);

  if v_user.id is null or v_user.otp_code is distinct from p_otp
     or v_user.otp_expires < now() then
    return json_build_object('ok', false, 'error', 'Wrong or expired code');
  end if;

  update public.guardian_users
  set verified = true, device_secret = v_secret, otp_code = null, otp_expires = null
  where id = v_user.id;

  return json_build_object('ok', true, 'device_secret', v_secret, 'user_id', v_user.id);
end;
$$;

-- 5c. Add a contact rung to the ladder.
create or replace function public.guardian_add_contact(
  p_secret   text,
  p_name     text,
  p_phone    text,
  p_priority int
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from public.guardian_users
  where device_secret = p_secret and verified;
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Not authorized');
  end if;
  if length(public.g_norm_phone(p_phone)) < 10 then
    return json_build_object('ok', false, 'error', 'Invalid contact phone');
  end if;

  insert into public.guardian_contacts (user_id, name, phone, priority)
  values (v_uid, trim(p_name), public.g_norm_phone(p_phone), p_priority)
  on conflict (user_id, priority) do update
    set name = excluded.name, phone = excluded.phone;

  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. THE PANIC BUTTON — guardian_trigger()
-- ---------------------------------------------------------------------------
create or replace function public.guardian_trigger(
  p_secret text,
  p_lat    double precision default null,
  p_lng    double precision default null,
  p_note   text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid       uuid;
  v_existing  uuid;
  v_id        uuid;
  v_countdown int := public.gcfg('countdown_seconds')::int;
  v_gw_ok     boolean := public.g_gateway_alive();
  v_ncontacts int;
begin
  select id into v_uid from public.guardian_users
  where device_secret = p_secret and verified;
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Not authorized');
  end if;

  -- No contacts = no ladder = the system CANNOT protect you. Refuse loudly
  -- instead of pretending. (The 112 helpline card in the app is the floor.)
  select count(*) into v_ncontacts from public.guardian_contacts where user_id = v_uid;
  if v_ncontacts = 0 then
    return json_build_object('ok', false,
      'error', 'No emergency contacts configured — add at least one, or dial 112 directly');
  end if;

  -- One live emergency per user. A second press = "I really mean it":
  -- skip the remaining countdown and escalate NOW.
  select id into v_existing from public.emergencies
  where user_id = v_uid and status in ('countdown','escalating');
  if v_existing is not null then
    update public.emergencies
    set next_action_at = now(), updated_at = now()
    where id = v_existing;
    perform public.g_log(v_existing, 'RETRIGGERED',
      json_build_object('effect', 'deadline pulled to now')::jsonb);
    return json_build_object('ok', true, 'emergency_id', v_existing,
      'status', 'already_active_fast_forwarded', 'gateway_ok', v_gw_ok);
  end if;

  insert into public.emergencies (user_id, lat, lng, note, next_action_at, gateway_ok)
  values (v_uid, p_lat, p_lng, p_note,
          now() + make_interval(secs => v_countdown), v_gw_ok)
  returning id into v_id;

  perform public.g_log(v_id, 'TRIGGERED', json_build_object(
    'lat', p_lat, 'lng', p_lng, 'note', p_note,
    'countdown_seconds', v_countdown, 'gateway_ok', v_gw_ok)::jsonb);

  -- FAIL-LOUD LAW #2: gateway health rides back in the trigger response.
  -- If gateway_ok is false the app must show "SYSTEM DEGRADED — DIAL 112".
  return json_build_object(
    'ok', true, 'emergency_id', v_id, 'status', 'countdown',
    'cancel_deadline', now() + make_interval(secs => v_countdown),
    'gateway_ok', v_gw_ok);
end;
$$;

-- Cancel (during countdown) or resolve (any time) — PIN required, because a
-- phone in an attacker's hands must not be able to silence the alarm.
create or replace function public.guardian_cancel(
  p_secret       text,
  p_emergency_id uuid,
  p_pin          text
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_e   public.emergencies;
  v_uid uuid;
begin
  select u.id into v_uid from public.guardian_users u
  where u.device_secret = p_secret and u.verified
    and u.pin_hash = public.g_hash(p_pin);
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Wrong PIN');
  end if;

  select * into v_e from public.emergencies
  where id = p_emergency_id and user_id = v_uid;
  if v_e.id is null then
    return json_build_object('ok', false, 'error', 'Not found');
  end if;
  if v_e.status in ('resolved','cancelled') then
    return json_build_object('ok', true, 'status', v_e.status);
  end if;

  if v_e.status = 'countdown' then
    update public.emergencies set status = 'cancelled', next_action_at = null,
      updated_at = now() where id = v_e.id;
    perform public.g_log(v_e.id, 'CANCELLED', '{"during":"countdown"}'::jsonb);
    return json_build_object('ok', true, 'status', 'cancelled');
  end if;

  -- Past countdown: contacts were already disturbed → tell them it's over.
  update public.emergencies set status = 'resolved', next_action_at = null,
    updated_at = now() where id = v_e.id;
  perform public.g_log(v_e.id, 'RESOLVED', json_build_object('prev', v_e.status)::jsonb);

  insert into public.gateway_commands (emergency_id, action, to_phone, body)
  select v_e.id, 'sms', c.phone,
         'SafeRaipur: ' || u.name || ' has marked themselves SAFE. Stand down.'
  from public.guardian_contacts c
  join public.guardian_users u on u.id = c.user_id
  where c.user_id = v_uid and c.priority <= greatest(v_e.current_level, 1);

  return json_build_object('ok', true, 'status', 'resolved');
end;
$$;

-- Live status for the victim's screen: state + full receipt trail.
create or replace function public.guardian_status(
  p_secret       text,
  p_emergency_id uuid
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
  v_out json;
begin
  select id into v_uid from public.guardian_users
  where device_secret = p_secret and verified;
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Not authorized');
  end if;

  select json_build_object(
    'ok', true,
    'status', e.status,
    'current_level', e.current_level,
    'next_action_at', e.next_action_at,
    'gateway_ok', public.g_gateway_alive(),
    'events', coalesce((
      select json_agg(json_build_object(
        'at', ev.created_at, 'event', ev.event, 'detail', ev.detail)
        order by ev.id)
      from public.emergency_events ev where ev.emergency_id = e.id), '[]'::json))
  into v_out
  from public.emergencies e
  where e.id = p_emergency_id and e.user_id = v_uid;

  return coalesce(v_out, json_build_object('ok', false, 'error', 'Not found'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. THE ESCALATION ENGINE — escalate_emergencies(), runs every 15 s
-- ---------------------------------------------------------------------------
-- This is the whole product in one function. It wakes up, finds every
-- emergency whose deadline has passed, and advances it exactly one step:
--   countdown  → level 1  (call contact #1, SMS the whole ladder)
--   level N    → level N+1 (call the next contact)
--   last level → escalated_112 ("CALL 112 NOW" blast; optional auto-dial)
create or replace function public.escalate_emergencies()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_advanced int := 0;
  v_timeout  int := public.gcfg('level_timeout_seconds')::int;
  rec        record;
  v_contact  public.guardian_contacts;
  v_user     public.guardian_users;
  v_maplink  text;
  v_next     int;
  v_max      int;
begin
  for rec in
    select e.* from public.emergencies e
    where e.status in ('countdown','escalating')
      and e.next_action_at <= now()
    order by e.next_action_at
    for update skip locked          -- overlapping cron runs can never double-fire
  loop
    select * into v_user from public.guardian_users where id = rec.user_id;
    select coalesce(max(priority), 0) into v_max
      from public.guardian_contacts where user_id = rec.user_id;

    v_next    := rec.current_level + 1;
    v_maplink := case when rec.lat is null then '(no location shared)'
                 else 'https://maps.google.com/?q=' || rec.lat || ',' || rec.lng end;

    if v_next <= v_max then
      -- ── climb one rung ────────────────────────────────────────────────
      select * into v_contact from public.guardian_contacts
      where user_id = rec.user_id and priority = v_next;

      -- CALL the contact on this rung
      insert into public.gateway_commands (emergency_id, action, to_phone)
      values (rec.id, 'call', v_contact.phone);

      -- SMS: rung 1 texts the ENTIRE ladder at once (everyone knows early);
      -- later rungs text only the newly-called contact (no spam).
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      select rec.id, 'sms', c.phone,
             'EMERGENCY - SafeRaipur Guardian. ' || v_user.name ||
             ' needs help NOW. Location: ' || v_maplink ||
             coalesce('. Note: ' || rec.note, '') ||
             '. REPLY to this SMS to confirm you are responding.'
      from public.guardian_contacts c
      where c.user_id = rec.user_id
        and (v_next = 1 or c.priority = v_next);

      update public.emergencies
      set status = 'escalating', current_level = v_next,
          next_action_at = now() + make_interval(secs => v_timeout),
          updated_at = now()
      where id = rec.id;

      perform public.g_log(rec.id, 'LEVEL_' || v_next, json_build_object(
        'called', v_contact.name, 'phone_last4', right(v_contact.phone, 4),
        'timeout_seconds', v_timeout)::jsonb);

    else
      -- ── ladder exhausted → 112 protocol ──────────────────────────────
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      select rec.id, 'sms', c.phone,
             'NO ONE HAS RESPONDED for ' || v_user.name ||
             '. CALL 112 (police emergency) NOW and share: ' || v_maplink
      from public.guardian_contacts c where c.user_id = rec.user_id;

      -- also tell the victim's own phone what the system just did
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      values (rec.id, 'sms', v_user.phone,
              'SafeRaipur: no contact responded. Your contacts were told to call 112. '
              || 'If you can, DIAL 112 yourself.');

      if public.gcfg('auto_dial_112') = 'on' then
        insert into public.gateway_commands (emergency_id, action, to_phone)
        values (rec.id, 'call', '112');
      end if;

      update public.emergencies
      set status = 'escalated_112', next_action_at = null, updated_at = now()
      where id = rec.id;

      perform public.g_log(rec.id, 'ESCALATED_112', json_build_object(
        'levels_exhausted', v_max,
        'auto_dial_112', public.gcfg('auto_dial_112'))::jsonb);
    end if;

    v_advanced := v_advanced + 1;
  end loop;

  return v_advanced;
end;
$$;

-- Schedule it. pg_cron ≥1.5 (Supabase ships it) supports second-granularity.
select cron.unschedule(jobid) from cron.job where jobname = 'guardian-escalate';
select cron.schedule('guardian-escalate', '15 seconds', $$select public.escalate_emergencies()$$);
-- Fallback if your instance rejects the seconds syntax (older pg_cron):
--   select cron.schedule('guardian-escalate', '* * * * *', $$select public.escalate_emergencies()$$);
--   ...and raise level_timeout_seconds to ≥120 so a 60 s cron tick can't
--   lag a 90 s deadline into meaninglessness. THE LAG RULE: the poller
--   period must always be well under the shortest timeout it enforces.

-- ---------------------------------------------------------------------------
-- 8. GATEWAY RPCs — the phone's three verbs: poll, report, forward-inbound
-- ---------------------------------------------------------------------------

-- 8a. Poll: heartbeat + claim pending work (marked 'sent' atomically so two
-- gateways could coexist later without double-sending).
create or replace function public.gateway_poll(p_secret text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_gw   bigint;
  v_cmds json;
begin
  update public.gateway_devices set last_seen_at = now()
  where secret = p_secret and secret <> 'CHANGE-ME-before-first-run'
  returning id into v_gw;
  if v_gw is null then
    return json_build_object('ok', false, 'error', 'Unknown gateway (did you change the seed secret?)');
  end if;

  with claimed as (
    update public.gateway_commands
    set status = 'sent', sent_at = now(), attempts = attempts + 1
    where id in (
      select id from public.gateway_commands
      where status = 'pending'
      order by id
      limit 10
      for update skip locked
    )
    returning id, emergency_id, action, to_phone, body
  )
  select coalesce(json_agg(row_to_json(claimed) order by id), '[]'::json)
  into v_cmds from claimed;

  return json_build_object('ok', true, 'commands', v_cmds);
end;
$$;

-- 8b. Report result. FAIL-LOUD LAW #3: a failed CALL immediately queues an
-- SMS fallback to the same number — the system never shrugs.
create or replace function public.gateway_report(
  p_secret     text,
  p_command_id bigint,
  p_ok         boolean,
  p_error      text default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_cmd public.gateway_commands;
begin
  if not exists (select 1 from public.gateway_devices
                 where secret = p_secret and secret <> 'CHANGE-ME-before-first-run') then
    return json_build_object('ok', false, 'error', 'Unknown gateway');
  end if;

  update public.gateway_commands
  set status = case when p_ok then 'done' else 'failed' end,
      done_at = now(), last_error = p_error
  where id = p_command_id and status = 'sent'
  returning * into v_cmd;
  if v_cmd.id is null then
    return json_build_object('ok', false, 'error', 'Command not in sent state');
  end if;

  if v_cmd.emergency_id is not null then
    perform public.g_log(v_cmd.emergency_id,
      case when p_ok then 'CMD_DONE' else 'CMD_FAILED' end,
      json_build_object('command_id', v_cmd.id, 'action', v_cmd.action,
                        'phone_last4', right(v_cmd.to_phone, 4),
                        'error', p_error)::jsonb);
  end if;

  if not p_ok and v_cmd.action = 'call' then
    insert into public.gateway_commands (emergency_id, action, to_phone, body)
    values (v_cmd.emergency_id, 'sms', v_cmd.to_phone,
            'EMERGENCY - SafeRaipur tried to CALL you and could not connect. '
            || 'Someone needs help. Check your SMS for details and RESPOND.');
  end if;

  return json_build_object('ok', true);
end;
$$;

-- 8c. Inbound SMS → acknowledgement. ANY reply from a listed contact while
-- the ladder is live counts as an ack. In a crisis we do not demand syntax.
create or replace function public.gateway_inbound(
  p_secret text,
  p_from   text,
  p_body   text
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_from text := public.g_norm_phone(p_from);
  rec    record;
  v_hits int := 0;
begin
  if not exists (select 1 from public.gateway_devices
                 where secret = p_secret and secret <> 'CHANGE-ME-before-first-run') then
    return json_build_object('ok', false, 'error', 'Unknown gateway');
  end if;

  for rec in
    select e.id as emergency_id, c.id as contact_id, c.name as contact_name,
           u.phone as user_phone, u.name as user_name
    from public.emergencies e
    join public.guardian_contacts c on c.user_id = e.user_id and c.phone = v_from
    join public.guardian_users u    on u.id = e.user_id
    where e.status in ('countdown','escalating')
  loop
    update public.emergencies
    set status = 'acknowledged', next_action_at = null,
        acked_by = rec.contact_id, updated_at = now()
    where id = rec.emergency_id;

    perform public.g_log(rec.emergency_id, 'ACKNOWLEDGED', json_build_object(
      'by', rec.contact_name, 'reply', left(coalesce(p_body,''), 200))::jsonb);

    -- confirm to the responder + tell the victim someone is coming
    insert into public.gateway_commands (emergency_id, action, to_phone, body) values
      (rec.emergency_id, 'sms', v_from,
       'SafeRaipur: confirmed - you are marked as responding for ' || rec.user_name
       || '. Please reach them or call 112 if you cannot.'),
      (rec.emergency_id, 'sms', rec.user_phone,
       'SafeRaipur: ' || rec.contact_name || ' confirmed they are responding.');

    v_hits := v_hits + 1;
  end loop;

  -- Unmatched inbound SMS are fine (delivery reports, spam) — just say so.
  return json_build_object('ok', true, 'matched', v_hits);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. GRANTS — anon may execute exactly these functions, nothing else.
-- ---------------------------------------------------------------------------
revoke all on function public.guardian_register(text, text, text)                          from public;
revoke all on function public.guardian_verify(text, text)                                  from public;
revoke all on function public.guardian_add_contact(text, text, text, int)                  from public;
revoke all on function public.guardian_trigger(text, double precision, double precision, text) from public;
revoke all on function public.guardian_cancel(text, uuid, text)                            from public;
revoke all on function public.guardian_status(text, uuid)                                  from public;
revoke all on function public.gateway_poll(text)                                           from public;
revoke all on function public.gateway_report(text, bigint, boolean, text)                  from public;
revoke all on function public.gateway_inbound(text, text, text)                            from public;

grant execute on function public.guardian_register(text, text, text)                          to anon, authenticated;
grant execute on function public.guardian_verify(text, text)                                  to anon, authenticated;
grant execute on function public.guardian_add_contact(text, text, text, int)                  to anon, authenticated;
grant execute on function public.guardian_trigger(text, double precision, double precision, text) to anon, authenticated;
grant execute on function public.guardian_cancel(text, uuid, text)                            to anon, authenticated;
grant execute on function public.guardian_status(text, uuid)                                  to anon, authenticated;
grant execute on function public.gateway_poll(text)                                           to anon, authenticated;
grant execute on function public.gateway_report(text, bigint, boolean, text)                  to anon, authenticated;
grant execute on function public.gateway_inbound(text, text, text)                            to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. REALTIME — the victim's screen subscribes to its own emergency row.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.emergencies;
