-- [MVP-1] Item mutation, item catch-up, and minimal notification delivery.

create table public.room_item_change_log (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  room_item_id uuid not null references public.room_items(id) on delete cascade,
  local_item_id text not null,
  items_version bigint not null check (items_version > 0),
  changed_fields text[] not null check (array_length(changed_fields, 1) > 0),
  changed_values jsonb not null default '{}'::jsonb,
  field_updated_at jsonb not null default '{}'::jsonb,
  updated_by uuid references public.room_members(id) on delete set null,
  notification_id uuid references public.notifications(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (room_id, items_version),
  check (jsonb_typeof(changed_values) = 'object'),
  check (jsonb_typeof(field_updated_at) = 'object')
);

create index room_item_change_log_room_version_idx
  on public.room_item_change_log(room_id, items_version);

create index room_item_change_log_item_version_idx
  on public.room_item_change_log(room_item_id, items_version);

create table public.notification_delivery_state (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  room_member_id uuid not null references public.room_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (notification_id, room_member_id)
);

create index notification_delivery_state_member_room_idx
  on public.notification_delivery_state(room_member_id, room_id, created_at, notification_id);

alter table public.room_item_change_log enable row level security;
alter table public.notification_delivery_state enable row level security;

revoke all on table public.room_item_change_log from anon, authenticated;
revoke all on table public.notification_delivery_state from anon, authenticated;

create or replace function private.room_item_payload(p_item public.room_items)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_item.id,
    'localItemId', p_item.local_item_id,
    'eventDate', p_item.event_date,
    'name', p_item.name,
    'purchaseStatus', p_item.purchase_status,
    'price', p_item.price,
    'quantity', p_item.quantity,
    'limitQuantity', p_item.limit_quantity,
    'actualPurchaseQuantity', p_item.actual_purchase_quantity,
    'remarks', p_item.remarks,
    'url', p_item.url,
    'assignedTo', p_item.assigned_to,
    'securedBy', p_item.secured_by,
    'orderIndex', p_item.order_index,
    'postponed', p_item.postponed,
    'itemVersion', p_item.item_version,
    'updatedAt', p_item.updated_at
  );
$$;

