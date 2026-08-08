begin;

create schema if not exists extensions;
create extension if not exists pg_cron with schema extensions;

revoke all
  on table public.persistence_release_a_metric_events
  from service_role;
revoke all
  on sequence public.persistence_release_a_metric_events_id_seq
  from service_role;
grant insert
  on table public.persistence_release_a_metric_events
  to service_role;
grant usage
  on sequence public.persistence_release_a_metric_events_id_seq
  to service_role;

revoke all
  on table public.persistence_release_a_metrics_dashboard_24h
  from service_role;
revoke all
  on table public.persistence_release_a_metrics_dashboard_hourly_24h
  from service_role;
revoke all
  on table public.persistence_release_a_cleanup_dashboard_24h
  from service_role;

create table if not exists public.csp_violation_reports (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default clock_timestamp(),
  schema_version smallint not null default 1
    check (schema_version = 1),
  effective_directive text not null
    check (
      effective_directive in (
        'base-uri',
        'child-src',
        'connect-src',
        'default-src',
        'font-src',
        'form-action',
        'frame-ancestors',
        'frame-src',
        'img-src',
        'manifest-src',
        'media-src',
        'object-src',
        'script-src',
        'script-src-attr',
        'script-src-elem',
        'style-src',
        'style-src-attr',
        'style-src-elem',
        'worker-src',
        'unknown'
      )
    ),
  disposition text not null
    check (disposition in ('enforce', 'report', 'unknown')),
  blocked_target text not null
    check (
      blocked_target in (
        'self',
        'data',
        'blob',
        'http',
        'https',
        'same-site',
        'cross-site',
        'inline',
        'eval',
        'unknown'
      )
    ),
  source_sha text not null
    check (source_sha ~ '^[0-9a-f]{40}$'),
  provider_deployment_id text not null
    check (
      length(provider_deployment_id) between 1 and 255
      and provider_deployment_id !~ '[[:cntrl:]]'
    )
);

create index if not exists csp_violation_reports_received_at_idx
  on public.csp_violation_reports (received_at desc);
create index if not exists csp_violation_reports_source_received_idx
  on public.csp_violation_reports (source_sha, received_at desc);

alter table public.csp_violation_reports enable row level security;
revoke all on table public.csp_violation_reports
  from public, anon, authenticated, service_role;
revoke all on sequence public.csp_violation_reports_id_seq
  from public, anon, authenticated, service_role;
grant insert on table public.csp_violation_reports
  to service_role;
grant usage on sequence public.csp_violation_reports_id_seq
  to service_role;

create table if not exists public.foundation_retention_run_audit (
  id bigint generated always as identity primary key,
  completed_at timestamptz not null default clock_timestamp(),
  target text not null
    check (target in ('persistence-release-a-metrics', 'csp-reports')),
  dry_run boolean not null,
  batch_count integer not null check (batch_count between 0 and 12),
  affected_rows bigint not null check (affected_rows >= 0),
  cutoff timestamptz not null,
  succeeded boolean not null,
  constraint foundation_retention_run_audit_success_check
    check (succeeded)
);

alter table public.foundation_retention_run_audit enable row level security;
revoke all on table public.foundation_retention_run_audit
  from public, anon, authenticated, service_role;
revoke all on sequence public.foundation_retention_run_audit_id_seq
  from public, anon, authenticated, service_role;

