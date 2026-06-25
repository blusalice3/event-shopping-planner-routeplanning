-- Additive contract-v2 item structural sync foundation.
-- This migration intentionally does not revoke/drop v1 RPCs. Activation cleanup is a
-- separate release-gated step after drift audits pass.

alter table private.sharing_runtime_config
  drop constraint if exists sharing_runtime_config_contract_version_check;

alter table private.sharing_runtime_config
  alter column contract_version set default 2;

alter table private.sharing_runtime_config
  add constraint sharing_runtime_config_contract_version_check
  check (contract_version in (1, 2));

update private.sharing_runtime_config
set contract_version = 2;

create or replace function private.sharing_success(p_data jsonb default '{}'::jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'data', coalesce(p_data, '{}'::jsonb),
    'contract_version', 2
  );
$$;

create or replace function private.sharing_error(
  p_code text,
  p_retry_after_seconds integer default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', false,
    'error', jsonb_strip_nulls(jsonb_build_object(
      'code', p_code,
      'retry_after_seconds', p_retry_after_seconds,
      'contract_version', 2
    ))
  );
$$;

alter table private.room_create_payload_challenges
  add column if not exists contract_version integer not null default 2;

alter table private.room_join_challenges
  add column if not exists contract_version integer not null default 2;

alter table public.room_members
  add column if not exists accepted_contract_version integer;

alter table public.room_members
  drop constraint if exists room_members_accepted_contract_version_check;

alter table public.room_members
  add constraint room_members_accepted_contract_version_check
  check (accepted_contract_version is null or accepted_contract_version in (1, 2));

alter table public.room_members
  alter column accepted_contract_version set default 2;

create or replace function private.current_room_member_id(p_room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select rm.id
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = p_room_id
    and rm.user_id = auth.uid()
    and rm.membership_status = 'active'
    and rm.accepted_contract_version = 2
    and r.sharing_status = 'active'
    and r.expires_at > now()
  order by rm.joined_at desc
  limit 1;
$$;

create or replace function private.is_host_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members rm
    join public.rooms r on r.id = rm.room_id
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
      and rm.role = 'host'
      and rm.membership_status = 'active'
      and rm.accepted_contract_version = 2
      and r.sharing_status = 'active'
      and r.expires_at > now()
  );
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
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = p_room_id
    and rm.membership_status = 'active'
    and rm.accepted_contract_version = 2
    and r.sharing_status = 'active'
    and r.expires_at > now()
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
  select p_notification_id,
         p_room_id,
         rm.id
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.id = p_room_member_id
    and rm.room_id = p_room_id
    and rm.membership_status = 'active'
    and rm.accepted_contract_version = 2
    and r.sharing_status = 'active'
    and r.expires_at > now()
  on conflict do nothing;
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
    join public.rooms r on r.id = rm.room_id
    where rm.room_id = p_room_id
      and rm.user_id = auth.uid()
      and rm.membership_status = 'active'
      and rm.accepted_contract_version = 2
      and r.sharing_status = 'active'
      and r.expires_at > now()
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
  current_member_id := private.current_room_member_id(p_room_id);

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

