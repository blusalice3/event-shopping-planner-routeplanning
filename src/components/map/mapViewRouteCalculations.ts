import type {
  DayMapData,
  RoutePathConstraint,
  RouteSegment,
} from "../../types/map";
import type { MapRoutePoint } from "../../utils/mapRoutePoints";
import {
  generateRouteSegments,
  generateRouteSegmentsStrict,
  simplifyPath,
} from "../../utils/pathfinding";

type RouteSegmentsPairParams = {
  displayMapData: DayMapData;
  displayRoutePoints: MapRoutePoint[];
  mapInsertMapData: DayMapData | null;
  mapInsertRoutePoints: MapRoutePoint[];
  mapInsertPathConstraint?: RoutePathConstraint;
  includeDisplayRoute?: boolean;
  includeMapInsertRoute?: boolean;
};

export type RouteSegmentsPair = {
  displayRouteSegments: RouteSegment[];
  mapInsertRouteSegments: RouteSegment[];
};

const simplifyDisplayRouteSegments = (
  segments: RouteSegment[],
): RouteSegment[] =>
  segments.map((segment) => ({
    ...segment,
    path: simplifyPath(segment.path),
  }));

const simplifyStrictRouteSegments = (
  segments: RouteSegment[],
  pathConstraint?: RoutePathConstraint,
): RouteSegment[] | null => {
  const simplifiedSegments = segments
    .map((segment) => ({
      ...segment,
      path: segment.path.map((point) => ({ ...point })),
    }))
    .map((segment) => ({
      ...segment,
      path: simplifyPath(segment.path),
    }));

  if (
    pathConstraint &&
    simplifiedSegments.some(
      (segment) => !pathConstraint.isPathAllowed(segment.path),
    )
  ) {
    return null;
  }

  return simplifiedSegments;
};

export const haveEquivalentRouteGeneratorPoints = (
  displayRoutePoints: MapRoutePoint[],
  mapInsertRoutePoints: MapRoutePoint[],
): boolean =>
  displayRoutePoints.length === mapInsertRoutePoints.length &&
  displayRoutePoints.every((displayPoint, index) => {
    const mapInsertPoint = mapInsertRoutePoints[index];
    return (
      displayPoint.row === mapInsertPoint.row &&
      displayPoint.col === mapInsertPoint.col &&
      displayPoint.priorityLevel === mapInsertPoint.priorityLevel &&
      displayPoint.itemId === mapInsertPoint.itemId &&
      displayPoint.order === mapInsertPoint.order
    );
  });

export const calculateRouteSegmentsPair = ({
  displayMapData,
  displayRoutePoints,
  mapInsertMapData,
  mapInsertRoutePoints,
  mapInsertPathConstraint,
  includeDisplayRoute = true,
  includeMapInsertRoute = true,
}: RouteSegmentsPairParams): RouteSegmentsPair => {
  const calculateDisplayRouteSegments = (): RouteSegment[] => {
    if (!includeDisplayRoute || displayRoutePoints.length < 2) return [];
    return simplifyDisplayRouteSegments(
      generateRouteSegments(displayMapData, displayRoutePoints),
    );
  };

  const calculateMapInsertRouteSegments = (): RouteSegment[] => {
    if (
      !includeMapInsertRoute ||
      mapInsertRoutePoints.length < 2 ||
      !mapInsertMapData
    )
      return [];
    const result = generateRouteSegmentsStrict(
      mapInsertMapData,
      mapInsertRoutePoints,
      {
        pathConstraint: mapInsertPathConstraint,
      },
    );
    if (!result.ok) return [];
    return (
      simplifyStrictRouteSegments(result.segments, mapInsertPathConstraint) ??
      []
    );
  };

  const canReuseStrictResult =
    includeDisplayRoute &&
    includeMapInsertRoute &&
    displayRoutePoints.length >= 2 &&
    mapInsertRoutePoints.length >= 2 &&
    mapInsertMapData !== null &&
    displayMapData === mapInsertMapData &&
    mapInsertPathConstraint === undefined &&
    haveEquivalentRouteGeneratorPoints(
      displayRoutePoints,
      mapInsertRoutePoints,
    );

  // 到達可能な同一入力では通常版とstrict版のA*結果が同じになるため、
  // strict版だけを実行する。fallback時は従来どおり通常版を再計算する。
  if (!canReuseStrictResult) {
    return {
      displayRouteSegments: calculateDisplayRouteSegments(),
      mapInsertRouteSegments: calculateMapInsertRouteSegments(),
    };
  }

  const sharedStrictResult = generateRouteSegmentsStrict(
    mapInsertMapData,
    mapInsertRoutePoints,
    { pathConstraint: undefined },
  );
  if (!sharedStrictResult.ok) {
    return {
      displayRouteSegments: calculateDisplayRouteSegments(),
      mapInsertRouteSegments: [],
    };
  }

  const mapInsertRouteSegments =
    simplifyStrictRouteSegments(sharedStrictResult.segments) ?? [];

  return {
    displayRouteSegments: simplifyDisplayRouteSegments(
      sharedStrictResult.segments,
    ),
    mapInsertRouteSegments,
  };
};

const cloneDayMapDataForRouteInsertSnapshot = (
  mapData: DayMapData,
): DayMapData => ({
  ...mapData,
  cells: mapData.cells.map((cell) => ({
    ...cell,
    borders: cell.borders ? { ...cell.borders } : cell.borders,
  })),
  blocks: mapData.blocks.map((block) => ({
    ...block,
    numberCells: block.numberCells.map((numberCell) => ({ ...numberCell })),
    nameCells: block.nameCells?.map((nameCell) => ({ ...nameCell })),
    cellGroups: block.cellGroups?.map((group) => ({
      ...group,
      cells: group.cells?.map((cell) => ({ ...cell })),
    })),
  })),
  mergedCells: mapData.mergedCells.map((merge) => ({ ...merge })),
});

export const createRouteInsertMapSnapshots = (
  canvasMapData: DayMapData,
  routeInsertMissMapData: DayMapData,
): Pick<
  {
    canvasMapDataAtStart: DayMapData;
    routeInsertMissMapDataAtStart: DayMapData;
  },
  "canvasMapDataAtStart" | "routeInsertMissMapDataAtStart"
> => {
  const canvasMapDataAtStart =
    cloneDayMapDataForRouteInsertSnapshot(canvasMapData);
  return {
    canvasMapDataAtStart,
    // 同じ読み取り専用スナップショットを2用途で使える場合は複製を重ねない。
    routeInsertMissMapDataAtStart:
      canvasMapData === routeInsertMissMapData
        ? canvasMapDataAtStart
        : cloneDayMapDataForRouteInsertSnapshot(routeInsertMissMapData),
  };
};
