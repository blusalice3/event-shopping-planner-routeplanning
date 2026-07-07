-- Restrict member-route visibility and prevent non-host assignment stealing.

create or replace function private.room_member_route_order_versions_payload_for_viewer(
  p_room_id uuid,
  p_viewer_member_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(event_versions.event_date, event_versions.routes_by_member), '{}'::jsonb)
  from (
    select versions.event_date,
           jsonb_object_agg(versions.route_member_id::text, versions.version order by versions.route_member_id::text) as routes_by_member
    from public.room_member_route_order_versions versions
    join public.room_members viewer
      on viewer.id = p_viewer_member_id
     and viewer.room_id = versions.room_id
     and viewer.membership_status = 'active'
    where versions.room_id = p_room_id
      and (viewer.role = 'host' or versions.route_member_id = viewer.id)
    group by versions.event_date
  ) event_versions
$$;

create or replace function private.can_read_member_route(
  p_actor_member_id uuid,
  p_route_member_id uuid
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members actor
    join public.room_members target
      on target.id = p_route_member_id
     and target.room_id = actor.room_id
     and target.membership_status = 'active'
    where actor.id = p_actor_member_id
      and actor.membership_status = 'active'
      and (actor.role = 'host' or actor.id = target.id)
  )
$$;

create or replace function private.create_member_route_notification_delivery(
  p_notification_id uuid,
  p_room_id uuid,
  p_route_member_id uuid
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notification_delivery_state(
    notification_id,
    room_id,
    room_member_id
  )
  select p_notification_id,
         p_room_id,
         rm.id
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = p_room_id
    and rm.membership_status = 'active'
    and rm.accepted_contract_version = 2
    and r.sharing_status = 'active'
    and r.expires_at > now()
    and (rm.role = 'host' or rm.id = p_route_member_id)
  on conflict do nothing;
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
    'memberRouteOrderVersions',
      private.room_member_route_order_versions_payload_for_viewer(p_room_id, member_id),
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

create or replace function public.get_member_route_order_by_date(
  p_room_id uuid,
  p_event_date text,
  p_route_member_id uuid
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

  if event_date_key = '' or p_route_member_id is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if not private.can_read_member_route(member_id, p_route_member_id) then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  select r.route_order_version into room_route_version
  from public.rooms r
  where r.id = p_room_id
    and r.sharing_status = 'active'
    and r.expires_at > now();

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  select coalesce(red.event_data #> array['memberRouteItems', event_date_key, p_route_member_id::text], '[]'::jsonb)
    into route_items
  from public.room_event_data red
  where red.room_id = p_room_id;

  if jsonb_typeof(route_items) is distinct from 'array' then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
  end if;

  select coalesce(versions.version, 0) into route_version
  from public.room_member_route_order_versions versions
  where versions.room_id = p_room_id
    and versions.event_date = event_date_key
    and versions.route_member_id = p_route_member_id;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'eventDate', event_date_key,
    'routeMemberId', p_route_member_id,
    'itemIds', route_items,
    'dateMemberRouteOrderVersion', coalesce(route_version, 0),
    'routeOrderVersion', room_route_version,
    'memberRouteOrderVersions',
      private.room_member_route_order_versions_payload_for_viewer(p_room_id, member_id)
  ));
end;
$$;

create or replace function public.update_room_item_with_purchase(
  p_room_id uuid,
  p_local_item_id text,
  p_fields jsonb,
  p_status text,
  p_actual_purchase_quantity integer,
  p_expected_field_clocks jsonb
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
  item_row public.room_items;
  target_assigned_to_text text;
  target_assigned_to uuid;
  is_assignment_only boolean;
  has_purchase_final_field boolean;
begin
  is_assignment_only := (
    p_status is null
    and p_actual_purchase_quantity is null
    and p_fields is not null
    and jsonb_typeof(p_fields) = 'object'
    and p_fields ? 'assignedTo'
    and (select count(*) from jsonb_object_keys(p_fields)) = 1
  );

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

  select rm.role into member_role
  from public.room_members rm
  where rm.id = member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active';

  select * into item_row
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(coalesce(p_local_item_id, ''))
  for update;

  if not found or item_row.deleted_at is not null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if is_assignment_only then
    target_assigned_to_text := nullif(p_fields ->> 'assignedTo', '');
    target_assigned_to := target_assigned_to_text::uuid;
    if member_role <> 'host' then
      if item_row.assigned_to is not null and item_row.assigned_to <> member_id then
        return private.sharing_error('PERMISSION_DENIED');
      end if;
      if target_assigned_to is not null and target_assigned_to <> member_id then
        return private.sharing_error('PERMISSION_DENIED');
      end if;
    end if;
  else
    has_purchase_final_field :=
      p_status is not null
      or p_actual_purchase_quantity is not null
      or coalesce(p_fields ? 'purchaseStatus', false)
      or coalesce(p_fields ? 'actualPurchaseQuantity', false)
      or coalesce(p_fields ? 'quantity', false)
      or coalesce(p_fields ? 'price', false);

    if member_role <> 'host'
       and has_purchase_final_field
       and item_row.assigned_to is not null
       and item_row.assigned_to <> member_id then
      return private.sharing_error('PERMISSION_DENIED');
    end if;

    return private.update_room_item_with_purchase_without_assignment(
      p_room_id,
      p_local_item_id,
      p_fields,
      p_status,
      p_actual_purchase_quantity,
      p_expected_field_clocks
    );
  end if;

  return private.update_room_item_with_purchase_without_assignment(
    p_room_id,
    p_local_item_id,
    p_fields,
    p_status,
    p_actual_purchase_quantity,
    p_expected_field_clocks
  );
end;
$$;

revoke all on function public.get_room_versions(uuid) from public;
revoke all on function public.get_member_route_order_by_date(uuid, text, uuid) from public;
revoke all on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb) from public;

grant execute on function public.get_room_versions(uuid) to authenticated;
grant execute on function public.get_member_route_order_by_date(uuid, text, uuid) to authenticated;
grant execute on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb) to authenticated;

