with canonical_route_by_date as (
  select
    route_items.room_id,
    jsonb_object_agg(route_items.event_date, route_items.item_ids order by route_items.event_date) as route_order_by_date
  from (
    select
      ri.room_id,
      ri.event_date,
      jsonb_agg(ri.local_item_id order by ri.order_index, ri.local_item_id, ri.id) as item_ids
    from public.room_items ri
    where ri.deleted_at is null
      and ri.order_index is not null
      and ri.event_date is not null
      and btrim(ri.event_date) <> ''
    group by ri.room_id, ri.event_date
  ) route_items
  group by route_items.room_id
),
active_v1_or_unknown_members as (
  select rm.id
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and rm.membership_status = 'active'
    and rm.accepted_contract_version is distinct from 2
),
checks as (
  select
    'active_v1_or_unknown_members' as check_key,
    'blocker' as severity,
    count(*)::bigint as observed_count,
    jsonb_build_object('reason', 'Active members without accepted contract v2 can still be affected by activation.') as details
  from active_v1_or_unknown_members

  union all
  select
    'active_v1_or_unknown_member_sync_state',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Sync watermarks for non-v2 active members must not be reused as v2 baselines.')
  from public.room_member_sync_state rms
  join active_v1_or_unknown_members legacy_members on legacy_members.id = rms.room_member_id

  union all
  select
    'pending_v1_create_challenges',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Pending create challenges must be consumed, expired, deleted, or reissued as contract v2.')
  from private.room_create_payload_challenges c
  where c.consumed_at is null
    and c.expires_at > now()
    and c.contract_version is distinct from 2

  union all
  select
    'pending_v1_join_restore_challenges',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Pending join/restore challenges must not be upgraded in place.')
  from private.room_join_challenges c
  where c.consumed_at is null
    and c.expires_at > now()
    and c.contract_version is distinct from 2

  union all
  select
    'active_items_missing_field_clocks',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Active item rows need field clocks before v2 field-level conflict detection is safe.')
  from public.room_items ri
  join public.rooms r on r.id = ri.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and ri.deleted_at is null
    and (
      ri.field_clocks is null
      or jsonb_typeof(ri.field_clocks) <> 'object'
      or ri.field_clocks = '{}'::jsonb
    )

  union all
  select
    'title_name_mismatch',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'The compatibility name column must match canonical title before old writers are removed.')
  from public.room_items ri
  join public.rooms r on r.id = ri.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and ri.deleted_at is null
    and ri.title is distinct from ri.name

  union all
  select
    'postponed_mirror_mismatch',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'The postponed mirror must be derived from purchaseStatus = Postpone.')
  from public.room_items ri
  join public.rooms r on r.id = ri.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and ri.deleted_at is null
    and ri.postponed is distinct from (ri.purchase_status = 'Postpone')

  union all
  select
    'route_membership_without_event_date',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Route member rows cannot be assigned to a route without an event date.')
  from public.room_items ri
  join public.rooms r on r.id = ri.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and ri.deleted_at is null
    and ri.order_index is not null
    and (ri.event_date is null or btrim(ri.event_date) = '')

  union all
  select
    'missing_route_version_rows',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Each active route date needs a canonical route version row.')
  from (
    select distinct ri.room_id, ri.event_date
    from public.room_items ri
    join public.rooms r on r.id = ri.room_id
    where r.sharing_status = 'active'
      and r.expires_at > now()
      and ri.deleted_at is null
      and ri.order_index is not null
      and ri.event_date is not null
      and btrim(ri.event_date) <> ''
  ) route_dates
  left join public.room_route_order_versions rov
    on rov.room_id = route_dates.room_id
   and rov.event_date = route_dates.event_date
  where rov.room_id is null

  union all
  select
    'route_mirror_mismatch',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'room_event_data.routeOrderByDate must match canonical room_items route order before activation.')
  from public.room_event_data red
  join public.rooms r on r.id = red.room_id
  left join canonical_route_by_date canonical on canonical.room_id = red.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and coalesce(red.event_data -> 'routeOrderByDate', '{}'::jsonb)
        <> coalesce(canonical.route_order_by_date, '{}'::jsonb)

  union all
  select
    'event_data_size_mismatch',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'event_data_size_bytes must describe the current compatibility mirror payload.')
  from public.room_event_data red
  join public.rooms r on r.id = red.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and red.event_data_size_bytes <> length(convert_to(red.event_data::text, 'UTF8'))

  union all
  select
    'legacy_change_log_missing_v2_metadata',
    'blocker',
    count(*)::bigint,
    jsonb_build_object('reason', 'Change log rows without v2 metadata cannot be delivered as normal incremental diffs.')
  from public.room_item_change_log cl
  join public.rooms r on r.id = cl.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and (
      cl.change_type is null
      or cl.field_clocks is null
      or jsonb_typeof(cl.field_clocks) <> 'object'
      or cl.field_clocks = '{}'::jsonb
      or (cl.change_type in ('create', 'undelete') and cl.item_payload is null)
    )

  union all
  select
    'deleted_tombstone_rows',
    'warning',
    count(*)::bigint,
    jsonb_build_object(
      'reason', 'Deleted rows are retained for sync history; monitor this count and deletedItemClocks payload size.',
      'estimatedDeletedItemClocksBytes', coalesce(sum(length(convert_to(jsonb_build_object(
        'localItemId', ri.local_item_id,
        'deletedAt', ri.deleted_at,
        'deletedBy', ri.deleted_by,
        'fieldClocks', ri.field_clocks,
        'itemVersion', ri.item_version,
        'updatedAt', ri.updated_at
      )::text, 'UTF8'))), 0)
    )
  from public.room_items ri
  join public.rooms r on r.id = ri.room_id
  where r.sharing_status = 'active'
    and r.expires_at > now()
    and ri.deleted_at is not null

  union all
  select
    'old_rpc_execute_grants_present',
    'warning',
    count(*)::bigint,
    jsonb_build_object('reason', 'Expected before activation; after the gate these grants/functions must be revoked or dropped.')
  from information_schema.routine_privileges rp
  where rp.routine_schema = 'public'
    and rp.routine_name in ('claim_item', 'update_room_item_fields')
    and rp.grantee = 'authenticated'
    and rp.privilege_type = 'EXECUTE'

  union all
  select
    'active_rooms',
    'info',
    count(*)::bigint,
    jsonb_build_object('reason', 'Active room count at audit time.')
  from public.rooms r
  where r.sharing_status = 'active'
    and r.expires_at > now()
)
select
  check_key,
  severity,
  observed_count,
  details
from checks
order by
  case severity
    when 'blocker' then 0
    when 'warning' then 1
    else 2
  end,
  check_key;
