import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSharingAvailabilityMock } = vi.hoisted(() => ({
  getSharingAvailabilityMock: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  getSharingAvailability: getSharingAvailabilityMock,
  supabase: null,
}));

vi.mock('./publicGuardClient', () => ({
  prepareCreateRoomViaPublicGuard: vi.fn(),
  prepareJoinViaPublicGuard: vi.fn(),
  prepareRestoreViaPublicGuard: vi.fn(),
}));

describe('sharing public Guard fallback boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSharingAvailabilityMock.mockReturnValue({
      enabled: false,
      reason: 'PUBLIC_GUARD_UNCONFIGURED',
    });
  });

  it('does not fall back to direct DB bootstrap when public Guard is required but unconfigured', async () => {
    const {
      createSharingRoom,
      prepareJoinRoom,
      prepareRestoreRoom,
    } = await import('./client');

    await expect(
      createSharingRoom({
        roomId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Host',
        rawRoomEventDataJson: '{}',
        itemCount: 0,
        memberKey: 'a'.repeat(43),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });

    await expect(prepareJoinRoom('AB12C')).resolves.toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });

    await expect(
      prepareRestoreRoom('11111111-1111-4111-8111-111111111111'),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'GUARD_UNAVAILABLE',
        contract_version: 2,
      },
    });
  });
});
