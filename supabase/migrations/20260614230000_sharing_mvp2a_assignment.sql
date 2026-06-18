-- [MVP-2a] Manual assignment and bulk transfer.

create or replace function public.assign_item(
  p_room_id uuid,
  p_local_item_id text,
  p_assigned_to uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  member_role text;
  room_row public.rooms;
  item_row public.room_items;
  updated_item public.room_items;
  new_version bigint;
  new_updated_at timestamptz := now();
  changed_fields text[] := array['assignedTo'];
  changed_values jsonb;
  field_updated_at jsonb;
  notification_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_assigned_to is null or nullif(btrim(coalesce(p_local_item_id, '')), '') is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select rm.role into member_role
  from public.room_members rm
  where rm.id = member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active';

  if not exists (
    select 1
    from public.room_members target
    where target.id = p_assigned_to
      and target.room_id = p_room_id
      and target.membership_status = 'active'
  ) then
    return private.sharing_error('INVALID_REQUEST');
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

  select * into item_row
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(p_local_item_id)
  for update;

  if not found then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if member_role <> 'host' and item_row.assigned_to is distinct from member_id then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  if item_row.assigned_to is not distinct from p_assigned_to then
    return private.sharing_success(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', room_row.items_version,
      'changedFields', '[]'::jsonb,
      'updatedValues', '{}'::jsonb,
      'fieldUpdatedAt', '{}'::jsonb,
      'item', private.room_item_payload(item_row)
    ));
  end if;

  new_version := room_row.items_version + 1;

  update public.rooms
  set items_version = new_version
  where id = p_room_id;

  update public.room_items
  set assigned_to = p_assigned_to,
      item_version = new_version,
      updated_by = member_id,
      updated_at = new_updated_at
  where id = item_row.id
  returning * into updated_item;

  changed_values := private.jsonb_keep_keys(private.room_item_payload(updated_item), changed_fields);
  field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);

  insert into public.notifications(
    room_id,
    idempotency_key,
    notification_type,
    target_member_id,
    payload
  )
  values (
    p_room_id,
    'item:' || updated_item.id::text || ':v' || new_version::text,
    'item_assigned',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', updated_item.local_item_id,
      'itemsVersion', new_version,
      'updatedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'updatedByMemberId', member_id,
      'assignedToMemberId', p_assigned_to
    )
  )
  returning id into notification_id;

  perform private.create_room_notification_delivery(notification_id, p_room_id);

  insert into public.room_item_change_log(
    room_id,
    room_item_id,
    local_item_id,
    items_version,
    changed_fields,
    changed_values,
    field_updated_at,
    updated_by,
    notification_id
  )
  values (
    p_room_id,
    updated_item.id,
    updated_item.local_item_id,
    new_version,
    changed_fields,
    changed_values,
    field_updated_at,
    member_id,
    notification_id
  );

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'itemsVersion', new_version,
    'changedFields', to_jsonb(changed_fields),
    'updatedValues', changed_values,
    'fieldUpdatedAt', field_updated_at,
    'notificationId', notification_id,
    'item', private.room_item_payload(updated_item)
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

