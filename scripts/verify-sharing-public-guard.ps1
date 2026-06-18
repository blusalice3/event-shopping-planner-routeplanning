[Console]::InputEncoding  = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding           = [Text.UTF8Encoding]::new($false)
chcp 65001 > $null
Add-Type -AssemblyName System.Net.Http

$publicGateEnabled = $env:VITE_SHARING_PUBLIC_GATE_ENABLED -eq 'true'

function Assert-FileContains {
  param(
    [string]$RelativePath,
    [string[]]$RequiredFragments
  )

  $path = Join-Path $PSScriptRoot "..\$RelativePath"
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required public Guard artifact is missing: $RelativePath"
  }

  $text = Get-Content -LiteralPath $path -Encoding utf8 -Raw
  foreach ($fragment in $RequiredFragments) {
    if (-not $text.Contains($fragment)) {
      throw "Required public Guard fragment is missing from ${RelativePath}: $fragment"
    }
  }
}

Assert-FileContains -RelativePath 'package.json' -RequiredFragments @(
  '"build": "npm run sharing:public-guard:check && tsc && vite build"',
  '"sharing:public-guard:check"',
  '"sharing:public-guard:unit"'
)

Assert-FileContains -RelativePath '.env.example' -RequiredFragments @(
  'VITE_SHARING_PUBLIC_GATE_ENABLED=false',
  'VITE_SHARING_EDGE_GUARD_URL=',
  'VITE_SHARING_CONTRACT_VERSION=1',
  'SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK=false',
  'SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK=false'
)

Assert-FileContains -RelativePath 'docs/sharing-public-guard.md' -RequiredFragments @(
  '[PUBLIC-GUARD]',
  'POST /guard-create-room',
  'POST /guard-prepare-join',
  'POST /guard-prepare-restore',
  'fallback',
  "app.sharing_public_mode = 'public'",
  'RATE_LIMITED',
  'retry_after_seconds'
)

Assert-FileContains -RelativePath 'src/lib/supabase.ts' -RequiredFragments @(
  'VITE_SHARING_PUBLIC_GATE_ENABLED',
  'VITE_SHARING_EDGE_GUARD_URL',
  'PUBLIC_GUARD_UNCONFIGURED',
  'public_guard'
)

Assert-FileContains -RelativePath 'src/features/sharing/client.ts' -RequiredFragments @(
  'publicGuardUnavailableEnvelope',
  'prepareCreateRoomViaPublicGuard',
  'prepareJoinViaPublicGuard',
  'prepareRestoreViaPublicGuard',
  'prepare_create_room_challenge',
  'prepare_room_member_token',
  'prepare_restore_member_token'
)

Assert-FileContains -RelativePath 'src/features/sharing/publicGuardClient.ts' -RequiredFragments @(
  'guard-create-room',
  'guard-prepare-join',
  'guard-prepare-restore',
  'Authorization',
  'X-Sharing-Contract-Version',
  'X-Sharing-Device-Id',
  'CONTRACT_VERSION_MISMATCH',
  'GUARD_UNAVAILABLE',
  'retry_after_seconds'
)

Assert-FileContains -RelativePath 'src/features/sharing/clientPublicGuard.test.ts' -RequiredFragments @(
  'does not fall back to direct DB bootstrap',
  'PUBLIC_GUARD_UNCONFIGURED',
  'GUARD_UNAVAILABLE'
)

Assert-FileContains -RelativePath 'src/features/sharing/publicGuardEdgeCanonical.test.ts' -RequiredFragments @(
  'canonicalizeCreatePayloadForGuard',
  'CHALLENGE_INVALID',
  'plaintext_fingerprint'
)

Assert-FileContains -RelativePath 'src/features/sharing/SharingMvp0cPanel.test.tsx' -RequiredFragments @(
  'public_guard',
  'public Guard',
  'toBeDisabled',
  'toBeEnabled'
)

Assert-FileContains -RelativePath 'supabase/functions/guard-create-room/index.ts' -RequiredFragments @(
  'guardCreateRoom',
  'servePublicGuard'
)

Assert-FileContains -RelativePath 'supabase/functions/guard-prepare-join/index.ts' -RequiredFragments @(
  'guardPrepareJoin',
  'servePublicGuard'
)

