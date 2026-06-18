const SHARING_CONTRACT_VERSION = 1;
const MAX_CANONICAL_CREATE_PAYLOAD_BYTES = 10 * 1024 * 1024;

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

type SharingErrorCode =
  | 'AUTH_REQUIRED'
  | 'CLIENT_UPGRADE_REQUIRED'
  | 'GUARD_UNAVAILABLE'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'CHALLENGE_INVALID'
  | 'CREATE_PAYLOAD_TOO_LARGE'
  | 'PERMISSION_DENIED'
  | 'SHARING_INTERNAL_ERROR';

type GuardPurpose = 'create_room' | 'join' | 'restore';

type GuardHandler = (context: GuardContext, body: Record<string, unknown>) => Promise<Response>;

type GuardContext = {
  authUserId: string;
  requestId: string;
  request: Request;
  env: GuardEnv;
};

type GuardEnv = {
  supabaseUrl: string;
  serviceRoleKey: string;
};

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, content-type, x-client-info, x-sharing-contract-version, x-sharing-device-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });

const errorEnvelope = (
  code: SharingErrorCode,
  requestId: string,
  status = 400,
  retryAfterSeconds?: number,
): Response =>
  jsonResponse(
    {
      ok: false,
      error: {
        code,
        retry_after_seconds: retryAfterSeconds,
        contract_version: SHARING_CONTRACT_VERSION,
        request_id: requestId,
      },
    },
    status,
  );

const successEnvelope = (data: unknown): Response =>
  jsonResponse({
    ok: true,
    data,
    contract_version: SHARING_CONTRACT_VERSION,
  });

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

class GuardCanonicalPayloadError extends Error {
  constructor(public readonly code: SharingErrorCode) {
    super(code);
    this.name = 'GuardCanonicalPayloadError';
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail();
    }
    return value;
  }

  private parseValue(): CanonicalJsonValue {
    const current = this.source[this.index];
    switch (current) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        return this.parseLiteral('true', true);
      case 'f':
        return this.parseLiteral('false', false);
      case 'n':
        return this.parseLiteral('null', null);
      default:
        if (current === '-' || (current >= '0' && current <= '9')) {
          return this.parseNumber();
        }
        this.fail();
    }
  }

  private parseObject(): { [key: string]: CanonicalJsonValue } {
    const result = Object.create(null) as { [key: string]: CanonicalJsonValue };
    const keys = new Set<string>();
    this.index++;
    this.skipWhitespace();
    if (this.consume('}')) return result;

    while (true) {
      if (this.source[this.index] !== '"') this.fail();
      const key = this.parseString();
      if (keys.has(key)) throw new GuardCanonicalPayloadError('INVALID_REQUEST');
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) this.fail();
      this.skipWhitespace();
      result[key] = this.parseValue();
      this.skipWhitespace();
      if (this.consume('}')) return result;
      if (!this.consume(',')) this.fail();
      this.skipWhitespace();
    }
  }

  private parseArray(): CanonicalJsonValue[] {
    const result: CanonicalJsonValue[] = [];
    this.index++;
    this.skipWhitespace();
    if (this.consume(']')) return result;

    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      if (this.consume(']')) return result;
      if (!this.consume(',')) this.fail();
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index++;

    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '"') {
        this.index++;
        const value = JSON.parse(this.source.slice(start, this.index)) as string;
        assertNoLoneSurrogate(value);
        return value;
      }
      if (char.charCodeAt(0) < 0x20) this.fail();
      if (char === '\\') {
        this.index++;
        const escape = this.source[this.index];
        if (escape === 'u') {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
          this.index += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) this.fail();
      }
      this.index++;
    }

    this.fail();
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!match) this.fail();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      throw new GuardCanonicalPayloadError('INVALID_REQUEST');
    }
    return Object.is(value, -0) ? 0 : value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (!this.source.startsWith(literal, this.index)) this.fail();
    this.index += literal.length;
    return value;
  }

  private consume(expected: string): boolean {
    if (this.source[this.index] !== expected) return false;
    this.index++;
    return true;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === ' ' ||
      this.source[this.index] === '\n' ||
      this.source[this.index] === '\r' ||
      this.source[this.index] === '\t'
    ) {
      this.index++;
    }
  }

  private fail(): never {
    throw new GuardCanonicalPayloadError('INVALID_REQUEST');
  }
}

const assertNoLoneSurrogate = (value: string): void => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new GuardCanonicalPayloadError('INVALID_REQUEST');
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new GuardCanonicalPayloadError('INVALID_REQUEST');
    }
  }
};

