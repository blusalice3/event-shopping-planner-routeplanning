-- [MVP-2b] Allow former room members to save display profiles before localizing expired rooms.

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

revoke all on function public.get_room_members_for_display(uuid) from public;
grant execute on function public.get_room_members_for_display(uuid) to authenticated;
