-- [MVP-2c] Route-order sync and member-scoped notification read state.

create table public.room_route_order_versions (
  room_id uuid not null references public.rooms(id) on delete cascade,
  event_date text not null,
  version bigint not null default 0 check (version >= 0),
  updated_by uuid references public.room_members(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (room_id, event_date),
  check (btrim(event_date) <> '')
);

create index room_route_order_versions_room_updated_idx
  on public.room_route_order_versions(room_id, updated_at desc);

create table public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  room_member_id uuid not null references public.room_members(id) on delete cascade,
  read_at timestamptz,
  hidden_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (notification_id, room_member_id)
);

create index notification_reads_member_room_idx
  on public.notification_reads(room_member_id, room_id, updated_at desc);

create trigger notification_reads_set_updated_at
before update on public.notification_reads
for each row execute function private.set_updated_at();

alter table public.room_route_order_versions enable row level security;
alter table public.notification_reads enable row level security;

revoke all on table public.room_route_order_versions from anon, authenticated;
revoke all on table public.notification_reads from anon, authenticated;

update public.rooms
set route_order_version = 0
where route_order_version is null;

create or replace function private.room_route_order_versions_payload(p_room_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(versions.event_date, versions.version order by versions.event_date),
    '{}'::jsonb
  )
  from public.room_route_order_versions versions
  where versions.room_id = p_room_id;
$$;

