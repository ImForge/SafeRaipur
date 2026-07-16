-- ============================================================================
-- SafeRaipur — GUARDIAN MODE: WHATSAPP VERIFIED CASCADE (apply AFTER 0003)
-- ============================================================================
-- Adds the third channel and, more importantly, PROOF OF REACH.
--
-- The cascade, per contact, per level:
--
--   WhatsApp template ──► Meta webhook says 'delivered'? ──► SMS CANCELLED
--        │                                                    (receipt logged)
--        │ no receipt within wa_hold_seconds (25s) or send failed
--        ▼
--   SMS released (works on keypad phones, no internet needed)
--        │
--   CALL from the gateway SIM fires immediately regardless — a local +91
--   number ringing is the one thing nobody sleeps through.
--
-- Why this shape:
--   • WhatsApp is instant, near-free, and RECEIPTED — Meta's webhook tells us
--     sent → delivered → read, message by message. "Did it reach them?" stops
--     being a hope and becomes a database fact (the police dashboard's
--     NO-CONTACT-REACHED flag is computed from exactly these receipts).
--   • The template's quick-reply button ("I'm responding ✓") arrives through
--     Meta's SIGNED webhook — a VERIFIED ack (SECURITY_AUDIT.md A4), unlike
--     spoofable SMS replies.
--   • WhatsApp never runs alone: no receipt → SMS fires anyway. The gateway
--     SIM stays the floor for keypad phones and dead data.
--
-- GRACEFUL WHEN UNCONFIGURED: wa_enabled ships 'off'. Every wa command then
-- fails instantly and loudly, which releases its SMS fallback IMMEDIATELY —
-- so until you finish the Meta setup (docs/WHATSAPP_SETUP.md), the system
-- behaves exactly like 0003. Nothing waits on WhatsApp that WhatsApp can't do.
--
-- Requires on Supabase: pg_net (enabled by default) + Vault for the token:
--   select vault.create_secret('<PERMANENT_META_TOKEN>', 'wa_token');
-- ============================================================================

-- pg_net: present on Supabase; absent on plain Postgres (local tests stub it)
do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable here (%). Fine locally; required on Supabase.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 1. CONFIG
-- ---------------------------------------------------------------------------
insert into public.guardian_config (key, value) values
  ('wa_enabled',          'off'),   -- flip to 'on' AFTER Meta setup is done
  ('wa_phone_number_id',  ''),      -- from Meta App dashboard → API Setup
  ('wa_template',         'guardian_emergency'),
  ('wa_lang',             'en'),
  ('wa_graph_version',    'v20.0'),
  ('wa_country_code',     '91'),    -- prefixed to 10-digit contact numbers
  ('wa_hold_seconds',     '25'),    -- how long SMS waits for a 'delivered'
  ('wa_ingest_secret',    'CHANGE-ME-wa-ingest')  -- shared with the Vercel webhook
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. DISPATCH QUEUE GROWS A CHANNEL — gateway_commands learns 'wa',
--    parent/child links, holds, and delivery receipts.
-- ---------------------------------------------------------------------------
alter table public.gateway_commands
  add column if not exists parent_id    bigint references public.gateway_commands(id),
  add column if not exists hold_until   timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists read_at      timestamptz;

alter table public.gateway_commands drop constraint if exists gateway_commands_action_check;
alter table public.gateway_commands
  add constraint gateway_commands_action_check
  check (action in ('sms','call','wa'));

alter table public.gateway_commands drop constraint if exists gateway_commands_status_check;
alter table public.gateway_commands
  add constraint gateway_commands_status_check
  check (status in ('pending','held','sent','done','failed','cancelled'));

create index if not exists gcommands_held_ix
  on public.gateway_commands (hold_until) where status = 'held';

-- The physical phone must NEVER pick up 'wa' rows — those go out over HTTP.
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
        and action in ('sms','call')          -- ← wa excluded
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

-- ---------------------------------------------------------------------------
-- 3. THE WHATSAPP SENDER — a trigger on insert of action='wa'
-- ---------------------------------------------------------------------------
-- For wa rows, `body` carries JSON: {"name": "...", "link": "..."} — the two
-- template variables. The HTTP call goes out via pg_net (async, fire-and-log);
-- CONFIRMATION comes back through the webhook, never assumed.
create or replace function public.wa_send_command()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_token   text;
  v_pnid    text := public.gcfg('wa_phone_number_id');
  v_params  json;
  v_payload jsonb;
