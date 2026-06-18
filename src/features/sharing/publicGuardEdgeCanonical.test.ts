import { describe, expect, it } from 'vitest';
import {
  canonicalizeCreatePayloadForGuard,
  guardCreateRoom,
} from '../../../supabase/functions/_shared/public-guard';
import { canonicalCreateRoomPayload } from './canonicalCreateRoomPayload';

const roomId = '11111111-1111-4111-8111-111111111111';

describe('public Guard Edge canonicalization', () => {
  it('matches the client canonical bytes and fingerprint for equivalent payloads', async () => {
    const rawPayload =
      ' { "schemaVersion" : 1, "eventMetadata" : { "eventName" : "e\\u0301" }, "itemSnapshots" : { "item-1" : { "title" : "本" } } } ';
    const client = await canonicalCreateRoomPayload(rawPayload);
    const guard = await canonicalizeCreatePayloadForGuard(rawPayload, roomId, 1);

    expect(guard.canonicalPayload).toBe(client.canonicalText);
    expect(guard.fingerprint).toBe(client.fingerprint);
    expect(guard.byteLength).toBe(client.plaintextSizeBytes);
  });

  it('rejects client-supplied fingerprint values that do not match Guard-derived bytes', async () => {
    const response = await guardCreateRoom(
      {
        authUserId: roomId,
        requestId: 'request-1',
        request: new Request('https://example.test/guard-create-room', {
          method: 'POST',
        }),
        env: {
          supabaseUrl: 'https://example.supabase.co',
          serviceRoleKey: 'service-role-key',
        },
      },
      {
        contract_version: 1,
        room_id: roomId,
        canonical_payload:
          '{"eventMetadata":{"eventName":"Public Guard"},"itemSnapshots":{},"schemaVersion":1}',
        plaintext_fingerprint: 'A'.repeat(43),
        item_count: 0,
        canonical_schema_version: 1,
        payload_protection_mode: 'encrypted',
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'CHALLENGE_INVALID',
        contract_version: 1,
      },
    });
  });
});
