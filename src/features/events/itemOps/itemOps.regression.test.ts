import { describe, expect, it } from 'vitest';
import type { ExecuteModeItems, ShoppingItem } from '../../../types/item';
import type { HallDefinition, HallRouteSettings } from '../../../types/map';
import {
  computeAddToExecuteListFromMap,
  computeMoveItem,
  computeUpdateItemPriority,
  reorderExecuteIdsForSpaceAdjacency,
} from './index';

const dayName = '2026-01-01';

const makeItem = (
  id: string,
  block: string,
  number: string,
  priorityLevel: ShoppingItem['priorityLevel'] = 'none',
): ShoppingItem => ({
  id,
  circle: id,
  eventDate: dayName,
  block,
  number,
  title: '',
  price: null,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
  priorityLevel,
});

const halls: HallDefinition[] = [
  { id: 'hall-a', name: 'Hall A', vertices: [], blockNames: ['A'] },
  { id: 'hall-b', name: 'Hall B', vertices: [], blockNames: ['B'] },
];

const emptySettings: HallRouteSettings = { hallOrder: [], hallVisitLists: [] };

describe('itemOps regressions', () => {
  it('adds map items before later halls according to hallOrder', () => {
    const allItems = [makeItem('b1', 'B', '01'), makeItem('a1', 'A', '01')];
    const executeModeItems: ExecuteModeItems = { [dayName]: ['b1'] };

    const result = computeAddToExecuteListFromMap(
      'a1',
      dayName,
      allItems,
      executeModeItems,
      halls,
      { hallOrder: ['hall-a', 'hall-b'], hallVisitLists: [] },
      undefined,
    );

    expect(result[dayName]).toEqual(['a1', 'b1']);
  });

  it('moves a candidate item together with same-space same-priority siblings', () => {
    const allItems = [
      makeItem('a1', 'A', '01', 'priority'),
      makeItem('a2', 'A', '01', 'priority'),
      makeItem('b1', 'B', '01'),
    ];

    const result = computeMoveItem({
      dragId: 'a1',
      hoverId: 'b1',
      targetColumn: 'execute',
      sourceColumn: 'candidate',
      mode: 'edit',
      effectiveSelectedIds: new Set(),
      allItems,
      executeModeItems: { [dayName]: ['b1'] },
      dayName,
      selectedBlockFilters: new Set(),
    });

    expect(result.executeModeItems?.[dayName]).toEqual(['a1', 'a2', 'b1']);
  });

  it('blocks execute-column drag reorders across hall boundaries', () => {
    const allItems = [makeItem('a1', 'A', '01'), makeItem('b1', 'B', '01')];

    const result = computeMoveItem({
      dragId: 'a1',
      hoverId: 'b1',
      targetColumn: 'execute',
      mode: 'edit',
      effectiveSelectedIds: new Set(),
      allItems,
      executeModeItems: { [dayName]: ['a1', 'b1'] },
      dayName,
      selectedBlockFilters: new Set(),
      areItemsInSameHall: () => false,
    });

    expect(result).toEqual({});
  });

  it('updates priority hall groups and removes an empty old priority group', () => {
    const allItems = [makeItem('a1', 'A', '01', 'priority')];

    const result = computeUpdateItemPriority(
      'a1',
      'highest',
      allItems,
      halls,
      undefined,
      { ...emptySettings, hallOrder: ['hall-a:priority', 'hall-a'] },
    );

    expect(result.items[0].priorityLevel).toBe('highest');
    expect(result.hallRouteSettings.hallOrder).toEqual(['hall-a:highest', 'hall-a']);
  });

  it('keeps same-space execute items adjacent after a priority change', () => {
    const allItems = [
      makeItem('x1', 'X', '01'),
      makeItem('a1', 'A', '01', 'priority'),
      makeItem('a2', 'A', '01', 'priority'),
    ];

    const result = reorderExecuteIdsForSpaceAdjacency(
      'a1',
      allItems,
      { [dayName]: ['a1', 'x1', 'a2'] },
      dayName,
    );

    expect(result[dayName]).toEqual(['x1', 'a2', 'a1']);
  });
});
