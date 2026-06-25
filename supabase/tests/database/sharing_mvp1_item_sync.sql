begin;

select plan(49);

select has_table('public', 'room_item_change_log', 'mvp1 creates item change log');
select has_table('public', 'notification_delivery_state', 'mvp1 creates notification delivery state');
select has_function(
  'public',
  'update_room_item_with_purchase',
  array['uuid', 'text', 'jsonb', 'text', 'integer', 'jsonb'],
  'mvp1 v2 item field and purchase RPC exists'
);
select has_function(
  'public',
  'get_room_item_changes_since',
  array['uuid', 'bigint'],
  'mvp1 item catch-up RPC exists'
);
select has_function(
  'public',
  'bulk_update_room_items_with_purchase',
  array['uuid', 'jsonb'],
  'mvp1 v2 bulk item field and purchase RPC exists'
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

create temp table mvp1_values(
  key text primary key,
  value text not null
) on commit drop;

insert into mvp1_values(key, value) values
  ('room_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('host_auth', '11111111-1111-4111-8111-111111111111'),
  ('guest_auth', '22222222-2222-4222-8222-222222222222'),
  ('late_auth', '33333333-3333-4333-8333-333333333333'),
  ('wrong_auth', '99999999-9999-4999-8999-999999999999'),
  ('host_token', repeat('h', 43)),
  ('guest_token', repeat('g', 43)),
  (
    'payload',
    '{"dayModes":{},"eventMetadata":{"eventName":"MVP1 Event"},"executeModeItems":{},"hallDefinitions":{},"hallRouteSettings":{},"itemSnapshots":{"item-1":{"eventDate":"2026-08-15","price":1200,"quantity":2,"remarks":"hello","title":"Book","url":"https://example.test/old"},"item-2":{"eventDate":"2026-08-15","price":800,"quantity":3,"remarks":"second","title":"Zine","url":"https://example.test/second"}},"mapData":{},"mapRotationSettings":{},"mapViewportSettings":{},"routeOrderByDate":{},"routeSettings":{},"schemaVersion":1}'
  );

create temp table mvp1_results(
  key text primary key,
  value jsonb not null
) on commit drop;

create function pg_temp.mvp1_expected_clocks(
  p_room_id uuid,
  p_local_item_id text,
  p_fields text[]
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(field_name, ri.field_clocks -> field_name), '{}'::jsonb)
  from public.room_items ri
  cross join unnest(coalesce(p_fields, array[]::text[])) as field_name
  where ri.room_id = p_room_id
    and ri.local_item_id = p_local_item_id;
$$;

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp1_results(key, value)
select 'prepare_create',
       public.prepare_create_room_challenge(
         (select value::uuid from mvp1_values where key = 'room_id'),
         (select value from mvp1_values where key = 'payload'),
         private.base64url(extensions.digest(convert_to((select value from mvp1_values where key = 'payload'), 'UTF8'), 'sha256')),
          2,
         1,
         'encrypted'
       );

insert into mvp1_results(key, value)
select 'create_room',
       public.create_room(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'Host',
         (select value from mvp1_values where key = 'host_token'),
         ((select value from mvp1_results where key = 'prepare_create') #>> '{data,challengeId}')::uuid
       );

select ok(
  ((select value from mvp1_results where key = 'create_room') ->> 'ok')::boolean,
  'sharing_mvp1_item_sync: create_room succeeds'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp1_results(key, value)
select 'prepare_join',
       public.prepare_room_member_token(
         (select value #>> '{data,roomCode}' from mvp1_results where key = 'create_room')
       );

insert into mvp1_results(key, value)
select 'join_room',
       public.join_room_by_code(
         ((select value from mvp1_results where key = 'prepare_join') #>> '{data,challengeId}')::uuid,
         (select value from mvp1_values where key = 'guest_token'),
         'Guest'
       );

select ok(
  ((select value from mvp1_results where key = 'join_room') ->> 'ok')::boolean,
  'sharing_mvp1_item_sync: guest joins before item sync'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp1_results(key, value)
select 'field_update',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-1',
         '{"price":1500,"remarks":"updated memo"}'::jsonb,
         null,
         null,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-1',
           array['price', 'remarks']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'field_update') ->> 'ok')::boolean,
  'sharing_mvp1_update_room_item_with_purchase: price and remarks update succeeds'
);

select is(
  (select value #>> '{data,itemsVersion}' from mvp1_results where key = 'field_update'),
  '1',
  'sharing_mvp1_update_room_item_with_purchase: first mutation allocates items_version 1'
);

select ok(
  exists (
    select 1
    from public.room_item_change_log
    where room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and items_version = 1
      and changed_fields = array['price', 'remarks']
      and changed_values ->> 'remarks' = 'updated memo'
  ),
  'sharing_mvp1_update_room_item_with_purchase: change log captures exact changed fields'
);

select ok(
  exists (
    select 1
    from public.notifications n
    join public.notification_delivery_state ds on ds.notification_id = n.id
    where n.room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and n.notification_type = 'item_fields_updated'
    group by n.id
    having count(*) = 2
  ),
  'sharing_mvp1_notification_delivery: room notification audience is fixed for active members'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp1_results(key, value)
select 'guest_changes_0',
       public.get_room_item_changes_since(
         (select value::uuid from mvp1_values where key = 'room_id'),
         0
       );

select is(
  jsonb_array_length((select value #> '{data,changes}' from mvp1_results where key = 'guest_changes_0'))::text,
  '1',
  'sharing_mvp1_item_catchup: guest receives one change since version zero'
);

select is(
  (select value #>> '{data,changes,0,updatedValues,price}' from mvp1_results where key = 'guest_changes_0'),
  '1500',
  'sharing_mvp1_item_catchup: changed values contain the new price'
);

insert into mvp1_results(key, value)
select 'guest_notifications',
       public.get_notifications_after_watermark(
         (select value::uuid from mvp1_values where key = 'room_id'),
         null,
         null,
         100
       );

select is(
  jsonb_array_length((select value #> '{data,notifications}' from mvp1_results where key = 'guest_notifications'))::text,
  '1',
  'sharing_mvp1_notification_catchup: guest receives delivered notification'
);

select is(
  jsonb_array_length((select value #> '{data,events}' from mvp1_results where key = 'guest_notifications'))::text,
  '1',
  'sharing_mvp1_notification_catchup: standard events alias is returned'
);

select ok(
  (select value #>> '{data,nextWatermarkId}' from mvp1_results where key = 'guest_notifications') is not null
  and (select value #>> '{data,serverHighWatermarkId}' from mvp1_results where key = 'guest_notifications') is not null
  and (select value #>> '{data,hasMore}' from mvp1_results where key = 'guest_notifications') = 'false',
  'sharing_mvp1_notification_catchup: response includes next and server high watermarks'
);

insert into mvp1_results(key, value)
select 'guest_ack_progress',
       public.ack_room_sync_progress(
         (select value::uuid from mvp1_values where key = 'room_id'),
         1,
         ((select value #>> '{data,notifications,0,createdAt}' from mvp1_results where key = 'guest_notifications'))::timestamptz,
         ((select value #>> '{data,notifications,0,id}' from mvp1_results where key = 'guest_notifications'))::uuid,
         jsonb_build_array(jsonb_build_object(
           'event_id',
           (select value #>> '{data,notifications,0,eventId}' from mvp1_results where key = 'guest_notifications'),
           'processed_at',
           now()
         ))
       );

select ok(
  ((select value from mvp1_results where key = 'guest_ack_progress') ->> 'ok')::boolean,
  'sharing_mvp1_sync_progress: guest can ack item and notification progress'
);

select ok(
  exists (
    select 1
    from public.room_member_sync_state
    where room_member_id = ((select value from mvp1_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and items_version = 1
      and last_processed_event_id = ((select value #>> '{data,notifications,0,id}' from mvp1_results where key = 'guest_notifications'))::uuid
  ),
  'sharing_mvp1_sync_progress: ack stores monotonic sync state'
);

select ok(
  exists (
    select 1
    from public.room_member_sync_state sync,
         jsonb_array_elements(sync.processed_event_ids) processed(value)
    where sync.room_member_id = ((select value from mvp1_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and processed.value ? 'event_id'
      and processed.value ? 'processed_at'
  ),
  'sharing_mvp1_sync_progress: processed_event_ids are stored as event objects'
);

select is(
  public.ack_room_sync_progress(
    (select value::uuid from mvp1_values where key = 'room_id'),
    1,
    null,
    null,
    jsonb_build_array((select value #>> '{data,notifications,0,eventId}' from mvp1_results where key = 'guest_notifications'))
  ) #>> '{error,code}',
  'INVALID_REQUEST',
  'sharing_mvp1_sync_progress: malformed processed_event_ids are rejected'
);

insert into mvp1_results(key, value)
select 'versions_after_update',
       public.get_room_versions((select value::uuid from mvp1_values where key = 'room_id'));

select is(
  (select value #>> '{data,itemsVersion}' from mvp1_results where key = 'versions_after_update'),
  '1',
  'sharing_mvp1_room_versions: lightweight version RPC reports latest items version'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp1_results(key, value)
select 'host_claim',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-1',
         '{}'::jsonb,
         'Purchased',
         null,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-1',
           array['purchaseStatus', 'securedBy']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'host_claim') ->> 'ok')::boolean,
  'sharing_mvp1_update_room_item_with_purchase: host purchase claim succeeds'
);

select ok(
  exists (
    select 1
    from public.room_items ri
    join public.room_members rm on rm.id = ri.secured_by
    where ri.room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and ri.local_item_id = 'item-1'
      and ri.purchase_status = 'Purchased'
      and rm.user_id = (select value::uuid from mvp1_values where key = 'host_auth')
  ),
  'sharing_mvp1_update_room_item_with_purchase: purchased item is secured by the executing member'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

select is(
  public.update_room_item_with_purchase(
    (select value::uuid from mvp1_values where key = 'room_id'),
    'item-1',
    '{}'::jsonb,
    'Purchased',
    null,
    '{}'::jsonb
  ) #>> '{error,code}',
  'PERMISSION_DENIED',
  'sharing_mvp1_update_room_item_with_purchase: double purchase claim is rejected for the losing member'
);

select is(
  public.update_room_item_with_purchase(
    (select value::uuid from mvp1_values where key = 'room_id'),
    'item-1',
    '{"price":999}'::jsonb,
    'Purchased',
    null,
    '{}'::jsonb
  ) #>> '{error,code}',
  'PERMISSION_DENIED',
  'sharing_mvp1_combined_update: double purchase rejects the whole combined update'
);

select is(
  (
    select price::text
    from public.room_items
    where room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and local_item_id = 'item-1'
  ),
  '1500',
  'sharing_mvp1_combined_update: rejected purchase does not apply the price change'
);

select is(
  (
    select items_version::text
    from public.rooms
    where id = (select value::uuid from mvp1_values where key = 'room_id')
  ),
  '2',
  'sharing_mvp1_update_room_item_with_purchase: failed double claim does not allocate a new item version'
);

select ok(
  exists (
    select 1
    from public.notifications n
    join public.notification_delivery_state ds on ds.notification_id = n.id
    where n.room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and n.notification_type = 'item_claim_failed'
      and n.target_member_id = ((select value from mvp1_results where key = 'join_room') #>> '{data,roomMemberId}')::uuid
      and ds.room_member_id = n.target_member_id
  ),
  'sharing_mvp1_update_room_item_with_purchase: double purchase failure creates targeted notification'
);

insert into mvp1_results(key, value)
select 'guest_field_only_after_claim',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-1',
         '{"price":1600}'::jsonb,
         null,
         null,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-1',
           array['price']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'guest_field_only_after_claim') ->> 'ok')::boolean,
  'sharing_mvp1_combined_update: non-claim field update is allowed on already secured item'
);

select ok(
  exists (
    select 1
    from public.room_items ri
    join public.room_members rm on rm.id = ri.secured_by
    where ri.room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and ri.local_item_id = 'item-1'
      and ri.price = 1600
      and rm.user_id = (select value::uuid from mvp1_values where key = 'host_auth')
  ),
  'sharing_mvp1_combined_update: field-only update preserves the original securing member'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp1_results(key, value)
select 'host_clear_claim',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-1',
         '{}'::jsonb,
         'None',
         null,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-1',
           array['purchaseStatus', 'securedBy']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'host_clear_claim') ->> 'ok')::boolean,
  'sharing_mvp1_update_room_item_with_purchase: clearing purchase status succeeds'
);

select ok(
  exists (
    select 1
    from public.room_items
    where room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and local_item_id = 'item-1'
      and purchase_status = 'None'
      and secured_by is null
  ),
  'sharing_mvp1_update_room_item_with_purchase: clearing non-purchase status clears secured_by'
);

insert into mvp1_results(key, value)
select 'changes_since_1',
       public.get_room_item_changes_since(
         (select value::uuid from mvp1_values where key = 'room_id'),
         1
       );

select is(
  jsonb_array_length((select value #> '{data,changes}' from mvp1_results where key = 'changes_since_1'))::text,
  '3',
  'sharing_mvp1_item_catchup: later catch-up returns claim and clear events'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'host_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

insert into mvp1_results(key, value)
select 'combined_price_purchase',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-1',
         '{"price":1800}'::jsonb,
         'Purchased',
         null,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-1',
           array['price', 'purchaseStatus', 'securedBy']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'combined_price_purchase') ->> 'ok')::boolean,
  'sharing_mvp1_combined_update: price and purchase status update succeeds atomically'
);

select ok(
  exists (
    select 1
    from public.room_item_change_log
    where room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and items_version = 5
      and changed_fields @> array['price', 'purchaseStatus', 'securedBy']
      and changed_values ->> 'price' = '1800'
      and changed_values ->> 'purchaseStatus' = 'Purchased'
  ),
  'sharing_mvp1_combined_update: change log contains both field and purchase changes in one version'
);

insert into mvp1_results(key, value)
select 'host_limited_item2',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-2',
         '{}'::jsonb,
         'LimitedPurchase',
         1,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-2',
           array['purchaseStatus', 'actualPurchaseQuantity', 'securedBy']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'host_limited_item2') ->> 'ok')::boolean,
  'sharing_mvp1_update_room_item_with_purchase: limited purchase claim succeeds for second item'
);

insert into mvp1_results(key, value)
select 'host_actual_quantity_item2',
       public.update_room_item_with_purchase(
         (select value::uuid from mvp1_values where key = 'room_id'),
         'item-2',
         '{"actualPurchaseQuantity":2}'::jsonb,
         null,
         null,
         pg_temp.mvp1_expected_clocks(
           (select value::uuid from mvp1_values where key = 'room_id'),
           'item-2',
           array['actualPurchaseQuantity']
         )
       );

select ok(
  ((select value from mvp1_results where key = 'host_actual_quantity_item2') ->> 'ok')::boolean,
  'sharing_mvp1_update_room_item_with_purchase: actual purchase quantity update succeeds'
);

select ok(
  exists (
    select 1
    from public.room_item_change_log
    where room_id = (select value::uuid from mvp1_values where key = 'room_id')
      and local_item_id = 'item-2'
      and items_version = 7
      and changed_fields = array['actualPurchaseQuantity']
      and changed_values ->> 'actualPurchaseQuantity' = '2'
  ),
  'sharing_mvp1_item_patch_catchup: actual purchase quantity is logged as a field patch'
);

select is(
  (
    select array_agg(items_version order by items_version)::text
    from public.room_item_change_log
    where room_id = (select value::uuid from mvp1_values where key = 'room_id')
  ),
  ARRAY[1, 2, 3, 4, 5, 6, 7]::bigint[]::text,
  'sharing_mvp1_items_version_allocation: item versions are contiguous without gaps'
);

select is(
  (
    select items_version::text
    from public.rooms
    where id = (select value::uuid from mvp1_values where key = 'room_id')
  ),
  '7',
  'sharing_mvp1_items_version_allocation: room items_version matches the latest mutation'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'guest_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"22222222-2222-4222-8222-222222222222"}',
  true
);

insert into mvp1_results(key, value)
select 'guest_notifications_page_1',
       public.get_notifications_after_watermark(
         (select value::uuid from mvp1_values where key = 'room_id'),
         null,
         null,
         2
       );

insert into mvp1_results(key, value)
select 'guest_notifications_page_2',
       public.get_notifications_after_watermark(
         (select value::uuid from mvp1_values where key = 'room_id'),
         ((select value #>> '{data,nextWatermarkCreatedAt}' from mvp1_results where key = 'guest_notifications_page_1'))::timestamptz,
         ((select value #>> '{data,nextWatermarkId}' from mvp1_results where key = 'guest_notifications_page_1'))::uuid,
         2
       );

select is(
  jsonb_array_length((select value #> '{data,events}' from mvp1_results where key = 'guest_notifications_page_1'))::text,
  '2',
  'sharing_mvp1_notification_catchup: first limited page returns the requested page size'
);

select ok(
  (select value #>> '{data,hasMore}' from mvp1_results where key = 'guest_notifications_page_1') = 'true'
  and jsonb_array_length((select value #> '{data,events}' from mvp1_results where key = 'guest_notifications_page_2')) >= 1,
  'sharing_mvp1_notification_catchup: subsequent page continues after the previous watermark'
);

insert into public.room_members(room_id, user_id, display_name, role, last_seen_at)
values (
  (select value::uuid from mvp1_values where key = 'room_id'),
  (select value::uuid from mvp1_values where key = 'late_auth'),
  'Late Guest',
  'member',
  now()
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'late_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"33333333-3333-4333-8333-333333333333"}',
  true
);

insert into mvp1_results(key, value)
select 'late_notifications',
       public.get_notifications_after_watermark(
         (select value::uuid from mvp1_values where key = 'room_id'),
         null,
         null,
         100
       );

select is(
  jsonb_array_length((select value #> '{data,events}' from mvp1_results where key = 'late_notifications'))::text,
  '0',
  'sharing_mvp1_notification_delivery: late member does not receive pre-join room-wide notifications via RPC'
);

set local role authenticated;

select is(
  (
    select count(*)::text
    from public.notifications
    where room_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
  ),
  '0',
  'sharing_mvp1_notification_delivery: late member cannot select pre-join room-wide notifications through RLS'
);

reset role;

select is(
  public.update_room_item_with_purchase(
    (select value::uuid from mvp1_values where key = 'room_id'),
    'item-1',
    '{"purchaseStatus":"SoldOut"}'::jsonb,
    null,
    null,
    '{}'::jsonb
  ) #>> '{error,code}',
  'INVALID_REQUEST',
  'sharing_mvp1_update_room_item_with_purchase: unsupported fields are rejected'
);

select set_config('request.jwt.claim.sub', (select value from mvp1_values where key = 'wrong_auth'), true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"99999999-9999-4999-8999-999999999999"}',
  true
);

select is(
  public.update_room_item_with_purchase(
    (select value::uuid from mvp1_values where key = 'room_id'),
    'item-1',
    '{"price":900}'::jsonb,
    null,
    null,
    '{}'::jsonb
  ) #>> '{error,code}',
  'ROOM_UNAVAILABLE',
  'sharing_mvp1_rls_rpc: non-member cannot update item fields through v2 RPC'
);

select isnt(
  has_table_privilege('authenticated', 'public.room_item_change_log', 'select'),
  true,
  'sharing_mvp1_rls_rpc: authenticated role cannot directly select item change log'
);

select ok(
  has_table_privilege('authenticated', 'public.room_items', 'select'),
  'sharing_mvp1_realtime: authenticated role can select room_items for realtime under RLS'
);

select ok(
  has_table_privilege('authenticated', 'public.notifications', 'select'),
  'sharing_mvp1_realtime: authenticated role can select notifications for realtime under RLS'
);

select * from finish();

rollback;
