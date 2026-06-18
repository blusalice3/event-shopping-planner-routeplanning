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
  type RoomItemChange,
  type RoomNotification,
  type RoomNotificationsResult,
  type SnapshotRoomItem,
  type RoomSnapshot,
} from './client';
import type { ShoppingItem } from '../../types/item';

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
          eventDate: '2026-08-15',
          name: 'Book',
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
          itemVersion: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ],
      eventData: {
        schemaVersion: 1,
        eventMetadata: { eventName: 'テストイベント' },
        executeModeItems: {},
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
      }),
    );
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

  it('merges an RPC item payload into an existing shopping item without replacing static fields', () => {
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
      eventDate: '2026-08-15',
      name: 'DB name',
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
      itemVersion: 4,
      updatedAt: '2026-08-01T00:00:04.000Z',
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
