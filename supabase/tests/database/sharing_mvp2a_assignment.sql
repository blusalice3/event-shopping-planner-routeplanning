begin;

select plan(23);

select has_function(
  'public',
  'assign_item',
  array['uuid', 'text', 'uuid'],
  'mvp2a assign_item RPC exists'
);
select has_function(
  'public',
  'bulk_assign_items',
  array['uuid', 'text[]', 'uuid'],
  'mvp2a bulk_assign_items RPC exists'
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

create temp table mvp2a_values(
  key text primary key,
  value text not null
) on commit drop;

insert into mvp2a_values(key, value) values
  ('room_id', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('other_room_id', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('host_auth', '11111111-1111-4111-8111-111111111111'),
  ('guest_auth', '22222222-2222-4222-8222-222222222222'),
  ('other_auth', '33333333-3333-4333-8333-333333333333'),
  ('wrong_auth', '99999999-9999-4999-8999-999999999999'),
  ('host_token', repeat('h', 43)),
  ('guest_token', repeat('g', 43)),
  ('other_token', repeat('o', 43)),
  (
    'payload',
    '{"dayModes":{},"eventMetadata":{"eventName":"MVP2a Event"},"executeModeItems":{},"hallDefinitions":{},"hallRouteSettings":{},"itemSnapshots":{"item-1":{"eventDate":"2026-08-15","price":1200,"quantity":2,"remarks":"first","title":"Book","url":"https://example.test/first"},"item-2":{"eventDate":"2026-08-15","price":800,"quantity":3,"remarks":"second","title":"Zine","url":"https://example.test/second"},"item-3":{"eventDate":"2026-08-15","price":500,"quantity":1,"remarks":"third","title":"Goods","url":"https://example.test/third"}},"mapData":{},"mapRotationSettings":{},"mapViewportSettings":{},"routeOrderByDate":{},"routeSettings":{},"schemaVersion":1}'
  );

create temp table mvp2a_results(
  key text primary key,
  value jsonb not null
) on commit drop;

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into public.rooms(
  id,
  event_name,
  created_by,
  expires_at,
  sharing_status,
  host_member_id
) values (
  (select value::uuid from mvp2a_values where key = 'other_room_id'),
  'Other MVP2a Event',
  (select value::uuid from mvp2a_values where key = 'other_auth'),
  now() + interval '1 day',
  'active',
  '33333333-3333-4333-8333-333333333333'
);

insert into public.room_members(
  id,
  room_id,
  user_id,
  display_name,
  color,
  role,
  membership_status
) values (
  '33333333-3333-4333-8333-333333333333',
  (select value::uuid from mvp2a_values where key = 'other_room_id'),
  (select value::uuid from mvp2a_values where key = 'other_auth'),
  'Other',
  '#f97316',
  'host',
  'active'
);

insert into mvp2a_results(key, value)
select 'prepare_create',
       public.prepare_create_room_challenge(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         (select value from mvp2a_values where key = 'payload'),
         private.base64url(extensions.digest(convert_to((select value from mvp2a_values where key = 'payload'), 'UTF8'), 'sha256')),
         3,
         1,
         'encrypted'
       );

insert into mvp2a_results(key, value)
select 'create_room',
       public.create_room(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         'Host',
         (select value from mvp2a_values where key = 'host_token'),
         ((select value from mvp2a_results where key = 'prepare_create') #>> '{data,challengeId}')::uuid
       );

select ok(
  ((select value from mvp2a_results where key = 'create_room') ->> 'ok')::boolean,
  'sharing_mvp2a_assignment: create_room succeeds'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp2a_results(key, value)
select 'prepare_join',
       public.prepare_room_member_token(
         (select value #>> '{data,roomCode}' from mvp2a_results where key = 'create_room')
       );

insert into mvp2a_results(key, value)
select 'join_room',
       public.join_room_by_code(
         ((select value from mvp2a_results where key = 'prepare_join') #>> '{data,challengeId}')::uuid,
         (select value from mvp2a_values where key = 'guest_token'),
         'Guest'
       );

select ok(
  ((select value from mvp2a_results where key = 'join_room') ->> 'ok')::boolean,
  'sharing_mvp2a_assignment: guest joins before assignment'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2a_results(key, value)
select 'cross_room_assignee_denied',
       public.assign_item(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         'item-1',
         '33333333-3333-4333-8333-333333333333'::uuid
       );

select is(
  (select value #>> '{error,code}' from mvp2a_results where key = 'cross_room_assignee_denied'),
  'INVALID_REQUEST',
  'sharing_mvp2a_assign_item: cannot assign to a member from another room'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

select ok(
  exists (
    select 1
    from public.room_items ri
    where ri.room_id = (select value::uuid from mvp2a_values where key = 'room_id')
      and ri.assigned_to = ((select value from mvp2a_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid
  ),
  'sharing_mvp2a_assignment: create_room assigns initial items to host'
);

insert into mvp2a_results(key, value)
select 'guest_reassign_host_item',
       public.assign_item(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         'item-2',
         ((select value from mvp2a_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
       );

select ok(
  ((select value from mvp2a_results where key = 'guest_reassign_host_item') ->> 'ok')::boolean,
  'sharing_mvp2a_assignment: member can reassign an item assigned to someone else'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2a_results(key, value)
select 'host_assign_item_1',
       public.assign_item(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         'item-1',
         ((select value from mvp2a_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
       );

select ok(
  ((select value from mvp2a_results where key = 'host_assign_item_1') ->> 'ok')::boolean,
  'sharing_mvp2a_assign_item: host can assign a single item'
);

select is(
  (select value #>> '{data,itemsVersion}' from mvp2a_results where key = 'host_assign_item_1'),
  '2',
  'sharing_mvp2a_assign_item: single assignment allocates version 2 after member reassignment'
);

select ok(
  exists (
    select 1
    from public.room_item_change_log log
    where log.room_id = (select value::uuid from mvp2a_values where key = 'room_id')
      and log.local_item_id = 'item-1'
      and log.items_version = 2
      and log.changed_fields = array['assignedTo']
      and log.changed_values ->> 'assignedTo' =
        ((select value from mvp2a_results where key = 'join_room') #>> '{data,roomMemberId}')
  ),
  'sharing_mvp2a_assign_item: change log captures assignedTo'
);

select ok(
  exists (
    select 1
    from public.notifications n
    join public.notification_delivery_state ds on ds.notification_id = n.id
    where n.room_id = (select value::uuid from mvp2a_values where key = 'room_id')
      and n.notification_type = 'item_assigned'
      and n.payload ->> 'localItemId' = 'item-1'
      and ds.room_member_id = ((select value from mvp2a_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  'sharing_mvp2a_assign_item: assignment notification is delivered to active members'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp2a_results(key, value)
select 'guest_transfer_own',
       public.assign_item(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         'item-1',
         ((select value from mvp2a_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid
       );

select ok(
  ((select value from mvp2a_results where key = 'guest_transfer_own') ->> 'ok')::boolean,
  'sharing_mvp2a_assign_item: member can transfer own assigned item'
);

select is(
  (select value #>> '{data,itemsVersion}' from mvp2a_results where key = 'guest_transfer_own'),
  '3',
  'sharing_mvp2a_assign_item: member transfer allocates version 3'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2a_results(key, value)
select 'host_bulk_assign',
       public.bulk_assign_items(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         array['item-1', 'item-2', 'item-3'],
         ((select value from mvp2a_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
       );

select ok(
  ((select value from mvp2a_results where key = 'host_bulk_assign') ->> 'ok')::boolean,
  'sharing_mvp2a_bulk_assign_items: host can bulk assign'
);

select is(
  (select value #>> '{data,itemsVersion}' from mvp2a_results where key = 'host_bulk_assign'),
  '5',
  'sharing_mvp2a_bulk_assign_items: bulk assignment allocates contiguous max version'
);

select is(
  (
    select string_agg(log.items_version::text, ',' order by log.items_version)
    from public.room_item_change_log log
    where log.room_id = (select value::uuid from mvp2a_values where key = 'room_id')
      and log.items_version between 4 and 5
  ),
  '4,5',
  'sharing_mvp2a_bulk_assign_items: bulk change log versions are contiguous'
);

select ok(
  not exists (
    select 1
    from public.room_items ri
    where ri.room_id = (select value::uuid from mvp2a_values where key = 'room_id')
      and ri.assigned_to is distinct from
        ((select value from mvp2a_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  'sharing_mvp2a_bulk_assign_items: all target items are assigned to guest'
);

select is(
  (
    select count(*)::text
    from public.notifications n
    where n.room_id = (select value::uuid from mvp2a_values where key = 'room_id')
      and n.notification_type = 'item_assigned'
      and n.payload ->> 'assignmentMode' = 'bulk'
  ),
  '2',
  'sharing_mvp2a_bulk_assign_items: bulk assignment creates one sync notification per changed item'
);

insert into mvp2a_results(key, value)
select 'host_bulk_duplicate_denied',
       public.bulk_assign_items(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         array['item-1', 'item-1'],
         ((select value from mvp2a_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid
       );

select is(
  (select value #>> '{error,code}' from mvp2a_results where key = 'host_bulk_duplicate_denied'),
  'INVALID_REQUEST',
  'sharing_mvp2a_bulk_assign_items: duplicate item ids are rejected'
);

insert into mvp2a_results(key, value)
select 'host_bulk_missing_denied',
       public.bulk_assign_items(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         array['item-1', 'missing-item'],
         ((select value from mvp2a_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid
       );

select is(
  (select value #>> '{error,code}' from mvp2a_results where key = 'host_bulk_missing_denied'),
  'INVALID_REQUEST',
  'sharing_mvp2a_bulk_assign_items: missing item ids are rejected atomically'
);

select is(
  (
    select items_version::text
    from public.rooms
    where id = (select value::uuid from mvp2a_values where key = 'room_id')
  ),
  '5',
  'sharing_mvp2a_bulk_assign_items: rejected bulk requests do not advance room version'
);

select set_config('request.jwt.claim.sub', (select value from mvp2a_values where key = 'wrong_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"99999999-9999-4999-8999-999999999999"}',
  true
);

insert into mvp2a_results(key, value)
select 'wrong_user_denied',
       public.assign_item(
         (select value::uuid from mvp2a_values where key = 'room_id'),
         'item-1',
         ((select value from mvp2a_results where key = 'create_room') #>> '{data,hostMemberId}')::uuid
       );

select is(
  (select value #>> '{error,code}' from mvp2a_results where key = 'wrong_user_denied'),
  'ROOM_UNAVAILABLE',
  'sharing_mvp2a_assign_item: non-member cannot assign'
);

select ok(
  exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'room_members'
      and grantee = 'authenticated'
      and privilege_type = 'SELECT'
  ),
  'sharing_mvp2a_members: authenticated role can select room member profiles through RLS'
);

select * from finish();

rollback;
