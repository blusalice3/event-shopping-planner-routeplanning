[CmdletBinding()]
param(
  [switch]$SkipPull,
  [switch]$SkipTypegen
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

. (Join-Path $PSScriptRoot 'load-supabase-connection.ps1') -RequireAuthConfirmation

Write-Host 'Authenticating Supabase CLI with the local access token...'
& npx supabase login --token $env:SUPABASE_ACCESS_TOKEN
if ($LASTEXITCODE -ne 0) {
  throw "supabase login failed with exit code $LASTEXITCODE."
}

Write-Host 'Linking the repository to the real Supabase project...'
& npx supabase link --project-ref $env:SUPABASE_PROJECT_REF --password $env:SUPABASE_DB_PASSWORD --yes
if ($LASTEXITCODE -ne 0) {
  throw "supabase link failed with exit code $LASTEXITCODE."
}

$envLocalPath = Join-Path $repoRoot '.env.local'
$envLocalLines = @(
  "VITE_SUPABASE_URL=$env:VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY=$env:VITE_SUPABASE_ANON_KEY",
  'VITE_SHARING_PUBLIC_GATE_ENABLED=false',
  'VITE_SHARING_EDGE_GUARD_URL=',
  'VITE_SHARING_CONTRACT_VERSION=2'
)
[IO.File]::WriteAllText(
  $envLocalPath,
  (($envLocalLines -join "`n") + "`n"),
  [Text.UTF8Encoding]::new($false)
)
Write-Host "Wrote local Vite Supabase settings: $envLocalPath"

Write-Host 'Verifying Management API access without printing project API keys...'
$projectsOutput = & npx supabase projects list --output-format json 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "supabase projects list failed with exit code $LASTEXITCODE. $($projectsOutput -join "`n")"
}
if (($projectsOutput -join "`n") -notlike "*$env:SUPABASE_PROJECT_REF*") {
  Write-Warning 'Management API access succeeded, but the configured project ref was not found in the project list output.'
}

if (-not $SkipPull) {
  & (Join-Path $PSScriptRoot 'pull-database-baseline.ps1')
}

if (-not $SkipTypegen) {
  & (Join-Path $PSScriptRoot 'generate-database-types.ps1')
}

Write-Host 'Real Supabase connection bootstrap completed.'
