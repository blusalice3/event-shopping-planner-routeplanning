begin;

select plan(40);

select has_table('public', 'room_route_order_versions', 'mvp2c creates route-order version table');
select has_table('public', 'notification_reads', 'mvp2c creates member notification read table');
select has_function(
  'public',
  'update_route_order',
  array['uuid', 'text', 'text[]', 'bigint'],
  'mvp2c update_route_order RPC exists'
);
select has_function(
  'public',
  'get_route_order_by_date',
  array['uuid', 'text'],
  'mvp2c get_route_order_by_date RPC exists'
);
select has_function(
  'public',
  'get_notification_list',
  array['uuid', 'integer', 'boolean'],
  'mvp2c notification list RPC exists'
);
select has_function(
  'public',
  'mark_notification_read',
  array['uuid', 'uuid', 'boolean'],
  'mvp2c mark_notification_read RPC exists'
);
select has_function(
  'public',
  'hide_notification',
  array['uuid', 'uuid', 'boolean'],
  'mvp2c hide_notification RPC exists'
);

insert into private.sharing_secret_versions(
  secret_kind,
  secret_version,
  secret_value,
  is_current,
  is_accepted
) values
  ('payload_encryption', 1, repeat('p', 32), true, true),
  ('payload_fixture_encryption', 1, repeat('f', 32), true, true),
  ('room_code', 1, repeat('r', 32), true, true),
  ('room_code_encryption', 1, repeat('e', 32), true, true),
  ('member_restore_lookup', 1, repeat('l', 32), true, true),
  ('member_restore_verify', 1, repeat('v', 32), true, true)
on conflict (secret_kind, secret_version) do update
  set secret_value = excluded.secret_value,
      is_current = excluded.is_current,
      is_accepted = excluded.is_accepted,
      retired_at = null;

update private.sharing_runtime_config
set public_mode = 'local',
    guard_required = false,
    payload_protection_mode = 'encrypted';

create temp table mvp2c_values(
  key text primary key,
  value text not null
) on commit drop;

insert into mvp2c_values(key, value) values
  ('room_id', 'abababab-abab-4bab-8bab-abababababab'),
  ('host_auth', '11111111-1111-4111-8111-111111111111'),
  ('guest_auth', '22222222-2222-4222-8222-222222222222'),
  ('host_token', repeat('h', 43)),
  ('guest_token', repeat('g', 43)),
  (
    'payload',
    '{"dayModes":{},"eventMetadata":{"eventName":"MVP2c Event"},"executeModeItems":{"2026-08-15":["item-1","item-2"],"2026-08-16":["item-3"]},"hallDefinitions":{},"hallRouteSettings":{},"itemSnapshots":{"item-1":{"eventDate":"2026-08-15","price":1200,"quantity":2,"remarks":"first","title":"Book","url":"https://example.test/first"},"item-2":{"eventDate":"2026-08-15","price":800,"quantity":3,"remarks":"second","title":"Zine","url":"https://example.test/second"},"item-3":{"eventDate":"2026-08-16","price":500,"quantity":1,"remarks":"third","title":"Goods","url":"https://example.test/third"}},"mapData":{},"mapRotationSettings":{},"mapViewportSettings":{},"routeOrderByDate":{"2026-08-15":["item-1","item-2"],"2026-08-16":["item-3"]},"routeSettings":{},"schemaVersion":1}'
  );

create temp table mvp2c_results(
  key text primary key,
  value jsonb not null
) on commit drop;

