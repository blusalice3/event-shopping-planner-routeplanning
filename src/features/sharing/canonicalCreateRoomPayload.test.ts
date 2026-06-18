import { describe, expect, it } from 'vitest';
import {
  CanonicalPayloadError,
  canonicalCreateRoomPayload,
  canonicalCreateRoomPayloadFromBytes,
} from './canonicalCreateRoomPayload';
import { MAX_CANONICAL_CREATE_PAYLOAD_BYTES } from './contracts';
import { parseRoomEventData } from './roomEventDataSchema';

const expectReason = async (
  action: () => Promise<unknown>,
  reason: CanonicalPayloadError['reason'],
): Promise<void> => {
  try {
    await action();
    throw new Error('Expected canonicalization to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalPayloadError);
    expect((error as CanonicalPayloadError).reason).toBe(reason);
  }
};

describe('canonicalCreateRoomPayload', () => {
  const validRoomEventDataPayload = {
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

  it('normalizes keys and values to NFC before RFC 8785 serialization', async () => {
    const result = await canonicalCreateRoomPayload(
      '{"z":"e\\u0301","\\u0065\\u0301":"value","a":-0,"emoji":"😀"}',
    );

    expect(result.canonicalText).toBe(
      '{"a":0,"emoji":"😀","z":"é","é":"value"}',
    );
    expect(result.plaintextSizeBytes).toBe(result.canonicalBytes.byteLength);
    expect(result.fingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('uses ECMAScript/JCS number serialization', async () => {
    const result = await canonicalCreateRoomPayload(
      '{"small":1e-7,"integer":1.0,"large":1e30,"negativeZero":-0}',
    );

    expect(result.canonicalText).toBe(
      '{"integer":1,"large":1e+30,"negativeZero":0,"small":1e-7}',
    );
  });

  it('rejects numeric values that cannot be represented as finite JSON numbers', async () => {
    await expectReason(
      () => canonicalCreateRoomPayload('{"tooLarge":1e999}'),
      'NON_FINITE_NUMBER',
    );
  });

  it('sorts BMP and non-BMP property names by UTF-16 code units', async () => {
    const result = await canonicalCreateRoomPayload(
      '{"😀":6,"€":5,"ö":4,"\\u0080":3,"1":2,"\\r":1}',
    );

    expect(result.canonicalText).toBe(
      '{"\\r":1,"1":2,"":3,"ö":4,"€":5,"😀":6}',
    );
  });

  it('rejects duplicate raw JSON keys', async () => {
    await expectReason(
      () => canonicalCreateRoomPayload('{"same":1,"same":2}'),
      'DUPLICATE_KEY',
    );
  });

  it('rejects keys that collide after NFC normalization', async () => {
    await expectReason(
      () => canonicalCreateRoomPayload('{"é":1,"e\\u0301":2}'),
      'NFC_DUPLICATE_KEY',
    );
  });

  it('rejects lone surrogates', async () => {
    await expectReason(
      () => canonicalCreateRoomPayload('{"bad":"\\ud800"}'),
      'LONE_SURROGATE',
    );
  });

  it('rejects invalid UTF-8 bytes', async () => {
    await expectReason(
      () => canonicalCreateRoomPayloadFromBytes(new Uint8Array([0xc3, 0x28])),
      'INVALID_UTF8',
    );
  });

  it('preserves nulls, empty containers, and array order', async () => {
    const result = await canonicalCreateRoomPayload(
      '{"items":[3,null,1],"emptyArray":[],"emptyObject":{},"emptyString":""}',
    );

    expect(result.canonicalText).toBe(
      '{"emptyArray":[],"emptyObject":{},"emptyString":"","items":[3,null,1]}',
    );
  });

  it('rejects schema-unknown fields before canonical text is accepted for create payloads', async () => {
    await expectReason(
      () =>
        canonicalCreateRoomPayload(
          JSON.stringify({
            ...validRoomEventDataPayload,
            unexpected: true,
          }),
          { validate: parseRoomEventData },
        ),
      'INVALID_SCHEMA',
    );
  });

  it('rejects canonical payloads above the configured byte limit', async () => {
    await expectReason(
      () =>
        canonicalCreateRoomPayload(
          JSON.stringify({
            huge: 'x'.repeat(MAX_CANONICAL_CREATE_PAYLOAD_BYTES),
          }),
        ),
      'PAYLOAD_TOO_LARGE',
    );
  });

  it('produces the same bytes and fingerprint for canonically equivalent input', async () => {
    const first = await canonicalCreateRoomPayload('{"b":"e\\u0301","a":1}');
    const second = await canonicalCreateRoomPayload(
      ' { "a" : 1.0, "b" : "é" } ',
    );

    expect(second.canonicalBytes).toEqual(first.canonicalBytes);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
