[CmdletBinding()]
param(
  [switch]$ConfirmActivation,
  [switch]$AllowLegacyMemberBlockers,
  [switch]$AllowDirtyWorktree,
  [switch]$SkipPublicGuard,
  [switch]$SkipDatabaseLint,
  [switch]$SkipDatabaseTests
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

if (-not $ConfirmActivation) {
  throw 'Refusing to run production-like sharing activation without -ConfirmActivation.'
}

if ($env:SHARING_ACTIVATION_CONFIRMED -ne 'true') {
  throw 'Set SHARING_ACTIVATION_CONFIRMED=true immediately before production-like activation.'
}

if ($env:SHARING_ACTIVATION_RUNBOOK_ACK -ne 'true') {
  throw 'Set SHARING_ACTIVATION_RUNBOOK_ACK=true after completing docs/sharing-activation-runbook.md preflight.'
}

if ($AllowLegacyMemberBlockers -and $env:SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK -ne 'true') {
  throw 'Set SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK=true after product/support confirms no old shared users need same-room recovery.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$ScriptBlock
  )

  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
  & $ScriptBlock
}

function Invoke-ExternalCommand {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $outputLines = & $Arguments[0] @($Arguments | Select-Object -Skip 1) 2>&1 | ForEach-Object { $_.ToString() }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $outputLines | ForEach-Object { Write-Host $_ }
  if ($exitCode -ne 0) {
    throw "$($Arguments -join ' ') failed with exit code $exitCode."
  }

  return $outputLines
}

function Get-FirstJsonObject {
  param([Parameter(Mandatory = $true)][string]$Text)

  $start = $Text.IndexOf('{')
  if ($start -lt 0) {
    throw "Command output did not contain JSON.`n$Text"
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

  throw "Command output contained incomplete JSON.`n$Text"
}

function Invoke-NpmRun {
  param([Parameter(Mandatory = $true)][string]$ScriptName)
  Invoke-ExternalCommand -Arguments @('npm', 'run', $ScriptName) | Out-Null
}

function Invoke-ActivationAudit {
  $arguments = @(
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (Join-Path $PSScriptRoot 'verify-sharing-activation-audit.ps1'),
    '-Linked'
  )
  if ($AllowLegacyMemberBlockers) {
    $arguments += '-AllowLegacyMemberBlockers'
  }

  Invoke-ExternalCommand -Arguments $arguments | Out-Null
}

function Assert-OldRpcFunctionsDropped {
  $queryPath = Join-Path ([IO.Path]::GetTempPath()) "sharing_activation_old_rpc_check_$PID.sql"
  $query = @'
select count(*)::bigint as old_rpc_function_count
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('claim_item', 'update_room_item_fields');
'@

  [IO.File]::WriteAllText($queryPath, $query, [Text.UTF8Encoding]::new($false))
  try {
    $outputLines = Invoke-ExternalCommand -Arguments @('npx', 'supabase', 'db', 'query', '--linked', '--output', 'json', '--file', $queryPath)
  } finally {
    Remove-Item -LiteralPath $queryPath -Force -ErrorAction SilentlyContinue
  }

  $jsonText = Get-FirstJsonObject -Text ($outputLines -join "`n")
  $result = $jsonText | ConvertFrom-Json
  $count = [int64]$result.rows[0].old_rpc_function_count
  if ($count -ne 0) {
    throw "Old sharing RPC functions still exist after activation: $count"
  }
}

if (-not $AllowDirtyWorktree) {
  $status = & git status --porcelain
  if ($status) {
    throw "Working tree must be clean before production-like activation. Commit or stash changes, or pass -AllowDirtyWorktree.`n$($status -join "`n")"
  }
}

. (Join-Path $PSScriptRoot 'load-supabase-connection.ps1') -RequireAuthConfirmation

Invoke-Step -Name 'encoding check' -ScriptBlock { Invoke-NpmRun -ScriptName 'encoding:check' }
Invoke-Step -Name 'activation runbook static check' -ScriptBlock { Invoke-NpmRun -ScriptName 'sharing:activation-runbook:check' }

if (-not $SkipPublicGuard) {
  Invoke-Step -Name 'public guard linked check' -ScriptBlock { Invoke-NpmRun -ScriptName 'sharing:public-guard:check' }
} else {
  Write-Host 'Skipping public guard linked check by request.' -ForegroundColor Yellow
}

Invoke-Step -Name 'pre-activation linked audit' -ScriptBlock { Invoke-ActivationAudit }

Invoke-Step -Name 'activation cleanup' -ScriptBlock {
  $arguments = @(
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    (Join-Path $PSScriptRoot 'apply-sharing-activation-cleanup.ps1'),
    '-Linked',
    '-ConfirmActivation'
  )
  if ($AllowLegacyMemberBlockers) {
    $arguments += '-AllowLegacyMemberBlockers'
  }

  Invoke-ExternalCommand -Arguments $arguments | Out-Null
}

Invoke-Step -Name 'post-activation linked audit' -ScriptBlock { Invoke-ActivationAudit }
Invoke-Step -Name 'old RPC catalog check' -ScriptBlock { Assert-OldRpcFunctionsDropped }
Invoke-Step -Name 'linked database type generation' -ScriptBlock { Invoke-NpmRun -ScriptName 'db:typegen' }
Invoke-Step -Name 'TypeScript typecheck' -ScriptBlock { Invoke-NpmRun -ScriptName 'typecheck' }

if (-not $SkipDatabaseLint) {
  Invoke-Step -Name 'local database lint' -ScriptBlock { Invoke-NpmRun -ScriptName 'db:lint' }
} else {
  Write-Host 'Skipping local database lint by request.' -ForegroundColor Yellow
}

if (-not $SkipDatabaseTests) {
  Invoke-Step -Name 'local database tests' -ScriptBlock { Invoke-NpmRun -ScriptName 'db:test' }
} else {
  Write-Host 'Skipping local database tests by request.' -ForegroundColor Yellow
}

Invoke-Step -Name 'final encoding check' -ScriptBlock { Invoke-NpmRun -ScriptName 'encoding:check' }

Write-Host ''
Write-Host 'Production-like sharing activation completed.' -ForegroundColor Green