select set_config('request.jwt.claim.sub', (select value from mvp2c_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2c_results(key, value)
select 'prepare_create',
       public.prepare_create_room_challenge(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         (select value from mvp2c_values where key = 'payload'),
         private.base64url(extensions.digest(convert_to((select value from mvp2c_values where key = 'payload'), 'UTF8'), 'sha256')),
         3,
         1,
         'encrypted'
       );

insert into mvp2c_results(key, value)
select 'create_room',
       public.create_room(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         'Host',
         (select value from mvp2c_values where key = 'host_token'),
         ((select value from mvp2c_results where key = 'prepare_create') #>> '{data,challengeId}')::uuid
       );

select ok(
  ((select value from mvp2c_results where key = 'create_room') ->> 'ok')::boolean,
  'sharing_mvp2c_route: create_room succeeds'
);

select is(
  (select route_order_version::text from public.rooms where id = (select value::uuid from mvp2c_values where key = 'room_id')),
  '0',
  'sharing_mvp2c_route: migration enables route sync with version zero'
);

select is(
  (select value #>> '{data,routeOrderVersion}' from mvp2c_results where key = 'create_room'),
  '0',
  'sharing_mvp2c_route: create_room returns the enabled route version'
);

select is(
  (
    select accepted_contract_version::text
    from public.room_members
    where id = ((select value from mvp2c_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid
  ),
  '2',
  'sharing_mvp2c_contract: host member stores accepted contract v2'
);

update public.room_members
set accepted_contract_version = null
where id = ((select value from mvp2c_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid;

insert into mvp2c_results(key, value)
select 'legacy_host_versions',
       public.get_room_versions((select value::uuid from mvp2c_values where key = 'room_id'));

select is(
  (select value ->> 'ok' from mvp2c_results where key = 'legacy_host_versions'),
  'false',
  'sharing_mvp2c_contract: legacy member cannot call sync RPCs'
);

select is(
  public.can_select_room_sync_rows((select value::uuid from mvp2c_values where key = 'room_id'))::text,
  'false',
  'sharing_mvp2c_contract: legacy member cannot select sync rows'
);

update public.room_members
set accepted_contract_version = 2
where id = ((select value from mvp2c_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid;

select set_config('request.jwt.claim.sub', (select value from mvp2c_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp2c_results(key, value)
select 'prepare_join',
       public.prepare_room_member_token(
         (select value #>> '{data,roomCode}' from mvp2c_results where key = 'create_room')
       );

insert into mvp2c_results(key, value)
select 'join_room',
       public.join_room_by_code(
         ((select value from mvp2c_results where key = 'prepare_join') #>> '{data,challengeId}')::uuid,
         (select value from mvp2c_values where key = 'guest_token'),
         'Guest'
       );

select ok(
  ((select value from mvp2c_results where key = 'join_room') ->> 'ok')::boolean,
  'sharing_mvp2c_route: guest joins before route update'
);

select is(
  (
    select accepted_contract_version::text
    from public.room_members
    where id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  '2',
  'sharing_mvp2c_contract: joined member stores accepted contract v2'
);

update public.room_members
set accepted_contract_version = null
where id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid;

select set_config('request.jwt.claim.sub', (select value from mvp2c_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

select is(
  public.can_select_room_sync_rows((select value::uuid from mvp2c_values where key = 'room_id'))::text,
  'false',
  'sharing_mvp2c_contract: legacy joined member cannot select sync rows'
);

insert into public.notifications(
  id,
  room_id,
  idempotency_key,
  notification_type,
  payload
) values (
  '33333333-3333-4333-8333-333333333333',
  (select value::uuid from mvp2c_values where key = 'room_id'),
  'mvp2c-legacy-delivery-test',
  'item_updated',
  '{}'::jsonb
);

select private.create_room_notification_delivery(
  '33333333-3333-4333-8333-333333333333',
  (select value::uuid from mvp2c_values where key = 'room_id')
);

select is(
  (
    select count(*)::text
    from public.notification_delivery_state
    where notification_id = '33333333-3333-4333-8333-333333333333'
  ),
  '1',
  'sharing_mvp2c_contract: room notification delivery skips legacy members'
);

select is(
  (
    select count(*)::text
    from public.notification_delivery_state
    where notification_id = '33333333-3333-4333-8333-333333333333'
      and room_member_id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  '0',
  'sharing_mvp2c_contract: legacy joined member receives no notification delivery'
);

update public.room_members
set accepted_contract_version = 2
where id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid;

select set_config('request.jwt.claim.sub', (select value from mvp2c_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2c_results(key, value)
select 'route_day_1',
       public.update_route_order(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '2026-08-15',
         array['item-2', 'item-1'],
         0
       );

select ok(
  ((select value from mvp2c_results where key = 'route_day_1') ->> 'ok')::boolean,
  'sharing_mvp2c_route: host updates day-specific route order'
);

select is(
  (select value #>> '{data,dateRouteOrderVersion}' from mvp2c_results where key = 'route_day_1'),
  '1',
  'sharing_mvp2c_route: day route version increments to one'
);

select is(
  (select value #>> '{data,routeOrderVersion}' from mvp2c_results where key = 'route_day_1'),
  '1',
  'sharing_mvp2c_route: room route version increments'
);

select is(
  (select red.event_data #>> '{routeOrderByDate,2026-08-15,0}'
   from public.room_event_data red
   where red.room_id = (select value::uuid from mvp2c_values where key = 'room_id')),
  'item-2',
  'sharing_mvp2c_route: room_event_data routeOrderByDate is updated'
);

select is(
  (select order_index::text
   from public.room_items
   where room_id = (select value::uuid from mvp2c_values where key = 'room_id')
     and local_item_id = 'item-2'),
  '0',
  'sharing_mvp2c_route: room_items order_index follows route order'
);

insert into mvp2c_results(key, value)
select 'route_day_2',
       public.update_route_order(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '2026-08-16',
         array['item-3'],
         0
       );

select ok(
  ((select value from mvp2c_results where key = 'route_day_2') ->> 'ok')::boolean,
  'sharing_mvp2c_route: another date can update from version zero'
);

select is(
  (select value #>> '{data,routeOrderVersions,2026-08-15}' from mvp2c_results where key = 'route_day_2'),
  '1',
  'sharing_mvp2c_route: unrelated date version is preserved'
);

insert into mvp2c_results(key, value)
select 'stale_route_conflict',
       public.update_route_order(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '2026-08-15',
         array['item-1', 'item-2'],
         0
       );

select is(
  (select value #>> '{error,code}' from mvp2c_results where key = 'stale_route_conflict'),
  'ROUTE_ORDER_CONFLICT',
  'sharing_mvp2c_route: stale same-date version conflicts'
);

insert into mvp2c_results(key, value)
select 'invalid_cross_date',
       public.update_route_order(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '2026-08-15',
         array['item-3'],
         1
       );

select is(
  (select value #>> '{error,code}' from mvp2c_results where key = 'invalid_cross_date'),
  'INVALID_REQUEST',
  'sharing_mvp2c_route: route cannot include an item from another event date'
);

select set_config('request.jwt.claim.sub', (select value from mvp2c_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp2c_results(key, value)
select 'guest_route_day_1',
       public.get_route_order_by_date(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '2026-08-15'
       );

select is(
  (select value #>> '{data,itemIds,0}' from mvp2c_results where key = 'guest_route_day_1'),
  'item-2',
  'sharing_mvp2c_route: guest fetches updated date route order'
);

insert into mvp2c_results(key, value)
select 'guest_versions',
       public.get_room_versions((select value::uuid from mvp2c_values where key = 'room_id'));

select is(
  (select value #>> '{data,routeOrderVersions,2026-08-15}' from mvp2c_results where key = 'guest_versions'),
  '1',
  'sharing_mvp2c_route: get_room_versions returns date version map'
);

insert into mvp2c_results(key, value)
select 'guest_route_ack_current',
       public.ack_room_route_order_versions(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '{"2026-08-15":1,"2026-08-16":1}'::jsonb
       );

insert into mvp2c_results(key, value)
select 'guest_route_ack_stale_partial',
       public.ack_room_route_order_versions(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         '{"2026-08-15":0}'::jsonb
       );

select is(
  (
    select route_order_versions #>> '{2026-08-15}'
    from public.room_member_sync_state
    where room_member_id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  '1',
  'sharing_mvp2c_route_ack: stale route ack does not roll back an acknowledged date version'
);

select is(
  (
    select route_order_versions #>> '{2026-08-16}'
    from public.room_member_sync_state
    where room_member_id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  '1',
  'sharing_mvp2c_route_ack: partial route ack does not drop another acknowledged date version'
);

select is(
  (select value #>> '{data,routeOrderVersions,2026-08-16}' from mvp2c_results where key = 'guest_route_ack_stale_partial'),
  '1',
  'sharing_mvp2c_route_ack: stale partial ack returns the stored merged route versions'
);

insert into mvp2c_results(key, value)
select 'guest_notifications',
       public.get_notification_list(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         50,
         false
       );

select ok(
  jsonb_path_exists(
    (select value #> '{data,notifications}' from mvp2c_results where key = 'guest_notifications'),
    '$[*] ? (@.notificationType == "route_order_updated")'
  ),
  'sharing_mvp2c_notifications: route updates appear in notification list'
);

insert into mvp2c_results(key, value)
select 'mark_first_read',
       public.mark_notification_read(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         ((select value #>> '{data,notifications,0,id}' from mvp2c_results where key = 'guest_notifications'))::uuid,
         true
       );

select ok(
  ((select value from mvp2c_results where key = 'mark_first_read') ->> 'ok')::boolean,
  'sharing_mvp2c_notifications: delivered notification can be marked read'
);

select ok(
  exists (
    select 1
    from public.notification_reads reads
    where reads.notification_id = ((select value #>> '{data,notifications,0,id}' from mvp2c_results where key = 'guest_notifications'))::uuid
      and reads.read_at is not null
      and reads.hidden_at is null
  ),
  'sharing_mvp2c_notifications: read state is member-local'
);

insert into mvp2c_results(key, value)
select 'hide_first',
       public.hide_notification(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         ((select value #>> '{data,notifications,0,id}' from mvp2c_results where key = 'guest_notifications'))::uuid,
         true
       );

select ok(
  ((select value from mvp2c_results where key = 'hide_first') ->> 'ok')::boolean,
  'sharing_mvp2c_notifications: delivered notification can be hidden'
);

insert into mvp2c_results(key, value)
select 'guest_notifications_after_hide',
       public.get_notification_list(
         (select value::uuid from mvp2c_values where key = 'room_id'),
         50,
         false
       );

select isnt(
  (select value #>> '{data,notifications,0,id}' from mvp2c_results where key = 'guest_notifications_after_hide'),
  (select value #>> '{data,notifications,0,id}' from mvp2c_results where key = 'guest_notifications'),
  'sharing_mvp2c_notifications: hidden notification is omitted from default list'
);

select is(
  (
    select last_processed_event_id::text
    from public.room_member_sync_state
    where room_member_id = ((select value from mvp2c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  null,
  'sharing_mvp2c_notifications: read/hide does not advance sync watermark'
);

select set_config('request.jwt.claim.sub', (select value from mvp2c_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2c_results(key, value)
select 'host_snapshot',
       public.get_room_snapshot((select value::uuid from mvp2c_values where key = 'room_id'));

select is(
  (select value #>> '{data,snapshot,routeOrderVersions,2026-08-15}' from mvp2c_results where key = 'host_snapshot'),
  '1',
  'sharing_mvp2c_snapshot: route order versions are included in snapshots'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_route_order_versions'
  ),
  'sharing_mvp2c_realtime: route order version table is in realtime publication when available'
);

select * from finish();

rollback;