Assert-FileContains -RelativePath 'supabase/functions/guard-prepare-restore/index.ts' -RequiredFragments @(
  'guardPrepareRestore',
  'servePublicGuard'
)

Assert-FileContains -RelativePath 'supabase/functions/_shared/public-guard.ts' -RequiredFragments @(
  'verifySupabaseJwt',
  'auth/v1/user',
  'guard_check_edge_rate_limit_internal',
  'guard_prepare_create_room_internal',
  'guard_prepare_join_internal',
  'guard_prepare_restore_internal',
  'canonicalizeCreatePayloadForGuard',
  'CHALLENGE_INVALID',
  'CONTRACT_VERSION_MISMATCH',
  'x-sharing-contract-version'
)

Assert-FileContains -RelativePath 'supabase/migrations/20260614213100_sharing_mvp0b_security_challenges.sql' -RequiredFragments @(
  'private.direct_bootstrap_disallowed',
  'GUARD_REQUIRED',
  'private.guard_service_role_claim_ok',
  'request.jwt.claims',
  'guard_prepare_create_room_internal',
  'guard_prepare_join_internal',
  'guard_prepare_restore_internal',
  'to service_role'
)

Assert-FileContains -RelativePath 'supabase/migrations/20260615002000_sharing_mvp2c_route_ack_contract_fix.sql' -RequiredFragments @(
  'p_challenge_id uuid',
  'private.consume_bootstrap_challenge',
  'PAYLOAD_PROTECTION_REQUIRED',
  'CHALLENGE_INVALID',
  'pgp_sym_decrypt_bytea'
)

Assert-FileContains -RelativePath 'supabase/migrations/20260615003000_sharing_public_guard_edge_rate_limit.sql' -RequiredFragments @(
  '[PUBLIC-GUARD]',
  'guard_edge_rate_limit_buckets',
  'guard_check_edge_rate_limit_internal',
  'RATE_LIMITED',
  'cfg.bootstrap_attempt_window_seconds',
  'to service_role'
)

Assert-FileContains -RelativePath 'supabase/migrations/20260615004000_sharing_public_guard_edge_rate_limit_privileges.sql' -RequiredFragments @(
  'from public, anon, authenticated',
  'to service_role'
)

Assert-FileContains -RelativePath 'supabase/tests/database/sharing_public_guard_edge_rate_limit.sql' -RequiredFragments @(
  'service_role can execute public Guard Edge rate limit RPC',
  'rejects missing service_role JWT claim',
  'RATE_LIMITED'
)

Assert-FileContains -RelativePath '.github/workflows/sharing-public-guard.yml' -RequiredFragments @(
  'public-guard-static',
  'public-guard-db-boundary',
  'public-guard-live',
  'sharing_guard_public_edge_integration'
)

$reviewPath = Join-Path $PSScriptRoot '..\docs\sharing-public-guard-review.md'
if (-not (Test-Path -LiteralPath $reviewPath)) {
  throw 'docs/sharing-public-guard-review.md is required for public Guard release review evidence.'
}

$reviewText = Get-Content -LiteralPath $reviewPath -Encoding utf8 -Raw
$requiredMarkers = @(
  '[PUBLIC-GUARD-REVIEW-COMPLETE]',
  'CSP_REVIEW=pass',
  'XSS_REVIEW=pass',
  'LOCAL_STORAGE_CREDENTIAL_RISK=acknowledged',
  'LOG_REDACTION_REVIEW=pass',
  'FALLBACK_PROHIBITION_TEST=pass',
  'DB_DIRECT_RPC_REJECTION_TEST=pass',
  'EDGE_GUARD_INTEGRATION_TEST=pass',
  'CSP_DEPLOYMENT_CONFIG=vercel.json',
  'EDGE_GUARD_MUTATING_CHECK=acknowledged'
)

foreach ($marker in $requiredMarkers) {
  if (-not $reviewText.Contains($marker)) {
    throw "Public Guard release review marker is missing: $marker"
  }
}

