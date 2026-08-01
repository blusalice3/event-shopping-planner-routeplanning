import type { DayMapData } from "../types/map";
import { generateRouteSegmentsStrict, simplifyPath } from "./pathfinding";

export interface FocusRouteCell {
  row: number;
  col: number;
  key: string;
}

export interface FocusRouteDisplaySegment {
  path: { row: number; col: number }[];
  segmentIndex: number;
}

export interface FocusRouteCalculation {
  segments: FocusRouteDisplaySegment[];
  missingVisitKeys: string[];
  validLocationCount: number;
  unreachable: boolean;
}

export const calculateStrictFocusRoute = (
  mapData: DayMapData | null,
  orderedVisitKeys: string[],
  visitKeyCellMap: ReadonlyMap<string, FocusRouteCell>,
): FocusRouteCalculation => {
  const missingVisitKeys: string[] = [];
  const validVisits: {
    visitKey: string;
    routeIndex: number;
    cell: FocusRouteCell;
  }[] = [];

  orderedVisitKeys.forEach((visitKey, routeIndex) => {
    const cell = visitKeyCellMap.get(visitKey);
    if (!cell) {
      missingVisitKeys.push(visitKey);
      return;
    }
    validVisits.push({ visitKey, routeIndex, cell });
  });

  if (!mapData || validVisits.length < 2) {
    return {
      segments: [],
      missingVisitKeys,
      validLocationCount: validVisits.length,
      unreachable: false,
    };
  }

  const strictResult = generateRouteSegmentsStrict(
    mapData,
    validVisits.map(({ visitKey, routeIndex, cell }) => ({
      row: cell.row,
      col: cell.col,
      itemId: visitKey,
      order: routeIndex,
    })),
  );
  if (!strictResult.ok) {
    return {
      segments: [],
      missingVisitKeys,
      validLocationCount: validVisits.length,
      unreachable: true,
    };
  }

  return {
    segments: strictResult.segments.map((segment, index) => ({
      path: simplifyPath(segment.path),
      segmentIndex:
        segment.fromOrder ?? validVisits[index]?.routeIndex ?? index,
    })),
    missingVisitKeys,
    validLocationCount: validVisits.length,
    unreachable: false,
  };
};
