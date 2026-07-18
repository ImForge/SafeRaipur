-- ============================================================================
-- SafeRaipur — GUARDIAN: SPEAKING CALLS + DASHBOARD FEEDS (apply AFTER 0005)
-- ============================================================================
-- Two additions, both from real gaps found while testing on a live phone:
--
--   1. SPEAKING CALLS. A ringing phone with dead air on answer gets hung up on
--      as spam — the most attention-grabbing channel, wasted. Call rows now
--      carry a spoken script in `body`, which the gateway reads aloud via
--      Android TTS once answered. The SMS still always goes out: the call is
--      the attention-getter, the SMS is the payload (a map link can't be
--      spoken usefully anyway).
--
--   2. DASHBOARD FEEDS. station_dashboard() gives a control room everything in
--      one call: its own offers, its assigned cases, plus city-wide SURGE
--      DETECTION — if several emergencies fire in the same area in a short
--      window, that's a pattern (a riot, a serial attacker, a blackout zone)
--      and it gets flagged, not buried. This reuses the same spatial thinking
--      as 0001's detect_surges() but for live emergencies rather than reports.
-- ============================================================================

insert into public.guardian_config (key, value) values
  ('surge_radius_m',      '1500'),  -- how close counts as "same area"
  ('surge_window_min',    '60'),    -- how recent counts as "same time"
  ('surge_min_count',     '3')      -- how many emergencies make it a pattern
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. SPEAKING CALLS — every call row gets a script
-- ---------------------------------------------------------------------------
-- Kept deliberately short and plain: TTS on a phone speaker into a call is
-- lossy, and a panicking listener needs the WHAT and the ACTION, nothing else.
create or replace function public.g_call_script(
  p_victim text,
  p_kind   text default 'contact'   -- 'contact' | 'final'
) returns text
language sql immutable as
$$
  select case p_kind
    when 'final' then
      'Emergency. ' || p_victim || ' needs help and nobody has responded. '
      || 'Please call 1 1 2 immediately. Check your messages for their location. '
      || 'Repeat. ' || p_victim || ' needs help now.'
    else
      'Emergency alert from Safe Raipur. ' || p_victim || ' has triggered a panic alarm '
      || 'and listed you as an emergency contact. Please check your messages for their '
      || 'live location, and respond now. If you cannot reach them, call 1 1 2.'
  end
$$;

-- Replace the engine so every call it queues carries its script.
create or replace function public.escalate_emergencies()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_advanced int := 0;
  v_timeout  int := public.gcfg('level_timeout_seconds')::int;
  v_hold     int := public.gcfg('wa_hold_seconds')::int;
  rec        record;
  c          record;
  v_contact  public.guardian_contacts;
  v_user     public.guardian_users;
  v_maplink  text;
  v_smstext  text;
  v_next     int;
  v_max      int;
  v_wa_id    bigint;