$vercelPath = Join-Path $PSScriptRoot '..\vercel.json'
if (-not (Test-Path -LiteralPath $vercelPath)) {
  throw 'vercel.json is required so the public release CSP can be verified.'
}

$vercelText = Get-Content -LiteralPath $vercelPath -Encoding utf8 -Raw
$vercelConfig = $vercelText | ConvertFrom-Json
$cspHeader = $null
foreach ($headerGroup in $vercelConfig.headers) {
  foreach ($header in $headerGroup.headers) {
    if ($header.key -eq 'Content-Security-Policy') {
      $cspHeader = [string]$header.value
    }
  }
}

if ([string]::IsNullOrWhiteSpace($cspHeader)) {
  throw 'Content-Security-Policy is required in vercel.json for public Guard release.'
}

$requiredCspFragments = @(
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  'connect-src',
  'https://*.supabase.co',
  'wss://*.supabase.co'
)

foreach ($fragment in $requiredCspFragments) {
  if (-not $cspHeader.Contains($fragment)) {
    throw "Content-Security-Policy is missing required fragment: $fragment"
  }
}

if (-not $publicGateEnabled) {
  Write-Host 'Sharing public Guard static check passed; live Guard rehearsal skipped because VITE_SHARING_PUBLIC_GATE_ENABLED is not true.'
  exit 0
}

if ([string]::IsNullOrWhiteSpace($env:VITE_SHARING_EDGE_GUARD_URL)) {
  throw 'VITE_SHARING_EDGE_GUARD_URL is required when VITE_SHARING_PUBLIC_GATE_ENABLED=true.'
}

if ($env:VITE_SHARING_CONTRACT_VERSION -ne '1') {
  throw 'VITE_SHARING_CONTRACT_VERSION must be 1 for the current sharing Guard contract.'
}

if ($env:SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK -ne 'true') {
  throw 'SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK=true is required after CSP/XSS/localStorage credential and log redaction review.'
}

if ($env:SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK -ne 'true') {
  throw 'SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK=true is required because the public Guard integration check creates a disposable sharing room.'
}

if ([string]::IsNullOrWhiteSpace($env:VITE_SUPABASE_URL)) {
  throw 'VITE_SUPABASE_URL is required for the public Guard integration check.'
}

if ([string]::IsNullOrWhiteSpace($env:VITE_SUPABASE_ANON_KEY)) {
  throw 'VITE_SUPABASE_ANON_KEY is required for the public Guard integration check.'
}

function ConvertTo-Base64Url {
  param([byte[]]$Bytes)

  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-Sha256Base64Url {
  param([string]$Value)

  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ConvertTo-Base64Url -Bytes $sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Value))
  } finally {
    $sha.Dispose()
  }
}

function New-RandomBase64Url {
  param([int]$ByteCount)

  $bytes = New-Object byte[] $ByteCount
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    return ConvertTo-Base64Url -Bytes $bytes
  } finally {
    $rng.Dispose()
  }
}

function Invoke-JsonRequest {
  param(
    [string]$Uri,
    [string]$Method = 'Post',
    [hashtable]$Headers,
    $Body
  )

  $jsonBody = $null
  if ($null -ne $Body) {
    if ($Body -is [string]) {
      $jsonBody = $Body
    } else {
      $jsonBody = $Body | ConvertTo-Json -Depth 50 -Compress
    }
  }

  try {
    $response = Invoke-WebRequest `
      -Uri $Uri `
      -Method $Method `
      -Headers $Headers `
      -Body $jsonBody `
      -UseBasicParsing `
      -ErrorAction Stop

    $json = if ([string]::IsNullOrWhiteSpace($response.Content)) {
      $null
    } else {
      $response.Content | ConvertFrom-Json
    }

    return [pscustomobject]@{
      StatusCode = [int]$response.StatusCode
      Content = $response.Content
      Json = $json
    }
  } catch {
    if ($_.Exception.Response -eq $null) {
      throw "Request failed before receiving an HTTP response: $Uri"
    }

    $errorResponse = $_.Exception.Response
    $statusCode = 0
    $content = ''

    if ($errorResponse -is [System.Net.Http.HttpResponseMessage]) {
      $statusCode = [int]$errorResponse.StatusCode
      try {
        $content = $errorResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      } catch {
        $content = ''
      }
    } else {
      $statusCode = [int]$errorResponse.StatusCode
      $stream = $errorResponse.GetResponseStream()
      $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false))
      $content = $reader.ReadToEnd()
    }

    if ([string]::IsNullOrWhiteSpace($content) -and
        -not [string]::IsNullOrWhiteSpace($_.ErrorDetails.Message)) {
      $content = [string]$_.ErrorDetails.Message
    }

    $json = $null
    if (-not [string]::IsNullOrWhiteSpace($content)) {
      try {
        $json = $content | ConvertFrom-Json
      } catch {
        throw "Endpoint did not return JSON: $Uri"
      }
    }

    return [pscustomobject]@{
      StatusCode = $statusCode
      Content = $content
      Json = $json
    }
  }
}

