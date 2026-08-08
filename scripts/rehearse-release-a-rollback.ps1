param(
  [string]$BaselineCommit = "e5f26b76b1318d70b5d2373c8808cda20c7bb5c3",
  [ValidateRange(0, 65535)]
  [int]$Port = 0
)

[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$nodeCommand = Get-Command `
  node `
  -CommandType Application `
  -ErrorAction Stop | Select-Object -First 1
$nodeExecutableOutput = @(
  & $nodeCommand.Source -p "process.execPath"
)
if (
  $LASTEXITCODE -ne 0 -or
  $nodeExecutableOutput.Count -ne 1 -or
  -not $nodeExecutableOutput[0]
) {
  throw "Could not resolve the active Node executable."
}
$NodeExecutable = [IO.Path]::GetFullPath(
  ([string]$nodeExecutableOutput[0]).Trim()
)
if (
  -not [string]::Equals(
    [IO.Path]::GetExtension($NodeExecutable),
    ".exe",
    [StringComparison]::OrdinalIgnoreCase
  ) -or
  -not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)
) {
  throw "The active Node runtime did not resolve to a Windows executable."
}
$ViteCli = Join-Path $ProjectRoot "node_modules\vite\bin\vite.js"
if ($Port -eq 0) {
  $portReservation = [Net.Sockets.TcpListener]::new(
    [Net.IPAddress]::Loopback,
    0
  )
  try {
    $portReservation.Start()
    $Port = ([Net.IPEndPoint]$portReservation.LocalEndpoint).Port
  } finally {
    $portReservation.Stop()
  }
}
$PreviewUrl = "http://127.0.0.1:$Port/"
$TempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$TempRoot = Join-Path $TempBase (
  "esp-release-a-rollback-" + [Guid]::NewGuid().ToString("N")
)
$BaselineArchive = Join-Path $TempRoot "baseline.zip"
$BaselineRoot = Join-Path $TempRoot "baseline"
$ProfileDirectory = Join-Path $TempRoot "browser-profile"
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

function Get-PreviewDiagnostics {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Paths
  )

  $parts = @(
    foreach ($path in $Paths) {
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        continue
      }
      try {
        $content = [string](
          Get-Content -LiteralPath $path -Raw -Encoding utf8
        )
        $content = $content.Trim()
        if ($content.Length -gt 2000) {
          $content = $content.Substring($content.Length - 2000)
        }
        if ($content) {
          "$(Split-Path $path -Leaf): $content"
        }
      } catch {
        "$(Split-Path $path -Leaf): <unavailable>"
      }
    }
  )
  if ($parts.Count -eq 0) {
    return "preview emitted no diagnostics"
  }
  return $parts -join [Environment]::NewLine
}

function Wait-PreviewReady {
  param(
    [Parameter(Mandatory = $true)]
    [Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [string[]]$DiagnosticPaths
  )

  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Process.HasExited) {
      $diagnostics = Get-PreviewDiagnostics -Paths $DiagnosticPaths
      throw (
        "Preview process exited with code {0} before becoming ready.{1}{2}" -f `
          $Process.ExitCode,
          [Environment]::NewLine,
          $diagnostics
      )
    }
    try {
      $response = Invoke-WebRequest `
        -Uri $PreviewUrl `
        -UseBasicParsing `
        -TimeoutSec 2
      if ($response.StatusCode -eq 200) {
        return
      }
    } catch {
      # The process can be healthy while the listener is still starting.
    }
    Start-Sleep -Milliseconds 100
  }
  $diagnostics = Get-PreviewDiagnostics -Paths $DiagnosticPaths
  throw (
    "Preview did not become ready at {0} within 60 seconds.{1}{2}" -f `
      $PreviewUrl,
      [Environment]::NewLine,
      $diagnostics
  )
}

function Start-ArtifactPreview {
  param(
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory
  )

  $logId = [Guid]::NewGuid().ToString("N")
  $standardOutputPath = Join-Path $TempRoot "preview-$logId.stdout.log"
  $standardErrorPath = Join-Path $TempRoot "preview-$logId.stderr.log"
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
    -RedirectStandardOutput $standardOutputPath `
    -RedirectStandardError $standardErrorPath `
    -PassThru
  try {
    Wait-PreviewReady `
      -Process $process `
      -DiagnosticPaths @($standardOutputPath, $standardErrorPath)
  } catch {
    Stop-ArtifactPreview -Process $process
    throw
  }
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

function Get-Sha256File {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $hashAlgorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try {
    return (
      $hashAlgorithm.ComputeHash($stream) |
        ForEach-Object { $_.ToString("x2") }
    ) -join ""
  } finally {
    $stream.Dispose()
    $hashAlgorithm.Dispose()
  }
}

function Get-ArtifactEvidence {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DistDirectory
  )

  $indexPath = Join-Path $DistDirectory "index.html"
  $serviceWorkerPath = Join-Path $DistDirectory "sw.js"
  $indexSource = Get-Content -LiteralPath $indexPath -Raw -Encoding utf8
  $moduleAssets = @(
    foreach ($scriptMatch in [regex]::Matches(
      $indexSource,
      '<script\b[^>]*>',
      [Text.RegularExpressions.RegexOptions]::IgnoreCase
    )) {
      if (-not [regex]::IsMatch(
        $scriptMatch.Value,
        '\btype\s*=\s*["'']module["'']',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )) {
        continue
      }
      $sourceMatch = [regex]::Match(
        $scriptMatch.Value,
        '\bsrc\s*=\s*["''](?<asset>/assets/[A-Za-z0-9._-]+\.js)["'']',
        [Text.RegularExpressions.RegexOptions]::IgnoreCase
      )
      if ($sourceMatch.Success) {
        $sourceMatch.Groups["asset"].Value
      }
    }
  )
  if ($moduleAssets.Count -ne 1) {
    throw (
      "Expected exactly one module application asset in {0}; found {1}." -f `
        $indexPath,
        $moduleAssets.Count
    )
  }
  $mainAsset = $moduleAssets[0]
  $assetPath = Join-Path `
    $DistDirectory `
    $mainAsset.Substring(1).Replace(
      "/",
      [IO.Path]::DirectorySeparatorChar
    )
  if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
    throw "Module application asset is missing: $mainAsset."
  }
  return @{
    IndexSha256 = Get-Sha256File -Path $indexPath
    ServiceWorkerSha256 = Get-Sha256File -Path $serviceWorkerPath
    MainAsset = $mainAsset
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

try {
  New-Item -ItemType Directory -Path $TempRoot | Out-Null
  New-Item -ItemType Directory -Path $ProfileDirectory | Out-Null

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

  Push-Location $BaselineRoot
  try {
    Invoke-CheckedCommand `
      -Command { npm ci } `
      -FailureMessage "Rollback baseline dependency installation failed"
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
  if (Test-Path -LiteralPath $TempRoot) {
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
}