create or replace function private.require_active_room_member(
  p_room_id uuid,
  p_auth_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
begin
  update public.rooms
  set sharing_status = 'expired'
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at <= now();

  select rm.id into v_member_id
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = p_room_id
    and rm.user_id = p_auth_user_id
    and rm.membership_status = 'active'
    and rm.accepted_contract_version = 2
    and r.sharing_status = 'active'
    and r.expires_at > now();

  return v_member_id;
end;
$$;

create or replace function public.restore_member_by_key(
  p_challenge_id uuid,
  p_member_restore_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  challenge_result jsonb;
  challenge_data jsonb;
  v_room_id uuid;
  member_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_challenge_id is null
     or p_member_restore_token !~ '^[A-Za-z0-9_-]{43}$' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select c.room_id into v_room_id
  from private.room_join_challenges c
  where c.challenge_id = p_challenge_id;

  challenge_result := private.consume_bootstrap_challenge(
    p_challenge_id,
    'restore',
    auth_user_id,
    v_room_id
  );
  if coalesce((challenge_result ->> 'ok')::boolean, false) = false then
    return challenge_result;
  end if;
  challenge_data := challenge_result -> 'data';
  v_room_id := (challenge_data ->> 'room_id')::uuid;

  select c.room_member_id into member_id
  from private.room_member_credentials c
  join public.room_members rm on rm.id = c.room_member_id
  join public.rooms r on r.id = rm.room_id
  where c.room_id = v_room_id
    and rm.membership_status = 'active'
    and rm.accepted_contract_version = 2
    and r.sharing_status = 'active'
    and r.expires_at > now()
    and c.member_key_lookup_digest = private.member_key_lookup_digest(
      v_room_id,
      p_member_restore_token,
      c.secret_version
    )
    and c.member_key_digest = private.member_key_digest(
      v_room_id,
      p_member_restore_token,
      c.secret_version
    )
  limit 1;

  if member_id is null then
    return private.sharing_error('RESTORE_REQUIRED');
  end if;

  begin
    update public.room_members
    set user_id = auth_user_id,
        last_seen_at = now()
    where id = member_id;
  exception
    when unique_violation then
      return private.sharing_error('RESTORE_REQUIRED');
  end;

  update private.room_join_challenges
  set consumed_at = now()
  where challenge_id = p_challenge_id;

  return private.sharing_success(jsonb_build_object(
    'roomId', v_room_id,
    'roomMemberId', member_id,
    'tokenContext', 'restore:v1:' || v_room_id::text
  ));
end;
$$;

alter table public.room_items
  add column if not exists circle_name text,
  add column if not exists block_name text,
  add column if not exists booth_number text,
  add column if not exists title text,
  add column if not exists priority_level text not null default 'none',
  add column if not exists protection_level text,
  add column if not exists source text,
  add column if not exists manual_hall_id text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.room_members(id) on delete set null,
  add column if not exists field_clocks jsonb not null default '{}'::jsonb;

update public.room_items
set circle_name = coalesce(circle_name, ''),
    block_name = coalesce(block_name, ''),
    booth_number = coalesce(booth_number, ''),
    title = coalesce(nullif(btrim(title), ''), name),
    priority_level = coalesce(priority_level, 'none'),
    postponed = purchase_status = 'Postpone';

alter table public.room_items
  alter column circle_name set not null,
  alter column block_name set not null,
  alter column booth_number set not null,
  alter column title set not null;

alter table public.room_items
  drop constraint if exists room_items_priority_level_check,
  drop constraint if exists room_items_protection_level_check,
  drop constraint if exists room_items_source_check,
  drop constraint if exists room_items_field_clocks_object_check,
  drop constraint if exists room_items_route_membership_date_check;

alter table public.room_items
  add constraint room_items_priority_level_check
    check (priority_level in ('none', 'priority', 'highest')),
  add constraint room_items_protection_level_check
    check (protection_level is null or protection_level in ('full', 'deletable', 'none')),
  add constraint room_items_source_check
    check (source is null or source in ('spreadsheet', 'app')),
  add constraint room_items_field_clocks_object_check
    check (jsonb_typeof(field_clocks) = 'object'),
  add constraint room_items_route_membership_date_check
    check (order_index is null or nullif(btrim(coalesce(event_date, '')), '') is not null);

create index if not exists room_items_room_active_count_idx
  on public.room_items(room_id)
  where deleted_at is null;

create index if not exists room_items_room_date_active_route_idx
  on public.room_items(room_id, event_date, order_index)
  where deleted_at is null and order_index is not null;

create or replace function private.v2_field_clock_payload(
  p_fields text[],
  p_items_version bigint,
  p_updated_at timestamptz
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_object_agg(
      field_name,
      jsonb_build_object(
        'itemsVersion', p_items_version,
        'updatedAt', p_updated_at
      )
    ),
    '{}'::jsonb
  )
  from unnest(coalesce(p_fields, array[]::text[])) field_name;
$$;

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
  new.title := coalesce(nullif(btrim(new.title), ''), new.name);
  new.priority_level := coalesce(new.priority_level, 'none');
  new.postponed := new.purchase_status = 'Postpone';
  new.field_clocks := coalesce(new.field_clocks, '{}'::jsonb);

  if tg_op = 'INSERT' then
    if new.name is null or btrim(new.name) = '' then
      new.name := new.title;
    end if;

    if new.field_clocks = '{}'::jsonb then
      new.field_clocks := private.v2_field_clock_payload(
        all_clock_fields,
        coalesce(new.item_version, 0),
        coalesce(new.updated_at, now())
      );
    end if;

    return new;
  end if;

  if new.name is distinct from old.name and new.title is not distinct from old.title then
    new.title := new.name;
  elsif new.title is distinct from old.title and new.name is not distinct from old.name then
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

drop trigger if exists room_items_v2_canonical_defaults on public.room_items;
create trigger room_items_v2_canonical_defaults
before insert or update on public.room_items
for each row execute function private.room_items_v2_canonical_defaults();

update public.room_items ri
set field_clocks = private.v2_field_clock_payload(
  array[
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
  ],
  ri.item_version,
  ri.updated_at
)
where ri.field_clocks = '{}'::jsonb;

alter table public.room_item_change_log
  add column if not exists change_type text not null default 'update',
  add column if not exists item_payload jsonb,
  add column if not exists field_clocks jsonb not null default '{}'::jsonb;

alter table public.room_item_change_log
  drop constraint if exists room_item_change_log_change_type_check,
  drop constraint if exists room_item_change_log_field_clocks_object_check;

alter table public.room_item_change_log
  add constraint room_item_change_log_change_type_check
    check (change_type in ('create', 'update', 'delete')),
  add constraint room_item_change_log_field_clocks_object_check
    check (jsonb_typeof(field_clocks) = 'object');

update public.room_item_change_log log
set field_clocks = private.v2_field_clock_payload(
  log.changed_fields,
  log.items_version,
  log.created_at
)
where log.field_clocks = '{}'::jsonb;

create or replace function private.room_item_payload(p_item public.room_items)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_item.id,
    'localItemId', p_item.local_item_id,
    'circle', p_item.circle_name,
    'block', p_item.block_name,
    'number', p_item.booth_number,
    'title', p_item.title,
    'eventDate', p_item.event_date,
    'name', p_item.name,
    'priorityLevel', p_item.priority_level,
    'protectionLevel', p_item.protection_level,
    'source', p_item.source,
    'manualHallId', p_item.manual_hall_id,
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
    'postponed', p_item.purchase_status = 'Postpone',
    'deletedAt', p_item.deleted_at,
    'deletedBy', p_item.deleted_by,
    'itemVersion', p_item.item_version,
    'updatedAt', p_item.updated_at,
    'fieldClocks', p_item.field_clocks
  );
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
    return private.sharing_error('INVALID_REQUEST');
  end if;

  expected_count := room_row.items_version - p_since_items_version;

  select count(*) into actual_count
  from public.room_item_change_log log
  where log.room_id = p_room_id
    and log.items_version > p_since_items_version
    and log.items_version <= room_row.items_version;

  if actual_count <> expected_count then
    return private.sharing_error('ITEM_DIFF_EXPIRED');
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
          'changeType', log.change_type,
          'itemsVersion', log.items_version,
          'updatedFields', to_jsonb(log.changed_fields),
          'updatedValues', log.changed_values,
          'fieldUpdatedAt', log.field_updated_at,
          'fieldClocks', log.field_clocks,
          'item', case
            when log.change_type = 'create'
              then coalesce(log.item_payload, private.room_item_payload(ri))
            else log.item_payload
          end,
          'updatedByMemberId', log.updated_by,
          'notificationId', log.notification_id,
          'createdAt', log.created_at
        )
        order by log.items_version asc, log.id asc
      )
      from public.room_item_change_log log
      left join public.room_items ri on ri.id = log.room_item_id
      where log.room_id = p_room_id
        and log.items_version > p_since_items_version
        and log.items_version <= room_row.items_version
    ), '[]'::jsonb)
  ));
