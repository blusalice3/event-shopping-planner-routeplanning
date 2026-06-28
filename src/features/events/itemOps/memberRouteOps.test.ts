import { describe, expect, it } from 'vitest';
import type { ShoppingItem } from '../../../types/item';
import {
  addToMemberRouteAndAssign,
  applyCanonicalMemberRouteOrders,
  bulkAssignOnly,
  delegateMemberRouteItem,
  removeDeletedIdsFromMemberRouteItems,
  removeFromAllMemberRoutesAndUnassign,
} from './memberRouteOps';

const item = (
  id: string,
  eventDate: string,
  assignedTo?: string,
): ShoppingItem => ({
  id,
  circle: `Circle ${id}`,
  eventDate,
  block: 'A',
  number: id,
  title: `Title ${id}`,
  price: null,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
  assignedTo,
});

describe('memberRouteOps', () => {
  it('adds items to a member route and assigns them', () => {
    const items = [item('item-1', 'day-1'), item('item-2', 'day-1', 'member-old')];
    const result = addToMemberRouteAndAssign({
      items,
      memberRouteItems: {
        'day-1': {
          'member-old': ['item-2'],
        },
      },
      itemIds: ['item-1', 'item-2', 'missing'],
      eventDate: 'day-1',
      roomMemberId: 'member-new',
    });

    expect(result.memberRouteItems).toEqual({
      'day-1': {
        'member-old': [],
        'member-new': ['item-1', 'item-2'],
      },
    });
    expect(result.items.map((nextItem) => nextItem.assignedTo)).toEqual([
      'member-new',
      'member-new',
    ]);
  });

  it('removes items from every member route and clears assignment', () => {
    const result = removeFromAllMemberRoutesAndUnassign({
      items: [item('item-1', 'day-1', 'member-a'), item('item-2', 'day-1', 'member-b')],
      memberRouteItems: {
        'day-1': {
          'member-a': ['item-1'],
          'member-b': ['item-2', 'item-1'],
        },
      },
      itemIds: ['item-1'],
    });

    expect(result.memberRouteItems).toEqual({
      'day-1': {
        'member-a': [],
        'member-b': ['item-2'],
      },
    });
    expect(result.items.find((nextItem) => nextItem.id === 'item-1')?.assignedTo).toBeUndefined();
    expect(result.items.find((nextItem) => nextItem.id === 'item-2')?.assignedTo).toBe('member-b');
  });

  it('delegates routed items to the target member by each item date', () => {
    const result = delegateMemberRouteItem({
      items: [
        item('item-1', 'day-1', 'member-a'),
        item('item-2', 'day-2', 'member-a'),
      ],
      memberRouteItems: {
        'day-1': {
          'member-a': ['item-1'],
        },
        'day-2': {
          'member-a': ['item-2'],
        },
      },
      itemIds: ['item-1', 'item-2'],
      roomMemberId: 'member-b',
    });

    expect(result.memberRouteItems).toEqual({
      'day-1': {
        'member-a': [],
        'member-b': ['item-1'],
      },
      'day-2': {
        'member-a': [],
        'member-b': ['item-2'],
      },
    });
    expect(result.items.every((nextItem) => nextItem.assignedTo === 'member-b')).toBe(true);
  });

  it('bulk assigns without changing routes', () => {
    const items = [item('item-1', 'day-1'), item('item-2', 'day-1')];

    expect(bulkAssignOnly({ items, itemIds: ['item-1'], roomMemberId: 'member-a' })).toEqual([
      expect.objectContaining({ id: 'item-1', assignedTo: 'member-a' }),
      expect.objectContaining({ id: 'item-2', assignedTo: undefined }),
    ]);
  });

  it('removes deleted ids from every member route', () => {
    expect(
      removeDeletedIdsFromMemberRouteItems(
        {
          'day-1': {
            'member-a': ['item-1', 'item-2'],
          },
          'day-2': {
            'member-b': ['item-2', 'item-3'],
          },
        },
        new Set(['item-2']),
      ),
    ).toEqual({
      'day-1': {
        'member-a': ['item-1'],
      },
      'day-2': {
        'member-b': ['item-3'],
      },
    });
  });

  it('applies canonical member route orders', () => {
    expect(
      applyCanonicalMemberRouteOrders(
        {
          'day-1': {
            'member-a': ['old'],
            'member-b': ['keep'],
          },
        },
        [
          {
            eventDate: 'day-1',
            roomMemberId: 'member-a',
            itemIds: ['item-2', 'item-1', 'item-2'],
          },
        ],
      ),
    ).toEqual({
      'day-1': {
        'member-a': ['item-2', 'item-1'],
        'member-b': ['keep'],
      },
    });
  });
});
