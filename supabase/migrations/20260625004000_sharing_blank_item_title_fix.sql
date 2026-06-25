-- Keep intentionally blank item titles blank in sharing v2.
-- Blank titles should render as the UI fallback instead of being copied from the circle name.

create or replace function private.room_items_v2_canonical_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_fields text[] := array[]::text[];
  all_clock_fields constant text[] := array[
    'circle',
    'block',
    'number',
    'title',
    'eventDate',
    'priorityLevel',
    'protectionLevel',
    'source',
    'manualHallId',
    'purchaseStatus',
    'price',
    'quantity',
    'limitQuantity',
    'actualPurchaseQuantity',
    'remarks',
    'url',
    'assignedTo',
    'securedBy',
    'deletedAt',
    'deletedBy'
  ];
begin
  new.circle_name := coalesce(new.circle_name, '');
  new.block_name := coalesce(new.block_name, '');
  new.booth_number := coalesce(new.booth_number, '');
  new.title := coalesce(new.title, '');
  new.priority_level := coalesce(new.priority_level, 'none');
  new.postponed := new.purchase_status = 'Postpone';
  new.field_clocks := coalesce(new.field_clocks, '{}'::jsonb);

  if tg_op = 'INSERT' then
    new.name := new.title;

    if new.field_clocks = '{}'::jsonb then
      new.field_clocks := private.v2_field_clock_payload(
        all_clock_fields,
        coalesce(new.item_version, 0),
        coalesce(new.updated_at, now())
      );
    end if;

    return new;
  end if;

  if new.title is distinct from old.title and new.name is not distinct from old.name then
    new.name := new.title;
  end if;

  if new.circle_name is distinct from old.circle_name then
    changed_fields := array_append(changed_fields, 'circle');
  end if;
  if new.block_name is distinct from old.block_name then
    changed_fields := array_append(changed_fields, 'block');
  end if;
  if new.booth_number is distinct from old.booth_number then
    changed_fields := array_append(changed_fields, 'number');
  end if;
  if new.title is distinct from old.title then
    changed_fields := array_append(changed_fields, 'title');
  end if;
  if new.event_date is distinct from old.event_date then
    changed_fields := array_append(changed_fields, 'eventDate');
  end if;
  if new.priority_level is distinct from old.priority_level then
    changed_fields := array_append(changed_fields, 'priorityLevel');
  end if;
  if new.protection_level is distinct from old.protection_level then
    changed_fields := array_append(changed_fields, 'protectionLevel');
  end if;
  if new.source is distinct from old.source then
    changed_fields := array_append(changed_fields, 'source');
  end if;
  if new.manual_hall_id is distinct from old.manual_hall_id then
    changed_fields := array_append(changed_fields, 'manualHallId');
  end if;
  if new.purchase_status is distinct from old.purchase_status then
    changed_fields := array_append(changed_fields, 'purchaseStatus');
  end if;
  if new.price is distinct from old.price then
    changed_fields := array_append(changed_fields, 'price');
  end if;
  if new.quantity is distinct from old.quantity then
    changed_fields := array_append(changed_fields, 'quantity');
  end if;
  if new.limit_quantity is distinct from old.limit_quantity then
    changed_fields := array_append(changed_fields, 'limitQuantity');
  end if;
  if new.actual_purchase_quantity is distinct from old.actual_purchase_quantity then
    changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
  end if;
  if new.remarks is distinct from old.remarks then
    changed_fields := array_append(changed_fields, 'remarks');
  end if;
  if new.url is distinct from old.url then
    changed_fields := array_append(changed_fields, 'url');
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    changed_fields := array_append(changed_fields, 'assignedTo');
  end if;
  if new.secured_by is distinct from old.secured_by then
    changed_fields := array_append(changed_fields, 'securedBy');
  end if;
  if new.deleted_at is distinct from old.deleted_at then
    changed_fields := array_append(changed_fields, 'deletedAt');
  end if;
  if new.deleted_by is distinct from old.deleted_by then
    changed_fields := array_append(changed_fields, 'deletedBy');
  end if;

  if array_length(changed_fields, 1) is not null
     and new.item_version is distinct from old.item_version then
    new.field_clocks := new.field_clocks || private.v2_field_clock_payload(
      changed_fields,
      new.item_version,
      coalesce(new.updated_at, now())
    );
  end if;

  return new;
