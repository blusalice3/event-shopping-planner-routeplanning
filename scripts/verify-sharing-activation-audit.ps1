[CmdletBinding()]
param(
  [switch]$Local,
  [switch]$Linked,
  [switch]$AllowBlockers,
  [switch]$AllowLegacyMemberBlockers
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

if ($Local -and $Linked) {
  throw 'Use either -Local or -Linked, not both.'
}

if (-not $Local -and -not $Linked) {
  $Local = $true
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sqlPath = Join-Path $repoRoot 'supabase\snippets\sharing_activation_audit.sql'
Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath $sqlPath)) {
  throw "Missing activation audit SQL: $sqlPath"
}

if ($Linked) {
  . (Join-Path $PSScriptRoot 'load-supabase-connection.ps1') -RequireAuthConfirmation
}

function Get-FirstJsonObject {
  param([Parameter(Mandatory = $true)][string]$Text)

  $start = $Text.IndexOf('{')
  if ($start -lt 0) {
    throw "Supabase query output did not contain JSON.`n$Text"
  }

  $depth = 0
  $inString = $false
  $escaped = $false
  for ($i = $start; $i -lt $Text.Length; $i++) {
    $char = $Text[$i]
    if ($inString) {
      if ($escaped) {
        $escaped = $false
      } elseif ($char -eq '\') {
        $escaped = $true
      } elseif ($char -eq '"') {
        $inString = $false
      }
      continue
    }

    if ($char -eq '"') {
      $inString = $true
    } elseif ($char -eq '{') {
      $depth++
    } elseif ($char -eq '}') {
      $depth--
      if ($depth -eq 0) {
        return $Text.Substring($start, $i - $start + 1)
      }
    }
  }

  throw "Supabase query output contained incomplete JSON.`n$Text"
}

