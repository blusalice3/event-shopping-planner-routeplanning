do $$
begin
  delete from private.room_create_payload_challenges
  where consumed_at is null
    and contract_version is distinct from 2;

  delete from private.room_join_challenges
  where consumed_at is null
    and contract_version is distinct from 2;

  if to_regprocedure('public.update_room_item_fields(uuid,text,jsonb)') is not null then
    execute 'revoke all on function public.update_room_item_fields(uuid, text, jsonb) from public';
    execute 'revoke all on function public.update_room_item_fields(uuid, text, jsonb) from anon';
    execute 'revoke all on function public.update_room_item_fields(uuid, text, jsonb) from authenticated';
    execute 'drop function public.update_room_item_fields(uuid, text, jsonb)';
  end if;

  if to_regprocedure('public.claim_item(uuid,text,text,integer)') is not null then
    execute 'revoke all on function public.claim_item(uuid, text, text, integer) from public';
    execute 'revoke all on function public.claim_item(uuid, text, text, integer) from anon';
    execute 'revoke all on function public.claim_item(uuid, text, text, integer) from authenticated';
    execute 'drop function public.claim_item(uuid, text, text, integer)';
  end if;

  if to_regprocedure('public.claim_item(uuid,text)') is not null then
    execute 'drop function public.claim_item(uuid, text)';
  end if;
end;
$$;
