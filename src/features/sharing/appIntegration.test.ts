import { describe, expect, it } from 'vitest';
import { buildRoomEventPayloadForEvent, findActiveSharingSessionForEvent } from './appIntegration';

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
        },
      },
      'テスト即売会',
      now,
    );

    expect(active?.sessionId).toBe('current');
  });
});
