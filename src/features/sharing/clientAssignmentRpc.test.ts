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
  assignedTo: 'member-b',
  securedBy: null,
  orderIndex: null,
  postponed: false,
  deletedAt: null,
  deletedBy: null,
  itemVersion: 5,
  updatedAt: '2026-08-01T00:00:05.000Z',
  fieldClocks: {
    assignedTo: {
      itemsVersion: 5,
      updatedAt: '2026-08-01T00:00:05.000Z',
    },
  },
  ...overrides,
});

describe('sharing assignment RPC wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSharingAvailabilityMock.mockReturnValue({
      enabled: true,
      mode: 'local_or_limited',
    });
  });

  it('routes single assignment through clocked item update RPC', async () => {
    const expectedFieldClocks = {
      assignedTo: {
        itemsVersion: 4,
        updatedAt: '2026-08-01T00:00:04.000Z',
      },
    };
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo'],
          updatedValues: { assignedTo: 'member-b' },
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            assignedTo: {
              itemsVersion: 5,
              updatedAt: '2026-08-01T00:00:05.000Z',
            },
          },
          item: buildSnapshotItem(),
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    const result = await assignRoomItem({
      roomId: 'room-1',
      localItemId: 'item-1',
      assignedToMemberId: 'member-b',
      expectedFieldClocks,
    });

    expect(result.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith('update_room_item_with_purchase', {
      p_room_id: 'room-1',
      p_local_item_id: 'item-1',
      p_fields: { assignedTo: 'member-b' },
      p_status: null,
      p_actual_purchase_quantity: null,
      p_expected_field_clocks: expectedFieldClocks,
    });
    expect(rpcMock).not.toHaveBeenCalledWith('assign_item', expect.anything());
  });

  it('returns refresh-required when a mutation response lacks a valid item payload', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo'],
          updatedValues: { assignedTo: 'member-b' },
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            assignedTo: {
              itemsVersion: 5,
              updatedAt: '2026-08-01T00:00:05.000Z',
            },
          },
          item: { localItemId: 'item-1' },
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    const result = await assignRoomItem({
      roomId: 'room-1',
      localItemId: 'item-1',
      assignedToMemberId: 'member-b',
      expectedFieldClocks: {
        assignedTo: {
          itemsVersion: 4,
          updatedAt: '2026-08-01T00:00:04.000Z',
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires mutation responses to include field clocks for changed fields', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo'],
          updatedValues: { assignedTo: 'member-b' },
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          item: buildSnapshotItem(),
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    await expect(
      assignRoomItem({
        roomId: 'room-1',
        localItemId: 'item-1',
        assignedToMemberId: 'member-b',
        expectedFieldClocks: {
          assignedTo: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires mutation responses to include updated values for changed fields', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo'],
          updatedValues: {},
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            assignedTo: {
              itemsVersion: 5,
              updatedAt: '2026-08-01T00:00:05.000Z',
            },
          },
          item: buildSnapshotItem(),
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    await expect(
      assignRoomItem({
        roomId: 'room-1',
        localItemId: 'item-1',
        assignedToMemberId: 'member-b',
        expectedFieldClocks: {
          assignedTo: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires mutation response field clocks to match field update timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo'],
          updatedValues: { assignedTo: 'member-b' },
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            assignedTo: {
              itemsVersion: 5,
              updatedAt: '2026-08-01T00:00:06.000Z',
            },
          },
          item: buildSnapshotItem(),
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    await expect(
      assignRoomItem({
        roomId: 'room-1',
        localItemId: 'item-1',
        assignedToMemberId: 'member-b',
        expectedFieldClocks: {
          assignedTo: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('rejects mutation responses with duplicate changed fields', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo', 'assignedTo'],
          updatedValues: { assignedTo: 'member-b' },
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            assignedTo: {
              itemsVersion: 5,
              updatedAt: '2026-08-01T00:00:05.000Z',
            },
          },
          item: buildSnapshotItem(),
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    await expect(
      assignRoomItem({
        roomId: 'room-1',
        localItemId: 'item-1',
        assignedToMemberId: 'member-b',
        expectedFieldClocks: {
          assignedTo: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires mutation response field clocks to match the mutation items version', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 5,
          changedFields: ['assignedTo'],
          updatedValues: { assignedTo: 'member-b' },
          fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:05.000Z' },
          fieldClocks: {
            assignedTo: {
              itemsVersion: 6,
              updatedAt: '2026-08-01T00:00:05.000Z',
            },
          },
          item: buildSnapshotItem(),
        },
      },
    });

    const { assignRoomItem } = await import('./client');
    await expect(
      assignRoomItem({
        roomId: 'room-1',
        localItemId: 'item-1',
        assignedToMemberId: 'member-b',
        expectedFieldClocks: {
          assignedTo: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('routes bulk assignment through clocked bulk item update RPC', async () => {
    const firstClock = {
      assignedTo: {
        itemsVersion: 4,
        updatedAt: '2026-08-01T00:00:04.000Z',
      },
    };
    const secondClock = {
      assignedTo: {
        itemsVersion: 6,
        updatedAt: '2026-08-01T00:00:06.000Z',
      },
    };
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          itemsVersion: 7,
          changedItems: [],
        },
      },
    });

    const { bulkAssignRoomItems } = await import('./client');
    const result = await bulkAssignRoomItems({
      roomId: 'room-1',
      assignedToMemberId: 'member-b',
      assignments: [
        { localItemId: 'item-1', expectedFieldClocks: firstClock },
        { localItemId: 'item-2', expectedFieldClocks: secondClock },
      ],
    });

    expect(result).toEqual({
      ok: true,
      contract_version: 2,
      data: {
        roomId: 'room-1',
        itemsVersion: 7,
        assignedToMemberId: 'member-b',
        changedItems: [],
      },
    });
    expect(rpcMock).toHaveBeenCalledWith('bulk_update_room_items_with_purchase', {
      p_room_id: 'room-1',
      p_mutations: [
        {
          localItemId: 'item-1',
          fields: { assignedTo: 'member-b' },
          status: null,
          actualPurchaseQuantity: null,
          expectedFieldClocks: firstClock,
        },
        {
          localItemId: 'item-2',
          fields: { assignedTo: 'member-b' },
          status: null,
          actualPurchaseQuantity: null,
          expectedFieldClocks: secondClock,
        },
      ],
    });
    expect(rpcMock).not.toHaveBeenCalledWith('bulk_assign_items', expect.anything());
  });

  it('accepts v2 item diffs with complete field clocks', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 2,
              updatedFields: ['title'],
              updatedValues: { title: 'New title' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:02.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 2,
                  updatedAt: '2026-08-01T00:00:02.000Z',
                },
              },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:02.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    const result = await getRoomItemChangesSince('room-1', 1);

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.changes[0].fieldClocks?.title.itemsVersion).toBe(2);
  });

  it('requires v2 item diffs to include field clocks for changed fields', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 2,
              updatedFields: ['title'],
              updatedValues: { title: 'New title' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:02.000Z' },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:02.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    const result = await getRoomItemChangesSince('room-1', 1);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires v2 item diffs to include updated values for changed fields', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 2,
              updatedFields: ['title'],
              updatedValues: {},
              fieldUpdatedAt: { title: '2026-08-01T00:00:02.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 2,
                  updatedAt: '2026-08-01T00:00:02.000Z',
                },
              },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:02.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 1)).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires v2 item diff field clocks to match field update timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 2,
              updatedFields: ['title'],
              updatedValues: { title: 'New title' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:02.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 2,
                  updatedAt: '2026-08-01T00:00:03.000Z',
                },
              },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:02.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 1)).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('rejects v2 item diffs with duplicate updated fields', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 2,
              updatedFields: ['title', 'title'],
              updatedValues: { title: 'New title' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:02.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 2,
                  updatedAt: '2026-08-01T00:00:02.000Z',
                },
              },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:02.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 1)).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('requires v2 item diff field clocks to match the change items version', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 2,
              updatedFields: ['title'],
              updatedValues: { title: 'New title' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:02.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 3,
                  updatedAt: '2026-08-01T00:00:02.000Z',
                },
              },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:02.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 1)).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });

  it('rejects v2 item diff changes outside the response version range', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          fromItemsVersion: 1,
          itemsVersion: 2,
          changes: [
            {
              changeId: 'change-1',
              localItemId: 'item-1',
              changeType: 'update',
              itemsVersion: 3,
              updatedFields: ['title'],
              updatedValues: { title: 'New title' },
              fieldUpdatedAt: { title: '2026-08-01T00:00:03.000Z' },
              fieldClocks: {
                title: {
                  itemsVersion: 3,
                  updatedAt: '2026-08-01T00:00:03.000Z',
                },
              },
              updatedByMemberId: 'member-b',
              notificationId: 'notification-1',
              createdAt: '2026-08-01T00:00:03.000Z',
            },
          ],
        },
      },
    });

    const { getRoomItemChangesSince } = await import('./client');
    await expect(getRoomItemChangesSince('room-1', 1)).resolves.toEqual({
      ok: false,
      error: {
        code: 'FULL_ITEM_REFRESH_REQUIRED',
        contract_version: 2,
      },
    });
  });
});
