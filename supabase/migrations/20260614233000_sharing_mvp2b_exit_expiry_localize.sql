-- [MVP-2b] Exit, temporary pause, expired-room cleanup, and display profiles.

alter table public.room_members
  add column if not exists paused_at timestamptz;

create table if not exists private.expired_room_cleanup_runs (
  id bigint generated always as identity primary key,
  room_id uuid not null,
  cutoff_at timestamptz not null,
  status text not null check (status in ('completed', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(counts) = 'object')
);

revoke all on table private.expired_room_cleanup_runs from anon, authenticated;

create or replace function private.current_active_room_member(p_room_id uuid)
returns public.room_members
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_row public.room_members;
begin
  if auth_user_id is null then
    return null;
  end if;

  select rm.* into member_row
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = p_room_id
    and rm.user_id = auth_user_id
    and rm.membership_status = 'active'
    and r.sharing_status = 'active'
    and r.expires_at > now();

  return member_row;
end;
$$;

create or replace function public.pause_room_session(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_row public.room_members;
  paused_at_value timestamptz := now();
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_room_id is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_row := private.current_active_room_member(p_room_id);
  if member_row.id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  update public.room_members
  set paused_at = paused_at_value,
      last_seen_at = null
  where id = member_row.id;

  insert into public.activity_log(room_id, room_member_id, auth_user_id, action, metadata)
  values (
    p_room_id,
    member_row.id,
    auth_user_id,
    'pause_room_session',
    jsonb_build_object('membershipStatus', member_row.membership_status)
  );

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_row.id,
    'pausedAt', paused_at_value
  ));
end;
$$;

create or replace function public.leave_room(
  p_room_id uuid,
  p_mode text default 'final'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_row public.room_members;
  left_at_value timestamptz := now();
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_room_id is null or p_mode is distinct from 'final' then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  member_row := private.current_active_room_member(p_room_id);
  if member_row.id is null then
    if exists (select 1 from public.rooms where id = p_room_id and expires_at <= now()) then
      return private.sharing_error('ROOM_EXPIRED');
    end if;
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  if member_row.role = 'host' then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  update public.room_members
  set membership_status = 'left',
      left_at = left_at_value,
      last_seen_at = null,
      paused_at = null
  where id = member_row.id;

  insert into public.activity_log(room_id, room_member_id, auth_user_id, action, metadata)
  values (
    p_room_id,
    member_row.id,
    auth_user_id,
    'leave_room',
    jsonb_build_object('mode', p_mode)
  );

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_row.id,
    'membershipStatus', 'left',
    'leftAt', left_at_value
  ));
end;
$$;

create or replace function public.get_room_members_for_display(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  auth_user_id uuid := auth.uid();
  member_row public.room_members;
begin
  if auth_user_id is null then
    return private.sharing_error('AUTH_REQUIRED');
  end if;

  if p_room_id is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  update public.rooms
  set sharing_status = 'expired'
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at <= now();

  select rm.* into member_row
  from public.room_members rm
  join public.rooms r on r.id = rm.room_id
  where rm.room_id = p_room_id
    and rm.user_id = auth_user_id
    and rm.membership_status in ('active', 'left')
    and r.sharing_status in ('active', 'expired', 'closed');

  if member_row.id is null then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
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
    ), '[]'::jsonb)
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
  seen_at timestamptz := now();
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
  set last_seen_at = seen_at,
      paused_at = null
  where id = member_id;

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_id,
    'lastSeenAt', seen_at
  ));
end;
$$;

