-- Guardian HARDENING test — run after 0002 + 0003. Rolls back everything.
\set ON_ERROR_STOP on
\pset pager off

begin;

update public.gateway_devices set secret = 'test-secret-123' where label = 'primary';

-- scaffold a verified user with 2 contacts
select public.guardian_register('9000000001', 'Test Victim', '4321');
select public.guardian_verify('9000000001',
  (select otp_code from public.guardian_users where phone = '9000000001')) as v \gset
select :'v'::json->>'device_secret' as secret \gset
select public.guardian_add_contact(:'secret', 'Contact One', '9000000011', 1);
select public.guardian_add_contact(:'secret', 'Contact Two', '9000000012', 2);

\echo '=== A3. OTP RATE LIMIT: sends 2,3 ok — send 4 within the hour refused ==='
select (public.guardian_register('9000000002', 'Rate Test', '1111')->>'ok')::boolean;
select (public.guardian_register('9000000002', 'Rate Test', '1111')->>'ok')::boolean;
select (public.guardian_register('9000000002', 'Rate Test', '1111')->>'ok')::boolean;
select public.guardian_register('9000000002', 'Rate Test', '1111')->>'error' as fourth_refused;

\echo '=== A5. ENGINE HEARTBEAT: run engine, health must report fresh + healthy ==='
select public.escalate_emergencies();
select (public.guardian_engine_health()->>'healthy')::boolean as engine_healthy,
       (public.guardian_engine_health()->>'seconds_ago')::int <= 1 as just_ran;

\echo '=== A2. DURESS PIN SETUP: wrong real PIN refused, same-PIN refused, then ok ==='
select public.guardian_set_duress_pin(:'secret', '0000', '9999')->>'error' as wrong_real_pin;
select public.guardian_set_duress_pin(:'secret', '4321', '4321')->>'error' as same_pin_refused;
select (public.guardian_set_duress_pin(:'secret', '4321', '9999')->>'ok')::boolean as duress_set;

\echo '=== A1. PIN BRUTE FORCE during live emergency ==='
select public.guardian_trigger(:'secret', 21.25, 81.63, 'brute test')::json->>'emergency_id' as eid \gset
\echo '  5 wrong PINs...'
select public.guardian_cancel(:'secret', :'eid', '0001')->>'error';
select public.guardian_cancel(:'secret', :'eid', '0002')->>'error';
select public.guardian_cancel(:'secret', :'eid', '0003')->>'error';
select public.guardian_cancel(:'secret', :'eid', '0004')->>'error';
select public.guardian_cancel(:'secret', :'eid', '0005')->>'error';
\echo '  lockout engaged: even the CORRECT pin is now refused...'
select public.guardian_cancel(:'secret', :'eid', '4321')->>'error' as locked_out;
\echo '  and the ladder FAST-FORWARDED (deadline pulled to now):'
select next_action_at <= now() as fast_forwarded from public.emergencies where id = :'eid';
\echo '  receipts show the whole fight:'
select event from public.emergency_events where emergency_id = :'eid' order by id;
\echo '  engine advances it immediately (countdown skipped by the brute-force rule):'
select public.escalate_emergencies();
select status, current_level from public.emergencies where id = :'eid';

-- clear lockout + resolve for next scenario
update public.guardian_users set pin_locked_until = null, pin_fails = 0
  where phone = '9000000001';
update public.emergencies set status = 'resolved' where id = :'eid';

\echo '=== A2. DURESS PIN in action ==='
select public.guardian_trigger(:'secret', 21.25, 81.63, 'duress test')::json->>'emergency_id' as eid2 \gset
\echo '  attacker forces her to cancel — she enters 9999 (duress). Response LIES:'
select public.guardian_cancel(:'secret', :'eid2', '9999');
\echo '  status API tells the SAME lie:'
select public.guardian_status(:'secret', :'eid2')->>'status' as shown_status;
\echo '  but the truth in the table: still live, duress flagged, deadline = NOW:'
select status, duress, next_action_at <= now() as fires_immediately
  from public.emergencies where id = :'eid2';
\echo '  engine climbs to level 1 despite the "cancel":'
select public.escalate_emergencies();
select status, current_level from public.emergencies where id = :'eid2';
\echo '  DURESS_PIN_USED is on the receipt tape (for the police feed):'
select count(*) = 1 as duress_logged from public.emergency_events
  where emergency_id = :'eid2' and event = 'DURESS_PIN_USED';

\echo '=== A2+A4. duress silence: ack arrives — responder confirmed, victim phone NOT texted ==='
select public.gateway_inbound('test-secret-123', '9000000011', 'coming');
select status, ack_channel from public.emergencies where id = :'eid2';
select count(*) filter (where to_phone = '9000000011' and body like '%confirmed - you are marked%') as responder_confirmed,
       count(*) filter (where to_phone = '9000000001' and body like '%confirmed they are responding%') as victim_texts_must_be_0
from public.gateway_commands where emergency_id = :'eid2';

\echo '=== A4. ack channel recorded as unverified sms in receipts ==='
select detail->>'channel' as channel, detail->>'verified' as verified
from public.emergency_events
where emergency_id = :'eid2' and event = 'ACKNOWLEDGED';

rollback;
\echo '=== ALL HARDENING SCENARIOS EXECUTED (rolled back) ==='
