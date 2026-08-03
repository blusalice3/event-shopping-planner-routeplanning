create table if not exists public.persistence_release_a_metric_events (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  schema_version smallint not null,
  event_version smallint not null,
  event_name text not null,
  outcome text not null,
  duration_bucket text,
  cleanup_mode text,
  cleanup_reason text,
  build_id text not null,
  browser_family text not null,
  app_mode text not null,
  online boolean not null,
  constraint persistence_release_a_metric_schema_version_check
    check (schema_version = 1),
  constraint persistence_release_a_metric_event_version_check
    check (event_version = 1),
  constraint persistence_release_a_metric_name_check
    check (
      event_name in (
        'checkpoint-adoption',
        'fallback-repair',
        'load',
        'save',
        'startup',
        'cleanup'
      )
    ),
  constraint persistence_release_a_metric_outcome_check
    check (
      (
        event_name = 'checkpoint-adoption'
        and outcome in (
          'adopted',
          'already-absorbed',
          'not-needed',
          'failed',
          'conflict'
        )
      )
      or (
        event_name = 'fallback-repair'
        and outcome in ('succeeded', 'failed', 'conflict')
      )
      or (
        event_name = 'load'
        and outcome in ('succeeded', 'missing', 'failed', 'conflict')
      )
      or (
        event_name = 'save'
        and outcome in ('succeeded', 'failed')
      )
      or (
        event_name = 'startup'
        and outcome in ('ready', 'recovery-required')
      )
      or (
        event_name = 'cleanup'
        and outcome in (
          'attempted',
          'task-started',
          'deferred',
          'blocked',
          'completed',
          'key-confirmed-removed',
          'physical-deferred',
          'physical-blocked'
        )
      )
    ),
  constraint persistence_release_a_metric_duration_check
    check (
      (
        event_name = 'startup'
        and duration_bucket is not null
        and duration_bucket in (
          'lt-250ms',
          '250-999ms',
          '1-2999ms',
          '3-9999ms',
          'gte-10s'
        )
      )
      or (event_name <> 'startup' and duration_bucket is null)
    ),
  constraint persistence_release_a_metric_cleanup_mode_check
    check (
      (
        event_name = 'cleanup'
        and cleanup_mode is not null
        and cleanup_mode in ('auto', 'manual')
      )
      or (event_name <> 'cleanup' and cleanup_mode is null)
    ),
  constraint persistence_release_a_metric_cleanup_reason_check
    check (
      (
        event_name = 'cleanup'
        and outcome in (
          'attempted',
          'task-started',
          'completed',
          'key-confirmed-removed'
        )
        and cleanup_reason is null
      )
      or (
        event_name = 'cleanup'
        and outcome = 'deferred'
        and cleanup_reason is not null
        and cleanup_reason in (
          'runtime-kill-switch-unknown',
          'web-locks-unsupported',
          'exclusive-lock-unavailable',
          'exclusive-lock-not-proven',
          'exclusive-lock-request-failed',
          'service-worker-state-unknown',
          'service-worker-unsupported',
          'service-worker-registration-missing',
          'service-worker-not-active',
          'service-worker-update-waiting',
          'service-worker-version-unconfigured',
          'service-worker-version-unknown',
          'service-worker-version-mismatch',
          'supported-client-version-unconfigured',
          'client-handshake-unknown',
          'client-version-unknown',
          'unsupported-client-version',
          'unresponsive-client',
          'client-quiescence-unknown',
          'client-not-quiescent'
        )
      )
      or (
        event_name = 'cleanup'
        and outcome = 'blocked'
        and cleanup_reason is not null
        and cleanup_reason in (
          'feature-flag-disabled',
          'runtime-kill-switch-active',
          'manual-other-tabs-not-confirmed',
          'cleanup-task-failed',
          'exclusive-lock-lifecycle-failed'
        )
      )
      or (
        event_name = 'cleanup'
        and outcome = 'physical-deferred'
        and cleanup_reason is not null
        and cleanup_reason in (
          'runtime-kill-switch-unknown',
          'web-locks-unsupported',
          'exclusive-lock-unavailable',
          'exclusive-lock-not-proven',
          'exclusive-lock-request-failed',
          'service-worker-state-unknown',
          'service-worker-unsupported',
          'service-worker-registration-missing',
          'service-worker-not-active',
          'service-worker-update-waiting',
          'service-worker-version-unconfigured',
          'service-worker-version-unknown',
          'service-worker-version-mismatch',
          'supported-client-version-unconfigured',
          'client-handshake-unknown',
          'client-version-unknown',
          'unsupported-client-version',
          'unresponsive-client',
          'client-quiescence-unknown',
          'client-not-quiescent',
          'cleanup-not-ready',
          'migration-journal-cas-failed',
          'legacy-source-remove-failed',
          'legacy-source-missing-after-claim'
        )
      )
      or (
        event_name = 'cleanup'
        and outcome = 'physical-blocked'
        and cleanup_reason is not null
        and cleanup_reason in (
          'feature-flag-disabled',
          'runtime-kill-switch-active',
          'manual-other-tabs-not-confirmed',
          'cleanup-task-failed',
          'exclusive-lock-lifecycle-failed',
          'migration-journal-invalid',
          'migration-archive-invalid',
          'committed-target-invalid',
          'legacy-storage-unavailable',
          'legacy-source-changed',
          'legacy-source-reappeared',
          'legacy-source-missing-before-claim',
          'legacy-source-digest-mismatch'
        )
      )
      or (
        event_name <> 'cleanup'
        and cleanup_mode is null
        and cleanup_reason is null
      )
    ),
  constraint persistence_release_a_metric_build_id_check
    check (
      build_id = 'unknown-source'
      or build_id ~ '^[0-9a-f]{7,64}$'
    ),
  constraint persistence_release_a_metric_browser_family_check
    check (browser_family in ('chromium', 'firefox', 'safari', 'other')),
  constraint persistence_release_a_metric_app_mode_check
    check (app_mode in ('browser-tab', 'installed-pwa'))
);

