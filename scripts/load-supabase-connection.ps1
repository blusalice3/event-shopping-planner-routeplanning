[CmdletBinding()]
param(
  [switch]$RequireAuthConfirmation
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
$connectionPath = Join-Path $repoRoot '.supabase-connection.local.ps1'

if (-not (Test-Path -LiteralPath $connectionPath)) {
  throw "Missing $connectionPath. Fill the provided .supabase-connection.local.ps1 file before running real Supabase commands."
}

. $connectionPath

$requiredNames = @(
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_DB_PASSWORD',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY'
)

$missing = @()
foreach ($name in $requiredNames) {
  $value = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    $missing += $name
  }
}

if ($missing.Count -gt 0) {
  throw "Missing required Supabase connection value(s): $($missing -join ', ')."
}

if ($RequireAuthConfirmation -and $env:SUPABASE_AUTH_ANONYMOUS_SIGN_INS_CONFIRMED -ne 'true') {
  throw 'Set SUPABASE_AUTH_ANONYMOUS_SIGN_INS_CONFIRMED=true after enabling anonymous sign-ins in the Supabase Dashboard.'
}

Write-Host "Loaded Supabase connection settings for project ref: $env:SUPABASE_PROJECT_REF"
