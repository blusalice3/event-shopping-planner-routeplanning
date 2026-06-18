import { describe, expect, it } from 'vitest';
import type { ShoppingItem } from '../types/item';
import type { DayMapData, HallDefinition } from '../types/map';
import {
  buildMapRouteExecuteItemIds,
  filterFirstRouteMarkers,
  normalizeMapRouteDayText,
  resolveMapRouteHallOrder,
} from './mapRouteOrder';

const makeItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: 'item-1',
  circle: 'Circle',
  eventDate: 'Day1',
  block: 'A',
  number: '01a',
  title: 'Title',
  price: 1000,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
  url: '',
  priorityLevel: 'none',
  ...overrides,
});

const makeItems = (count: number): ShoppingItem[] =>
  Array.from({ length: count }, (_, index) =>
    makeItem({
      id: `item-${index + 1}`,
      number: `${index + 1}a`,
    }),
  );

const makeMap = (): DayMapData => ({
  sheetName: 'Sheet',
  rows: 40,
  cols: 40,
  maxRow: 40,
  maxCol: 40,
  cells: [],
  mergedCells: [],
  blocks: [
    {
      name: 'A',
      startRow: 1,
      startCol: 1,
      endRow: 20,
      endCol: 20,
      numberCells: Array.from({ length: 30 }, (_, index) => ({
        row: index + 1,
        col: 2,
        value: index + 1,
      })),
    },
    {
      name: 'B',
      startRow: 21,
      startCol: 1,
      endRow: 35,
      endCol: 20,
      numberCells: [
        { row: 22, col: 2, value: 1 },
        { row: 23, col: 2, value: 2 },
      ],
    },
  ],
});

const halls: HallDefinition[] = [
  {
    id: 'hall-a',
    name: 'Hall A',
    vertices: [
      { row: 0, col: 0 },
      { row: 0, col: 25 },
      { row: 21, col: 25 },
      { row: 21, col: 0 },
    ],
    blockNames: ['A'],
  },
  {
    id: 'hall-b',
    name: 'Hall B',
    vertices: [
      { row: 20, col: 0 },
      { row: 20, col: 25 },
      { row: 36, col: 25 },
      { row: 36, col: 0 },
    ],
    blockNames: ['B'],
  },
];

describe('normalizeMapRouteDayText', () => {
  it('normalizes full-width spaces and trims day names', () => {
    expect(normalizeMapRouteDayText(' Day1\u3000')).toBe('Day1');
  });
});

describe('resolveMapRouteHallOrder', () => {
  it('uses routeHallOrder when it has values', () => {
    expect(resolveMapRouteHallOrder(['hall-a'], ['hall-b'])).toEqual(['hall-a']);
  });

  it('falls back when routeHallOrder is empty or undefined', () => {
    expect(resolveMapRouteHallOrder([], ['hall-b'])).toEqual(['hall-b']);
    expect(resolveMapRouteHallOrder(undefined, ['hall-b'])).toEqual(['hall-b']);
  });
});

describe('filterFirstRouteMarkers', () => {
  it('keeps the first marker for each route cell', () => {
    const markers = [
      { row: 1, col: 1, order: 0 },
      { row: 1, col: 1, order: 1 },
      { row: 2, col: 1, order: 2 },
    ];

    expect(filterFirstRouteMarkers(markers)).toEqual([
      { row: 1, col: 1, order: 0 },
      { row: 2, col: 1, order: 2 },
    ]);
  });
});

describe('buildMapRouteExecuteItemIds', () => {
  it('uses the priority group order when hallOrder contains the priority group', () => {
    const items = makeItems(30).map((item) =>
      item.id === 'item-20'
        ? { ...item, priorityLevel: 'priority' as const }
        : item,
    );

    expect(
      buildMapRouteExecuteItemIds({
        executeModeItemIds: items.map((item) => item.id),
        items,
        mapData: makeMap(),
        hallDefinitions: halls,
        hallOrder: ['hall-a:priority', 'hall-a'],
        dayName: 'Day1',
      }),
    ).toEqual([
      'item-20',
      ...items.filter((item) => item.id !== 'item-20').map((item) => item.id),
    ]);
  });

  it('follows mixed highest priority and normal hall groups in hallOrder', () => {
    const items = [
      makeItem({ id: 'a-normal', block: 'A', number: '1a' }),
      makeItem({ id: 'b-normal', block: 'B', number: '1a' }),
      makeItem({
        id: 'a-highest',
        block: 'A',
        number: '2a',
        priorityLevel: 'highest',
      }),
      makeItem({
        id: 'b-priority',
        block: 'B',
        number: '2a',
        priorityLevel: 'priority',
      }),
    ];

    expect(
      buildMapRouteExecuteItemIds({
        executeModeItemIds: ['a-normal', 'b-normal', 'a-highest', 'b-priority'],
        items,
        mapData: makeMap(),
        hallDefinitions: halls,
        hallOrder: ['hall-a:highest', 'hall-b:priority', 'hall-a', 'hall-b'],
        dayName: 'Day1',
      }),
    ).toEqual(['a-highest', 'b-priority', 'a-normal', 'b-normal']);
  });

  it('uses undefined priority buckets even when hall definitions are empty', () => {
    const items = [
      makeItem({ id: 'normal-1' }),
      makeItem({ id: 'priority-1', priorityLevel: 'priority' }),
      makeItem({ id: 'highest-1', priorityLevel: 'highest' }),
      makeItem({ id: 'normal-2', number: '2a' }),
    ];

    expect(
      buildMapRouteExecuteItemIds({
        executeModeItemIds: ['normal-1', 'priority-1', 'highest-1', 'normal-2'],
        items,
        mapData: null,
        hallDefinitions: [],
        hallOrder: ['undefined:highest', 'undefined:priority', 'undefined'],
        dayName: 'Day1',
      }),
    ).toEqual(['highest-1', 'priority-1', 'normal-1', 'normal-2']);
  });

  it('normalizes day names before filtering route ids', () => {
    const items = [
      makeItem({ id: 'day-1', eventDate: 'Day1\u3000' }),
      makeItem({ id: 'day-2', eventDate: 'Day2' }),
    ];

    expect(
      buildMapRouteExecuteItemIds({
        executeModeItemIds: ['day-2', 'day-1'],
        items,
        mapData: makeMap(),
        hallDefinitions: halls,
        hallOrder: ['hall-a'],
        dayName: ' Day1 ',
      }),
    ).toEqual(['day-1']);
  });

  it('drops missing ids and items from other days', () => {
    const items = [
      makeItem({ id: 'day-1' }),
      makeItem({ id: 'day-2', eventDate: 'Day2' }),
    ];

    expect(
      buildMapRouteExecuteItemIds({
        executeModeItemIds: ['missing', 'day-2', 'day-1'],
        items,
        mapData: makeMap(),
        hallDefinitions: halls,
        hallOrder: ['hall-a'],
        dayName: 'Day1',
      }),
    ).toEqual(['day-1']);
  });
});