begin
  if new.action <> 'wa' then return new; end if;

  -- FAIL LOUD + RELEASE FAST: any reason WhatsApp can't fly marks the command
  -- failed immediately, which lets process_held_commands() release the SMS
  -- fallback on its very next tick instead of burning the 25 s hold.
  if public.gcfg('wa_enabled') <> 'on' then
    update public.gateway_commands
    set status = 'failed', done_at = now(),
        last_error = 'whatsapp disabled (wa_enabled=off)'
    where id = new.id;
    return new;
  end if;

  begin
    select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'wa_token' limit 1;
  exception when others then v_token := null;
  end;

  if v_token is null or v_pnid = '' then
    update public.gateway_commands
    set status = 'failed', done_at = now(),
        last_error = 'whatsapp misconfigured: missing vault wa_token or wa_phone_number_id'
    where id = new.id;
    if new.emergency_id is not null then
      perform public.g_log(new.emergency_id, 'WA_FAILED',
        json_build_object('command_id', new.id, 'error', 'misconfigured')::jsonb);
    end if;
    return new;
  end if;

  v_params := new.body::json;
  v_payload := jsonb_build_object(
    'messaging_product', 'whatsapp',
    'to', public.gcfg('wa_country_code') || new.to_phone,
    'type', 'template',
    'template', jsonb_build_object(
      'name', public.gcfg('wa_template'),
      'language', jsonb_build_object('code', public.gcfg('wa_lang')),
      'components', jsonb_build_array(jsonb_build_object(
        'type', 'body',
        'parameters', jsonb_build_array(
          jsonb_build_object('type','text','text', coalesce(v_params->>'name','Someone')),
          jsonb_build_object('type','text','text', coalesce(v_params->>'link','(no location)'))
        )))));

  perform net.http_post(
    url     := 'https://graph.facebook.com/' || public.gcfg('wa_graph_version')
               || '/' || v_pnid || '/messages',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_token,
                 'Content-Type', 'application/json'),
    body    := v_payload);

  update public.gateway_commands
  set status = 'sent', sent_at = now(), attempts = attempts + 1
  where id = new.id;
  return new;
end;
$$;

drop trigger if exists wa_send_on_insert on public.gateway_commands;
create trigger wa_send_on_insert
  after insert on public.gateway_commands
  for each row execute function public.wa_send_command();

-- ---------------------------------------------------------------------------
-- 4. THE HOLD/RELEASE SWEEP — SMS fallbacks obey their WhatsApp parent
-- ---------------------------------------------------------------------------
create or replace function public.process_held_commands()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_n int := 0;
  rec record;
begin
  for rec in
    select c.id, c.emergency_id, c.to_phone,
           p.status as parent_status, p.delivered_at as parent_delivered
    from public.gateway_commands c
    join public.gateway_commands p on p.id = c.parent_id
    where c.status = 'held'
      and (p.delivered_at is not null            -- parent reached → cancel
           or p.status = 'failed'                -- parent dead → release now
           or c.hold_until <= now())             -- hold expired → release
    for update of c skip locked
  loop
    if rec.parent_delivered is not null then
      update public.gateway_commands
      set status = 'cancelled', done_at = now(),
          last_error = 'whatsapp delivered — sms not needed'
      where id = rec.id;
    else
      update public.gateway_commands
      set status = 'pending', hold_until = null
      where id = rec.id;
      if rec.emergency_id is not null then
        perform public.g_log(rec.emergency_id, 'SMS_FALLBACK_RELEASED',
          json_build_object('phone_last4', right(rec.to_phone, 4),
                            'reason', case when rec.parent_status = 'failed'
                                           then 'whatsapp failed' else 'no delivery receipt' end)::jsonb);
      end if;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'guardian-held';
select cron.schedule('guardian-held', '15 seconds',
  $$select public.process_held_commands()$$);

-- ---------------------------------------------------------------------------
-- 5. WEBHOOK INGEST — wa_ingest(): receipts in, verified acks in
-- ---------------------------------------------------------------------------
-- Called ONLY by the Vercel route (frontend/api/wa-webhook.js), which has
-- already verified Meta's X-Hub-Signature-256. A second shared secret gates
-- this RPC so nobody can feed us fake receipts by calling PostgREST directly
-- (SECURITY_AUDIT.md, "webhook forgery").
create or replace function public.wa_ingest(p_secret text, p_payload jsonb)
returns json
language plpgsql security definer set search_path = public
as $$
declare
  v_change   jsonb;
  v_item     jsonb;
  v_phone    text;
  v_cmd      public.gateway_commands;
  v_statuses int := 0;
  v_acks     int := 0;
  rec        record;
  v_reply    text;
