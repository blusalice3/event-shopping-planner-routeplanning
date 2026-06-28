import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ackRoomMemberRouteOrderVersions,
  getMemberRouteOrderByDate,
  updateMemberRouteOrder,
  updateRoomItemAssignmentWithMemberRoutes,
} from './client';
import { SHARING_CONTRACT_VERSION } from './contracts';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/supabase', () => ({
  supabase: {
    rpc: rpcMock,
  },
  getSharingAvailability: () => ({ enabled: true, mode: 'local_or_limited' }),
  isSharingEnabled: () => true,
  getSharingPublicGuardBaseUrl: () => null,
}));

const successEnvelope = (data: unknown) => ({
  ok: true,
  data,
  contract_version: SHARING_CONTRACT_VERSION,
});

describe('member route RPC client helpers', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('loads a member route order by date', async () => {
    rpcMock.mockResolvedValueOnce({
      data: successEnvelope({
        roomId: 'room-1',
        eventDate: 'day-1',
        routeMemberId: 'member-1',
        itemIds: ['item-1'],
        dateMemberRouteOrderVersion: 2,
        routeOrderVersion: 5,
        memberRouteOrderVersions: {
          'day-1': {
            'member-1': 2,
          },
        },
      }),
      error: null,
    });

    await expect(
      getMemberRouteOrderByDate('room-1', 'day-1', 'member-1'),
    ).resolves.toEqual({
      ok: true,
      contract_version: SHARING_CONTRACT_VERSION,
      data: {
        roomId: 'room-1',
        eventDate: 'day-1',
        routeMemberId: 'member-1',
        itemIds: ['item-1'],
        dateMemberRouteOrderVersion: 2,
        routeOrderVersion: 5,
        memberRouteOrderVersions: {
          'day-1': {
            'member-1': 2,
          },
        },
      },
    });

    expect(rpcMock).toHaveBeenCalledWith('get_member_route_order_by_date', {
      p_room_id: 'room-1',
      p_event_date: 'day-1',
      p_route_member_id: 'member-1',
    });
  });

  it('updates a member route order', async () => {
    rpcMock.mockResolvedValueOnce({
      data: successEnvelope({
        roomId: 'room-1',
        eventDate: 'day-1',
        routeMemberId: 'member-1',
        itemIds: ['item-2', 'item-1'],
        dateMemberRouteOrderVersion: 3,
        routeOrderVersion: 6,
        memberRouteOrderVersions: {
          'day-1': {
            'member-1': 3,
          },
        },
        changedMemberRouteOrders: [
          {
            eventDate: 'day-1',
            routeMemberId: 'member-1',
            itemIds: ['item-2', 'item-1'],
            dateMemberRouteOrderVersion: 3,
          },
        ],
        notificationId: 'notification-1',
      }),
      error: null,
    });

    const result = await updateMemberRouteOrder({
      roomId: 'room-1',
      eventDate: 'day-1',
      routeMemberId: 'member-1',
      itemIds: ['item-2', 'item-1'],
      expectedVersion: 2,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.dateMemberRouteOrderVersion).toBe(3);
    expect(rpcMock).toHaveBeenCalledWith('update_member_route_order', {
      p_room_id: 'room-1',
      p_event_date: 'day-1',
      p_route_member_id: 'member-1',
      p_item_ids: ['item-2', 'item-1'],
      p_expected_version: 2,
    });
  });

  it('acks member route order versions', async () => {
    rpcMock.mockResolvedValueOnce({
      data: successEnvelope({
        roomId: 'room-1',
        roomMemberId: 'member-1',
        memberRouteOrderVersions: {
          'day-1': {
            'member-1': 3,
            'member-2': 4,
          },
        },
      }),
      error: null,
    });

    const versions = {
      'day-1': {
        'member-1': 3,
        'member-2': 4,
      },
    };

    await expect(ackRoomMemberRouteOrderVersions('room-1', versions)).resolves.toEqual({
      ok: true,
      contract_version: SHARING_CONTRACT_VERSION,
      data: {
        roomId: 'room-1',
        roomMemberId: 'member-1',
        memberRouteOrderVersions: versions,
      },
    });

    expect(rpcMock).toHaveBeenCalledWith('ack_room_member_route_order_versions', {
      p_room_id: 'room-1',
      p_member_route_order_versions: versions,
    });
  });

  it('updates assignments and member routes atomically', async () => {
    rpcMock.mockResolvedValueOnce({
      data: successEnvelope({
        roomId: 'room-1',
        itemsVersion: 7,
        changedItems: [],
        routeOrderVersion: 8,
        memberRouteOrderVersions: {
          'day-1': {
            'member-1': 4,
          },
        },
        changedMemberRouteOrders: [
          {
            eventDate: 'day-1',
            routeMemberId: 'member-1',
            itemIds: ['item-1'],
            dateMemberRouteOrderVersion: 4,
          },
        ],
      }),
      error: null,
    });

    const result = await updateRoomItemAssignmentWithMemberRoutes({
      roomId: 'room-1',
      assignments: [
        {
          localItemId: 'item-1',
          assignedToMemberId: 'member-1',
          expectedFieldClocks: {
            assignedTo: {
              itemsVersion: 6,
              updatedAt: '2026-06-26T00:00:00.000Z',
            },
          },
        },
      ],
      memberRouteUpdates: [
        {
          eventDate: 'day-1',
          routeMemberId: 'member-1',
          itemIds: ['item-1'],
          expectedVersion: 3,
        },
      ],
    });

    expect(result.ok && result.data.memberRouteOrderVersions['day-1']['member-1']).toBe(4);
    expect(rpcMock).toHaveBeenCalledWith('update_room_item_assignment_with_member_routes', {
      p_room_id: 'room-1',
      p_assignment_mutations: [
        {
          localItemId: 'item-1',
          assignedToMemberId: 'member-1',
          expectedFieldClocks: {
            assignedTo: {
              itemsVersion: 6,
              updatedAt: '2026-06-26T00:00:00.000Z',
            },
          },
        },
      ],
      p_member_route_updates: [
        {
          eventDate: 'day-1',
          routeMemberId: 'member-1',
          itemIds: ['item-1'],
          expectedVersion: 3,
        },
      ],
    });
  });
});