create or replace function public.get_room_versions(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  room_row public.rooms;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select * into room_row
  from public.rooms
  where id = p_room_id;

  return private.sharing_success(jsonb_build_object(
    'roomId', room_row.id,
    'itemsVersion', room_row.items_version,
    'routeOrderVersion', room_row.route_order_version,
    'routeOrderVersions', private.room_route_order_versions_payload(p_room_id),
    'roomEventDataUpdatedAt', (
      select red.updated_at
      from public.room_event_data red
      where red.room_id = p_room_id
    ),
    'expiresAt', room_row.expires_at,
    'isActive', room_row.sharing_status = 'active' and room_row.expires_at > now()
  ));
end;
$$;

create or replace function public.get_route_order_by_date(
  p_room_id uuid,
  p_event_date text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  event_date_key text := btrim(coalesce(p_event_date, ''));
  route_items jsonb;
  route_version bigint;
  room_route_version bigint;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if event_date_key = '' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select r.route_order_version into room_route_version
  from public.rooms r
  where r.id = p_room_id
    and r.sharing_status = 'active'
    and r.expires_at > now();

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select coalesce(red.event_data #> array['routeOrderByDate', event_date_key], '[]'::jsonb)
  into route_items
  from public.room_event_data red
  where red.room_id = p_room_id;

  if jsonb_typeof(route_items) is distinct from 'array' then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
  end if;

  select coalesce(versions.version, 0) into route_version
  from public.room_route_order_versions versions
  where versions.room_id = p_room_id
    and versions.event_date = event_date_key;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'eventDate', event_date_key,
    'itemIds', route_items,
    'dateRouteOrderVersion', coalesce(route_version, 0),
    'routeOrderVersion', room_route_version
  ));
end;
$$;

create or replace function public.update_route_order(
  p_room_id uuid,
  p_event_date text,
  p_item_ids text[],
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  room_row public.rooms;
  event_date_key text := btrim(coalesce(p_event_date, ''));
  route_item_ids text[] := coalesce(p_item_ids, array[]::text[]);
  current_date_version bigint;
  new_date_version bigint;
  new_room_route_version bigint;
  notification_id uuid;
  invalid_item_count integer;
  distinct_item_count integer;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if event_date_key = ''
     or p_expected_version is null
     or p_expected_version < 0
     or exists (
       select 1
       from unnest(route_item_ids) item_id
       where item_id is null or btrim(item_id) = ''
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select count(distinct item_id) into distinct_item_count
  from unnest(route_item_ids) item_id;

  if distinct_item_count <> coalesce(array_length(route_item_ids, 1), 0) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select * into room_row
  from public.rooms
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at > now()
  for update;

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select count(*) into invalid_item_count
  from unnest(route_item_ids) item_id
  where not exists (
    select 1
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.local_item_id = item_id
      and coalesce(ri.event_date, '') = event_date_key
  );

  if invalid_item_count > 0 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select coalesce(versions.version, 0) into current_date_version
  from public.room_route_order_versions versions
  where versions.room_id = p_room_id
    and versions.event_date = event_date_key
  for update;

  current_date_version := coalesce(current_date_version, 0);
  if current_date_version <> p_expected_version then
    return private.sharing_error('ROUTE_ORDER_CONFLICT');
  end if;

  new_date_version := current_date_version + 1;
  new_room_route_version := coalesce(room_row.route_order_version, 0) + 1;

  insert into public.room_route_order_versions(
    room_id,
    event_date,
    version,
    updated_by,
    updated_at
  )
  values (
    p_room_id,
    event_date_key,
    new_date_version,
    member_id,
    now()
  )
  on conflict (room_id, event_date) do update
    set version = excluded.version,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  update public.rooms
  set route_order_version = new_room_route_version
  where id = p_room_id;

  update public.room_event_data
  set event_data = jsonb_set(
        event_data,
        array['routeOrderByDate', event_date_key],
        to_jsonb(route_item_ids),
        true
      )
  where room_id = p_room_id;

  update public.room_items ri
  set order_index = ordered.ordinality - 1,
      updated_by = member_id
  from unnest(route_item_ids) with ordinality as ordered(local_item_id, ordinality)
  where ri.room_id = p_room_id
    and ri.local_item_id = ordered.local_item_id
    and coalesce(ri.event_date, '') = event_date_key;

  update public.room_items ri
  set order_index = null,
      updated_by = member_id
  where ri.room_id = p_room_id
    and coalesce(ri.event_date, '') = event_date_key
    and not (ri.local_item_id = any(route_item_ids))
    and ri.order_index is not null;

  insert into public.notifications(
    room_id,
    idempotency_key,
    notification_type,
    target_member_id,
    payload
  )
  values (
    p_room_id,
    'route:' || p_room_id::text || ':' || event_date_key || ':v' || new_date_version::text,
    'route_order_updated',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'eventDate', event_date_key,
      'itemIds', to_jsonb(route_item_ids),
      'dateRouteOrderVersion', new_date_version,
      'routeOrderVersion', new_room_route_version,
      'updatedFields', '["routeOrderByDate"]'::jsonb,
      'updatedValues', jsonb_build_object(
        'routeOrderByDate',
        jsonb_build_object(
          'eventDate', event_date_key,
          'itemIds', to_jsonb(route_item_ids),
          'version', new_date_version
        )
      ),
      'fieldUpdatedAt', jsonb_build_object('routeOrderByDate', now()),
      'updatedByMemberId', member_id
    )
  )
  returning id into notification_id;

  perform private.create_room_notification_delivery(notification_id, p_room_id);

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'eventDate', event_date_key,
    'itemIds', to_jsonb(route_item_ids),
    'dateRouteOrderVersion', new_date_version,
    'routeOrderVersion', new_room_route_version,
    'routeOrderVersions', private.room_route_order_versions_payload(p_room_id),
    'notificationId', notification_id
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

create or replace function public.get_notification_list(
  p_room_id uuid,
  p_limit integer default 50,
  p_include_hidden boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  effective_limit integer;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  effective_limit := least(greatest(coalesce(p_limit, 50), 1), 100);

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'limit', effective_limit,
    'notifications', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', listed.id,
          'eventId', listed.event_id,
          'idempotencyKey', listed.idempotency_key,
          'notificationType', listed.notification_type,
          'targetMemberId', listed.target_member_id,
          'payload', listed.payload,
          'createdAt', listed.created_at,
          'readAt', listed.read_at,
          'hiddenAt', listed.hidden_at
        )
        order by listed.created_at desc, listed.id desc
      )
      from (
        select n.*, reads.read_at, reads.hidden_at
        from public.notification_delivery_state ds
        join public.notifications n on n.id = ds.notification_id
        left join public.notification_reads reads
          on reads.notification_id = n.id
         and reads.room_member_id = member_id
        where ds.room_id = p_room_id
          and ds.room_member_id = member_id
          and (p_include_hidden or reads.hidden_at is null)
        order by n.created_at desc, n.id desc
        limit effective_limit
      ) listed
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function public.mark_notification_read(
  p_room_id uuid,
  p_notification_id uuid,
  p_is_read boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  next_read_at timestamptz;
  existing_hidden_at timestamptz;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_notification_id is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if not private.current_member_has_notification_delivery(p_room_id, p_notification_id) then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  next_read_at := case when coalesce(p_is_read, true) then now() else null end;

  insert into public.notification_reads(
    notification_id,
    room_id,
    room_member_id,
    read_at
  )
  values (
    p_notification_id,
    p_room_id,
    member_id,
    next_read_at
  )
  on conflict (notification_id, room_member_id) do update
    set read_at = excluded.read_at
  returning hidden_at into existing_hidden_at;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'notificationId', p_notification_id,
    'readAt', next_read_at,
    'hiddenAt', existing_hidden_at
  ));
