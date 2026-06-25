import { describe, expect, it } from 'vitest';
import {
  SHARING_SYNC_UPGRADE_REQUIRED_MESSAGE,
  buildLocalizedSharingSessionForSyncUpgrade,
  buildRoomEventPayloadForEvent,
  clearSatisfiedRouteOrderAcks,
  findActiveSharingSessionForEvent,
  isSharingSyncUpgradeRequiredErrorCode,
  isSharingSessionSyncMetadataCompatible,
  markPendingItemSyncAckAttempt,
  markPendingRouteOrderAckAttempt,
  mergePendingRouteOrderAcks,
  normalizePendingRouteOrderAcks,
} from './appIntegration';

describe('buildRoomEventPayloadForEvent', () => {
  it('builds a schema v1 payload for a single event snapshot', () => {
    const result = buildRoomEventPayloadForEvent({
      eventName: 'テスト即売会',
      eventLists: {
        テスト即売会: [
          {
            id: 'item-1',
            circle: 'サークルA',
            eventDate: '1日目',
            block: 'A',
            number: '01',
            title: '新刊',
            price: 500,
            purchaseStatus: 'None',
            quantity: 1,
            remarks: '',
            postponed: false,
          },
        ],
      },
      eventMetadata: {
        テスト即売会: {
          spreadsheetUrl: 'https://example.test/sheet',
          spreadsheetSheetName: 'list',
          lastImportDate: '2026-06-14',
        },
      },
      executeModeItems: {
        テスト即売会: {
          '1日目': ['item-1'],
        },
      },
      dayModes: {
        テスト即売会: {
          '1日目': 'edit',
        },
      },
      mapData: {},
      mapRotationSettings: {},
      routeSettings: {},
      hallDefinitions: {},
      hallRouteSettings: {},
      mapViewportSettings: {},
    });

    expect(result.itemCount).toBe(1);
    expect(result.payload.schemaVersion).toBe(1);
    expect(result.payload.eventMetadata.eventName).toBe('テスト即売会');
    expect(result.payload.executeModeItems).toEqual({ '1日目': ['item-1'] });
    expect(result.payload.routeOrderByDate).toEqual({ '1日目': ['item-1'] });
    expect(result.payload.itemSnapshots['item-1']).toMatchObject({
      circle: 'サークルA',
      title: '新刊',
    });
    expect(JSON.parse(result.rawJson)).toEqual(result.payload);
  });
});

describe('findActiveSharingSessionForEvent', () => {
  const currentSyncMetadata = {
    contractVersion: 2,
    metadataSchemaVersion: 2,
    fieldClocksByItemId: {},
  };

  it('ignores expired sessions when deciding the structure lock', () => {
    const now = Date.parse('2026-06-14T12:00:00.000Z');
    const active = findActiveSharingSessionForEvent(
      {
        old: {
          sessionId: 'old',
          roomId: 'room-old',
          roomMemberId: 'member-old',
          eventName: 'テスト即売会',
          role: 'member',
          status: 'active',
          startedAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T11:00:00.000Z',
          itemsVersion: 1,
          routeOrderVersions: {},
          ...currentSyncMetadata,
        },
        current: {
          sessionId: 'current',
          roomId: 'room-current',
          roomMemberId: 'member-current',
          eventName: 'テスト即売会',
          role: 'host',
          status: 'active',
          startedAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T13:00:00.000Z',
          itemsVersion: 1,
          routeOrderVersions: {},
          ...currentSyncMetadata,
        },
        leaving: {
          sessionId: 'leaving',
          roomId: 'room-leaving',
          roomMemberId: 'member-leaving',
          eventName: 'テスト即売会',
          role: 'member',
          status: 'leaving',
          startedAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T13:00:00.000Z',
          itemsVersion: 1,
          routeOrderVersions: {},
          ...currentSyncMetadata,
        },
      },
      'テスト即売会',
      now,
    );

    expect(active?.sessionId).toBe('current');
  });

  it('does not select an active session with legacy sync metadata for shared item operations', () => {
    const now = Date.parse('2026-06-14T12:00:00.000Z');
    const active = findActiveSharingSessionForEvent(
      {
        legacy: {
          sessionId: 'legacy',
          roomId: 'room-legacy',
          roomMemberId: 'member-legacy',
          eventName: 'テスト即売会',
          role: 'host',
          status: 'active',
          startedAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-06-14T13:00:00.000Z',
          itemsVersion: 1,
          routeOrderVersions: {},
          contractVersion: 1,
        },
      },
      'テスト即売会',
      now,
    );

    expect(active).toBeNull();
  });
});

