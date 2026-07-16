-- WhatsApp cascade test — run after 0002..0004. Rolls back everything.
-- Stubs pg_net + vault locally so we can assert the EXACT payloads sent.
\set ON_ERROR_STOP on
\pset pager off

begin;

-- ── local stubs (no-ops on Supabase where the real ones exist first) ──
do $$ begin
  if not exists (select 1 from pg_namespace where nspname = 'net') then
    create schema net;
    create table net._capture (id bigserial primary key, url text, headers jsonb, body jsonb);
    create function net.http_post(url text, body jsonb default '{}'::jsonb,
                                  params jsonb default '{}'::jsonb,
                                  headers jsonb default '{}'::jsonb,
                                  timeout_milliseconds int default 5000)
    returns bigint language sql as
    $f$ insert into net._capture(url, headers, body) values (url, headers, body) returning id $f$;
  end if;
  if not exists (select 1 from pg_namespace where nspname = 'vault') then
    create schema vault;
    create table vault._secrets (name text primary key, decrypted_secret text);
    create view vault.decrypted_secrets as select name, decrypted_secret from vault._secrets;
  end if;
end $$;
insert into vault._secrets values ('wa_token', 'TEST-TOKEN-123');

update public.gateway_devices set secret = 'test-secret-123' where label = 'primary';

-- scaffold verified user + 2 contacts
select public.guardian_register('9000000001', 'Test Victim', '4321');
select public.guardian_verify('9000000001',
  (select otp_code from public.guardian_users where phone='9000000001')) as v \gset
select :'v'::json->>'device_secret' as secret \gset
select public.guardian_add_contact(:'secret','Contact One','9000000011',1);
select public.guardian_add_contact(:'secret','Contact Two','9000000012',2);

\echo '=== W0. wa DISABLED (default): wa fails instantly, sms releases on next sweep ==='
select public.guardian_trigger(:'secret', 21.25, 81.63, null)::json->>'emergency_id' as eid0 \gset
update public.emergencies set next_action_at = now() - interval '1s' where id = :'eid0';
select public.escalate_emergencies();
select action, status, left(coalesce(last_error,''),40) as err
  from public.gateway_commands where emergency_id = :'eid0' order by id;
select public.process_held_commands() as released;
select count(*) filter (where action='sms' and status='pending') as sms_released_now
  from public.gateway_commands where emergency_id = :'eid0';
update public.emergencies set status='resolved' where id = :'eid0';

\echo '=== W1. wa ENABLED: level 1 = call + (wa + held sms) per contact ==='
update public.guardian_config set value='on' where key='wa_enabled';
update public.guardian_config set value='111222333' where key='wa_phone_number_id';
update public.guardian_config set value='secret-ingest-9' where key='wa_ingest_secret';

select public.guardian_trigger(:'secret', 21.25, 81.63, 'cascade test')::json->>'emergency_id' as eid \gset
update public.emergencies set next_action_at = now() - interval '1s' where id = :'eid';
select public.escalate_emergencies();
select action, to_phone, status, parent_id is not null as has_parent
  from public.gateway_commands where emergency_id = :'eid' order by id;

\echo '  the actual HTTP payload sent to Meta (url + template params):'
select url, body->>'to' as to_number,
       body#>>'{template,name}' as template,
       body#>'{template,components,0,parameters}' as params
from net._capture order by id;
select headers->>'Authorization' = 'Bearer TEST-TOKEN-123' as auth_header_ok
from net._capture limit 1;

\echo '=== W2. webhook DELIVERED for contact 1 → its held sms CANCELLED ==='
select public.wa_ingest('secret-ingest-9', jsonb_build_object('entry', jsonb_build_array(
  jsonb_build_object('changes', jsonb_build_array(jsonb_build_object('value',
    jsonb_build_object('statuses', jsonb_build_array(
      jsonb_build_object('status','delivered','recipient_id','919000000011')))))))));
select to_phone, action, status from public.gateway_commands
  where emergency_id = :'eid' and to_phone='9000000011' order by id;

\echo '=== W3. contact 2: NO receipt → hold expires → sms released, receipt logged ==='
update public.gateway_commands set hold_until = now() - interval '1s'
  where emergency_id = :'eid' and status = 'held';
select public.process_held_commands();
select to_phone, action, status from public.gateway_commands
  where emergency_id = :'eid' and to_phone='9000000012' order by id;
select count(*)=1 as fallback_logged from public.emergency_events
  where emergency_id = :'eid' and event='SMS_FALLBACK_RELEASED';

\echo '=== W4. gateway poll never sees wa rows ==='
select public.gateway_poll('test-secret-123')::json->'commands' as claimed_by_phone;
select bool_and((c->>'action') in ('sms','call')) as only_sms_and_call
from json_array_elements((select public.gateway_poll('test-secret-123')::json->'commands')) c;

\echo '=== W5. VERIFIED ack: contact 1 taps the WhatsApp button ==='
select public.wa_ingest('secret-ingest-9', jsonb_build_object('entry', jsonb_build_array(
  jsonb_build_object('changes', jsonb_build_array(jsonb_build_object('value',
    jsonb_build_object('messages', jsonb_build_array(
      jsonb_build_object('from','919000000011',
        'button', jsonb_build_object('text', $$I'm responding ✓$$)))))))))) ;
select status, ack_channel from public.emergencies where id = :'eid';
select detail->>'channel' as channel, detail->>'verified' as verified
from public.emergency_events where emergency_id = :'eid' and event='ACKNOWLEDGED';

\echo '=== W6. bad ingest secret refused; seed secret refused ==='
select public.wa_ingest('wrong', '{}'::jsonb)->>'error' as bad_secret;
update public.guardian_config set value='CHANGE-ME-wa-ingest' where key='wa_ingest_secret';
select public.wa_ingest('CHANGE-ME-wa-ingest', '{}'::jsonb)->>'error' as seed_refused;

rollback;
\echo '=== WHATSAPP CASCADE: ALL SCENARIOS EXECUTED (rolled back) ==='
