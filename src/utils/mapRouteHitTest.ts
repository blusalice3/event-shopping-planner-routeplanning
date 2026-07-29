import type { RouteSegment } from "../types/map";
import type { MapRoutePoint } from "./mapRoutePoints";

export type MapRouteHitResult =
  | {
      type: "marker";
      itemId: string;
      order: number;
      duplicateCandidates: Array<{ itemId: string; order: number }>;
    }
  | {
      type: "line";
      fromItemId: string;
      fromOrder?: number;
      segment: RouteSegment;
    };

export interface HitTestMapRouteParams {
  mapX: number;
  mapY: number;
  cellSize: number;
  routePoints: MapRoutePoint[];
  routeSegments: RouteSegment[];
  markerRadiusPx?: number;
  lineThresholdPx?: number;
}

const distanceToSegment = (
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(
    0,
    Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

export function hitTestMapRoute(
  params: HitTestMapRouteParams,
): MapRouteHitResult | null {
  const markerRadiusPx =
    params.markerRadiusPx ?? Math.max(12, params.cellSize * 0.35);
  const lineThresholdPx =
    params.lineThresholdPx ?? Math.max(8, params.cellSize * 0.25);

  const pointsByCell = new Map<string, MapRoutePoint[]>();
  params.routePoints.forEach((point) => {
    const key = `${point.row}-${point.col}`;
    const current = pointsByCell.get(key) ?? [];
    current.push(point);
    pointsByCell.set(key, current);
  });

  for (const candidates of pointsByCell.values()) {
    const point = candidates[0];
    const cx = (point.col - 0.5) * params.cellSize;
    const cy = (point.row - 0.5) * params.cellSize;
    if (Math.hypot(params.mapX - cx, params.mapY - cy) <= markerRadiusPx) {
      const sortedCandidates = [...candidates].sort(
        (a, b) => a.order - b.order,
      );
      return {
        type: "marker",
        itemId: sortedCandidates[0].itemId,
        order: sortedCandidates[0].order,
        duplicateCandidates: sortedCandidates.map((candidate) => ({
          itemId: candidate.itemId,
          order: candidate.order,
        })),
      };
    }
  }

  let best: {
    distance: number;
    segmentIndex: number;
    segment: RouteSegment;
  } | null = null;

  for (
    let segmentIndex = 0;
    segmentIndex < params.routeSegments.length;
    segmentIndex += 1
  ) {
    const segment = params.routeSegments[segmentIndex];
    if (!segment.fromItemId || segment.path.length < 2) continue;
    for (let i = 0; i < segment.path.length - 1; i += 1) {
      const a = segment.path[i];
      const b = segment.path[i + 1];
      const distance = distanceToSegment(
        params.mapX,
        params.mapY,
        (a.col - 0.5) * params.cellSize,
        (a.row - 0.5) * params.cellSize,
        (b.col - 0.5) * params.cellSize,
        (b.row - 0.5) * params.cellSize,
      );
      if (distance > lineThresholdPx) continue;
      if (!best) {
        best = { distance, segmentIndex, segment };
        continue;
      }
      const bestOrder = best.segment.fromOrder ?? Number.MAX_SAFE_INTEGER;
      const currentOrder = segment.fromOrder ?? Number.MAX_SAFE_INTEGER;
      if (
        distance < best.distance - 0.001 ||
        (Math.abs(distance - best.distance) < 0.001 &&
          (currentOrder < bestOrder ||
            (currentOrder === bestOrder && segmentIndex < best.segmentIndex)))
      ) {
        best = { distance, segmentIndex, segment };
      }
    }
  }

  if (!best || !best.segment.fromItemId) return null;
  return {
    type: "line",
    fromItemId: best.segment.fromItemId,
    fromOrder: best.segment.fromOrder,
    segment: best.segment,
  };
}