begin
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

      -- CALL — now WITH a spoken script
      insert into public.gateway_commands (emergency_id, action, to_phone, body)
      values (rec.id, 'call', v_contact.phone,
              public.g_call_script(v_user.name, 'contact'));

      for c in
        select * from public.guardian_contacts gc
        where gc.user_id = rec.user_id
          and (v_next = 1 or gc.priority = v_next)
      loop
        v_smstext := 'EMERGENCY - SafeRaipur Guardian. ' || v_user.name ||
                     ' needs help NOW. Location: ' || v_maplink ||
                     coalesce('. Note: ' || rec.note, '') ||
                     '. REPLY to this SMS to confirm you are responding.';

        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'wa', c.phone,
                json_build_object('name', v_user.name, 'link', v_maplink)::text)
        returning id into v_wa_id;

        insert into public.gateway_commands
          (emergency_id, action, to_phone, body, status, parent_id, hold_until)
        values (rec.id, 'sms', c.phone, v_smstext,
                'held', v_wa_id, now() + make_interval(secs => v_hold));
      end loop;

      update public.emergencies
      set status = 'escalating', current_level = v_next,
          next_action_at = now() + make_interval(secs => v_timeout),
          updated_at = now()
      where id = rec.id;

      perform public.g_log(rec.id, 'LEVEL_' || v_next, json_build_object(
        'called', v_contact.name, 'phone_last4', right(v_contact.phone, 4),
        'timeout_seconds', v_timeout, 'duress', rec.duress)::jsonb);

    else
      for c in select * from public.guardian_contacts gc where gc.user_id = rec.user_id
      loop
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'wa', c.phone,
                json_build_object('name', v_user.name, 'link', v_maplink)::text);
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'sms', c.phone,
                'NO ONE HAS RESPONDED for ' || v_user.name ||
                '. CALL 112 (police emergency) NOW and share: ' || v_maplink);
        -- final round: call the FIRST contact again, with the urgent script
        if c.priority = 1 then
          insert into public.gateway_commands (emergency_id, action, to_phone, body)
          values (rec.id, 'call', c.phone, public.g_call_script(v_user.name, 'final'));
        end if;
      end loop;

      if not rec.duress then
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'sms', v_user.phone,
                'SafeRaipur: no contact responded. Your contacts were told to call 112. '
                || 'If you can, DIAL 112 yourself.');
      end if;

      if public.gcfg('auto_dial_112') = 'on' then
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'call', '112', public.g_call_script(v_user.name, 'final'));
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
-- 2. SURGE DETECTION — many alarms, one area, one hour = a pattern
-- ---------------------------------------------------------------------------
-- Not just "lots of emergencies": clusters them spatially so a control room
-- sees "4 alarms within 1.5km in the last hour near X" instead of 4 unrelated
-- cards. This is the difference between noise and intelligence.
create or replace function public.guardian_surges()
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_radius int := public.gcfg('surge_radius_m')::int;
  v_window int := public.gcfg('surge_window_min')::int;
  v_min    int := public.gcfg('surge_min_count')::int;
  v_out    json;
begin
  -- Each live emergency counts its recent neighbours; any point that clears
  -- the threshold becomes a surge centre. Keep the densest centres.
  with live as (
    select e.id, e.location, e.lat, e.lng, e.created_at
    from public.emergencies e
    where e.location is not null
      and e.created_at > now() - make_interval(mins => v_window)
      and e.status in ('escalating','acknowledged','escalated_112')
  ),
  clustered as (
    select a.id, a.lat, a.lng,
           count(*) as nearby,
           max(a.created_at) as latest
    from live a
    join live b on st_dwithin(a.location::geography, b.location::geography, v_radius)
    group by a.id, a.lat, a.lng
    having count(*) >= v_min
  )
  select coalesce(json_agg(json_build_object(
           'lat', lat, 'lng', lng,
           'emergency_count', nearby,
           'latest_at', latest,
           'radius_m', v_radius,
           'window_minutes', v_window)
         order by nearby desc), '[]'::json)
  into v_out
  from clustered;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. station_dashboard() — one call, everything a control room needs
-- ---------------------------------------------------------------------------
create or replace function public.station_dashboard(p_secret text)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_station public.station_accounts;
  v_feed    json;
begin
  select * into v_station from public.station_accounts
  where secret = p_secret and active;
  if v_station.id is null then
    return json_build_object('ok', false, 'error', 'Unknown station');
  end if;

  v_feed := public.station_feed(p_secret);

  return json_build_object(
    'ok', true,
    'station', json_build_object(
      'name', v_station.name, 'lat', v_station.lat, 'lng', v_station.lng),
    'offers', v_feed->'offers',
    -- city-wide pattern flags: shown to every station, since a surge is
    -- everyone's problem
    'surges', public.guardian_surges(),
    'stats', json_build_object(
      'live_emergencies', (select count(*) from public.emergencies
                           where status in ('escalating','acknowledged','escalated_112')),
      'assigned_to_me',   (select count(*) from public.dispatches d
                           join public.dispatch_offers o on o.id = d.current_offer_id
                           where d.status = 'assigned' and o.station_id = v_station.id),
      'unassigned',       (select count(*) from public.dispatches
                           where status = 'unassigned')),
    'engine', public.guardian_engine_health());
end;
$$;

revoke all on function public.guardian_surges() from public;
revoke all on function public.station_dashboard(text) from public;
grant execute on function public.station_dashboard(text) to anon, authenticated;