const normalizeNfc = (value: CanonicalJsonValue): CanonicalJsonValue => {
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GuardCanonicalPayloadError('INVALID_REQUEST');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeNfc);
  if (value && typeof value === 'object') {
    const normalized = Object.create(null) as { [key: string]: CanonicalJsonValue };
    const normalizedKeys = new Set<string>();
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.normalize('NFC');
      if (normalizedKeys.has(normalizedKey)) {
        throw new GuardCanonicalPayloadError('INVALID_REQUEST');
      }
      normalizedKeys.add(normalizedKey);
      normalized[normalizedKey] = normalizeNfc(child);
    }
    return normalized;
  }
  return value;
};

const canonicalizeJson = (value: CanonicalJsonValue): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GuardCanonicalPayloadError('INVALID_REQUEST');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJson).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(',')}}`;
};

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const sha256Base64Url = async (bytes: Uint8Array): Promise<string> => {
  const digestInput = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', digestInput);
  return base64Url(new Uint8Array(digest));
};

const validateRoomEventDataForCreate = (
  value: CanonicalJsonValue,
  roomId: string,
  itemCount: number,
): void => {
  const root = asObject(value);
  const eventMetadata = asObject(root.eventMetadata);
  const itemSnapshots = asObject(root.itemSnapshots);
  const eventName = eventMetadata.eventName;
  if (
    root.schemaVersion !== 1 ||
    typeof eventName !== 'string' ||
    eventName.length === 0 ||
    eventName.length > 200 ||
    !root.itemSnapshots ||
    Array.isArray(root.itemSnapshots) ||
    Object.keys(itemSnapshots).length !== itemCount
  ) {
    throw new GuardCanonicalPayloadError('INVALID_REQUEST');
  }

  if (typeof root.roomId === 'string' && root.roomId !== roomId) {
    throw new GuardCanonicalPayloadError('CHALLENGE_INVALID');
  }
};

export const canonicalizeCreatePayloadForGuard = async (
  rawPayload: string,
  roomId: string,
  itemCount: number,
): Promise<{ canonicalPayload: string; fingerprint: string; byteLength: number }> => {
  const rawBytes = new TextEncoder().encode(rawPayload);
  if (rawBytes.byteLength > MAX_CANONICAL_CREATE_PAYLOAD_BYTES) {
    throw new GuardCanonicalPayloadError('CREATE_PAYLOAD_TOO_LARGE');
  }

  const value = normalizeNfc(new StrictJsonParser(rawPayload).parse());
  validateRoomEventDataForCreate(value, roomId, itemCount);
  const canonicalPayload = canonicalizeJson(value);
  const canonicalBytes = new TextEncoder().encode(canonicalPayload);
  if (canonicalBytes.byteLength > MAX_CANONICAL_CREATE_PAYLOAD_BYTES) {
    throw new GuardCanonicalPayloadError('CREATE_PAYLOAD_TOO_LARGE');
  }

  return {
    canonicalPayload,
    fingerprint: await sha256Base64Url(canonicalBytes),
    byteLength: canonicalBytes.byteLength,
  };
};

const getEnv = (): GuardEnv | null => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')?.replace(/\/+$/, '');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return null;
  return { supabaseUrl, serviceRoleKey };
};

const getBearerToken = (request: Request): string | null => {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
};

const verifySupabaseJwt = async (
  env: GuardEnv,
  accessToken: string,
): Promise<string | null> => {
  const response = await fetch(`${env.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) return null;
  const user = asObject(await response.json().catch(() => null));
  return typeof user.id === 'string' ? user.id : null;
};

const sha256Hex = async (value: string): Promise<string> => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const firstForwardedIp = (request: Request): string => {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  return first || request.headers.get('cf-connecting-ip') || 'unknown';
};

const callRpc = async (
  env: GuardEnv,
  rpcName: string,
  body: Record<string, unknown>,
  requestId: string,
): Promise<Response> => {
  const response = await fetch(`${env.supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      apikey: env.serviceRoleKey,
      Authorization: `Bearer ${env.serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return errorEnvelope('GUARD_UNAVAILABLE', requestId, 502);
  }
  return jsonResponse(payload, 200);
};

const checkEdgeRateLimit = async (
  context: GuardContext,
  purpose: GuardPurpose,
): Promise<Response | null> => {
  const ipHash = await sha256Hex(`ip:v1:${firstForwardedIp(context.request)}`);
  const deviceId = context.request.headers.get('x-sharing-device-id')?.trim() ?? '';
  const deviceHash = deviceId ? await sha256Hex(`device:v1:${deviceId}`) : null;
  const sessionHash = await sha256Hex(`session:v1:${context.authUserId}`);
  const response = await callRpc(context.env, 'guard_check_edge_rate_limit_internal', {
    p_auth_user_id: context.authUserId,
    p_purpose: purpose,
    p_ip_hash: ipHash,
    p_device_hash: deviceHash,
    p_session_hash: sessionHash,
  }, context.requestId);
  const envelope = asObject(await response.clone().json().catch(() => null));
  if (envelope.ok === true) return null;
  return response;
};

const readJsonBody = async (
  request: Request,
  requestId: string,
): Promise<Record<string, unknown> | Response> => {
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MAX_CANONICAL_CREATE_PAYLOAD_BYTES + 1024 * 1024) {
    return errorEnvelope('CREATE_PAYLOAD_TOO_LARGE', requestId, 413);
  }
  const body = asObject(await request.json().catch(() => null));
  return Object.keys(body).length > 0 ? body : errorEnvelope('INVALID_REQUEST', requestId, 400);
};