end;
$$;

create or replace function public.upsert_room_item_with_route(
  p_room_id uuid,
  p_local_item_id text,
  p_fields jsonb,
  p_route_updates jsonb,
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
  room_row public.rooms;
  existing_item public.room_items;
  inserted_item public.room_items;
  route_update jsonb;
  route_update_count integer;
  route_event_date text;
  route_item_ids text[];
  current_route_item_ids text[];
  expected_route_member_ids text[];
  expected_route_version bigint;
  current_route_version bigint;
  new_route_version bigint;
  new_room_route_version bigint;
  event_date_value text;
  title_value text;
  purchase_status_value text;
  actual_purchase_quantity_value integer;
  secured_by_value uuid;
  assigned_to_value uuid;
  final_event_date text;
  final_title text;
  final_circle text;
  final_block text;
  final_number text;
  final_priority_level text;
  final_protection_level text;
  final_source text;
  final_manual_hall_id text;
  update_changed_fields text[];
  clock_status text;
  changed_fields text[] := array[
    'circle',
    'block',
    'number',
    'title',
    'eventDate',
    'priorityLevel',
    'protectionLevel',
    'source',
    'manualHallId',
    'purchaseStatus',
    'price',
    'quantity',
    'limitQuantity',
    'actualPurchaseQuantity',
    'remarks',
    'url',
    'assignedTo',
    'securedBy',
    'deletedAt',
    'deletedBy'
  ];
  new_version bigint;
  new_updated_at timestamptz := now();
  changed_values jsonb;
  field_updated_at jsonb;
  new_field_clocks jsonb;
  item_notification_id uuid;
  route_notification_id uuid;
  route_detach_for_date_move boolean := false;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if btrim(coalesce(p_local_item_id, '')) = ''
     or p_fields is null
     or jsonb_typeof(p_fields) <> 'object'
     or p_route_updates is null
     or jsonb_typeof(p_route_updates) <> 'array'
     or p_expected_field_clocks is null
     or jsonb_typeof(p_expected_field_clocks) <> 'object' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'orderIndex'
     or p_fields ? 'postponed'
     or p_fields ? 'deletedAt'
     or p_fields ? 'deletedBy'
     or p_fields ? 'securedBy' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  route_update_count := jsonb_array_length(p_route_updates);
  if route_update_count > 1 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  event_date_value := nullif(btrim(coalesce(p_fields ->> 'eventDate', '')), '');
  title_value := btrim(coalesce(p_fields ->> 'title', ''));
  purchase_status_value := coalesce(nullif(p_fields ->> 'purchaseStatus', ''), 'None');

  if purchase_status_value not in ('None', 'SoldOut', 'Absent', 'Postpone', 'Late')
     or (p_fields ? 'actualPurchaseQuantity' and p_fields -> 'actualPurchaseQuantity' <> 'null'::jsonb) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'price'
     and p_fields -> 'price' <> 'null'::jsonb
     and (jsonb_typeof(p_fields -> 'price') <> 'number' or (p_fields ->> 'price')::numeric < 0) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'quantity'
     and p_fields -> 'quantity' <> 'null'::jsonb
     and (jsonb_typeof(p_fields -> 'quantity') <> 'number' or (p_fields ->> 'quantity')::integer < 0) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'limitQuantity'
     and p_fields -> 'limitQuantity' <> 'null'::jsonb
     and (jsonb_typeof(p_fields -> 'limitQuantity') <> 'number' or (p_fields ->> 'limitQuantity')::integer < 0) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'priorityLevel'
     and p_fields -> 'priorityLevel' <> 'null'::jsonb
     and p_fields ->> 'priorityLevel' not in ('none', 'priority', 'highest') then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'protectionLevel'
     and p_fields -> 'protectionLevel' <> 'null'::jsonb
     and p_fields ->> 'protectionLevel' not in ('full', 'deletable', 'none') then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'source'
     and p_fields -> 'source' <> 'null'::jsonb
     and p_fields ->> 'source' not in ('spreadsheet', 'app') then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'assignedTo' and p_fields -> 'assignedTo' <> 'null'::jsonb then
    begin
      assigned_to_value := (p_fields ->> 'assignedTo')::uuid;
    exception
      when others then
        return private.sharing_error('INVALID_REQUEST');
    end;
  end if;

  if route_update_count = 1 then
    route_update := p_route_updates -> 0;
    if jsonb_typeof(route_update) <> 'object'
       or jsonb_typeof(route_update -> 'itemIds') <> 'array'
       or jsonb_typeof(route_update -> 'expectedVersion') <> 'number' then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    route_event_date := btrim(coalesce(route_update ->> 'eventDate', ''));
    expected_route_version := (route_update ->> 'expectedVersion')::bigint;

    if route_event_date = ''
       or expected_route_version < 0 then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    select coalesce(array_agg(value order by ordinality), array[]::text[])
      into route_item_ids
    from jsonb_array_elements_text(route_update -> 'itemIds') with ordinality as entry(value, ordinality);

    if exists (
      select 1
      from unnest(route_item_ids) item_id
      where item_id is null or btrim(item_id) = ''
    ) then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    if (
      select count(distinct item_id)
      from unnest(route_item_ids) item_id
    ) <> coalesce(array_length(route_item_ids, 1), 0) then
      return private.sharing_error('INVALID_REQUEST');
    end if;
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

  if assigned_to_value is not null and not exists (
    select 1
    from public.room_members rm
    where rm.id = assigned_to_value
      and rm.room_id = p_room_id
      and rm.membership_status = 'active'
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select * into existing_item
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(p_local_item_id)
  for update;

  if found then
    if existing_item.deleted_at is not null then
      return private.sharing_error('FULL_ITEM_REFRESH_REQUIRED');
    end if;

    if p_fields ? 'purchaseStatus'
       or p_fields ? 'price'
       or p_fields ? 'quantity'
       or p_fields ? 'limitQuantity'
       or p_fields ? 'actualPurchaseQuantity'
       or p_fields ? 'remarks'
       or p_fields ? 'url'
       or p_fields ? 'assignedTo'
       or p_fields ? 'securedBy'
       or p_fields ? 'deletedAt'
       or p_fields ? 'deletedBy'
       or p_fields ? 'orderIndex'
       or p_fields ? 'postponed' then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    final_event_date := case
      when p_fields ? 'eventDate' then event_date_value
      else existing_item.event_date
    end;
    final_title := case
      when p_fields ? 'title' then title_value
      else existing_item.title
    end;
    final_circle := case
      when p_fields ? 'circle' then coalesce(p_fields ->> 'circle', '')
      else existing_item.circle_name
    end;
    final_block := case
      when p_fields ? 'block' then coalesce(p_fields ->> 'block', '')
      else existing_item.block_name
    end;
    final_number := case
      when p_fields ? 'number' then coalesce(p_fields ->> 'number', '')
      else existing_item.booth_number
    end;
    final_priority_level := case
      when p_fields ? 'priorityLevel' then coalesce(nullif(p_fields ->> 'priorityLevel', ''), 'none')
      else existing_item.priority_level
    end;
    final_protection_level := case
      when p_fields ? 'protectionLevel' then nullif(p_fields ->> 'protectionLevel', 'null')
      else existing_item.protection_level
    end;
    final_source := case
      when p_fields ? 'source' then nullif(p_fields ->> 'source', 'null')
      else existing_item.source
    end;
    final_manual_hall_id := case
      when p_fields ? 'manualHallId' then nullif(p_fields ->> 'manualHallId', 'null')
      else existing_item.manual_hall_id
    end;


    route_detach_for_date_move :=
      existing_item.order_index is not null
      and existing_item.event_date is distinct from final_event_date;

    if route_update_count <> 0 and not route_detach_for_date_move then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    if route_detach_for_date_move then
      if route_update_count <> 1
         or route_event_date <> coalesce(existing_item.event_date, '')
         or btrim(p_local_item_id) = any(route_item_ids) then
        return private.sharing_error('INVALID_REQUEST');
      end if;

      insert into public.room_route_order_versions(
        room_id,
        event_date,
        version,
        updated_by,
        updated_at
      )
      values (
        p_room_id,
        route_event_date,
        0,
        member_id,
        new_updated_at
      )
      on conflict (room_id, event_date) do nothing;

      select version into current_route_version
      from public.room_route_order_versions
      where room_id = p_room_id
        and event_date = route_event_date
      for update;

      current_route_version := coalesce(current_route_version, 0);
      if current_route_version <> expected_route_version then
        return private.sharing_error('ROUTE_ORDER_CONFLICT');
      end if;

      select coalesce(array_agg(ri.local_item_id order by ri.order_index, ri.local_item_id), array[]::text[])
        into current_route_item_ids
      from public.room_items ri
      where ri.room_id = p_room_id
        and coalesce(ri.event_date, '') = route_event_date
        and ri.deleted_at is null
        and ri.order_index is not null;

      if not (btrim(p_local_item_id) = any(current_route_item_ids)) then
        return private.sharing_error('INVALID_REQUEST');
      end if;

      select coalesce(array_agg(item_id order by ordinality), array[]::text[])
        into expected_route_member_ids
      from unnest(current_route_item_ids) with ordinality as current_item(item_id, ordinality)
      where item_id <> btrim(p_local_item_id);

      if route_item_ids is distinct from expected_route_member_ids then
        return private.sharing_error('INVALID_REQUEST');
      end if;
    elsif existing_item.order_index is not null
       and existing_item.event_date is distinct from final_event_date then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    select coalesce(array_agg(field_name order by ordinality), array[]::text[])
      into update_changed_fields
    from unnest(array[
      'circle',
      'block',
      'number',
      'title',
      'eventDate',
      'priorityLevel',
      'protectionLevel',
      'source',
      'manualHallId'
    ]) with ordinality as changed(field_name, ordinality)
    where (
      changed.field_name = 'circle' and existing_item.circle_name is distinct from final_circle
    ) or (
      changed.field_name = 'block' and existing_item.block_name is distinct from final_block
    ) or (
      changed.field_name = 'number' and existing_item.booth_number is distinct from final_number
    ) or (
      changed.field_name = 'title' and existing_item.title is distinct from final_title
    ) or (
      changed.field_name = 'eventDate' and existing_item.event_date is distinct from final_event_date
    ) or (
      changed.field_name = 'priorityLevel' and existing_item.priority_level is distinct from final_priority_level
    ) or (
      changed.field_name = 'protectionLevel' and existing_item.protection_level is distinct from final_protection_level
    ) or (
      changed.field_name = 'source' and existing_item.source is distinct from final_source
    ) or (
      changed.field_name = 'manualHallId' and existing_item.manual_hall_id is distinct from final_manual_hall_id
    );

    if coalesce(array_length(update_changed_fields, 1), 0) = 0 then
      if p_expected_field_clocks <> '{}'::jsonb then
        return private.sharing_error('INVALID_REQUEST');
      end if;

      return private.sharing_success(jsonb_build_object(
        'roomId', p_room_id,
        'itemsVersion', room_row.items_version,
        'changedFields', '[]'::jsonb,
        'updatedValues', '{}'::jsonb,
        'fieldUpdatedAt', '{}'::jsonb,
        'fieldClocks', '{}'::jsonb,
        'notificationId', null,
        'itemNotificationId', null,
        'routeNotificationId', null,
        'routeOrderVersion', null,
        'routeOrderVersions', private.room_route_order_versions_payload(p_room_id),
        'changedRouteOrders', '[]'::jsonb,
        'item', private.room_item_payload(existing_item)
      ));
    end if;

    clock_status := private.v2_expected_field_clocks_status(
      existing_item.field_clocks,
      p_expected_field_clocks,
      update_changed_fields
    );
    if clock_status = 'missing' then
      return private.sharing_error('INVALID_REQUEST');
    end if;
    if clock_status = 'conflict' then
      return private.sharing_error('FIELD_CLOCK_CONFLICT');
    end if;

    new_version := room_row.items_version + 1;
    field_updated_at := private.field_timestamp_payload(update_changed_fields, new_updated_at);
    new_field_clocks := private.v2_field_clock_payload(update_changed_fields, new_version, new_updated_at);

    if route_detach_for_date_move then
      new_route_version := current_route_version + 1;
      new_room_route_version := coalesce(room_row.route_order_version, 0) + 1;
    end if;

    update public.rooms
    set items_version = new_version,
        route_order_version = case
          when route_detach_for_date_move then new_room_route_version
          else route_order_version
        end
    where id = p_room_id;

    update public.room_items
    set event_date = final_event_date,
        name = final_title,
        circle_name = final_circle,
        block_name = final_block,
        booth_number = final_number,
        title = final_title,
        priority_level = final_priority_level,
        protection_level = final_protection_level,
        source = final_source,
        manual_hall_id = final_manual_hall_id,
        order_index = case when route_detach_for_date_move then null else order_index end,
        item_version = new_version,
        updated_by = member_id,
        updated_at = new_updated_at,
        field_clocks = coalesce(field_clocks, '{}'::jsonb) || new_field_clocks
    where id = existing_item.id
    returning * into inserted_item;

    with next_event_data as (
      select jsonb_set(
        red.event_data,
        array['itemSnapshots', inserted_item.local_item_id],
        jsonb_build_object(
          'circle', inserted_item.circle_name,
          'block', inserted_item.block_name,
          'number', inserted_item.booth_number,
          'title', inserted_item.title,
          'eventDate', inserted_item.event_date,
          'priorityLevel', inserted_item.priority_level,
          'protectionLevel', inserted_item.protection_level,
          'source', inserted_item.source,
          'manualHallId', inserted_item.manual_hall_id
        ),
        true
      ) as value
      from public.room_event_data red
      where red.room_id = p_room_id
    )
    update public.room_event_data red
    set event_data = next_event_data.value,
        event_data_size_bytes = length(convert_to(next_event_data.value::text, 'UTF8'))
    from next_event_data
    where red.room_id = p_room_id;

    changed_values := private.jsonb_keep_keys(private.room_item_payload(inserted_item), update_changed_fields);

    if route_detach_for_date_move then
      update public.room_route_order_versions
      set version = new_route_version,
          updated_by = member_id,
          updated_at = new_updated_at
      where room_id = p_room_id
        and event_date = route_event_date;

      with next_event_data as (
        select jsonb_set(
          red.event_data,
          array['routeOrderByDate', route_event_date],
          to_jsonb(route_item_ids),
          true
        ) as value
        from public.room_event_data red
        where red.room_id = p_room_id
      )
      update public.room_event_data red
      set event_data = next_event_data.value,
          event_data_size_bytes = length(convert_to(next_event_data.value::text, 'UTF8'))
      from next_event_data
      where red.room_id = p_room_id;

      update public.room_items ri
      set order_index = ordered.ordinality - 1,
          updated_by = member_id
      from unnest(route_item_ids) with ordinality as ordered(local_item_id, ordinality)
      where ri.room_id = p_room_id
        and ri.local_item_id = ordered.local_item_id
        and coalesce(ri.event_date, '') = route_event_date
        and ri.deleted_at is null;

      insert into public.notifications(
        room_id,
        idempotency_key,
        notification_type,
        target_member_id,
        payload
      )
      values (
        p_room_id,
        'route:' || p_room_id::text || ':' || route_event_date || ':v' || new_route_version::text,
        'route_order_updated',
        null,
        jsonb_build_object(
          'roomId', p_room_id,
          'eventDate', route_event_date,
          'itemIds', to_jsonb(route_item_ids),
          'dateRouteOrderVersion', new_route_version,
          'routeOrderVersion', new_room_route_version,
          'updatedFields', '["routeOrderByDate"]'::jsonb,
          'updatedValues', jsonb_build_object(
            'routeOrderByDate',
            jsonb_build_object(
              'eventDate', route_event_date,
              'itemIds', to_jsonb(route_item_ids),
              'version', new_route_version
            )
          ),
          'fieldUpdatedAt', jsonb_build_object('routeOrderByDate', new_updated_at),
          'updatedByMemberId', member_id
        )
      )
      returning id into route_notification_id;

      perform private.create_room_notification_delivery(route_notification_id, p_room_id);
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
      'item:' || inserted_item.id::text || ':update:v' || new_version::text,
      'item_fields_updated',
      null,
      jsonb_build_object(
        'roomId', p_room_id,
        'localItemId', inserted_item.local_item_id,
        'itemsVersion', new_version,
        'updatedFields', to_jsonb(update_changed_fields),
        'updatedValues', changed_values,
        'fieldUpdatedAt', field_updated_at,
        'fieldClocks', new_field_clocks,
        'updatedByMemberId', member_id
      )
    )
    returning id into item_notification_id;

    perform private.create_room_notification_delivery(item_notification_id, p_room_id);

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
      inserted_item.id,
      inserted_item.local_item_id,
      new_version,
      update_changed_fields,
      changed_values,
      field_updated_at,
      'update',
      null,
      new_field_clocks,
      member_id,
      item_notification_id
    );

    return private.sharing_success(jsonb_build_object(
      'roomId', p_room_id,
      'itemsVersion', new_version,
      'changedFields', to_jsonb(update_changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'fieldClocks', new_field_clocks,
      'notificationId', item_notification_id,
      'itemNotificationId', item_notification_id,
      'routeNotificationId', route_notification_id,
      'routeOrderVersion', case when route_detach_for_date_move then new_room_route_version else null end,
      'routeOrderVersions', private.room_route_order_versions_payload(p_room_id),
      'changedRouteOrders', case
        when route_detach_for_date_move then jsonb_build_array(jsonb_build_object(
          'eventDate', route_event_date,
          'itemIds', to_jsonb(route_item_ids),
          'dateRouteOrderVersion', new_route_version
        ))
        else '[]'::jsonb
      end,
      'item', private.room_item_payload(inserted_item)
    ));
  end if;

  if p_expected_field_clocks <> '{}'::jsonb then
    return private.sharing_error('INVALID_REQUEST');
  end if;


  if (
    select count(*)
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.deleted_at is null
  ) >= (select max_room_items from private.get_sharing_runtime_config()) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if route_update_count = 1 then
    if event_date_value is distinct from route_event_date
       or not (btrim(p_local_item_id) = any(route_item_ids)) then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    insert into public.room_route_order_versions(
      room_id,
      event_date,
      version,
      updated_by,
      updated_at
    )
    values (
      p_room_id,
      route_event_date,
      0,
      member_id,
      new_updated_at
    )
    on conflict (room_id, event_date) do nothing;

    select version into current_route_version
    from public.room_route_order_versions
    where room_id = p_room_id
      and event_date = route_event_date
    for update;

    current_route_version := coalesce(current_route_version, 0);
    if current_route_version <> expected_route_version then
      return private.sharing_error('ROUTE_ORDER_CONFLICT');
    end if;

    select coalesce(array_agg(ri.local_item_id order by ri.order_index, ri.local_item_id), array[]::text[])
      into current_route_item_ids
    from public.room_items ri
    where ri.room_id = p_room_id
      and coalesce(ri.event_date, '') = route_event_date
      and ri.deleted_at is null
      and ri.order_index is not null;

    select coalesce(array_agg(item_id order by item_id), array[]::text[])
      into expected_route_member_ids
    from unnest(current_route_item_ids || btrim(p_local_item_id)) item_id;

    if (
      select coalesce(array_agg(item_id order by item_id), array[]::text[])
      from unnest(route_item_ids) item_id
    ) is distinct from expected_route_member_ids then
      return private.sharing_error('INVALID_REQUEST');
    end if;
  else
    if exists (
      select 1
      from public.room_items ri
      where ri.room_id = p_room_id
        and ri.local_item_id = btrim(p_local_item_id)
    ) then
      return private.sharing_error('INVALID_REQUEST');
    end if;
  end if;

  actual_purchase_quantity_value := null;
  secured_by_value := null;
  new_version := room_row.items_version + 1;
  field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);
  new_field_clocks := private.v2_field_clock_payload(changed_fields, new_version, new_updated_at);

  if route_update_count = 1 then
    new_route_version := current_route_version + 1;
    new_room_route_version := coalesce(room_row.route_order_version, 0) + 1;
  end if;

  update public.rooms
  set items_version = new_version,
      route_order_version = case
        when route_update_count = 1 then new_room_route_version
        else route_order_version
      end
  where id = p_room_id;

  insert into public.room_items(
    room_id,
    local_item_id,
    event_date,
    name,
    circle_name,
    block_name,
    booth_number,
    title,
    priority_level,
    protection_level,
    source,
    manual_hall_id,
    purchase_status,
    price,
    quantity,
    limit_quantity,
    actual_purchase_quantity,
    remarks,
    url,
    assigned_to,
    secured_by,
    order_index,
    postponed,
    item_version,
    updated_by,
    updated_at,
    field_clocks
  )
  values (
    p_room_id,
    btrim(p_local_item_id),
    event_date_value,
    title_value,
    coalesce(p_fields ->> 'circle', ''),
    coalesce(p_fields ->> 'block', ''),
    coalesce(p_fields ->> 'number', ''),
    title_value,
    coalesce(nullif(p_fields ->> 'priorityLevel', ''), 'none'),
    nullif(p_fields ->> 'protectionLevel', 'null'),
    nullif(p_fields ->> 'source', 'null'),
    nullif(p_fields ->> 'manualHallId', 'null'),
    purchase_status_value,
    case when p_fields ? 'price' then nullif(p_fields ->> 'price', 'null')::numeric else null end,
    case when p_fields ? 'quantity' then nullif(p_fields ->> 'quantity', 'null')::integer else null end,
    case when p_fields ? 'limitQuantity' then nullif(p_fields ->> 'limitQuantity', 'null')::integer else null end,
    actual_purchase_quantity_value,
    nullif(p_fields ->> 'remarks', 'null'),
    nullif(p_fields ->> 'url', 'null'),
    assigned_to_value,
    secured_by_value,
    null,
    purchase_status_value = 'Postpone',
    new_version,
    member_id,
    new_updated_at,
    new_field_clocks
  )
  returning * into inserted_item;

  if route_update_count = 1 then
    update public.room_route_order_versions
    set version = new_route_version,
        updated_by = member_id,
        updated_at = new_updated_at
    where room_id = p_room_id
      and event_date = route_event_date;

    with next_event_data as (
      select jsonb_set(
        red.event_data,
        array['routeOrderByDate', route_event_date],
        to_jsonb(route_item_ids),
        true
      ) as value
      from public.room_event_data red
      where red.room_id = p_room_id
    )
    update public.room_event_data red
    set event_data = next_event_data.value,
        event_data_size_bytes = length(convert_to(next_event_data.value::text, 'UTF8'))
    from next_event_data
    where red.room_id = p_room_id;

    update public.room_items ri
    set order_index = ordered.ordinality - 1,
        updated_by = member_id
    from unnest(route_item_ids) with ordinality as ordered(local_item_id, ordinality)
    where ri.room_id = p_room_id
      and ri.local_item_id = ordered.local_item_id
      and coalesce(ri.event_date, '') = route_event_date
      and ri.deleted_at is null;

    select * into inserted_item
    from public.room_items
    where room_id = p_room_id
      and local_item_id = btrim(p_local_item_id);
  end if;

  with next_event_data as (
    select jsonb_set(
      red.event_data,
      array['itemSnapshots', inserted_item.local_item_id],
      jsonb_build_object(
        'circle', inserted_item.circle_name,
        'block', inserted_item.block_name,
        'number', inserted_item.booth_number,
        'title', inserted_item.title,
        'eventDate', inserted_item.event_date,
        'priorityLevel', inserted_item.priority_level,
        'protectionLevel', inserted_item.protection_level,
        'source', inserted_item.source,
        'manualHallId', inserted_item.manual_hall_id
      ),
      true
    ) as value
    from public.room_event_data red
    where red.room_id = p_room_id
  )
  update public.room_event_data red
  set event_data = next_event_data.value,
      event_data_size_bytes = length(convert_to(next_event_data.value::text, 'UTF8'))
  from next_event_data
  where red.room_id = p_room_id;

  changed_values := private.jsonb_keep_keys(private.room_item_payload(inserted_item), changed_fields);

  insert into public.notifications(
    room_id,
    idempotency_key,
    notification_type,
    target_member_id,
    payload
  )
  values (
    p_room_id,
    'item:' || inserted_item.id::text || ':create:v' || new_version::text,
    'item_created',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', inserted_item.local_item_id,
      'itemsVersion', new_version,
      'updatedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'fieldClocks', new_field_clocks,
      'updatedByMemberId', member_id
    )
  )
  returning id into item_notification_id;

  perform private.create_room_notification_delivery(item_notification_id, p_room_id);

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
    inserted_item.id,
    inserted_item.local_item_id,
    new_version,
    changed_fields,
    changed_values,
    field_updated_at,
    'create',
    private.room_item_payload(inserted_item),
    new_field_clocks,
    member_id,
    item_notification_id
  );

  if route_update_count = 1 then
    insert into public.notifications(
      room_id,
      idempotency_key,
      notification_type,
      target_member_id,
      payload
    )
    values (
      p_room_id,
      'route:' || p_room_id::text || ':' || route_event_date || ':v' || new_route_version::text,
      'route_order_updated',
      null,
      jsonb_build_object(
        'roomId', p_room_id,
        'eventDate', route_event_date,
        'itemIds', to_jsonb(route_item_ids),
        'dateRouteOrderVersion', new_route_version,
        'routeOrderVersion', new_room_route_version,
        'updatedFields', '["routeOrderByDate"]'::jsonb,
        'updatedValues', jsonb_build_object(
          'routeOrderByDate',
          jsonb_build_object(
            'eventDate', route_event_date,
            'itemIds', to_jsonb(route_item_ids),
            'version', new_route_version
          )
        ),
        'fieldUpdatedAt', jsonb_build_object('routeOrderByDate', new_updated_at),
        'updatedByMemberId', member_id
      )
    )
    returning id into route_notification_id;

    perform private.create_room_notification_delivery(route_notification_id, p_room_id);
  end if;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'itemsVersion', new_version,
    'changedFields', to_jsonb(changed_fields),
    'updatedValues', changed_values,
    'fieldUpdatedAt', field_updated_at,
    'fieldClocks', new_field_clocks,
    'notificationId', item_notification_id,
    'itemNotificationId', item_notification_id,
    'routeNotificationId', route_notification_id,
    'routeOrderVersion', case when route_update_count = 1 then new_room_route_version else null end,
    'routeOrderVersions', private.room_route_order_versions_payload(p_room_id),
    'changedRouteOrders', case
      when route_update_count = 1 then jsonb_build_array(jsonb_build_object(
        'eventDate', route_event_date,
        'itemIds', to_jsonb(route_item_ids),
        'dateRouteOrderVersion', new_route_version
      ))
      else '[]'::jsonb
    end,
    'item', private.room_item_payload(inserted_item)
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

