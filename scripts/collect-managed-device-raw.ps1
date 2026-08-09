param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [Parameter(Mandatory = $true)]
  [string]$CurrentDistPath,
  [string]$RollbackDistPath = "",
  [Parameter(Mandatory = $true)]
  [string]$RepositoryRoot
)

[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 | Out-Null

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Sha256Bytes {
  param(
    [Parameter(Mandatory = $true)]
    [byte[]]$Bytes
  )

  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ($algorithm.ComputeHash($Bytes) | ForEach-Object {
      $_.ToString("x2")
    }) -join ""
  } finally {
    $algorithm.Dispose()
  }
}

function Get-Sha256Text {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )

  return Get-Sha256Bytes -Bytes ([Text.UTF8Encoding]::new($false).GetBytes(
    $Value
  ))
}

function Get-Sha256File {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return Get-Sha256Bytes -Bytes ([IO.File]::ReadAllBytes($Path))
}

function Resolve-ExactFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $full = [IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $full -Force
  if (
    -not $item.PSIsContainer -and
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  ) {
    return $item.FullName
  }
  throw "$Label must be a regular non-reparse file."
}

function Resolve-ExactDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $full = [IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $full -Force
  if (
    $item.PSIsContainer -and
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  ) {
    return $item.FullName
  }
  throw "$Label must be a regular non-reparse directory."
}

function Get-RequiredEnvironment {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Managed device environment is absent: $Name"
  }
  return $value
}

function Get-NewBrowserProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BrowserPath,
    [Parameter(Mandatory = $true)]
    [string]$CommandFragment,
    [Parameter(Mandatory = $true)]
    [int[]]$PreviousIds
  )

  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $deadline) {
    $matches = @(
      Get-CimInstance Win32_Process | Where-Object {
        -not ($PreviousIds -contains [int]$_.ProcessId) -and
        [string]::Equals(
          [string]$_.ExecutablePath,
          $BrowserPath,
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        ([string]$_.CommandLine).Contains(
          $CommandFragment,
          [StringComparison]::Ordinal
        )
      }
    )
    if ($matches.Count -eq 1) {
      return $matches[0]
    }
    if ($matches.Count -gt 1) {
      throw "Managed browser process observation is ambiguous."
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Managed browser process was not observed."
}

function Stop-ObservedBrowserProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [int[]]$ProcessIds
  )

  foreach ($processId in $ProcessIds) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not ($ProcessIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })) {
      return
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Managed browser clients did not fully close."
}

$resolvedRequest = Resolve-ExactFile -Path $RequestPath -Label "Managed request"
$requestBytes = [IO.File]::ReadAllBytes($resolvedRequest)
$request = [Text.UTF8Encoding]::new($false, $true).GetString(
  $requestBytes
) | ConvertFrom-Json -Depth 100

# This gate is intentionally before registry, CIM, process, and network work.
$device = $request.externalPolicy.managedDeviceExecution
if (
  $null -eq $device -or
  $device.bindingStatus -ne "configured" -or
  $device.installedPwaLaunchAuthority.bindingStatus -ne "configured"
) {
  throw "Managed device execution is unconfigured; no live observation started."
}
if (
  $request.authority -notin @(
    "pwa-multiclient-drill",
    "idb-device-compatibility"
  )
) {
  throw "Managed device authority is invalid."
}

# Preserve the device signing material only inside this coordinator. Browser and
# probe processes receive neither it nor any caller workflow/database secret.
$attestationPrivateKeyPem = Get-RequiredEnvironment `
  -Name "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM"
$attestationPublicKeyPem = Get-RequiredEnvironment `
  -Name "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM"
foreach ($entry in @(Get-ChildItem Env:)) {
  if (
    [string]$entry.Name -match
      '(?i)(TOKEN|SECRET|PASSWORD|DATABASE|PRIVATE_KEY|OIDC|ACTIONS_ID)'
  ) {
    Remove-Item -LiteralPath "Env:\$($entry.Name)" -ErrorAction SilentlyContinue
  }
}