create or replace function public.bulk_assign_items(
  p_room_id uuid,
  p_local_item_ids text[],
  p_assigned_to uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  member_role text;
  room_row public.rooms;
  item_row public.room_items;
  updated_item public.room_items;
  input_count integer := coalesce(array_length(p_local_item_ids, 1), 0);
  requested_ids text[];
  requested_count integer;
  found_count integer;
  changed_item_ids uuid[] := array[]::uuid[];
  changed_count integer := 0;
  version_cursor bigint;
  new_updated_at timestamptz := now();
  changed_fields text[] := array['assignedTo'];
  changed_values jsonb;
  field_updated_at jsonb;
  notification_id uuid;
  changed_items jsonb := '[]'::jsonb;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_assigned_to is null or input_count = 0 or input_count > 500 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select array_agg(trimmed_id order by trimmed_id), count(*)
  into requested_ids, requested_count
  from (
    select distinct btrim(local_item_id) as trimmed_id
    from unnest(p_local_item_ids) local_item_id
    where nullif(btrim(local_item_id), '') is not null
  ) normalized;

  if requested_count is null or requested_count <> input_count then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select rm.role into member_role
  from public.room_members rm
  where rm.id = member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active';

  if not exists (
    select 1
    from public.room_members target
    where target.id = p_assigned_to
      and target.room_id = p_room_id
      and target.membership_status = 'active'
  ) then
    return private.sharing_error('INVALID_REQUEST');
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

  select count(*) into found_count
  from public.room_items ri
  where ri.room_id = p_room_id
    and ri.local_item_id = any(requested_ids);

  if found_count <> requested_count then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  for item_row in
    select *
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.local_item_id = any(requested_ids)
    order by ri.local_item_id asc, ri.id asc
    for update
  loop
    if member_role <> 'host' and item_row.assigned_to is distinct from member_id then
      return private.sharing_error('PERMISSION_DENIED');
    end if;

    if item_row.assigned_to is distinct from p_assigned_to then
      changed_item_ids := array_append(changed_item_ids, item_row.id);
      changed_count := changed_count + 1;
    end if;
  end loop;

  if changed_count = 0 then
    return private.sharing_success(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', room_row.items_version,
      'changedItems', '[]'::jsonb,
      'assignedToMemberId', p_assigned_to
    ));
  end if;

  update public.rooms
  set items_version = room_row.items_version + changed_count
  where id = p_room_id;

  version_cursor := room_row.items_version;

  for item_row in
    select *
    from public.room_items ri
    where ri.id = any(changed_item_ids)
    order by ri.local_item_id asc, ri.id asc
    for update
  loop
    version_cursor := version_cursor + 1;

    update public.room_items
    set assigned_to = p_assigned_to,
        item_version = version_cursor,
        updated_by = member_id,
        updated_at = new_updated_at
    where id = item_row.id
    returning * into updated_item;

    changed_values := private.jsonb_keep_keys(private.room_item_payload(updated_item), changed_fields);
    field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);

    insert into public.notifications(
      room_id,
      idempotency_key,
      notification_type,
      target_member_id,
      payload
    )
    values (
      p_room_id,
      'item:' || updated_item.id::text || ':v' || version_cursor::text,
      'item_assigned',
      null,
      jsonb_build_object(
        'roomId', p_room_id,
        'localItemId', updated_item.local_item_id,
        'itemsVersion', version_cursor,
        'updatedFields', to_jsonb(changed_fields),
        'updatedValues', changed_values,
        'fieldUpdatedAt', field_updated_at,
        'updatedByMemberId', member_id,
        'assignedToMemberId', p_assigned_to,
        'assignmentMode', 'bulk'
      )
    )
    returning id into notification_id;

    perform private.create_room_notification_delivery(notification_id, p_room_id);

    insert into public.room_item_change_log(
      room_id,
      room_item_id,
      local_item_id,
      items_version,
      changed_fields,
      changed_values,
      field_updated_at,
      updated_by,
      notification_id
    )
    values (
      p_room_id,
      updated_item.id,
      updated_item.local_item_id,
      version_cursor,
      changed_fields,
      changed_values,
      field_updated_at,
      member_id,
      notification_id
    );

    changed_items := changed_items || jsonb_build_array(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', version_cursor,
      'changedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'notificationId', notification_id,
      'item', private.room_item_payload(updated_item)
    ));
  end loop;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'itemsVersion', room_row.items_version + changed_count,
    'assignedToMemberId', p_assigned_to,
    'changedItems', changed_items
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
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
        and tablename = 'room_members'
    ) then
      alter publication supabase_realtime add table public.room_members;
    end if;
  end if;
end;
$$;

grant select on table public.room_members to authenticated;

drop policy if exists room_members_select_active_members on public.room_members;
create policy room_members_select_active_members
on public.room_members
for select
to authenticated
using (public.can_select_room_sync_rows(room_id));

revoke all on function public.assign_item(uuid, text, uuid) from public;
revoke all on function public.bulk_assign_items(uuid, text[], uuid) from public;

grant execute on function public.assign_item(uuid, text, uuid) to authenticated;
grant execute on function public.bulk_assign_items(uuid, text[], uuid) to authenticated;
