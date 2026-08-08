begin;

-- CSP_REPORT_CONTRACT_UPGRADE_BEGIN
-- Preserve forward-only migration history while replacing the anonymous
-- column checks created by the original hardening migration.
alter table public.csp_violation_reports
  drop constraint if exists csp_violation_reports_effective_directive_check;
alter table public.csp_violation_reports
  drop constraint if exists csp_violation_reports_blocked_target_check;

update public.csp_violation_reports
set effective_directive = 'unknown'
where effective_directive not in (
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
);

update public.csp_violation_reports
set blocked_target = case
  when blocked_target in (
    'data',
    'blob',
    'http',
    'https',
    'inline',
    'eval'
  ) then 'scheme'
  else 'unknown'
end
where blocked_target not in (
  'self',
  'scheme',
  'same-site',
  'cross-site',
  'unknown'
);

alter table public.csp_violation_reports
  add constraint csp_violation_reports_effective_directive_check
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
  ) not valid;

alter table public.csp_violation_reports
  validate constraint csp_violation_reports_effective_directive_check;

alter table public.csp_violation_reports
  add constraint csp_violation_reports_blocked_target_check
  check (
    blocked_target in (
      'self',
      'scheme',
      'same-site',
      'cross-site',
      'unknown'
    )
  ) not valid;

alter table public.csp_violation_reports
  validate constraint csp_violation_reports_blocked_target_check;
-- CSP_REPORT_CONTRACT_UPGRADE_END

commit;
