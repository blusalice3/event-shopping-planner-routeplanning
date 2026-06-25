[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

. (Join-Path $PSScriptRoot 'load-supabase-connection.ps1') -RequireAuthConfirmation

$configPath = Join-Path $repoRoot 'supabase\config.toml'
$config = Get-Content -LiteralPath $configPath -Encoding utf8 -Raw
if ($config -notmatch '(?m)^\s*enable_anonymous_sign_ins\s*=\s*true\s*$') {
  throw 'Local supabase/config.toml does not enable anonymous sign-ins.'
}

if ($env:VITE_SHARING_CONTRACT_VERSION -and $env:VITE_SHARING_CONTRACT_VERSION -ne '2') {
  throw "Unexpected VITE_SHARING_CONTRACT_VERSION: $env:VITE_SHARING_CONTRACT_VERSION"
}

Write-Host 'Auth settings check passed for MVP-0a: anonymous sign-ins confirmed, local config enabled, contract version is compatible.'
