import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSessionMock, getSharingAvailabilityMock, rpcMock, signInAnonymouslyMock } =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    getSharingAvailabilityMock: vi.fn(),
    rpcMock: vi.fn(),
    signInAnonymouslyMock: vi.fn(),
  }));

vi.mock('../../lib/supabase', () => ({
  getSharingAvailability: getSharingAvailabilityMock,
  supabase: {
    auth: {
      getSession: getSessionMock,
      signInAnonymously: signInAnonymouslyMock,
    },
    rpc: rpcMock,
  },
}));

const internalError = {
  ok: false,
  error: {
    code: 'SHARING_INTERNAL_ERROR',
    contract_version: 2,
  },
};

const validRoomEventDataJson = JSON.stringify({
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
  itemSnapshots: {},
});

describe('sharing session RPC wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      clear: vi.fn(() => storage.clear()),
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      removeItem: vi.fn((key: string) => storage.delete(key)),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
    });
    getSharingAvailabilityMock.mockReturnValue({
      enabled: true,
      mode: 'local_or_limited',
    });
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          user: {
            id: 'user-1',
          },
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts valid room creation responses and stores the member key', async () => {
    rpcMock
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            challengeId: 'challenge-1',
            roomId: 'room-1',
          },
        },
      })
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            roomId: 'room-1',
            roomCode: 'AB12C',
            hostMemberId: 'member-host',
            expiresAt: '2026-08-01T00:00:00.000Z',
            itemsVersion: 0,
            routeOrderVersion: null,
            routeOrderVersions: {},
            tokenContext: 'restore:v1:room-1',
          },
        },
      });

    const { createSharingRoom, loadMemberKey } = await import('./client');
    const result = await createSharingRoom({
      roomId: 'room-1',
      displayName: 'Host',
      rawRoomEventDataJson: validRoomEventDataJson,
      itemCount: 0,
      memberKey: 'a'.repeat(43),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.roomCode).toBe('AB12C');
    expect(loadMemberKey('room-1')).toBe('a'.repeat(43));
  });

  it('rejects malformed room creation responses without storing the member key', async () => {
    rpcMock
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            challengeId: 'challenge-1',
            roomId: 'room-1',
          },
        },
      })
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            roomId: 'room-1',
            hostMemberId: 'member-host',
            expiresAt: '2026-08-01T00:00:00.000Z',
            itemsVersion: 0,
            routeOrderVersion: null,
            routeOrderVersions: {},
            tokenContext: 'restore:v1:room-1',
          },
        },
      });

    const { createSharingRoom, loadMemberKey } = await import('./client');
    await expect(
      createSharingRoom({
        roomId: 'room-1',
        displayName: 'Host',
        rawRoomEventDataJson: validRoomEventDataJson,
        itemCount: 0,
        memberKey: 'a'.repeat(43),
      }),
    ).resolves.toEqual(internalError);
    expect(loadMemberKey('room-1')).toBeNull();
  });

  it('rejects room creation responses with malformed expiry timestamps', async () => {
    rpcMock
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            challengeId: 'challenge-1',
            roomId: 'room-1',
          },
        },
      })
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            roomId: 'room-1',
            roomCode: 'AB12C',
            hostMemberId: 'member-host',
            expiresAt: '',
            itemsVersion: 0,
            routeOrderVersion: null,
            routeOrderVersions: {},
            tokenContext: 'restore:v1:room-1',
          },
        },
      });

    const { createSharingRoom, loadMemberKey } = await import('./client');
    await expect(
      createSharingRoom({
        roomId: 'room-1',
        displayName: 'Host',
        rawRoomEventDataJson: validRoomEventDataJson,
        itemCount: 0,
        memberKey: 'a'.repeat(43),
      }),
    ).resolves.toEqual(internalError);
    expect(loadMemberKey('room-1')).toBeNull();
  });

  it('accepts valid prepared member tokens', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          challengeId: 'challenge-1',
          roomId: 'room-1',
          tokenContext: 'join:v1:room-1',
          expiresAt: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const { prepareJoinRoom } = await import('./client');
    const result = await prepareJoinRoom('AB12C');

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.challengeId).toBe('challenge-1');
    expect(rpcMock).toHaveBeenCalledWith('prepare_room_member_token', {
      p_room_code: 'AB12C',
    });
  });

  it('rejects malformed prepared member tokens', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          challengeId: 'challenge-1',
          roomId: 'room-1',
          expiresAt: '2026-08-01T00:00:00.000Z',
        },
      },
    });

    const { prepareJoinRoom } = await import('./client');
    await expect(prepareJoinRoom('AB12C')).resolves.toEqual(internalError);
  });

  it('rejects prepared member tokens with malformed expiry timestamps', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          challengeId: 'challenge-1',
          roomId: 'room-1',
          tokenContext: 'join:v1:room-1',
          expiresAt: '',
        },
      },
    });

    const { prepareJoinRoom } = await import('./client');
    await expect(prepareJoinRoom('AB12C')).resolves.toEqual(internalError);
  });

  it('rejects malformed heartbeat session responses', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          roomMemberId: 'member-1',
          lastSeenAt: null,
        },
      },
    });

    const { heartbeatRoomSession } = await import('./client');
    await expect(heartbeatRoomSession('room-1')).resolves.toEqual(internalError);
  });

  it('rejects session state responses with malformed timestamps', async () => {
    rpcMock
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            roomId: 'room-1',
            roomMemberId: 'member-1',
            pausedAt: '',
          },
        },
      })
      .mockResolvedValueOnce({
        error: null,
        data: {
          ok: true,
          contract_version: 2,
          data: {
            roomId: 'room-1',
            roomMemberId: 'member-1',
            membershipStatus: 'left',
            leftAt: 'not-a-date',
          },
        },
      });

    const { pauseRoomSession, leaveRoom } = await import('./client');
    await expect(pauseRoomSession('room-1')).resolves.toEqual(internalError);
    await expect(leaveRoom('room-1')).resolves.toEqual(internalError);
  });

  it('rejects malformed member display profiles', async () => {
    rpcMock.mockResolvedValueOnce({
      error: null,
      data: {
        ok: true,
        contract_version: 2,
        data: {
          roomId: 'room-1',
          members: [
            {
              roomMemberId: 'member-1',
              displayName: 'Host',
              color: null,
              role: 'owner',
              membershipStatus: 'active',
            },
          ],
        },
      },
    });

    const { getRoomMembersForDisplay } = await import('./client');
    await expect(getRoomMembersForDisplay('room-1')).resolves.toEqual(internalError);
  });
});
