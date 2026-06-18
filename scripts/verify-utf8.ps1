[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

$repoRoot = Split-Path -Parent $PSScriptRoot
$knownExceptionsPath = Join-Path $PSScriptRoot 'utf8-known-exceptions.json'
$knownExceptions = @{}
if (Test-Path -LiteralPath $knownExceptionsPath) {
  foreach ($entry in (Get-Content -LiteralPath $knownExceptionsPath -Encoding utf8 | ConvertFrom-Json)) {
    $knownExceptions[$entry.path] = $entry
  }
}

$strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
$failures = [Collections.Generic.List[string]]::new()
$checked = 0

Get-ChildItem -LiteralPath $repoRoot -Recurse -File |
  Where-Object {
    $relative = $_.FullName.Substring($repoRoot.Length).TrimStart('\')
    $isSource = $relative.StartsWith('src\') -and ($_.Extension -eq '.ts' -or $_.Extension -eq '.tsx')
    $isReadme = $relative -eq 'README.md'
    $isDocs = $relative.StartsWith('docs\') -and $_.Extension -eq '.md'
    $isSource -or $isReadme -or $isDocs
  } |
  ForEach-Object {
    $checked++
    $relative = $_.FullName.Substring($repoRoot.Length).TrimStart('\')
    $bytes = [IO.File]::ReadAllBytes($_.FullName)
    $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
    try {
      $text = $strictUtf8.GetString($bytes)
      $replacementCount = ([regex]::Matches($text, [char]0xFFFD)).Count
    } catch {
      $failures.Add("$($_.FullName): invalid UTF-8")
      return
    }

    $expectedBom = $false
    $expectedReplacementCount = 0
    if ($knownExceptions.ContainsKey($relative)) {
      $expectedBom = [bool]$knownExceptions[$relative].bom
      $expectedReplacementCount = [int]$knownExceptions[$relative].replacementCount
      Write-Warning "${relative}: monitoring known encoding exception (BOM=$expectedBom, U+FFFD=$expectedReplacementCount)."
    }

    if ($hasBom -ne $expectedBom) {
      $failures.Add("$($_.FullName): BOM changed (expected=$expectedBom, actual=$hasBom)")
    }
    if ($replacementCount -ne $expectedReplacementCount) {
      $failures.Add(
        "$($_.FullName): U+FFFD count changed (expected=$expectedReplacementCount, actual=$replacementCount)"
      )
    }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  throw "UTF-8 verification failed for $($failures.Count) file(s)."
}

Write-Host "UTF-8 verification passed for $checked monitored files."
