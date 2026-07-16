-- Police dispatch test — run after 0002..0005. Rolls back everything.
\set ON_ERROR_STOP on
\pset pager off
begin;

update public.gateway_devices set secret = 'test-secret-123' where label = 'primary';
update public.guardian_config set value='on'  where key='wa_enabled' returning 'noop';
update public.guardian_config set value='DEMO-CODE' where key='station_enroll_code';

-- Three stations at increasing distance from the victim (Raipur ~21.25,81.63)
--   Alpha  ~1km, Bravo ~4km, Charlie ~9km
select public.station_register('DEMO-CODE','Alpha PS', '0771-1', 21.2560, 81.6300)->>'ok' as a_ok;
select public.station_register('DEMO-CODE','Bravo PS', '0771-2', 21.2850, 81.6300)->>'ok' as b_ok;
select public.station_register('DEMO-CODE','Charlie PS','0771-3', 21.3300, 81.6300)->>'ok' as c_ok;
-- grab each secret individually
select secret as sa from public.station_accounts where name='Alpha PS' \gset
select secret as sb from public.station_accounts where name='Bravo PS' \gset
select secret as sc from public.station_accounts where name='Charlie PS' \gset

\echo '=== D0. seed enroll code refused ==='
update public.guardian_config set value='CHANGE-ME-station-code' where key='station_enroll_code';
select public.station_register('CHANGE-ME-station-code','X',null,1,1)->>'error' as seed_refused;
update public.guardian_config set value='DEMO-CODE' where key='station_enroll_code';

-- victim + contact + live emergency (past countdown)
select public.guardian_register('9000000001','Test Victim','4321');
select public.guardian_verify('9000000001',
  (select otp_code from public.guardian_users where phone='9000000001'))::json->>'device_secret' as secret \gset
select public.guardian_add_contact(:'secret','Contact One','9000000011',1);
select public.guardian_trigger(:'secret', 21.2514, 81.6296, 'help')::json->>'emergency_id' as eid \gset
update public.emergencies set next_action_at = now() - interval '1s' where id = :'eid';
select public.escalate_emergencies();  -- now 'escalating'

\echo '=== D1. router creates a dispatch and offers the NEAREST (Alpha) ==='
select public.route_dispatches();
select d.status, sa.name as offered_to,
       round(o.distance_m) as dist_m
from public.dispatches d
join public.dispatch_offers o on o.id = d.current_offer_id
join public.station_accounts sa on sa.id = o.station_id
where d.emergency_id = :'eid';

\echo '  Alpha sees exactly ONE offer in its feed; Bravo/Charlie see NOTHING ==='
select json_array_length(public.station_feed(:'sa')::json->'offers') as alpha_sees,
       json_array_length(public.station_feed(:'sb')::json->'offers') as bravo_sees,
       json_array_length(public.station_feed(:'sc')::json->'offers') as charlie_sees;

\echo '  the offer carries victim + REACH PROOF fields:'
select o->'emergency'->>'victim' as victim,
       o->'emergency'->>'contact_reached' as reached,
       o->>'distance_km' as dist_km
from json_array_elements(public.station_feed(:'sa')::json->'offers') o;

\echo '=== D2. Alpha DECLINES (busy) → chain advances to Bravo immediately ==='
select public.station_respond(:'sa',
  (select o.id from public.dispatch_offers o join public.dispatches d on d.id=o.dispatch_id
   where d.emergency_id=:'eid' and o.status='offered'),
  'decline', 'all units engaged')->>'status' as alpha_decline;
select sa.name as now_offered_to
from public.dispatches d
join public.dispatch_offers o on o.id=d.current_offer_id
join public.station_accounts sa on sa.id=o.station_id
where d.emergency_id=:'eid';
select json_array_length(public.station_feed(:'sa')::json->'offers') as alpha_now_sees_0,
       json_array_length(public.station_feed(:'sb')::json->'offers') as bravo_now_sees_1;

\echo '=== D3. Bravo TIMES OUT (silence) → router advances to Charlie ==='
update public.dispatch_offers set expires_at = now() - interval '1s'
  where dispatch_id=(select id from public.dispatches where emergency_id=:'eid')
    and status='offered';
select public.route_dispatches();
select sa.name as now_offered_to
from public.dispatches d
join public.dispatch_offers o on o.id=d.current_offer_id
join public.station_accounts sa on sa.id=o.station_id
where d.emergency_id=:'eid';

\echo '=== D4. Charlie ACCEPTS → assigned + victim gets an SMS ==='
select public.station_respond(:'sc',
  (select o.id from public.dispatch_offers o join public.dispatches d on d.id=o.dispatch_id
   where d.emergency_id=:'eid' and o.status='offered'),
  'accept', null)->>'status' as charlie_accept;
select status from public.dispatches where emergency_id=:'eid';
select count(*)=1 as victim_notified from public.gateway_commands
  where emergency_id=:'eid' and body like '%have accepted your alert%';
select o->>'assigned' as assigned_flag, o->'emergency'->>'victim' as victim
from json_array_elements(public.station_feed(:'sc')::json->'offers') o;

\echo '=== D5. receipt tape tells the whole dispatch story ==='
select event, detail->>'station' as station, detail->>'reason' as reason
from public.emergency_events where emergency_id=:'eid'
  and event like 'DISPATCH%' order by id;

\echo '=== D6. STAND-DOWN only on PIN resolve (ack does NOT) ==='
-- ack first: dispatch must stay assigned
update public.emergencies set status='acknowledged' where id=:'eid';
select public.route_dispatches();
select status as still_assigned_after_ack from public.dispatches where emergency_id=:'eid';
-- now PIN-resolve: dispatch stands down
select public.guardian_cancel(:'secret', :'eid', '4321')->>'status' as resolved;
select public.route_dispatches();
select status as stood_down from public.dispatches where emergency_id=:'eid';

\echo '=== D7. exhaustion: fresh emergency, every station declines → UNASSIGNED ==='
select public.guardian_trigger(:'secret', 21.2514, 81.6296, null)::json->>'emergency_id' as eid2 \gset
update public.emergencies set next_action_at = now() - interval '1s' where id = :'eid2';
select public.escalate_emergencies();
select public.route_dispatches();  -- offers Alpha
-- decline all three in turn
do $$
declare v_eid uuid; v_off bigint; v_sec text;
begin
  select id into v_eid from public.emergencies where note is null
    and status='escalating' order by created_at desc limit 1;
  for i in 1..3 loop
    select o.id, sa.secret into v_off, v_sec
    from public.dispatch_offers o
    join public.dispatches d on d.id=o.dispatch_id
    join public.station_accounts sa on sa.id=o.station_id
    where d.emergency_id=v_eid and o.status='offered';
    exit when v_off is null;
    perform public.station_respond(v_sec, v_off, 'decline', 'busy');
  end loop;
end $$;
select status as should_be_unassigned from public.dispatches where emergency_id=:'eid2';
select count(*)=1 as unassigned_logged from public.emergency_events
  where emergency_id=:'eid2' and event='DISPATCH_UNASSIGNED';

rollback;
\echo '=== POLICE DISPATCH: ALL SCENARIOS EXECUTED (rolled back) ==='
