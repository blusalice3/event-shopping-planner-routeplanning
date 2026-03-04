import { describe, expect, it } from 'vitest';
import { findPath, generateRouteSegments, simplifyPath } from './pathfinding';
import { DayMapData, CellData } from '../types';

const createMapData = (
  maxRow: number,
  maxCol: number,
  cells: Array<Partial<CellData> & Pick<CellData, 'row' | 'col'>>,
): DayMapData => ({
  maxRow,
  maxCol,
  cells: cells.map((cell) => ({
    row: cell.row,
    col: cell.col,
    value: cell.value ?? null,
    backgroundColor: cell.backgroundColor ?? null,
    borders: cell.borders ?? {
      top: null,
      right: null,
      bottom: null,
      left: null,
    },
  })),
  mergedCells: [],
  blocks: [],
});

const isAdjacentOrSame = (a: { row: number; col: number }, b: { row: number; col: number }) =>
  Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;

describe('pathfinding utilities', () => {
  it('finds a valid path in an open grid', () => {
    const mapData = createMapData(3, 3, []);
    const path = findPath(mapData, 1, 1, 3, 3);

    expect(path[0]).toEqual({ row: 1, col: 1 });
    expect(path[path.length - 1]).toEqual({ row: 3, col: 3 });
    expect(path.every((point, i) => i === 0 || isAdjacentOrSame(path[i - 1], point))).toBe(true);
  });

  it('avoids blocked cells when an alternate route exists', () => {
    const mapData = createMapData(3, 3, [{ row: 2, col: 2, value: 100 }]);
    const path = findPath(mapData, 1, 1, 3, 3);

    expect(path).not.toEqual([
      { row: 1, col: 1 },
      { row: 3, col: 3 },
    ]);
    expect(path.some((point) => point.row === 2 && point.col === 2)).toBe(false);
  });

  it('returns fallback start/end when no path can be found', () => {
    const mapData = createMapData(2, 2, [
      { row: 1, col: 2, value: 1 },
      { row: 2, col: 1, value: 1 },
    ]);

    const path = findPath(mapData, 1, 1, 2, 2);
    expect(path).toEqual([
      { row: 1, col: 1 },
      { row: 2, col: 2 },
    ]);
  });

  it('builds route segments between consecutive visit points', () => {
    const mapData = createMapData(3, 3, []);
    const visitPoints = [
      { row: 1, col: 1, priorityLevel: 'highest' as const },
      { row: 1, col: 3 },
      { row: 3, col: 3, priorityLevel: 'priority' as const },
    ];

    const segments = generateRouteSegments(mapData, visitPoints);

    expect(segments).toHaveLength(2);
    expect(segments[0].fromRow).toBe(1);
    expect(segments[0].fromCol).toBe(1);
    expect(segments[0].toRow).toBe(1);
    expect(segments[0].toCol).toBe(3);
    expect(segments[0].fromPriority).toBe('highest');
    expect(segments[0].toPriority).toBe('none');
    expect(segments[1].fromPriority).toBe('none');
    expect(segments[1].toPriority).toBe('priority');
  });

  it('simplifies a mostly straight path', () => {
    const path = [
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 1, col: 3 },
      { row: 1, col: 4 },
      { row: 1, col: 5 },
    ];

    expect(simplifyPath(path)).toEqual([
      { row: 1, col: 1 },
      { row: 1, col: 5 },
    ]);
  });

  it('keeps bend points when tolerance is strict', () => {
    const path = [
      { row: 1, col: 1 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
      { row: 2, col: 3 },
      { row: 3, col: 3 },
    ];

    const simplified = simplifyPath(path, 0);
    expect(simplified.length).toBeGreaterThan(2);
    expect(simplifyPath(path, 10)).toEqual([
      { row: 1, col: 1 },
      { row: 3, col: 3 },
    ]);
  });
});
