import { describe, expect, it } from 'vitest';
import type { AssignmentMemberProfile, ShoppingItem } from '../../types/item';
import {
  UNASSIGNED_ROUTE_GROUP_ID,
  buildAssignmentRouteGroups,
  keepsAssignmentRouteLock,
  normalizeExecuteIdsByAssignmentRouteLock,
  reorderExecuteIdsByAssignmentRouteOrder,
} from './assignmentRouteOrder';

const member = (
  roomMemberId: string,
  displayName: string,
  membershipStatus: AssignmentMemberProfile['membershipStatus'] = 'active',
): AssignmentMemberProfile => ({
  roomMemberId,
  displayName,
  role: 'member',
  membershipStatus,
});

const item = (id: string, assignedTo?: string): ShoppingItem => ({
  id,
  circle: id,
  eventDate: 'Day1',
  block: 'A',
  number: id,
  title: '',
  price: null,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
  assignedTo,
});

describe('assignment route order', () => {
  it('builds assignment route groups in current execute order', () => {
    const groups = buildAssignmentRouteGroups(
      ['s1', 's2', 't1', 'none1', 's3'],
      [item('s1', 'sato'), item('s2', 'sato'), item('t1', 'tanaka'), item('none1'), item('s3', 'sato')],
      [member('sato', '佐藤'), member('tanaka', '田中')],
    );

    expect(groups).toEqual([
      expect.objectContaining({ groupId: 'sato', displayName: '佐藤', itemIds: ['s1', 's2', 's3'] }),
      expect.objectContaining({ groupId: 'tanaka', displayName: '田中', itemIds: ['t1'] }),
      expect.objectContaining({
        groupId: UNASSIGNED_ROUTE_GROUP_ID,
        displayName: '未担当',
        itemIds: ['none1'],
      }),
    ]);
  });

  it('reorders execute ids by assignment route group while preserving in-member order', () => {
    const result = reorderExecuteIdsByAssignmentRouteOrder(
      ['s1', 't1', 's2', 'm1', 't2'],
      [
        item('s1', 'sato'),
        item('t1', 'tanaka'),
        item('s2', 'sato'),
        item('m1', 'manaka'),
        item('t2', 'tanaka'),
      ],
      ['sato', 'tanaka', 'manaka'],
    );

    expect(result).toEqual(['s1', 's2', 't1', 't2', 'm1']);
  });

  it('keeps unknown groups after the requested order', () => {
    const result = reorderExecuteIdsByAssignmentRouteOrder(
      ['s1', 'x1', 'none1'],
      [item('s1', 'sato'), item('x1', 'unknown'), item('none1')],
      ['sato'],
    );

    expect(result).toEqual(['s1', 'x1', 'none1']);
  });

  it('detects route changes that cross assignment group boundaries', () => {
    const items = [
      item('s1', 'sato'),
      item('s2', 'sato'),
      item('t1', 'tanaka'),
      item('t2', 'tanaka'),
    ];

    expect(
      keepsAssignmentRouteLock(['s1', 's2', 't1', 't2'], ['s2', 's1', 't1', 't2'], items),
    ).toBe(true);
    expect(
      keepsAssignmentRouteLock(['s1', 's2', 't1', 't2'], ['t1', 't2', 's1', 's2'], items),
    ).toBe(false);
    expect(
      keepsAssignmentRouteLock(['s1', 's2', 't1', 't2'], ['s1', 't1', 's2', 't2'], items),
    ).toBe(false);
  });

  it('normalizes added route items into the current assignment group order', () => {
    const items = [item('s1', 'sato'), item('s2', 'sato'), item('t1', 'tanaka')];

    expect(
      normalizeExecuteIdsByAssignmentRouteLock(['s1', 't1'], ['s1', 't1', 's2'], items),
    ).toEqual(['s1', 's2', 't1']);
  });
});