create or replace function public.read_persistence_release_a_metrics(
  requested_from timestamptz,
  requested_to timestamptz,
  requested_limit integer default 1000
)
returns table (
  received_at timestamptz,
  build_id text,
  browser_family text,
  app_mode text,
  online boolean,
  event_name text,
  outcome text,
  duration_bucket text,
  cleanup_mode text,
  cleanup_reason text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if requested_from is null
    or requested_to is null
    or requested_limit is null
    or requested_from >= requested_to
    or requested_to - requested_from > interval '31 days'
    or requested_limit < 1
    or requested_limit > 10000
  then
    raise exception 'invalid bounded metrics query' using errcode = '22023';
  end if;
  return query
    select
      metrics.received_at,
      metrics.build_id,
      metrics.browser_family,
      metrics.app_mode,
      metrics.online,
      metrics.event_name,
      metrics.outcome,
      metrics.duration_bucket,
      metrics.cleanup_mode,
      metrics.cleanup_reason
    from public.persistence_release_a_metric_events as metrics
    where metrics.received_at >= requested_from
      and metrics.received_at < requested_to
    order by metrics.received_at asc, metrics.id asc
    limit requested_limit;
end;
$$;

create or replace function public.read_csp_violation_aggregates(
  requested_from timestamptz,
  requested_to timestamptz,
  requested_limit integer default 1000
)
returns table (
  source_sha text,
  effective_directive text,
  disposition text,
  blocked_target text,
  violation_count bigint,
  first_received_at timestamptz,
  last_received_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if requested_from is null
    or requested_to is null
    or requested_limit is null
    or requested_from >= requested_to
    or requested_to - requested_from > interval '8 days'
    or requested_limit < 1
    or requested_limit > 1000
  then
    raise exception 'invalid bounded CSP query' using errcode = '22023';
  end if;
  return query
    select
      reports.source_sha,
      reports.effective_directive,
      reports.disposition,
      reports.blocked_target,
      count(*)::bigint,
      min(reports.received_at),
      max(reports.received_at)
    from public.csp_violation_reports as reports
    where reports.received_at >= requested_from
      and reports.received_at < requested_to
    group by
      reports.source_sha,
      reports.effective_directive,
      reports.disposition,
      reports.blocked_target
    order by count(*) desc, reports.effective_directive asc
    limit requested_limit;
end;
$$;

create or replace function public.retain_persistence_release_a_metrics(
  requested_dry_run boolean default true,
  requested_batch_size integer default 5000,
  requested_max_batches integer default 12
)
returns table (
  cutoff timestamptz,
  affected_rows bigint,
  batch_count integer,
  dry_run boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  retention_cutoff timestamptz := clock_timestamp() - interval '30 days';
  current_batch_count integer := 0;
  current_affected_rows bigint := 0;
  total_affected_rows bigint := 0;
begin
  if requested_dry_run is null
    or requested_batch_size is null
    or requested_max_batches is null
    or requested_batch_size < 1
    or requested_batch_size > 5000
    or requested_max_batches < 1
    or requested_max_batches > 12
  then
    raise exception 'retention bound exceeded' using errcode = '22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'event-shopping-planner:persistence-release-a-retention',
    0
  )) then
    raise exception 'retention run already active' using errcode = '55P03';
  end if;
  perform set_config('lock_timeout', '1000ms', true);
  perform set_config('statement_timeout', '15000ms', true);

  if requested_dry_run then
    select count(*)::bigint
      into total_affected_rows
      from (
        select id
        from public.persistence_release_a_metric_events
        where received_at < retention_cutoff
        order by id
        limit requested_batch_size * requested_max_batches
      ) as candidates;
  else
    loop
      exit when current_batch_count >= requested_max_batches;
      with candidates as (
        select id
        from public.persistence_release_a_metric_events
        where received_at < retention_cutoff
        order by id
        limit requested_batch_size
        for update skip locked
      )
      delete from public.persistence_release_a_metric_events as metrics
      using candidates
      where metrics.id = candidates.id;
      get diagnostics current_affected_rows = row_count;
      total_affected_rows := total_affected_rows + current_affected_rows;
      current_batch_count := current_batch_count + 1;
      exit when current_affected_rows < requested_batch_size;
    end loop;
    insert into public.foundation_retention_run_audit (
      target,
      dry_run,
      batch_count,
      affected_rows,
      cutoff,
      succeeded
    ) values (
      'persistence-release-a-metrics',
      false,
      current_batch_count,
      total_affected_rows,
      retention_cutoff,
      true
    );
  end if;

  return query
    select
      retention_cutoff,
      total_affected_rows,
      current_batch_count,
      requested_dry_run;
end;
$$;

create or replace function public.retain_csp_violation_reports(
  requested_dry_run boolean default true,
  requested_batch_size integer default 5000,
  requested_max_batches integer default 12
)
returns table (
  cutoff timestamptz,
  affected_rows bigint,
  batch_count integer,
  dry_run boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  retention_cutoff timestamptz := clock_timestamp() - interval '7 days';
  current_batch_count integer := 0;
  current_affected_rows bigint := 0;
  total_affected_rows bigint := 0;
begin
  if requested_dry_run is null
    or requested_batch_size is null
    or requested_max_batches is null
    or requested_batch_size < 1
    or requested_batch_size > 5000
    or requested_max_batches < 1
    or requested_max_batches > 12
  then
    raise exception 'retention bound exceeded' using errcode = '22023';
  end if;
  if not pg_try_advisory_xact_lock(hashtextextended(
    'event-shopping-planner:csp-retention',
    0
  )) then
    raise exception 'retention run already active' using errcode = '55P03';
  end if;
  perform set_config('lock_timeout', '1000ms', true);
  perform set_config('statement_timeout', '15000ms', true);

  if requested_dry_run then
    select count(*)::bigint
      into total_affected_rows
      from (
        select id
        from public.csp_violation_reports
        where received_at < retention_cutoff
        order by id
        limit requested_batch_size * requested_max_batches
      ) as candidates;
  else
    loop
      exit when current_batch_count >= requested_max_batches;
      with candidates as (
        select id
        from public.csp_violation_reports
        where received_at < retention_cutoff
        order by id
        limit requested_batch_size
        for update skip locked
      )
      delete from public.csp_violation_reports as reports
      using candidates
      where reports.id = candidates.id;
      get diagnostics current_affected_rows = row_count;
      total_affected_rows := total_affected_rows + current_affected_rows;
      current_batch_count := current_batch_count + 1;
      exit when current_affected_rows < requested_batch_size;
    end loop;
    insert into public.foundation_retention_run_audit (
      target,
      dry_run,
      batch_count,
      affected_rows,
      cutoff,
      succeeded
    ) values (
      'csp-reports',
      false,
      current_batch_count,
      total_affected_rows,
      retention_cutoff,
      true
    );
  end if;

  return query
    select
      retention_cutoff,
      total_affected_rows,
      current_batch_count,
      requested_dry_run;
end;
$$;

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
revoke all on function public.retain_persistence_release_a_metrics(
  boolean,
  integer,
  integer
) from public, anon, authenticated, service_role;
revoke all on function public.retain_csp_violation_reports(
  boolean,
  integer,
  integer
) from public, anon, authenticated, service_role;

comment on table public.csp_violation_reports is
  'Dormant sanitized CSP report storage; no application grant before Phase 2B.';
comment on function public.read_persistence_release_a_metrics is
  'Bounded operator-only Release A metrics read API.';
comment on function public.read_csp_violation_aggregates is
  'Bounded operator-only privacy-safe CSP aggregate API.';

select cron.schedule(
  'event-shopping-planner-foundation-retention-v1',
  '17 * * * *',
  $retention$
    select *
    from public.retain_persistence_release_a_metrics(false, 5000, 12);
    select *
    from public.retain_csp_violation_reports(false, 5000, 12);
  $retention$
);

commit;
