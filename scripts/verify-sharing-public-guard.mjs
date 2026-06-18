import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const publicGateEnabled = process.env.VITE_SHARING_PUBLIC_GATE_ENABLED === 'true';

const readUtf8 = (relativePath) =>
  readFileSync(path.join(repoRoot, relativePath), 'utf8');

const assertFileContains = (relativePath, requiredFragments) => {
  let text;
  try {
    text = readUtf8(relativePath);
  } catch {
    throw new Error(`Required public Guard artifact is missing: ${relativePath}`);
  }

  for (const fragment of requiredFragments) {
    if (!text.includes(fragment)) {
      throw new Error(
        `Required public Guard fragment is missing from ${relativePath}: ${fragment}`,
      );
    }
  }
};

assertFileContains('package.json', [
  '"build": "npm run sharing:public-guard:check && tsc && vite build"',
  '"sharing:public-guard:check": "node scripts/verify-sharing-public-guard.mjs"',
  '"sharing:public-guard:unit"',
]);

assertFileContains('.env.example', [
  'VITE_SHARING_PUBLIC_GATE_ENABLED=false',
  'VITE_SHARING_EDGE_GUARD_URL=',
  'VITE_SHARING_CONTRACT_VERSION=1',
  'SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK=false',
  'SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK=false',
]);

assertFileContains('docs/sharing-public-guard.md', [
  '[PUBLIC-GUARD]',
  'POST /guard-create-room',
  'POST /guard-prepare-join',
  'POST /guard-prepare-restore',
  'fallback',
  "app.sharing_public_mode = 'public'",
  'RATE_LIMITED',
  'retry_after_seconds',
]);

assertFileContains('src/lib/supabase.ts', [
  'VITE_SHARING_PUBLIC_GATE_ENABLED',
  'VITE_SHARING_EDGE_GUARD_URL',
  'PUBLIC_GUARD_UNCONFIGURED',
  'public_guard',
]);

assertFileContains('src/features/sharing/client.ts', [
  'publicGuardUnavailableEnvelope',
  'prepareCreateRoomViaPublicGuard',
  'prepareJoinViaPublicGuard',
  'prepareRestoreViaPublicGuard',
  'prepare_create_room_challenge',
  'prepare_room_member_token',
  'prepare_restore_member_token',
]);

assertFileContains('src/features/sharing/publicGuardClient.ts', [
  'guard-create-room',
  'guard-prepare-join',
  'guard-prepare-restore',
  'Authorization',
  'X-Sharing-Contract-Version',
  'X-Sharing-Device-Id',
  'CONTRACT_VERSION_MISMATCH',
  'GUARD_UNAVAILABLE',
  'retry_after_seconds',
]);

assertFileContains('src/features/sharing/clientPublicGuard.test.ts', [
  'does not fall back to direct DB bootstrap',
  'PUBLIC_GUARD_UNCONFIGURED',
  'GUARD_UNAVAILABLE',
]);

assertFileContains('src/features/sharing/publicGuardEdgeCanonical.test.ts', [
  'canonicalizeCreatePayloadForGuard',
  'CHALLENGE_INVALID',
  'plaintext_fingerprint',
]);

assertFileContains('src/features/sharing/SharingMvp0cPanel.test.tsx', [
  'public_guard',
  'public Guard',
  'toBeDisabled',
  'toBeEnabled',
]);

assertFileContains('supabase/functions/guard-create-room/index.ts', [
  'guardCreateRoom',
  'servePublicGuard',
]);

assertFileContains('supabase/functions/guard-prepare-join/index.ts', [
  'guardPrepareJoin',
  'servePublicGuard',
]);

assertFileContains('supabase/functions/guard-prepare-restore/index.ts', [
  'guardPrepareRestore',
  'servePublicGuard',
]);

