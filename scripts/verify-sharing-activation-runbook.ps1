[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Assert-FileContains {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string[]]$RequiredFragments
  )

  $path = Join-Path $repoRoot $RelativePath
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required activation runbook artifact is missing: $RelativePath"
  }

  $text = Get-Content -LiteralPath $path -Encoding utf8 -Raw
  foreach ($fragment in $RequiredFragments) {
    if (-not $text.Contains($fragment)) {
      throw "Required activation runbook fragment is missing from ${RelativePath}: $fragment"
    }
  }
}

Assert-FileContains -RelativePath 'docs/sharing-activation-runbook.md' -RequiredFragments @(
  'activation runbook',
  'additive migration',
  'preflight',
  'npm run sharing:activation-audit:linked',
  'npm run sharing:activation-cleanup:linked',
  'npm run sharing:activation-production:linked',
  'SHARING_ACTIVATION_CONFIRMED',
  'SHARING_ACTIVATION_RUNBOOK_ACK',
  'SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK',
  '-AllowLegacyMemberBlockers',
  '-SkipAudit',
  'old_rpc_execute_grants_present',
  'rollback',
  'support copy'
)

Assert-FileContains -RelativePath 'docs/sharing-db-setup.md' -RequiredFragments @(
  'activation runbook',
  './sharing-activation-runbook.md',
  'npm run sharing:activation-runbook:check',
  'npm run sharing:activation-production:linked'
)

Assert-FileContains -RelativePath 'package.json' -RequiredFragments @(
  '"sharing:activation-runbook:check"',
  '"sharing:activation-audit"',
  '"sharing:activation-audit:linked"',
  '"sharing:activation-cleanup"',
  '"sharing:activation-cleanup:linked"',
  '"sharing:activation-production:linked"'
)

Assert-FileContains -RelativePath 'scripts/apply-sharing-activation-cleanup.ps1' -RequiredFragments @(
  'Refusing to apply activation cleanup without -ConfirmActivation.',
  'SHARING_ACTIVATION_CONFIRMED',
  'SHARING_ACTIVATION_RUNBOOK_ACK',
  'SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK',
  'AllowLegacyMemberBlockers',
  'Linked activation cleanup cannot skip the activation audit.'
)

Assert-FileContains -RelativePath 'scripts/verify-sharing-activation-audit.ps1' -RequiredFragments @(
  'Sharing activation audit found blocker counts',
  'Do not run activation cleanup or old RPC removal yet.',
  'AllowLegacyMemberBlockers',
  'WAIVED BY RELEASE DECISION'
)

Assert-FileContains -RelativePath 'scripts/invoke-sharing-production-activation.ps1' -RequiredFragments @(
  'Refusing to run production-like sharing activation without -ConfirmActivation.',
  'SHARING_ACTIVATION_CONFIRMED',
  'SHARING_ACTIVATION_RUNBOOK_ACK',
  'SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK',
  'pre-activation linked audit',
  'activation cleanup',
  'post-activation linked audit',
  'old RPC catalog check',
  'linked database type generation',
  'local database tests'
)

Assert-FileContains -RelativePath 'supabase/snippets/sharing_activation_audit.sql' -RequiredFragments @(
  'active_v1_or_unknown_members',
  'active_v1_or_unknown_member_sync_state',
  'pending_v1_create_challenges',
  'pending_v1_join_restore_challenges',
  'active_items_missing_field_clocks',
  'title_name_mismatch',
  'postponed_mirror_mismatch',
  'route_membership_without_event_date',
  'missing_route_version_rows',
  'route_mirror_mismatch',
  'event_data_size_mismatch',
  'legacy_change_log_missing_v2_metadata',
  'deleted_tombstone_rows',
  'old_rpc_execute_grants_present'
)

Assert-FileContains -RelativePath 'supabase/snippets/sharing_activation_cleanup.sql' -RequiredFragments @(
  'delete from private.room_create_payload_challenges',
  'delete from private.room_join_challenges',
  'drop function public.update_room_item_fields',
  'drop function public.claim_item'
)

Write-Host 'Sharing activation runbook static check passed.'