$runnerGroup = Get-RequiredEnvironment -Name "FOUNDATION_DEVICE_RUNNER_GROUP"
$runnerLabels = @(Get-RequiredEnvironment -Name "FOUNDATION_DEVICE_RUNNER_LABELS" -split ",")
if (
  $runnerGroup -ne [string]$device.runnerGroup -or
  ($runnerLabels | ConvertTo-Json -Compress) -ne (
    @($device.requiredLabels) | ConvertTo-Json -Compress
  )
) {
  throw "Managed device runner group or labels differ."
}

$resolvedRepository = Resolve-ExactDirectory `
  -Path $RepositoryRoot `
  -Label "Managed repository"
$resolvedCurrentDist = Resolve-ExactDirectory `
  -Path $CurrentDistPath `
  -Label "Managed current artifact"
if ($request.authority -eq "pwa-multiclient-drill") {
  if ([string]::IsNullOrWhiteSpace($RollbackDistPath)) {
    throw "Managed PWA rollback artifact is absent."
  }
  $resolvedRollbackDist = Resolve-ExactDirectory `
    -Path $RollbackDistPath `
    -Label "Managed rollback artifact"
} else {
  if (-not [string]::IsNullOrWhiteSpace($RollbackDistPath)) {
    throw "Managed IDB collector rejects a rollback artifact."
  }
  $resolvedRollbackDist = $null
}

