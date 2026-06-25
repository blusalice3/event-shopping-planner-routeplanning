[CmdletBinding()]
param(
  [switch]$Local,
  [switch]$Linked,
  [switch]$ConfirmActivation,
  [switch]$SkipAudit,
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

if (-not $ConfirmActivation) {
  throw 'Refusing to apply activation cleanup without -ConfirmActivation.'
}

if ($Linked -and $env:SHARING_ACTIVATION_CONFIRMED -ne 'true') {
  throw 'Set SHARING_ACTIVATION_CONFIRMED=true immediately before linked activation cleanup.'
}

if ($Linked -and $env:SHARING_ACTIVATION_RUNBOOK_ACK -ne 'true') {
  throw 'Set SHARING_ACTIVATION_RUNBOOK_ACK=true after completing docs/sharing-activation-runbook.md preflight.'
}

if ($Linked -and $SkipAudit) {
  throw 'Linked activation cleanup cannot skip the activation audit.'
}

if ($Linked -and $AllowLegacyMemberBlockers -and $env:SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK -ne 'true') {
  throw 'Set SHARING_ACTIVATION_LEGACY_MEMBER_BLOCKERS_ACK=true after product/support confirms no old shared users need same-room recovery.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$sqlPath = Join-Path $repoRoot 'supabase\snippets\sharing_activation_cleanup.sql'
Set-Location -LiteralPath $repoRoot

if (-not (Test-Path -LiteralPath $sqlPath)) {
  throw "Missing activation cleanup SQL: $sqlPath"
}

if ($Linked) {
  . (Join-Path $PSScriptRoot 'load-supabase-connection.ps1') -RequireAuthConfirmation
}

if (-not $SkipAudit) {
  if ($Local) {
    & (Join-Path $PSScriptRoot 'verify-sharing-activation-audit.ps1') -Local -AllowLegacyMemberBlockers:$AllowLegacyMemberBlockers
  } else {
    & (Join-Path $PSScriptRoot 'verify-sharing-activation-audit.ps1') -Linked -AllowLegacyMemberBlockers:$AllowLegacyMemberBlockers
  }
}

function Invoke-NpxCommand {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $outputLines = & npx @Arguments 2>&1 | ForEach-Object { $_.ToString() }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  if ($exitCode -ne 0) {
    throw "npx $($Arguments -join ' ') failed with exit code $exitCode.`n$($outputLines -join "`n")"
  }

  return $outputLines
}

$queryArguments = @('supabase', 'db', 'query')
if ($Local) {
  $queryArguments += '--local'
} else {
  $queryArguments += '--linked'
}
$queryArguments += @('--file', $sqlPath)

Write-Host "Applying sharing activation cleanup against $(if ($Local) { 'local database' } else { 'linked database' })..."
$cleanupOutput = Invoke-NpxCommand -Arguments $queryArguments
$cleanupOutput | ForEach-Object { Write-Host $_ }
Write-Host 'Sharing activation cleanup completed. Regenerate database types against this activated schema before publishing the final v2 client.'
