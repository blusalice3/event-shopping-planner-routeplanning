-- [MVP-0c] Core sharing room lifecycle.
-- Opens create/join/restore/snapshot/ack and keeps live sync/mutations closed.

create table public.room_member_sync_state (
  room_member_id uuid primary key references public.room_members(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  last_snapshot_receipt_id uuid,
  last_snapshot_ack_at timestamptz,
  items_version bigint not null default 0 check (items_version >= 0),
  route_order_versions jsonb not null default '{}'::jsonb,
  last_processed_event_created_at timestamptz,
  last_processed_event_id uuid,
  processed_event_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(route_order_versions) = 'object'),
  check (jsonb_typeof(processed_event_ids) = 'array')
);

create table private.room_snapshot_receipts (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  room_member_id uuid not null references public.room_members(id) on delete cascade,
  items_version bigint not null check (items_version >= 0),
  route_order_version bigint,
  route_order_versions jsonb not null default '{}'::jsonb,
  notification_watermark_created_at timestamptz,
  notification_watermark_id uuid,
  snapshot_hash text not null,
  snapshot_created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  acked_at timestamptz,
  created_at timestamptz not null default now(),
  check (route_order_version is null),
  check (jsonb_typeof(route_order_versions) = 'object')
);

create index room_member_sync_state_room_idx
  on public.room_member_sync_state(room_id);

create index room_snapshot_receipts_member_room_idx
  on private.room_snapshot_receipts(room_member_id, room_id, created_at desc);

create trigger room_member_sync_state_set_updated_at
before update on public.room_member_sync_state
for each row execute function private.set_updated_at();

alter table public.room_member_sync_state enable row level security;
revoke all on table public.room_member_sync_state from anon, authenticated;
revoke all on table private.room_snapshot_receipts from anon, authenticated;

create or replace function private.generate_room_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  bytes bytea;
  i integer;
  idx integer;
begin
  bytes := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    idx := (get_byte(bytes, i) % length(alphabet)) + 1;
    result := result || substr(alphabet, idx, 1);
  end loop;
  return result;
end;
$$;

