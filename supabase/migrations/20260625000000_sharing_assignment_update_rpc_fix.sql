-- Fix v2 assignment writes routed through the canonical item update RPCs.
-- The previous v2 wrappers sent { assignedTo } to update_room_item_with_purchase,
-- but the SQL implementation did not include assignedTo in its changed-field set.

alter function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb)
  rename to update_room_item_with_purchase_without_assignment;

alter function public.update_room_item_with_purchase_without_assignment(uuid, text, jsonb, text, integer, jsonb)
  set schema private;

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
begin
  if not (
    p_status is null
    and p_actual_purchase_quantity is null
    and p_fields is not null
    and jsonb_typeof(p_fields) = 'object'
    and p_fields ? 'assignedTo'
    and jsonb_object_length(p_fields) = 1
  ) then
    return private.update_room_item_with_purchase_without_assignment(
      p_room_id,
      p_local_item_id,
      p_fields,
      p_status,
      p_actual_purchase_quantity,
      p_expected_field_clocks
    );
  end if;

  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
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

  select * into item_row
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(p_local_item_id)
  for update;

  if not found or item_row.deleted_at is not null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if member_role <> 'host' and item_row.assigned_to is distinct from member_id then
    return private.sharing_error('PERMISSION_DENIED');
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

revoke all on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb) from public;
grant execute on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb) to authenticated;

alter function public.bulk_update_room_items_with_purchase(uuid, jsonb)
  rename to bulk_update_room_items_with_purchase_without_assignment;

alter function public.bulk_update_room_items_with_purchase_without_assignment(uuid, jsonb)
  set schema private;

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
          or jsonb_object_length(coalesce(entry.value -> 'fields', '{}'::jsonb)) <> 1
          or nullif(entry.value ->> 'status', '') is not null
          or (
            entry.value ? 'actualPurchaseQuantity'
            and entry.value -> 'actualPurchaseQuantity' <> 'null'::jsonb
          )
     ) then
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

    if member_role <> 'host' and item_row.assigned_to is distinct from member_id then
      return private.sharing_error('PERMISSION_DENIED');
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