describe('isSharingSessionSyncMetadataCompatible', () => {
  const baseSession = {
    sessionId: 'current',
    roomId: 'room-current',
    roomMemberId: 'member-current',
    eventName: 'テスト即売会',
    role: 'host' as const,
    status: 'active' as const,
    startedAt: '2026-06-14T00:00:00.000Z',
    expiresAt: '2026-06-14T13:00:00.000Z',
    itemsVersion: 1,
    routeOrderVersions: {},
    contractVersion: 2,
    metadataSchemaVersion: 2,
    fieldClocksByItemId: {},
  };

  it('accepts current v2 sync metadata with route versions and field clocks', () => {
    expect(isSharingSessionSyncMetadataCompatible(baseSession)).toBe(true);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        routeOrderVersions: { '1日目': 2 },
        pendingRouteOrderAcks: {
          '1日目': {
            version: 2,
            source: 'mutation',
            retryCount: 0,
            updatedAt: '2026-06-14T12:00:00.000Z',
          },
        },
      }),
    ).toBe(true);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingItemSyncAck: {
          fromItemsVersion: 1,
          targetItemsVersion: 2,
          affectedLocalItemIds: ['item-1'],
          retryCount: 1,
          lastTriedAt: '2026-06-14T12:01:00.000Z',
          updatedAt: '2026-06-14T12:00:00.000Z',
        },
      }),
    ).toBe(true);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingRouteOrderAcks: { '1日目': 2 },
      } as unknown as typeof baseSession),
    ).toBe(true);
  });

  it('rejects legacy or incomplete persisted metadata before incremental sync', () => {
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        contractVersion: 1,
      }),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        metadataSchemaVersion: undefined,
      }),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        fieldClocksByItemId: undefined,
      }),
    ).toBe(false);
  });

  it('rejects malformed route version and pending route ack metadata', () => {
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        routeOrderVersions: [] as unknown as Record<string, number>,
      }),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        routeOrderVersions: { '1日目': '2' } as unknown as Record<string, number>,
      }),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingItemSyncAck: {
          fromItemsVersion: 3,
          targetItemsVersion: 2,
          updatedAt: '2026-06-14T12:00:00.000Z',
        },
      }),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingItemSyncAck: {
          fromItemsVersion: 1,
          targetItemsVersion: 2,
          affectedLocalItemIds: [1],
          updatedAt: '2026-06-14T12:00:00.000Z',
        },
      } as unknown as typeof baseSession),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingRouteOrderAcks: [] as never,
      }),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingRouteOrderAcks: { '1日目': -1 },
      } as unknown as typeof baseSession),
    ).toBe(false);
    expect(
      isSharingSessionSyncMetadataCompatible({
        ...baseSession,
        pendingRouteOrderAcks: {
          '1日目': {
            version: 2,
            source: 'mutation',
            retryCount: -1,
            updatedAt: '2026-06-14T12:00:00.000Z',
          },
        },
      }),
    ).toBe(false);
  });
});

