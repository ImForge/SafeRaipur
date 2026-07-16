-- Guardian Mode state machine test — run against a DB with 0002 applied.
-- Time is fast-forwarded by editing next_action_at, then calling
-- escalate_emergencies() directly (exactly what pg_cron does).
\set ON_ERROR_STOP on
\pset pager off

begin;

-- gateway device for the test
update public.gateway_devices set secret = 'test-secret-123' where label = 'primary';

\echo '=== 1. REGISTER + OTP + VERIFY ==='
select public.guardian_register('+91 90000 00001', 'Test Victim', '4321');
select count(*) = 1 as otp_sms_queued from public.gateway_commands
  where action = 'sms' and to_phone = '9000000001' and body like '%code%';
select public.guardian_verify('9000000001',
  (select otp_code from public.guardian_users where phone = '9000000001')) as verify_result
\gset
select (:'verify_result'::json->>'ok')::boolean as verified;
select :'verify_result'::json->>'device_secret' as secret \gset
\echo '  wrong OTP must fail:'
select (public.guardian_verify('9000000001', '000000')->>'ok')::boolean = false as wrong_otp_rejected;

\echo '=== 2. TRIGGER WITH ZERO CONTACTS MUST REFUSE LOUDLY ==='
select public.guardian_trigger(:'secret') ->> 'error' as refusal;

\echo '=== 3. ADD CONTACTS ==='
select public.guardian_add_contact(:'secret', 'Contact One', '9000000011', 1);
select public.guardian_add_contact(:'secret', 'Contact Two', '9000000012', 2);

\echo '=== 4. TRIGGER -> COUNTDOWN (gateway is stale: no poll yet -> gateway_ok false) ==='
select public.guardian_trigger(:'secret', 21.2514, 81.6296, 'drill') as trig \gset
select (:'trig'::json->>'gateway_ok')::boolean as gateway_ok_should_be_false;
select :'trig'::json->>'emergency_id' as eid \gset
select status, current_level from public.emergencies where id = :'eid';

\echo '=== 5. GATEWAY HEARTBEAT -> alive flips true ==='
select public.gateway_poll('test-secret-123')->>'ok' as poll_ok;
select public.g_gateway_alive() as gateway_now_alive;

\echo '=== 6. COUNTDOWN EXPIRES -> LEVEL 1 (call #1 + SMS BOTH contacts) ==='
update public.emergencies set next_action_at = now() - interval '1 second' where id = :'eid';
select public.escalate_emergencies() as advanced;
select status, current_level from public.emergencies where id = :'eid';
select action, to_phone from public.gateway_commands
  where emergency_id = :'eid' and status = 'pending' order by id;

\echo '=== 7. GATEWAY CLAIMS + a CALL FAILS -> SMS FALLBACK AUTO-QUEUED ==='
select json_array_length(public.gateway_poll('test-secret-123')->'commands') as claimed;
select public.gateway_report('test-secret-123',
  (select id from public.gateway_commands where emergency_id = :'eid' and action = 'call' order by id limit 1),
  false, 'no network on SIM');
select count(*) as fallback_sms from public.gateway_commands
  where emergency_id = :'eid' and status = 'pending'
    and body like '%tried to CALL you%';

\echo '=== 8. LEVEL 1 TIMES OUT -> LEVEL 2 (call #2 + SMS only #2) ==='
update public.emergencies set next_action_at = now() - interval '1 second' where id = :'eid';
select public.escalate_emergencies();
select status, current_level from public.emergencies where id = :'eid';
select action, to_phone from public.gateway_commands
  where emergency_id = :'eid' and status = 'pending' order by id;

\echo '=== 9. LADDER EXHAUSTED -> ESCALATED_112 (blast to contacts + victim, NO auto-dial) ==='
update public.emergencies set next_action_at = now() - interval '1 second' where id = :'eid';
select public.escalate_emergencies();
select status from public.emergencies where id = :'eid';
select count(*) filter (where body like '%CALL 112%')  as blast_112,
       count(*) filter (where action = 'call' and to_phone = '112') as auto_dial_should_be_0
from public.gateway_commands where emergency_id = :'eid' and status = 'pending';

\echo '=== 10. RECEIPT TAPE ==='
select event, detail from public.emergency_events where emergency_id = :'eid' order by id;

\echo '=== 11. SECOND EMERGENCY: ACK PATH HALTS THE LADDER ==='
update public.emergencies set status = 'resolved' where id = :'eid';
select public.guardian_trigger(:'secret')::json->>'emergency_id' as eid2 \gset
update public.emergencies set next_action_at = now() - interval '1 second' where id = :'eid2';
select public.escalate_emergencies();  -- now at level 1
select public.gateway_inbound('test-secret-123', '+919000000011', 'omw!!') ->> 'matched' as matched;
select status, acked_by is not null as has_acker from public.emergencies where id = :'eid2';
\echo '  ladder must NOT advance after ack even past deadline:'
select public.escalate_emergencies() as advanced_should_be_0;

\echo '=== 12. PIN CANCEL DURING COUNTDOWN + WRONG PIN REJECTED ==='
update public.emergencies set status = 'resolved' where user_id =
  (select id from public.guardian_users where phone = '9000000001');
select public.guardian_trigger(:'secret')::json->>'emergency_id' as eid3 \gset
select public.guardian_cancel(:'secret', :'eid3', '9999') ->> 'error' as wrong_pin;
select public.guardian_cancel(:'secret', :'eid3', '4321') ->> 'status' as cancelled;

\echo '=== 13. RETRIGGER FAST-FORWARD (second press = escalate NOW) ==='
select public.guardian_trigger(:'secret')::json->>'emergency_id' as eid4 \gset
select next_action_at > now() + interval '30 seconds' as countdown_running
  from public.emergencies where id = :'eid4';
select public.guardian_trigger(:'secret')::json->>'status' as second_press;
select next_action_at <= now() as deadline_pulled_to_now
  from public.emergencies where id = :'eid4';

\echo '=== 14. SEED SECRET MUST BE REFUSED ==='
update public.gateway_devices set secret = 'CHANGE-ME-before-first-run' where label = 'primary';
select public.gateway_poll('CHANGE-ME-before-first-run') ->> 'error' as seed_refused;

rollback;
\echo '=== ALL SCENARIOS EXECUTED (rolled back) ==='