function Assert-EnvelopeErrorCode {
  param(
    $Response,
    [string]$Uri,
    [string]$ExpectedCode
  )

  if ($Response.Json.ok -ne $false -or
      $Response.Json.error.code -ne $ExpectedCode -or
      [int]$Response.Json.error.contract_version -ne 1) {
    throw "Expected $ExpectedCode envelope from $Uri but received: $($Response.Content)"
  }
}

function Assert-EnvelopeSuccess {
  param(
    $Response,
    [string]$Uri
  )

  if ($Response.StatusCode -lt 200 -or
      $Response.StatusCode -ge 300 -or
      $Response.Json.ok -ne $true -or
      [int]$Response.Json.contract_version -ne 1) {
    throw "Expected success envelope from $Uri but received: $($Response.Content)"
  }
}

$guardBaseUrl = $env:VITE_SHARING_EDGE_GUARD_URL.TrimEnd('/')
$supabaseUrl = $env:VITE_SUPABASE_URL.TrimEnd('/')
$supabaseAnonKey = $env:VITE_SUPABASE_ANON_KEY

function New-AnonymousAccessToken {
  $authResponse = Invoke-JsonRequest `
    -Uri "$supabaseUrl/auth/v1/signup" `
    -Headers @{
      apikey = $supabaseAnonKey
      Authorization = "Bearer $supabaseAnonKey"
      'Content-Type' = 'application/json'
    } `
    -Body @{
      data = @{
        public_guard_check = 'true'
      }
      gotrue_meta_security = @{}
    }

  if ($authResponse.StatusCode -lt 200 -or
      $authResponse.StatusCode -ge 300 -or
      [string]::IsNullOrWhiteSpace($authResponse.Json.access_token)) {
    throw "Anonymous Supabase sign-in failed for the public Guard integration check: $($authResponse.Content)"
  }

  return [string]$authResponse.Json.access_token
}

$guardEndpoints = @(
  'guard-create-room',
  'guard-prepare-join',
  'guard-prepare-restore'
)

foreach ($endpoint in $guardEndpoints) {
  $uri = "$guardBaseUrl/$endpoint"
  $response = Invoke-JsonRequest `
    -Uri $uri `
    -Headers @{
      'Content-Type' = 'application/json'
      'X-Sharing-Contract-Version' = '1'
    } `
    -Body @{ contract_version = 1 }

  if ($response.StatusCode -ne 401) {
    throw "Public Guard unauthenticated smoke expected HTTP 401 from $uri but received $($response.StatusCode)."
  }
  Assert-EnvelopeErrorCode -Response $response -Uri $uri -ExpectedCode 'AUTH_REQUIRED'
}

$accessToken = New-AnonymousAccessToken
$deviceId = "public-guard-check-$([guid]::NewGuid().ToString('N'))"
$guardHeaders = @{
  Authorization = "Bearer $accessToken"
  'Content-Type' = 'application/json'
  'X-Sharing-Contract-Version' = '1'
  'X-Sharing-Device-Id' = $deviceId
}