assertFileContains('supabase/functions/_shared/public-guard.ts', [
  'verifySupabaseJwt',
  'auth/v1/user',
  'guard_check_edge_rate_limit_internal',
  'guard_prepare_create_room_internal',
  'guard_prepare_join_internal',
  'guard_prepare_restore_internal',
  'canonicalizeCreatePayloadForGuard',
  'CHALLENGE_INVALID',
  'CONTRACT_VERSION_MISMATCH',
  'x-sharing-contract-version',
]);

assertFileContains('supabase/migrations/20260614213100_sharing_mvp0b_security_challenges.sql', [
  'private.direct_bootstrap_disallowed',
  'GUARD_REQUIRED',
  'private.guard_service_role_claim_ok',
  'request.jwt.claims',
  'guard_prepare_create_room_internal',
  'guard_prepare_join_internal',
  'guard_prepare_restore_internal',
  'to service_role',
]);

assertFileContains('supabase/migrations/20260615002000_sharing_mvp2c_route_ack_contract_fix.sql', [
  'p_challenge_id uuid',
  'private.consume_bootstrap_challenge',
  'PAYLOAD_PROTECTION_REQUIRED',
  'CHALLENGE_INVALID',
  'pgp_sym_decrypt_bytea',
]);

assertFileContains('supabase/migrations/20260615003000_sharing_public_guard_edge_rate_limit.sql', [
  '[PUBLIC-GUARD]',
  'guard_edge_rate_limit_buckets',
  'guard_check_edge_rate_limit_internal',
  'RATE_LIMITED',
  'cfg.bootstrap_attempt_window_seconds',
  'to service_role',
]);

assertFileContains('supabase/migrations/20260615004000_sharing_public_guard_edge_rate_limit_privileges.sql', [
  'from public, anon, authenticated',
  'to service_role',
]);

assertFileContains('supabase/tests/database/sharing_public_guard_edge_rate_limit.sql', [
  'service_role can execute public Guard Edge rate limit RPC',
  'rejects missing service_role JWT claim',
  'RATE_LIMITED',
]);

assertFileContains('.github/workflows/sharing-public-guard.yml', [
  'public-guard-static',
  'public-guard-db-boundary',
  'public-guard-live',
  'sharing_guard_public_edge_integration',
]);

const reviewText = readUtf8('docs/sharing-public-guard-review.md');
for (const marker of [
  '[PUBLIC-GUARD-REVIEW-COMPLETE]',
  'CSP_REVIEW=pass',
  'XSS_REVIEW=pass',
  'LOCAL_STORAGE_CREDENTIAL_RISK=acknowledged',
  'LOG_REDACTION_REVIEW=pass',
  'FALLBACK_PROHIBITION_TEST=pass',
  'DB_DIRECT_RPC_REJECTION_TEST=pass',
  'EDGE_GUARD_INTEGRATION_TEST=pass',
  'CSP_DEPLOYMENT_CONFIG=vercel.json',
  'EDGE_GUARD_MUTATING_CHECK=acknowledged',
]) {
  if (!reviewText.includes(marker)) {
    throw new Error(`Public Guard release review marker is missing: ${marker}`);
  }
}

let vercelConfig;
try {
  vercelConfig = JSON.parse(readUtf8('vercel.json'));
} catch {
  throw new Error('vercel.json is required so the public release CSP can be verified.');
}

const cspHeader = vercelConfig.headers
  ?.flatMap((headerGroup) => headerGroup.headers ?? [])
  .find((header) => header.key === 'Content-Security-Policy')
  ?.value;

if (!cspHeader || !String(cspHeader).trim()) {
  throw new Error('Content-Security-Policy is required in vercel.json for public Guard release.');
}

for (const fragment of [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  'connect-src',
  'https://*.supabase.co',
  'wss://*.supabase.co',
]) {
  if (!cspHeader.includes(fragment)) {
    throw new Error(`Content-Security-Policy is missing required fragment: ${fragment}`);
  }
}

if (!publicGateEnabled) {
  console.log(
    'Sharing public Guard static check passed; live Guard rehearsal skipped because VITE_SHARING_PUBLIC_GATE_ENABLED is not true.',
  );
  process.exit(0);
}

