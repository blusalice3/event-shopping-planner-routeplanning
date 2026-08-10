begin;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'foundation_db_observer'
  ) then
    raise exception
      using
        errcode = '42710',
        message = 'foundation_db_observer role already exists';
  end if;
  create role foundation_db_observer
    login
    noinherit
    nosuperuser
    nocreatedb
    nocreaterole
    noreplication
    nobypassrls;
end;
$$;
alter role foundation_db_observer
  set default_transaction_read_only = on;
alter role foundation_db_observer
  set statement_timeout = '15s';

revoke create on schema public from public;
revoke all on all tables in schema public from public;
revoke all on all sequences in schema public from public;
revoke execute on all functions in schema public from public;
alter default privileges
  revoke execute on functions from public;
alter default privileges in schema public
  revoke all on tables from public;
alter default privileges in schema public
  revoke all on sequences from public;
alter default privileges in schema public
  revoke execute on functions from public;

revoke all on schema public from foundation_db_observer;
grant usage on schema public to foundation_db_observer;

revoke all
  on all tables in schema public
  from foundation_db_observer;
revoke all
  on all sequences in schema public
  from foundation_db_observer;
revoke all
  on all functions in schema public
  from foundation_db_observer;

revoke all on schema supabase_migrations from foundation_db_observer;
grant usage on schema supabase_migrations to foundation_db_observer;
revoke all
  on all tables in schema supabase_migrations
  from foundation_db_observer;
revoke all
  on all sequences in schema supabase_migrations
  from foundation_db_observer;
revoke all
  on all functions in schema supabase_migrations
  from foundation_db_observer;
revoke all on all tables in schema supabase_migrations from public;
revoke all on all sequences in schema supabase_migrations from public;
revoke execute on all functions in schema supabase_migrations from public;
alter default privileges in schema supabase_migrations
  revoke all on tables from public;
alter default privileges in schema supabase_migrations
  revoke all on sequences from public;
alter default privileges in schema supabase_migrations
  revoke execute on functions from public;
grant select on table supabase_migrations.schema_migrations
  to foundation_db_observer;

revoke all on function public.read_persistence_release_a_metrics(
  timestamptz,
  timestamptz,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.read_csp_violation_aggregates(
  timestamptz,
  timestamptz,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.read_csp_deployment_violation_aggregates(
  timestamptz,
  timestamptz,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;

grant execute on function public.read_persistence_release_a_metrics(
  timestamptz,
  timestamptz,
  integer
) to foundation_db_observer;
grant execute on function public.read_csp_violation_aggregates(
  timestamptz,
  timestamptz,
  integer
) to foundation_db_observer;
grant execute on function public.read_csp_deployment_violation_aggregates(
  timestamptz,
  timestamptz,
  text,
  text,
  integer
) to foundation_db_observer;

do $$
begin
  execute format(
    'revoke create on database %I from foundation_db_observer',
    current_database()
  );
  execute format(
    'grant connect on database %I to foundation_db_observer',
    current_database()
  );
end;
$$;

comment on role foundation_db_observer is
  'Passwordless-at-migration least-privilege production compatibility observer; set its secret out of band.';

commit;