export const servePublicGuard = (handler: GuardHandler): void => {
  Deno.serve(async (request) => {
    const requestId = crypto.randomUUID();
    if (request.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return errorEnvelope('INVALID_REQUEST', requestId, 405);
    }

    const env = getEnv();
    if (!env) {
      return errorEnvelope('GUARD_UNAVAILABLE', requestId, 503);
    }

    const body = await readJsonBody(request, requestId);
    if (body instanceof Response) return body;
    const headerVersion = Number(request.headers.get('x-sharing-contract-version'));
    const bodyVersion = Number(body.contract_version);
    if (
      headerVersion !== SHARING_CONTRACT_VERSION ||
      bodyVersion !== SHARING_CONTRACT_VERSION
    ) {
      return errorEnvelope('CONTRACT_VERSION_MISMATCH', requestId, 426);
    }

    const accessToken = getBearerToken(request);
    if (!accessToken) {
      return errorEnvelope('AUTH_REQUIRED', requestId, 401);
    }

    const authUserId = await verifySupabaseJwt(env, accessToken);
    if (!authUserId) {
      return errorEnvelope('AUTH_REQUIRED', requestId, 401);
    }

    return handler({ authUserId, requestId, request, env }, body);
  });
};

export const guardCreateRoom = async (
  context: GuardContext,
  body: Record<string, unknown>,
): Promise<Response> => {
  const rawPayload = typeof body.canonical_payload === 'string' ? body.canonical_payload : '';
  const roomId = typeof body.room_id === 'string' ? body.room_id : '';
  const itemCount = typeof body.item_count === 'number' ? body.item_count : NaN;
  const clientFingerprint =
    typeof body.plaintext_fingerprint === 'string' ? body.plaintext_fingerprint : '';
  let canonicalized: Awaited<ReturnType<typeof canonicalizeCreatePayloadForGuard>>;

  try {
    canonicalized = await canonicalizeCreatePayloadForGuard(rawPayload, roomId, itemCount);
  } catch (error) {
    if (error instanceof GuardCanonicalPayloadError) {
      return errorEnvelope(
        error.code,
        context.requestId,
        error.code === 'CREATE_PAYLOAD_TOO_LARGE' ? 413 : 400,
      );
    }
    return errorEnvelope('INVALID_REQUEST', context.requestId, 400);
  }

  if (clientFingerprint !== canonicalized.fingerprint) {
    return errorEnvelope('CHALLENGE_INVALID', context.requestId, 400);
  }

  const rateLimit = await checkEdgeRateLimit(context, 'create_room');
  if (rateLimit) return rateLimit;
  return callRpc(context.env, 'guard_prepare_create_room_internal', {
    p_auth_user_id: context.authUserId,
    p_client_room_id: roomId,
    p_canonical_payload: canonicalized.canonicalPayload,
    p_plaintext_fingerprint: canonicalized.fingerprint,
    p_item_count: itemCount,
    p_canonical_schema_version: body.canonical_schema_version,
    p_payload_protection_mode: body.payload_protection_mode ?? 'encrypted',
  }, context.requestId);
};

export const guardPrepareJoin = async (
  context: GuardContext,
  body: Record<string, unknown>,
): Promise<Response> => {
  const rateLimit = await checkEdgeRateLimit(context, 'join');
  if (rateLimit) return rateLimit;
  return callRpc(context.env, 'guard_prepare_join_internal', {
    p_auth_user_id: context.authUserId,
    p_room_code: body.room_code,
  }, context.requestId);
};

export const guardPrepareRestore = async (
  context: GuardContext,
  body: Record<string, unknown>,
): Promise<Response> => {
  const rateLimit = await checkEdgeRateLimit(context, 'restore');
  if (rateLimit) return rateLimit;
  return callRpc(context.env, 'guard_prepare_restore_internal', {
    p_auth_user_id: context.authUserId,
    p_room_id: body.room_id,
  }, context.requestId);
};

export { successEnvelope };