end;
$$;

create or replace function private.v2_expected_field_clocks_status(
  p_current jsonb,
  p_expected jsonb,
  p_fields text[]
)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  field_name text;
  expected_clock jsonb;
begin
  if p_expected is null or jsonb_typeof(p_expected) <> 'object' then
    return 'invalid';
  end if;

  foreach field_name in array coalesce(p_fields, array[]::text[]) loop
    expected_clock := p_expected -> field_name;

    if expected_clock is null
       or jsonb_typeof(expected_clock) <> 'object'
       or jsonb_typeof(expected_clock -> 'itemsVersion') <> 'number'
       or jsonb_typeof(expected_clock -> 'updatedAt') <> 'string' then
      return 'invalid';
    end if;

    if (p_current -> field_name) is distinct from expected_clock then
      return 'conflict';
    end if;
  end loop;

  return 'ok';
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
  allowed_keys constant text[] := array[
    'price',
    'quantity',
    'limitQuantity',
    'actualPurchaseQuantity',
    'remarks',
    'url'
  ];
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

  if p_fields ? 'limitQuantity'
     and p_fields -> 'limitQuantity' <> 'null'::jsonb
     and (
       jsonb_typeof(p_fields -> 'limitQuantity') <> 'number'
       or (p_fields ->> 'limitQuantity')::integer < 0
       or (p_fields ->> 'limitQuantity')::numeric <> ((p_fields ->> 'limitQuantity')::integer)::numeric
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
        select jsonb_agg(private.room_item_payload(ri) order by ri.local_item_id)
        from public.room_items ri
        where ri.room_id = p_room_id
          and ri.deleted_at is null
      ), '[]'::jsonb),
      'eventData', red.event_data,
      'snapshot', jsonb_build_object(
        'itemsVersion', r.items_version,
        'routeOrderVersion', r.route_order_version,
        'routeOrderVersions', route_versions.value,
        'deletedItemClocks', coalesce((
          select jsonb_object_agg(
            ri.local_item_id,
            jsonb_build_object(
              'deletedAt', ri.deleted_at,
              'deletedBy', ri.deleted_by,
              'fieldClocks', ri.field_clocks,
              'itemVersion', ri.item_version,
              'updatedAt', ri.updated_at
            )
            order by ri.local_item_id
          )
          from public.room_items ri
          where ri.room_id = p_room_id
            and ri.deleted_at is not null
        ), '{}'::jsonb),
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

  if (p_fields ? 'title' and title_value = '')
     or purchase_status_value not in ('None', 'SoldOut', 'Absent', 'Postpone', 'Late')
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

    if final_title is null or btrim(final_title) = '' then
      return private.sharing_error('INVALID_REQUEST');
    end if;

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

  if title_value = '' then
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

create or replace function public.delete_room_item_with_route(
  p_room_id uuid,
  p_local_item_id text,
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
  item_row public.room_items;
  updated_item public.room_items;
  route_update jsonb;
  route_update_count integer;
  route_event_date text;
  route_item_ids text[];
  expected_route_item_ids text[];
  expected_route_version bigint;
  current_route_version bigint;
  new_route_version bigint;
  new_room_route_version bigint;
  changed_fields text[] := array['deletedAt', 'deletedBy'];
  clock_status text;
  new_version bigint;
  new_updated_at timestamptz := now();
  changed_values jsonb;
  field_updated_at jsonb;
  new_field_clocks jsonb;
  item_notification_id uuid;
  route_notification_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if btrim(coalesce(p_local_item_id, '')) = ''
     or p_route_updates is null
     or jsonb_typeof(p_route_updates) <> 'array' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  route_update_count := jsonb_array_length(p_route_updates);
  if route_update_count > 1 then
    return private.sharing_error('INVALID_REQUEST');
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

    if route_event_date = '' or expected_route_version < 0 then
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

  if route_update_count = 1 then
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
  end if;

  select * into item_row
  from public.room_items
  where room_id = p_room_id
    and local_item_id = btrim(p_local_item_id)
  for update;

  if not found or item_row.deleted_at is not null then
    return private.sharing_error('INVALID_REQUEST');
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

  if item_row.order_index is null then
    if route_update_count <> 0 then
      return private.sharing_error('INVALID_REQUEST');
    end if;
  else
    if route_update_count <> 1
       or route_event_date <> coalesce(item_row.event_date, '')
       or item_row.local_item_id = any(route_item_ids) then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    select coalesce(array_agg(ri.local_item_id order by ri.order_index, ri.local_item_id), array[]::text[])
      into expected_route_item_ids
    from public.room_items ri
    where ri.room_id = p_room_id
      and coalesce(ri.event_date, '') = route_event_date
      and ri.deleted_at is null
      and ri.order_index is not null
      and ri.id <> item_row.id;

    if route_item_ids is distinct from expected_route_item_ids then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    if exists (
      select 1
      from unnest(route_item_ids) route_item_id
      where not exists (
        select 1
        from public.room_items ri
        where ri.room_id = p_room_id
          and ri.local_item_id = route_item_id
          and ri.deleted_at is null
          and ri.order_index is not null
          and coalesce(ri.event_date, '') = route_event_date
      )
    ) then
      return private.sharing_error('INVALID_REQUEST');
    end if;
  end if;

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

  update public.room_items
  set deleted_at = new_updated_at,
      deleted_by = member_id,
      order_index = null,
      item_version = new_version,
      updated_by = member_id,
      updated_at = new_updated_at,
      field_clocks = public.room_items.field_clocks || new_field_clocks
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
    'item:' || updated_item.id::text || ':delete:v' || new_version::text,
    'item_deleted',
    null,
    jsonb_build_object(
      'roomId', p_room_id,
      'localItemId', updated_item.local_item_id,
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
    updated_item.id,
    updated_item.local_item_id,
    new_version,
    changed_fields,
    changed_values,
    field_updated_at,
    'delete',
    null,
    new_field_clocks,
    member_id,
    item_notification_id
  );

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

    update public.room_items ri
    set order_index = null,
        updated_by = member_id
    where ri.room_id = p_room_id
      and coalesce(ri.event_date, '') = route_event_date
      and ri.order_index is not null
      and not (ri.local_item_id = any(route_item_ids));

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
    'item', private.room_item_payload(updated_item)
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
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
  new_updated_at timestamptz := now();
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
    0,
    member_id,
    new_updated_at
  )
  on conflict (room_id, event_date) do nothing;

  select version into current_date_version
  from public.room_route_order_versions
  where room_id = p_room_id
    and event_date = event_date_key
  for update;

  current_date_version := coalesce(current_date_version, 0);
  if current_date_version <> p_expected_version then
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
  );

  if invalid_item_count > 0 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  new_date_version := current_date_version + 1;
  new_room_route_version := coalesce(room_row.route_order_version, 0) + 1;

  update public.room_route_order_versions
  set version = new_date_version,
      updated_by = member_id,
      updated_at = new_updated_at
  where room_id = p_room_id
    and event_date = event_date_key;

  update public.rooms
  set route_order_version = new_room_route_version
  where id = p_room_id;

  with next_event_data as (
    select jsonb_set(
      red.event_data,
      array['routeOrderByDate', event_date_key],
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
    and coalesce(ri.event_date, '') = event_date_key
    and ri.deleted_at is null;

  update public.room_items ri
  set order_index = null,
      updated_by = member_id
  where ri.room_id = p_room_id
    and coalesce(ri.event_date, '') = event_date_key
    and ri.deleted_at is null
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
      'fieldUpdatedAt', jsonb_build_object('routeOrderByDate', new_updated_at),
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
    'changedRouteOrders', jsonb_build_array(jsonb_build_object(
      'eventDate', event_date_key,
      'itemIds', to_jsonb(route_item_ids),
      'dateRouteOrderVersion', new_date_version
    )),
    'notificationId', notification_id
  ));
