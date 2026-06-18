import { getSharingPublicGuardBaseUrl, supabase } from '../../lib/supabase';
import {
  SHARING_CONTRACT_VERSION,
  type SharingEnvelope,
  type SharingErrorEnvelope,
  type SharingSuccessEnvelope,
} from './contracts';

type GuardEndpoint = 'guard-create-room' | 'guard-prepare-join' | 'guard-prepare-restore';

const PUBLIC_GUARD_DEVICE_ID_STORAGE_KEY = 'sharing.publicGuardDeviceId.v1';
const PUBLIC_GUARD_DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type PublicGuardCreateRoomInput = {
  roomId: string;
  canonicalPayload: string;
  plaintextFingerprint: string;
  itemCount: number;
  canonicalSchemaVersion: number;
  payloadProtectionMode: 'encrypted';
};

export type PublicGuardCreateRoomChallenge = {
  challengeId: string;
  roomId: string;
};

export type PublicGuardPreparedMemberToken = {
  challengeId: string;
  roomId: string;
  tokenContext: string;
  expiresAt: string;
};

const stableGuardError = (
  code: SharingErrorEnvelope['error']['code'],
  retryAfterSeconds?: number,
): SharingErrorEnvelope => {
  const error: SharingErrorEnvelope['error'] = {
    code,
    contract_version: SHARING_CONTRACT_VERSION,
  };
  if (typeof retryAfterSeconds === 'number') {
    error.retry_after_seconds = retryAfterSeconds;
  }
  return { ok: false, error };
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const randomBase64Url = (length: number): string => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const createPublicGuardDeviceId = (): string => {
  if (typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return randomBase64Url(32);
};

export const getOrCreatePublicGuardDeviceId = (): string => {
  try {
    const stored = localStorage.getItem(PUBLIC_GUARD_DEVICE_ID_STORAGE_KEY);
    if (stored && PUBLIC_GUARD_DEVICE_ID_PATTERN.test(stored)) {
      return stored;
    }

    const generated = createPublicGuardDeviceId();
    localStorage.setItem(PUBLIC_GUARD_DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return createPublicGuardDeviceId();
  }
};

export const buildPublicGuardHeaders = (accessToken: string): HeadersInit => ({
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
  'X-Sharing-Contract-Version': String(SHARING_CONTRACT_VERSION),
  'X-Sharing-Device-Id': getOrCreatePublicGuardDeviceId(),
});

export const buildPublicGuardEndpoint = (
  baseUrl: string,
  endpoint: GuardEndpoint,
): string => `${baseUrl.replace(/\/+$/, '')}/${endpoint}`;

export const normalizePublicGuardEnvelope = <T>(
  value: unknown,
): SharingEnvelope<T> => {
  const envelope = asObject(value);
  if (envelope.ok === true) {
    const contractVersion =
      typeof envelope.contract_version === 'number'
        ? envelope.contract_version
        : SHARING_CONTRACT_VERSION;
    if (contractVersion !== SHARING_CONTRACT_VERSION) {
      return stableGuardError('CONTRACT_VERSION_MISMATCH');
    }
    return {
      ok: true,
      data: envelope.data as T,
      contract_version: contractVersion,
    } satisfies SharingSuccessEnvelope<T>;
  }

  const errorObject = asObject(envelope.error);
  const contractVersion =
    typeof errorObject.contract_version === 'number'
      ? errorObject.contract_version
      : SHARING_CONTRACT_VERSION;
  const error: SharingErrorEnvelope['error'] = {
    code:
      typeof errorObject.code === 'string'
        ? (errorObject.code as SharingErrorEnvelope['error']['code'])
        : 'GUARD_UNAVAILABLE',
    contract_version: contractVersion,
  };
  if (typeof errorObject.retry_after_seconds === 'number') {
    error.retry_after_seconds = errorObject.retry_after_seconds;
  }
  if (typeof errorObject.request_id === 'string') {
    error.request_id = errorObject.request_id;
  }
  return {
    ok: false,
    error,
  };
};

const getAccessToken = async (): Promise<string | null> => {
  if (!supabase) return null;
  const session = await supabase.auth.getSession();
  return session.data.session?.access_token ?? null;
};

const callPublicGuard = async <T>(
  endpoint: GuardEndpoint,
  body: Record<string, unknown>,
): Promise<SharingEnvelope<T>> => {
  const baseUrl = getSharingPublicGuardBaseUrl();
  const accessToken = await getAccessToken();
  if (!baseUrl || !accessToken) {
    return stableGuardError('GUARD_UNAVAILABLE');
  }

  try {
    const response = await fetch(buildPublicGuardEndpoint(baseUrl, endpoint), {
      method: 'POST',
      headers: buildPublicGuardHeaders(accessToken),
      body: JSON.stringify({
        ...body,
        contract_version: SHARING_CONTRACT_VERSION,
      }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    const envelope = normalizePublicGuardEnvelope<T>(payload);
    if (!response.ok && envelope.ok) {
      return stableGuardError('GUARD_UNAVAILABLE');
    }
    return envelope;
  } catch {
    return stableGuardError('GUARD_UNAVAILABLE');
  }
};

export const prepareCreateRoomViaPublicGuard = (
  input: PublicGuardCreateRoomInput,
): Promise<SharingEnvelope<PublicGuardCreateRoomChallenge>> =>
  callPublicGuard<PublicGuardCreateRoomChallenge>('guard-create-room', {
    room_id: input.roomId,
    canonical_payload: input.canonicalPayload,
    plaintext_fingerprint: input.plaintextFingerprint,
    item_count: input.itemCount,
    canonical_schema_version: input.canonicalSchemaVersion,
    payload_protection_mode: input.payloadProtectionMode,
  });

export const prepareJoinViaPublicGuard = (
  roomCode: string,
): Promise<SharingEnvelope<PublicGuardPreparedMemberToken>> =>
  callPublicGuard<PublicGuardPreparedMemberToken>('guard-prepare-join', {
    room_code: roomCode,
  });

export const prepareRestoreViaPublicGuard = (
  roomId: string,
): Promise<SharingEnvelope<PublicGuardPreparedMemberToken>> =>
  callPublicGuard<PublicGuardPreparedMemberToken>('guard-prepare-restore', {
    room_id: roomId,
  });
