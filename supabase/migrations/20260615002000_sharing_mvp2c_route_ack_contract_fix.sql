-- [MVP-2c] Keep route-order sync progress monotonic and expose enabled route version.

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
    'routeOrderVersion', (select route_order_version from public.rooms where id = p_room_id),
    'routeOrderVersions', '{}'::jsonb,
    'tokenContext', 'restore:v1:' || p_room_id::text
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
  stored_route_order_versions jsonb;
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
    set route_order_versions = (
      select coalesce(jsonb_object_agg(merged.event_date, merged.version), '{}'::jsonb)
      from (
        select event_date, max(version) as version
        from (
          select existing.key as event_date,
                 (existing.value #>> '{}')::bigint as version
          from jsonb_each(public.room_member_sync_state.route_order_versions) existing(key, value)
          where jsonb_typeof(existing.value) = 'number'
          union all
          select requested.key as event_date,
                 (requested.value #>> '{}')::bigint as version
          from jsonb_each(excluded.route_order_versions) requested(key, value)
          where jsonb_typeof(requested.value) = 'number'
        ) combined
        group by event_date
      ) merged
    )
  returning route_order_versions into stored_route_order_versions;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'routeOrderVersions', stored_route_order_versions
  ));
end;
$$;

revoke all on function public.create_room(uuid, text, text, uuid) from public;
revoke all on function public.ack_room_route_order_versions(uuid, jsonb) from public;

grant execute on function public.create_room(uuid, text, text, uuid) to authenticated;
grant execute on function public.ack_room_route_order_versions(uuid, jsonb) to authenticated;
