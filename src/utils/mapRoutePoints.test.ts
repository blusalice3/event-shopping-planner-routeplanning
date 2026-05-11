import { describe, expect, it } from 'vitest';
import type { ShoppingItem } from '../types/item';
import type { DayMapData, HallDefinition } from '../types/map';
import { resolveMapRoutePoints } from './mapRoutePoints';

const makeItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: 'item-1',
  circle: 'Circle',
  eventDate: 'Day1',
  block: 'A',
  number: '1a',
  title: '',
  price: 0,
  purchaseStatus: 'None',
  quantity: 1,
  remarks: '',
  url: '',
  priorityLevel: 'none',
  ...overrides,
});

const makeMap = (): DayMapData => ({
  sheetName: 'Day1',
  rows: 30,
  cols: 30,
  maxRow: 30,
  maxCol: 30,
  cells: [],
  mergedCells: [],
  blocks: [
    {
      name: 'A',
      startRow: 1,
      startCol: 1,
      endRow: 10,
      endCol: 10,
      numberCells: [
        { row: 2, col: 2, value: 1 },
        { row: 3, col: 2, value: 2 },
      ],
    },
    {
      name: 'A',
      startRow: 11,
      startCol: 1,
      endRow: 20,
      endCol: 10,
      numberCells: [{ row: 12, col: 2, value: 1 }],
    },
    {
      name: 'b',
      startRow: 1,
      startCol: 11,
      endRow: 10,
      endCol: 20,
      numberCells: [{ row: 2, col: 12, value: 1 }],
    },
    {
      name: 'B',
      startRow: 11,
      startCol: 11,
      endRow: 20,
      endCol: 20,
      numberCells: [{ row: 12, col: 12, value: 1 }],
    },
  ],
});

const halls: HallDefinition[] = [
  {
    id: 'hall-a',
    name: 'Hall A',
    vertices: [
      { row: 0, col: 0 },
      { row: 0, col: 10 },
      { row: 10, col: 10 },
      { row: 10, col: 0 },
    ],
    blockNames: ['A'],
  },
  {
    id: 'hall-a2',
    name: 'Hall A2',
    vertices: [
      { row: 10, col: 0 },
      { row: 10, col: 10 },
      { row: 20, col: 10 },
      { row: 20, col: 0 },
    ],
    blockNames: ['A'],
  },
  {
    id: 'manual-hall',
    name: 'Manual Hall',
    vertices: [
      { row: 20, col: 20 },
      { row: 20, col: 25 },
      { row: 25, col: 25 },
      { row: 25, col: 20 },
    ],
  },
];

describe('resolveMapRoutePoints', () => {
  it('keeps item id order, route snapshot order, metadata, and labels', () => {
    const items = [
      makeItem({ id: 'a-2', circle: 'Circle 2', number: '2a' }),
      makeItem({ id: 'a-1', circle: 'Circle 1', number: '1a' }),
    ];

    const result = resolveMapRoutePoints({
      itemIds: ['a-1', 'a-2'],
      items,
      mapData: makeMap(),
      hallDefinitions: halls,
      dayName: ' Day1 ',
      selectedHallId: 'hall-a',
      orderOffset: 5,
    });

    expect(result.missingItemIds).toEqual([]);
    expect(result.routePoints.map((point) => point.itemId)).toEqual(['a-1', 'a-2']);
    expect(result.routePoints.map((point) => point.order)).toEqual([5, 6]);
    expect(result.routePoints[0]).toMatchObject({
      row: 2,
      col: 2,
      hallId: 'hall-a',
      anchorLabel: '6. Circle 1 / A-1a の後',
    });
  });

  it('treats all-hall duplicate route cell candidates as hall unresolved', () => {
    const result = resolveMapRoutePoints({
      itemIds: ['item-1'],
      items: [makeItem({ id: 'item-1', block: 'A', number: '1a', priorityLevel: 'priority' })],
      mapData: makeMap(),
      hallDefinitions: halls,
      dayName: 'Day1',
      selectedHallId: 'all',
    });

    expect(result.routePoints[0].hallId).toBeNull();
    expect(result.routePoints[0].groupKey).toBe('undefined:priority');
  });

  it('uses selected hall to disambiguate duplicate route cell candidates', () => {
    const result = resolveMapRoutePoints({
      itemIds: ['item-1'],
      items: [makeItem({ id: 'item-1', block: 'A', number: '1a' })],
      mapData: makeMap(),
      hallDefinitions: halls,
      dayName: 'Day1',
      selectedHallId: 'hall-a2',
    });

    expect(result.routePoints[0].hallId).toBe('hall-a2');
  });

  it('keeps valid manual hall as the group and excludes mismatched manual hall in selected hall mode', () => {
    const mapData = makeMap();
    const manualItem = makeItem({
      id: 'manual',
      manualHallId: 'manual-hall',
      priorityLevel: 'highest',
    });

    expect(
      resolveMapRoutePoints({
        itemIds: ['manual'],
        items: [manualItem],
        mapData,
        hallDefinitions: halls,
        dayName: 'Day1',
        selectedHallId: 'all',
        respectManualHallMismatch: true,
      }).routePoints[0],
    ).toMatchObject({ hallId: 'manual-hall', groupKey: 'manual-hall:highest' });

    const selectedHallResult = resolveMapRoutePoints({
      itemIds: ['manual'],
      items: [manualItem],
      mapData,
      hallDefinitions: halls,
      dayName: 'Day1',
      selectedHallId: 'hall-a',
      respectManualHallMismatch: true,
    });

    expect(selectedHallResult.routePoints).toEqual([]);
    expect(selectedHallResult.missingItemIds).toEqual(['manual']);
  });

  it('requires the adopted number cell to exist in the supplied map data when requested', () => {
    const strictMap: DayMapData = {
      ...makeMap(),
      blocks: makeMap().blocks.map((block) =>
        block.name === 'A' ? { ...block, numberCells: [] } : block,
      ),
    };

    const result = resolveMapRoutePoints({
      itemIds: ['item-1'],
      items: [makeItem({ id: 'item-1', block: 'A', number: '1a' })],
      mapData: strictMap,
      hallDefinitions: halls,
      dayName: 'Day1',
      selectedHallId: 'hall-a',
      requireCellInMap: true,
    });

    expect(result.routePoints).toEqual([]);
    expect(result.missingItemIds).toEqual(['item-1']);
  });

  it('does not adopt ambiguous case-insensitive block matches', () => {
    const mapData: DayMapData = {
      ...makeMap(),
      blocks: [
        {
          name: 'Block',
          startRow: 1,
          startCol: 1,
          endRow: 5,
          endCol: 5,
          numberCells: [{ row: 2, col: 2, value: 1 }],
        },
        {
          name: 'block',
          startRow: 6,
          startCol: 1,
          endRow: 10,
          endCol: 5,
          numberCells: [{ row: 7, col: 2, value: 1 }],
        },
      ],
    };

    const result = resolveMapRoutePoints({
      itemIds: ['item-b'],
      items: [makeItem({ id: 'item-b', block: 'BLOCK', number: '1a' })],
      mapData,
      hallDefinitions: halls,
      dayName: 'Day1',
    });

    expect(result.routePoints).toEqual([]);
    expect(result.missingItemIds).toEqual(['item-b']);
  });
});
