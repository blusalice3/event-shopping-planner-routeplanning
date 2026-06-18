begin;

select plan(10);

select has_table(
  'private',
  'guard_edge_rate_limit_buckets',
  'public Guard creates private Edge rate limit bucket table'
);

select has_function(
  'public',
  'guard_check_edge_rate_limit_internal',
  array['uuid', 'text', 'text', 'text', 'text'],
  'public Guard Edge rate limit RPC exists'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.guard_check_edge_rate_limit_internal(uuid, text, text, text, text)',
    'execute'
  ),
  'authenticated cannot execute public Guard Edge rate limit RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.guard_check_edge_rate_limit_internal(uuid, text, text, text, text)',
    'execute'
  ),
  'service_role can execute public Guard Edge rate limit RPC'
);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',
  true
);

select is(
  public.guard_check_edge_rate_limit_internal(
    '11111111-1111-4111-8111-111111111111',
    'join',
    repeat('a', 64),
    repeat('b', 64),
    repeat('c', 64)
  ) #>> '{error,code}',
  'PERMISSION_DENIED',
  'public Guard Edge rate limit rejects missing service_role JWT claim'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"00000000-0000-4000-8000-000000000000"}',
  true
);

update private.sharing_runtime_config
set bootstrap_attempt_window_seconds = 300,
    bootstrap_attempt_limit = 2;

select ok(
  (
    public.guard_check_edge_rate_limit_internal(
      '11111111-1111-4111-8111-111111111111',
      'join',
      repeat('a', 64),
      repeat('b', 64),
      repeat('c', 64)
    ) ->> 'ok'
  )::boolean,
  'public Guard Edge rate limit accepts first attempt'
);

select ok(
  (
    public.guard_check_edge_rate_limit_internal(
      '11111111-1111-4111-8111-111111111111',
      'join',
      repeat('a', 64),
      repeat('b', 64),
      repeat('c', 64)
    ) ->> 'ok'
  )::boolean,
  'public Guard Edge rate limit accepts second attempt within limit'
);

create temp table public_guard_rate_limited_result as
select public.guard_check_edge_rate_limit_internal(
  '11111111-1111-4111-8111-111111111111',
  'join',
  repeat('a', 64),
  repeat('b', 64),
  repeat('c', 64)
) as value;

select is(
  (select value #>> '{error,code}' from public_guard_rate_limited_result),
  'RATE_LIMITED',
  'public Guard Edge rate limit rejects third attempt'
);

select is(
  (select (value #>> '{error,retry_after_seconds}')::integer from public_guard_rate_limited_result),
  300,
  'public Guard Edge rate limit returns retry_after_seconds'
);

select is(
  (
    select count(*)::integer
    from private.guard_edge_rate_limit_buckets
    where purpose = 'join'
      and bucket_hash in (repeat('a', 64), repeat('b', 64), repeat('c', 64))
  ),
  3,
  'public Guard Edge rate limit records IP, device, and session buckets'
);

select * from finish();

rollback;
