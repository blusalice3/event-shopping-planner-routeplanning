import { describe, expect, it } from 'vitest';
import { findPath, generateRouteSegments, simplifyPath } from './pathfinding';
import { DayMapData, CellData } from '../types/map';

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

// Orthogonality check helper: each consecutive segment must share row or col.
function assertOrthogonal(path: { row: number; col: number }[]) {
  for (let i = 1; i < path.length; i++) {
    const sameRow = Math.abs(path[i].row - path[i - 1].row) < 0.01;
    const sameCol = Math.abs(path[i].col - path[i - 1].col) < 0.01;
    expect(sameRow || sameCol, `Segment ${i - 1}->${i} is diagonal: (${path[i - 1].row},${path[i - 1].col}) -> (${path[i].row},${path[i].col})`).toBe(true);
  }
}

describe('pathfinding utilities', () => {
  it('finds a valid orthogonal path in an open grid', () => {
    const mapData = createMapData(3, 3, []);
    const path = findPath(mapData, 1, 1, 3, 3);

    // The sub-cell grid and margin can return decimal coordinates.
    // Start and end points are decimal coordinates at cell centers.
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path[0].row).toBeCloseTo(1, 1);
    expect(path[0].col).toBeCloseTo(1, 1);
    expect(path[path.length - 1].row).toBeCloseTo(3, 1);
    expect(path[path.length - 1].col).toBeCloseTo(3, 1);

    assertOrthogonal(path);
  });

  it('avoids blocked cells with orthogonal path', () => {
    const mapData = createMapData(3, 3, [{ row: 2, col: 2, value: 100 }]);
    const path = findPath(mapData, 1, 1, 3, 3);

    // Confirm the path does not pass through the blocked cell center (2,2).
    expect(path.length).toBeGreaterThanOrEqual(2);
    const passesBlockedCenter = path.some(
      (point) => Math.abs(point.row - 2) < 0.2 && Math.abs(point.col - 2) < 0.2,
    );
    expect(passesBlockedCenter).toBe(false);

    assertOrthogonal(path);
  });

  it('returns fallback L-shaped path when no path can be found', () => {
    const mapData = createMapData(2, 2, [
      { row: 1, col: 2, value: 1 },
      { row: 2, col: 1, value: 1 },
    ]);

    const path = findPath(mapData, 1, 1, 2, 2);
    // Fallback path: L shape (start -> midpoint -> end).
    expect(path.length).toBe(3);
    expect(path[0].row).toBeCloseTo(1, 1);
    expect(path[0].col).toBeCloseTo(1, 1);
    expect(path[path.length - 1].row).toBeCloseTo(2, 1);
    expect(path[path.length - 1].col).toBeCloseTo(2, 1);

    assertOrthogonal(path);
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

    // Check all route segments are orthogonal.
    for (const seg of segments) {
      assertOrthogonal(seg.path);
    }
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

  it('preserves orthogonal bend points even with high tolerance', () => {
    const path = [
      { row: 1, col: 1 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
      { row: 2, col: 3 },
      { row: 3, col: 3 },
    ];

    // Orthogonal paths are returned as-is by the orthogonality guard.
    const simplified = simplifyPath(path, 0);
    expect(simplified.length).toBeGreaterThan(2);

    // Even with a high tolerance, the L-shaped path must not collapse diagonally.
    const highTol = simplifyPath(path, 10);
    assertOrthogonal(highTol);
    // Bend points are preserved, while the collinear midpoint (2,2) is removed.
    expect(highTol).toEqual([
      { row: 1, col: 1 },
      { row: 2, col: 1 },
      { row: 2, col: 3 },
      { row: 3, col: 3 },
    ]);
  });

  it('produces straight path with no turns for same-row points', () => {
    const mapData = createMapData(3, 5, []);
    const path = findPath(mapData, 2, 1, 2, 5);

    // Same-row points need no turn.
    expect(path.length).toBe(2);
    expect(path[0].row).toBeCloseTo(path[1].row, 1);

    assertOrthogonal(path);
  });

  it('produces straight path with no turns for same-column points', () => {
    const mapData = createMapData(5, 3, []);
    const path = findPath(mapData, 1, 2, 5, 2);

    // Same-column points need no turn.
    expect(path.length).toBe(2);
    expect(path[0].col).toBeCloseTo(path[1].col, 1);

    assertOrthogonal(path);
  });
});
