-- Allow the room host to leave by closing the shared room.

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
  next_room_status text := 'active';
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

  update public.room_members
  set membership_status = 'left',
      left_at = left_at_value,
      last_seen_at = null,
      paused_at = null
  where id = member_row.id;

  if member_row.role = 'host' then
    next_room_status := 'closed';

    update public.rooms
    set sharing_status = 'closed',
        expires_at = least(expires_at, left_at_value)
    where id = p_room_id
      and sharing_status = 'active';
  end if;

  insert into public.activity_log(room_id, room_member_id, auth_user_id, action, metadata)
  values (
    p_room_id,
    member_row.id,
    auth_user_id,
    'leave_room',
    jsonb_build_object(
      'mode', p_mode,
      'role', member_row.role,
      'roomStatus', next_room_status
    )
  );

  return private.sharing_success(jsonb_build_object(
    'roomId', p_room_id,
    'roomMemberId', member_row.id,
    'membershipStatus', 'left',
    'leftAt', left_at_value,
    'roomStatus', next_room_status
  ));
end;
$$;

revoke all on function public.leave_room(uuid, text) from public;
grant execute on function public.leave_room(uuid, text) to authenticated;
