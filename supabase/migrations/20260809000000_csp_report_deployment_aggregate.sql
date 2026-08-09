begin;

create index if not exists csp_violation_reports_deployment_received_idx
  on public.csp_violation_reports (
    source_sha,
    provider_deployment_id,
    received_at desc
  );

create or replace function public.read_csp_deployment_violation_aggregates(
  requested_from timestamptz,
  requested_to timestamptz,
  requested_source_sha text,
  requested_provider_deployment_id text,
  requested_limit integer default 1000
)
returns table (
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
    or requested_source_sha is null
    or requested_provider_deployment_id is null
    or requested_limit is null
    or requested_from >= requested_to
    or requested_to - requested_from > interval '8 days'
    or requested_source_sha !~ '^[0-9a-f]{40}$'
    or length(requested_provider_deployment_id) not between 1 and 255
    or requested_provider_deployment_id ~ '[[:cntrl:]]'
    or requested_limit < 1
    or requested_limit > 1000
  then
    raise exception 'invalid bounded deployment CSP query'
      using errcode = '22023';
  end if;

  return query
    select
      reports.effective_directive,
      reports.disposition,
      reports.blocked_target,
      count(*)::bigint,
      min(reports.received_at),
      max(reports.received_at)
    from public.csp_violation_reports as reports
    where reports.received_at >= requested_from
      and reports.received_at < requested_to
      and reports.source_sha = requested_source_sha
      and reports.provider_deployment_id = requested_provider_deployment_id
    group by
      reports.effective_directive,
      reports.disposition,
      reports.blocked_target
    order by
      count(*) desc,
      reports.effective_directive asc,
      reports.disposition asc,
      reports.blocked_target asc
    limit requested_limit;
end;
$$;

revoke all on function public.read_csp_deployment_violation_aggregates(
  timestamptz,
  timestamptz,
  text,
  text,
  integer
) from public, anon, authenticated, service_role;

comment on function public.read_csp_deployment_violation_aggregates is
  'Deployment and source-bound bounded operator-only CSP aggregate API.';

commit;