create or replace function private.payload_text_field(
  p_payload jsonb,
  p_path text[],
  p_default text default null
)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(btrim(coalesce(p_payload #>> p_path, p_default)), '');
$$;

create or replace function private.payload_integer_field(
  p_payload jsonb,
  p_path text[],
  p_default integer default null
)
returns integer
language plpgsql
immutable
set search_path = ''
as $$
declare
  raw_value text;
begin
  raw_value := p_payload #>> p_path;
  if raw_value is null or raw_value = '' then
    return p_default;
  end if;
  begin
    return raw_value::integer;
  exception
    when others then
      return p_default;
  end;
end;
$$;

create or replace function private.payload_numeric_field(
  p_payload jsonb,
  p_path text[],
  p_default numeric default null
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  raw_value text;
begin
  raw_value := p_payload #>> p_path;
  if raw_value is null or raw_value = '' then
    return p_default;
  end if;
  begin
    return raw_value::numeric;
  exception
    when others then
      return p_default;
  end;
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
    and r.sharing_status = 'active'
    and r.expires_at > now();

  return v_member_id;
end;
$$;

create or replace function private.consume_bootstrap_challenge(
  p_challenge_id uuid,
  p_expected_purpose text,
  p_auth_user_id uuid,
  p_room_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  challenge_row private.room_join_challenges;
begin
  select * into challenge_row
  from private.room_join_challenges
  where challenge_id = p_challenge_id
  for update;

  if not found
     or challenge_row.consumed_at is not null
     or challenge_row.expires_at <= now()
     or challenge_row.purpose <> p_expected_purpose
     or challenge_row.auth_user_id <> p_auth_user_id
     or challenge_row.room_id <> p_room_id then
    if found then
      update private.room_join_challenges
      set attempt_count = attempt_count + 1
      where challenge_id = p_challenge_id;
      perform private.record_bootstrap_attempt(
        challenge_row.auth_user_id,
        challenge_row.purpose,
        'CHALLENGE_INVALID'
      );
    end if;
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  return private.sharing_success(to_jsonb(challenge_row));
end;
$$;

drop function if exists public.create_room(uuid);

create or replace function public.create_room(
  p_room_id uuid,
  p_display_name text,
  p_member_restore_token text,
  p_challenge_id uuid
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
  challenge_row private.room_join_challenges;
  payload_row private.room_create_payload_challenges;
  payload_key_kind text;
  payload_key text;
  decrypted_payload bytea;
  payload_text text;
  payload_json jsonb;
  actual_fingerprint text;
  event_name text;
  v_host_member_id uuid;
  room_code text;
  alias_result jsonb;
  credential_result jsonb;
  attempt integer;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_room_id is null
     or p_challenge_id is null
     or p_member_restore_token !~ '^[A-Za-z0-9_-]{43}$'
     or nullif(btrim(p_display_name), '') is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  if private.get_current_secret_version('room_code') is null
     or private.get_current_secret_version('room_code_encryption') is null
     or private.get_current_secret_version('member_restore_lookup') is null
     or private.get_current_secret_version('member_restore_verify') is null then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  challenge_result := private.consume_bootstrap_challenge(
    p_challenge_id,
    'create_room',
    auth_user_id,
    p_room_id
  );
  if coalesce((challenge_result ->> 'ok')::boolean, false) = false then
    return challenge_result;
  end if;
  challenge_data := challenge_result -> 'data';

  select * into challenge_row
  from jsonb_populate_record(null::private.room_join_challenges, challenge_data);

  select * into payload_row
  from private.room_create_payload_challenges
  where id = challenge_row.create_payload_challenge_id
  for update;

  if not found
     or payload_row.consumed_at is not null
     or payload_row.expires_at <= now()
     or payload_row.auth_user_id <> auth_user_id
     or payload_row.client_room_id <> p_room_id
     or payload_row.plaintext_fingerprint <> challenge_row.create_payload_fingerprint then
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  payload_key_kind := case payload_row.payload_protection_mode
    when 'plaintext_local_fixture' then 'payload_fixture_encryption'
    else 'payload_encryption'
  end;
  payload_key := private.get_secret_value(payload_key_kind, payload_row.encryption_key_version);
  if payload_key is null then
    return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end if;

  begin
    decrypted_payload := extensions.pgp_sym_decrypt_bytea(
      payload_row.encrypted_payload,
      payload_key
    );
    actual_fingerprint := private.base64url(extensions.digest(decrypted_payload, 'sha256'));
    payload_text := convert_from(decrypted_payload, 'UTF8');
    payload_json := payload_text::jsonb;
  exception
    when others then
      return private.sharing_error('PAYLOAD_PROTECTION_REQUIRED');
  end;

  if actual_fingerprint <> payload_row.plaintext_fingerprint
     or payload_row.plaintext_fingerprint <> challenge_row.create_payload_fingerprint
     or payload_json ->> 'schemaVersion' <> '1'
     or jsonb_typeof(payload_json -> 'itemSnapshots') <> 'object' then
    return private.sharing_error('CHALLENGE_INVALID');
  end if;

  event_name := private.payload_text_field(
    payload_json,
    array['eventMetadata', 'eventName'],
    null
  );
  if event_name is null or length(event_name) > 200 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  begin
    insert into public.rooms(id, event_name, created_by)
    values (p_room_id, event_name, auth_user_id);

    insert into public.room_members(room_id, user_id, display_name, color, role, last_seen_at)
    values (
      p_room_id,
      auth_user_id,
      btrim(p_display_name),
      private.payload_text_field(payload_json, array['eventMetadata', 'hostColor'], null),
      'host',
      now()
    )
    returning id into v_host_member_id;

    update public.rooms
    set host_member_id = v_host_member_id
    where id = p_room_id;

    insert into public.room_event_data(
      room_id,
      schema_version,
      event_data,
      event_data_size_bytes
    )
    values (
      p_room_id,
      1,
      payload_json,
      payload_row.plaintext_size_bytes
    );

    insert into public.room_items(
      room_id,
      local_item_id,
      event_date,
      name,
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
      updated_by
    )
    select p_room_id,
           item.key,
           private.payload_text_field(item.value, array['eventDate'], null),
           coalesce(
             private.payload_text_field(item.value, array['title'], null),
             private.payload_text_field(item.value, array['circle'], null),
             item.key
           ),
           case
             when item.value ->> 'purchaseStatus' in (
               'None',
               'Purchased',
               'SoldOut',
               'Absent',
               'Postpone',
               'Late',
               'LimitedPurchase'
             ) then item.value ->> 'purchaseStatus'
             else 'None'
           end,
           private.payload_numeric_field(item.value, array['price'], null),
           greatest(private.payload_integer_field(item.value, array['quantity'], 1), 0),
           private.payload_integer_field(item.value, array['limitQuantity'], null),
           private.payload_integer_field(item.value, array['limitedPurchasedQuantity'], null),
           coalesce(private.payload_text_field(item.value, array['remarks'], ''), ''),
           private.payload_text_field(item.value, array['url'], null),
           v_host_member_id,
           null,
           null,
           coalesce((item.value ->> 'postponed')::boolean, false),
           0,
           v_host_member_id
    from jsonb_each(payload_json -> 'itemSnapshots') as item(key, value);

    credential_result := private.store_room_member_credential(
      v_host_member_id,
      p_member_restore_token
    );
    if coalesce((credential_result ->> 'ok')::boolean, false) = false then
      return credential_result;
    end if;

    for attempt in 1..20 loop
      room_code := private.generate_room_code();
      alias_result := private.create_room_code_aliases(p_room_id, room_code);
      if coalesce((alias_result ->> 'ok')::boolean, false) then
        exit;
      end if;
      room_code := null;
    end loop;

    if room_code is null then
      return private.sharing_error('ROOM_UNAVAILABLE');
    end if;

    update private.room_join_challenges
    set consumed_at = now()
    where challenge_id = p_challenge_id;

    update private.room_create_payload_challenges
    set consumed_at = now()
    where id = payload_row.id;
  exception
    when unique_violation then
      return private.sharing_error('ROOM_UNAVAILABLE');
    when check_violation then
      return private.sharing_error('INVALID_REQUEST');
    when foreign_key_violation then
      return private.sharing_error('INVALID_REQUEST');
  end;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomCode', room_code,
    'hostMemberId', v_host_member_id,
    'expiresAt', (select expires_at from public.rooms where id = p_room_id),
    'itemsVersion', 0,
    'routeOrderVersion', null,
    'routeOrderVersions', '{}'::jsonb,
    'tokenContext', 'restore:v1:' || p_room_id::text
  ));
end;
$$;

create or replace function public.join_room_by_code(
  p_challenge_id uuid,
  p_member_restore_token text,
  p_display_name text
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
  limit_result jsonb;
  credential_result jsonb;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_challenge_id is null
     or p_member_restore_token !~ '^[A-Za-z0-9_-]{43}$'
     or nullif(btrim(p_display_name), '') is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select c.room_id into v_room_id
  from private.room_join_challenges c
  where c.challenge_id = p_challenge_id;

  challenge_result := private.consume_bootstrap_challenge(
    p_challenge_id,
    'join',
    auth_user_id,
    v_room_id
  );
  if coalesce((challenge_result ->> 'ok')::boolean, false) = false then
    return challenge_result;
  end if;
  challenge_data := challenge_result -> 'data';
  v_room_id := (challenge_data ->> 'room_id')::uuid;

  limit_result := private.check_room_member_limit(v_room_id);
  if coalesce((limit_result ->> 'ok')::boolean, false) = false then
    return limit_result;
  end if;

  begin
    insert into public.room_members(room_id, user_id, display_name, role, last_seen_at)
    values (v_room_id, auth_user_id, btrim(p_display_name), 'member', now())
    returning id into member_id;

    credential_result := private.store_room_member_credential(
      member_id,
      p_member_restore_token
    );
    if coalesce((credential_result ->> 'ok')::boolean, false) = false then
      return credential_result;
    end if;

    update private.room_join_challenges
    set consumed_at = now()
    where challenge_id = p_challenge_id;
  exception
    when unique_violation then
      return private.sharing_error('RESTORE_REQUIRED');
  end;

  return private.sharing_success(jsonb_build_object(
    'roomId', v_room_id,
    'roomMemberId', member_id,
    'tokenContext', 'restore:v1:' || v_room_id::text
  ));
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
        'routeOrderVersions', '{}'::jsonb,
        'notificationWatermarkCreatedAt', (select created_at from notification_watermark),
        'notificationWatermarkId', (select id from notification_watermark),
        'createdAt', now()
      )
    ) as payload
    from room_row r
    join member_row m on true
    join public.room_event_data red on red.room_id = r.id
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
           null,
           '{}'::jsonb,
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

create or replace function public.ack_room_snapshot_watermark(
  p_room_id uuid,
  p_snapshot_receipt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_id uuid;
  receipt_row private.room_snapshot_receipts;
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

  select * into receipt_row
  from private.room_snapshot_receipts
  where id = p_snapshot_receipt_id
    and room_id = p_room_id
    and room_member_id = member_id
  for update;

  if not found or receipt_row.expires_at <= now() then
    return private.sharing_error('SNAPSHOT_RECEIPT_INVALID');
  end if;

  if receipt_row.acked_at is null then
    update private.room_snapshot_receipts
    set acked_at = now()
    where id = receipt_row.id;
  end if;

  insert into public.room_member_sync_state(
    room_member_id,
    room_id,
    last_snapshot_receipt_id,
    last_snapshot_ack_at,
    items_version,
    route_order_versions,
    last_processed_event_created_at,
    last_processed_event_id
  )
  values (
    member_id,
    p_room_id,
    receipt_row.id,
    now(),
    receipt_row.items_version,
    receipt_row.route_order_versions,
    receipt_row.notification_watermark_created_at,
    receipt_row.notification_watermark_id
  )
  on conflict (room_member_id) do update
    set last_snapshot_receipt_id = excluded.last_snapshot_receipt_id,
        last_snapshot_ack_at = excluded.last_snapshot_ack_at,
        items_version = greatest(
          public.room_member_sync_state.items_version,
          excluded.items_version
        ),
        route_order_versions = excluded.route_order_versions,
        last_processed_event_created_at = excluded.last_processed_event_created_at,
        last_processed_event_id = excluded.last_processed_event_id;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'snapshotReceiptId', receipt_row.id,
    'itemsVersion', receipt_row.items_version,
    'routeOrderVersions', receipt_row.route_order_versions
  ));
end;
$$;

create or replace function public.heartbeat_room_session(p_room_id uuid)
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

  member_id := private.require_active_room_member(p_room_id, auth_user_id);
  if member_id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('RESTORE_REQUIRED');
  end if;

  update public.room_members
  set last_seen_at = now()
  where id = member_id;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'lastSeenAt', now()
  ));
end;
$$;

revoke all on function public.create_room(uuid, text, text, uuid) from public;
revoke all on function public.join_room_by_code(uuid, text, text) from public;
revoke all on function public.restore_member_by_key(uuid, text) from public;
revoke all on function public.get_room_snapshot(uuid) from public;
revoke all on function public.ack_room_snapshot_watermark(uuid, uuid) from public;
revoke all on function public.heartbeat_room_session(uuid) from public;

grant execute on function public.create_room(uuid, text, text, uuid) to authenticated;
grant execute on function public.join_room_by_code(uuid, text, text) to authenticated;
grant execute on function public.restore_member_by_key(uuid, text) to authenticated;
grant execute on function public.get_room_snapshot(uuid) to authenticated;
grant execute on function public.ack_room_snapshot_watermark(uuid, uuid) to authenticated;
grant execute on function public.heartbeat_room_session(uuid) to authenticated;