create or replace function public.update_room_item_with_purchase(
  p_room_id uuid,
  p_local_item_id text,
  p_fields jsonb,
  p_status text,
  p_actual_purchase_quantity integer,
  p_expected_field_clocks jsonb
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
  target_assigned_to uuid;
  target_assigned_to_text text;
  changed_fields text[] := array['assignedTo'];
  new_version bigint;
  new_updated_at timestamptz := now();
  changed_values jsonb;
  field_updated_at jsonb;
  new_field_clocks jsonb;
  clock_status text;
  notification_id uuid;
  is_assignment_only boolean;
  has_purchase_final_field boolean;
begin
  is_assignment_only := (
    p_status is null
    and p_actual_purchase_quantity is null
    and p_fields is not null
    and jsonb_typeof(p_fields) = 'object'
    and p_fields ? 'assignedTo'
    and (select count(*) from jsonb_object_keys(p_fields)) = 1
  );

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

  select rm.role into member_role
  from public.room_members rm
  where rm.id = member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active';

  select * into item_row
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(coalesce(p_local_item_id, ''))
  for update;

  if not found or item_row.deleted_at is not null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if not is_assignment_only then
    has_purchase_final_field :=
      p_status is not null
      or p_actual_purchase_quantity is not null
      or coalesce(p_fields ? 'purchaseStatus', false)
      or coalesce(p_fields ? 'actualPurchaseQuantity', false)
      or coalesce(p_fields ? 'quantity', false)
      or coalesce(p_fields ? 'price', false);

    if member_role <> 'host'
       and has_purchase_final_field
       and item_row.assigned_to is not null
       and item_row.assigned_to <> member_id then
      return private.sharing_error('PERMISSION_DENIED');
    end if;

    return private.update_room_item_with_purchase_without_assignment(
      p_room_id,
      p_local_item_id,
      p_fields,
      p_status,
      p_actual_purchase_quantity,
      p_expected_field_clocks
    );
  end if;

  if btrim(coalesce(p_local_item_id, '')) = ''
     or p_expected_field_clocks is null
     or jsonb_typeof(p_expected_field_clocks) <> 'object' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  target_assigned_to_text := nullif(p_fields ->> 'assignedTo', '');
  if target_assigned_to_text is not null then
    if target_assigned_to_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return private.sharing_error('INVALID_REQUEST');
    end if;
    target_assigned_to := target_assigned_to_text::uuid;
  end if;

  if target_assigned_to is not null
     and not exists (
       select 1
       from public.room_members target
       where target.id = target_assigned_to
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

  if member_role <> 'host' then
    if item_row.assigned_to is not null and item_row.assigned_to <> member_id then
      return private.sharing_error('PERMISSION_DENIED');
    end if;
    if target_assigned_to is not null and target_assigned_to <> member_id then
      return private.sharing_error('PERMISSION_DENIED');
    end if;
  end if;

  if item_row.assigned_to is not distinct from target_assigned_to then
    return private.sharing_success(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', room_row.items_version,
      'changedFields', '[]'::jsonb,
      'updatedValues', '{}'::jsonb,
      'fieldUpdatedAt', '{}'::jsonb,
      'fieldClocks', '{}'::jsonb,
      'notificationId', null,
      'item', private.room_item_payload(item_row)
    ));
  end if;

  clock_status := private.v2_expected_field_clocks_status(
    item_row.field_clocks,
    p_expected_field_clocks,
    changed_fields
  );
  if clock_status = 'invalid' then
    return private.sharing_error('INVALID_REQUEST');
  elsif clock_status = 'conflict' then
    return private.sharing_error('FIELD_CLOCK_CONFLICT');
  end if;

  new_version := room_row.items_version + 1;
  field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);
  new_field_clocks := private.v2_field_clock_payload(changed_fields, new_version, new_updated_at);

  update public.rooms
  set items_version = new_version
  where id = p_room_id;

  update public.room_items
  set assigned_to = target_assigned_to,
      item_version = new_version,
      updated_by = member_id,
      updated_at = new_updated_at,
      field_clocks = coalesce(field_clocks, '{}'::jsonb) || new_field_clocks
  where id = item_row.id
  returning * into updated_item;

  changed_values := private.jsonb_keep_keys(private.room_item_payload(updated_item), changed_fields);

  insert into public.notifications(
    room_id,
    idempotency_key,
    notification_type,
    target_member_id,
    payload
  )
  values (
    p_room_id,
    'item:' || updated_item.id::text || ':assignment:v' || new_version::text,
    'item_assigned',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', updated_item.local_item_id,
      'itemsVersion', new_version,
      'updatedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'fieldClocks', new_field_clocks,
      'updatedByMemberId', member_id,
      'assignedToMemberId', target_assigned_to
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
    change_type,
    item_payload,
    field_clocks,
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
    'update',
    null,
    new_field_clocks,
    member_id,
    notification_id
  );

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'itemsVersion', new_version,
    'changedFields', to_jsonb(changed_fields),
    'updatedValues', changed_values,
    'fieldUpdatedAt', field_updated_at,
    'fieldClocks', new_field_clocks,
    'notificationId', notification_id,
    'item', private.room_item_payload(updated_item)
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

