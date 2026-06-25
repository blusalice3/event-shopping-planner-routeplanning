/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPublicGuardHeaders,
  buildPublicGuardEndpoint,
  getOrCreatePublicGuardDeviceId,
  normalizePublicGuardCreateRoomChallengeEnvelope,
  normalizePublicGuardEnvelope,
  normalizePublicGuardPreparedMemberTokenEnvelope,
} from './publicGuardClient';

describe('publicGuardClient', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('builds function endpoints from the shared Guard base URL', () => {
    expect(
      buildPublicGuardEndpoint(
        'http://127.0.0.1:54321/functions/v1/',
        'guard-create-room',
      ),
    ).toBe('http://127.0.0.1:54321/functions/v1/guard-create-room');
  });

  it('rejects success envelopes with a mismatched contract version', () => {
    expect(
      normalizePublicGuardEnvelope({
        ok: true,
        data: { challengeId: 'challenge-1' },
        contract_version: 999,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'CONTRACT_VERSION_MISMATCH',
        contract_version: 2,
      },
    });
  });

  it('normalizes malformed Guard responses as unavailable', () => {
    expect(normalizePublicGuardEnvelope(null)).toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });
  });

  it('normalizes unknown Guard error codes as unavailable', () => {
    expect(
      normalizePublicGuardEnvelope({
        ok: false,
        error: {
          code: 'NEW_EDGE_ERROR',
          contract_version: 2,
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });
  });

  it('rejects Guard error envelopes with a mismatched contract version', () => {
    expect(
      normalizePublicGuardEnvelope({
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          contract_version: 999,
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'CONTRACT_VERSION_MISMATCH',
        contract_version: 2,
      },
    });
  });

  it('rejects malformed create-room Guard success payloads', () => {
    expect(
      normalizePublicGuardCreateRoomChallengeEnvelope({
        ok: true,
        contract_version: 2,
        data: {
          challengeId: 'challenge-1',
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });
  });

  it('rejects malformed join/restore Guard success payloads', () => {
    expect(
      normalizePublicGuardPreparedMemberTokenEnvelope({
        ok: true,
        contract_version: 2,
        data: {
          challengeId: 'challenge-1',
          roomId: 'room-1',
          tokenContext: 'join:v1:room-1',
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });
  });

  it('rejects join/restore Guard success payloads with malformed expiry timestamps', () => {
    expect(
      normalizePublicGuardPreparedMemberTokenEnvelope({
        ok: true,
        contract_version: 2,
        data: {
          challengeId: 'challenge-1',
          roomId: 'room-1',
          tokenContext: 'join:v1:room-1',
          expiresAt: '',
        },
      }),
    ).toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });
  });

  it('reuses a stable public Guard device id for device-scoped rate limits', () => {
    localStorage.setItem('sharing.publicGuardDeviceId.v1', 'device-id-for-test-01');

    expect(getOrCreatePublicGuardDeviceId()).toBe('device-id-for-test-01');
    expect(buildPublicGuardHeaders('access-token')).toEqual({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'X-Sharing-Contract-Version': '2',
      'X-Sharing-Device-Id': 'device-id-for-test-01',
    });
  });
});