const requireEnv = (name, message) => {
  if (!process.env[name] || !process.env[name].trim()) {
    throw new Error(message);
  }
  return process.env[name].trim();
};

const guardBaseUrl = requireEnv(
  'VITE_SHARING_EDGE_GUARD_URL',
  'VITE_SHARING_EDGE_GUARD_URL is required when VITE_SHARING_PUBLIC_GATE_ENABLED=true.',
).replace(/\/+$/u, '');

if (process.env.VITE_SHARING_CONTRACT_VERSION !== '1') {
  throw new Error('VITE_SHARING_CONTRACT_VERSION must be 1 for the current sharing Guard contract.');
}

if (process.env.SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK !== 'true') {
  throw new Error(
    'SHARING_PUBLIC_GUARD_RELEASE_CHECKLIST_ACK=true is required after CSP/XSS/localStorage credential and log redaction review.',
  );
}

if (process.env.SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK !== 'true') {
  throw new Error(
    'SHARING_PUBLIC_GUARD_MUTATING_CHECK_ACK=true is required because the public Guard integration check creates a disposable sharing room.',
  );
}

const supabaseUrl = requireEnv(
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_URL is required for the public Guard integration check.',
).replace(/\/+$/u, '');
const supabaseAnonKey = requireEnv(
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY is required for the public Guard integration check.',
);

const toBase64Url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256Base64Url = (value) =>
  createHash('sha256').update(value, 'utf8').digest('base64url');
const randomBase64Url = (byteCount) => toBase64Url(randomBytes(byteCount));

const invokeJsonRequest = async (uri, { method = 'POST', headers = {}, body } = {}) => {
  const response = await fetch(uri, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const content = await response.text();
  let json = null;

  if (content.trim()) {
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error(`Endpoint did not return JSON: ${uri}`);
    }
  }

  return {
    statusCode: response.status,
    content,
    json,
  };
};

const assertEnvelopeErrorCode = (response, uri, expectedCode) => {
  if (
    response.json?.ok !== false ||
    response.json?.error?.code !== expectedCode ||
    Number(response.json?.error?.contract_version) !== 1
  ) {
    throw new Error(`Expected ${expectedCode} envelope from ${uri} but received: ${response.content}`);
  }
};

const assertEnvelopeSuccess = (response, uri) => {
  if (
    response.statusCode < 200 ||
    response.statusCode >= 300 ||
    response.json?.ok !== true ||
    Number(response.json?.contract_version) !== 1
  ) {
    throw new Error(`Expected success envelope from ${uri} but received: ${response.content}`);
  }
};

const newAnonymousAccessToken = async () => {
  const authResponse = await invokeJsonRequest(`${supabaseUrl}/auth/v1/signup`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: {
      data: {
        public_guard_check: 'true',
      },
      gotrue_meta_security: {},
    },
  });

  if (
    authResponse.statusCode < 200 ||
    authResponse.statusCode >= 300 ||
    !authResponse.json?.access_token
  ) {
    throw new Error(
      `Anonymous Supabase sign-in failed for the public Guard integration check: ${authResponse.content}`,
    );
  }

  return String(authResponse.json.access_token);
};

for (const endpoint of ['guard-create-room', 'guard-prepare-join', 'guard-prepare-restore']) {
  const uri = `${guardBaseUrl}/${endpoint}`;
  const response = await invokeJsonRequest(uri, {
    headers: {
      'Content-Type': 'application/json',
      'X-Sharing-Contract-Version': '1',
    },
    body: { contract_version: 1 },
  });

  if (response.statusCode !== 401) {
    throw new Error(
      `Public Guard unauthenticated smoke expected HTTP 401 from ${uri} but received ${response.statusCode}.`,
    );
  }
  assertEnvelopeErrorCode(response, uri, 'AUTH_REQUIRED');
}

const accessToken = await newAnonymousAccessToken();
const deviceId = `public-guard-check-${randomUUID().replace(/-/gu, '')}`;
const guardHeaders = {
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'X-Sharing-Contract-Version': '1',
  'X-Sharing-Device-Id': deviceId,
};

