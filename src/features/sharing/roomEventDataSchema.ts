import { z } from 'zod';
import {
  MAX_ROOM_EVENT_DATA_BYTES,
  ROOM_EVENT_DATA_SCHEMA_VERSION,
} from './contracts';

export type RoomEventJson =
  | null
  | boolean
  | number
  | string
  | RoomEventJson[]
  | { [key: string]: RoomEventJson };

const roomEventJsonSchema: z.ZodType<RoomEventJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(roomEventJsonSchema),
    z.record(z.string(), roomEventJsonSchema),
  ]),
);

const stringArrayRecordSchema = z.record(z.string(), z.array(z.string()));
const memberRouteItemsSchema = z.record(z.string(), stringArrayRecordSchema);
const jsonRecordSchema = z.record(z.string(), roomEventJsonSchema);

export const roomEventDataSchema = z
  .object({
    schemaVersion: z.literal(ROOM_EVENT_DATA_SCHEMA_VERSION),
    eventMetadata: jsonRecordSchema,
    executeModeItems: stringArrayRecordSchema,
    memberRouteItems: memberRouteItemsSchema.default({}),
    memberProfilesSnapshot: z.array(jsonRecordSchema).default([]),
    dayModes: z.record(z.string(), z.string()),
    mapData: jsonRecordSchema,
    mapRotationSettings: jsonRecordSchema,
    routeSettings: jsonRecordSchema,
    hallDefinitions: jsonRecordSchema,
    hallRouteSettings: jsonRecordSchema,
    mapViewportSettings: jsonRecordSchema,
    routeOrderByDate: stringArrayRecordSchema,
    itemSnapshots: z.record(z.string(), jsonRecordSchema),
  })
  .strict();

export type RoomEventDataPayload = z.infer<typeof roomEventDataSchema>;

export class RoomEventDataValidationError extends Error {
  constructor(
    public readonly reason: 'INVALID_SCHEMA' | 'PAYLOAD_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'RoomEventDataValidationError';
  }
}

export const parseRoomEventData = (input: unknown): RoomEventDataPayload => {
  const parsed = roomEventDataSchema.safeParse(input);
  if (!parsed.success) {
    throw new RoomEventDataValidationError(
      'INVALID_SCHEMA',
      z.prettifyError(parsed.error),
    );
  }

  const encoded = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (encoded.byteLength > MAX_ROOM_EVENT_DATA_BYTES) {
    throw new RoomEventDataValidationError(
      'PAYLOAD_TOO_LARGE',
      `Room event data exceeds ${MAX_ROOM_EVENT_DATA_BYTES} bytes.`,
    );
  }

  return parsed.data;
};
