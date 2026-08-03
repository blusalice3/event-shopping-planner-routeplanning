param(
  [string]$BaselineCommit = "e5f26b76b1318d70b5d2373c8808cda20c7bb5c3",
  [int]$Port = 4173
)

[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$NodeExecutable = (Get-Command node).Source
$ViteCli = Join-Path $ProjectRoot "node_modules\vite\bin\vite.js"
$PreviewUrl = "http://127.0.0.1:$Port/"
$TempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$TempRoot = Join-Path $TempBase (
  "esp-release-a-rollback-" + [Guid]::NewGuid().ToString("N")
)
$BaselineArchive = Join-Path $TempRoot "baseline.zip"
$BaselineRoot = Join-Path $TempRoot "baseline"
$ProfileDirectory = Join-Path $TempRoot "browser-profile"
$BaselineNodeModules = Join-Path $BaselineRoot "node_modules"
$PreviewProcess = $null

function Invoke-CheckedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command,
    [Parameter(Mandatory = $true)]
    [string]$FailureMessage
  )

  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$FailureMessage (exit code: $LASTEXITCODE)"
  }
}

function Wait-PreviewReady {
  param(
    [Parameter(Mandatory = $true)]
    [Diagnostics.Process]$Process
  )

  for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
    if ($Process.HasExited) {
      throw "Preview process exited before becoming ready."
    }
    try {
      $response = Invoke-WebRequest -Uri $PreviewUrl -UseBasicParsing
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  throw "Preview did not become ready at $PreviewUrl."
}

function Start-ArtifactPreview {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
  )

  $process = Start-Process `
    -FilePath $NodeExecutable `
    -ArgumentList @(
      $ViteCli,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "$Port",
      "--strictPort"
    ) `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -PassThru
  Wait-PreviewReady -Process $process
  return $process
}

function Stop-ArtifactPreview {
  param(
    [Diagnostics.Process]$Process
  )

  if ($null -eq $Process -or $Process.HasExited) {
    return
  }
  Stop-Process -Id $Process.Id
  $Process.WaitForExit(5000) | Out-Null
}

function Get-ArtifactEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DistDirectory
  )

  $indexPath = Join-Path $DistDirectory "index.html"
  $serviceWorkerPath = Join-Path $DistDirectory "sw.js"
  $indexSource = Get-Content -LiteralPath $indexPath -Raw -Encoding utf8
  $assetMatch = [regex]::Match(
    $indexSource,
    'src="(?<asset>/assets/index-[^"]+\.js)"'
  )
  if (-not $assetMatch.Success) {
    throw "Main application asset was not found in $indexPath."
  }
  return @{
    IndexSha256 = (
      Get-FileHash -LiteralPath $indexPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    ServiceWorkerSha256 = (
      Get-FileHash -LiteralPath $serviceWorkerPath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    MainAsset = $assetMatch.Groups["asset"].Value
  }
}

function Clear-TransitionEnvironment {
  Remove-Item Env:ESP_TRANSITION_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_ROLLBACK_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_EXPECTED_FROM_ARTIFACT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_TARGET_ARTIFACT_ID -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_EXPECTED_TARGET_BUILD_ID -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_EXPECTED_INDEX_SHA256 -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_EXPECTED_SW_SHA256 -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_EXPECTED_MAIN_ASSET -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_ALLOW_DIRTY_BUILD -ErrorAction SilentlyContinue
}

function Invoke-BrowserVerifier {
  param(
    [ValidateSet("seed", "rollback", "forward")]
    [string]$Mode,
    [string]$FromArtifactId,
    [string]$TargetArtifactId,
    [string]$TargetBuildId,
    [hashtable]$Evidence
  )

  Clear-TransitionEnvironment
  $env:ESP_PREVIEW_URL = $PreviewUrl
  $env:ESP_BROWSER_PROFILE_DIR = $ProfileDirectory
  if ($Mode -ne "seed") {
    $env:ESP_TRANSITION_MODE = $Mode
    $env:ESP_EXPECTED_FROM_ARTIFACT_ID = $FromArtifactId
    $env:ESP_TARGET_ARTIFACT_ID = $TargetArtifactId
    $env:ESP_EXPECTED_INDEX_SHA256 = $Evidence.IndexSha256
    $env:ESP_EXPECTED_SW_SHA256 = $Evidence.ServiceWorkerSha256
    $env:ESP_EXPECTED_MAIN_ASSET = $Evidence.MainAsset
    if ($TargetBuildId) {
      $env:ESP_EXPECTED_TARGET_BUILD_ID = $TargetBuildId
    }
  }

  Push-Location $ProjectRoot
  try {
    Invoke-CheckedCommand `
      -Command { node scripts/verify-release-a-browser.mjs } `
      -FailureMessage "Release A browser verifier failed in $Mode mode"
  } finally {
    Pop-Location
  }
}

$occupiedPort = Get-NetTCPConnection `
  -LocalPort $Port `
  -State Listen `
  -ErrorAction SilentlyContinue
if ($occupiedPort) {
  throw "Port $Port is already in use. Stop the existing preview first."
}

$workingTreeState = git -C $ProjectRoot status --porcelain
if ($LASTEXITCODE -ne 0 -or $workingTreeState) {
  throw "Rollback rehearsal requires a clean git working tree."
}
if (-not (Test-Path -LiteralPath $ViteCli -PathType Leaf)) {
  throw "Vite CLI is missing. Run npm install before the rehearsal."
}

New-Item -ItemType Directory -Path $TempRoot | Out-Null
New-Item -ItemType Directory -Path $ProfileDirectory | Out-Null

try {
  Push-Location $ProjectRoot
  try {
    Invoke-CheckedCommand `
      -Command { npm run build:release-a } `
      -FailureMessage "Clean Release A build failed"
  } finally {
    Pop-Location
  }

  $finalCapabilityPath = Join-Path $ProjectRoot "dist\release-capabilities.json"
  $finalCapability = Get-Content `
    -LiteralPath $finalCapabilityPath `
    -Raw `
    -Encoding utf8 | ConvertFrom-Json
  $FinalBuildId = [string]$finalCapability.buildId
  if ($FinalBuildId -notmatch '^[0-9a-f]{40}$') {
    throw "Final Release A build ID is not a full source SHA."
  }
  $FinalEvidence = Get-ArtifactEvidence -DistDirectory (
    Join-Path $ProjectRoot "dist"
  )

  Invoke-CheckedCommand `
    -Command {
      git -C $ProjectRoot archive `
        --format=zip `
        "--output=$BaselineArchive" `
        $BaselineCommit
    } `
    -FailureMessage "Could not archive rollback baseline $BaselineCommit"
  New-Item -ItemType Directory -Path $BaselineRoot | Out-Null
  Expand-Archive `
    -LiteralPath $BaselineArchive `
    -DestinationPath $BaselineRoot
  New-Item `
    -ItemType Junction `
    -Path $BaselineNodeModules `
    -Target (Join-Path $ProjectRoot "node_modules") | Out-Null

  Push-Location $BaselineRoot
  try {
    $env:VITE_PERSISTENCE_LEGACY_CLEANUP = "false"
    Invoke-CheckedCommand `
      -Command { npm run build } `
      -FailureMessage "Rollback baseline build failed"
  } finally {
    Remove-Item Env:VITE_PERSISTENCE_LEGACY_CLEANUP -ErrorAction SilentlyContinue
    Pop-Location
  }
  $BaselineEvidence = Get-ArtifactEvidence -DistDirectory (
    Join-Path $BaselineRoot "dist"
  )

  $PreviewProcess = Start-ArtifactPreview -WorkingDirectory $ProjectRoot
  Invoke-BrowserVerifier -Mode "seed"
  Stop-ArtifactPreview -Process $PreviewProcess
  $PreviewProcess = $null

  $PreviewProcess = Start-ArtifactPreview -WorkingDirectory $BaselineRoot
  Invoke-BrowserVerifier `
    -Mode "rollback" `
    -FromArtifactId $FinalBuildId `
    -TargetArtifactId $BaselineCommit `
    -Evidence $BaselineEvidence
  Stop-ArtifactPreview -Process $PreviewProcess
  $PreviewProcess = $null

  $PreviewProcess = Start-ArtifactPreview -WorkingDirectory $ProjectRoot
  Invoke-BrowserVerifier `
    -Mode "forward" `
    -FromArtifactId $BaselineCommit `
    -TargetArtifactId $FinalBuildId `
    -TargetBuildId $FinalBuildId `
    -Evidence $FinalEvidence

  Write-Output (
    "Release A rollback rehearsal PASS: {0} -> {1} -> {0}" -f `
      $FinalBuildId,
      $BaselineCommit
  )
} finally {
  Stop-ArtifactPreview -Process $PreviewProcess
  Clear-TransitionEnvironment
  Remove-Item Env:ESP_PREVIEW_URL -ErrorAction SilentlyContinue
  Remove-Item Env:ESP_BROWSER_PROFILE_DIR -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $BaselineNodeModules) {
    Remove-Item -LiteralPath $BaselineNodeModules -Force
  }
  $resolvedTempRoot = [IO.Path]::GetFullPath($TempRoot)
  if (
    $resolvedTempRoot.StartsWith(
      $TempBase,
      [StringComparison]::OrdinalIgnoreCase
    ) -and
    (Split-Path $resolvedTempRoot -Leaf).StartsWith(
      "esp-release-a-rollback-",
      [StringComparison]::Ordinal
    )
  ) {
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  } else {
    throw "Refusing to remove an unexpected rehearsal path: $resolvedTempRoot"
  }
}
