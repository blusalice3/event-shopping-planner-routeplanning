import { describe, expect, it } from 'vitest';
import { MAX_ROOM_EVENT_DATA_BYTES } from './contracts';
import {
  RoomEventDataValidationError,
  parseRoomEventData,
} from './roomEventDataSchema';

const validPayload = {
  schemaVersion: 1,
  eventMetadata: { eventName: 'テストイベント' },
  executeModeItems: { '2026-08-15': ['item-1'] },
  dayModes: { '2026-08-15': 'circle' },
  mapData: {},
  mapRotationSettings: {},
  routeSettings: {},
  hallDefinitions: {},
  hallRouteSettings: {},
  mapViewportSettings: {},
  routeOrderByDate: { '2026-08-15': ['item-1'] },
  itemSnapshots: {
    'item-1': {
      priorityLevel: 1,
      source: 'manual',
    },
  },
} as const;

describe('roomEventDataSchema', () => {
  it('accepts the fixed schema version and expected payload shape', () => {
    expect(parseRoomEventData(validPayload)).toEqual(validPayload);
  });

  it('rejects an unknown schema version', () => {
    expect(() =>
      parseRoomEventData({ ...validPayload, schemaVersion: 2 }),
    ).toThrow(RoomEventDataValidationError);
  });

  it('rejects unknown top-level fields', () => {
    expect(() =>
      parseRoomEventData({ ...validPayload, unexpected: true }),
    ).toThrow(RoomEventDataValidationError);
  });

  it('rejects event-name nesting in routeOrderByDate', () => {
    expect(() =>
      parseRoomEventData({
        ...validPayload,
        routeOrderByDate: {
          eventName: {
            '2026-08-15': ['item-1'],
          },
        },
      }),
    ).toThrow(RoomEventDataValidationError);
  });

  it('rejects payloads above the room event data byte limit', () => {
    expect(() =>
      parseRoomEventData({
        ...validPayload,
        eventMetadata: {
          huge: 'x'.repeat(MAX_ROOM_EVENT_DATA_BYTES),
        },
      }),
    ).toThrow(RoomEventDataValidationError);
  });
});
