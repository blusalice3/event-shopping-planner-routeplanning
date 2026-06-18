/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPublicGuardHeaders,
  buildPublicGuardEndpoint,
  getOrCreatePublicGuardDeviceId,
  normalizePublicGuardEnvelope,
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
        contract_version: 1,
      },
    });
  });

  it('normalizes malformed Guard responses as unavailable', () => {
    expect(normalizePublicGuardEnvelope(null)).toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 1,
      },
    });
  });

  it('reuses a stable public Guard device id for device-scoped rate limits', () => {
    localStorage.setItem('sharing.publicGuardDeviceId.v1', 'device-id-for-test-01');

    expect(getOrCreatePublicGuardDeviceId()).toBe('device-id-for-test-01');
    expect(buildPublicGuardHeaders('access-token')).toEqual({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
      'X-Sharing-Contract-Version': '1',
      'X-Sharing-Device-Id': 'device-id-for-test-01',
    });
  });
});