$roomId = [guid]::NewGuid().ToString()
$canonicalPayload = '{"eventMetadata":{"eventName":"Public Guard Release Check"},"itemSnapshots":{},"schemaVersion":1}'
$fingerprint = Get-Sha256Base64Url -Value $canonicalPayload
$createGuardUri = "$guardBaseUrl/guard-create-room"
$badFingerprintResponse = Invoke-JsonRequest `
  -Uri $createGuardUri `
  -Headers $guardHeaders `
  -Body @{
    contract_version = 1
    room_id = $roomId
    canonical_payload = $canonicalPayload
    plaintext_fingerprint = ('A' * 43)
    item_count = 0
    canonical_schema_version = 1
    payload_protection_mode = 'encrypted'
  }
Assert-EnvelopeErrorCode -Response $badFingerprintResponse -Uri $createGuardUri -ExpectedCode 'CHALLENGE_INVALID'

$createGuardResponse = Invoke-JsonRequest `
  -Uri $createGuardUri `
  -Headers $guardHeaders `
  -Body @{
    contract_version = 1
    room_id = $roomId
    canonical_payload = $canonicalPayload
    plaintext_fingerprint = $fingerprint
    item_count = 0
    canonical_schema_version = 1
    payload_protection_mode = 'encrypted'
  }

Assert-EnvelopeSuccess -Response $createGuardResponse -Uri $createGuardUri

if ([string]::IsNullOrWhiteSpace($createGuardResponse.Json.data.challengeId) -or
    $createGuardResponse.Json.data.roomId -ne $roomId) {
  throw "Guard create response did not return the expected challenge for room $roomId."
}

$memberKey = New-RandomBase64Url -ByteCount 32
$memberRestoreToken = Get-Sha256Base64Url -Value ("restore:v1:$roomId" + ':' + $memberKey)
$rpcHeaders = @{
  apikey = $supabaseAnonKey
  Authorization = "Bearer $accessToken"
  'Content-Type' = 'application/json'
}

$createRoomRpcResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/create_room" `
  -Headers $rpcHeaders `
  -Body @{
    p_room_id = $roomId
    p_display_name = 'Public Guard Check'
    p_member_restore_token = $memberRestoreToken
    p_challenge_id = $createGuardResponse.Json.data.challengeId
  }

Assert-EnvelopeSuccess -Response $createRoomRpcResponse -Uri "$supabaseUrl/rest/v1/rpc/create_room"

if ([string]::IsNullOrWhiteSpace($createRoomRpcResponse.Json.data.roomCode)) {
  throw "create_room did not return a roomCode for the disposable public Guard room."
}

$reusedCreateChallengeResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/create_room" `
  -Headers $rpcHeaders `
  -Body @{
    p_room_id = $roomId
    p_display_name = 'Public Guard Check'
    p_member_restore_token = $memberRestoreToken
    p_challenge_id = $createGuardResponse.Json.data.challengeId
  }
Assert-EnvelopeErrorCode -Response $reusedCreateChallengeResponse -Uri "$supabaseUrl/rest/v1/rpc/create_room" -ExpectedCode 'CHALLENGE_INVALID'

$missingCreateChallengeResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/create_room" `
  -Headers $rpcHeaders `
  -Body @{
    p_room_id = [guid]::NewGuid().ToString()
    p_display_name = 'Public Guard Check'
    p_member_restore_token = $memberRestoreToken
    p_challenge_id = [guid]::NewGuid().ToString()
  }
Assert-EnvelopeErrorCode -Response $missingCreateChallengeResponse -Uri "$supabaseUrl/rest/v1/rpc/create_room" -ExpectedCode 'CHALLENGE_INVALID'

$roomCode = [string]$createRoomRpcResponse.Json.data.roomCode
$joinGuardUri = "$guardBaseUrl/guard-prepare-join"
$joinGuardResponse = Invoke-JsonRequest `
  -Uri $joinGuardUri `
  -Headers $guardHeaders `
  -Body @{
    contract_version = 1
    room_code = $roomCode
  }

Assert-EnvelopeSuccess -Response $joinGuardResponse -Uri $joinGuardUri

if ([string]::IsNullOrWhiteSpace($joinGuardResponse.Json.data.challengeId) -or
    $joinGuardResponse.Json.data.roomId -ne $roomId) {
  throw "Guard join response did not return the expected challenge for room $roomId."
}

$wrongPurposeChallengeResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/create_room" `
  -Headers $rpcHeaders `
  -Body @{
    p_room_id = $roomId
    p_display_name = 'Public Guard Check'
    p_member_restore_token = $memberRestoreToken
    p_challenge_id = $joinGuardResponse.Json.data.challengeId
  }
Assert-EnvelopeErrorCode -Response $wrongPurposeChallengeResponse -Uri "$supabaseUrl/rest/v1/rpc/create_room" -ExpectedCode 'CHALLENGE_INVALID'

$restoreGuardUri = "$guardBaseUrl/guard-prepare-restore"
$restoreGuardResponse = Invoke-JsonRequest `
  -Uri $restoreGuardUri `
  -Headers $guardHeaders `
  -Body @{
    contract_version = 1
    room_id = $roomId
  }

Assert-EnvelopeSuccess -Response $restoreGuardResponse -Uri $restoreGuardUri

if ([string]::IsNullOrWhiteSpace($restoreGuardResponse.Json.data.challengeId) -or
    $restoreGuardResponse.Json.data.roomId -ne $roomId) {
  throw "Guard restore response did not return the expected challenge for room $roomId."
}

$directCreateResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/prepare_create_room_challenge" `
  -Headers $rpcHeaders `
  -Body @{
    p_client_room_id = [guid]::NewGuid().ToString()
    p_canonical_payload = $canonicalPayload
    p_plaintext_fingerprint = $fingerprint
    p_item_count = 0
    p_canonical_schema_version = 1
    p_payload_protection_mode = 'encrypted'
  }
Assert-EnvelopeErrorCode -Response $directCreateResponse -Uri "$supabaseUrl/rest/v1/rpc/prepare_create_room_challenge" -ExpectedCode 'GUARD_REQUIRED'

$directJoinResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/prepare_room_member_token" `
  -Headers $rpcHeaders `
  -Body @{
    p_room_code = $roomCode
  }
Assert-EnvelopeErrorCode -Response $directJoinResponse -Uri "$supabaseUrl/rest/v1/rpc/prepare_room_member_token" -ExpectedCode 'GUARD_REQUIRED'

$directRestoreResponse = Invoke-JsonRequest `
  -Uri "$supabaseUrl/rest/v1/rpc/prepare_restore_member_token" `
  -Headers $rpcHeaders `
  -Body @{
    p_room_id = $roomId
  }
Assert-EnvelopeErrorCode -Response $directRestoreResponse -Uri "$supabaseUrl/rest/v1/rpc/prepare_restore_member_token" -ExpectedCode 'GUARD_REQUIRED'

$rateLimitToken = New-AnonymousAccessToken
$rateLimitHeaders = @{
  Authorization = "Bearer $rateLimitToken"
  'Content-Type' = 'application/json'
  'X-Sharing-Contract-Version' = '1'
  'X-Sharing-Device-Id' = "public-guard-rate-limit-$([guid]::NewGuid().ToString('N'))"
}
$rateLimited = $false
for ($attempt = 1; $attempt -le 12; $attempt++) {
  $rateLimitResponse = Invoke-JsonRequest `
    -Uri $restoreGuardUri `
    -Headers $rateLimitHeaders `
    -Body @{
      contract_version = 1
      room_id = [guid]::NewGuid().ToString()
    }

  if ($rateLimitResponse.Json.ok -eq $false -and
      $rateLimitResponse.Json.error.code -eq 'RATE_LIMITED') {
    if ([int]$rateLimitResponse.Json.error.retry_after_seconds -le 0) {
      throw "Public Guard rate limit did not return a positive retry_after_seconds: $($rateLimitResponse.Content)"
    }
    $rateLimited = $true
    break
  }

  if ($rateLimitResponse.Json.ok -ne $false -or
      $rateLimitResponse.Json.error.code -ne 'ROOM_UNAVAILABLE') {
    throw "Public Guard rate limit rehearsal expected ROOM_UNAVAILABLE before RATE_LIMITED but received: $($rateLimitResponse.Content)"
  }
}

if (-not $rateLimited) {
  throw 'Public Guard rate limit rehearsal did not observe RATE_LIMITED within 12 restore attempts.'
}

Write-Host 'Sharing public Guard check passed.'
