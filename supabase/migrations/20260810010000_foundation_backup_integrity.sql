begin;

create or replace function public.read_foundation_backup_restore_integrity()
returns table (
  database_head text,
  migration_version text,
  integrity_sha256 text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with migration_authority as (
    select
      coalesce(string_agg(migration.version, E'\n' order by migration.version), '')
        as manifest,
      coalesce(max(migration.version), '') as migration_version
    from supabase_migrations.schema_migrations migration
  ),
  metric_authority as (
    select
      count(*)::text as row_count,
      encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(string_agg(row_sha256, '' order by row_sha256), ''),
            'UTF8'
          )
        ),
        'hex'
      ) as table_sha256
    from (
      select encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(to_jsonb(metric)::text, 'UTF8')
        ),
        'hex'
      ) as row_sha256
      from public.persistence_release_a_metric_events metric
    ) metric_rows
  ),
  csp_authority as (
    select
      count(*)::text as row_count,
      encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(string_agg(row_sha256, '' order by row_sha256), ''),
            'UTF8'
          )
        ),
        'hex'
      ) as table_sha256
    from (
      select encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(to_jsonb(report)::text, 'UTF8')
        ),
        'hex'
      ) as row_sha256
      from public.csp_violation_reports report
    ) csp_rows
  ),
  retention_authority as (
    select
      count(*)::text as row_count,
      encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            coalesce(string_agg(row_sha256, '' order by row_sha256), ''),
            'UTF8'
          )
        ),
        'hex'
      ) as table_sha256
    from (
      select encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(to_jsonb(audit)::text, 'UTF8')
        ),
        'hex'
      ) as row_sha256
      from public.foundation_retention_run_audit audit
    ) retention_rows
  )
  select
    encode(
      pg_catalog.sha256(pg_catalog.convert_to(migration.manifest, 'UTF8')),
      'hex'
    ) as database_head,
    migration.migration_version,
    encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          jsonb_build_object(
            'migration_manifest', migration.manifest,
            'metrics_count', metric.row_count,
            'metrics_sha256', metric.table_sha256,
            'csp_count', csp.row_count,
            'csp_sha256', csp.table_sha256,
            'retention_count', retention.row_count,
            'retention_sha256', retention.table_sha256
          )::text,
          'UTF8'
        )
      ),
      'hex'
    ) as integrity_sha256
  from migration_authority migration
  cross join metric_authority metric
  cross join csp_authority csp
  cross join retention_authority retention;
$$;

revoke execute on all functions in schema public from public;
alter default privileges in schema public
  revoke execute on functions from public;

revoke all on function public.read_foundation_backup_restore_integrity()
  from public, anon, authenticated, service_role, foundation_db_observer;

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'foundation_backup_source_reader',
    'foundation_backup_restore_reader'
  ]
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = role_name
    ) then
      raise exception
        using
          errcode = '42710',
          message = format('%s role already exists', role_name);
    end if;
    execute format(
      'create role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
      role_name
    );
    execute format(
      'alter role %I set default_transaction_read_only = on',
      role_name
    );
    execute format('alter role %I set statement_timeout = %L', role_name, '15s');
    execute format('revoke all on schema public from %I', role_name);
    execute format('grant usage on schema public to %I', role_name);
    execute format(
      'revoke all on all tables in schema public from %I',
      role_name
    );
    execute format(
      'revoke all on all sequences in schema public from %I',
      role_name
    );
    execute format(
      'revoke all on all functions in schema public from %I',
      role_name
    );
    execute format(
      'grant execute on function public.read_foundation_backup_restore_integrity() to %I',
      role_name
    );
    execute format(
      'grant connect on database %I to %I',
      current_database(),
      role_name
    );
  end loop;
end;
$$;

comment on function public.read_foundation_backup_restore_integrity is
  'Security-definer migration and bounded data fingerprint for source/new-project restore comparison.';
comment on role foundation_backup_source_reader is
  'Passwordless-at-migration source integrity reader; set a unique secret out of band.';
comment on role foundation_backup_restore_reader is
  'Passwordless-at-migration restored-project integrity reader; reset a distinct secret after physical clone.';

commit;
