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

const buildSnapshotItem = (overrides: Record<string, unknown> = {}) => ({
  localItemId: 'item-1',
  circle: 'Circle',
  block: 'A',
  number: '01',
  title: 'Book',
  eventDate: '2026-08-15',
  priorityLevel: null,
  protectionLevel: null,
  source: 'app',
  manualHallId: null,
  purchaseStatus: 'None',
  price: null,
  quantity: 1,
  limitQuantity: null,
  actualPurchaseQuantity: null,
  remarks: '',
  url: null,
  assignedTo: null,
  securedBy: null,
  orderIndex: 0,
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
  ...overrides,
});

describe('sharing route RPC wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSharingAvailabilityMock.mockReturnValue({
      enabled: true,
      mode: 'local_or_limited',
    });
  });

  it('accepts room version responses with authoritative route version maps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 4,
          routeOrderVersion: 2,
          routeOrderVersions: {
            '2026-08-15': 2,
          },
          expiresAt: '2026-08-01T00:00:00.000Z',
          isActive: true,
        },
      },
    });

    const { getRoomVersions } = await import('./client');
    const result = await getRoomVersions('room-1');

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.routeOrderVersions).toEqual({ '2026-08-15': 2 });
  });

  it('rejects malformed route version maps in room version responses', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 4,
          routeOrderVersion: 2,
          routeOrderVersions: {
            '2026-08-15': '2',
          },
          expiresAt: '2026-08-01T00:00:00.000Z',
          isActive: true,
        },
      },
    });

    const { getRoomVersions } = await import('./client');
    await expect(getRoomVersions('room-1')).resolves.toEqual(refreshRequired);
  });

  it('rejects malformed room version timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 4,
          routeOrderVersion: 2,
          routeOrderVersions: {
            '2026-08-15': 2,
          },
          roomEventDataUpdatedAt: 'not-a-date',
          expiresAt: '2026-08-01T00:00:00.000Z',
          isActive: true,
        },
      },
    });

    const { getRoomVersions } = await import('./client');
    await expect(getRoomVersions('room-1')).resolves.toEqual(refreshRequired);
  });

  it('rejects malformed route item ids in date route responses', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          eventDate: '2026-08-15',
          itemIds: ['item-1', 'item-1'],
          dateRouteOrderVersion: 3,
          routeOrderVersion: 5,
        },
      },
    });

    const { getRouteOrderByDate } = await import('./client');
    await expect(getRouteOrderByDate('room-1', '2026-08-15')).resolves.toEqual(refreshRequired);
  });

  it('requires update route responses to include the full route version baseline', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          eventDate: '2026-08-15',
          itemIds: ['item-1', 'item-2'],
          dateRouteOrderVersion: 3,
          routeOrderVersion: 5,
          notificationId: 'notification-1',
        },
      },
    });

    const { updateRouteOrder } = await import('./client');
    await expect(
      updateRouteOrder({
        roomId: 'room-1',
        eventDate: '2026-08-15',
        itemIds: ['item-1', 'item-2'],
        expectedVersion: 2,
      }),
    ).resolves.toEqual(refreshRequired);
  });

  it('rejects route-aware item mutation responses with inconsistent route versions', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['title'],
          updatedValues: { title: 'Book' },
          fieldUpdatedAt: { title: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            title: {
              itemsVersion: 5,
              updatedAt: '2026-08-01T00:00:05.000Z',
            },
          },
          notificationId: null,
          item: buildSnapshotItem(),
          routeOrderVersion: 3,
          routeOrderVersions: {
            '2026-08-15': 2,
          },
          changedRouteOrders: [
            {
              eventDate: '2026-08-15',
              itemIds: ['item-1'],
              dateRouteOrderVersion: 3,
            },
          ],
          itemNotificationId: null,
          routeNotificationId: null,
        },
      },
    });

    const { upsertRoomItemWithRoute } = await import('./client');
    await expect(
      upsertRoomItemWithRoute({
        roomId: 'room-1',
        localItemId: 'item-1',
        fields: { title: 'Book' },
        routeUpdates: [],
        expectedFieldClocks: {
          title: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
      }),
    ).resolves.toEqual(refreshRequired);
  });
});