exception
  when others then
    return private.sharing_error('SHARING_INTERNAL_ERROR');
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
  new_field_clocks jsonb;
  clock_status text;
  notification_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if btrim(coalesce(p_local_item_id, '')) = ''
     or p_fields is null
     or jsonb_typeof(p_fields) <> 'object'
     or p_expected_field_clocks is null
     or jsonb_typeof(p_expected_field_clocks) <> 'object' then
    return private.sharing_error('INVALID_REQUEST');
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

  validation_result := private.validate_room_item_update_fields(p_fields);
  if coalesce((validation_result ->> 'ok')::boolean, false) = false
     and p_fields <> '{}'::jsonb then
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

  if not found or item_row.deleted_at is not null then
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
        'fieldClocks', '{}'::jsonb,
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
    when p_status is null and p_fields ? 'actualPurchaseQuantity'
      then nullif(p_fields ->> 'actualPurchaseQuantity', 'null')::integer
    when p_status is null then item_row.actual_purchase_quantity
    when effective_status = 'LimitedPurchase' then p_actual_purchase_quantity
    else null
  end;
  new_postponed := effective_status = 'Postpone';

  if p_fields ? 'price'
     and item_row.price is distinct from nullif(p_fields ->> 'price', 'null')::numeric then
    changed_fields := array_append(changed_fields, 'price');
  end if;
  if p_fields ? 'quantity'
     and item_row.quantity is distinct from nullif(p_fields ->> 'quantity', 'null')::integer then
    changed_fields := array_append(changed_fields, 'quantity');
  end if;
  if p_fields ? 'limitQuantity'
     and item_row.limit_quantity is distinct from nullif(p_fields ->> 'limitQuantity', 'null')::integer then
    changed_fields := array_append(changed_fields, 'limitQuantity');
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
  if item_row.purchase_status is distinct from effective_status then
    changed_fields := array_append(changed_fields, 'purchaseStatus');
  end if;
  if item_row.actual_purchase_quantity is distinct from new_actual_purchase_quantity
     and not ('actualPurchaseQuantity' = any(changed_fields)) then
    changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
  end if;
  if item_row.secured_by is distinct from new_secured_by then
    changed_fields := array_append(changed_fields, 'securedBy');
  end if;

  if array_length(changed_fields, 1) is null then
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
  set price = case when p_fields ? 'price' then nullif(p_fields ->> 'price', 'null')::numeric else price end,
      quantity = case when p_fields ? 'quantity' then nullif(p_fields ->> 'quantity', 'null')::integer else quantity end,
      limit_quantity = case when p_fields ? 'limitQuantity' then nullif(p_fields ->> 'limitQuantity', 'null')::integer else limit_quantity end,
      remarks = case when p_fields ? 'remarks' then coalesce(nullif(p_fields ->> 'remarks', 'null'), '') else remarks end,
      url = case when p_fields ? 'url' then nullif(p_fields ->> 'url', 'null') else url end,
      purchase_status = effective_status,
      actual_purchase_quantity = new_actual_purchase_quantity,
      secured_by = new_secured_by,
      postponed = new_postponed,
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
    'item:' || updated_item.id::text || ':purchase:v' || new_version::text,
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
      'fieldClocks', new_field_clocks,
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
  room_row public.rooms;
  mutation jsonb;
  plan_entry jsonb;
  mutation_plan jsonb := '[]'::jsonb;
  changed_items jsonb := '[]'::jsonb;
  target_local_item_id text;
  fields jsonb;
  expected_field_clocks jsonb;
  status_value text;
  effective_status text;
  actual_purchase_quantity_value integer;
  item_row public.room_items;
  updated_item public.room_items;
  validation_result jsonb;
  changed_fields text[];
  clock_status text;
  new_version bigint;
  new_updated_at timestamptz := now();
  new_secured_by uuid;
  new_actual_purchase_quantity integer;
  new_postponed boolean;
  changed_values jsonb;
  field_updated_at jsonb;
  new_field_clocks jsonb;
  notification_id uuid;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_mutations is null
     or jsonb_typeof(p_mutations) <> 'array'
     or jsonb_array_length(p_mutations) = 0
     or jsonb_array_length(p_mutations) > 100 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_mutations) entry(value)
    where jsonb_typeof(entry.value) <> 'object'
       or btrim(coalesce(entry.value ->> 'localItemId', '')) = ''
       or jsonb_typeof(coalesce(entry.value -> 'fields', '{}'::jsonb)) <> 'object'
       or coalesce(jsonb_typeof(entry.value -> 'expectedFieldClocks'), '') <> 'object'
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
    fields := coalesce(mutation -> 'fields', '{}'::jsonb);
    expected_field_clocks := mutation -> 'expectedFieldClocks';
    status_value := nullif(mutation ->> 'status', '');
    actual_purchase_quantity_value := null;

    if status_value is not null
       and status_value not in (
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

    if mutation ? 'actualPurchaseQuantity'
       and mutation -> 'actualPurchaseQuantity' <> 'null'::jsonb then
      if jsonb_typeof(mutation -> 'actualPurchaseQuantity') <> 'number'
         or (mutation ->> 'actualPurchaseQuantity')::integer < 0
         or (mutation ->> 'actualPurchaseQuantity')::numeric <> ((mutation ->> 'actualPurchaseQuantity')::integer)::numeric then
        return private.sharing_error('INVALID_REQUEST');
      end if;
      actual_purchase_quantity_value := (mutation ->> 'actualPurchaseQuantity')::integer;
    end if;

    validation_result := private.validate_room_item_update_fields(fields);
    if coalesce((validation_result ->> 'ok')::boolean, false) = false
       and fields <> '{}'::jsonb then
      return validation_result;
    end if;

    select * into item_row
    from public.room_items ri
    where ri.room_id = p_room_id
      and ri.local_item_id = target_local_item_id
    for update;

    if not found or item_row.deleted_at is not null then
      return private.sharing_error('INVALID_REQUEST');
    end if;

    effective_status := coalesce(status_value, item_row.purchase_status);

    if item_row.secured_by is not null
       and item_row.secured_by <> member_id
       and item_row.purchase_status in ('Purchased', 'LimitedPurchase')
       and status_value in ('Purchased', 'LimitedPurchase') then
      return private.sharing_error('PERMISSION_DENIED');
    end if;

    new_secured_by := case
      when status_value is null then item_row.secured_by
      when effective_status in ('Purchased', 'LimitedPurchase') then member_id
      else null
    end;
    new_actual_purchase_quantity := case
      when status_value is null and fields ? 'actualPurchaseQuantity'
        then nullif(fields ->> 'actualPurchaseQuantity', 'null')::integer
      when status_value is null then item_row.actual_purchase_quantity
      when effective_status = 'LimitedPurchase' then actual_purchase_quantity_value
      else null
    end;
    new_postponed := effective_status = 'Postpone';
    changed_fields := array[]::text[];

    if fields ? 'price'
       and item_row.price is distinct from nullif(fields ->> 'price', 'null')::numeric then
      changed_fields := array_append(changed_fields, 'price');
    end if;
    if fields ? 'quantity'
       and item_row.quantity is distinct from nullif(fields ->> 'quantity', 'null')::integer then
      changed_fields := array_append(changed_fields, 'quantity');
    end if;
    if fields ? 'limitQuantity'
       and item_row.limit_quantity is distinct from nullif(fields ->> 'limitQuantity', 'null')::integer then
      changed_fields := array_append(changed_fields, 'limitQuantity');
    end if;
    if fields ? 'actualPurchaseQuantity'
       and item_row.actual_purchase_quantity is distinct from nullif(fields ->> 'actualPurchaseQuantity', 'null')::integer then
      changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
    end if;
    if fields ? 'remarks'
       and coalesce(item_row.remarks, '') is distinct from coalesce(nullif(fields ->> 'remarks', 'null'), '') then
      changed_fields := array_append(changed_fields, 'remarks');
    end if;
    if fields ? 'url'
       and item_row.url is distinct from nullif(fields ->> 'url', 'null') then
      changed_fields := array_append(changed_fields, 'url');
    end if;
    if item_row.purchase_status is distinct from effective_status then
      changed_fields := array_append(changed_fields, 'purchaseStatus');
    end if;
    if item_row.actual_purchase_quantity is distinct from new_actual_purchase_quantity
       and not ('actualPurchaseQuantity' = any(changed_fields)) then
      changed_fields := array_append(changed_fields, 'actualPurchaseQuantity');
    end if;
    if item_row.secured_by is distinct from new_secured_by then
      changed_fields := array_append(changed_fields, 'securedBy');
    end if;

    if array_length(changed_fields, 1) is null then
      if expected_field_clocks <> '{}'::jsonb then
        return private.sharing_error('INVALID_REQUEST');
      end if;
    else
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
        'fields', fields,
        'effectiveStatus', effective_status,
        'actualPurchaseQuantity', new_actual_purchase_quantity,
        'securedBy', new_secured_by,
        'postponed', new_postponed,
        'changedFields', to_jsonb(changed_fields)
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
    fields := plan_entry -> 'fields';
    effective_status := plan_entry ->> 'effectiveStatus';
    new_actual_purchase_quantity := (plan_entry ->> 'actualPurchaseQuantity')::integer;
    new_secured_by := (plan_entry ->> 'securedBy')::uuid;
    new_postponed := (plan_entry ->> 'postponed')::boolean;

    select coalesce(array_agg(value order by ordinality), array[]::text[])
      into changed_fields
    from jsonb_array_elements_text(plan_entry -> 'changedFields') with ordinality as entry(value, ordinality);

    field_updated_at := private.field_timestamp_payload(changed_fields, new_updated_at);
    new_field_clocks := private.v2_field_clock_payload(changed_fields, new_version, new_updated_at);

    update public.room_items
    set price = case when fields ? 'price' then nullif(fields ->> 'price', 'null')::numeric else price end,
        quantity = case when fields ? 'quantity' then nullif(fields ->> 'quantity', 'null')::integer else quantity end,
        limit_quantity = case when fields ? 'limitQuantity' then nullif(fields ->> 'limitQuantity', 'null')::integer else limit_quantity end,
        remarks = case when fields ? 'remarks' then coalesce(nullif(fields ->> 'remarks', 'null'), '') else remarks end,
        url = case when fields ? 'url' then nullif(fields ->> 'url', 'null') else url end,
        purchase_status = effective_status,
        actual_purchase_quantity = new_actual_purchase_quantity,
        secured_by = new_secured_by,
        postponed = new_postponed,
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
      'item:' || updated_item.id::text || ':bulk_purchase:v' || new_version::text,
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
        'fieldClocks', new_field_clocks,
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

revoke all on function public.upsert_room_item_with_route(uuid, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.delete_room_item_with_route(uuid, text, jsonb, jsonb) from public;
revoke all on function public.update_route_order(uuid, text, text[], bigint) from public;
revoke all on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb) from public;
revoke all on function public.bulk_update_room_items_with_purchase(uuid, jsonb) from public;

grant execute on function public.upsert_room_item_with_route(uuid, text, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.delete_room_item_with_route(uuid, text, jsonb, jsonb) to authenticated;
grant execute on function public.update_route_order(uuid, text, text[], bigint) to authenticated;
grant execute on function public.update_room_item_with_purchase(uuid, text, jsonb, text, integer, jsonb) to authenticated;
grant execute on function public.bulk_update_room_items_with_purchase(uuid, jsonb) to authenticated;
