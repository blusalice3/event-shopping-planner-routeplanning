param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
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
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)

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
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  return Get-Sha256Bytes -Bytes (
    [Text.UTF8Encoding]::new($false).GetBytes($Value)
  )
}

function Get-Sha256File {
  param([Parameter(Mandatory = $true)][string]$Path)
  return Get-Sha256Bytes -Bytes ([IO.File]::ReadAllBytes($Path))
}

function Get-Base64Text {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  return [Convert]::ToBase64String(
    [Text.UTF8Encoding]::new($false).GetBytes($Value)
  )
}

function Resolve-ExactFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = [IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $full -Force
  $cursor = $item
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse-point path component."
    }
    $cursor = $cursor.Parent
  }
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
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $full = [IO.Path]::GetFullPath($Path)
  $item = Get-Item -LiteralPath $full -Force
  $cursor = $item
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse-point path component."
    }
    $cursor = $cursor.Parent
  }
  if (
    $item.PSIsContainer -and
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  ) {
    return $item.FullName
  }
  throw "$Label must be a regular non-reparse directory."
}

function Get-RequiredEnvironment {
  param([Parameter(Mandatory = $true)][string]$Name)
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Managed device environment is absent: $Name"
  }
  return $value
}

function Reserve-LoopbackPort {
  $listener = [Net.Sockets.TcpListener]::new(
    [Net.IPAddress]::Loopback,
    0
  )
  try {
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Wait-CdpEndpoint {
  param([Parameter(Mandatory = $true)][int]$Port)
  $endpoint = "http://127.0.0.1:$Port"
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $version = Invoke-RestMethod `
        -Uri "$endpoint/json/version" `
        -Method Get `
        -TimeoutSec 2
      if (
        -not [string]::IsNullOrWhiteSpace(
          [string]$version.webSocketDebuggerUrl
        ) -and
        ([uri][string]$version.webSocketDebuggerUrl).Host -in @(
          "127.0.0.1",
          "localhost"
        )
      ) {
        return $endpoint
      }
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  throw "Managed device CDP endpoint was not observed."
}

function Get-NewManagedBrowserProcess {
  param(
    [Parameter(Mandatory = $true)][string]$BrowserPath,
    [Parameter(Mandatory = $true)][string]$ProfileRoot,
    [Parameter(Mandatory = $true)][string]$ProfileName,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ClientKind,
    [Parameter(Mandatory = $true)][string]$ApplicationId,
    [Parameter(Mandatory = $true)][int[]]$PreviousIds
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  while ([DateTime]::UtcNow -lt $deadline) {
    $matches = @(
      Get-CimInstance Win32_Process | Where-Object {
        $commandLine = [string]$_.CommandLine
        -not ($PreviousIds -contains [int]$_.ProcessId) -and
        [string]::Equals(
          [string]$_.ExecutablePath,
          $BrowserPath,
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        $commandLine.Contains(
          "--remote-debugging-port=$Port",
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        $commandLine.Contains(
          $ProfileRoot,
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        $commandLine.Contains(
          "--profile-directory=$ProfileName",
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        (
          (
            $ClientKind -eq "installed-pwa" -and
            $commandLine.Contains(
              "--app-id=$ApplicationId",
              [StringComparison]::OrdinalIgnoreCase
            ) -and
            -not $commandLine.Contains(
              "--app=",
              [StringComparison]::OrdinalIgnoreCase
            )
          ) -or
          (
            $ClientKind -eq "browser-tab" -and
            -not $commandLine.Contains(
              "--app-id=",
              [StringComparison]::OrdinalIgnoreCase
            ) -and
            -not $commandLine.Contains(
              "--app=",
              [StringComparison]::OrdinalIgnoreCase
            )
          )
        )
      }
    )
    if ($matches.Count -eq 1) {
      return $matches[0]
    }
    if ($matches.Count -gt 1) {
      throw "Managed device browser process is ambiguous."
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Managed device browser process was not observed."
}

function Stop-ManagedProfileProcesses {
  param(
    [Parameter(Mandatory = $true)][string]$BrowserPath,
    [Parameter(Mandatory = $true)][string[]]$ProfileRoots
  )
  $processes = @(
    Get-CimInstance Win32_Process | Where-Object {
      $commandLine = [string]$_.CommandLine
      [string]::Equals(
        [string]$_.ExecutablePath,
        $BrowserPath,
        [StringComparison]::OrdinalIgnoreCase
      ) -and
      $null -ne (
        $ProfileRoots | Where-Object {
          $commandLine.Contains(
            $_,
            [StringComparison]::OrdinalIgnoreCase
          )
        } | Select-Object -First 1
      )
    }
  )
  foreach ($process in $processes) {
    Stop-Process `
      -Id ([int]$process.ProcessId) `
      -Force `
      -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline) {
    $remaining = @(
      Get-CimInstance Win32_Process | Where-Object {
        $commandLine = [string]$_.CommandLine
        [string]::Equals(
          [string]$_.ExecutablePath,
          $BrowserPath,
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        $null -ne (
          $ProfileRoots | Where-Object {
            $commandLine.Contains(
              $_,
              [StringComparison]::OrdinalIgnoreCase
            )
          } | Select-Object -First 1
        )
      }
    )
    if ($remaining.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 100
  }
  throw "Managed device profile processes did not fully close."
}

$resolvedRequest = Resolve-ExactFile -Path $RequestPath -Label "Managed request"
$request = [Text.UTF8Encoding]::new($false, $true).GetString(
  [IO.File]::ReadAllBytes($resolvedRequest)
) | ConvertFrom-Json -Depth 100

# This check remains before registry, CIM, process, and network work.
$device = $request.externalPolicy.managedDeviceExecution
if (
  $request.kind -ne "managed-device-stage-execution-request/v1" -or
  $null -eq $device -or
  $device.bindingStatus -ne "configured" -or
  $device.installedPwaLaunchAuthority.bindingStatus -ne "configured"
) {
  throw "Managed device stage execution is unconfigured."
}

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
$runnerLabels = @(
  Get-RequiredEnvironment -Name "FOUNDATION_DEVICE_RUNNER_LABELS" -split ","
)
if (
  $runnerGroup -ne [string]$device.runnerGroup -or
  ($runnerLabels | ConvertTo-Json -Compress) -ne (
    @($device.requiredLabels) | ConvertTo-Json -Compress
  )
) {
  throw "Managed device runner authority differs."
}

$resolvedRepository = Resolve-ExactDirectory `
  -Path $RepositoryRoot `
  -Label "Managed repository"
if (-not [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [Runtime.InteropServices.OSPlatform]::Windows
)) {
  throw "Managed device stage requires Windows."
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
$browserVersion = [string](Get-Item -LiteralPath $browserPath).VersionInfo.ProductVersion
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
      [pscustomobject]@{ RegistryPath = $registryPath; Values = $values }
    }
  }
)
if ($policyObservations.Count -ne 1) {
  throw "Managed PWA force-install policy is ambiguous."
}
$policyValues = @($policyObservations[0].Values)
$policyHash = Get-Sha256Text -Value ($policyValues | ConvertTo-Json -Compress)
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

$profiles = @($device.deviceProfiles)
if (
  $profiles.Count -ne 2 -or
  [string]$profiles[0].id -ne "browser-tab" -or
  [string]$profiles[1].id -ne "installed-pwa"
) {
  throw "Managed device profile set differs."
}
$profileRoots = @{}
$profilePaths = @{}
foreach ($profile in $profiles) {
  $rootPath = Resolve-ExactDirectory `
    -Path ([string]$profile.profileRoot) `
    -Label "Managed profile root $($profile.id)"
  $profilePath = Resolve-ExactDirectory `
    -Path ([string]$profile.profilePath) `
    -Label "Managed profile path $($profile.id)"
  if (
    -not [string]::Equals(
      [IO.Path]::GetFullPath((Join-Path $rootPath ([string]$profile.profileName))),
      $profilePath,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Managed profile root/path binding differs."
  }
  $profileRoots[[string]$profile.id] = $rootPath
  $profilePaths[[string]$profile.id] = $profilePath
}
if (
  [string]::Equals(
    $profileRoots["browser-tab"],
    $profileRoots["installed-pwa"],
    [StringComparison]::OrdinalIgnoreCase
  )
) {
  throw "Managed profile roots are not distinct."
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
      $arguments = [string]$shortcut.Arguments
      if (
        $arguments.Contains(
          "--app-id=$($device.installedPwaLaunchAuthority.applicationId)",
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        $arguments.Contains(
          $profileRoots["installed-pwa"],
          [StringComparison]::OrdinalIgnoreCase
        ) -and
        $arguments.Contains(
          "--profile-directory=$($profiles[1].profileName)",
          [StringComparison]::OrdinalIgnoreCase
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
          Arguments = $arguments
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

$nodeOutput = @(
  & (Get-Command node -ErrorAction Stop).Source -p "process.execPath"
)
if ($LASTEXITCODE -ne 0 -or $nodeOutput.Count -ne 1) {
  throw "Managed device Node runtime is unavailable."
}
$nodeExecutable = Resolve-ExactFile `
  -Path ([string]$nodeOutput[0]).Trim() `
  -Label "Managed Node runtime"
$probeScript = Resolve-ExactFile `
  -Path (Join-Path $resolvedRepository "scripts\browser\probe-managed-device-live-stage.mjs") `
  -Label "Managed live stage probe"
$sentinelScript = Resolve-ExactFile `
  -Path (Join-Path $resolvedRepository "scripts\browser\prepare-managed-device-legacy-sentinels.mjs") `
  -Label "Managed legacy sentinel preparer"
$finalizerScript = Resolve-ExactFile `
  -Path (Join-Path $resolvedRepository "scripts\browser\finalize-managed-device-live-stage.mjs") `
  -Label "Managed live stage finalizer"
$temporaryRoot = Split-Path -Parent $resolvedRequest

function Initialize-LegacySentinels {
  Stop-ManagedProfileProcesses `
    -BrowserPath $browserPath `
    -ProfileRoots @(
      $profileRoots["browser-tab"],
      $profileRoots["installed-pwa"]
    )
  $previousIds = @(
    Get-CimInstance Win32_Process | ForEach-Object { [int]$_.ProcessId }
  )
  $tabPort = Reserve-LoopbackPort
  $pwaPort = Reserve-LoopbackPort
  if ($tabPort -eq $pwaPort) {
    throw "Managed device sentinel CDP ports are ambiguous."
  }
  $tabArguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$tabPort",
    "--remote-allow-origins=http://127.0.0.1:$tabPort",
    "--user-data-dir=$($profileRoots['browser-tab'])",
    "--profile-directory=$($profiles[0].profileName)",
    "--new-window",
    "about:blank"
  )
  $pwaArguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$pwaPort",
    "--remote-allow-origins=http://127.0.0.1:$pwaPort",
    "--user-data-dir=$($profileRoots['installed-pwa'])",
    "--profile-directory=$($profiles[1].profileName)",
    "--new-window",
    "about:blank"
  )
  Start-Process `
    -FilePath $browserPath `
    -ArgumentList $tabArguments `
    -WindowStyle Hidden
  $tabProcess = Get-NewManagedBrowserProcess `
    -BrowserPath $browserPath `
    -ProfileRoot $profileRoots["browser-tab"] `
    -ProfileName ([string]$profiles[0].profileName) `
    -Port $tabPort `
    -ClientKind "browser-tab" `
    -ApplicationId ([string]$device.installedPwaLaunchAuthority.applicationId) `
    -PreviousIds $previousIds
  Start-Process `
    -FilePath $browserPath `
    -ArgumentList $pwaArguments `
    -WindowStyle Hidden
  $pwaProcess = Get-NewManagedBrowserProcess `
    -BrowserPath $browserPath `
    -ProfileRoot $profileRoots["installed-pwa"] `
    -ProfileName ([string]$profiles[1].profileName) `
    -Port $pwaPort `
    -ClientKind "browser-tab" `
    -ApplicationId ([string]$device.installedPwaLaunchAuthority.applicationId) `
    -PreviousIds ($previousIds + [int]$tabProcess.ProcessId)
  $launchPath = Join-Path $temporaryRoot "legacy-sentinel-launch.json"
  $sentinelPath = Join-Path $temporaryRoot "legacy-sentinel-authority.json"
  $launch = [ordered]@{
    schemaVersion = 1
    kind = "managed-device-legacy-sentinel-launch/v1"
    clients = @(
      [ordered]@{
        profileId = "browser-tab"
        processId = [int]$tabProcess.ProcessId
        cdpEndpoint = Wait-CdpEndpoint -Port $tabPort
      },
      [ordered]@{
        profileId = "installed-pwa"
        processId = [int]$pwaProcess.ProcessId
        cdpEndpoint = Wait-CdpEndpoint -Port $pwaPort
      }
    )
  }
  $launch | ConvertTo-Json -Depth 20 -Compress | Set-Content `
    -LiteralPath $launchPath `
    -Encoding utf8 `
    -NoNewline
  try {
    & $nodeExecutable $sentinelScript `
      --request $resolvedRequest `
      --launch $launchPath `
      --output $sentinelPath
    if ($LASTEXITCODE -ne 0) {
      throw "Managed device legacy sentinel preparation failed."
    }
  } finally {
    Stop-ManagedProfileProcesses `
      -BrowserPath $browserPath `
      -ProfileRoots @(
        $profileRoots["browser-tab"],
        $profileRoots["installed-pwa"]
      )
  }
  return $sentinelPath
}

function Invoke-LiveCycle {
  param([Parameter(Mandatory = $true)][string]$Cycle)

  Stop-ManagedProfileProcesses `
    -BrowserPath $browserPath `
    -ProfileRoots @(
      $profileRoots["browser-tab"],
      $profileRoots["installed-pwa"]
    )
  $previousIds = @(
    Get-CimInstance Win32_Process | ForEach-Object { [int]$_.ProcessId }
  )
  $tabPort = Reserve-LoopbackPort
  $pwaPort = Reserve-LoopbackPort
  if ($tabPort -eq $pwaPort) {
    throw "Managed device CDP ports are ambiguous."
  }
  $commonTabArguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$tabPort",
    "--remote-allow-origins=http://127.0.0.1:$tabPort",
    "--user-data-dir=$($profileRoots['browser-tab'])",
    "--profile-directory=$($profiles[0].profileName)",
    "--new-window",
    [string]$device.installedPwaLaunchAuthority.installUrl
  )
  Start-Process `
    -FilePath $browserPath `
    -ArgumentList $commonTabArguments `
    -WindowStyle Hidden
  $tabProcess = Get-NewManagedBrowserProcess `
    -BrowserPath $browserPath `
    -ProfileRoot $profileRoots["browser-tab"] `
    -ProfileName ([string]$profiles[0].profileName) `
    -Port $tabPort `
    -ClientKind "browser-tab" `
    -ApplicationId ([string]$device.installedPwaLaunchAuthority.applicationId) `
    -PreviousIds $previousIds

  $pwaExtraArguments = @(
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=$pwaPort",
    "--remote-allow-origins=http://127.0.0.1:$pwaPort"
  )
  Start-Process `
    -FilePath ([string]$installedShortcut.Path) `
    -ArgumentList $pwaExtraArguments `
    -WindowStyle Hidden
  $pwaProcess = Get-NewManagedBrowserProcess `
    -BrowserPath $browserPath `
    -ProfileRoot $profileRoots["installed-pwa"] `
    -ProfileName ([string]$profiles[1].profileName) `
    -Port $pwaPort `
    -ClientKind "installed-pwa" `
    -ApplicationId ([string]$device.installedPwaLaunchAuthority.applicationId) `
    -PreviousIds ($previousIds + [int]$tabProcess.ProcessId)

  $tabEndpoint = Wait-CdpEndpoint -Port $tabPort
  $pwaEndpoint = Wait-CdpEndpoint -Port $pwaPort
  $launchPath = Join-Path $temporaryRoot "$Cycle-launch.json"
  $probePath = Join-Path $temporaryRoot "$Cycle-probe.json"
  $launch = [ordered]@{
    schemaVersion = 1
    kind = "managed-device-live-launch-authority/v1"
    cycle = $Cycle
    clients = @(
      [ordered]@{
        profileId = "browser-tab"
        processId = [int]$tabProcess.ProcessId
        executableSha256 = Get-Sha256File -Path ([string]$tabProcess.ExecutablePath)
        cimCommandLineBytesBase64 = Get-Base64Text -Value ([string]$tabProcess.CommandLine)
        cdpEndpoint = $tabEndpoint
      },
      [ordered]@{
        profileId = "installed-pwa"
        processId = [int]$pwaProcess.ProcessId
        executableSha256 = Get-Sha256File -Path ([string]$pwaProcess.ExecutablePath)
        cimCommandLineBytesBase64 = Get-Base64Text -Value ([string]$pwaProcess.CommandLine)
        cdpEndpoint = $pwaEndpoint
      }
    )
  }
  $launch | ConvertTo-Json -Depth 20 -Compress | Set-Content `
    -LiteralPath $launchPath `
    -Encoding utf8 `
    -NoNewline
  try {
    & $nodeExecutable $probeScript `
      --request $resolvedRequest `
      --launch $launchPath `
      --output $probePath
    if ($LASTEXITCODE -ne 0) {
      throw "Managed device live probe failed for $Cycle."
    }
  } finally {
    Stop-ManagedProfileProcesses `
      -BrowserPath $browserPath `
      -ProfileRoots @(
        $profileRoots["browser-tab"],
        $profileRoots["installed-pwa"]
      )
  }
  return [pscustomobject]@{
    ProbePath = $probePath
    Closure = [ordered]@{
      cycle = $Cycle
      processIds = @(
        [int]$tabProcess.ProcessId,
        [int]$pwaProcess.ProcessId
      )
      remainingProcessCount = 0
      closedAt = [DateTime]::UtcNow.ToString(
        "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
        [Globalization.CultureInfo]::InvariantCulture
      )
    }
  }
}

$sentinelPath = Initialize-LegacySentinels
$sentinelAuthority = Get-Content `
  -LiteralPath $sentinelPath `
  -Raw `
  -Encoding utf8 | ConvertFrom-Json -Depth 100
$initialCycle = Invoke-LiveCycle -Cycle "initial"
$reopenedCycle = Invoke-LiveCycle -Cycle "reopened"
$initialPath = [string]$initialCycle.ProbePath
$reopenedPath = [string]$reopenedCycle.ProbePath
$hostPath = Join-Path $temporaryRoot "live-host.json"
$host = [ordered]@{
  runnerGroup = $runnerGroup
  runnerLabels = $runnerLabels
  operatingSystem = [ordered]@{
    family = "windows"
    release = "11"
    architecture = "x64"
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
    shortcutPathSha256 = Get-Sha256Text -Value ([string]$installedShortcut.Path)
    shortcutArgumentsSha256 = Get-Sha256Text -Value ([string]$installedShortcut.Arguments)
  }
  closures = @(
    $initialCycle.Closure,
    $reopenedCycle.Closure
  )
  legacySentinels = @($sentinelAuthority.profiles)
}
$host | ConvertTo-Json -Depth 20 -Compress | Set-Content `
  -LiteralPath $hostPath `
  -Encoding utf8 `
  -NoNewline

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
  & $nodeExecutable $finalizerScript `
    --request $resolvedRequest `
    --host $hostPath `
    --initial $initialPath `
    --reopened $reopenedPath `
    --output ([IO.Path]::GetFullPath($OutputPath))
  if ($LASTEXITCODE -ne 0) {
    throw "Managed device live stage finalizer failed."
  }
} finally {
  Remove-Item `
    -LiteralPath "Env:\FOUNDATION_DEVICE_ATTESTATION_PRIVATE_KEY_PEM" `
    -ErrorAction SilentlyContinue
  Remove-Item `
    -LiteralPath "Env:\FOUNDATION_DEVICE_ATTESTATION_PUBLIC_KEY_PEM" `
    -ErrorAction SilentlyContinue
}