function Invoke-SupabaseJsonQuery {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$FailureLabel
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $outputLines = & npx @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    $queryExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($queryExitCode -ne 0) {
    throw "$FailureLabel failed with exit code $queryExitCode.`n$($outputLines -join "`n")"
  }

  $jsonText = Get-FirstJsonObject -Text ($outputLines -join "`n")
  return $jsonText | ConvertFrom-Json
}

$baseArguments = @('supabase', 'db', 'query')
if ($Local) {
  $baseArguments += '--local'
} else {
  $baseArguments += '--linked'
}

$schemaPrerequisiteQuery = @'
with required_columns(schema_name, table_name, column_name) as (
  values
    ('public', 'rooms', 'sharing_status'),
    ('public', 'rooms', 'expires_at'),
    ('public', 'room_members', 'membership_status'),
    ('public', 'room_members', 'accepted_contract_version'),
    ('public', 'room_member_sync_state', 'room_member_id'),
    ('private', 'room_create_payload_challenges', 'consumed_at'),
    ('private', 'room_create_payload_challenges', 'expires_at'),
    ('private', 'room_create_payload_challenges', 'contract_version'),
    ('private', 'room_join_challenges', 'consumed_at'),
    ('private', 'room_join_challenges', 'expires_at'),
    ('private', 'room_join_challenges', 'contract_version'),
    ('public', 'room_items', 'room_id'),
    ('public', 'room_items', 'local_item_id'),
    ('public', 'room_items', 'deleted_at'),
    ('public', 'room_items', 'deleted_by'),
    ('public', 'room_items', 'order_index'),
    ('public', 'room_items', 'event_date'),
    ('public', 'room_items', 'field_clocks'),
    ('public', 'room_items', 'title'),
    ('public', 'room_items', 'name'),
    ('public', 'room_items', 'postponed'),
    ('public', 'room_items', 'purchase_status'),
    ('public', 'room_items', 'item_version'),
    ('public', 'room_items', 'updated_at'),
    ('public', 'room_route_order_versions', 'room_id'),
    ('public', 'room_route_order_versions', 'event_date'),
    ('public', 'room_event_data', 'room_id'),
    ('public', 'room_event_data', 'event_data'),
    ('public', 'room_event_data', 'event_data_size_bytes'),
    ('public', 'room_item_change_log', 'room_id'),
    ('public', 'room_item_change_log', 'change_type'),
    ('public', 'room_item_change_log', 'field_clocks'),
    ('public', 'room_item_change_log', 'item_payload')
),
missing_columns as (
  select
    schema_name,
    table_name,
    column_name
  from required_columns required
  where not exists (
    select 1
    from information_schema.columns existing
    where existing.table_schema = required.schema_name
      and existing.table_name = required.table_name
      and existing.column_name = required.column_name
  )
)
select
  'schema_prerequisite_missing' as check_key,
  'blocker' as severity,
  count(*)::bigint as observed_count,
  jsonb_build_object(
    'reason', 'Apply the additive v2 sharing migration before running activation audit.',
    'missingColumns', coalesce(
      jsonb_agg(jsonb_build_object(
        'schema', schema_name,
        'table', table_name,
        'column', column_name
      ) order by schema_name, table_name, column_name) filter (where schema_name is not null),
      '[]'::jsonb
    )
  ) as details
from missing_columns;
'@

Write-Host "Checking sharing activation schema prerequisites against $(if ($Local) { 'local database' } else { 'linked database' })..."
$schemaPrerequisitePath = Join-Path ([IO.Path]::GetTempPath()) "sharing_activation_schema_prerequisite_$PID.sql"
[IO.File]::WriteAllText($schemaPrerequisitePath, $schemaPrerequisiteQuery, [Text.UTF8Encoding]::new($false))
try {
  $schemaResult = Invoke-SupabaseJsonQuery `
    -Arguments ($baseArguments + @('--output', 'json', '--file', $schemaPrerequisitePath)) `
    -FailureLabel 'Supabase activation schema prerequisite query'
} finally {
  Remove-Item -LiteralPath $schemaPrerequisitePath -Force -ErrorAction SilentlyContinue
}
$schemaRows = @($schemaResult.rows)
$schemaBlockers = @(
  $schemaRows | Where-Object {
    $_.severity -eq 'blocker' -and [int64]$_.observed_count -gt 0
  }
)

if ($schemaBlockers.Count -gt 0) {
  $schemaRows |
    Select-Object check_key, severity, observed_count |
    Format-Table -AutoSize |
    Out-String |
    Write-Host

  foreach ($row in $schemaBlockers) {
    Write-Host "- $($row.check_key): $($row.observed_count) ($($row.details.reason))" -ForegroundColor Yellow
    foreach ($missingColumn in @($row.details.missingColumns)) {
      Write-Host "  - $($missingColumn.schema).$($missingColumn.table).$($missingColumn.column)"
    }
  }

  if (-not $AllowBlockers) {
    throw 'Sharing activation schema prerequisites are missing. Apply additive v2 migration before activation audit.'
  }
}

Write-Host "Running sharing activation audit against $(if ($Local) { 'local database' } else { 'linked database' })..."
$result = Invoke-SupabaseJsonQuery `
  -Arguments ($baseArguments + @('--output', 'json', '--file', $sqlPath)) `
  -FailureLabel 'Supabase activation audit query'
$rows = @($result.rows)

if ($rows.Count -eq 0) {
  throw 'Activation audit returned no rows.'
}

$rows |
  Select-Object check_key, severity, observed_count |
  Format-Table -AutoSize |
  Out-String |
  Write-Host

$blockers = @(
  $rows | Where-Object {
    $_.severity -eq 'blocker' -and [int64]$_.observed_count -gt 0
  }
)

$waivedBlockerKeys = @()
if ($AllowLegacyMemberBlockers) {
  $waivedBlockerKeys = @(
    'active_v1_or_unknown_members',
    'active_v1_or_unknown_member_sync_state'
  )
}

$effectiveBlockers = @(
  $blockers | Where-Object { $waivedBlockerKeys -notcontains $_.check_key }
)

if ($blockers.Count -gt 0) {
  Write-Host 'Blocking audit findings:' -ForegroundColor Yellow
  foreach ($row in $blockers) {
    $reason = $row.details.reason
    $waived = $waivedBlockerKeys -contains $row.check_key
    $suffix = if ($waived) { ' [WAIVED BY RELEASE DECISION]' } else { '' }
    Write-Host "- $($row.check_key): $($row.observed_count) ($reason)$suffix"
  }

  if (-not $AllowBlockers -and $effectiveBlockers.Count -gt 0) {
    throw 'Sharing activation audit found blocker counts. Do not run activation cleanup or old RPC removal yet.'
  }
}

Write-Host 'Sharing activation audit completed.'
