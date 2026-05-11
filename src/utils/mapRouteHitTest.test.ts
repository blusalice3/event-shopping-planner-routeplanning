import { describe, expect, it } from 'vitest';
import type { RouteSegment } from '../types/map';
import type { MapRoutePoint } from './mapRoutePoints';
import { hitTestMapRoute } from './mapRouteHitTest';

const point = (itemId: string, row: number, col: number, order: number): MapRoutePoint => ({
  itemId,
  row,
  col,
  order,
  priorityLevel: 'none',
  groupKey: null,
  hallId: null,
  anchorLabel: `${order + 1}. ${itemId} after`,
});

describe('hitTestMapRoute', () => {
  it('prefers marker hits and returns duplicate candidates for the same cell', () => {
    const hit = hitTestMapRoute({
      mapX: 15,
      mapY: 15,
      cellSize: 10,
      routePoints: [point('a', 2, 2, 1), point('b', 2, 2, 2)],
      routeSegments: [],
    });

    expect(hit).toMatchObject({
      type: 'marker',
      itemId: 'a',
      duplicateCandidates: [
        { itemId: 'a', order: 1 },
        { itemId: 'b', order: 2 },
      ],
    });
  });

  it('chooses the nearest line hit and exposes the segment anchor', () => {
    const segment: RouteSegment = {
      fromRow: 1,
      fromCol: 1,
      toRow: 1,
      toCol: 4,
      path: [
        { row: 1, col: 1 },
        { row: 1, col: 4 },
      ],
      fromItemId: 'a',
      fromOrder: 0,
    };

    const hit = hitTestMapRoute({
      mapX: 20,
      mapY: 5,
      cellSize: 10,
      routePoints: [],
      routeSegments: [segment],
    });

    expect(hit).toMatchObject({ type: 'line', fromItemId: 'a', segment });
  });
});
