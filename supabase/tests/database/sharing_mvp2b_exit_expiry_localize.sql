begin;

select plan(36);

select has_column('public', 'room_members', 'paused_at', 'mvp2b adds paused_at to room_members');
select has_table('private', 'expired_room_cleanup_runs', 'mvp2b creates cleanup audit metadata table');
select has_function(
  'public',
  'pause_room_session',
  array['uuid'],
  'mvp2b pause_room_session RPC exists'
);
select has_function(
  'public',
  'leave_room',
  array['uuid', 'text'],
  'mvp2b leave_room RPC exists'
);
select has_function(
  'public',
  'get_room_members_for_display',
  array['uuid'],
  'mvp2b display member RPC exists'
);
select has_function(
  'public',
  'cleanup_expired_room_data',
  array['uuid', 'integer', 'integer'],
  'mvp2b cleanup_expired_room_data RPC exists'
);
select has_function(
  'public',
  'expire_room_for_cleanup',
  array['uuid'],
  'mvp2b expire_room_for_cleanup RPC exists'
);
select ok(
  exists (select 1 from pg_extension where extname = 'pg_cron'),
  'mvp2b cleanup cron: pg_cron extension is installed'
);
select ok(
  exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and p.proname = 'run_expired_room_cleanup_job'
  ),
  'mvp2b cleanup cron: private cron wrapper exists'
);
select ok(
  exists (
    select 1
    from cron.job
    where jobname = 'sharing-expired-room-cleanup-daily'
  ),
  'mvp2b cleanup cron: daily cleanup job is registered'
);
select is(
  (select schedule from cron.job where jobname = 'sharing-expired-room-cleanup-daily'),
  '0 18 * * *',
  'mvp2b cleanup cron: daily cleanup runs at 18:00 UTC / 03:00 JST'
);
select is(
  (select command from cron.job where jobname = 'sharing-expired-room-cleanup-daily'),
  'select private.run_expired_room_cleanup_job();',
  'mvp2b cleanup cron: job calls the private cleanup wrapper'
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

create temp table mvp2b_values(
  key text primary key,
  value text not null
) on commit drop;

insert into mvp2b_values(key, value) values
  ('room_id', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('expired_room_id', 'ffffffff-ffff-4fff-8fff-ffffffffffff'),
  ('host_auth', '11111111-1111-4111-8111-111111111111'),
  ('guest_auth', '22222222-2222-4222-8222-222222222222'),
  ('host_token', repeat('h', 43)),
  ('guest_token', repeat('g', 43)),
  (
    'payload',
    '{"dayModes":{},"eventMetadata":{"eventName":"MVP2b Event"},"executeModeItems":{},"hallDefinitions":{},"hallRouteSettings":{},"itemSnapshots":{"item-1":{"eventDate":"2026-08-15","price":1200,"quantity":2,"remarks":"leave","title":"Book","url":"https://example.test/leave"}},"mapData":{},"mapRotationSettings":{},"mapViewportSettings":{},"routeOrderByDate":{},"routeSettings":{},"schemaVersion":1}'
  );

create temp table mvp2b_results(
  key text primary key,
  value jsonb not null
) on commit drop;

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2b_results(key, value)
select 'prepare_create',
       public.prepare_create_room_challenge(
         (select value::uuid from mvp2b_values where key = 'room_id'),
         (select value from mvp2b_values where key = 'payload'),
         private.base64url(extensions.digest(convert_to((select value from mvp2b_values where key = 'payload'), 'UTF8'), 'sha256')),
         1,
         1,
         'encrypted'
       );

insert into mvp2b_results(key, value)
select 'create_room',
       public.create_room(
         (select value::uuid from mvp2b_values where key = 'room_id'),
         'Host',
         (select value from mvp2b_values where key = 'host_token'),
         ((select value from mvp2b_results where key = 'prepare_create') #>> '{data,challengeId}')::uuid
       );

select ok(
  ((select value from mvp2b_results where key = 'create_room') ->> 'ok')::boolean,
  'sharing_mvp2b_exit: create_room succeeds'
);

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp2b_results(key, value)
select 'prepare_join',
       public.prepare_room_member_token(
         (select value #>> '{data,roomCode}' from mvp2b_results where key = 'create_room')
       );

insert into mvp2b_results(key, value)
select 'join_room',
       public.join_room_by_code(
         ((select value from mvp2b_results where key = 'prepare_join') #>> '{data,challengeId}')::uuid,
         (select value from mvp2b_values where key = 'guest_token'),
         'Guest'
       );

select ok(
  ((select value from mvp2b_results where key = 'join_room') ->> 'ok')::boolean,
  'sharing_mvp2b_exit: guest joins'
);

insert into mvp2b_results(key, value)
select 'pause_guest',
       public.pause_room_session((select value::uuid from mvp2b_values where key = 'room_id'));

select ok(
  ((select value from mvp2b_results where key = 'pause_guest') ->> 'ok')::boolean,
  'sharing_mvp2b_pause: active member can pause'
);
select ok(
  exists (
    select 1
    from public.room_members rm
    where rm.id = ((select value from mvp2b_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and rm.membership_status = 'active'
      and rm.paused_at is not null
      and rm.last_seen_at is null
  ),
  'sharing_mvp2b_pause: pause keeps active membership and drops heartbeat'
);

insert into mvp2b_results(key, value)
select 'heartbeat_guest',
       public.heartbeat_room_session((select value::uuid from mvp2b_values where key = 'room_id'));

select ok(
  ((select value from mvp2b_results where key = 'heartbeat_guest') ->> 'ok')::boolean,
  'sharing_mvp2b_pause: heartbeat resumes paused session'
);
select ok(
  exists (
    select 1
    from public.room_members rm
    where rm.id = ((select value from mvp2b_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and rm.membership_status = 'active'
      and rm.paused_at is null
      and rm.last_seen_at is not null
  ),
  'sharing_mvp2b_pause: resume clears paused_at'
);

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2b_results(key, value)
select 'host_leave_denied',
       public.leave_room((select value::uuid from mvp2b_values where key = 'room_id'), 'final');

select is(
  (select value #>> '{error,code}' from mvp2b_results where key = 'host_leave_denied'),
  'PERMISSION_DENIED',
  'sharing_mvp2b_leave: host exit is rejected'
);

insert into mvp2b_results(key, value)
select 'assign_to_guest',
       public.assign_item(
         (select value::uuid from mvp2b_values where key = 'room_id'),
         'item-1',
         ((select value from mvp2b_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
       );

select ok(
  ((select value from mvp2b_results where key = 'assign_to_guest') ->> 'ok')::boolean,
  'sharing_mvp2b_leave: host assigns an item before guest exits'
);

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp2b_results(key, value)
select 'leave_guest',
       public.leave_room((select value::uuid from mvp2b_values where key = 'room_id'), 'final');

select ok(
  ((select value from mvp2b_results where key = 'leave_guest') ->> 'ok')::boolean,
  'sharing_mvp2b_leave: member can leave final'
);
select ok(
  exists (
    select 1
    from public.room_members rm
    where rm.id = ((select value from mvp2b_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and rm.membership_status = 'left'
      and rm.left_at is not null
  ),
  'sharing_mvp2b_leave: final exit marks member left'
);
select ok(
  exists (
    select 1
    from public.room_items ri
    where ri.room_id = (select value::uuid from mvp2b_values where key = 'room_id')
      and ri.local_item_id = 'item-1'
      and ri.assigned_to = ((select value from mvp2b_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
  ),
  'sharing_mvp2b_leave: final exit preserves assignment history'
);

insert into mvp2b_results(key, value)
select 'left_member_versions',
       public.get_room_versions((select value::uuid from mvp2b_values where key = 'room_id'));

select is(
  (select value #>> '{error,code}' from mvp2b_results where key = 'left_member_versions'),
  'ROOM_UNAVAILABLE',
  'sharing_mvp2b_leave: left member cannot access normal sync RPCs'
);

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2b_results(key, value)
select 'display_members_after_leave',
       public.get_room_members_for_display((select value::uuid from mvp2b_values where key = 'room_id'));

select ok(
  ((select value from mvp2b_results where key = 'display_members_after_leave') ->> 'ok')::boolean,
  'sharing_mvp2b_display: active member can fetch display members'
);
select is(
  (
    select member ->> 'membershipStatus'
    from jsonb_array_elements((select value #> '{data,members}' from mvp2b_results where key = 'display_members_after_leave')) member
    where member ->> 'roomMemberId' = ((select value from mvp2b_results where key = 'join_room') #>> '{data,roomMemberId}')
  ),
  'left',
  'sharing_mvp2b_display: display profiles include left members'
);

insert into public.rooms(
  id,
  event_name,
  created_by,
  expires_at,
  sharing_status
) values (
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  'Expired MVP2b Event',
  (select value::uuid from mvp2b_values where key = 'host_auth'),
  now() - interval '100 hours',
  'expired'
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
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  (select value::uuid from mvp2b_values where key = 'host_auth'),
  'Expired Host',
  '#0ea5e9',
  'host',
  'active'
);

update public.rooms
set host_member_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
where id = (select value::uuid from mvp2b_values where key = 'expired_room_id');

insert into public.room_event_data(room_id, schema_version, event_data, event_data_size_bytes)
values (
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  1,
  '{"eventMetadata":{"eventName":"Expired"},"itemSnapshots":{"expired-item":{"remarks":"sensitive memo","url":"https://example.test/secret"}}}'::jsonb,
  128
);

insert into public.room_items(
  id,
  room_id,
  local_item_id,
  name,
  remarks,
  url,
  assigned_to
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  'expired-item',
  'Expired Item',
  'sensitive memo',
  'https://example.test/secret',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);

insert into public.notifications(
  id,
  room_id,
  idempotency_key,
  notification_type,
  payload
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  'expired:notification',
  'item_updated',
  '{"remarks":"sensitive memo"}'
);

insert into public.notification_delivery_state(notification_id, room_id, room_member_id)
values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);

insert into public.room_item_change_log(
  room_id,
  room_item_id,
  local_item_id,
  items_version,
  changed_fields,
  changed_values
) values (
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'expired-item',
  1,
  array['remarks'],
  '{"remarks":"sensitive memo"}'::jsonb
);

insert into public.room_member_sync_state(room_member_id, room_id)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select value::uuid from mvp2b_values where key = 'expired_room_id')
);

insert into private.room_snapshot_receipts(
  id,
  room_id,
  room_member_id,
  items_version,
  route_order_version,
  route_order_versions,
  snapshot_hash,
  expires_at
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  1,
  null,
  '{}'::jsonb,
  'snapshot-hash',
  now() - interval '1 hour'
);

insert into private.room_member_credentials(
  room_member_id,
  room_id,
  secret_version,
  member_key_lookup_digest,
  member_key_digest
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  1,
  '\x01'::bytea,
  '\x02'::bytea
);

insert into private.room_create_payload_challenges(
  id,
  auth_user_id,
  client_room_id,
  encrypted_payload,
  encryption_key_version,
  plaintext_fingerprint,
  plaintext_size_bytes,
  item_count,
  canonical_schema_version,
  payload_protection_mode,
  expires_at
) values (
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  (select value::uuid from mvp2b_values where key = 'host_auth'),
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  '\x03'::bytea,
  1,
  'fingerprint',
  128,
  1,
  1,
  'encrypted',
  now() + interval '5 minutes'
);

insert into private.room_join_challenges(
  challenge_id,
  purpose,
  room_id,
  auth_user_id,
  create_payload_challenge_id,
  expires_at
) values (
  '99999999-9999-4999-8999-999999999999',
  'create_room',
  (select value::uuid from mvp2b_values where key = 'expired_room_id'),
  (select value::uuid from mvp2b_values where key = 'host_auth'),
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  now() + interval '5 minutes'
);

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2b_results(key, value)
select 'expired_members_display',
       public.get_room_members_for_display((select value::uuid from mvp2b_values where key = 'expired_room_id'));

select ok(
  ((select value from mvp2b_results where key = 'expired_members_display') ->> 'ok')::boolean,
  'sharing_mvp2b_localize: expired room member display snapshot RPC succeeds before cleanup'
);
select is(
  ((select value from mvp2b_results where key = 'expired_members_display') #>> '{data,members,0,displayName}'),
  'Expired Host',
  'sharing_mvp2b_localize: expired room members remain readable for local display snapshot before cleanup'
);

insert into mvp2b_results(key, value)
select 'cleanup_denied',
       public.cleanup_expired_room_data((select value::uuid from mvp2b_values where key = 'expired_room_id'), 72, 10);

select is(
  (select value #>> '{error,code}' from mvp2b_results where key = 'cleanup_denied'),
  'PERMISSION_DENIED',
  'sharing_mvp2b_cleanup: normal authenticated caller cannot run cleanup'
);

select set_config('request.jwt.claim.sub', (select value from mvp2b_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp2b_results(key, value)
select 'cleanup_expired_room',
       public.cleanup_expired_room_data((select value::uuid from mvp2b_values where key = 'expired_room_id'), 72, 10);

select ok(
  ((select value from mvp2b_results where key = 'cleanup_expired_room') ->> 'ok')::boolean,
  'sharing_mvp2b_cleanup: service role cleanup succeeds'
);
select is(
  ((select value from mvp2b_results where key = 'cleanup_expired_room') #>> '{data,roomCount}')::integer,
  1,
  'sharing_mvp2b_cleanup: cleanup processes the expired room'
);
select ok(
  not exists (
    select 1
    from public.room_items
    where room_id = (select value::uuid from mvp2b_values where key = 'expired_room_id')
  ),
  'sharing_mvp2b_cleanup: room_items are deleted'
);
select ok(
  not exists (
    select 1
    from public.room_event_data
    where room_id = (select value::uuid from mvp2b_values where key = 'expired_room_id')
  ),
  'sharing_mvp2b_cleanup: room_event_data is deleted'
);
select ok(
  not exists (
    select 1
    from private.room_create_payload_challenges
    where client_room_id = (select value::uuid from mvp2b_values where key = 'expired_room_id')
  ),
  'sharing_mvp2b_cleanup: canonical create payload challenge is deleted'
);
select ok(
  not exists (
    select 1
    from public.room_members
    where room_id = (select value::uuid from mvp2b_values where key = 'expired_room_id')
  ),
  'sharing_mvp2b_cleanup: room member profiles are removed with the room'
);
select ok(
  exists (
    select 1
    from private.expired_room_cleanup_runs
    where room_id = (select value::uuid from mvp2b_values where key = 'expired_room_id')
      and status = 'completed'
      and counts ? 'roomItems'
      and not counts::text like '%sensitive memo%'
      and not counts::text like '%https://example.test/secret%'
  ),
  'sharing_mvp2b_cleanup: audit metadata is minimal and excludes body content'
);

select * from finish();
rollback;