describe('sync upgrade hard stop helpers', () => {
  const baseSession = {
    sessionId: 'legacy',
    roomId: 'room-legacy',
    roomMemberId: 'member-legacy',
    eventName: 'テスト即売会',
    role: 'host' as const,
    status: 'active' as const,
    startedAt: '2026-06-14T00:00:00.000Z',
    expiresAt: '2026-06-14T13:00:00.000Z',
    itemsVersion: 7,
    routeOrderVersions: { '1日目': 3 },
    contractVersion: 1,
    metadataSchemaVersion: 1,
    fieldClocksByItemId: {
      'item-1': {
        title: { itemsVersion: 7, updatedAt: '2026-06-14T12:00:00.000Z' },
      },
    },
    deletedItemClocks: {
      'item-old': {
        deletedAt: '2026-06-14T11:00:00.000Z',
        deletedBy: 'member-legacy',
        fieldClocks: {},
        itemVersion: 6,
        updatedAt: '2026-06-14T11:00:00.000Z',
      },
    },
    pendingItemSyncAck: {
      fromItemsVersion: 6,
      targetItemsVersion: 7,
      updatedAt: '2026-06-14T12:00:00.000Z',
    },
    pendingRouteOrderAcks: {
      '1日目': {
        version: 3,
        source: 'mutation' as const,
        retryCount: 1,
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    },
    lastSnapshotReceiptId: 'receipt-legacy',
    lastProcessedEventCreatedAt: '2026-06-14T12:01:00.000Z',
    lastProcessedEventId: 'event-legacy',
    lastAckAt: '2026-06-14T12:02:00.000Z',
  };

  it('localizes an incompatible session and clears persisted incremental sync metadata', () => {
    expect(SHARING_SYNC_UPGRADE_REQUIRED_MESSAGE).toContain('ローカルデータは保持');

    expect(buildLocalizedSharingSessionForSyncUpgrade(baseSession, '2026-06-14T12:30:00.000Z'))
      .toEqual({
        ...baseSession,
        status: 'localizing',
        routeOrderVersions: {},
        fieldClocksByItemId: undefined,
        deletedItemClocks: undefined,
        pendingItemSyncAck: undefined,
        pendingRouteOrderAcks: undefined,
        lastSnapshotReceiptId: undefined,
        lastProcessedEventCreatedAt: null,
        lastProcessedEventId: null,
        lastAckAt: '2026-06-14T12:30:00.000Z',
      });
  });

  it('treats contract and restore errors as terminal upgrade-required sync errors', () => {
    expect(isSharingSyncUpgradeRequiredErrorCode('CLIENT_UPGRADE_REQUIRED')).toBe(true);
    expect(isSharingSyncUpgradeRequiredErrorCode('CONTRACT_VERSION_MISMATCH')).toBe(true);
    expect(isSharingSyncUpgradeRequiredErrorCode('RESTORE_REQUIRED')).toBe(true);
    expect(isSharingSyncUpgradeRequiredErrorCode('ROOM_UNAVAILABLE')).toBe(true);
    expect(isSharingSyncUpgradeRequiredErrorCode('ROOM_EXPIRED')).toBe(false);
    expect(isSharingSyncUpgradeRequiredErrorCode('FIELD_CLOCK_CONFLICT')).toBe(false);
  });
});

describe('pending route order ack helpers', () => {
  const nowIso = '2026-06-14T12:00:00.000Z';

  it('normalizes legacy numeric pending route ack metadata', () => {
    expect(normalizePendingRouteOrderAcks({ '1日目': 3 }, 'sync', nowIso)).toEqual({
      '1日目': {
        version: 3,
        source: 'sync',
        retryCount: 0,
        updatedAt: nowIso,
      },
    });
  });

  it('merges newer pending route ack versions while preserving same-version retry state', () => {
    const pending = {
      '1日目': {
        version: 2,
        source: 'mutation' as const,
        retryCount: 1,
        lastTriedAt: '2026-06-14T11:59:00.000Z',
        updatedAt: '2026-06-14T11:59:00.000Z',
      },
    };

    expect(mergePendingRouteOrderAcks(pending, { '1日目': 2, '2日目': 1 }, 'reorder', nowIso))
      .toEqual({
        '1日目': {
          version: 2,
          source: 'reorder',
          retryCount: 1,
          lastTriedAt: '2026-06-14T11:59:00.000Z',
          updatedAt: nowIso,
        },
        '2日目': {
          version: 1,
          source: 'reorder',
          retryCount: 0,
          updatedAt: nowIso,
        },
      });
  });

  it('increments retry metadata and clears only member-acked versions', () => {
    const pending = {
      '1日目': {
        version: 2,
        source: 'mutation' as const,
        retryCount: 0,
        updatedAt: nowIso,
      },
      '2日目': {
        version: 4,
        source: 'reorder' as const,
        retryCount: 1,
        lastTriedAt: '2026-06-14T11:59:00.000Z',
        updatedAt: '2026-06-14T11:59:00.000Z',
      },
    };

    const attempted = markPendingRouteOrderAckAttempt(pending, nowIso);
    expect(attempted?.['1日目']).toMatchObject({
      version: 2,
      retryCount: 1,
      lastTriedAt: nowIso,
    });
    expect(attempted?.['2日目']).toMatchObject({
      version: 4,
      retryCount: 2,
      lastTriedAt: nowIso,
    });

    expect(clearSatisfiedRouteOrderAcks(attempted, { '1日目': 2, '2日目': 3 }, nowIso))
      .toEqual({
        '2日目': {
          version: 4,
          source: 'reorder',
          retryCount: 2,
          lastTriedAt: nowIso,
          updatedAt: nowIso,
        },
      });
  });
});

describe('pending item sync ack helpers', () => {
  const nowIso = '2026-06-14T12:00:00.000Z';

  it('increments retry metadata before retrying item sync ack', () => {
    expect(
      markPendingItemSyncAckAttempt(
        {
          fromItemsVersion: 2,
          targetItemsVersion: 5,
          affectedLocalItemIds: ['item-1'],
          retryCount: 1,
          lastTriedAt: '2026-06-14T11:59:00.000Z',
          updatedAt: '2026-06-14T11:59:00.000Z',
        },
        nowIso,
      ),
    ).toEqual({
      fromItemsVersion: 2,
      targetItemsVersion: 5,
      affectedLocalItemIds: ['item-1'],
      retryCount: 2,
      lastTriedAt: nowIso,
      updatedAt: nowIso,
    });
  });

  it('drops malformed pending item sync ack metadata instead of retrying it', () => {
    expect(
      markPendingItemSyncAckAttempt(
        {
          fromItemsVersion: 5,
          targetItemsVersion: 2,
          updatedAt: nowIso,
        },
        nowIso,
      ),
    ).toBeUndefined();
  });
});