end;
$$;

create or replace function public.hide_notification(
  p_room_id uuid,
  p_notification_id uuid,
  p_is_hidden boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  existing_read_at timestamptz;
  next_hidden_at timestamptz;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_notification_id is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if not private.current_member_has_notification_delivery(p_room_id, p_notification_id) then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  next_hidden_at := case when coalesce(p_is_hidden, true) then now() else null end;

  insert into public.notification_reads(
    notification_id,
    room_id,
    room_member_id,
    hidden_at
  )
  values (
    p_notification_id,
    p_room_id,
    member_id,
    next_hidden_at
  )
  on conflict (notification_id, room_member_id) do update
    set hidden_at = excluded.hidden_at
  returning read_at into existing_read_at;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'notificationId', p_notification_id,
    'readAt', existing_read_at,
    'hiddenAt', next_hidden_at
  ));
end;
$$;

create or replace function public.ack_room_route_order_versions(
  p_room_id uuid,
  p_route_order_versions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if jsonb_typeof(coalesce(p_route_order_versions, '{}'::jsonb)) <> 'object'
     or exists (
       select 1
       from jsonb_each(coalesce(p_route_order_versions, '{}'::jsonb)) entry(key, value)
       where btrim(entry.key) = ''
          or jsonb_typeof(entry.value) <> 'number'
          or (entry.value #>> '{}')::bigint < 0
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if exists (
    select 1
    from jsonb_each(coalesce(p_route_order_versions, '{}'::jsonb)) requested(event_date, version_value)
    left join public.room_route_order_versions actual
      on actual.room_id = p_room_id
     and actual.event_date = requested.event_date
    where (requested.version_value #>> '{}')::bigint > coalesce(actual.version, 0)
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  insert into public.room_member_sync_state(
    room_member_id,
    room_id,
    route_order_versions
  )
  values (
    member_id,
    p_room_id,
    coalesce(p_route_order_versions, '{}'::jsonb)
  )
  on conflict (room_member_id) do update
    set route_order_versions = excluded.route_order_versions;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'routeOrderVersions', coalesce(p_route_order_versions, '{}'::jsonb)
  ));
end;
$$;

create or replace function public.get_room_snapshot(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  snapshot_envelope jsonb;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  with room_row as (
    select r.*
    from public.rooms r
    where r.id = p_room_id
      and r.sharing_status = 'active'
      and r.expires_at > now()
  ),
  member_row as (
    select rm.*
    from public.room_members rm
    where rm.id = member_id
  ),
  notification_watermark as (
    select n.created_at, n.id
    from public.notifications n
    where n.room_id = p_room_id
    order by n.created_at desc, n.id desc
    limit 1
  ),
  route_versions as (
    select private.room_route_order_versions_payload(p_room_id) as value
  ),
  snapshot_payload as (
    select jsonb_build_object(
      'room', jsonb_build_object(
        'roomId', r.id,
        'eventName', r.event_name,
        'hostMemberId', r.host_member_id,
        'itemsVersion', r.items_version,
        'routeOrderVersion', r.route_order_version,
        'expiresAt', r.expires_at,
        'sharingStatus', r.sharing_status
      ),
      'currentMember', jsonb_build_object(
        'roomMemberId', m.id,
        'displayName', m.display_name,
        'color', m.color,
        'role', m.role
      ),
      'members', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'roomMemberId', rm.id,
            'displayName', rm.display_name,
            'color', rm.color,
            'role', rm.role,
            'membershipStatus', rm.membership_status
          )
          order by rm.joined_at, rm.id
        )
        from public.room_members rm
        where rm.room_id = p_room_id
          and rm.membership_status = 'active'
      ), '[]'::jsonb),
      'items', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', ri.id,
            'localItemId', ri.local_item_id,
            'eventDate', ri.event_date,
            'name', ri.name,
            'purchaseStatus', ri.purchase_status,
            'price', ri.price,
            'quantity', ri.quantity,
            'limitQuantity', ri.limit_quantity,
            'actualPurchaseQuantity', ri.actual_purchase_quantity,
            'remarks', ri.remarks,
            'url', ri.url,
            'assignedTo', ri.assigned_to,
            'securedBy', ri.secured_by,
            'orderIndex', ri.order_index,
            'postponed', ri.postponed,
            'itemVersion', ri.item_version,
            'updatedAt', ri.updated_at
          )
          order by ri.local_item_id
        )
        from public.room_items ri
        where ri.room_id = p_room_id
      ), '[]'::jsonb),
      'eventData', red.event_data,
      'snapshot', jsonb_build_object(
        'itemsVersion', r.items_version,
        'routeOrderVersion', r.route_order_version,
        'routeOrderVersions', route_versions.value,
        'notificationWatermarkCreatedAt', (select created_at from notification_watermark),
        'notificationWatermarkId', (select id from notification_watermark),
        'createdAt', now()
      )
    ) as payload
    from room_row r
    join member_row m on true
    join public.room_event_data red on red.room_id = r.id
    join route_versions on true
  ),
  inserted_receipt as (
    insert into private.room_snapshot_receipts(
      room_id,
      room_member_id,
      items_version,
      route_order_version,
      route_order_versions,
      notification_watermark_created_at,
      notification_watermark_id,
      snapshot_hash
    )
    select p_room_id,
           member_id,
           (payload #>> '{snapshot,itemsVersion}')::bigint,
           (payload #>> '{snapshot,routeOrderVersion}')::bigint,
           payload #> '{snapshot,routeOrderVersions}',
           (payload #>> '{snapshot,notificationWatermarkCreatedAt}')::timestamptz,
           (payload #>> '{snapshot,notificationWatermarkId}')::uuid,
           private.base64url(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'))
    from snapshot_payload
    returning *
  )
  select private.sharing_success(
    jsonb_set(
      snapshot_payload.payload,
      '{snapshot,receiptId}',
      to_jsonb(inserted_receipt.id::text),
      true
    )
  )
  into snapshot_envelope
  from snapshot_payload
  join inserted_receipt on true;

  if snapshot_envelope is null then
    return private.sharing_error('SNAPSHOT_CONFLICT');
  end if;

  return snapshot_envelope;
end;
$$;

do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'room_route_order_versions'
    ) then
      alter publication supabase_realtime add table public.room_route_order_versions;
    end if;
  end if;
end;
$$;

revoke all on function public.get_route_order_by_date(uuid, text) from public;
revoke all on function public.update_route_order(uuid, text, text[], bigint) from public;
revoke all on function public.get_notification_list(uuid, integer, boolean) from public;
revoke all on function public.mark_notification_read(uuid, uuid, boolean) from public;
revoke all on function public.hide_notification(uuid, uuid, boolean) from public;
revoke all on function public.ack_room_route_order_versions(uuid, jsonb) from public;

grant execute on function public.get_route_order_by_date(uuid, text) to authenticated;
grant execute on function public.update_route_order(uuid, text, text[], bigint) to authenticated;
grant execute on function public.get_notification_list(uuid, integer, boolean) to authenticated;
grant execute on function public.mark_notification_read(uuid, uuid, boolean) to authenticated;
grant execute on function public.hide_notification(uuid, uuid, boolean) to authenticated;
grant execute on function public.ack_room_route_order_versions(uuid, jsonb) to authenticated;
