import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSharingAvailabilityMock, rpcMock } = vi.hoisted(() => ({
  getSharingAvailabilityMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock('../../lib/supabase', () => ({
  getSharingAvailability: getSharingAvailabilityMock,
  supabase: {
    rpc: rpcMock,
  },
}));

const refreshRequired = {
  ok: false,
  error: {
    code: 'FULL_ITEM_REFRESH_REQUIRED',
    contract_version: 2,
  },
};

describe('sharing ack RPC wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSharingAvailabilityMock.mockReturnValue({
      enabled: true,
      mode: 'local_or_limited',
    });
  });

  it('accepts valid item sync ack responses', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          roomMemberId: 'member-1',
          itemsVersion: 4,
          lastProcessedEventCreatedAt: null,
          lastProcessedEventId: null,
        },
      },
    });

    const { ackRoomSyncProgress } = await import('./client');
    const result = await ackRoomSyncProgress('room-1', 4, null, null);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.itemsVersion).toBe(4);
  });

  it('rejects success envelopes with a mismatched contract version', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 999,
        data: {
          roomId: 'room-1',
          roomMemberId: 'member-1',
          itemsVersion: 4,
          lastProcessedEventCreatedAt: null,
          lastProcessedEventId: null,
        },
      },
    });

    const { ackRoomSyncProgress } = await import('./client');
    await expect(ackRoomSyncProgress('room-1', 4, null, null)).resolves.toEqual({
      ok: false,
      error: {
        code: 'CONTRACT_VERSION_MISMATCH',
        contract_version: 2,
      },
    });
  });

  it('rejects malformed item sync ack versions', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          roomMemberId: 'member-1',
          itemsVersion: -1,
          lastProcessedEventCreatedAt: null,
          lastProcessedEventId: null,
        },
      },
    });

    const { ackRoomSyncProgress } = await import('./client');
    await expect(ackRoomSyncProgress('room-1', 4, null, null)).resolves.toEqual(
      refreshRequired,
    );
  });

  it('normalizes unknown RPC error codes as internal errors', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: false,
        error: {
          code: 'NEW_DATABASE_ERROR',
          contract_version: 2,
        },
      },
    });

    const { ackRoomSyncProgress } = await import('./client');
    await expect(ackRoomSyncProgress('room-1', 4, null, null)).resolves.toEqual({
      ok: false,
      error: {
        code: 'SHARING_INTERNAL_ERROR',
        contract_version: 2,
      },
    });
  });

  it('rejects error envelopes with a mismatched contract version', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: false,
        error: {
          code: 'INVALID_REQUEST',
          contract_version: 999,
        },
      },
    });

    const { ackRoomSyncProgress } = await import('./client');
    await expect(ackRoomSyncProgress('room-1', 4, null, null)).resolves.toEqual({
      ok: false,
      error: {
        code: 'CONTRACT_VERSION_MISMATCH',
        contract_version: 2,
      },
    });
  });

  it('requires create item diffs to include field clock baselines', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 4,
          itemsVersion: 5,
          changes: [
            {
              changeId: 'change-create',
              localItemId: 'item-created',
              changeType: 'create',
              itemsVersion: 5,
              updatedFields: ['title'],
              updatedValues: { title: 'New book' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:05.000Z' },
              item: {
                localItemId: 'item-created',
                circle: 'Circle',
                block: 'A',
                number: '01',
                title: 'New book',
                eventDate: null,
                priorityLevel: null,
                protectionLevel: null,
                source: 'app',
                manualHallId: null,
                purchaseStatus: 'None',
                price: null,
                quantity: 1,
                limitQuantity: null,
                actualPurchaseQuantity: null,
                remarks: null,
                url: null,
                assignedTo: null,
                securedBy: null,
                orderIndex: null,
                postponed: false,
                deletedAt: null,
                deletedBy: null,
                itemVersion: 5,
                updatedAt: '2026-08-01T00:00:05.000Z',
                fieldClocks: {
                  title: {
                    itemsVersion: 5,
                    updatedAt: '2026-08-01T00:00:05.000Z',
                  },
                },
              },
              updatedByMemberId: 'member-host',
              notificationId: 'notification-create',
              createdAt: '2026-08-01T00:00:05.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 4)).resolves.toEqual(refreshRequired);
  });

  it('requires item diffs to include a valid creation timestamp', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 4,
          itemsVersion: 5,
          changes: [
            {
              changeId: 'change-update',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 5,
              updatedFields: ['title'],
              updatedValues: { title: 'Updated book' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:05.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 5,
                  updatedAt: '2026-08-01T00:00:05.000Z',
                },
              },
              updatedByMemberId: 'member-host',
              notificationId: 'notification-update',
              createdAt: '',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 4)).resolves.toEqual(refreshRequired);
  });

  it('rejects malformed route ack baselines', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          roomMemberId: 'member-1',
          routeOrderVersions: {
            '2026-08-15': '2',
          },
        },
      },
    });

    const { ackRoomRouteOrderVersions } = await import('./client');
    await expect(
      ackRoomRouteOrderVersions('room-1', { '2026-08-15': 2 }),
    ).resolves.toEqual(refreshRequired);
  });

  it('requires snapshot ack responses to include route version baselines', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          roomMemberId: 'member-1',
          snapshotReceiptId: 'receipt-1',
          itemsVersion: 4,
        },
      },
    });

    const { ackRoomSnapshot } = await import('./client');
    await expect(ackRoomSnapshot('room-1', 'receipt-1')).resolves.toEqual(refreshRequired);
  });
});
