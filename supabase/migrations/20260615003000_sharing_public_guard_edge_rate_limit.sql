-- [PUBLIC-GUARD] Edge-visible rate limit buckets for public Guard bootstrap.

create table if not exists private.guard_edge_rate_limit_buckets (
  purpose text not null check (purpose in ('create_room', 'join', 'restore')),
  bucket_scope text not null check (bucket_scope in ('ip', 'device', 'session')),
  bucket_hash text not null check (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_start timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (purpose, bucket_scope, bucket_hash)
);

create index if not exists guard_edge_rate_limit_updated_idx
  on private.guard_edge_rate_limit_buckets(updated_at);

create or replace function public.guard_check_edge_rate_limit_internal(
  p_auth_user_id uuid,
  p_purpose text,
  p_ip_hash text default null,
  p_device_hash text default null,
  p_session_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg private.sharing_runtime_config;
  bucket record;
  next_count integer;
begin
  if not private.guard_service_role_claim_ok() then
    return private.sharing_error('PERMISSION_DENIED');
  end if;

  if p_auth_user_id is null or p_purpose not in ('create_room', 'join', 'restore') then
    return private.sharing_error('INVALID_REQUEST');
  end if;

  select * into cfg from private.get_sharing_runtime_config();
  if not found then
    return private.sharing_error('SHARING_DISABLED');
  end if;

  delete from private.guard_edge_rate_limit_buckets
  where updated_at < now() - make_interval(secs => cfg.bootstrap_attempt_window_seconds * 4);

  for bucket in
    select *
    from (
      values
        ('ip', p_ip_hash),
        ('device', p_device_hash),
        ('session', coalesce(p_session_hash, encode(extensions.digest(convert_to(p_auth_user_id::text, 'UTF8'), 'sha256'), 'hex')))
    ) as buckets(bucket_scope, bucket_hash)
    where bucket_hash ~ '^[a-f0-9]{64}$'
  loop
    insert into private.guard_edge_rate_limit_buckets(
      purpose,
      bucket_scope,
      bucket_hash,
      window_start,
      attempt_count,
      updated_at
    )
    values (
      p_purpose,
      bucket.bucket_scope,
      bucket.bucket_hash,
      now(),
      1,
      now()
    )
    on conflict (purpose, bucket_scope, bucket_hash)
    do update set
      window_start = case
        when private.guard_edge_rate_limit_buckets.window_start < now() - make_interval(secs => cfg.bootstrap_attempt_window_seconds)
          then now()
        else private.guard_edge_rate_limit_buckets.window_start
      end,
      attempt_count = case
        when private.guard_edge_rate_limit_buckets.window_start < now() - make_interval(secs => cfg.bootstrap_attempt_window_seconds)
          then 1
        else private.guard_edge_rate_limit_buckets.attempt_count + 1
      end,
      updated_at = now()
    returning attempt_count into next_count;

    if next_count > cfg.bootstrap_attempt_limit then
      return private.sharing_error('RATE_LIMITED', cfg.bootstrap_attempt_window_seconds);
    end if;
  end loop;

  return private.sharing_success();
end;
$$;

revoke all on table private.guard_edge_rate_limit_buckets from anon, authenticated;
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