-- Redefine the combined assignment/member-route RPC with the same exclusion rules.
create or replace function public.update_room_item_assignment_with_member_routes(
  p_room_id uuid,
  p_assignment_mutations jsonb,
  p_member_route_updates jsonb
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
  assignment_mutation jsonb;
  route_update jsonb;
  plan_entry jsonb;
  mutation_plan jsonb := '[]'::jsonb;
  changed_items jsonb := '[]'::jsonb;
  changed_member_route_orders jsonb := '[]'::jsonb;
  target_local_item_id text;
  target_assigned_to uuid;
  target_assigned_to_text text;
  item_row public.room_items;
  updated_item public.room_items;
  expected_field_clocks jsonb;
  changed_fields text[] := array['assignedTo'];
  clock_status text;
  new_items_version bigint;
  current_room_route_version bigint;
  current_date_member_version bigint;
  new_date_member_version bigint;
  new_updated_at timestamptz := now();
  changed_values jsonb;
  field_updated_at jsonb;
  new_field_clocks jsonb;
  notification_id uuid;
  route_notification_id uuid;
  event_date_key text;
  target_route_member_id uuid;
  target_route_member_id_text text;
  route_item_ids text[];
  distinct_item_count integer;
  invalid_item_count integer;
  route_update_count integer := 0;
  next_event_data jsonb;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if coalesce(jsonb_typeof(p_assignment_mutations), '') <> 'array'
     or coalesce(jsonb_typeof(p_member_route_updates), '') <> 'array'
     or jsonb_array_length(p_assignment_mutations) > 100
     or jsonb_array_length(p_member_route_updates) > 100
     or (
       jsonb_array_length(p_assignment_mutations) = 0
       and jsonb_array_length(p_member_route_updates) = 0
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_assignment_mutations) entry(value)
    where jsonb_typeof(entry.value) <> 'object'
       or btrim(coalesce(entry.value ->> 'localItemId', '')) = ''
       or coalesce(jsonb_typeof(entry.value -> 'expectedFieldClocks'), '') <> 'object'
       or (
         entry.value ? 'assignedToMemberId'
         and entry.value -> 'assignedToMemberId' <> 'null'::jsonb
         and coalesce(entry.value ->> 'assignedToMemberId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if (
    select count(*) <> count(distinct btrim(value ->> 'localItemId'))
    from jsonb_array_elements(p_assignment_mutations) entry(value)
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_member_route_updates) entry(value)
    where jsonb_typeof(entry.value) <> 'object'
       or btrim(coalesce(entry.value ->> 'eventDate', '')) = ''
       or coalesce(entry.value ->> 'routeMemberId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(jsonb_typeof(entry.value -> 'itemIds'), '') <> 'array'
       or (entry.value ->> 'expectedVersion') is null
       or (entry.value ->> 'expectedVersion') !~ '^[0-9]+$'
       or exists (
         select 1
         from jsonb_array_elements_text(entry.value -> 'itemIds') item_id(value)
         where btrim(coalesce(item_id.value, '')) = ''
       )
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if (
    select count(*) <> count(distinct ((value ->> 'eventDate') || '::' || (value ->> 'routeMemberId')))
    from jsonb_array_elements(p_member_route_updates) entry(value)
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

  select rm.role into member_role
  from public.room_members rm
  where rm.id = member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active';

  select * into room_row
  from public.rooms
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at > now()
  for update;

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  for assignment_mutation in
    select value
    from jsonb_array_elements(p_assignment_mutations) entry(value)
    order by btrim(value ->> 'localItemId')
  loop
    target_local_item_id := btrim(assignment_mutation ->> 'localItemId');
    expected_field_clocks := assignment_mutation -> 'expectedFieldClocks';
    target_assigned_to_text := case
      when assignment_mutation ? 'assignedToMemberId'
           and assignment_mutation -> 'assignedToMemberId' <> 'null'::jsonb
        then nullif(assignment_mutation ->> 'assignedToMemberId', '')
      else null
    end;
    target_assigned_to := target_assigned_to_text::uuid;

    if target_assigned_to is not null
       and not exists (
         select 1
         from public.room_members target
         where target.id = target_assigned_to
           and target.room_id = p_room_id
           and target.membership_status = 'active'
       ) then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    select * into item_row
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.local_item_id = target_local_item_id
    for update;

    if not found or item_row.deleted_at is not null then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    if member_role <> 'host' then
      if item_row.assigned_to is not null and item_row.assigned_to <> member_id then
        return private.sharing_error('PERMISSION_DENIED');
      end if;
      if target_assigned_to is not null and target_assigned_to <> member_id then
        return private.sharing_error('PERMISSION_DENIED');
      end if;
    end if;

    if item_row.assigned_to is distinct from target_assigned_to then
      clock_status := private.v2_expected_field_clocks_status(
        item_row.field_clocks,
        expected_field_clocks,
        changed_fields
      );
      if clock_status = 'invalid' then
        return private.sharing_error('INVALID_REQUEST');
      elsif clock_status = 'conflict' then
        return private.sharing_error('FIELD_CLOCK_CONFLICT');
      end if;

      mutation_plan := mutation_plan || jsonb_build_array(jsonb_build_object(
        'itemId', item_row.id,
        'localItemId', item_row.local_item_id,
        'assignedTo', target_assigned_to
      ));
    end if;
  end loop;

  new_items_version := room_row.items_version;
  if jsonb_array_length(mutation_plan) > 0 then
    new_items_version := room_row.items_version + 1;
    field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);
    new_field_clocks := private.v2_field_clock_payload(changed_fields, new_items_version, new_updated_at);

    update public.rooms
    set items_version = new_items_version
    where id = p_room_id;

    for plan_entry in
      select value
      from jsonb_array_elements(mutation_plan) entry(value)
    loop
      target_assigned_to := nullif(plan_entry ->> 'assignedTo', '')::uuid;

      update public.room_items
      set assigned_to = target_assigned_to,
          item_version = new_items_version,
          updated_by = member_id,
          updated_at = new_updated_at,
          field_clocks = coalesce(field_clocks, '{}'::jsonb) || new_field_clocks
      where id = (plan_entry ->> 'itemId')::uuid
      returning * into updated_item;

      changed_values := private.jsonb_keep_keys(private.room_item_payload(updated_item), changed_fields);

      insert into public.notifications(
        room_id,
        idempotency_key,
        notification_type,
        target_member_id,
        payload
      )
      values (
        p_room_id,
        'item:' || updated_item.id::text || ':assignment_member_route:v' || new_items_version::text,
        'item_assigned',
        null,
        jsonb_build_object(
          'roomId', p_room_id,
          'localItemId', updated_item.local_item_id,
          'itemsVersion', new_items_version,
          'updatedFields', to_jsonb(changed_fields),
          'updatedValues', changed_values,
          'fieldUpdatedAt', field_updated_at,
          'fieldClocks', new_field_clocks,
          'updatedByMemberId', member_id,
          'assignedToMemberId', target_assigned_to,
          'assignmentMode', 'memberRoute'
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
        change_type,
        item_payload,
        field_clocks,
        updated_by,
        notification_id
      )
      values (
        p_room_id,
        updated_item.id,
        updated_item.local_item_id,
        new_items_version,
        changed_fields,
        changed_values,
        field_updated_at,
        'update',
        null,
        new_field_clocks,
        member_id,
        notification_id
      );

      changed_items := changed_items || jsonb_build_array(jsonb_build_object(
        'roomId', p_room_id,
        'itemsVersion', new_items_version,
        'changedFields', to_jsonb(changed_fields),
        'updatedValues', changed_values,
        'fieldUpdatedAt', field_updated_at,
        'fieldClocks', new_field_clocks,
        'notificationId', notification_id,
        'item', private.room_item_payload(updated_item)
      ));
    end loop;
  end if;

  current_room_route_version := coalesce(room_row.route_order_version, 0);

  if jsonb_array_length(p_member_route_updates) > 0 then
    select red.event_data into next_event_data
    from public.room_event_data red
    where red.room_id = p_room_id
    for update;

    if next_event_data is null then
      return private.sharing_error('ROOM_UNAVAILABLE');
    end if;
  end if;

  for route_update in
    select value
    from jsonb_array_elements(p_member_route_updates) entry(value)
    order by btrim(value ->> 'eventDate'), btrim(value ->> 'routeMemberId')
  loop
    event_date_key := btrim(route_update ->> 'eventDate');
    target_route_member_id_text := route_update ->> 'routeMemberId';
    target_route_member_id := target_route_member_id_text::uuid;
    route_item_ids := array(
      select item_id.value
      from jsonb_array_elements_text(route_update -> 'itemIds') item_id(value)
    );

    select count(distinct item_id) into distinct_item_count
    from unnest(route_item_ids) item_id;

    if distinct_item_count <> coalesce(array_length(route_item_ids, 1), 0) then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    if not private.can_update_member_route(member_id, target_route_member_id) then
      return private.sharing_error('PERMISSION_DENIED');
    end if;

    insert into public.room_member_route_order_versions(
      room_id,
      event_date,
      route_member_id,
      version,
      updated_by,
      updated_at
    )
    values (
      p_room_id,
      event_date_key,
      target_route_member_id,
      0,
      member_id,
      new_updated_at
    )
    on conflict (room_id, event_date, route_member_id) do nothing;

    select version into current_date_member_version
    from public.room_member_route_order_versions
    where room_id = p_room_id
      and event_date = event_date_key
      and route_member_id = target_route_member_id
    for update;

    current_date_member_version := coalesce(current_date_member_version, 0);
    if current_date_member_version <> (route_update ->> 'expectedVersion')::bigint then
      return private.sharing_error('ROUTE_ORDER_CONFLICT');
    end if;

    select count(*) into invalid_item_count
    from unnest(route_item_ids) item_id
    where not exists (
      select 1
      from public.room_items ri
      where ri.room_id = p_room_id
        and ri.local_item_id = item_id
        and coalesce(ri.event_date, '') = event_date_key
        and ri.deleted_at is null
        and ri.assigned_to = target_route_member_id
    );

    if invalid_item_count > 0 then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    new_date_member_version := current_date_member_version + 1;
    current_room_route_version := current_room_route_version + 1;
    route_update_count := route_update_count + 1;

    update public.room_member_route_order_versions
    set version = new_date_member_version,
        updated_by = member_id,
        updated_at = new_updated_at
    where room_id = p_room_id
      and event_date = event_date_key
      and route_member_id = target_route_member_id;

    next_event_data := jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(next_event_data, '{}'::jsonb),
          '{memberRouteItems}',
          coalesce(next_event_data -> 'memberRouteItems', '{}'::jsonb),
          true
        ),
        array['memberRouteItems', event_date_key],
        coalesce(next_event_data #> array['memberRouteItems', event_date_key], '{}'::jsonb),
        true
      ),
      array['memberRouteItems', event_date_key, target_route_member_id::text],
      to_jsonb(route_item_ids),
      true
    );

    changed_member_route_orders := changed_member_route_orders || jsonb_build_array(jsonb_build_object(
      'eventDate', event_date_key,
      'routeMemberId', target_route_member_id,
      'itemIds', to_jsonb(route_item_ids),
      'dateMemberRouteOrderVersion', new_date_member_version
    ));

    insert into public.notifications(
      room_id,
      idempotency_key,
      notification_type,
      target_member_id,
      payload
    )
    values (
      p_room_id,
      'member-route-assignment:' || p_room_id::text || ':' || event_date_key || ':' || target_route_member_id::text || ':v' || new_date_member_version::text,
      'route_order_updated',
      null,
      jsonb_build_object(
        'roomId', p_room_id,
        'eventDate', event_date_key,
        'routeMemberId', target_route_member_id,
        'itemIds', to_jsonb(route_item_ids),
        'dateMemberRouteOrderVersion', new_date_member_version,
        'routeOrderVersion', current_room_route_version,
        'updatedFields', '["memberRouteItems"]'::jsonb,
        'updatedValues', jsonb_build_object(
          'memberRouteItems',
          jsonb_build_object(
            'eventDate', event_date_key,
            'routeMemberId', target_route_member_id,
            'itemIds', to_jsonb(route_item_ids),
            'version', new_date_member_version
          )
        ),
        'fieldUpdatedAt', jsonb_build_object('memberRouteItems', new_updated_at),
        'updatedByMemberId', member_id
      )
    )
    returning id into route_notification_id;

    perform private.create_member_route_notification_delivery(route_notification_id, p_room_id, target_route_member_id);
  end loop;

  if route_update_count > 0 then
    update public.rooms
    set route_order_version = current_room_route_version
    where id = p_room_id;

    update public.room_event_data red
    set event_data = next_event_data,
        event_data_size_bytes = length(convert_to(next_event_data::text, 'UTF8'))
    where red.room_id = p_room_id;
  end if;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'itemsVersion', new_items_version,
    'changedItems', changed_items,
    'routeOrderVersion', case when route_update_count > 0 then current_room_route_version else room_row.route_order_version end,
    'memberRouteOrderVersions', private.room_member_route_order_versions_payload_for_viewer(p_room_id, member_id),
    'changedMemberRouteOrders', changed_member_route_orders
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

revoke all on function public.update_room_item_assignment_with_member_routes(uuid, jsonb, jsonb) from public;
grant execute on function public.update_room_item_assignment_with_member_routes(uuid, jsonb, jsonb) to authenticated;

-- Redefine the bulk item update RPC to block purchase finalization by non-assignees.
create or replace function public.bulk_update_room_items_with_purchase(
  p_room_id uuid,
  p_mutations jsonb
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
  mutation jsonb;
  plan_entry jsonb;
  mutation_plan jsonb := '[]'::jsonb;
  changed_items jsonb := '[]'::jsonb;
  target_local_item_id text;
  target_assigned_to uuid;
  target_assigned_to_text text;
  item_row public.room_items;
  updated_item public.room_items;
  expected_field_clocks jsonb;
  changed_fields text[] := array['assignedTo'];
  clock_status text;
  new_version bigint;
  new_updated_at timestamptz := now();
  changed_values jsonb;
  field_updated_at jsonb;
  new_field_clocks jsonb;
  notification_id uuid;
  preflight_mutation jsonb;
  preflight_fields jsonb;
  preflight_status text;
  preflight_item_row public.room_items;
  preflight_has_purchase_final_field boolean;
begin
  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) = 0
     or exists (
       select 1
       from jsonb_array_elements(p_mutations) entry(value)
       where jsonb_typeof(entry.value) <> 'object'
          or jsonb_typeof(coalesce(entry.value -> 'fields', '{}'::jsonb)) <> 'object'
          or not (coalesce(entry.value -> 'fields', '{}'::jsonb) ? 'assignedTo')
          or (
            select count(*)
            from jsonb_object_keys(coalesce(entry.value -> 'fields', '{}'::jsonb))
          ) <> 1
          or nullif(entry.value ->> 'status', '') is not null
          or (
            entry.value ? 'actualPurchaseQuantity'
            and entry.value -> 'actualPurchaseQuantity' <> 'null'::jsonb
          )
     ) then
    if auth_user_id is null then
      return private.sharing_error('AUTH_REQUIRED');
    end if;

    if p_mutations is null
       or jsonb_typeof(p_mutations) <> 'array'
       or jsonb_array_length(p_mutations) = 0
       or jsonb_array_length(p_mutations) > 100 then
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

    for preflight_mutation in
      select value
      from jsonb_array_elements(p_mutations) entry(value)
    loop
      if jsonb_typeof(preflight_mutation) <> 'object'
         or btrim(coalesce(preflight_mutation ->> 'localItemId', '')) = '' then
        return private.bulk_update_room_items_with_purchase_without_assignment(p_room_id, p_mutations);
      end if;

      preflight_fields := coalesce(preflight_mutation -> 'fields', '{}'::jsonb);
      if jsonb_typeof(preflight_fields) <> 'object' then
        return private.bulk_update_room_items_with_purchase_without_assignment(p_room_id, p_mutations);
      end if;

      preflight_status := nullif(preflight_mutation ->> 'status', '');
      preflight_has_purchase_final_field :=
        preflight_status is not null
        or (
          preflight_mutation ? 'actualPurchaseQuantity'
          and preflight_mutation -> 'actualPurchaseQuantity' <> 'null'::jsonb
        )
        or preflight_fields ? 'purchaseStatus'
        or preflight_fields ? 'actualPurchaseQuantity'
        or preflight_fields ? 'quantity'
        or preflight_fields ? 'price';

      if preflight_has_purchase_final_field then
        select * into preflight_item_row
        from public.room_items ri
        where ri.room_id = p_room_id
          and ri.local_item_id = btrim(preflight_mutation ->> 'localItemId')
        for update;

        if found
           and preflight_item_row.deleted_at is null
           and member_role <> 'host'
           and preflight_item_row.assigned_to is not null
           and preflight_item_row.assigned_to <> member_id then
          return private.sharing_error('PERMISSION_DENIED');
        end if;
      end if;
    end loop;

    return private.bulk_update_room_items_with_purchase_without_assignment(p_room_id, p_mutations);
  end if;

  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if jsonb_array_length(p_mutations) > 100 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_mutations) entry(value)
    where btrim(coalesce(entry.value ->> 'localItemId', '')) = ''
       or coalesce(jsonb_typeof(entry.value -> 'expectedFieldClocks'), '') <> 'object'
       or (
         nullif((entry.value -> 'fields') ->> 'assignedTo', '') is not null
         and nullif((entry.value -> 'fields') ->> 'assignedTo', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if (
    select count(*) <> count(distinct btrim(value ->> 'localItemId'))
    from jsonb_array_elements(p_mutations) entry(value)
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

  select rm.role into member_role
  from public.room_members rm
  where rm.id = member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active';

  select * into room_row
  from public.rooms
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at > now()
  for update;

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  for mutation in
    select value
    from jsonb_array_elements(p_mutations) entry(value)
    order by btrim(value ->> 'localItemId')
  loop
    target_local_item_id := btrim(mutation ->> 'localItemId');
    expected_field_clocks := mutation -> 'expectedFieldClocks';
    target_assigned_to_text := nullif((mutation -> 'fields') ->> 'assignedTo', '');
    target_assigned_to := target_assigned_to_text::uuid;

    if target_assigned_to is not null
       and not exists (
         select 1
         from public.room_members target
         where target.id = target_assigned_to
           and target.room_id = p_room_id
           and target.membership_status = 'active'
       ) then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    select * into item_row
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.local_item_id = target_local_item_id
    for update;

    if not found or item_row.deleted_at is not null then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    if member_role <> 'host' then
      if item_row.assigned_to is not null and item_row.assigned_to <> member_id then
        return private.sharing_error('PERMISSION_DENIED');
      end if;
      if target_assigned_to is not null and target_assigned_to <> member_id then
        return private.sharing_error('PERMISSION_DENIED');
      end if;
    end if;

    if item_row.assigned_to is distinct from target_assigned_to then
      clock_status := private.v2_expected_field_clocks_status(
        item_row.field_clocks,
        expected_field_clocks,
        changed_fields
      );
      if clock_status = 'invalid' then
        return private.sharing_error('INVALID_REQUEST');
      elsif clock_status = 'conflict' then
        return private.sharing_error('FIELD_CLOCK_CONFLICT');
      end if;

      mutation_plan := mutation_plan || jsonb_build_array(jsonb_build_object(
        'itemId', item_row.id,
        'localItemId', item_row.local_item_id,
        'assignedTo', target_assigned_to
      ));
    end if;
  end loop;

  if jsonb_array_length(mutation_plan) = 0 then
    return private.sharing_success(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', room_row.items_version,
      'changedItems', '[]'::jsonb
    ));
  end if;

  new_version := room_row.items_version + 1;

  update public.rooms
  set items_version = new_version
  where id = p_room_id;

  for plan_entry in
    select value
    from jsonb_array_elements(mutation_plan) entry(value)
  loop
    target_assigned_to := (plan_entry ->> 'assignedTo')::uuid;
    field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);
    new_field_clocks := private.v2_field_clock_payload(changed_fields, new_version, new_updated_at);

    update public.room_items
    set assigned_to = target_assigned_to,
        item_version = new_version,
        updated_by = member_id,
        updated_at = new_updated_at,
        field_clocks = coalesce(field_clocks, '{}'::jsonb) || new_field_clocks
    where id = (plan_entry ->> 'itemId')::uuid
    returning * into updated_item;

    changed_values := private.jsonb_keep_keys(private.room_item_payload(updated_item), changed_fields);

    insert into public.notifications(
      room_id,
      idempotency_key,
      notification_type,
      target_member_id,
      payload
    )
    values (
      p_room_id,
      'item:' || updated_item.id::text || ':bulk_assignment:v' || new_version::text,
      'item_assigned',
      null,
      jsonb_build_object(
        'roomId', p_room_id,
        'localItemId', updated_item.local_item_id,
        'itemsVersion', new_version,
        'updatedFields', to_jsonb(changed_fields),
        'updatedValues', changed_values,
        'fieldUpdatedAt', field_updated_at,
        'fieldClocks', new_field_clocks,
        'updatedByMemberId', member_id,
        'assignedToMemberId', target_assigned_to,
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
      change_type,
      item_payload,
      field_clocks,
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
      'update',
      null,
      new_field_clocks,
      member_id,
      notification_id
    );

    changed_items := changed_items || jsonb_build_array(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', new_version,
      'changedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'fieldClocks', new_field_clocks,
      'notificationId', notification_id,
      'item', private.room_item_payload(updated_item)
    ));
  end loop;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'itemsVersion', new_version,
    'changedItems', changed_items
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

revoke all on function public.bulk_update_room_items_with_purchase(uuid, jsonb) from public;
grant execute on function public.bulk_update_room_items_with_purchase(uuid, jsonb) to authenticated;

-- Redefine the direct member-route RPC with filtered versions and scoped delivery.
create or replace function public.update_member_route_order(
  p_room_id uuid,
  p_event_date text,
  p_route_member_id uuid,
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
  current_date_member_version bigint;
  new_date_member_version bigint;
  new_room_route_version bigint;
  notification_id uuid;
  invalid_item_count integer;
  distinct_item_count integer;
  new_updated_at timestamptz := now();
  next_event_data jsonb;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if event_date_key = ''
     or p_route_member_id is null
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

  if not private.can_update_member_route(member_id, p_route_member_id) then
    return private.sharing_error('PERMISSION_DENIED');
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

  insert into public.room_member_route_order_versions(
    room_id,
    event_date,
    route_member_id,
    version,
    updated_by,
    updated_at
  )
  values (
    p_room_id,
    event_date_key,
    p_route_member_id,
    0,
    member_id,
    new_updated_at
  )
  on conflict (room_id, event_date, route_member_id) do nothing;

  select version into current_date_member_version
  from public.room_member_route_order_versions
  where room_id = p_room_id
    and event_date = event_date_key
    and route_member_id = p_route_member_id
  for update;

  current_date_member_version := coalesce(current_date_member_version, 0);
  if current_date_member_version <> p_expected_version then
    return private.sharing_error('ROUTE_ORDER_CONFLICT');
  end if;

  select count(*) into invalid_item_count
  from unnest(route_item_ids) item_id
  where not exists (
    select 1
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.local_item_id = item_id
      and coalesce(ri.event_date, '') = event_date_key
      and ri.deleted_at is null
      and ri.assigned_to = p_route_member_id
  );

  if invalid_item_count > 0 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  new_date_member_version := current_date_member_version + 1;
  new_room_route_version := coalesce(room_row.route_order_version, 0) + 1;

  update public.room_member_route_order_versions
  set version = new_date_member_version,
      updated_by = member_id,
      updated_at = new_updated_at
  where room_id = p_room_id
    and event_date = event_date_key
    and route_member_id = p_route_member_id;

  update public.rooms
  set route_order_version = new_room_route_version
  where id = p_room_id;

  with patched_event_data as (
    select jsonb_set(
      jsonb_set(
        jsonb_set(
          coalesce(red.event_data, '{}'::jsonb),
          '{memberRouteItems}',
          coalesce(red.event_data -> 'memberRouteItems', '{}'::jsonb),
          true
        ),
        array['memberRouteItems', event_date_key],
        coalesce(red.event_data #> array['memberRouteItems', event_date_key], '{}'::jsonb),
        true
      ),
      array['memberRouteItems', event_date_key, p_route_member_id::text],
      to_jsonb(route_item_ids),
      true
    ) as value
    from public.room_event_data red
    where red.room_id = p_room_id
  )
  update public.room_event_data red
  set event_data = patched_event_data.value,
      event_data_size_bytes = length(convert_to(patched_event_data.value::text, 'UTF8'))
  from patched_event_data
  where red.room_id = p_room_id
  returning patched_event_data.value into next_event_data;

  if next_event_data is null then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  insert into public.notifications(
    room_id,
    idempotency_key,
    notification_type,
    target_member_id,
    payload
  )
  values (
    p_room_id,
    'member-route:' || p_room_id::text || ':' || event_date_key || ':' || p_route_member_id::text || ':v' || new_date_member_version::text,
    'route_order_updated',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'eventDate', event_date_key,
      'routeMemberId', p_route_member_id,
      'itemIds', to_jsonb(route_item_ids),
      'dateMemberRouteOrderVersion', new_date_member_version,
      'routeOrderVersion', new_room_route_version,
      'updatedFields', '["memberRouteItems"]'::jsonb,
      'updatedValues', jsonb_build_object(
        'memberRouteItems',
        jsonb_build_object(
          'eventDate', event_date_key,
          'routeMemberId', p_route_member_id,
          'itemIds', to_jsonb(route_item_ids),
          'version', new_date_member_version
        )
      ),
      'fieldUpdatedAt', jsonb_build_object('memberRouteItems', new_updated_at),
      'updatedByMemberId', member_id
    )
  )
  returning id into notification_id;

  perform private.create_member_route_notification_delivery(notification_id, p_room_id, p_route_member_id);

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'eventDate', event_date_key,
    'routeMemberId', p_route_member_id,
    'itemIds', to_jsonb(route_item_ids),
    'dateMemberRouteOrderVersion', new_date_member_version,
    'routeOrderVersion', new_room_route_version,
    'memberRouteOrderVersions', private.room_member_route_order_versions_payload_for_viewer(p_room_id, member_id),
    'changedMemberRouteOrders', jsonb_build_array(jsonb_build_object(
      'eventDate', event_date_key,
      'routeMemberId', p_route_member_id,
      'itemIds', to_jsonb(route_item_ids),
      'dateMemberRouteOrderVersion', new_date_member_version
    )),
    'notificationId', notification_id
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

create or replace function public.ack_room_member_route_order_versions(
  p_room_id uuid,
  p_member_route_order_versions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  stored_member_route_order_versions jsonb;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if jsonb_typeof(coalesce(p_member_route_order_versions, '{}'::jsonb)) <> 'object'
     or exists (
       select 1
       from jsonb_each(coalesce(p_member_route_order_versions, '{}'::jsonb)) event_entry(event_date, routes_by_member)
       where btrim(event_entry.event_date) = ''
          or jsonb_typeof(event_entry.routes_by_member) <> 'object'
     )
     or exists (
       select 1
       from jsonb_each(coalesce(p_member_route_order_versions, '{}'::jsonb)) event_entry(event_date, routes_by_member)
       cross join jsonb_each(
         case
           when jsonb_typeof(event_entry.routes_by_member) = 'object' then event_entry.routes_by_member
           else '{}'::jsonb
         end
       ) route_entry(route_member_id, version_value)
       where btrim(route_entry.route_member_id) = ''
          or jsonb_typeof(route_entry.version_value) <> 'number'
          or (route_entry.version_value #>> '{}')::bigint < 0
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
    from jsonb_each(coalesce(p_member_route_order_versions, '{}'::jsonb)) event_entry(event_date, routes_by_member)
    cross join jsonb_each(
      case
        when jsonb_typeof(event_entry.routes_by_member) = 'object' then event_entry.routes_by_member
        else '{}'::jsonb
      end
    ) requested(route_member_id, version_value)
    left join public.room_member_route_order_versions actual
      on actual.room_id = p_room_id
     and actual.event_date = event_entry.event_date
     and actual.route_member_id::text = requested.route_member_id
    where (requested.version_value #>> '{}')::bigint > coalesce(actual.version, 0)
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  insert into public.room_member_sync_state(
    room_member_id,
    room_id,
    member_route_order_versions
  )
  values (
    member_id,
    p_room_id,
    coalesce(p_member_route_order_versions, '{}'::jsonb)
  )
  on conflict (room_member_id) do update
    set member_route_order_versions = (
      select coalesce(jsonb_object_agg(event_versions.event_date, event_versions.routes_by_member), '{}'::jsonb)
      from (
        select member_versions.event_date,
               jsonb_object_agg(member_versions.route_member_id, member_versions.version) as routes_by_member
        from (
          select combined.event_date,
                 combined.route_member_id,
                 max(combined.version) as version
          from (
            select existing_event.key as event_date,
                   existing_route.key as route_member_id,
                   (existing_route.value #>> '{}')::bigint as version
            from jsonb_each(public.room_member_sync_state.member_route_order_versions) existing_event(key, value)
            cross join jsonb_each(
              case
                when jsonb_typeof(existing_event.value) = 'object' then existing_event.value
                else '{}'::jsonb
              end
            ) existing_route(key, value)
            where jsonb_typeof(existing_event.value) = 'object'
              and jsonb_typeof(existing_route.value) = 'number'
            union all
            select requested_event.key as event_date,
                   requested_route.key as route_member_id,
                   (requested_route.value #>> '{}')::bigint as version
            from jsonb_each(excluded.member_route_order_versions) requested_event(key, value)
            cross join jsonb_each(
              case
                when jsonb_typeof(requested_event.value) = 'object' then requested_event.value
                else '{}'::jsonb
              end
            ) requested_route(key, value)
            where jsonb_typeof(requested_event.value) = 'object'
              and jsonb_typeof(requested_route.value) = 'number'
          ) combined
          group by combined.event_date, combined.route_member_id
        ) member_versions
        group by member_versions.event_date
      ) event_versions
    )
  returning member_route_order_versions into stored_member_route_order_versions;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'memberRouteOrderVersions', coalesce(stored_member_route_order_versions, '{}'::jsonb)
  ));
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
        and tablename = 'room_member_route_order_versions'
    ) then
      alter publication supabase_realtime add table public.room_member_route_order_versions;
    end if;
  end if;
end;
$$;

revoke all on function public.get_member_route_order_by_date(uuid, text, uuid) from public;
revoke all on function public.update_member_route_order(uuid, text, uuid, text[], bigint) from public;
revoke all on function public.ack_room_member_route_order_versions(uuid, jsonb) from public;

grant execute on function public.get_member_route_order_by_date(uuid, text, uuid) to authenticated;
grant execute on function public.update_member_route_order(uuid, text, uuid, text[], bigint) to authenticated;
