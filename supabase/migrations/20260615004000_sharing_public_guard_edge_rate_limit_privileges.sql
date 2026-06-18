-- [PUBLIC-GUARD] Keep Edge rate limit internals callable only by service_role.

revoke all on function public.guard_check_edge_rate_limit_internal(
  uuid,
  text,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.guard_check_edge_rate_limit_internal(
  uuid,
  text,
  text,
  text,
  text
) to service_role;