create index if not exists persistence_release_a_metric_received_at_idx
  on public.persistence_release_a_metric_events (received_at desc);

create index if not exists persistence_release_a_metric_build_received_idx
  on public.persistence_release_a_metric_events (build_id, received_at desc);

alter table public.persistence_release_a_metric_events enable row level security;

revoke all on table public.persistence_release_a_metric_events
  from public, anon, authenticated;
grant insert, select on table public.persistence_release_a_metric_events
  to service_role;

revoke all on sequence public.persistence_release_a_metric_events_id_seq
  from public, anon, authenticated;
grant usage, select
  on sequence public.persistence_release_a_metric_events_id_seq
  to service_role;

create or replace view public.persistence_release_a_metrics_dashboard_24h
with (security_invoker = true)
as
with observed as (
  select
    *,
    min(received_at) over (
      partition by build_id, browser_family, app_mode, online
    ) as observation_started_at
  from public.persistence_release_a_metric_events
)
select
  build_id,
  browser_family,
  app_mode,
  online,
  min(observation_started_at) as observation_started_at,
  extract(epoch from now() - min(observation_started_at))::bigint
    as observation_age_seconds,
  min(received_at) as first_received_at,
  max(received_at) as last_received_at,
  count(distinct date_trunc('hour', received_at, 'UTC')) as active_hour_count,
  count(*) as event_count,
  count(*) filter (
    where event_name = 'checkpoint-adoption'
    and outcome in ('adopted', 'already-absorbed')
  ) as checkpoint_adopted_count,
  count(*) filter (
    where event_name = 'checkpoint-adoption'
    and outcome in ('adopted', 'already-absorbed', 'failed', 'conflict')
  ) as checkpoint_evaluation_count,
  count(*) filter (
    where event_name = 'fallback-repair' and outcome = 'succeeded'
  ) as fallback_repair_succeeded_count,
  count(*) filter (
    where event_name = 'fallback-repair'
  ) as fallback_repair_attempt_count,
  count(*) filter (
    where event_name = 'load' and outcome = 'conflict'
  ) as load_conflict_count,
  count(*) filter (
    where event_name = 'load'
  ) as load_attempt_count,
  count(*) filter (
    where event_name = 'save' and outcome = 'succeeded'
  ) as save_succeeded_count,
  count(*) filter (
    where event_name = 'save' and outcome = 'failed'
  ) as save_failed_count,
  count(*) filter (
    where event_name = 'startup' and outcome = 'ready'
  ) as startup_ready_count,
  count(*) filter (
    where event_name = 'startup' and outcome = 'recovery-required'
  ) as startup_recovery_required_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = 'lt-250ms'
  ) as startup_lt_250ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = '250-999ms'
  ) as startup_250_999ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = '1-2999ms'
  ) as startup_1_2999ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = '3-9999ms'
  ) as startup_3_9999ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = 'gte-10s'
  ) as startup_gte_10s_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'attempted'
  ) as cleanup_attempted_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'deferred'
  ) as cleanup_deferred_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'blocked'
  ) as cleanup_blocked_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'completed'
  ) as cleanup_completed_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'key-confirmed-removed'
  ) as cleanup_key_confirmed_removed_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'physical-deferred'
  ) as cleanup_physical_deferred_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'physical-blocked'
  ) as cleanup_physical_blocked_count
