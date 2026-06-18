[CmdletBinding()]
param(
  [switch]$Local
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $repoRoot 'src\lib\database.types.ts'
Set-Location -LiteralPath $repoRoot

if ($Local -and -not (Get-Command docker -ErrorAction SilentlyContinue)) {
  $dockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
  if (Test-Path -LiteralPath (Join-Path $dockerBin 'docker.exe')) {
    $env:PATH = "$dockerBin;$env:PATH"
  }
}

$arguments = @('supabase', 'gen', 'types', 'typescript')
if ($Local) {
  $arguments += '--local'
} else {
  . (Join-Path $PSScriptRoot 'load-supabase-connection.ps1') -RequireAuthConfirmation
  $arguments += '--linked'
}
$arguments += @('--schema', 'public')

$generatedLines = & npx @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Supabase type generation failed with exit code $LASTEXITCODE."
}

$generated = ($generatedLines -join "`n").TrimEnd() + "`n"
[IO.File]::WriteAllText($outputPath, $generated, [Text.UTF8Encoding]::new($false))
Write-Host "Generated client-safe public schema types: $outputPath"
