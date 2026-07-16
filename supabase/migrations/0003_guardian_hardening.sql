-- ============================================================================
-- SafeRaipur — GUARDIAN MODE HARDENING (apply AFTER 0002)
-- ============================================================================
-- Every change in this file exists because we attacked our own system and
-- found a hole. The full write-up lives in docs/SECURITY_AUDIT.md — each
-- section below carries its audit number (A1, A2, ...) so code and document
-- stay in sync. Run in Supabase SQL Editor after 0002. Idempotent.
--
-- Fixes shipped here:
--   A1  PIN brute force        → attempt counter, 15-min lockout, and the
--                                twist: brute-forcing DURING an emergency is
--                                itself treated as evidence of an attacker
--                                → ladder fast-forwards instead of pausing
--   A2  Coerced cancellation   → DURESS PIN: looks like a cancel, lies to
--                                the screen, keeps escalating silently,
--                                flags the emergency for the police feed
--   A3  OTP bombing            → per-phone rate limit (3/hour) + global
--                                dispatch cap so one attacker can't drain
--                                the gateway SIM's daily SMS quota
--   A4  Spoofed SMS acks       → acks now record their channel + verified
--                                flag; SMS acks are honored but marked
--                                UNVERIFIED for the dashboard, and never
--                                auto-resolve anything (that was already
--                                true — now it's visible)
--   A5  Silent engine death    → heartbeat row updated by every engine run
--                                + public guardian_engine_health() so any
--                                client (and an external GitHub Actions
--                                watchdog) can see the clock stopped
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. NEW COLUMNS + CONFIG
-- ---------------------------------------------------------------------------
alter table public.guardian_users
  add column if not exists duress_pin_hash  text,
  add column if not exists pin_fails        int not null default 0,
  add column if not exists pin_locked_until timestamptz,
  add column if not exists otp_send_count   int not null default 0,
  add column if not exists otp_window_start timestamptz;

alter table public.emergencies
  add column if not exists duress      boolean not null default false,
  add column if not exists ack_channel text;   -- 'sms' | 'whatsapp' | null

insert into public.guardian_config (key, value) values
  ('pin_max_fails',          '5'),    -- wrong PINs before lockout
  ('pin_lockout_minutes',    '15'),
  ('otp_max_per_hour',       '3'),    -- OTP texts per phone per hour
  ('dispatch_max_per_hour',  '100')   -- global command cap (SIM quota shield)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- A5. ENGINE HEARTBEAT — the clock must be observable
-- ---------------------------------------------------------------------------
-- If pg_cron silently stops, every deadline in the system stops with it and
-- nobody would know. Now every engine run stamps this row, and ANY client
-- can ask "is the clock alive?" without seeing any private data.
create table if not exists public.guardian_engine (
  id       int primary key default 1 check (id = 1),   -- exactly one row
  last_run timestamptz not null default now()
);
insert into public.guardian_engine (id) values (1) on conflict do nothing;
alter table public.guardian_engine enable row level security;  -- RPC-only

create or replace function public.guardian_engine_health()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_last timestamptz;
  v_age  numeric;
begin
  select last_run into v_last from public.guardian_engine where id = 1;
  v_age := extract(epoch from (now() - v_last));
  return json_build_object(
    'ok', true,
    'engine_last_run', v_last,
    'seconds_ago', round(v_age),
    -- engine ticks every 15 s; 60 s of silence = something is wrong
    'healthy', v_age < 60,
    'gateway_ok', public.g_gateway_alive());
end;
$$;
revoke all on function public.guardian_engine_health() from public;
grant execute on function public.guardian_engine_health() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- A3. OTP RATE LIMITS — replace guardian_register
-- ---------------------------------------------------------------------------
-- Attack: script calls guardian_register('victim_number') in a loop →
-- victim's phone floods with OTP texts AND the gateway SIM burns its daily
-- carrier SMS quota, which is the real prize: with the quota gone, a REAL
-- emergency an hour later can't send anything. Rate limits are not about
-- politeness here — they protect the weapon's ammunition.
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
  v_user  public.guardian_users;
  v_hour_dispatch int;
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

  -- global dispatch cap: if the queue grew suspiciously in the last hour,
  -- refuse LOUDLY rather than silently eating the SIM quota. Emergencies
  -- in flight are unaffected — this only gates NEW registrations.
  select count(*) into v_hour_dispatch from public.gateway_commands
  where created_at > now() - interval '1 hour';
  if v_hour_dispatch >= public.gcfg('dispatch_max_per_hour')::int then
    return json_build_object('ok', false,
      'error', 'System is under heavy load — registration paused. Emergencies are unaffected.');
  end if;

  -- per-phone OTP window
  select * into v_user from public.guardian_users where phone = v_phone;
  if v_user.id is not null then
    if v_user.otp_window_start is null
       or v_user.otp_window_start < now() - interval '1 hour' then
      update public.guardian_users
      set otp_send_count = 0, otp_window_start = now() where id = v_user.id;
    elsif v_user.otp_send_count >= public.gcfg('otp_max_per_hour')::int then
      return json_build_object('ok', false,
        'error', 'Too many codes requested for this number — try again in an hour');
    end if;
  end if;

  insert into public.guardian_users
    (phone, name, pin_hash, otp_code, otp_expires, otp_send_count, otp_window_start)
  values (v_phone, trim(p_name), public.g_hash(p_pin), v_otp,
          now() + make_interval(secs => public.gcfg('otp_ttl_seconds')::int),
          1, now())
  on conflict (phone) do update
    set otp_code       = excluded.otp_code,
        otp_expires    = excluded.otp_expires,
        otp_send_count = guardian_users.otp_send_count + 1,
        otp_window_start = coalesce(guardian_users.otp_window_start, now()),
        name     = case when guardian_users.verified then guardian_users.name     else excluded.name end,
        pin_hash = case when guardian_users.verified then guardian_users.pin_hash else excluded.pin_hash end;

  insert into public.gateway_commands (action, to_phone, body)
  values ('sms', v_phone,
          'SafeRaipur Guardian code: ' || v_otp || '. Expires in 5 minutes.');

  return json_build_object('ok', true, 'gateway_ok', public.g_gateway_alive());
end;
$$;

-- ---------------------------------------------------------------------------
-- A2. DURESS PIN — set it up (requires knowing the REAL pin)
-- ---------------------------------------------------------------------------
create or replace function public.guardian_set_duress_pin(
  p_secret     text,
  p_real_pin   text,
  p_duress_pin text
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from public.guardian_users
  where device_secret = p_secret and verified
    and pin_hash = public.g_hash(p_real_pin);
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Wrong PIN');
  end if;
  if p_duress_pin !~ '^\d{4,6}$' then
    return json_build_object('ok', false, 'error', 'Duress PIN must be 4-6 digits');
  end if;
  if p_duress_pin = p_real_pin then
    return json_build_object('ok', false, 'error', 'Duress PIN must differ from your real PIN');
  end if;

  update public.guardian_users
  set duress_pin_hash = public.g_hash(p_duress_pin) where id = v_uid;
  return json_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- A1 + A2. REPLACE guardian_cancel — brute-force defense + duress path
-- ---------------------------------------------------------------------------
-- Threat model: the attacker HAS her unlocked phone (so he has the app and
-- the device_secret) and is forcing her to stop the alarm, or trying PINs
-- himself. Old behavior: unlimited guesses → 10,000 tries kills any 4-digit
-- PIN in minutes via the API. New behavior:
--   • 5 wrong PINs → 15-minute lockout on cancel/resolve
--   • wrong PINs while an emergency is LIVE are treated as evidence of an
--     attacker → the ladder FAST-FORWARDS (next contact fires now). The
--     alarm gets harder to silence under attack, not easier. Fail loud.
--   • the DURESS PIN "works": the response says cancelled, the status API
--     will say cancelled, the victim's own phone stops receiving system
--     texts (the attacker may be reading it) — but the ladder keeps
--     climbing, the emergency is flagged duress=true, and the receipt tape
--     records DURESS_PIN_USED for the police feed.
create or replace function public.guardian_cancel(
  p_secret       text,
  p_emergency_id uuid,
  p_pin          text
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_user public.guardian_users;
  v_e    public.emergencies;
begin
  select * into v_user from public.guardian_users
  where device_secret = p_secret and verified;
  if v_user.id is null then
    return json_build_object('ok', false, 'error', 'Not authorized');
  end if;

  select * into v_e from public.emergencies
  where id = p_emergency_id and user_id = v_user.id;
  if v_e.id is null then
    return json_build_object('ok', false, 'error', 'Not found');
  end if;

  -- duress consistency: once flagged, keep lying no matter what comes next
  if v_e.duress then
    return json_build_object('ok', true, 'status',
      case when v_e.created_at > now() - make_interval(
                  secs => public.gcfg('countdown_seconds')::int)
           then 'cancelled' else 'resolved' end);
  end if;

  -- lockout window active?
  if v_user.pin_locked_until is not null and v_user.pin_locked_until > now() then
    perform public.g_log(v_e.id, 'PIN_LOCKED_ATTEMPT', null);
    return json_build_object('ok', false,
      'error', 'Too many wrong PINs — locked. The alarm continues.');
  end if;

  -- ── DURESS PIN path ────────────────────────────────────────────────────
  if v_user.duress_pin_hash is not null
     and public.g_hash(p_pin) = v_user.duress_pin_hash then
    update public.emergencies set duress = true, updated_at = now()
    where id = v_e.id;
    -- pull the next escalation to NOW — she used the duress PIN because
    -- the situation is worse, not better
    update public.emergencies set next_action_at = now()
    where id = v_e.id and status in ('countdown','escalating');
    perform public.g_log(v_e.id, 'DURESS_PIN_USED',
      json_build_object('shown_to_user', 'cancelled')::jsonb);
    update public.guardian_users set pin_fails = 0 where id = v_user.id;
    -- THE LIE, by design:
    return json_build_object('ok', true, 'status',
      case when v_e.status = 'countdown' then 'cancelled' else 'resolved' end);
  end if;

  -- ── wrong PIN path ─────────────────────────────────────────────────────
  if public.g_hash(p_pin) is distinct from v_user.pin_hash then
    update public.guardian_users set pin_fails = pin_fails + 1
    where id = v_user.id
    returning * into v_user;

    perform public.g_log(v_e.id, 'PIN_FAIL',
      json_build_object('fails', v_user.pin_fails)::jsonb);

    if v_user.pin_fails >= public.gcfg('pin_max_fails')::int then
      update public.guardian_users
      set pin_locked_until = now() +
            make_interval(mins => public.gcfg('pin_lockout_minutes')::int),
          pin_fails = 0
      where id = v_user.id;
      perform public.g_log(v_e.id, 'PIN_BRUTE_LOCKOUT', null);
      -- brute force DURING a live emergency = attacker has the phone
      -- → escalate NOW instead of waiting out the current timer
      if v_e.status in ('countdown','escalating') then
        update public.emergencies set next_action_at = now()
        where id = v_e.id;
        perform public.g_log(v_e.id, 'DURESS_SUSPECTED',
          '{"reason":"pin brute force during live emergency"}'::jsonb);
      end if;
    end if;
    return json_build_object('ok', false, 'error', 'Wrong PIN');
  end if;

  -- ── correct PIN — original 0002 behavior ───────────────────────────────
  update public.guardian_users set pin_fails = 0 where id = v_user.id;

  if v_e.status in ('resolved','cancelled') then
    return json_build_object('ok', true, 'status', v_e.status);
  end if;

  if v_e.status = 'countdown' then
    update public.emergencies set status = 'cancelled', next_action_at = null,
      updated_at = now() where id = v_e.id;
    perform public.g_log(v_e.id, 'CANCELLED', '{"during":"countdown"}'::jsonb);
    return json_build_object('ok', true, 'status', 'cancelled');
  end if;

  update public.emergencies set status = 'resolved', next_action_at = null,
    updated_at = now() where id = v_e.id;
  perform public.g_log(v_e.id, 'RESOLVED', json_build_object('prev', v_e.status)::jsonb);

  insert into public.gateway_commands (emergency_id, action, to_phone, body)
  select v_e.id, 'sms', c.phone,
         'SafeRaipur: ' || v_user.name || ' has marked themselves SAFE. Stand down.'
  from public.guardian_contacts c
  where c.user_id = v_user.id and c.priority <= greatest(v_e.current_level, 1);

  return json_build_object('ok', true, 'status', 'resolved');
end;
$$;

-- ---------------------------------------------------------------------------
-- A2 (cont). guardian_status must tell the SAME lie for duress emergencies —
-- the attacker holding her phone will check the app, and the app must agree
-- with the "cancelled" it just showed.
-- ---------------------------------------------------------------------------
create or replace function public.guardian_status(
  p_secret       text,
  p_emergency_id uuid
) returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid;
  v_e   public.emergencies;
  v_out json;
begin
  select id into v_uid from public.guardian_users
  where device_secret = p_secret and verified;
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'Not authorized');
  end if;

  select * into v_e from public.emergencies
  where id = p_emergency_id and user_id = v_uid;
  if v_e.id is null then
    return json_build_object('ok', false, 'error', 'Not found');
  end if;

  if v_e.duress then
    return json_build_object('ok', true,
      'status', 'cancelled', 'current_level', 0,
      'next_action_at', null, 'gateway_ok', public.g_gateway_alive(),
      'events', '[]'::json);
  end if;

  select json_build_object(
    'ok', true, 'status', v_e.status, 'current_level', v_e.current_level,
    'next_action_at', v_e.next_action_at,
    'ack_channel', v_e.ack_channel,
    'gateway_ok', public.g_gateway_alive(),
    'events', coalesce((
      select json_agg(json_build_object(
        'at', ev.created_at, 'event', ev.event, 'detail', ev.detail) order by ev.id)
      from public.emergency_events ev where ev.emergency_id = v_e.id), '[]'::json))
  into v_out;
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- A4. REPLACE gateway_inbound — ack channel tracking + duress silence
-- ---------------------------------------------------------------------------
-- SMS sender IDs can be spoofed. We still honor an SMS ack (a real responder
-- with a keypad phone matters more than a theoretical spoofer), but we now
-- RECORD that it arrived on an unverifiable channel. When the WhatsApp layer
-- lands, its button-tap acks are authenticated by Meta's signed webhooks and
-- will be recorded as verified — and the police dashboard can rank
-- "acknowledged (verified)" above "acknowledged (unverified SMS)".
-- Design guarantee that blunts spoofing entirely: an ack HALTS the ladder
-- but NEVER resolves the emergency, and the victim can re-trigger with one
-- press. Spoofing buys an attacker a pause, not silence.
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
    select e.id as emergency_id, e.duress, c.id as contact_id,
           c.name as contact_name, u.phone as user_phone, u.name as user_name
    from public.emergencies e
    join public.guardian_contacts c on c.user_id = e.user_id and c.phone = v_from
    join public.guardian_users u    on u.id = e.user_id
    where e.status in ('countdown','escalating')
  loop
    update public.emergencies
    set status = 'acknowledged', next_action_at = null,
        acked_by = rec.contact_id, ack_channel = 'sms', updated_at = now()
    where id = rec.emergency_id;

    perform public.g_log(rec.emergency_id, 'ACKNOWLEDGED', json_build_object(
      'by', rec.contact_name, 'channel', 'sms', 'verified', false,
      'reply', left(coalesce(p_body,''), 200))::jsonb);

    insert into public.gateway_commands (emergency_id, action, to_phone, body)
    values (rec.emergency_id, 'sms', v_from,
       'SafeRaipur: confirmed - you are marked as responding for ' || rec.user_name
       || '. Please reach them or call 112 if you cannot.');

    -- victim confirmation SUPPRESSED under duress — the attacker may be
    -- holding (and reading) her phone
    if not rec.duress then
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      values (rec.emergency_id, 'sms', rec.user_phone,
        'SafeRaipur: ' || rec.contact_name || ' confirmed they are responding.');
    end if;

    v_hits := v_hits + 1;
  end loop;

  return json_build_object('ok', true, 'matched', v_hits);
end;
$$;

-- ---------------------------------------------------------------------------
-- A2 (cont) + A5. REPLACE escalate_emergencies — heartbeat + duress silence
-- ---------------------------------------------------------------------------
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
  -- A5: prove the clock ticked, every single run
  update public.guardian_engine set last_run = now() where id = 1;

  for rec in
    select e.* from public.emergencies e
    where e.status in ('countdown','escalating')
      and e.next_action_at <= now()
    order by e.next_action_at
    for update skip locked
  loop
    select * into v_user from public.guardian_users where id = rec.user_id;
    select coalesce(max(priority), 0) into v_max
      from public.guardian_contacts where user_id = rec.user_id;

    v_next    := rec.current_level + 1;
    v_maplink := case when rec.lat is null then '(no location shared)'
                 else 'https://maps.google.com/?q=' || rec.lat || ',' || rec.lng end;

    if v_next <= v_max then
      select * into v_contact from public.guardian_contacts
      where user_id = rec.user_id and priority = v_next;

      insert into public.gateway_commands (emergency_id, action, to_phone)
      values (rec.id, 'call', v_contact.phone);

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
        'timeout_seconds', v_timeout, 'duress', rec.duress)::jsonb);

    else
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      select rec.id, 'sms', c.phone,
             'NO ONE HAS RESPONDED for ' || v_user.name ||
             '. CALL 112 (police emergency) NOW and share: ' || v_maplink
      from public.guardian_contacts c where c.user_id = rec.user_id;

      -- victim's own copy SUPPRESSED under duress (attacker may hold phone)
      if not rec.duress then
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'sms', v_user.phone,
                'SafeRaipur: no contact responded. Your contacts were told to call 112. '
                || 'If you can, DIAL 112 yourself.');
      end if;

      if public.gcfg('auto_dial_112') = 'on' then
        insert into public.gateway_commands (emergency_id, action, to_phone)
        values (rec.id, 'call', '112');
      end if;

      update public.emergencies
      set status = 'escalated_112', next_action_at = null, updated_at = now()
      where id = rec.id;

      perform public.g_log(rec.id, 'ESCALATED_112', json_build_object(
        'levels_exhausted', v_max, 'duress', rec.duress,
        'auto_dial_112', public.gcfg('auto_dial_112'))::jsonb);
    end if;

    v_advanced := v_advanced + 1;
  end loop;

  return v_advanced;
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS for the new functions
-- ---------------------------------------------------------------------------
revoke all on function public.guardian_set_duress_pin(text, text, text) from public;
grant execute on function public.guardian_set_duress_pin(text, text, text) to anon, authenticated;
-- (replaced functions keep their 0002 grants automatically)
