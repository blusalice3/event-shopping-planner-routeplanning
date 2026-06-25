begin;

select plan(30);

select has_table('public', 'room_member_sync_state', 'mvp0c creates member sync state table');
select has_table('private', 'room_snapshot_receipts', 'mvp0c creates private snapshot receipt table');
select has_function(
  'public',
  'create_room',
  array['uuid', 'text', 'text', 'uuid'],
  'mvp0c create_room accepts room, host display name, restore token, and challenge'
);
select has_function(
  'public',
  'heartbeat_room_session',
  array['uuid'],
  'mvp0c heartbeat RPC exists'
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

create temp table mvp0c_values(
  key text primary key,
  value text not null
) on commit drop;

insert into mvp0c_values(key, value) values
  ('room_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('host_auth', '11111111-1111-4111-8111-111111111111'),
  ('guest_auth', '22222222-2222-4222-8222-222222222222'),
  ('restored_auth', '33333333-3333-4333-8333-333333333333'),
  ('wrong_auth', '44444444-4444-4444-8444-444444444444'),
  ('host_token', repeat('a', 43)),
  ('guest_token', repeat('b', 43)),
  ('wrong_token', repeat('c', 43)),
  (
    'payload',
    '{"dayModes":{},"eventMetadata":{"eventName":"MVP0c Event"},"executeModeItems":{},"hallDefinitions":{},"hallRouteSettings":{},"itemSnapshots":{"item-1":{"eventDate":"2026-08-15","price":1200,"quantity":2,"remarks":"hello","title":"Book"}},"mapData":{},"mapRotationSettings":{},"mapViewportSettings":{},"routeOrderByDate":{},"routeSettings":{},"schemaVersion":1}'
  );

create temp table mvp0c_results(
  key text primary key,
  value jsonb not null
) on commit drop;

select set_config('request.jwt.claim.sub', (select value from mvp0c_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp0c_results(key, value)
select 'prepare_create',
       public.prepare_create_room_challenge(
         (select value::uuid from mvp0c_values where key = 'room_id'),
         (select value from mvp0c_values where key = 'payload'),
         private.base64url(extensions.digest(convert_to((select value from mvp0c_values where key = 'payload'), 'UTF8'), 'sha256')),
         1,
         1,
         'encrypted'
       );

select ok(
  ((select value from mvp0c_results where key = 'prepare_create') ->> 'ok')::boolean,
  'sharing_mvp0c_create_join_snapshot_ack: create challenge succeeds'
);

insert into mvp0c_results(key, value)
select 'create_room',
       public.create_room(
         (select value::uuid from mvp0c_values where key = 'room_id'),
         'Host',
         (select value from mvp0c_values where key = 'host_token'),
         ((select value from mvp0c_results where key = 'prepare_create') #>> '{data,challengeId}')::uuid
       );

select ok(
  ((select value from mvp0c_results where key = 'create_room') ->> 'ok')::boolean,
  'sharing_mvp0c_create_join_snapshot_ack: create_room succeeds'
);

select ok(
  exists (
    select 1
    from public.rooms
    where id = (select value::uuid from mvp0c_values where key = 'room_id')
      and event_name = 'MVP0c Event'
      and host_member_id is not null
      and (route_order_version is null or route_order_version = 0)
  ),
  'sharing_mvp0c_create_join_snapshot_ack: room metadata is stored with route sync disabled or mvp2c-initialized'
);

select ok(
  exists (
    select 1
    from public.room_members
    where room_id = (select value::uuid from mvp0c_values where key = 'room_id')
      and user_id = (select value::uuid from mvp0c_values where key = 'host_auth')
      and role = 'host'
  ),
  'sharing_mvp0c_create_join_snapshot_ack: host member is created'
);

select ok(
  exists (
    select 1
    from private.room_member_credentials c
    join public.room_members rm on rm.id = c.room_member_id
    where rm.room_id = (select value::uuid from mvp0c_values where key = 'room_id')
      and rm.role = 'host'
  ),
  'sharing_mvp0c_create_join_snapshot_ack: host restore credential is digest-stored'
);

select ok(
  exists (
    select 1
    from public.room_event_data
    where room_id = (select value::uuid from mvp0c_values where key = 'room_id')
      and event_data #>> '{eventMetadata,eventName}' = 'MVP0c Event'
  ),
  'sharing_mvp0c_create_join_snapshot_ack: canonical event payload is stored as room_event_data'
);

select ok(
  exists (
    select 1
    from public.room_items ri
    join public.rooms r on r.id = ri.room_id
    where ri.room_id = (select value::uuid from mvp0c_values where key = 'room_id')
      and ri.local_item_id = 'item-1'
      and ri.assigned_to = r.host_member_id
      and ri.item_version = 0
  ),
  'sharing_mvp0c_create_join_snapshot_ack: initial item is assigned to host at version zero'
);

select is(
  public.create_room(
    (select value::uuid from mvp0c_values where key = 'room_id'),
    'Host',
    (select value from mvp0c_values where key = 'host_token'),
    ((select value from mvp0c_results where key = 'prepare_create') #>> '{data,challengeId}')::uuid
  ) #>> '{error,code}',
  'CHALLENGE_INVALID',
  'sharing_mvp0c_create_join_snapshot_ack: consumed create challenge is not replayable'
);

insert into mvp0c_results(key, value)
select 'host_snapshot',
       public.get_room_snapshot((select value::uuid from mvp0c_values where key = 'room_id'));

select ok(
  ((select value from mvp0c_results where key = 'host_snapshot') ->> 'ok')::boolean,
  'sharing_mvp0c_create_join_snapshot_ack: host snapshot succeeds'
);

select ok(
  exists (
    select 1
    from private.room_snapshot_receipts
    where id = ((select value from mvp0c_results where key = 'host_snapshot') #>> '{data,snapshot,receiptId}')::uuid
      and acked_at is null
  ),
  'sharing_mvp0c_snapshot_receipt_ack: snapshot creates an unacked private receipt'
);

insert into mvp0c_results(key, value)
select 'host_ack',
       public.ack_room_snapshot_watermark(
         (select value::uuid from mvp0c_values where key = 'room_id'),
         ((select value from mvp0c_results where key = 'host_snapshot') #>> '{data,snapshot,receiptId}')::uuid
       );

select ok(
  ((select value from mvp0c_results where key = 'host_ack') ->> 'ok')::boolean,
  'sharing_mvp0c_snapshot_receipt_ack: ack succeeds after local commit boundary'
);

select ok(
  exists (
    select 1
    from public.room_member_sync_state
    where last_snapshot_receipt_id = ((select value from mvp0c_results where key = 'host_snapshot') #>> '{data,snapshot,receiptId}')::uuid
      and items_version = 0
      and route_order_versions = '{}'::jsonb
  ),
  'sharing_mvp0c_snapshot_receipt_ack: ack stores sync state without route versions'
);

select ok(
  (public.ack_room_snapshot_watermark(
    (select value::uuid from mvp0c_values where key = 'room_id'),
    ((select value from mvp0c_results where key = 'host_snapshot') #>> '{data,snapshot,receiptId}')::uuid
  ) ->> 'ok')::boolean,
  'sharing_mvp0c_snapshot_receipt_ack: ack is idempotent for the same receipt'
);

select ok(
  (public.heartbeat_room_session(
    (select value::uuid from mvp0c_values where key = 'room_id')
  ) ->> 'ok')::boolean,
  'sharing_mvp0c_expiry_minimal_stop: heartbeat succeeds for active member'
);

select set_config('request.jwt.claim.sub', (select value from mvp0c_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp0c_results(key, value)
select 'prepare_join',
       public.prepare_room_member_token(
         (select value #>> '{data,roomCode}' from mvp0c_results where key = 'create_room')
       );

select ok(
  ((select value from mvp0c_results where key = 'prepare_join') ->> 'ok')::boolean,
  'sharing_mvp0c_create_join_snapshot_ack: prepare join succeeds for returned room code'
);

insert into mvp0c_results(key, value)
select 'join_room',
       public.join_room_by_code(
         ((select value from mvp0c_results where key = 'prepare_join') #>> '{data,challengeId}')::uuid,
         (select value from mvp0c_values where key = 'guest_token'),
         'Guest'
       );

select ok(
  ((select value from mvp0c_results where key = 'join_room') ->> 'ok')::boolean,
  'sharing_mvp0c_create_join_snapshot_ack: join_room_by_code creates a member'
);

select ok(
  exists (
    select 1
    from public.room_members
    where id = ((select value from mvp0c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and user_id = (select value::uuid from mvp0c_values where key = 'guest_auth')
      and role = 'member'
  ),
  'sharing_mvp0c_create_join_snapshot_ack: guest member row is active'
);

insert into mvp0c_results(key, value)
select 'guest_snapshot',
       public.get_room_snapshot((select value::uuid from mvp0c_values where key = 'room_id'));

select ok(
  ((select value from mvp0c_results where key = 'guest_snapshot') ->> 'ok')::boolean,
  'sharing_mvp0c_create_join_snapshot_ack: joined guest can get snapshot'
);

select set_config('request.jwt.claim.sub', (select value from mvp0c_values where key = 'restored_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"33333333-3333-4333-8333-333333333333"}',
  true
);

insert into mvp0c_results(key, value)
select 'prepare_restore',
       public.prepare_restore_member_token((select value::uuid from mvp0c_values where key = 'room_id'));

select ok(
  ((select value from mvp0c_results where key = 'prepare_restore') ->> 'ok')::boolean,
  'sharing_mvp0c_restore_member_by_key: prepare restore succeeds'
);

insert into mvp0c_results(key, value)
select 'restore_guest',
       public.restore_member_by_key(
         ((select value from mvp0c_results where key = 'prepare_restore') #>> '{data,challengeId}')::uuid,
         (select value from mvp0c_values where key = 'guest_token')
       );

select ok(
  ((select value from mvp0c_results where key = 'restore_guest') ->> 'ok')::boolean,
  'sharing_mvp0c_restore_member_by_key: restore succeeds with the saved member token'
);

select ok(
  exists (
    select 1
    from public.room_members
    where id = ((select value from mvp0c_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and user_id = (select value::uuid from mvp0c_values where key = 'restored_auth')
  ),
  'sharing_mvp0c_restore_member_by_key: restore rebinds the same member to the new anonymous auth'
);

select set_config('request.jwt.claim.sub', (select value from mvp0c_values where key = 'wrong_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"44444444-4444-4444-8444-444444444444"}',
  true
);

insert into mvp0c_results(key, value)
select 'prepare_wrong_restore',
       public.prepare_restore_member_token((select value::uuid from mvp0c_values where key = 'room_id'));

select is(
  public.restore_member_by_key(
    ((select value from mvp0c_results where key = 'prepare_wrong_restore') #>> '{data,challengeId}')::uuid,
    (select value from mvp0c_values where key = 'wrong_token')
  ) #>> '{error,code}',
  'RESTORE_REQUIRED',
  'sharing_mvp0c_restore_member_by_key: wrong restore token is rejected'
);

update public.rooms
set expires_at = now() - interval '1 second'
where id = (select value::uuid from mvp0c_values where key = 'room_id');

select is(
  public.heartbeat_room_session((select value::uuid from mvp0c_values where key = 'room_id')) #>> '{error,code}',
  'ROOM_EXPIRED',
  'sharing_mvp0c_expiry_minimal_stop: heartbeat stops expired rooms'
);

select is(
  public.get_room_snapshot((select value::uuid from mvp0c_values where key = 'room_id')) #>> '{error,code}',
  'ROOM_EXPIRED',
  'sharing_mvp0c_expiry_minimal_stop: snapshot stops expired rooms'
);

select has_function(
  'public',
  'update_room_item_with_purchase',
  array['uuid', 'text', 'jsonb', 'text', 'integer', 'jsonb'],
  'sharing_mvp1_gate_progression: v2 purchase mutation is available'
);

select ok(
  (select value #>> '{data,room,routeOrderVersion}' from mvp0c_results where key = 'host_snapshot') is null
  or (select value #>> '{data,room,routeOrderVersion}' from mvp0c_results where key = 'host_snapshot') = '0',
  'sharing_mvp0c_create_join_snapshot_ack: route order version is null before MVP-2c or zero after MVP-2c initialization'
);

select * from finish();

rollback;