do $$
declare
  repair record;
  repair_fields text[] := array['title'];
  new_version bigint;
  new_updated_at timestamptz;
  new_field_clocks jsonb;
  field_updated_at jsonb;
  updated_item public.room_items;
begin
  for repair in
    select ri.*
    from public.room_items ri
    join public.room_event_data red on red.room_id = ri.room_id
    where ri.deleted_at is null
      and nullif(btrim(coalesce(red.event_data #>> array['itemSnapshots', ri.local_item_id, 'title'], '')), '') is null
      and btrim(coalesce(ri.title, '')) <> ''
      and btrim(coalesce(ri.title, '')) = btrim(coalesce(ri.circle_name, ''))
  loop
    new_updated_at := now();

    update public.rooms
    set items_version = items_version + 1
    where id = repair.room_id
    returning items_version into new_version;

    field_updated_at := private.field_timestamp_payload(repair_fields, new_updated_at);
    new_field_clocks := private.v2_field_clock_payload(repair_fields, new_version, new_updated_at);

    update public.room_items
    set title = '',
        name = '',
        item_version = new_version,
        updated_at = new_updated_at,
        field_clocks = coalesce(field_clocks, '{}'::jsonb) || new_field_clocks
    where id = repair.id
    returning * into updated_item;

    update public.room_event_data red
    set event_data = jsonb_set(
          red.event_data,
          array['itemSnapshots', repair.local_item_id, 'title'],
          '""'::jsonb,
          true
        ),
        event_data_size_bytes = length(convert_to(jsonb_set(
          red.event_data,
          array['itemSnapshots', repair.local_item_id, 'title'],
          '""'::jsonb,
          true
        )::text, 'UTF8'))
    where red.room_id = repair.room_id;

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
      repair.room_id,
      updated_item.id,
      updated_item.local_item_id,
      new_version,
      repair_fields,
      private.jsonb_keep_keys(private.room_item_payload(updated_item), repair_fields),
      field_updated_at,
      'update',
      null,
      new_field_clocks,
      null,
      null
    );
  end loop;
end;
$$;

revoke all on function public.upsert_room_item_with_route(uuid, text, jsonb, jsonb, jsonb) from public;
grant execute on function public.upsert_room_item_with_route(uuid, text, jsonb, jsonb, jsonb) to authenticated;