create or replace function private.jsonb_keep_keys(
  p_source jsonb,
  p_keys text[]
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
  from jsonb_each(coalesce(p_source, '{}'::jsonb)) entry
  where entry.key = any(p_keys);
$$;

create or replace function private.field_timestamp_payload(
  p_fields text[],
  p_updated_at timestamptz
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(field_name, to_jsonb(p_updated_at)),
    '{}'::jsonb
  )
  from unnest(p_fields) field_name;
$$;

create or replace function private.create_room_notification_delivery(
  p_notification_id uuid,
  p_room_id uuid
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
  where rm.room_id = p_room_id
    and rm.membership_status = 'active'
  on conflict do nothing;
$$;

create or replace function private.create_member_notification_delivery(
  p_notification_id uuid,
  p_room_id uuid,
  p_room_member_id uuid
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
  values (
    p_notification_id,
    p_room_id,
    p_room_member_id
  )
  on conflict do nothing;
$$;

create or replace function private.current_member_has_notification_delivery(
  p_room_id uuid,
  p_notification_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.notification_delivery_state ds
    where ds.room_id = p_room_id
      and ds.notification_id = p_notification_id
      and ds.room_member_id = private.current_room_member_id(p_room_id)
  );
$$;

create or replace function public.can_select_room_sync_rows(p_room_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
    from public.room_members rm
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
      and rm.membership_status = 'active'
  );
end;
$$;

create or replace function public.can_select_room_notification(
  p_room_id uuid,
  p_notification_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_member_id uuid;
begin
  select rm.id into current_member_id
  from public.room_members rm
  where rm.room_id = p_room_id
    and rm.user_id = auth.uid()
    and rm.membership_status = 'active'
  order by rm.joined_at desc
  limit 1;

  if current_member_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.notification_delivery_state ds
    where ds.room_id = p_room_id
      and ds.notification_id = p_notification_id
      and ds.room_member_id = current_member_id
  );
end;
$$;

create or replace function private.validate_room_item_update_fields(p_fields jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  invalid_key text;
  allowed_keys constant text[] := array['price', 'quantity', 'actualPurchaseQuantity', 'remarks', 'url'];
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select key into invalid_key
  from jsonb_object_keys(p_fields) as key
  where key <> all(allowed_keys)
  limit 1;

  if invalid_key is not null or p_fields = '{}'::jsonb then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'price'
     and p_fields -> 'price' <> 'null'::jsonb
     and (
       jsonb_typeof(p_fields -> 'price') <> 'number'
       or (p_fields ->> 'price')::numeric < 0
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'quantity'
     and p_fields -> 'quantity' <> 'null'::jsonb
     and (
       jsonb_typeof(p_fields -> 'quantity') <> 'number'
       or (p_fields ->> 'quantity')::integer < 0
       or (p_fields ->> 'quantity')::numeric <> ((p_fields ->> 'quantity')::integer)::numeric
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'actualPurchaseQuantity'
     and p_fields -> 'actualPurchaseQuantity' <> 'null'::jsonb
     and (
       jsonb_typeof(p_fields -> 'actualPurchaseQuantity') <> 'number'
       or (p_fields ->> 'actualPurchaseQuantity')::integer < 0
       or (p_fields ->> 'actualPurchaseQuantity')::numeric <> ((p_fields ->> 'actualPurchaseQuantity')::integer)::numeric
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'remarks'
     and p_fields -> 'remarks' <> 'null'::jsonb
     and (
       jsonb_typeof(p_fields -> 'remarks') <> 'string'
       or length(p_fields ->> 'remarks') > 2000
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_fields ? 'url'
     and p_fields -> 'url' <> 'null'::jsonb
     and (
       jsonb_typeof(p_fields -> 'url') <> 'string'
       or length(p_fields ->> 'url') > 2048
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  return private.sharing_success();
exception
  when others then
    return private.sharing_error('INVALID_REQUEST');
end;
$$;

create or replace function public.update_room_item_fields(
  p_room_id uuid,
  p_local_item_id text,
  p_fields jsonb
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
  item_row public.room_items;
  updated_item public.room_items;
  validation_result jsonb;
  changed_fields text[] := array[]::text[];
  new_version bigint;
  new_updated_at timestamptz := now();
  changed_values jsonb;
  field_updated_at jsonb;
  notification_id uuid;
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

  validation_result := private.validate_room_item_update_fields(p_fields);
  if coalesce((validation_result ->> 'ok')::boolean, false) = false then
    return validation_result;
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

  if p_fields ? 'price'
     and item_row.price is distinct from nullif(p_fields ->> 'price', 'null')::numeric then
    changed_fields := array_append(changed_fields, 'price');
  end if;
  if p_fields ? 'quantity'
     and item_row.quantity is distinct from nullif(p_fields ->> 'quantity', 'null')::integer then
    changed_fields := array_append(changed_fields, 'quantity');
  end if;
  if p_fields ? 'actualPurchaseQuantity'
     and item_row.actual_purchase_quantity is distinct from nullif(p_fields ->> 'actualPurchaseQuantity', 'null')::integer then
    changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
  end if;
  if p_fields ? 'remarks'
     and coalesce(item_row.remarks, '') is distinct from coalesce(nullif(p_fields ->> 'remarks', 'null'), '') then
    changed_fields := array_append(changed_fields, 'remarks');
  end if;
  if p_fields ? 'url'
     and item_row.url is distinct from nullif(p_fields ->> 'url', 'null') then
    changed_fields := array_append(changed_fields, 'url');
  end if;

  if array_length(changed_fields, 1) is null then
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
  set price = case when p_fields ? 'price' then nullif(p_fields ->> 'price', 'null')::numeric else price end,
      quantity = case when p_fields ? 'quantity' then nullif(p_fields ->> 'quantity', 'null')::integer else quantity end,
      actual_purchase_quantity = case when p_fields ? 'actualPurchaseQuantity' then nullif(p_fields ->> 'actualPurchaseQuantity', 'null')::integer else actual_purchase_quantity end,
      remarks = case when p_fields ? 'remarks' then coalesce(nullif(p_fields ->> 'remarks', 'null'), '') else remarks end,
      url = case when p_fields ? 'url' then nullif(p_fields ->> 'url', 'null') else url end,
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
    'item_fields_updated',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', updated_item.local_item_id,
      'itemsVersion', new_version,
      'updatedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'updatedByMemberId', member_id
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

drop function if exists public.claim_item(uuid, text);

create or replace function public.claim_item(
  p_room_id uuid,
  p_local_item_id text,
  p_status text,
  p_actual_purchase_quantity integer default null
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
  item_row public.room_items;
  updated_item public.room_items;
  changed_fields text[] := array[]::text[];
  new_version bigint;
  new_updated_at timestamptz := now();
  new_secured_by uuid;
  new_actual_purchase_quantity integer;
  new_postponed boolean;
  changed_values jsonb;
  field_updated_at jsonb;
  notification_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_status not in (
    'None',
    'Purchased',
    'SoldOut',
    'Absent',
    'Postpone',
    'Late',
    'LimitedPurchase'
  ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_actual_purchase_quantity is not null and p_actual_purchase_quantity < 0 then
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

  select * into item_row
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(p_local_item_id)
  for update;

  if not found then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if item_row.secured_by is not null
     and item_row.secured_by <> member_id
     and item_row.purchase_status in ('Purchased', 'LimitedPurchase')
     and p_status in ('Purchased', 'LimitedPurchase') then
    insert into public.notifications(
      room_id,
      idempotency_key,
      notification_type,
      target_member_id,
      payload
    )
    values (
      p_room_id,
      'item:' || item_row.id::text || ':claim_failed:' || member_id::text || ':' || pg_catalog.gen_random_uuid()::text,
      'item_claim_failed',
      member_id,
      jsonb_build_object(
        'roomId', p_room_id,
        'localItemId', item_row.local_item_id,
        'itemsVersion', room_row.items_version,
        'updatedFields', '[]'::jsonb,
        'updatedValues', '{}'::jsonb,
        'fieldUpdatedAt', '{}'::jsonb,
        'updatedByMemberId', item_row.secured_by,
        'targetMemberId', member_id,
        'reason', 'already_secured'
      )
    )
    returning id into notification_id;

    perform private.create_member_notification_delivery(notification_id, p_room_id, member_id);

    return private.sharing_error('PERMISSION_DENIED');
  end if;

  new_secured_by := case
    when p_status in ('Purchased', 'LimitedPurchase') then member_id
    else null
  end;
  new_actual_purchase_quantity := case
    when p_status = 'LimitedPurchase' then p_actual_purchase_quantity
    else null
  end;
  new_postponed := p_status = 'Postpone';

  if item_row.purchase_status is distinct from p_status then
    changed_fields := array_append(changed_fields, 'purchaseStatus');
  end if;
  if item_row.actual_purchase_quantity is distinct from new_actual_purchase_quantity then
    changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
  end if;
  if item_row.secured_by is distinct from new_secured_by then
    changed_fields := array_append(changed_fields, 'securedBy');
  end if;
  if item_row.postponed is distinct from new_postponed then
    changed_fields := array_append(changed_fields, 'postponed');
  end if;

  if array_length(changed_fields, 1) is null then
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
  set purchase_status = p_status,
      actual_purchase_quantity = new_actual_purchase_quantity,
      secured_by = new_secured_by,
      postponed = new_postponed,
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
    case
      when p_status in ('Purchased', 'LimitedPurchase') then 'item_claimed'
      else 'item_purchase_status_updated'
    end,
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', updated_item.local_item_id,
      'itemsVersion', new_version,
      'updatedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'updatedByMemberId', member_id
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

create or replace function public.update_room_item_with_purchase(
  p_room_id uuid,
  p_local_item_id text,
  p_fields jsonb default '{}'::jsonb,
  p_status text default null,
  p_actual_purchase_quantity integer default null
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
  item_row public.room_items;
  updated_item public.room_items;
  validation_result jsonb;
  changed_fields text[] := array[]::text[];
  effective_status text;
  new_version bigint;
  new_updated_at timestamptz := now();
  new_secured_by uuid;
  new_actual_purchase_quantity integer;
  new_postponed boolean;
  changed_values jsonb;
  field_updated_at jsonb;
  notification_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_status is not null
     and p_status not in (
       'None',
       'Purchased',
       'SoldOut',
       'Absent',
       'Postpone',
       'Late',
       'LimitedPurchase'
     ) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if p_actual_purchase_quantity is not null and p_actual_purchase_quantity < 0 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  validation_result := private.validate_room_item_update_fields(coalesce(p_fields, '{}'::jsonb));
  if coalesce((validation_result ->> 'ok')::boolean, false) = false
     and coalesce(p_fields, '{}'::jsonb) <> '{}'::jsonb then
    return validation_result;
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

  effective_status := coalesce(p_status, item_row.purchase_status);

  if item_row.secured_by is not null
     and item_row.secured_by <> member_id
     and item_row.purchase_status in ('Purchased', 'LimitedPurchase')
     and p_status in ('Purchased', 'LimitedPurchase') then
    insert into public.notifications(
      room_id,
      idempotency_key,
      notification_type,
      target_member_id,
      payload
    )
    values (
      p_room_id,
      'item:' || item_row.id::text || ':claim_failed:' || member_id::text || ':' || pg_catalog.gen_random_uuid()::text,
      'item_claim_failed',
      member_id,
      jsonb_build_object(
        'roomId', p_room_id,
        'localItemId', item_row.local_item_id,
        'itemsVersion', room_row.items_version,
        'updatedFields', '[]'::jsonb,
        'updatedValues', '{}'::jsonb,
        'fieldUpdatedAt', '{}'::jsonb,
        'updatedByMemberId', item_row.secured_by,
        'targetMemberId', member_id,
        'reason', 'already_secured'
      )
    )
    returning id into notification_id;

    perform private.create_member_notification_delivery(notification_id, p_room_id, member_id);

    return private.sharing_error('PERMISSION_DENIED');
  end if;

  new_secured_by := case
    when p_status is null then item_row.secured_by
    when effective_status in ('Purchased', 'LimitedPurchase') then member_id
    else null
  end;
  new_actual_purchase_quantity := case
    when p_status is null and coalesce(p_fields, '{}'::jsonb) ? 'actualPurchaseQuantity'
      then nullif(p_fields ->> 'actualPurchaseQuantity', 'null')::integer
    when p_status is null then item_row.actual_purchase_quantity
    when effective_status = 'LimitedPurchase' then p_actual_purchase_quantity
    else null
  end;
  new_postponed := effective_status = 'Postpone';

  if coalesce(p_fields, '{}'::jsonb) ? 'price'
     and item_row.price is distinct from nullif(p_fields ->> 'price', 'null')::numeric then
    changed_fields := array_append(changed_fields, 'price');
  end if;
  if coalesce(p_fields, '{}'::jsonb) ? 'quantity'
     and item_row.quantity is distinct from nullif(p_fields ->> 'quantity', 'null')::integer then
    changed_fields := array_append(changed_fields, 'quantity');
  end if;
  if coalesce(p_fields, '{}'::jsonb) ? 'remarks'
     and coalesce(item_row.remarks, '') is distinct from coalesce(nullif(p_fields ->> 'remarks', 'null'), '') then
    changed_fields := array_append(changed_fields, 'remarks');
  end if;
  if coalesce(p_fields, '{}'::jsonb) ? 'url'
     and item_row.url is distinct from nullif(p_fields ->> 'url', 'null') then
    changed_fields := array_append(changed_fields, 'url');
  end if;
  if item_row.purchase_status is distinct from effective_status then
    changed_fields := array_append(changed_fields, 'purchaseStatus');
  end if;
  if item_row.actual_purchase_quantity is distinct from new_actual_purchase_quantity then
    changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
  end if;
  if item_row.secured_by is distinct from new_secured_by then
    changed_fields := array_append(changed_fields, 'securedBy');
  end if;
  if item_row.postponed is distinct from new_postponed then
    changed_fields := array_append(changed_fields, 'postponed');
  end if;

  if array_length(changed_fields, 1) is null then
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
  set price = case when coalesce(p_fields, '{}'::jsonb) ? 'price' then nullif(p_fields ->> 'price', 'null')::numeric else price end,
      quantity = case when coalesce(p_fields, '{}'::jsonb) ? 'quantity' then nullif(p_fields ->> 'quantity', 'null')::integer else quantity end,
      remarks = case when coalesce(p_fields, '{}'::jsonb) ? 'remarks' then coalesce(nullif(p_fields ->> 'remarks', 'null'), '') else remarks end,
      url = case when coalesce(p_fields, '{}'::jsonb) ? 'url' then nullif(p_fields ->> 'url', 'null') else url end,
      purchase_status = effective_status,
      actual_purchase_quantity = new_actual_purchase_quantity,
      secured_by = new_secured_by,
      postponed = new_postponed,
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
    case
      when effective_status in ('Purchased', 'LimitedPurchase')
           and 'purchaseStatus' = any(changed_fields) then 'item_claimed'
      else 'item_fields_updated'
    end,
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', updated_item.local_item_id,
      'itemsVersion', new_version,
      'updatedFields', to_jsonb(changed_fields),
      'updatedValues', changed_values,
      'fieldUpdatedAt', field_updated_at,
      'updatedByMemberId', member_id
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
    'expiresAt', room_row.expires_at,
    'isActive', room_row.sharing_status = 'active' and room_row.expires_at > now()
  ));
end;
$$;

create or replace function public.get_room_item_changes_since(
  p_room_id uuid,
  p_since_items_version bigint
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
  expected_count bigint;
  actual_count bigint;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_since_items_version is null or p_since_items_version < 0 then
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
    and expires_at > now();

  if not found then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if p_since_items_version > room_row.items_version then
    return private.sharing_error('FULL_ITEM_REFRESH_REQUIRED');
  end if;

  expected_count := room_row.items_version - p_since_items_version;
  select count(*) into actual_count
  from public.room_item_change_log log
  where log.room_id = p_room_id
    and log.items_version > p_since_items_version
    and log.items_version <= room_row.items_version;

  if actual_count <> expected_count then
    return private.sharing_error('FULL_ITEM_REFRESH_REQUIRED');
  end if;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'fromItemsVersion', p_since_items_version,
    'itemsVersion', room_row.items_version,
    'changes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'changeId', log.id,
          'localItemId', log.local_item_id,
          'itemsVersion', log.items_version,
          'updatedFields', to_jsonb(log.changed_fields),
          'updatedValues', log.changed_values,
          'fieldUpdatedAt', log.field_updated_at,
          'updatedByMemberId', log.updated_by,
          'notificationId', log.notification_id,
          'createdAt', log.created_at
        )
        order by log.items_version asc, log.id asc
      )
      from public.room_item_change_log log
      where log.room_id = p_room_id
        and log.items_version > p_since_items_version
        and log.items_version <= room_row.items_version
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function public.get_notifications_after_watermark(
  p_room_id uuid,
  p_after_created_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 100
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
  page_rows jsonb := '[]'::jsonb;
  visible_total integer := 0;
  page_total integer := 0;
  next_watermark_created_at timestamptz;
  next_watermark_id uuid;
  server_high_watermark_created_at timestamptz;
  server_high_watermark_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if (p_after_created_at is null and p_after_id is not null)
     or (p_after_created_at is not null and p_after_id is null) then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  effective_limit := least(greatest(coalesce(p_limit, 100), 1), 100);

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  with visible as (
    select n.*
    from public.notification_delivery_state ds
    join public.notifications n on n.id = ds.notification_id
    where ds.room_id = p_room_id
      and ds.room_member_id = member_id
      and (
        p_after_created_at is null
        or (n.created_at, n.id) > (p_after_created_at, p_after_id)
      )
  ),
  counted as (
    select *,
           count(*) over () as total_count,
           first_value(created_at) over (order by created_at desc, id desc) as high_created_at,
           first_value(id) over (order by created_at desc, id desc) as high_id
    from visible
  ),
  limited as (
    select *
    from counted
    order by created_at asc, id asc
    limit effective_limit
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', id,
             'eventId', event_id,
             'idempotencyKey', idempotency_key,
             'notificationType', notification_type,
             'targetMemberId', target_member_id,
             'payload', payload,
             'createdAt', created_at
           )
           order by created_at asc, id asc
         ), '[]'::jsonb),
         coalesce(max(total_count), 0),
         count(*),
         (array_agg(created_at order by created_at desc, id desc))[1],
         (array_agg(id order by created_at desc, id desc))[1],
         (array_agg(high_created_at order by high_created_at desc, high_id desc))[1],
         (array_agg(high_id order by high_created_at desc, high_id desc))[1]
  into page_rows,
       visible_total,
       page_total,
       next_watermark_created_at,
       next_watermark_id,
       server_high_watermark_created_at,
       server_high_watermark_id
  from limited;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'limit', effective_limit,
    'events', page_rows,
    'notifications', page_rows,
    'nextWatermarkCreatedAt', next_watermark_created_at,
    'nextWatermarkId', next_watermark_id,
    'hasMore', visible_total > page_total,
    'serverHighWatermarkCreatedAt', server_high_watermark_created_at,
    'serverHighWatermarkId', server_high_watermark_id
  ));
end;
$$;

create or replace function public.ack_room_sync_progress(
  p_room_id uuid,
  p_items_version bigint,
  p_last_processed_event_created_at timestamptz default null,
  p_last_processed_event_id uuid default null,
  p_processed_event_ids jsonb default '[]'::jsonb
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
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_items_version is null
     or p_items_version < 0
     or jsonb_typeof(coalesce(p_processed_event_ids, '[]'::jsonb)) <> 'array' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_processed_event_ids, '[]'::jsonb)) processed(value)
    where jsonb_typeof(processed.value) is distinct from 'object'
      or jsonb_typeof(processed.value -> 'event_id') is distinct from 'string'
      or jsonb_typeof(processed.value -> 'processed_at') is distinct from 'string'
      or not ((processed.value ->> 'event_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      or not ((processed.value ->> 'processed_at') ~ '^\d{4}-\d{2}-\d{2}T')
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

  select * into room_row
  from public.rooms
  where id = p_room_id;

  if p_items_version > room_row.items_version then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  insert into public.room_member_sync_state(
    room_member_id,
    room_id,
    items_version,
    last_processed_event_created_at,
    last_processed_event_id,
    processed_event_ids
  )
  values (
    member_id,
    p_room_id,
    p_items_version,
    p_last_processed_event_created_at,
    p_last_processed_event_id,
    coalesce(p_processed_event_ids, '[]'::jsonb)
  )
  on conflict (room_member_id) do update
    set items_version = greatest(
          public.room_member_sync_state.items_version,
          excluded.items_version
        ),
        last_processed_event_created_at = case
          when excluded.last_processed_event_created_at is null then public.room_member_sync_state.last_processed_event_created_at
          when public.room_member_sync_state.last_processed_event_created_at is null then excluded.last_processed_event_created_at
          when (excluded.last_processed_event_created_at, coalesce(excluded.last_processed_event_id, '00000000-0000-0000-0000-000000000000'::uuid))
               > (public.room_member_sync_state.last_processed_event_created_at, coalesce(public.room_member_sync_state.last_processed_event_id, '00000000-0000-0000-0000-000000000000'::uuid))
            then excluded.last_processed_event_created_at
          else public.room_member_sync_state.last_processed_event_created_at
        end,
        last_processed_event_id = case
          when excluded.last_processed_event_created_at is null then public.room_member_sync_state.last_processed_event_id
          when public.room_member_sync_state.last_processed_event_created_at is null then excluded.last_processed_event_id
          when (excluded.last_processed_event_created_at, coalesce(excluded.last_processed_event_id, '00000000-0000-0000-0000-000000000000'::uuid))
               > (public.room_member_sync_state.last_processed_event_created_at, coalesce(public.room_member_sync_state.last_processed_event_id, '00000000-0000-0000-0000-000000000000'::uuid))
            then excluded.last_processed_event_id
          else public.room_member_sync_state.last_processed_event_id
        end,
        processed_event_ids = (
          select coalesce(jsonb_agg(limited.value order by limited.processed_at desc), '[]'::jsonb)
          from (
            select dedup.value, dedup.processed_at
            from (
              select distinct on (entry.value ->> 'event_id')
                     entry.value,
                     (entry.value ->> 'processed_at')::timestamptz as processed_at
              from jsonb_array_elements(
                public.room_member_sync_state.processed_event_ids || excluded.processed_event_ids
              ) entry(value)
              where jsonb_typeof(entry.value) = 'object'
                and jsonb_typeof(entry.value -> 'event_id') = 'string'
                and jsonb_typeof(entry.value -> 'processed_at') = 'string'
                and (entry.value ->> 'event_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                and (entry.value ->> 'processed_at') ~ '^\d{4}-\d{2}-\d{2}T'
                and (entry.value ->> 'processed_at')::timestamptz >= now() - interval '24 hours'
              order by entry.value ->> 'event_id',
                       (entry.value ->> 'processed_at')::timestamptz desc
            ) dedup
            order by dedup.processed_at desc
            limit 100
          ) limited
        );

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'itemsVersion', (
      select sync.items_version
      from public.room_member_sync_state sync
      where sync.room_member_id = member_id
    ),
    'lastProcessedEventCreatedAt', (
      select sync.last_processed_event_created_at
      from public.room_member_sync_state sync
      where sync.room_member_id = member_id
    ),
    'lastProcessedEventId', (
      select sync.last_processed_event_id
      from public.room_member_sync_state sync
      where sync.room_member_id = member_id
    )
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
        and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'room_items'
    ) then
      alter publication supabase_realtime add table public.room_items;
    end if;
  end if;
end;
$$;

revoke all on function public.can_select_room_sync_rows(uuid) from public;
revoke all on function public.can_select_room_notification(uuid, uuid) from public;
grant execute on function public.can_select_room_sync_rows(uuid) to authenticated;
grant execute on function public.can_select_room_notification(uuid, uuid) to authenticated;

grant select on table public.room_items to authenticated;
grant select on table public.notifications to authenticated;

create policy room_items_select_active_members
on public.room_items
for select
to authenticated
using (public.can_select_room_sync_rows(room_id));

create policy notifications_select_active_members
on public.notifications
for select
to authenticated
using (public.can_select_room_notification(room_id, id));

revoke all on function public.update_room_item_fields(uuid, text, jsonb) from public;
revoke all on function public.claim_item(uuid, text, text, integer) from public;
revoke all on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer) from public;
revoke all on function public.get_room_versions(uuid) from public;
revoke all on function public.get_room_item_changes_since(uuid, bigint) from public;
revoke all on function public.get_notifications_after_watermark(uuid, timestamptz, uuid, integer) from public;
revoke all on function public.ack_room_sync_progress(uuid, bigint, timestamptz, uuid, jsonb) from public;

grant execute on function public.update_room_item_fields(uuid, text, jsonb) to authenticated;
grant execute on function public.claim_item(uuid, text, text, integer) to authenticated;
grant execute on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer) to authenticated;
grant execute on function public.get_room_versions(uuid) to authenticated;
grant execute on function public.get_room_item_changes_since(uuid, bigint) to authenticated;
grant execute on function public.get_notifications_after_watermark(uuid, timestamptz, uuid, integer) to authenticated;
grant execute on function public.ack_room_sync_progress(uuid, bigint, timestamptz, uuid, jsonb) to authenticated;