const roomId = randomUUID();
const canonicalPayload =
  '{"eventMetadata":{"eventName":"Public Guard Release Check"},"itemSnapshots":{},"schemaVersion":1}';
const fingerprint = sha256Base64Url(canonicalPayload);
const createGuardUri = `${guardBaseUrl}/guard-create-room`;

const badFingerprintResponse = await invokeJsonRequest(createGuardUri, {
  headers: guardHeaders,
  body: {
    contract_version: 1,
    room_id: roomId,
    canonical_payload: canonicalPayload,
    plaintext_fingerprint: 'A'.repeat(43),
    item_count: 0,
    canonical_schema_version: 1,
    payload_protection_mode: 'encrypted',
  },
});
assertEnvelopeErrorCode(badFingerprintResponse, createGuardUri, 'CHALLENGE_INVALID');

const createGuardResponse = await invokeJsonRequest(createGuardUri, {
  headers: guardHeaders,
  body: {
    contract_version: 1,
    room_id: roomId,
    canonical_payload: canonicalPayload,
    plaintext_fingerprint: fingerprint,
    item_count: 0,
    canonical_schema_version: 1,
    payload_protection_mode: 'encrypted',
  },
});
assertEnvelopeSuccess(createGuardResponse, createGuardUri);

if (
  !createGuardResponse.json?.data?.challengeId ||
  createGuardResponse.json.data.roomId !== roomId
) {
  throw new Error(`Guard create response did not return the expected challenge for room ${roomId}.`);
}

const memberKey = randomBase64Url(32);
const memberRestoreToken = sha256Base64Url(`restore:v1:${roomId}:${memberKey}`);
const rpcHeaders = {
  apikey: supabaseAnonKey,
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};

const createRoomRpcUri = `${supabaseUrl}/rest/v1/rpc/create_room`;
const createRoomRpcResponse = await invokeJsonRequest(createRoomRpcUri, {
  headers: rpcHeaders,
  body: {
    p_room_id: roomId,
    p_display_name: 'Public Guard Check',
    p_member_restore_token: memberRestoreToken,
    p_challenge_id: createGuardResponse.json.data.challengeId,
  },
});
assertEnvelopeSuccess(createRoomRpcResponse, createRoomRpcUri);

if (!createRoomRpcResponse.json?.data?.roomCode) {
  throw new Error('create_room did not return a roomCode for the disposable public Guard room.');
}

const reusedCreateChallengeResponse = await invokeJsonRequest(createRoomRpcUri, {
  headers: rpcHeaders,
  body: {
    p_room_id: roomId,
    p_display_name: 'Public Guard Check',
    p_member_restore_token: memberRestoreToken,
    p_challenge_id: createGuardResponse.json.data.challengeId,
  },
});
assertEnvelopeErrorCode(reusedCreateChallengeResponse, createRoomRpcUri, 'CHALLENGE_INVALID');

const missingCreateChallengeResponse = await invokeJsonRequest(createRoomRpcUri, {
  headers: rpcHeaders,
  body: {
    p_room_id: randomUUID(),
    p_display_name: 'Public Guard Check',
    p_member_restore_token: memberRestoreToken,
    p_challenge_id: randomUUID(),
  },
});
assertEnvelopeErrorCode(missingCreateChallengeResponse, createRoomRpcUri, 'CHALLENGE_INVALID');

const roomCode = String(createRoomRpcResponse.json.data.roomCode);
const joinGuardUri = `${guardBaseUrl}/guard-prepare-join`;
const joinGuardResponse = await invokeJsonRequest(joinGuardUri, {
  headers: guardHeaders,
  body: {
    contract_version: 1,
    room_code: roomCode,
  },
});
assertEnvelopeSuccess(joinGuardResponse, joinGuardUri);

if (!joinGuardResponse.json?.data?.challengeId || joinGuardResponse.json.data.roomId !== roomId) {
  throw new Error(`Guard join response did not return the expected challenge for room ${roomId}.`);
}