if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [Runtime.InteropServices.OSPlatform]::Windows
)) {
  throw "Managed device execution requires Windows."
}
$os = Get-CimInstance Win32_OperatingSystem
if (
  [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne
    [Runtime.InteropServices.Architecture]::X64 -or
  ([version]$os.Version).Build -lt 22000 -or
  -not ([string]$os.Caption).Contains("Windows 11")
) {
  throw "Managed device is not exact Windows 11 x64."
}

$browserPath = Resolve-ExactFile `
  -Path ([string]$device.browser.binaryPath) `
  -Label "Managed Chromium"
$browserItem = Get-Item -LiteralPath $browserPath
$browserVersion = [string]$browserItem.VersionInfo.ProductVersion
if ($browserVersion -ne [string]$device.browser.exactVersion) {
  throw "Managed Chromium version differs."
}

$enrollmentObservations = @(
  foreach ($registryPath in @(
    "HKLM:\SOFTWARE\Policies\Google\Chrome",
    "HKLM:\SOFTWARE\Policies\Microsoft\Edge"
  )) {
    if (-not (Test-Path -LiteralPath $registryPath)) {
      continue
    }
    $property = Get-ItemProperty `
      -LiteralPath $registryPath `
      -Name "CloudManagementEnrollmentToken" `
      -ErrorAction SilentlyContinue
    if ($null -ne $property) {
      if (
        [string]::IsNullOrEmpty(
          [string]$property.CloudManagementEnrollmentToken
        )
      ) {
        throw "Managed Chromium enrollment token is empty."
      }
      [pscustomobject]@{
        RegistryPath = $registryPath
        Sha256 = Get-Sha256Text -Value (
          [string]$property.CloudManagementEnrollmentToken
        )
      }
    }
  }
)
if (
  $enrollmentObservations.Count -ne 1 -or
  $enrollmentObservations[0].Sha256 -ne
    [string]$device.browser.managedEnrollmentIdSha256
) {
  throw "Managed Chromium enrollment differs."
}

$policyName = [string]$device.installedPwaLaunchAuthority.forceInstallPolicyName
$policyObservations = @(
  foreach ($registryPath in @(
    "HKLM:\SOFTWARE\Policies\Google\Chrome\$policyName",
    "HKLM:\SOFTWARE\Policies\Microsoft\Edge\$policyName"
  )) {
    if (-not (Test-Path -LiteralPath $registryPath)) {
      continue
    }
    $properties = Get-ItemProperty -LiteralPath $registryPath
    $values = @(
      $properties.PSObject.Properties |
        Where-Object { $_.Name -match '^[0-9]+$' } |
        Sort-Object { [int]$_.Name } |
        ForEach-Object { [string]$_.Value }
    )
    if ($values.Count -gt 0) {
      [pscustomobject]@{
        RegistryPath = $registryPath
        Values = $values
      }
    }
  }
)
if ($policyObservations.Count -ne 1) {
  throw "Managed PWA force-install policy is ambiguous."
}
$policyValues = @($policyObservations[0].Values)
$policyJson = $policyValues | ConvertTo-Json -Compress
$policyHash = Get-Sha256Text -Value $policyJson
if (
  $policyHash -ne
    [string]$device.installedPwaLaunchAuthority.forceInstallPolicyValueSha256
) {
  throw "Managed PWA force-install policy hash differs."
}
$matchingPolicyEntries = @(
  foreach ($rawValue in $policyValues) {
    try {
      $entry = $rawValue | ConvertFrom-Json -Depth 20
      if (
        [string]$entry.url -eq
          [string]$device.installedPwaLaunchAuthority.installUrl
      ) {
        $entry
      }
    } catch {
      throw "Managed PWA force-install policy contains invalid JSON."
    }
  }
)
if ($matchingPolicyEntries.Count -ne 1) {
  throw "Managed PWA install URL is not exact in policy."
}

$profileRoot = Resolve-ExactDirectory `
  -Path (Get-RequiredEnvironment -Name "FOUNDATION_DEVICE_PROFILE_ROOT") `
  -Label "Managed Chromium profile root"
$profiles = @($device.deviceProfiles)
if (
  $profiles.Count -ne 2 -or
  [string]$profiles[0].id -ne "browser-tab" -or
  [string]$profiles[1].id -ne "installed-pwa"
) {
  throw "Managed Chromium profile policy differs."
}
$profilePaths = @{}
foreach ($profile in $profiles) {
  $profilePath = Join-Path $profileRoot ([string]$profile.profileName)
  $profilePaths[[string]$profile.id] = Resolve-ExactDirectory `
    -Path $profilePath `
    -Label "Managed Chromium profile $($profile.id)"
}
if (
  [string]::Equals(
    $profilePaths["browser-tab"],
    $profilePaths["installed-pwa"],
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Managed Chromium profiles are not distinct."
}

$shortcutCandidates = @(
  foreach ($startMenuRoot in @(
    (Join-Path (Get-RequiredEnvironment -Name "APPDATA") "Microsoft\Windows\Start Menu\Programs"),
    (Join-Path (Get-RequiredEnvironment -Name "ProgramData") "Microsoft\Windows\Start Menu\Programs")
  )) {
    if (Test-Path -LiteralPath $startMenuRoot) {
      Get-ChildItem -LiteralPath $startMenuRoot -Filter "*.lnk" -File -Recurse
    }
  }
)
$shell = New-Object -ComObject WScript.Shell
try {
  $shortcutMatches = @(
    foreach ($candidate in $shortcutCandidates) {
      $shortcut = $shell.CreateShortcut($candidate.FullName)
      if (
        ([string]$shortcut.Arguments).Contains(
          "--app-id=$($device.installedPwaLaunchAuthority.applicationId)",
          [StringComparison]::Ordinal
        ) -and
        ([string]$shortcut.Arguments).Contains(
          "--profile-directory=$($profiles[1].profileName)",
          [StringComparison]::Ordinal
        ) -and
        [string]::Equals(
          [IO.Path]::GetFullPath([string]$shortcut.TargetPath),
          $browserPath,
          [StringComparison]::OrdinalIgnoreCase
        )
      ) {
        [pscustomobject]@{
          Path = $candidate.FullName
          TargetPath = [IO.Path]::GetFullPath([string]$shortcut.TargetPath)
          Arguments = [string]$shortcut.Arguments
        }
      }
    }
  )
} finally {
  [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
}
if ($shortcutMatches.Count -ne 1) {
  throw "Managed installed PWA shortcut authority is ambiguous."
}
$installedShortcut = $shortcutMatches[0]

$previousIds = @(Get-CimInstance Win32_Process | ForEach-Object {
  [int]$_.ProcessId
})
$observedProcessIds = @()
try {
  Start-Process -FilePath $installedShortcut.Path -WindowStyle Hidden
  $installedProcess = Get-NewBrowserProcess `
    -BrowserPath $browserPath `
    -CommandFragment "--app-id=$($device.installedPwaLaunchAuthority.applicationId)" `
    -PreviousIds $previousIds
  $observedProcessIds += [int]$installedProcess.ProcessId

  $tabArguments = @(
    "--user-data-dir=$profileRoot",
    "--profile-directory=$($profiles[0].profileName)",
    "--new-window",
    [string]$request.deployment.deploymentUrl
  )
  $previousIds += [int]$installedProcess.ProcessId
  Start-Process `
    -FilePath $browserPath `
    -ArgumentList $tabArguments `
    -WindowStyle Hidden
  $tabProcess = Get-NewBrowserProcess `
    -BrowserPath $browserPath `
    -CommandFragment "--profile-directory=$($profiles[0].profileName)" `
    -PreviousIds $previousIds
  $observedProcessIds += [int]$tabProcess.ProcessId

  $hostBase = [ordered]@{
    runnerGroup = $runnerGroup
    runnerLabels = $runnerLabels
    operatingSystem = [ordered]@{
      family = "windows"
      release = "11"
      architecture = "x64"
      buildNumber = [string]$os.Version
    }
    browser = [ordered]@{
      family = "chromium"
      binaryPath = $browserPath
      binarySha256 = Get-Sha256File -Path $browserPath
      version = $browserVersion
      enrollmentIdSha256 = [string]$enrollmentObservations[0].Sha256
    }
    policy = [ordered]@{
      forceInstallPolicyName = $policyName
      forceInstallPolicyValueSha256 = $policyHash
      installUrl = [string]$device.installedPwaLaunchAuthority.installUrl
      applicationId = [string]$device.installedPwaLaunchAuthority.applicationId
      observedPolicyResult = "OK"
    }
    appLaunch = [ordered]@{
      applicationId = [string]$device.installedPwaLaunchAuthority.applicationId
      shortcutPathSha256 = Get-Sha256Text -Value ([string]$installedShortcut.Path)
      targetBinarySha256 = Get-Sha256File -Path ([string]$installedShortcut.TargetPath)
      argumentsSha256 = Get-Sha256Text -Value ([string]$installedShortcut.Arguments)
      processExecutableSha256 = Get-Sha256Text -Value ([string]$installedProcess.ExecutablePath)
      processCommandLineSha256 = Get-Sha256Text -Value ([string]$installedProcess.CommandLine)
    }
    profiles = @(
      [ordered]@{
        profileId = "browser-tab"
        profileName = [string]$profiles[0].profileName
        profilePathSha256 = Get-Sha256Text -Value $profilePaths["browser-tab"]
        initialProcessId = [int]$tabProcess.ProcessId
      },
      [ordered]@{
        profileId = "installed-pwa"
        profileName = [string]$profiles[1].profileName
        profilePathSha256 = Get-Sha256Text -Value $profilePaths["installed-pwa"]
        initialProcessId = [int]$installedProcess.ProcessId
      }
    )
  }
} finally {
  if ($observedProcessIds.Count -gt 0) {
    Stop-ObservedBrowserProcesses -ProcessIds $observedProcessIds
  }
}

$temporaryRoot = Split-Path -Parent $resolvedRequest
$hostPath = Join-Path $temporaryRoot "host-observation.json"
$browserTransitionPath = Join-Path $temporaryRoot "browser-tab-transition.json"
$pwaTransitionPath = Join-Path $temporaryRoot "installed-pwa-transition.json"
$browserIdbPath = Join-Path $temporaryRoot "browser-tab-idb.json"
$pwaIdbPath = Join-Path $temporaryRoot "installed-pwa-idb.json"
$hostBase | ConvertTo-Json -Depth 100 -Compress | Set-Content `
  -LiteralPath $hostPath `
  -Encoding utf8 `
  -NoNewline

$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop |
  Select-Object -First 1
$nodeExecutableOutput = @(& $nodeCommand.Source -p "process.execPath")
if (
  $LASTEXITCODE -ne 0 -or
  $nodeExecutableOutput.Count -ne 1 -or
  -not $nodeExecutableOutput[0]
) {
  throw "Managed device Node runtime is unavailable."
}
$nodeExecutable = Resolve-ExactFile `
  -Path ([string]$nodeExecutableOutput[0]).Trim() `
  -Label "Managed device Node runtime"
$transitionScript = Resolve-ExactFile `
  -Path (Join-Path $resolvedRepository "scripts\browser\run-managed-device-transition.mjs") `
  -Label "Managed device transition adapter"
$finalizerScript = Resolve-ExactFile `
  -Path (Join-Path $resolvedRepository "scripts\browser\finalize-managed-device-receipt.mjs") `
  -Label "Managed device receipt finalizer"
$idbProbeScript = Resolve-ExactFile `
  -Path (Join-Path $resolvedRepository "scripts\browser\run-managed-device-idb-probe.mjs") `
  -Label "Managed device IDB probe"

if ($request.authority -eq "pwa-multiclient-drill") {
  foreach ($profile in $profiles) {
    $transitionOutput = if (
      [string]$profile.id -eq "browser-tab"
    ) {
      $browserTransitionPath
    } else {
      $pwaTransitionPath
    }
    & $nodeExecutable $transitionScript `
      --browser-path $browserPath `
      --current-dist $resolvedCurrentDist `
      --current-source ([string]$request.sourceSha) `
      --output $transitionOutput `
      --profile-dir $profilePaths[[string]$profile.id] `
      --profile-id ([string]$profile.id) `
      --rollback-dist $resolvedRollbackDist `
      --rollback-source ([string]$request.rollbackDeployment.sourceSha)
    if ($LASTEXITCODE -ne 0) {
      throw "Managed device transition adapter failed for $($profile.id)."
    }
  }
} else {
  foreach ($profile in $profiles) {
    $idbOutput = if (
      [string]$profile.id -eq "browser-tab"
    ) {
      $browserIdbPath
    } else {
      $pwaIdbPath
    }
    & $nodeExecutable $idbProbeScript `
      --browser-path $browserPath `
      --current-dist $resolvedCurrentDist `
      --output $idbOutput `
      --profile-dir $profilePaths[[string]$profile.id] `
      --profile-id ([string]$profile.id) `
      --source-sha ([string]$request.sourceSha)
    if ($LASTEXITCODE -ne 0) {
      throw "Managed device IDB probe failed for $($profile.id)."
    }
  }
}

$finalizerArguments = @(
  $finalizerScript,
  "--request", $resolvedRequest,
  "--host", $hostPath,
  "--current-dist", $resolvedCurrentDist,
  "--output", ([IO.Path]::GetFullPath($OutputPath))
)
if ($request.authority -eq "pwa-multiclient-drill") {
  $finalizerArguments += @(
    "--browser-transition", $browserTransitionPath,
    "--pwa-transition", $pwaTransitionPath
  )
} else {
  $finalizerArguments += @(
    "--browser-idb", $browserIdbPath,
    "--pwa-idb", $pwaIdbPath
  )
}
try {
  [Environment]::SetEnvironmentVariable(
    "FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM",
    $attestationPrivateKeyPem,
    [EnvironmentVariableTarget]::Process
  )
  [Environment]::SetEnvironmentVariable(
    "FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM",
    $attestationPublicKeyPem,
    [EnvironmentVariableTarget]::Process
  )
  & $nodeExecutable $finalizerArguments
  if ($LASTEXITCODE -ne 0) {
    throw "Managed device receipt finalizer failed."
  }
} finally {
  Remove-Item `
    -LiteralPath "Env:\FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM" `
    -ErrorAction SilentlyContinue
  Remove-Item `
    -LiteralPath "Env:\FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM" `
    -ErrorAction SilentlyContinue
}
