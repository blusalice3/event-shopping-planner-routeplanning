import { describe, expect, it } from 'vitest';
import {
  applyRoomItemChangesToItems,
  buildSharingSessionMetadata,
  deriveMemberRestoreToken,
  filterNotificationsAtOrBeforeWatermark,
  getRoomNotificationEvents,
  mergeSnapshotRoomItemIntoShoppingItem,
  roomSnapshotToAppData,
  summarizeNotificationCatchUpPage,
  validateRoomSnapshot,
  type RoomItemChange,
  type RoomNotification,
  type RoomNotificationsResult,
  type SnapshotRoomItem,
  type RoomSnapshot,
} from './client';
import type { ShoppingItem } from '../../types/item';

const buildValidRoomSnapshot = (): RoomSnapshot => ({
  room: {
    roomId: 'room-1',
    eventName: 'テストイベント',
    hostMemberId: 'member-host',
    itemsVersion: 1,
    routeOrderVersion: 1,
    expiresAt: '2026-08-01T00:00:00.000Z',
    sharingStatus: 'active',
  },
  currentMember: {
    roomMemberId: 'member-host',
    displayName: 'Host',
    color: null,
    role: 'host',
  },
  members: [
    {
      roomMemberId: 'member-host',
      displayName: 'Host',
      color: '#0ea5e9',
      role: 'host',
      membershipStatus: 'active',
    },
  ],
  items: [
    {
      localItemId: 'item-1',
      circle: 'Circle',
      block: 'A',
      number: '01',
      title: 'Book title',
      eventDate: '2026-08-15',
      name: 'Book title',
      priorityLevel: null,
      protectionLevel: null,
      source: 'spreadsheet',
      manualHallId: null,
      purchaseStatus: 'None',
      price: 1200,
      quantity: 2,
      limitQuantity: null,
      actualPurchaseQuantity: null,
      remarks: 'memo',
      url: null,
      assignedTo: 'member-host',
      securedBy: null,
      orderIndex: null,
      postponed: false,
      deletedAt: null,
      deletedBy: null,
      itemVersion: 1,
      updatedAt: '2026-08-01T00:00:01.000Z',
      fieldClocks: {
        title: {
          itemsVersion: 1,
          updatedAt: '2026-08-01T00:00:01.000Z',
        },
      },
    },
  ],
  eventData: {
    schemaVersion: 1,
    eventMetadata: { eventName: 'テストイベント' },
    executeModeItems: {},
    memberRouteItems: {},
    memberProfilesSnapshot: [],
    dayModes: {},
    mapData: {},
    mapRotationSettings: {},
    routeSettings: {},
    hallDefinitions: {},
    hallRouteSettings: {},
    mapViewportSettings: {},
    routeOrderByDate: {},
    itemSnapshots: {
      'item-1': {
        title: 'Legacy fallback title',
      },
    },
  },
  snapshot: {
    receiptId: 'receipt-1',
    itemsVersion: 1,
    routeOrderVersion: 1,
    routeOrderVersions: { '2026-08-15': 1 },
    deletedItemClocks: {},
    notificationWatermarkCreatedAt: null,
    notificationWatermarkId: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
});

describe('sharing MVP-0c client helpers', () => {
  it('derives member_restore_token with the fixed MVP formula', async () => {
    await expect(
      deriveMemberRestoreToken(
        'restore:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'a'.repeat(43),
      ),
    ).resolves.toBe('nq8ngyOuBkv01Lay1JeJTao6wwSebmEf5fDAJj0hzso');
  });

  it('converts a room snapshot into local app data with MVP-2c route sync metadata', () => {
    const snapshot: RoomSnapshot = {
      room: {
        roomId: 'room-1',
        eventName: 'テストイベント',
        hostMemberId: 'member-host',
        itemsVersion: 0,
        routeOrderVersion: 0,
        expiresAt: '2026-08-01T00:00:00.000Z',
        sharingStatus: 'active',
      },
      currentMember: {
        roomMemberId: 'member-host',
        displayName: 'Host',
        color: null,
        role: 'host',
      },
      members: [
        {
          roomMemberId: 'member-host',
          displayName: 'Host',
          color: '#0ea5e9',
          role: 'host',
          membershipStatus: 'active',
        },
      ],
      items: [
        {
          localItemId: 'item-1',
          circle: 'Circle',
          block: 'A',
          number: '01',
          title: 'Book title',
          eventDate: '2026-08-15',
          name: 'Book',
          priorityLevel: null,
          protectionLevel: null,
          source: 'spreadsheet',
          manualHallId: null,
          purchaseStatus: 'None',
          price: 1200,
          quantity: 2,
          limitQuantity: null,
          actualPurchaseQuantity: null,
          remarks: 'memo',
          url: null,
          assignedTo: 'member-host',
          securedBy: null,
          orderIndex: null,
          postponed: false,
          deletedAt: null,
          deletedBy: null,
          itemVersion: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
          fieldClocks: {
            title: {
              itemsVersion: 0,
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          },
        },
      ],
      eventData: {
        schemaVersion: 1,
        eventMetadata: { eventName: 'テストイベント' },
        executeModeItems: {},
        memberRouteItems: {
          '2026-08-15': {
            'member-host': ['item-1'],
          },
        },
        memberProfilesSnapshot: [],
        dayModes: {},
        mapData: {},
        mapRotationSettings: {},
        routeSettings: {},
        hallDefinitions: {},
        hallRouteSettings: {},
        mapViewportSettings: {},
        routeOrderByDate: {},
        itemSnapshots: {
          'item-1': {
            circle: 'Circle',
            block: 'A',
            number: '01',
            title: 'Book title',
            source: 'spreadsheet',
          },
        },
      },
      snapshot: {
        receiptId: 'receipt-1',
        itemsVersion: 0,
        routeOrderVersion: 0,
        routeOrderVersions: {},
        deletedItemClocks: {
          'deleted-item-1': {
            deletedAt: '2026-08-01T00:00:03.000Z',
            deletedBy: 'member-host',
            fieldClocks: {
              deletedAt: {
                itemsVersion: 3,
                updatedAt: '2026-08-01T00:00:03.000Z',
              },
              deletedBy: {
                itemsVersion: 3,
                updatedAt: '2026-08-01T00:00:03.000Z',
              },
            },
            itemVersion: 3,
            updatedAt: '2026-08-01T00:00:03.000Z',
          },
        },
        notificationWatermarkCreatedAt: '2026-08-01T00:00:00.000Z',
        notificationWatermarkId: 'notification-0',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    };

    const appData = roomSnapshotToAppData(snapshot);

    expect(appData.eventLists['テストイベント']).toEqual([
      expect.objectContaining({
        id: 'item-1',
        circle: 'Circle',
        block: 'A',
        number: '01',
        title: 'Book title',
        assignedTo: 'member-host',
        securedBy: undefined,
        lastSyncedAt: '2026-08-01T00:00:00.000Z',
      }),
    ]);
    expect(appData.executeModeItems['テストイベント']).toEqual({});
    expect(appData.memberRouteItems['テストイベント']).toEqual({
      '2026-08-15': {
        'member-host': ['item-1'],
      },
    });

    expect(buildSharingSessionMetadata(snapshot)).toEqual(
      expect.objectContaining({
        itemsVersion: 0,
        lastProcessedEventCreatedAt: '2026-08-01T00:00:00.000Z',
        lastProcessedEventId: 'notification-0',
        memberProfileSnapshot: [
          {
            roomMemberId: 'member-host',
            displayName: 'Host',
            color: '#0ea5e9',
            role: 'host',
            membershipStatus: 'active',
          },
        ],
        fieldClocksByItemId: expect.objectContaining({
          'item-1': expect.objectContaining({
            title: {
              itemsVersion: 0,
              updatedAt: '2026-08-01T00:00:00.000Z',
            },
          }),
          'deleted-item-1': expect.objectContaining({
            deletedAt: {
              itemsVersion: 3,
              updatedAt: '2026-08-01T00:00:03.000Z',
            },
          }),
        }),
        deletedItemClocks: {
          'deleted-item-1': {
            deletedAt: '2026-08-01T00:00:03.000Z',
            deletedBy: 'member-host',
            fieldClocks: {
              deletedAt: {
                itemsVersion: 3,
                updatedAt: '2026-08-01T00:00:03.000Z',
              },
              deletedBy: {
                itemsVersion: 3,
                updatedAt: '2026-08-01T00:00:03.000Z',
              },
            },
            itemVersion: 3,
            updatedAt: '2026-08-01T00:00:03.000Z',
          },
        },
      }),
    );
  });

  it('rebuilds execute route order from canonical snapshot items instead of stale eventData mirrors', () => {
    const snapshot = buildValidRoomSnapshot();
    const routedItem = { ...snapshot.items[0], orderIndex: 1 };
    const firstItem: SnapshotRoomItem = {
      ...routedItem,
      localItemId: 'item-0',
      title: 'First',
      orderIndex: 0,
      fieldClocks: {
        title: {
          itemsVersion: 1,
          updatedAt: '2026-08-01T00:00:01.000Z',
        },
      },
    };
    const nextDateItem: SnapshotRoomItem = {
      ...routedItem,
      localItemId: 'item-2',
      title: 'Next date',
      eventDate: '2026-08-16',
      orderIndex: 0,
      fieldClocks: {
        title: {
          itemsVersion: 1,
          updatedAt: '2026-08-01T00:00:01.000Z',
        },
      },
    };
    const nonRouteItem: SnapshotRoomItem = {
      ...routedItem,
      localItemId: 'item-free',
      title: 'Not routed',
      orderIndex: null,
    };

    const appData = roomSnapshotToAppData({
      ...snapshot,
      items: [routedItem, firstItem, nextDateItem, nonRouteItem],
      eventData: {
        ...snapshot.eventData,
        routeOrderByDate: {
          '2026-08-15': ['stale-item', 'item-1'],
          '2026-08-17': ['stale-other-date'],
        },
      },
    });

    expect(appData.executeModeItems['テストイベント']).toEqual({
      '2026-08-15': ['item-0', 'item-1'],
      '2026-08-16': ['item-2'],
    });
  });

  it('rejects malformed v2 full snapshots instead of filling required item fields from legacy snapshots', () => {
    const snapshot = buildValidRoomSnapshot();
    expect(validateRoomSnapshot(snapshot)).toBe(true);

    expect(
      validateRoomSnapshot({
        ...snapshot,
        room: { ...snapshot.room, expiresAt: '' },
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], title: undefined }],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], fieldClocks: undefined }],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], updatedAt: '' }],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], deletedAt: 'not-a-date' }],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], purchaseStatus: 'None', postponed: true }],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [{ ...snapshot.items[0], purchaseStatus: 'Postpone', postponed: false }],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [
          {
            ...snapshot.items[0],
            fieldClocks: {
              title: {
                itemsVersion: 1,
                updatedAt: '',
              },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        items: [
          {
            ...snapshot.items[0],
            fieldClocks: {
              title: {
                itemsVersion: 2,
                updatedAt: '2026-08-01T00:00:02.000Z',
              },
              remarks: {
                itemsVersion: 3,
                updatedAt: '2026-08-01T00:00:01.000Z',
              },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          createdAt: 'not-a-date',
        },
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          notificationWatermarkCreatedAt: '',
          notificationWatermarkId: 'notification-0',
        },
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          deletedItemClocks: {
            'deleted-item': {
              deletedAt: '2026-08-01T00:00:02.000Z',
              deletedBy: null,
              fieldClocks: {},
              itemVersion: 2,
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      validateRoomSnapshot({
        ...snapshot,
        snapshot: {
          ...snapshot.snapshot,
          deletedItemClocks: {
            'deleted-item': {
              deletedAt: '2026-08-01T00:00:02.000Z',
              deletedBy: null,
              fieldClocks: {
                deletedAt: {
                  itemsVersion: 2,
                  updatedAt: '2026-08-01T00:00:02.000Z',
                },
              },
              itemVersion: 2,
              updatedAt: '',
            },
          },
        },
      }),
    ).toBe(false);
  });

  it('applies MVP-1 item catch-up changes field-by-field without overwriting other fields', () => {
    const items: ShoppingItem[] = [
      {
        id: 'item-1',
        circle: 'Circle',
        eventDate: '2026-08-15',
        block: 'A',
        number: '01',
        title: 'Book',
        price: 1000,
        purchaseStatus: 'None',
        quantity: 1,
        remarks: 'local memo',
        url: 'https://example.test/old',
      },
    ];
    const changes: RoomItemChange[] = [
      {
        changeId: 'change-1',
        localItemId: 'item-1',
        itemsVersion: 1,
        updatedFields: ['price'],
        updatedValues: { price: 1500 },
        fieldUpdatedAt: { price: '2026-08-01T00:00:01.000Z' },
        updatedByMemberId: 'member-a',
        notificationId: 'notification-1',
        createdAt: '2026-08-01T00:00:01.000Z',
      },
      {
        changeId: 'change-2',
        localItemId: 'item-1',
        itemsVersion: 2,
        updatedFields: ['securedBy', 'purchaseStatus'],
        updatedValues: {
          securedBy: 'member-b',
          purchaseStatus: 'Purchased',
        },
        fieldUpdatedAt: {
          securedBy: '2026-08-01T00:00:02.000Z',
          purchaseStatus: '2026-08-01T00:00:02.000Z',
        },
        updatedByMemberId: 'member-b',
        notificationId: 'notification-2',
        createdAt: '2026-08-01T00:00:02.000Z',
      },
      {
        changeId: 'change-3',
        localItemId: 'item-1',
        itemsVersion: 3,
        updatedFields: ['actualPurchaseQuantity'],
        updatedValues: { actualPurchaseQuantity: 2 },
        fieldUpdatedAt: {
          actualPurchaseQuantity: '2026-08-01T00:00:03.000Z',
        },
        updatedByMemberId: 'member-b',
        notificationId: 'notification-3',
        createdAt: '2026-08-01T00:00:03.000Z',
      },
    ];

    const patched = applyRoomItemChangesToItems(items, changes);

    expect(patched[0]).toEqual(
      expect.objectContaining({
        price: 1500,
        remarks: 'local memo',
        url: 'https://example.test/old',
        securedBy: 'member-b',
        purchaseStatus: 'Purchased',
        limitedPurchasedQuantity: 2,
        lastSyncedAt: '2026-08-01T00:00:03.000Z',
      }),
    );
  });

  it('derives postponed from purchaseStatus, accepts legacy name, and ignores orderIndex field diffs', () => {
    const items: ShoppingItem[] = [
      {
        id: 'item-1',
        circle: 'Circle',
        eventDate: '2026-08-15',
        block: 'A',
        number: '01',
        title: 'Book',
        price: 1000,
        purchaseStatus: 'None',
        quantity: 1,
        remarks: '',
        orderIndex: 4,
        postponed: false,
      },
    ];
    const changes: RoomItemChange[] = [
      {
        changeId: 'change-postpone',
        localItemId: 'item-1',
        itemsVersion: 1,
        updatedFields: ['purchaseStatus', 'postponed', 'orderIndex', 'name'],
        updatedValues: {
          purchaseStatus: 'Postpone',
          postponed: false,
          orderIndex: 0,
          name: 'Legacy title',
        },
        fieldUpdatedAt: {
          purchaseStatus: '2026-08-01T00:00:01.000Z',
          name: '2026-08-01T00:00:01.000Z',
        },
        updatedByMemberId: 'member-a',
        notificationId: 'notification-postpone',
        createdAt: '2026-08-01T00:00:01.000Z',
      },
      {
        changeId: 'change-unpostpone',
        localItemId: 'item-1',
        itemsVersion: 2,
        updatedFields: ['purchaseStatus'],
        updatedValues: {
          purchaseStatus: 'None',
        },
        fieldUpdatedAt: {
          purchaseStatus: '2026-08-01T00:00:02.000Z',
        },
        updatedByMemberId: 'member-a',
        notificationId: 'notification-unpostpone',
        createdAt: '2026-08-01T00:00:02.000Z',
      },
    ];

    expect(applyRoomItemChangesToItems(items, changes)).toEqual([
      expect.objectContaining({
        title: 'Legacy title',
        purchaseStatus: 'None',
        postponed: false,
        orderIndex: 4,
      }),
    ]);
    expect(applyRoomItemChangesToItems(items, changes.slice(0, 1))).toEqual([
      expect.objectContaining({
        title: 'Legacy title',
        purchaseStatus: 'Postpone',
        postponed: true,
        orderIndex: 4,
      }),
    ]);
  });

  it('keeps limitQuantity as payload metadata while mapping actualPurchaseQuantity to limitedPurchasedQuantity', () => {
    const item: ShoppingItem = {
      id: 'item-1',
      circle: 'Circle',
      eventDate: '2026-08-15',
      block: 'A',
      number: '01',
      title: 'Book',
      price: 1000,
      purchaseStatus: 'None',
      quantity: 3,
      remarks: '',
    };
    const snapshot: SnapshotRoomItem = {
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
      purchaseStatus: 'LimitedPurchase',
      price: 1000,
      quantity: 3,
      limitQuantity: 2,
      actualPurchaseQuantity: 1,
      remarks: '',
      url: null,
      assignedTo: null,
      securedBy: 'member-a',
      orderIndex: null,
      postponed: false,
      deletedAt: null,
      deletedBy: null,
      itemVersion: 4,
      updatedAt: '2026-08-01T00:00:04.000Z',
      fieldClocks: {
        actualPurchaseQuantity: {
          itemsVersion: 4,
          updatedAt: '2026-08-01T00:00:04.000Z',
        },
        limitQuantity: {
          itemsVersion: 4,
          updatedAt: '2026-08-01T00:00:04.000Z',
        },
      },
    };

    const merged = mergeSnapshotRoomItemIntoShoppingItem(item, snapshot);

    expect(merged).toEqual(
      expect.objectContaining({
        purchaseStatus: 'LimitedPurchase',
        quantity: 3,
        limitedPurchasedQuantity: 1,
      }),
    );
    expect(merged).not.toHaveProperty('limitQuantity');
  });

  it('applies MVP-2a assignment catch-up changes to assignedTo only', () => {
    const items: ShoppingItem[] = [
      {
        id: 'item-1',
        circle: 'Circle',
        eventDate: '2026-08-15',
        block: 'A',
        number: '01',
        title: 'Book',
        price: 1000,
        purchaseStatus: 'None',
        quantity: 1,
        remarks: 'local memo',
        assignedTo: 'member-host',
      },
    ];
    const changes: RoomItemChange[] = [
      {
        changeId: 'change-assign',
        localItemId: 'item-1',
        itemsVersion: 4,
        updatedFields: ['assignedTo'],
        updatedValues: { assignedTo: 'member-guest' },
        fieldUpdatedAt: { assignedTo: '2026-08-01T00:00:04.000Z' },
        fieldClocks: {
          assignedTo: {
            itemsVersion: 4,
            updatedAt: '2026-08-01T00:00:04.000Z',
          },
        },
        updatedByMemberId: 'member-host',
        notificationId: 'notification-assign',
        createdAt: '2026-08-01T00:00:04.000Z',
      },
    ];

    const patched = applyRoomItemChangesToItems(items, changes);

    expect(patched[0]).toEqual(
      expect.objectContaining({
        assignedTo: 'member-guest',
        remarks: 'local memo',
        lastSyncedAt: '2026-08-01T00:00:04.000Z',
      }),
    );
  });

  it('applies v2 create and delete item changes', () => {
    const items: ShoppingItem[] = [
      {
        id: 'item-1',
        circle: 'Circle',
        eventDate: '2026-08-15',
        block: 'A',
        number: '01',
        title: 'Book',
        price: 1000,
        purchaseStatus: 'None',
        quantity: 1,
        remarks: '',
      },
    ];
    const changes: RoomItemChange[] = [
      {
        changeId: 'change-delete',
        localItemId: 'item-1',
        changeType: 'delete',
        itemsVersion: 5,
        updatedFields: ['deletedAt', 'deletedBy'],
        updatedValues: {
          deletedAt: '2026-08-01T00:00:05.000Z',
          deletedBy: 'member-host',
        },
        fieldUpdatedAt: {
          deletedAt: '2026-08-01T00:00:05.000Z',
          deletedBy: '2026-08-01T00:00:05.000Z',
        },
        fieldClocks: {
          deletedAt: {
            itemsVersion: 5,
            updatedAt: '2026-08-01T00:00:05.000Z',
          },
        },
        updatedByMemberId: 'member-host',
        notificationId: 'notification-delete',
        createdAt: '2026-08-01T00:00:05.000Z',
      },
      {
        changeId: 'change-create',
        localItemId: 'item-2',
        changeType: 'create',
        itemsVersion: 6,
        updatedFields: ['title'],
        updatedValues: { title: 'New book' },
        fieldUpdatedAt: { title: '2026-08-01T00:00:06.000Z' },
        fieldClocks: {
          title: {
            itemsVersion: 6,
            updatedAt: '2026-08-01T00:00:06.000Z',
          },
        },
        item: {
          localItemId: 'item-2',
          circle: 'New Circle',
          block: 'B',
          number: '02',
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
          itemVersion: 6,
          updatedAt: '2026-08-01T00:00:06.000Z',
          fieldClocks: {
            title: {
              itemsVersion: 6,
              updatedAt: '2026-08-01T00:00:06.000Z',
            },
          },
        },
        updatedByMemberId: 'member-host',
        notificationId: 'notification-create',
        createdAt: '2026-08-01T00:00:06.000Z',
      },
    ];

    expect(applyRoomItemChangesToItems(items, changes)).toEqual([
      expect.objectContaining({
        id: 'item-2',
        title: 'New book',
        eventDate: '',
      }),
    ]);
  });

  it('restores an item when a later create-style change follows a delete in the same catch-up batch', () => {
    const items: ShoppingItem[] = [
      {
        id: 'item-1',
        circle: 'Circle',
        eventDate: '2026-08-15',
        block: 'A',
        number: '01',
        title: 'Book',
        price: 1000,
        purchaseStatus: 'None',
        quantity: 1,
        remarks: '',
      },
    ];
    const restoredItem: SnapshotRoomItem = {
      localItemId: 'item-1',
      circle: 'Restored Circle',
      block: 'C',
      number: '03',
      title: 'Restored book',
      eventDate: '2026-08-16',
      priorityLevel: null,
      protectionLevel: null,
      source: 'app',
      manualHallId: null,
      purchaseStatus: 'None',
      price: 1200,
      quantity: 2,
      limitQuantity: null,
      actualPurchaseQuantity: null,
      remarks: 'restored',
      url: null,
      assignedTo: null,
      securedBy: null,
      orderIndex: null,
      postponed: false,
      deletedAt: null,
      deletedBy: null,
      itemVersion: 6,
      updatedAt: '2026-08-01T00:00:06.000Z',
      fieldClocks: {
        title: {
          itemsVersion: 6,
          updatedAt: '2026-08-01T00:00:06.000Z',
        },
      },
    };
    const changes: RoomItemChange[] = [
      {
        changeId: 'change-delete',
        localItemId: 'item-1',
        changeType: 'delete',
        itemsVersion: 5,
        updatedFields: ['deletedAt', 'deletedBy'],
        updatedValues: {
          deletedAt: '2026-08-01T00:00:05.000Z',
          deletedBy: 'member-host',
        },
        fieldUpdatedAt: {
          deletedAt: '2026-08-01T00:00:05.000Z',
          deletedBy: '2026-08-01T00:00:05.000Z',
        },
        updatedByMemberId: 'member-host',
        notificationId: 'notification-delete',
        createdAt: '2026-08-01T00:00:05.000Z',
      },
      {
        changeId: 'change-restore',
        localItemId: 'item-1',
        changeType: 'create',
        itemsVersion: 6,
        updatedFields: ['title', 'deletedAt', 'deletedBy'],
        updatedValues: {
          title: 'Restored book',
          deletedAt: null,
          deletedBy: null,
        },
        fieldUpdatedAt: {
          title: '2026-08-01T00:00:06.000Z',
          deletedAt: '2026-08-01T00:00:06.000Z',
          deletedBy: '2026-08-01T00:00:06.000Z',
        },
        fieldClocks: restoredItem.fieldClocks,
        item: restoredItem,
        updatedByMemberId: 'member-host',
        notificationId: 'notification-restore',
        createdAt: '2026-08-01T00:00:06.000Z',
      },
    ];

    expect(applyRoomItemChangesToItems(items, changes)).toEqual([
      expect.objectContaining({
        id: 'item-1',
        circle: 'Restored Circle',
        eventDate: '2026-08-16',
        title: 'Restored book',
        price: 1200,
        quantity: 2,
        remarks: 'restored',
        lastSyncedAt: '2026-08-01T00:00:06.000Z',
      }),
    ]);
  });

  it('merges a v2 RPC item payload into an existing shopping item', () => {
    const item: ShoppingItem = {
      id: 'item-1',
      circle: 'Circle',
      eventDate: '2026-08-15',
      block: 'A',
      number: '01',
      title: 'Book',
      price: 1000,
      purchaseStatus: 'None',
      quantity: 1,
      remarks: 'old',
      url: 'https://example.test/old',
      priorityLevel: 'priority',
    };
    const snapshot: SnapshotRoomItem = {
      localItemId: 'item-1',
      circle: 'Circle',
      block: 'A',
      number: '01',
      title: 'Book',
      eventDate: '2026-08-15',
      name: 'DB name',
      priorityLevel: 'priority',
      protectionLevel: null,
      source: null,
      manualHallId: null,
      purchaseStatus: 'Purchased',
      price: 1800,
      quantity: 1,
      limitQuantity: null,
      actualPurchaseQuantity: null,
      remarks: 'updated',
      url: 'https://example.test/new',
      assignedTo: 'member-a',
      securedBy: 'member-a',
      orderIndex: null,
      postponed: false,
      deletedAt: null,
      deletedBy: null,
      itemVersion: 4,
      updatedAt: '2026-08-01T00:00:04.000Z',
      fieldClocks: {
        purchaseStatus: {
          itemsVersion: 4,
          updatedAt: '2026-08-01T00:00:04.000Z',
        },
      },
    };

    expect(mergeSnapshotRoomItemIntoShoppingItem(item, snapshot)).toEqual(
      expect.objectContaining({
        circle: 'Circle',
        title: 'Book',
        priorityLevel: 'priority',
        price: 1800,
        purchaseStatus: 'Purchased',
        securedBy: 'member-a',
        remarks: 'updated',
        url: 'https://example.test/new',
        lastSyncedAt: '2026-08-01T00:00:04.000Z',
      }),
    );
  });

  it('keeps notification catch-up bounded by the first server high watermark', () => {
    const notifications: RoomNotification[] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        eventId: '21111111-1111-4111-8111-111111111111',
        idempotencyKey: 'before',
        notificationType: 'item_fields_updated',
        targetMemberId: null,
        payload: {},
        createdAt: '2026-08-01T00:00:01.000Z',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        eventId: '43333333-3333-4333-8333-333333333333',
        idempotencyKey: 'after',
        notificationType: 'item_fields_updated',
        targetMemberId: null,
        payload: {},
        createdAt: '2026-08-01T00:00:03.000Z',
      },
    ];

    expect(
      filterNotificationsAtOrBeforeWatermark(
        notifications,
        '2026-08-01T00:00:02.000Z',
        '22222222-2222-4222-8222-222222222222',
      ).map((notification) => notification.id),
    ).toEqual(['11111111-1111-4111-8111-111111111111']);
  });

  it('uses the standard events alias when reading notification catch-up pages', () => {
    const aliased: RoomNotification = {
      id: '11111111-1111-4111-8111-111111111111',
      eventId: '21111111-1111-4111-8111-111111111111',
      idempotencyKey: 'event',
      notificationType: 'item_fields_updated',
      targetMemberId: null,
      payload: {},
      createdAt: '2026-08-01T00:00:01.000Z',
    };
    const fallback: RoomNotification = {
      ...aliased,
      id: '22222222-2222-4222-8222-222222222222',
      eventId: '32222222-2222-4222-8222-222222222222',
      idempotencyKey: 'notification',
    };

    const result: RoomNotificationsResult = {
      roomId: 'room-1',
      limit: 100,
      events: [aliased],
      notifications: [fallback],
      nextWatermarkCreatedAt: aliased.createdAt,
      nextWatermarkId: aliased.id,
      hasMore: false,
      serverHighWatermarkCreatedAt: aliased.createdAt,
      serverHighWatermarkId: aliased.id,
    };

    expect(getRoomNotificationEvents(result)).toEqual([aliased]);
  });

  it('does not advance the notification cursor past the bounded catch-up watermark', () => {
    const included: RoomNotification = {
      id: '11111111-1111-4111-8111-111111111111',
      eventId: '21111111-1111-4111-8111-111111111111',
      idempotencyKey: 'included',
      notificationType: 'item_fields_updated',
      targetMemberId: null,
      payload: {},
      createdAt: '2026-08-01T00:00:01.000Z',
    };
    const afterCeiling: RoomNotification = {
      id: '33333333-3333-4333-8333-333333333333',
      eventId: '43333333-3333-4333-8333-333333333333',
      idempotencyKey: 'after-ceiling',
      notificationType: 'item_fields_updated',
      targetMemberId: null,
      payload: {},
      createdAt: '2026-08-01T00:00:03.000Z',
    };

    const summary = summarizeNotificationCatchUpPage(
      {
        roomId: 'room-1',
        limit: 2,
        events: [included, afterCeiling],
        notifications: [included, afterCeiling],
        nextWatermarkCreatedAt: afterCeiling.createdAt,
        nextWatermarkId: afterCeiling.id,
        hasMore: true,
        serverHighWatermarkCreatedAt: included.createdAt,
        serverHighWatermarkId: included.id,
      },
      included.createdAt,
      included.id,
    );

    expect(summary.included).toEqual([included]);
    expect(summary.nextCursorCreatedAt).toBe(included.createdAt);
    expect(summary.nextCursorId).toBe(included.id);
    expect(summary.shouldContinue).toBe(false);
  });
});
