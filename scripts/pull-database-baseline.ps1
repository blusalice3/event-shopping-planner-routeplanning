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

Write-Host 'Pulling the remote public/private schema as a migration baseline...'
$arguments = @(
  'supabase',
  'db',
  'pull',
  'sharing_remote_baseline',
  '--linked',
  '--schema',
  'public,private',
  '--password',
  $env:SUPABASE_DB_PASSWORD
)

& npx @arguments
if ($LASTEXITCODE -ne 0) {
  Write-Warning "supabase db pull failed with exit code $LASTEXITCODE. Falling back to supabase db dump for a baseline schema file."

  $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
  $baselinePath = Join-Path $repoRoot "supabase\migrations\${timestamp}_sharing_remote_baseline.sql"
  $dumpArguments = @(
    'supabase',
    'db',
    'dump',
    '--linked',
    '--schema',
    'public,private',
    '--password',
    $env:SUPABASE_DB_PASSWORD,
    '--file',
    $baselinePath
  )

  & npx @dumpArguments
  if ($LASTEXITCODE -ne 0) {
    if ((Test-Path -LiteralPath $baselinePath) -and ((Get-Item -LiteralPath $baselinePath).Length -eq 0)) {
      Remove-Item -LiteralPath $baselinePath -Force
    }
    throw "supabase db dump fallback failed with exit code $LASTEXITCODE."
  }

  Write-Host "Baseline dump completed. Review the generated SQL before committing it: $baselinePath"
  return
}

Write-Host 'Baseline pull completed. Review the generated migration before committing it.'