from observed
where received_at >= now() - interval '24 hours'
group by build_id, browser_family, app_mode, online;

revoke all on table public.persistence_release_a_metrics_dashboard_24h
  from public, anon, authenticated;
grant select on table public.persistence_release_a_metrics_dashboard_24h
  to service_role;

create or replace view public.persistence_release_a_metrics_dashboard_hourly_24h
with (security_invoker = true)
as
select
  date_trunc('hour', received_at, 'UTC') as hour_bucket,
  build_id,
  browser_family,
  app_mode,
  online,
  min(received_at) as first_received_at,
  max(received_at) as last_received_at,
  count(*) as event_count,
  count(*) filter (
    where event_name = 'checkpoint-adoption'
    and outcome in ('adopted', 'already-absorbed')
  ) as checkpoint_adopted_count,
  count(*) filter (
    where event_name = 'checkpoint-adoption'
    and outcome in ('adopted', 'already-absorbed', 'failed', 'conflict')
  ) as checkpoint_evaluation_count,
  count(*) filter (
    where event_name = 'fallback-repair' and outcome = 'succeeded'
  ) as fallback_repair_succeeded_count,
  count(*) filter (
    where event_name = 'fallback-repair'
  ) as fallback_repair_attempt_count,
  count(*) filter (
    where event_name = 'load' and outcome = 'conflict'
  ) as load_conflict_count,
  count(*) filter (
    where event_name = 'load'
  ) as load_attempt_count,
  count(*) filter (
    where event_name = 'save' and outcome = 'succeeded'
  ) as save_succeeded_count,
  count(*) filter (
    where event_name = 'save' and outcome = 'failed'
  ) as save_failed_count,
  count(*) filter (
    where event_name = 'startup' and outcome = 'ready'
  ) as startup_ready_count,
  count(*) filter (
    where event_name = 'startup' and outcome = 'recovery-required'
  ) as startup_recovery_required_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = 'lt-250ms'
  ) as startup_lt_250ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = '250-999ms'
  ) as startup_250_999ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = '1-2999ms'
  ) as startup_1_2999ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = '3-9999ms'
  ) as startup_3_9999ms_count,
  count(*) filter (
    where event_name = 'startup' and duration_bucket = 'gte-10s'
  ) as startup_gte_10s_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'attempted'
  ) as cleanup_attempted_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'deferred'
  ) as cleanup_deferred_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'blocked'
  ) as cleanup_blocked_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'completed'
  ) as cleanup_completed_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'key-confirmed-removed'
  ) as cleanup_key_confirmed_removed_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'physical-deferred'
  ) as cleanup_physical_deferred_count,
  count(*) filter (
    where event_name = 'cleanup' and outcome = 'physical-blocked'
  ) as cleanup_physical_blocked_count
from public.persistence_release_a_metric_events
where
  received_at >= date_trunc('hour', now(), 'UTC') - interval '24 hours'
  and received_at < date_trunc('hour', now(), 'UTC')
group by
  date_trunc('hour', received_at, 'UTC'),
  build_id,
  browser_family,
  app_mode,
  online;

revoke all
  on table public.persistence_release_a_metrics_dashboard_hourly_24h
  from public, anon, authenticated;
grant select
  on table public.persistence_release_a_metrics_dashboard_hourly_24h
  to service_role;

create or replace view public.persistence_release_a_cleanup_dashboard_24h
with (security_invoker = true)
as
select
  build_id,
  browser_family,
  app_mode,
  online,
  cleanup_mode,
  outcome,
  cleanup_reason,
  min(received_at) as first_received_at,
  max(received_at) as last_received_at,
  count(*) as event_count
from public.persistence_release_a_metric_events
where
  received_at >= now() - interval '24 hours'
  and event_name = 'cleanup'
group by
  build_id,
  browser_family,
  app_mode,
  online,
  cleanup_mode,
  outcome,
  cleanup_reason;

revoke all on table public.persistence_release_a_cleanup_dashboard_24h
  from public, anon, authenticated;
grant select on table public.persistence_release_a_cleanup_dashboard_24h
  to service_role;