const wrongPurposeChallengeResponse = await invokeJsonRequest(createRoomRpcUri, {
  headers: rpcHeaders,
  body: {
    p_room_id: roomId,
    p_display_name: 'Public Guard Check',
    p_member_restore_token: memberRestoreToken,
    p_challenge_id: joinGuardResponse.json.data.challengeId,
  },
});
assertEnvelopeErrorCode(wrongPurposeChallengeResponse, createRoomRpcUri, 'CHALLENGE_INVALID');

const restoreGuardUri = `${guardBaseUrl}/guard-prepare-restore`;
const restoreGuardResponse = await invokeJsonRequest(restoreGuardUri, {
  headers: guardHeaders,
  body: {
    contract_version: 1,
    room_id: roomId,
  },
});
assertEnvelopeSuccess(restoreGuardResponse, restoreGuardUri);

if (
  !restoreGuardResponse.json?.data?.challengeId ||
  restoreGuardResponse.json.data.roomId !== roomId
) {
  throw new Error(`Guard restore response did not return the expected challenge for room ${roomId}.`);
}

const directCreateUri = `${supabaseUrl}/rest/v1/rpc/prepare_create_room_challenge`;
const directCreateResponse = await invokeJsonRequest(directCreateUri, {
  headers: rpcHeaders,
  body: {
    p_client_room_id: randomUUID(),
    p_canonical_payload: canonicalPayload,
    p_plaintext_fingerprint: fingerprint,
    p_item_count: 0,
    p_canonical_schema_version: 1,
    p_payload_protection_mode: 'encrypted',
  },
});
assertEnvelopeErrorCode(directCreateResponse, directCreateUri, 'GUARD_REQUIRED');

const directJoinUri = `${supabaseUrl}/rest/v1/rpc/prepare_room_member_token`;
const directJoinResponse = await invokeJsonRequest(directJoinUri, {
  headers: rpcHeaders,
  body: {
    p_room_code: roomCode,
  },
});
assertEnvelopeErrorCode(directJoinResponse, directJoinUri, 'GUARD_REQUIRED');

const directRestoreUri = `${supabaseUrl}/rest/v1/rpc/prepare_restore_member_token`;
const directRestoreResponse = await invokeJsonRequest(directRestoreUri, {
  headers: rpcHeaders,
  body: {
    p_room_id: roomId,
  },
});
assertEnvelopeErrorCode(directRestoreResponse, directRestoreUri, 'GUARD_REQUIRED');

const rateLimitToken = await newAnonymousAccessToken();
const rateLimitHeaders = {
  Authorization: `Bearer ${rateLimitToken}`,
  'Content-Type': 'application/json',
  'X-Sharing-Contract-Version': '1',
  'X-Sharing-Device-Id': `public-guard-rate-limit-${randomUUID().replace(/-/gu, '')}`,
};

let rateLimited = false;
for (let attempt = 1; attempt <= 12; attempt += 1) {
  const rateLimitResponse = await invokeJsonRequest(restoreGuardUri, {
    headers: rateLimitHeaders,
    body: {
      contract_version: 1,
      room_id: randomUUID(),
    },
  });

  if (rateLimitResponse.json?.ok === false && rateLimitResponse.json?.error?.code === 'RATE_LIMITED') {
    if (Number(rateLimitResponse.json.error.retry_after_seconds) <= 0) {
      throw new Error(
        `Public Guard rate limit did not return a positive retry_after_seconds: ${rateLimitResponse.content}`,
      );
    }
    rateLimited = true;
    break;
  }

  if (
    rateLimitResponse.json?.ok !== false ||
    rateLimitResponse.json?.error?.code !== 'ROOM_UNAVAILABLE'
  ) {
    throw new Error(
      `Public Guard rate limit rehearsal expected ROOM_UNAVAILABLE before RATE_LIMITED but received: ${rateLimitResponse.content}`,
    );
  }
}

if (!rateLimited) {
  throw new Error('Public Guard rate limit rehearsal did not observe RATE_LIMITED within 12 restore attempts.');
}

console.log('Sharing public Guard check passed.');
