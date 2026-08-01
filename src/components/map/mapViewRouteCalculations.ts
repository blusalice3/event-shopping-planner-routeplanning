import type {
  DayMapData,
  RoutePathConstraint,
  RouteSegment,
} from "../../types/map";
import type { MapRoutePoint } from "../../utils/mapRoutePoints";
import {
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
  displayRouteState: "idle" | "normal" | "unreachable";
};

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
  const calculateDisplayRoute = (): Pick<
    RouteSegmentsPair,
    "displayRouteSegments" | "displayRouteState"
  > => {
    if (!includeDisplayRoute) {
      return { displayRouteSegments: [], displayRouteState: "idle" };
    }
    if (displayRoutePoints.length < 2) {
      return { displayRouteSegments: [], displayRouteState: "normal" };
    }
    const result = generateRouteSegmentsStrict(
      displayMapData,
      displayRoutePoints,
    );
    if (!result.ok) {
      return {
        displayRouteSegments: [],
        displayRouteState: "unreachable",
      };
    }
    return {
      displayRouteSegments: simplifyStrictRouteSegments(result.segments) ?? [],
      displayRouteState: "normal",
    };
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

  // 同一入力ではstrict版を1回だけ実行し、表示と挿入検証で共有する。
  // 失敗時は部分経路を含めて双方とも描画しない。
  if (!canReuseStrictResult) {
    const displayRoute = calculateDisplayRoute();
    return {
      ...displayRoute,
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
      displayRouteSegments: [],
      mapInsertRouteSegments: [],
      displayRouteState: "unreachable",
    };
  }

  const mapInsertRouteSegments =
    simplifyStrictRouteSegments(sharedStrictResult.segments) ?? [];

  return {
    displayRouteSegments:
      simplifyStrictRouteSegments(sharedStrictResult.segments) ?? [],
    mapInsertRouteSegments,
    displayRouteState: "normal",
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