create or replace function public.expire_room_for_cleanup(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  room_row public.rooms;
begin
  if not private.guard_service_role_claim_ok() then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  if p_room_id is null then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  update public.rooms
  set sharing_status = 'expired'
  where id = p_room_id
    and sharing_status = 'active'
    and expires_at <= now()
  returning * into room_row;

  if room_row.id is null then
    select * into room_row from public.rooms where id = p_room_id;
  end if;

  if room_row.id is null then
    return private.sharing_error('ROOM_UNAVAILABLE');
  end if;

  return private.sharing_success(jsonb_build_object(
    'roomId', room_row.id,
    'sharingStatus', room_row.sharing_status,
    'expiresAt', room_row.expires_at
  ));
end;
$$;

create or replace function public.cleanup_expired_room_data(
  p_room_id uuid default null,
  p_retention_hours integer default 72,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff_at_value timestamptz;
  room_record record;
  room_count integer := 0;
  total_counts jsonb := '{}'::jsonb;
  deleted_count integer;
begin
  if not private.guard_service_role_claim_ok() then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  if p_retention_hours is null
     or p_retention_hours < 0
     or p_retention_hours > 8760
     or p_limit is null
     or p_limit < 1
     or p_limit > 500 then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  cutoff_at_value := now() - make_interval(hours => p_retention_hours);

  for room_record in
    select r.id
    from public.rooms r
    where (p_room_id is null or r.id = p_room_id)
      and r.expires_at <= cutoff_at_value
      and r.sharing_status in ('active', 'expired', 'closed')
    order by r.expires_at asc, r.id asc
    limit p_limit
  loop
    room_count := room_count + 1;

    update public.rooms
    set sharing_status = 'expired'
    where id = room_record.id
      and sharing_status = 'active';

    with deleted as (
      delete from public.notification_delivery_state
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{notificationDeliveryState}', to_jsonb(coalesce((total_counts ->> 'notificationDeliveryState')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from public.room_member_sync_state
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomMemberSyncState}', to_jsonb(coalesce((total_counts ->> 'roomMemberSyncState')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from public.room_item_change_log
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomItemChangeLog}', to_jsonb(coalesce((total_counts ->> 'roomItemChangeLog')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from public.notifications
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{notifications}', to_jsonb(coalesce((total_counts ->> 'notifications')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from public.room_items
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomItems}', to_jsonb(coalesce((total_counts ->> 'roomItems')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from public.room_event_data
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomEventData}', to_jsonb(coalesce((total_counts ->> 'roomEventData')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from private.room_snapshot_receipts
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{snapshotReceipts}', to_jsonb(coalesce((total_counts ->> 'snapshotReceipts')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from private.room_join_challenges
      where room_id = room_record.id
         or create_payload_challenge_id in (
           select id
           from private.room_create_payload_challenges
           where client_room_id = room_record.id
         )
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomJoinChallenges}', to_jsonb(coalesce((total_counts ->> 'roomJoinChallenges')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from private.room_create_payload_challenges
      where client_room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{createPayloadChallenges}', to_jsonb(coalesce((total_counts ->> 'createPayloadChallenges')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from private.room_member_credentials
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomMemberCredentials}', to_jsonb(coalesce((total_counts ->> 'roomMemberCredentials')::integer, 0) + deleted_count), true);

    with deleted as (
      delete from private.room_code_digest_aliases
      where room_id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{roomCodeDigestAliases}', to_jsonb(coalesce((total_counts ->> 'roomCodeDigestAliases')::integer, 0) + deleted_count), true);

    delete from private.room_code_sealed_codes
    where room_id = room_record.id;

    with deleted as (
      delete from public.rooms
      where id = room_record.id
      returning 1
    )
    select count(*) into deleted_count from deleted;
    total_counts := jsonb_set(total_counts, '{rooms}', to_jsonb(coalesce((total_counts ->> 'rooms')::integer, 0) + deleted_count), true);

    insert into private.expired_room_cleanup_runs(room_id, cutoff_at, status, counts)
    values (room_record.id, cutoff_at_value, 'completed', total_counts);
  end loop;

  return private.sharing_success(jsonb_build_object(
    'roomCount', room_count,
    'cutoffAt', cutoff_at_value,
    'counts', total_counts
  ));
exception
  when others then
    if room_record.id is not null then
      insert into private.expired_room_cleanup_runs(room_id, cutoff_at, status, counts, error_code)
      values (room_record.id, cutoff_at_value, 'failed', total_counts, SQLSTATE);
    end if;
    return private.sharing_error('SHARING_INTERNAL_ERROR');
end;
$$;

revoke all on function public.pause_room_session(uuid) from public;
revoke all on function public.leave_room(uuid, text) from public;
revoke all on function public.get_room_members_for_display(uuid) from public;
revoke all on function public.heartbeat_room_session(uuid) from public;
revoke all on function public.expire_room_for_cleanup(uuid) from public;
revoke all on function public.cleanup_expired_room_data(uuid, integer, integer) from public;

grant execute on function public.pause_room_session(uuid) to authenticated;
grant execute on function public.leave_room(uuid, text) to authenticated;
grant execute on function public.get_room_members_for_display(uuid) to authenticated;
grant execute on function public.heartbeat_room_session(uuid) to authenticated;
grant execute on function public.expire_room_for_cleanup(uuid) to service_role;
grant execute on function public.cleanup_expired_room_data(uuid, integer, integer) to service_role;