begin
  if p_secret is distinct from public.gcfg('wa_ingest_secret')
     or public.gcfg('wa_ingest_secret') = 'CHANGE-ME-wa-ingest' then
    return json_build_object('ok', false, 'error', 'Unauthorized');
  end if;

  for v_change in
    select c->'value' from jsonb_path_query(p_payload, '$.entry[*].changes[*]') as t(c)
  loop
    -- ── delivery receipts ────────────────────────────────────────────────
    for v_item in select * from jsonb_array_elements(coalesce(v_change->'statuses','[]'::jsonb))
    loop
      v_statuses := v_statuses + 1;
      v_phone := public.g_norm_phone(v_item->>'recipient_id');

      -- match the newest in-flight wa command to that phone (wamid-free
      -- matching: simpler and survives pg_net's async response model)
      select * into v_cmd from public.gateway_commands
      where action = 'wa' and to_phone = v_phone
        and status in ('sent','done')
      order by id desc limit 1;
      if v_cmd.id is null then continue; end if;

      if v_item->>'status' = 'delivered' and v_cmd.delivered_at is null then
        update public.gateway_commands
        set delivered_at = now(), status = 'done', done_at = coalesce(done_at, now())
        where id = v_cmd.id;
        if v_cmd.emergency_id is not null then
          perform public.g_log(v_cmd.emergency_id, 'WA_DELIVERED',
            json_build_object('phone_last4', right(v_phone,4))::jsonb);
        end if;
        -- cancel its held SMS children right now (don't wait for the sweep)
        update public.gateway_commands
        set status = 'cancelled', done_at = now(),
            last_error = 'whatsapp delivered — sms not needed'
        where parent_id = v_cmd.id and status = 'held';

      elsif v_item->>'status' = 'read' then
        update public.gateway_commands set read_at = coalesce(read_at, now())
        where id = v_cmd.id;
        if v_cmd.emergency_id is not null then
          perform public.g_log(v_cmd.emergency_id, 'WA_READ',
            json_build_object('phone_last4', right(v_phone,4))::jsonb);
        end if;

      elsif v_item->>'status' = 'failed' then
        update public.gateway_commands
        set status = 'failed', done_at = now(),
            last_error = coalesce(v_item#>>'{errors,0,title}', 'whatsapp send failed')
        where id = v_cmd.id and delivered_at is null;
        if v_cmd.emergency_id is not null then
          perform public.g_log(v_cmd.emergency_id, 'WA_FAILED',
            json_build_object('phone_last4', right(v_phone,4),
                              'error', v_item#>>'{errors,0,title}')::jsonb);
        end if;
      end if;
    end loop;

    -- ── inbound messages: the VERIFIED ack path ──────────────────────────
    for v_item in select * from jsonb_array_elements(coalesce(v_change->'messages','[]'::jsonb))
    loop
      v_phone := public.g_norm_phone(v_item->>'from');
      v_reply := coalesce(v_item#>>'{button,text}',
                          v_item#>>'{interactive,button_reply,title}',
                          v_item#>>'{text,body}', '');

      for rec in
        select e.id as emergency_id, e.duress, c.id as contact_id,
               c.name as contact_name, u.phone as user_phone, u.name as user_name
        from public.emergencies e
        join public.guardian_contacts c on c.user_id = e.user_id and c.phone = v_phone
        join public.guardian_users u    on u.id = e.user_id
        where e.status in ('countdown','escalating')
      loop
        update public.emergencies
        set status = 'acknowledged', next_action_at = null,
            acked_by = rec.contact_id, ack_channel = 'whatsapp', updated_at = now()
        where id = rec.emergency_id;

        perform public.g_log(rec.emergency_id, 'ACKNOWLEDGED', json_build_object(
          'by', rec.contact_name, 'channel', 'whatsapp', 'verified', true,
          'reply', left(v_reply, 200))::jsonb);

        -- confirmations ride the SMS path (always works, gateway sends)
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.emergency_id, 'sms', v_phone,
          'SafeRaipur: confirmed - you are marked as responding for ' || rec.user_name
          || '. Please reach them or call 112 if you cannot.');
        if not rec.duress then
          insert into public.gateway_commands (emergency_id, action, to_phone, body)
          values (rec.emergency_id, 'sms', rec.user_phone,
            'SafeRaipur: ' || rec.contact_name || ' confirmed they are responding.');
        end if;
        v_acks := v_acks + 1;
      end loop;
    end loop;
  end loop;

  return json_build_object('ok', true, 'statuses', v_statuses, 'acks', v_acks);
end;
$$;

revoke all on function public.wa_ingest(text, jsonb) from public;
grant execute on function public.wa_ingest(text, jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. THE ENGINE LEARNS THE CASCADE — escalate_emergencies v3
--    (identical to 0003's version except the messaging block per level and
--     the 112 blast now lead with WhatsApp; duress + heartbeat unchanged)
-- ---------------------------------------------------------------------------
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

      -- CALL the rung's contact — immediate, unconditional
      insert into public.gateway_commands (emergency_id, action, to_phone)
      values (rec.id, 'call', v_contact.phone);

      -- WhatsApp + held-SMS pair, per target contact
      -- (level 1 reaches the whole ladder; later levels only the new rung)
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
      -- ── 112 protocol: urgency means BOTH channels immediately, no holds ──
      for c in select * from public.guardian_contacts gc where gc.user_id = rec.user_id
      loop
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'wa', c.phone,
                json_build_object('name', v_user.name, 'link', v_maplink)::text);
        insert into public.gateway_commands (emergency_id, action, to_phone, body)
        values (rec.id, 'sms', c.phone,
                'NO ONE HAS RESPONDED for ' || v_user.name ||
                '. CALL 112 (police emergency) NOW and share: ' || v_maplink);
      end loop;

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
