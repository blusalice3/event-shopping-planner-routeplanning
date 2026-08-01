import React, { useRef, useEffect, useCallback, useMemo } from "react";
import {
  DayMapData,
  CellData,
  MergedCellInfo,
  HallDefinition,
  BlockDefinition,
  NumberCellOutlineStyle,
  MIN_ZOOM,
  MAX_ZOOM,
} from "../types/map";
import { ShoppingItem } from "../types/item";
import {
  FocusMapCenteringMode,
  FocusMapViewportRestoreRequest,
  FocusMapViewportSnapshot,
} from "../types/focus";
import {
  rotatePointAroundCenter,
  useCanvasViewport,
} from "../features/map/canvas/useCanvasViewport";
import { extractNumberFromItemNumber } from "../utils/xlsxMapParser";
import { findRouteLookupNumberCell } from "../utils/mapRoutingSignature";
import { findPath, simplifyPath } from "../utils/pathfinding";
import {
  buildSpaceKey,
  normalizeBaseSpaceNumber,
  normalizeSpaceBlock,
} from "../features/space-navigation/domain/visitIdentity";
import {
  findAllCrossingsIndexed,
  buildCrossingLookup,
  getBridgeParams,
  collectEdgeWithBridges,
  BatchedPathRenderer,
  PixelEdge,
} from "../utils/routeRendering";
import type { RouteDiagnostics } from "../utils/routeDiagnostics";
import RouteDiagnosticsOverlay from "./map/RouteDiagnosticsOverlay";

interface FocusModeMapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  zoomLevel: number;
  selectedHall: HallDefinition | null;
  currentVisitKey: string | null;
  /**
   * When supplied, `currentVisitKey` remains the legacy/display pointer while
   * this key is the official route position. Omitting it preserves the
   * historical single-position behaviour.
   */
  formalCurrentVisitKey?: string | null;
  /** A temporary display target drawn separately from the official position. */
  temporaryVisitKey?: string | null;
  nextVisitKey: string | null;
  prevVisitKey: string | null;
  currentPhase: "normal" | "postponed" | "late";
  formalCurrentPhase?: "normal" | "postponed" | "late";
  selectedHallMode?: string | "follow";
  onZoomChange?: (newZoom: number) => void;
  onCellClick?: (
    blockName: string,
    number: number,
    matchingItems: ShoppingItem[],
  ) => void;
  appZoomLevel?: number;
  hallDefinitions?: HallDefinition[];
  rotationAngle?: number;
  onRotationAngleChange?: (angle: number) => void;
  allVisitKeys?: string[];
  currentPhaseIndex?: number;
  formalCurrentPhaseIndex?: number;
  currentRouteIndex?: number;
  formalCurrentRouteIndex?: number;
  recenterRevision?: number;
  onViewportSnapshotChange?: (snapshot: FocusMapViewportSnapshot) => void;
  viewportRestoreRequest?: FocusMapViewportRestoreRequest | null;
  onViewportRestoreApplied?: (revision: number) => void;
  numberCellOutlineStyle?: NumberCellOutlineStyle;
  mapCenteringMode?: FocusMapCenteringMode;
  // ルート再計算を避けるため、FocusMode 側で事前計算したデータを受け取る。
  precomputedVisitKeyCellMap?: Map<
    string,
    { row: number; col: number; key: string }
  >;
  precomputedAllVisitCellCoords?: { row: number; col: number; key: string }[];
  precomputedRouteSegments?: {
    path: { row: number; col: number }[];
    segmentIndex: number;
  }[];
  routeDiagnostics?: RouteDiagnostics;
}

const BASE_CELL_SIZE = 28;
const SCROLL_MARGIN = 5;
const FILLED_SCROLL_MARGIN = 25;

export interface FocusMapPositionKeys {
  officialVisitKey: string | null;
  temporaryVisitKey: string | null;
  centerVisitKey: string | null;
}

export interface FocusMapCellPositionFlags {
  isOfficialPosition: boolean;
  isTemporaryPosition: boolean;
}

export const FOCUS_MAP_OFFICIAL_MARKER_STYLE = {
  color: "rgba(255, 109, 0, 0.8)",
  lineStyle: "solid",
  pin: "\u{1F4CD}",
} as const;

export const FOCUS_MAP_TEMPORARY_MARKER_STYLE = {
  outerColor: "rgba(29, 78, 216, 0.95)",
  innerColor: "rgba(96, 165, 250, 0.95)",
  lineStyle: "dashed",
  frameCount: 2,
  label: "一時",
} as const;

export type FocusMapRouteProgressState = "visited" | "current" | "upcoming";

export const resolveFocusMapPositionKeys = ({
  currentVisitKey,
  formalCurrentVisitKey,
  temporaryVisitKey,
}: {
  currentVisitKey: string | null;
  formalCurrentVisitKey?: string | null;
  temporaryVisitKey?: string | null;
}): FocusMapPositionKeys => {
  const officialVisitKey =
    formalCurrentVisitKey === undefined
      ? currentVisitKey
      : formalCurrentVisitKey;
  const resolvedTemporaryVisitKey = temporaryVisitKey ?? null;
  return {
    officialVisitKey,
    temporaryVisitKey: resolvedTemporaryVisitKey,
    centerVisitKey: resolvedTemporaryVisitKey ?? officialVisitKey,
  };
};

export const resolveFocusMapCellPositionFlags = (
  visitKeys: ReadonlySet<string>,
  positionKeys: Pick<
    FocusMapPositionKeys,
    "officialVisitKey" | "temporaryVisitKey"
  >,
): FocusMapCellPositionFlags => ({
  isOfficialPosition: Boolean(
    positionKeys.officialVisitKey &&
    visitKeys.has(positionKeys.officialVisitKey),
  ),
  isTemporaryPosition: Boolean(
    positionKeys.temporaryVisitKey &&
    visitKeys.has(positionKeys.temporaryVisitKey),
  ),
});

export const resolveFocusMapRouteProgressState = (
  segmentIndex: number,
  formalRouteIndex: number,
): FocusMapRouteProgressState => {
  if (segmentIndex < formalRouteIndex - 1) return "visited";
  if (segmentIndex === formalRouteIndex - 1) return "current";
  return "upcoming";
};

const hasCellInputValue = (value: string | number | null): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

const getVisitKey = (item: ShoppingItem): string => {
  return `${item.eventDate.trim()}-${buildSpaceKey(item.block, item.number)}`;
};

type RgbColor = { r: number; g: number; b: number };

const parseCssColorToRgb = (color: string): RgbColor | null => {
  const normalized = color.trim().toLowerCase();
  if (normalized === "white") return { r: 255, g: 255, b: 255 };
  if (normalized === "black") return { r: 0, g: 0, b: 0 };

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = normalized.match(
    /^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\)$/,
  );
  if (!rgbMatch) return null;

  return {
    r: Math.min(255, Math.max(0, parseInt(rgbMatch[1], 10))),
    g: Math.min(255, Math.max(0, parseInt(rgbMatch[2], 10))),
    b: Math.min(255, Math.max(0, parseInt(rgbMatch[3], 10))),
  };
};

const isWhiteLikeColor = (color: string | null | undefined): boolean => {
  if (!color) return false;
  const rgb = parseCssColorToRgb(color);
  if (!rgb) return false;
  return rgb.r >= 245 && rgb.g >= 245 && rgb.b >= 245;
};

const isDarkLikeColor = (color: string): boolean => {
  const rgb = parseCssColorToRgb(color);
  if (!rgb) return false;
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return luminance <= 64;
};

const resolveMapTextColorForTheme = (
  color: string | null | undefined,
  isDarkMode: boolean,
  fallback = "#333333",
): string => {
  const baseColor = color?.trim() || fallback;
  if (!isDarkMode) return baseColor;
  if (isWhiteLikeColor(baseColor)) return baseColor;
  return isDarkLikeColor(baseColor) ? "#FFFFFF" : baseColor;
};

const FocusModeMapCanvas: React.FC<FocusModeMapCanvasProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds: _executeModeItemIds,
  zoomLevel,
  selectedHall,
  currentVisitKey,
  formalCurrentVisitKey,
  temporaryVisitKey,
  nextVisitKey,
  prevVisitKey,
  currentPhase,
  formalCurrentPhase,
  selectedHallMode = "follow",
  onZoomChange,
  onCellClick,
  appZoomLevel = 100,
  hallDefinitions,
  rotationAngle = 0,
  onRotationAngleChange,
  allVisitKeys = [],
  currentPhaseIndex = 0,
  formalCurrentPhaseIndex,
  currentRouteIndex = currentPhaseIndex,
  formalCurrentRouteIndex,
  recenterRevision = 0,
  onViewportSnapshotChange,
  viewportRestoreRequest,
  onViewportRestoreApplied,
  numberCellOutlineStyle = "rounded",
  mapCenteringMode = "prevToCurrent",
  precomputedVisitKeyCellMap,
  precomputedAllVisitCellCoords,
  precomputedRouteSegments,
  routeDiagnostics,
}) => {
  const positionKeys = useMemo(
    () =>
      resolveFocusMapPositionKeys({
        currentVisitKey,
        formalCurrentVisitKey,
        temporaryVisitKey,
      }),
    [currentVisitKey, formalCurrentVisitKey, temporaryVisitKey],
  );
  const resolvedFormalPhase = formalCurrentPhase ?? currentPhase;
  const resolvedFormalPhaseIndex = formalCurrentPhaseIndex ?? currentPhaseIndex;
  const resolvedFormalRouteIndex = formalCurrentRouteIndex ?? currentRouteIndex;
  const {
    activeTouchesRef,
    canvasRef,
    cellSize,
    containerRef,
    dpr,
    dragStartOffsetRef,
    dragStartRef,
    drawCanvasRef,
    isDragging,
    isDraggingRef,
    isPinchGestureRef,
    isRotationInteracting,
    mapCenterX,
    mapCenterY,
    offset,
    offsetRef,
    rafPendingRef,
    rotationRadians,
    setIsDragging,
    setOffset,
    setOffsetState,
    suppressClickUntilRef,
    toMapCoordinates,
    zoomLevelRef,
  } = useCanvasViewport({
    mapMaxCol: mapData.maxCol,
    mapMaxRow: mapData.maxRow,
    zoomLevel,
    rotationAngle,
    baseCellSize: BASE_CELL_SIZE,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    onZoomChange,
    onRotationAngleChange,
  });
  useEffect(() => {
    onViewportSnapshotChange?.({
      offsetX: offset.x,
      offsetY: offset.y,
      zoomLevel,
      rotationAngle,
    });
  }, [offset.x, offset.y, onViewportSnapshotChange, rotationAngle, zoomLevel]);
  const appScale = Math.max(0.01, appZoomLevel / 100);
  const isDarkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;

  const prevSelectedHallRef = useRef<HallDefinition | null>(null);

  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  const mergedCellsMap = useMemo(() => {
    const map = new Map<string, MergedCellInfo>();
    mapData.mergedCells.forEach((merge) => {
      map.set(`${merge.startRow}-${merge.startCol}`, merge);
    });
    return map;
  }, [mapData.mergedCells]);

  const dayName = useMemo(() => {
    const dayMatch = mapName.match(/^(.+)マップ$/);
    return dayMatch ? dayMatch[1].trim() : "";
  }, [mapName]);

  const cellStates = useMemo(() => {
    const states = new Map<
      string,
      {
        hasItems: boolean;
        items: ShoppingItem[];
        visitKeys: Set<string>;
        isCurrentPosition: boolean;
        isTemporaryPosition: boolean;
        isNextDestination: boolean;
        isPreviousPosition: boolean;
        allNone: boolean;
        allProcessed: boolean;
        hasPostponed: boolean;
        hasLate: boolean;
        allPostponed: boolean;
        allLate: boolean;
        isVisited: boolean;
      }
    >();

    if (!dayName) return states;

    items.forEach((item) => {
      const itemEventDate = item.eventDate?.trim() || "";
      if (itemEventDate !== dayName) return;

      const itemBlockName = normalizeSpaceBlock(item.block || "");
      let block = mapData.blocks.find(
        (candidate) => normalizeSpaceBlock(candidate.name) === itemBlockName,
      );
      if (!block) {
        const candidates = mapData.blocks.filter(
          (candidate) =>
            normalizeSpaceBlock(candidate.name).toLowerCase() ===
            itemBlockName.toLowerCase(),
        );
        if (candidates.length === 1) {
          block = candidates[0];
        }
      }
      if (!block) return;

      const numStr = extractNumberFromItemNumber(
        normalizeBaseSpaceNumber(item.number),
      );
      if (!numStr) return;

      const num = parseInt(numStr, 10);
      const cell = findRouteLookupNumberCell(block, num);
      if (!cell) return;

      const key = `${cell.row}-${cell.col}`;
      const visitKey = getVisitKey(item);
      const existing = states.get(key) || {
        hasItems: false,
        items: [],
        visitKeys: new Set<string>(),
        isCurrentPosition: false,
        isTemporaryPosition: false,
        isNextDestination: false,
        isPreviousPosition: false,
        allNone: true,
        allProcessed: true,
        hasPostponed: false,
        hasLate: false,
        allPostponed: true,
        allLate: true,
        isVisited: false,
      };

      existing.hasItems = true;
      existing.items.push(item);
      existing.visitKeys.add(visitKey);

      if (item.purchaseStatus === "None") {
        existing.allProcessed = false;
      } else {
        existing.allNone = false;
      }
      if (item.purchaseStatus === "Postpone") {
        existing.hasPostponed = true;
      } else {
        existing.allPostponed = false;
      }
      if (item.purchaseStatus === "Late") {
        existing.hasLate = true;
      } else {
        existing.allLate = false;
      }

      states.set(key, existing);
    });

    states.forEach((state, _key) => {
      const hasFinalStatus = state.items.some(
        (item) =>
          item.purchaseStatus === "Purchased" ||
          item.purchaseStatus === "SoldOut" ||
          item.purchaseStatus === "Absent",
      );
      const onlyPostponedOrLate = state.items.every(
        (item) =>
          item.purchaseStatus === "Postpone" || item.purchaseStatus === "Late",
      );
      state.isVisited =
        !state.allNone &&
        (hasFinalStatus || (!state.allNone && !onlyPostponedOrLate));

      const positionFlags = resolveFocusMapCellPositionFlags(
        state.visitKeys,
        positionKeys,
      );
      state.isCurrentPosition = positionFlags.isOfficialPosition;
      state.isTemporaryPosition = positionFlags.isTemporaryPosition;
      if (nextVisitKey && state.visitKeys.has(nextVisitKey)) {
        state.isNextDestination = true;
      }
      if (prevVisitKey && state.visitKeys.has(prevVisitKey)) {
        state.isPreviousPosition = true;
      }
    });

    return states;
  }, [
    mapData.blocks,
    items,
    dayName,
    positionKeys,
    nextVisitKey,
    prevVisitKey,
  ]);

  const officialCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isCurrentPosition) {
        const [row, col] = key.split("-").map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  const temporaryCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isTemporaryPosition) {
        const [row, col] = key.split("-").map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  // All viewport calculations follow the temporary target while marker and
  // route-progress rendering continue to use the official position.
  const currentCellCoords = temporaryCellCoords ?? officialCellCoords;

  const nextCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isNextDestination) {
        const [row, col] = key.split("-").map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  const prevCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isPreviousPosition) {
        const [row, col] = key.split("-").map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  // セルに表示するラベル文字と色を決定する。
  const cellLabels = useMemo(() => {
    const labels = new Map<
      string,
      {
        text: string;
        bgColor: string;
        textColor: string;
      }
    >();

    cellStates.forEach((state, key) => {
      if (!state.hasItems) return;

      if (state.isCurrentPosition) {
        if (resolvedFormalPhaseIndex === 0) {
          // 各フェーズの最初の訪問セルにはフェーズ別ラベルを表示する。
          if (resolvedFormalPhase === "normal") {
            labels.set(key, {
              text: "始",
              bgColor: "rgba(255,109,0,0.5)",
              textColor: "#FFFFFF",
            });
          } else if (resolvedFormalPhase === "postponed") {
            labels.set(key, {
              text: "後始",
              bgColor: "rgba(156,39,176,0.5)",
              textColor: "#FFFFFF",
            });
          } else {
            labels.set(key, {
              text: "遅始",
              bgColor: "rgba(33,150,243,0.5)",
              textColor: "#FFFFFF",
            });
          }
        } else {
          labels.set(key, {
            text: "\u6B21",
            bgColor: "rgba(255,109,0,0.5)",
            textColor: "#FFFFFF",
          });
        }
      } else if (state.allProcessed && state.allPostponed) {
        labels.set(key, {
          text: "後",
          bgColor: "rgba(156,39,176,0.4)",
          textColor: "rgba(156,39,176,0.9)",
        });
      } else if (state.allProcessed && state.allLate) {
        labels.set(key, {
          text: "遅",
          bgColor: "rgba(33,150,243,0.4)",
          textColor: "rgba(33,150,243,0.9)",
        });
      } else if (state.allProcessed) {
        labels.set(key, {
          text: "済",
          bgColor: "rgba(158,158,158,0.5)",
          textColor: "rgba(76,175,80,0.8)",
        });
      } else if (state.allNone) {
        labels.set(key, {
          text: "\u672A",
          bgColor: "rgba(66,165,245,0.3)",
          textColor: "rgba(33,150,243,0.8)",
        });
      }
    });

    return labels;
  }, [cellStates, resolvedFormalPhaseIndex, resolvedFormalPhase]);

  // 番号セルを高速に判定できるようキャッシュする。
  const numberCellSet = useMemo(() => {
    const set = new Set<string>();
    mapData.blocks.forEach((block) => {
      block.numberCells.forEach((nc) => set.add(`${nc.row}-${nc.col}`));
    });
    return set;
  }, [mapData.blocks]);

  // ルート再計算を避けるため、FocusMode 側で事前計算したデータを使用する。
  const allVisitCellCoords = precomputedAllVisitCellCoords || [];
  const routeSegments = precomputedRouteSegments || [];

  const findHallForCell = useCallback(
    (row: number, col: number): HallDefinition | null => {
      if (!hallDefinitions || hallDefinitions.length === 0) return null;
      for (const hall of hallDefinitions) {
        if (hall.vertices.length < 3) continue;
        let inside = false;
        const vertices = hall.vertices;
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
          const xi = vertices[i].col,
            yi = vertices[i].row;
          const xj = vertices[j].col,
            yj = vertices[j].row;
          if (
            yi > row !== yj > row &&
            col < ((xj - xi) * (row - yi)) / (yj - yi) + xi
          ) {
            inside = !inside;
          }
        }
        if (inside) return hall;
      }
      return null;
    },
    [hallDefinitions],
  );

  const prevInSameHall = useMemo(() => {
    if (!prevCellCoords || !currentCellCoords) return false;
    if (!hallDefinitions || hallDefinitions.length === 0) return true;
    const prevHall = findHallForCell(prevCellCoords.row, prevCellCoords.col);
    const currentHall = findHallForCell(
      currentCellCoords.row,
      currentCellCoords.col,
    );
    if (!prevHall || !currentHall) return false;
    return prevHall.id === currentHall.id;
  }, [prevCellCoords, currentCellCoords, hallDefinitions, findHallForCell]);

  const showPrevRoute = useMemo(() => {
    if (!prevCellCoords || !currentCellCoords) return false;
    if (
      prevCellCoords.row === currentCellCoords.row &&
      prevCellCoords.col === currentCellCoords.col
    )
      return false;
    if (!prevInSameHall) return false;
    return true;
  }, [prevCellCoords, currentCellCoords, prevInSameHall]);

  const routeBoundsAll = useMemo(() => {
    if (!currentCellCoords) return null;

    let minRow = currentCellCoords.row;
    let maxRow = currentCellCoords.row;
    let minCol = currentCellCoords.col;
    let maxCol = currentCellCoords.col;

    if (nextCellCoords) {
      minRow = Math.min(minRow, nextCellCoords.row);
      maxRow = Math.max(maxRow, nextCellCoords.row);
      minCol = Math.min(minCol, nextCellCoords.col);
      maxCol = Math.max(maxCol, nextCellCoords.col);
    }

    if (prevCellCoords && showPrevRoute) {
      minRow = Math.min(minRow, prevCellCoords.row);
      maxRow = Math.max(maxRow, prevCellCoords.row);
      minCol = Math.min(minCol, prevCellCoords.col);
      maxCol = Math.max(maxCol, prevCellCoords.col);
    }

    const margin = 3;
    minRow = Math.max(1, minRow - margin);
    maxRow = maxRow + margin;
    minCol = Math.max(1, minCol - margin);
    maxCol = maxCol + margin;

    return { minRow, maxRow, minCol, maxCol };
  }, [currentCellCoords, nextCellCoords, prevCellCoords, showPrevRoute]);

  const routeBoundsCurrentNext = useMemo(() => {
    if (!currentCellCoords) return null;

    let minRow = currentCellCoords.row;
    let maxRow = currentCellCoords.row;
    let minCol = currentCellCoords.col;
    let maxCol = currentCellCoords.col;

    if (nextCellCoords) {
      minRow = Math.min(minRow, nextCellCoords.row);
      maxRow = Math.max(maxRow, nextCellCoords.row);
      minCol = Math.min(minCol, nextCellCoords.col);
      maxCol = Math.max(maxCol, nextCellCoords.col);
    }

    const margin = 3;
    minRow = Math.max(1, minRow - margin);
    maxRow = maxRow + margin;
    minCol = Math.max(1, minCol - margin);
    maxCol = maxCol + margin;

    return { minRow, maxRow, minCol, maxCol };
  }, [currentCellCoords, nextCellCoords]);

  const calcOptimalZoom = useCallback(
    (
      bounds: {
        minRow: number;
        maxRow: number;
        minCol: number;
        maxCol: number;
      },
      containerWidth: number,
      containerHeight: number,
    ): number => {
      const bWidth = bounds.maxCol - bounds.minCol + 1;
      const bHeight = bounds.maxRow - bounds.minRow + 1;
      const requiredWidthZoom =
        (containerWidth / (bWidth * BASE_CELL_SIZE)) * 100;
      const requiredHeightZoom =
        (containerHeight / (bHeight * BASE_CELL_SIZE)) * 100;
      return Math.min(requiredWidthZoom, requiredHeightZoom, 100);
    },
    [],
  );

  const routeBoundsPrevCurrent = useMemo(() => {
    if (!currentCellCoords) return null;

    let minRow = currentCellCoords.row;
    let maxRow = currentCellCoords.row;
    let minCol = currentCellCoords.col;
    let maxCol = currentCellCoords.col;

    if (prevCellCoords) {
      minRow = Math.min(minRow, prevCellCoords.row);
      maxRow = Math.max(maxRow, prevCellCoords.row);
      minCol = Math.min(minCol, prevCellCoords.col);
      maxCol = Math.max(maxCol, prevCellCoords.col);
    }

    const margin = 3;
    minRow = Math.max(1, minRow - margin);
    maxRow = maxRow + margin;
    minCol = Math.max(1, minCol - margin);
    maxCol = maxCol + margin;

    return { minRow, maxRow, minCol, maxCol };
  }, [currentCellCoords, prevCellCoords]);

  const routeBoundsCurrentOnly = useMemo(() => {
    if (!currentCellCoords) return null;

    const margin = 3;
    return {
      minRow: Math.max(1, currentCellCoords.row - margin),
      maxRow: currentCellCoords.row + margin,
      minCol: Math.max(1, currentCellCoords.col - margin),
      maxCol: currentCellCoords.col + margin,
    };
  }, [currentCellCoords]);

  const effectiveShowPrevRef = useRef<boolean>(true);

  const routeBounds = temporaryCellCoords
    ? routeBoundsCurrentOnly
    : mapCenteringMode === "currentOnly"
      ? routeBoundsCurrentOnly
      : routeBoundsPrevCurrent;

  const prevCenterRequestRef = useRef<string | null>(null);

  const calculateCenteredOffset = useCallback(
    (
      mapX: number,
      mapY: number,
      containerWidth: number,
      containerHeight: number,
      targetCellSize: number,
      angleRad: number,
    ) => {
      const targetCenterX = (mapData.maxCol * targetCellSize) / 2;
      const targetCenterY = (mapData.maxRow * targetCellSize) / 2;
      const rotatedPoint = rotatePointAroundCenter(
        mapX,
        mapY,
        targetCenterX,
        targetCenterY,
        angleRad,
      );
      return {
        x: containerWidth / 2 - rotatedPoint.x,
        y: containerHeight / 2 - rotatedPoint.y,
      };
    },
    [mapData.maxCol, mapData.maxRow],
  );

  useEffect(() => {
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;

    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    if (routeBounds && currentCellCoords) {
      effectiveShowPrevRef.current =
        mapCenteringMode === "prevToCurrent" && showPrevRoute;

      const optimalZoom = calcOptimalZoom(
        routeBounds,
        containerWidth,
        containerHeight,
      );
      const newZoom = Math.max(
        MIN_ZOOM,
        Math.min(MAX_ZOOM, Math.round(optimalZoom)),
      );

      if (onZoomChange) {
        onZoomChange(newZoom);
      }

      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
      const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
      const routeCenterX = (routeCenterCol - 0.5) * newCellSize;
      const routeCenterY = (routeCenterRow - 0.5) * newCellSize;

      setOffset(
        calculateCenteredOffset(
          routeCenterX,
          routeCenterY,
          containerWidth,
          containerHeight,
          newCellSize,
          rotationRadians,
        ),
      );
      return;
    }

    if (selectedHall && selectedHall.vertices.length >= 4) {
      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      const minRow = Math.max(1, Math.min(...rows) - SCROLL_MARGIN);
      const maxRow = Math.max(...rows) + SCROLL_MARGIN;
      const minCol = Math.max(1, Math.min(...cols) - SCROLL_MARGIN);
      const maxCol = Math.max(...cols) + SCROLL_MARGIN;
      const centerCol = (minCol + maxCol) / 2;
      const centerRow = (minRow + maxRow) / 2;
      const centerX = (centerCol - 0.5) * cellSize;
      const centerY = (centerRow - 0.5) * cellSize;
      setOffset(
        calculateCenteredOffset(
          centerX,
          centerY,
          containerWidth,
          containerHeight,
          cellSize,
          rotationRadians,
        ),
      );
    } else if (!selectedHall) {
      if (routeBounds) {
        const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
        const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
        const routeCenterX = (routeCenterCol - 0.5) * cellSize;
        const routeCenterY = (routeCenterRow - 0.5) * cellSize;

        setOffset(
          calculateCenteredOffset(
            routeCenterX,
            routeCenterY,
            containerWidth,
            containerHeight,
            cellSize,
            rotationRadians,
          ),
        );
      } else {
        setOffset({ x: 0, y: 0 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedHall,
    routeBounds,
    currentCellCoords,
    onZoomChange,
    showPrevRoute,
    mapCenteringMode,
    calcOptimalZoom,
    calculateCenteredOffset,
  ]);

  useEffect(() => {
    const centerRequestKey = `${positionKeys.centerVisitKey ?? ""}:${recenterRevision}`;
    if (prevCenterRequestRef.current === centerRequestKey) {
      return;
    }
    prevCenterRequestRef.current = centerRequestKey;

    if (!routeBounds || !currentCellCoords) return;
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    effectiveShowPrevRef.current =
      mapCenteringMode === "prevToCurrent" && showPrevRoute;

    const optimalZoom = calcOptimalZoom(
      routeBounds,
      containerWidth,
      containerHeight,
    );
    const newZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.round(optimalZoom)),
    );

    if (onZoomChange) {
      onZoomChange(newZoom);
    }

    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
    const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
    const routeCenterX = (routeCenterCol - 0.5) * newCellSize;
    const routeCenterY = (routeCenterRow - 0.5) * newCellSize;

    setOffset(
      calculateCenteredOffset(
        routeCenterX,
        routeCenterY,
        containerWidth,
        containerHeight,
        newCellSize,
        rotationRadians,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    positionKeys.centerVisitKey,
    recenterRevision,
    routeBounds,
    currentCellCoords,
    onZoomChange,
    showPrevRoute,
    mapCenteringMode,
    calcOptimalZoom,
    calculateCenteredOffset,
  ]);

  // 描画補助関数。
  const prevCenteringModeRef = useRef(mapCenteringMode);
  useEffect(() => {
    if (prevCenteringModeRef.current === mapCenteringMode) return;
    prevCenteringModeRef.current = mapCenteringMode;

    if (!routeBounds || !currentCellCoords) return;
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    effectiveShowPrevRef.current =
      mapCenteringMode === "prevToCurrent" && showPrevRoute;

    const optimalZoom = calcOptimalZoom(
      routeBounds,
      containerWidth,
      containerHeight,
    );
    const newZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, Math.round(optimalZoom)),
    );

    if (onZoomChange) {
      onZoomChange(newZoom);
    }

    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
    const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
    const routeCenterX = (routeCenterCol - 0.5) * newCellSize;
    const routeCenterY = (routeCenterRow - 0.5) * newCellSize;

    setOffset(
      calculateCenteredOffset(
        routeCenterX,
        routeCenterY,
        containerWidth,
        containerHeight,
        newCellSize,
        rotationRadians,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    mapCenteringMode,
    routeBounds,
    currentCellCoords,
    onZoomChange,
    showPrevRoute,
    calcOptimalZoom,
    calculateCenteredOffset,
  ]);

  const restoredViewportRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (
      !viewportRestoreRequest ||
      restoredViewportRevisionRef.current === viewportRestoreRequest.revision
    ) {
      return;
    }
    restoredViewportRevisionRef.current = viewportRestoreRequest.revision;
    const snapshot = viewportRestoreRequest.snapshot;
    if (onZoomChange && snapshot.zoomLevel !== zoomLevelRef.current) {
      zoomLevelRef.current = snapshot.zoomLevel;
      onZoomChange(snapshot.zoomLevel);
    }
    if (onRotationAngleChange && snapshot.rotationAngle !== rotationAngle) {
      onRotationAngleChange(snapshot.rotationAngle);
    }
    setOffset({ x: snapshot.offsetX, y: snapshot.offsetY });
    onViewportRestoreApplied?.(viewportRestoreRequest.revision);
  }, [
    onRotationAngleChange,
    onZoomChange,
    onViewportRestoreApplied,
    rotationAngle,
    setOffset,
    viewportRestoreRequest,
    zoomLevelRef,
  ]);

  // ドラッグ中の再描画で再計算しないよう、ルート交差データをキャッシュする。
  const routeCrossingData = useMemo(() => {
    if (routeSegments.length === 0) return null;

    const allPixelEdges: PixelEdge[][] = routeSegments.map((segment) => {
      if (segment.path.length < 2) return [];
      const edges: PixelEdge[] = [];
      for (let i = 0; i < segment.path.length - 1; i++) {
        const p1 = segment.path[i];
        const p2 = segment.path[i + 1];
        edges.push({
          x1: (p1.col - 0.5) * cellSize,
          y1: (p1.row - 0.5) * cellSize,
          x2: (p2.col - 0.5) * cellSize,
          y2: (p2.row - 0.5) * cellSize,
        });
      }
      return edges;
    });

    const crossings = findAllCrossingsIndexed(allPixelEdges, cellSize);
    const crossingLookup = buildCrossingLookup(crossings);
    const bridgeParams = getBridgeParams(cellSize);

    return { crossingLookup, bridgeParams };
  }, [routeSegments, cellSize]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;
    canvas.width = containerWidth * dpr;
    canvas.height = containerHeight * dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, containerWidth, containerHeight);

    // ドラッグ中の最新オフセットを即時反映するため、ref から読み取る。
    const currentOffset = offsetRef.current;

    ctx.save();
    ctx.translate(currentOffset.x, currentOffset.y);
    if (rotationRadians !== 0) {
      ctx.translate(mapCenterX, mapCenterY);
      ctx.rotate(rotationRadians);
      ctx.translate(-mapCenterX, -mapCenterY);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    // toMapCoordinates への依存を避けるため、表示座標からマップ座標への変換をここで行う。
    const viewToMap = (viewX: number, viewY: number) => {
      const tx = viewX - currentOffset.x;
      const ty = viewY - currentOffset.y;
      if (rotationRadians === 0) return { x: tx, y: ty };
      const dx = tx - mapCenterX;
      const dy = ty - mapCenterY;
      const cos = Math.cos(rotationRadians);
      const sin = Math.sin(rotationRadians);
      return {
        x: dx * cos + dy * sin + mapCenterX,
        y: -dx * sin + dy * cos + mapCenterY,
      };
    };
    const viewportCorners = [
      viewToMap(0, 0),
      viewToMap(containerWidth, 0),
      viewToMap(0, containerHeight),
      viewToMap(containerWidth, containerHeight),
    ];
    const visibleMinX =
      Math.min(...viewportCorners.map((point) => point.x)) - cellSize * 2;
    const visibleMaxX =
      Math.max(...viewportCorners.map((point) => point.x)) + cellSize * 2;
    const visibleMinY =
      Math.min(...viewportCorners.map((point) => point.y)) - cellSize * 2;
    const visibleMaxY =
      Math.max(...viewportCorners.map((point) => point.y)) + cellSize * 2;

    const visMinCol = Math.max(1, Math.floor(visibleMinX / cellSize) + 1);
    const visMaxCol = Math.min(
      mapData.maxCol,
      Math.ceil(visibleMaxX / cellSize) + 1,
    );
    const visMinRow = Math.max(1, Math.floor(visibleMinY / cellSize) + 1);
    const visMaxRow = Math.min(
      mapData.maxRow,
      Math.ceil(visibleMaxY / cellSize) + 1,
    );

    const isCellVisible = (
      row: number,
      col: number,
      spanRows: number,
      spanCols: number,
    ): boolean => {
      return (
        col + spanCols - 1 >= visMinCol &&
        col <= visMaxCol &&
        row + spanRows - 1 >= visMinRow &&
        row <= visMaxRow
      );
    };

    const drawUprightText = (text: string, x: number, y: number) => {
      if (rotationRadians === 0) {
        ctx.fillText(text, x, y);
        return;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-rotationRadians);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };

    const splitTokenByWidth = (
      token: string,
      maxLineWidth: number,
    ): string[] => {
      const chunks: string[] = [];
      let current = "";

      Array.from(token).forEach((char) => {
        const next = current + char;
        if (current.length > 0 && ctx.measureText(next).width > maxLineWidth) {
          chunks.push(current);
          current = char;
        } else {
          current = next;
        }
      });

      if (current.length > 0) {
        chunks.push(current);
      }
      return chunks.length > 0 ? chunks : [""];
    };

    const tokenizeLineForWrap = (line: string): string[] => {
      const tokens: string[] = [];
      let currentAsciiWord = "";

      const flushAsciiWord = () => {
        if (currentAsciiWord.length === 0) return;
        tokens.push(currentAsciiWord);
        currentAsciiWord = "";
      };

      Array.from(line).forEach((char) => {
        if (/\s/.test(char)) {
          flushAsciiWord();
          tokens.push(char);
          return;
        }
        if (/[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/.test(char)) {
          currentAsciiWord += char;
          return;
        }
        flushAsciiWord();
        tokens.push(char);
      });
      flushAsciiWord();

      return tokens.length > 0 ? tokens : [""];
    };

    const splitTextByWidth = (
      sourceText: string,
      maxLineWidth: number,
    ): string[] => {
      const rawLines = sourceText.split("\n");
      const wrappedLines: string[] = [];

      rawLines.forEach((rawLine) => {
        if (rawLine.length === 0) {
          wrappedLines.push("");
          return;
        }

        const tokens = tokenizeLineForWrap(rawLine);
        let current = "";

        tokens.forEach((token) => {
          const next = current + token;
          if (
            current.length > 0 &&
            ctx.measureText(next).width > maxLineWidth
          ) {
            wrappedLines.push(current.trimEnd());

            const normalizedToken = token.trimStart();
            if (normalizedToken.length === 0) {
              current = "";
              return;
            }

            if (ctx.measureText(normalizedToken).width > maxLineWidth) {
              const chunks = splitTokenByWidth(normalizedToken, maxLineWidth);
              wrappedLines.push(...chunks.slice(0, -1));
              current = chunks[chunks.length - 1];
            } else {
              current = normalizedToken;
            }
          } else {
            current = next;
          }
        });

        wrappedLines.push(current.trimEnd());
      });

      return wrappedLines.length > 0 ? wrappedLines : [""];
    };

    const trimLineToWidth = (line: string, maxLineWidth: number): string => {
      let next = line;
      while (
        next.length > 0 &&
        ctx.measureText(`${next}…`).width > maxLineWidth
      ) {
        next = next.slice(0, -1);
      }
      return next.length > 0 ? `${next}…` : "…";
    };

    const drawFittedHorizontalTextInCell = (
      sourceText: string,
      x: number,
      y: number,
      width: number,
      height: number,
      preferredFontSize: number,
    ) => {
      const fontFamily =
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const minFontSize = 6;
      const innerPaddingX = Math.max(1, preferredFontSize * 0.2);
      const innerPaddingY = Math.max(1, preferredFontSize * 0.2);
      const maxLineWidth = Math.max(1, width - innerPaddingX * 2);
      const maxTextHeight = Math.max(1, height - innerPaddingY * 2);

      let resolvedFontSize = Math.max(
        minFontSize,
        Math.floor(preferredFontSize),
      );
      let resolvedLineHeight = resolvedFontSize * 1.15;
      let resolvedLines = splitTextByWidth(sourceText, maxLineWidth);

      for (
        let size = Math.max(minFontSize, Math.floor(preferredFontSize));
        size >= minFontSize;
        size--
      ) {
        ctx.font = `${size}px ${fontFamily}`;
        const candidateLines = splitTextByWidth(sourceText, maxLineWidth);
        const candidateLineHeight = size * 1.15;
        if (candidateLines.length * candidateLineHeight <= maxTextHeight) {
          resolvedFontSize = size;
          resolvedLineHeight = candidateLineHeight;
          resolvedLines = candidateLines;
          break;
        }
      }

      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      const maxLines = Math.max(
        1,
        Math.floor(maxTextHeight / resolvedLineHeight),
      );
      if (resolvedLines.length > maxLines) {
        const clamped = resolvedLines.slice(0, maxLines);
        clamped[maxLines - 1] = trimLineToWidth(
          clamped[maxLines - 1],
          maxLineWidth,
        );
        resolvedLines = clamped;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const totalTextHeight = resolvedLines.length * resolvedLineHeight;
      const startY =
        y + (height - totalTextHeight) / 2 + resolvedLineHeight / 2;
      const centerX = x + width / 2;

      resolvedLines.forEach((line, lineIndex) => {
        const lineY = startY + lineIndex * resolvedLineHeight;
        drawUprightText(line, centerX, lineY);
      });

      ctx.restore();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    };

    const drawFittedVerticalTextInCell = (
      sourceText: string,
      x: number,
      y: number,
      width: number,
      height: number,
      preferredFontSize: number,
    ) => {
      const fontFamily =
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const minFontSize = 6;
      const columns = sourceText.split(/\n/).map((line) => line || " ");
      const innerPaddingX = Math.max(1, preferredFontSize * 0.2);
      const innerPaddingY = Math.max(1, preferredFontSize * 0.2);
      const maxTextWidth = Math.max(1, width - innerPaddingX * 2);
      const maxTextHeight = Math.max(1, height - innerPaddingY * 2);

      const canFitVerticalText = (fontSize: number): boolean => {
        const columnSpacing = fontSize * 1.2;
        const rowSpacing = fontSize * 1.1;
        const requiredWidth = columns.length * columnSpacing;
        const requiredHeight =
          Math.max(...columns.map((column) => Array.from(column).length)) *
          rowSpacing;
        return requiredWidth <= maxTextWidth && requiredHeight <= maxTextHeight;
      };

      let resolvedFontSize = Math.max(
        minFontSize,
        Math.floor(preferredFontSize),
      );
      for (
        let size = Math.max(minFontSize, Math.floor(preferredFontSize));
        size >= minFontSize;
        size--
      ) {
        if (canFitVerticalText(size)) {
          resolvedFontSize = size;
          break;
        }
      }

      const columnSpacing = resolvedFontSize * 1.2;
      const rowSpacing = resolvedFontSize * 1.1;
      const maxColumns = Math.max(1, Math.floor(maxTextWidth / columnSpacing));
      const maxRows = Math.max(1, Math.floor(maxTextHeight / rowSpacing));

      let drawableColumns = columns
        .slice(0, maxColumns)
        .map((column) => Array.from(column));
      const hadHiddenColumns = columns.length > maxColumns;

      drawableColumns = drawableColumns.map((chars) => {
        if (chars.length <= maxRows) return chars;
        const trimmed = chars.slice(0, maxRows);
        trimmed[maxRows - 1] = "…";
        return trimmed;
      });

      if (hadHiddenColumns) {
        const lastColumnIndex = drawableColumns.length - 1;
        const lastColumn = drawableColumns[lastColumnIndex];
        if (lastColumn.length < maxRows) {
          lastColumn.push("…");
        } else {
          lastColumn[lastColumn.length - 1] = "…";
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const totalWidth = drawableColumns.length * columnSpacing;
      const startX = x + width / 2 + (totalWidth - columnSpacing) / 2;

      drawableColumns.forEach((chars, columnIndex) => {
        const totalHeight = chars.length * rowSpacing;
        const startY = y + (height - totalHeight) / 2 + rowSpacing / 2;
        const columnX = startX - columnIndex * columnSpacing;

        chars.forEach((char, charIndex) => {
          const charY = startY + charIndex * rowSpacing;
          drawUprightText(char, columnX, charY);
        });
      });

      ctx.restore();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
    };

    // 番号セルのスタイル値はループ外で解決する。
    const outlineStyle = numberCellOutlineStyle;
    const useInset = outlineStyle !== "none";
    const ncPad = useInset ? cellSize * 0.1 : 0;
    const ncRadius =
      outlineStyle === "rounded" ? Math.max(2, cellSize * 0.18) : 0;
    const ncBg = isDarkMode ? "#1E293B" : "#FFFFFF";
    const ncBorder = isDarkMode ? "#475569" : "#CBD5E1";
    const ncBorderWidth = Math.max(1, cellSize * 0.055);
    const drawStroke = outlineStyle !== "none";
    const isDashed = outlineStyle === "dashed";

    // セルのパス生成処理をスタイルごとにまとめる。
    const drawCellPath =
      ncRadius > 0
        ? (rx: number, ry: number, rw: number, rh: number) =>
            ctx.roundRect(
              rx + ncPad,
              ry + ncPad,
              rw - ncPad * 2,
              rh - ncPad * 2,
              ncRadius,
            )
        : (rx: number, ry: number, rw: number, rh: number) =>
            ctx.rect(rx + ncPad, ry + ncPad, rw - ncPad * 2, rh - ncPad * 2);

    // 一括描画用にジオメトリを収集する。
    const ncRects: { x: number; y: number; w: number; h: number }[] = [];
    const overlayGroups = new Map<
      string,
      { x: number; y: number; w: number; h: number }[]
    >();

    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;

      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const spanCols = merge ? merge.endCol - merge.startCol + 1 : 1;
      const spanRows = merge ? merge.endRow - merge.startRow + 1 : 1;
      if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;

      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;
      const width = spanCols * cellSize;
      const height = spanRows * cellSize;

      const cellKey = `${cell.row}-${cell.col}`;
      const isNumberCell = numberCellSet.has(cellKey);

      if (isNumberCell) {
        ncRects.push({ x, y, w: width, h: height });
      } else if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }

      const state = cellStates.get(cellKey);
      if (state && state.hasItems) {
        const label = cellLabels.get(cellKey);
        if (label) {
          if (isNumberCell) {
            const color = label.bgColor;
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = label.bgColor;
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.isVisited) {
          if (isNumberCell) {
            const color = "rgba(158, 158, 158, 0.5)";
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = "rgba(158, 158, 158, 0.5)";
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.hasPostponed && resolvedFormalPhase !== "postponed") {
          if (isNumberCell) {
            const color = "rgba(156, 39, 176, 0.4)";
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = "rgba(156, 39, 176, 0.4)";
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.hasLate && resolvedFormalPhase !== "late") {
          if (isNumberCell) {
            const color = "rgba(33, 150, 243, 0.4)";
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = "rgba(33, 150, 243, 0.4)";
            ctx.fillRect(x, y, width, height);
          }
        }
      }
    });

    // 収集したジオメトリをまとめて描画する。
    if (ncRects.length > 0) {
      ctx.beginPath();
      for (const r of ncRects) drawCellPath(r.x, r.y, r.w, r.h);
      ctx.fillStyle = ncBg;
      ctx.fill();

      // 枠線を描画する。
      if (drawStroke) {
        ctx.strokeStyle = ncBorder;
        ctx.lineWidth = ncBorderWidth;
        if (isDashed) {
          // 破線枠はセルごとに破線の開始位置をリセットする。
          const dashLen = Math.max(2, cellSize * 0.12);
          ctx.setLineDash([dashLen, dashLen]);
          for (const r of ncRects) {
            ctx.beginPath();
            drawCellPath(r.x, r.y, r.w, r.h);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        } else {
          // 角丸と四角の枠線はまとめたパスを一度だけ stroke する。
          ctx.stroke();
        }
      }

      // オーバーレイもまとめて描画する。
      for (const [color, rects] of overlayGroups) {
        ctx.beginPath();
        for (const r of rects) drawCellPath(r.x, r.y, r.w, r.h);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // セル境界線を描画する。
    if (showBorders && !isRotationInteracting) {
      type DrawnBorder = NonNullable<CellData["borders"]["top"]>;
      type BorderEdge = {
        orientation: "h" | "v";
        gridX: number;
        gridY: number;
        border: DrawnBorder;
      };

      const borderWeight = (border: DrawnBorder): number => {
        switch (border.style) {
          case "double":
            return 4;
          case "thick":
            return 3;
          case "medium":
            return 2;
          case "thin":
          default:
            return 1;
        }
      };

      const pickBorder = (
        current: DrawnBorder | undefined,
        candidate: DrawnBorder,
      ): DrawnBorder => {
        if (!current) return candidate;

        const currentWeight = borderWeight(current);
        const candidateWeight = borderWeight(candidate);
        if (candidateWeight > currentWeight) return candidate;
        if (candidateWeight < currentWeight) return current;

        if (current.color === "#000000" && candidate.color !== "#000000") {
          return candidate;
        }

        return current;
      };

      const edgeMap = new Map<string, BorderEdge>();
      const upsertEdge = (
        orientation: "h" | "v",
        gridX: number,
        gridY: number,
        border: DrawnBorder | null,
      ) => {
        if (!border) return;
        const key = `${orientation}-${gridX}-${gridY}`;
        const existing = edgeMap.get(key);
        const selected = pickBorder(existing?.border, border);
        edgeMap.set(key, { orientation, gridX, gridY, border: selected });
      };

      mapData.cells.forEach((cell) => {
        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        if (!isCellVisible(cell.row, cell.col, 1, 1)) return;

        const startCol = cell.col - 1;
        const endCol = startCol + 1;
        const startRow = cell.row - 1;
        const endRow = startRow + 1;

        let topBorder = cell.borders.top;
        let rightBorder = cell.borders.right;
        let bottomBorder = cell.borders.bottom;
        let leftBorder = cell.borders.left;

        if (merge) {
          if (merge.endCol > merge.startCol) {
            rightBorder = null;
          }
          if (merge.endRow > merge.startRow) {
            bottomBorder = null;
          }
        }

        if (topBorder) {
          upsertEdge("h", startCol, startRow, topBorder);
        }
        if (bottomBorder) {
          upsertEdge("h", startCol, endRow, bottomBorder);
        }
        if (leftBorder) {
          upsertEdge("v", startCol, startRow, leftBorder);
        }
        if (rightBorder) {
          upsertEdge("v", endCol, startRow, rightBorder);
        }
      });

      const softBorderColor = (color: string | undefined): string => {
        const c = color || "#000000";
        if (c === "#000000") return isDarkMode ? "#666666" : "#555555";
        return c;
      };

      edgeMap.forEach(({ orientation, gridX, gridY, border }) => {
        let lineWidth = 1;
        switch (border.style) {
          case "double":
          case "thick":
            lineWidth = 3;
            break;
          case "medium":
            lineWidth = 2;
            break;
          case "thin":
          default:
            lineWidth = 1;
            break;
        }

        const startX = gridX * cellSize;
        const startY = gridY * cellSize;
        const endX = orientation === "h" ? (gridX + 1) * cellSize : startX;
        const endY = orientation === "v" ? (gridY + 1) * cellSize : startY;

        ctx.beginPath();
        ctx.strokeStyle = softBorderColor(border.color);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = lineWidth;
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      });
    }

    if (showNumbers) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged || cell.value === null) return;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const spanCols = merge ? merge.endCol - merge.startCol + 1 : 1;
        const spanRows = merge ? merge.endRow - merge.startRow + 1 : 1;
        if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;
        const width = spanCols * cellSize;
        const height = spanRows * cellSize;

        const text = String(cell.value);
        const isVertical = cell.isVerticalText;

        let fontSize: number;
        if (merge) {
          if (isVertical) {
            const charCount = text.replace(/\n/g, "").length;
            fontSize = Math.min(
              width * 0.6,
              (height / (charCount + 1)) * 0.9,
              16,
            );
          } else {
            fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
          }
        } else if (typeof cell.value === "number") {
          fontSize = Math.min(cellSize * 0.45, 14);
        } else {
          fontSize = Math.min(cellSize * 0.4, 12);
        }
        fontSize = Math.max(fontSize, 8);

        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        const explicitFontColor = cell.fontColor?.trim();
        if (explicitFontColor) {
          ctx.fillStyle = resolveMapTextColorForTheme(
            explicitFontColor,
            isDarkMode,
          );
        } else if (state?.isCurrentPosition) {
          ctx.fillStyle = "#E65100";
        } else if (state?.isVisited) {
          ctx.fillStyle = resolveMapTextColorForTheme("#616161", isDarkMode);
        } else if (state?.hasItems) {
          ctx.fillStyle = "#1565C0";
        } else if (numberCellSet.has(`${cell.row}-${cell.col}`)) {
          ctx.fillStyle = isDarkMode ? "#E2E8F0" : "#334155";
        } else {
          ctx.fillStyle = resolveMapTextColorForTheme(
            cell.fontColor,
            isDarkMode,
          );
        }

        if (isVertical) {
          if (rotationRadians !== 0) {
            drawFittedVerticalTextInCell(text, x, y, width, height, fontSize);
          } else {
            const lines = text.split(/\n/);
            const lineSpacing = fontSize * 1.2;
            const totalWidth = lines.length * lineSpacing;
            const startX = x + width / 2 + (totalWidth - lineSpacing) / 2;

            lines.forEach((line, lineIndex) => {
              const chars = line.split("");
              const totalHeight = chars.length * fontSize * 1.1;
              const startY = y + (height - totalHeight) / 2 + fontSize / 2;
              const lineX = startX - lineIndex * lineSpacing;

              chars.forEach((char, charIndex) => {
                const charY = startY + charIndex * fontSize * 1.1;
                drawUprightText(char, lineX, charY);
              });
            });
          }
        } else if (rotationRadians !== 0) {
          drawFittedHorizontalTextInCell(text, x, y, width, height, fontSize);
        } else {
          drawUprightText(text, x + width / 2, y + height / 2);
        }
      });
    }

    // ドラッグ中の再描画で再計算しないよう、ルート交差データをキャッシュする。
    if (
      !isRotationInteracting &&
      routeSegments.length > 0 &&
      routeCrossingData
    ) {
      const lineWidth = Math.max(2, cellSize * 0.08);
      const { crossingLookup, bridgeParams } = routeCrossingData;

      // ビューポート外判定用の余白。
      const routeMargin = cellSize * 2;
      const visMinX = visibleMinX - routeMargin;
      const visMaxX = visibleMaxX + routeMargin;
      const visMinY = visibleMinY - routeMargin;
      const visMaxY = visibleMaxY + routeMargin;

      const batcher = new BatchedPathRenderer();

      routeSegments.forEach((segment, segIdx) => {
        if (segment.path.length < 2) return;

        let currentLineWidth = lineWidth;
        let strokeStyle: string;

        // 正式位置だけを基準にルート線の見た目を切り替える。
        const progressState = resolveFocusMapRouteProgressState(
          segment.segmentIndex,
          resolvedFormalRouteIndex,
        );
        if (progressState === "visited") {
          strokeStyle = "rgba(156, 163, 175, 0.4)";
        } else if (progressState === "current") {
          strokeStyle = "rgba(255, 109, 0, 0.6)";
          currentLineWidth = Math.max(3, cellSize * 0.1);
        } else {
          strokeStyle = "rgba(66, 165, 245, 0.4)";
        }

        const collector = batcher.beginGroup(strokeStyle, currentLineWidth);

        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];

          const px1 = (p1.col - 0.5) * cellSize;
          const py1 = (p1.row - 0.5) * cellSize;
          const px2 = (p2.col - 0.5) * cellSize;
          const py2 = (p2.row - 0.5) * cellSize;

          // ビューポート外のセグメントは描画をスキップする。
          if (px1 < visMinX && px2 < visMinX) continue;
          if (px1 > visMaxX && px2 > visMaxX) continue;
          if (py1 < visMinY && py2 < visMinY) continue;
          if (py1 > visMaxY && py2 > visMaxY) continue;

          // ルート線の交差箇所にはブリッジ用の隙間を入れて描画する。
          collectEdgeWithBridges(
            collector,
            px1,
            py1,
            px2,
            py2,
            segIdx,
            i,
            crossingLookup,
            bridgeParams,
          );
        }
      });

      batcher.flush(ctx);
    }

    // ラベルを描画する。
    if (!isRotationInteracting) {
      cellLabels.forEach((label, key) => {
        const [row, col] = key.split("-").map(Number);
        if (!isCellVisible(row, col, 1, 1)) return;

        const x = (col - 1) * cellSize;
        const y = (row - 1) * cellSize;

        const merge = mergedCellsMap.get(key);
        const width = merge
          ? (merge.endCol - merge.startCol + 1) * cellSize
          : cellSize;
        const height = merge
          ? (merge.endRow - merge.startRow + 1) * cellSize
          : cellSize;

        // 現在対象セルを枠線で強調する。
        const state = cellStates.get(key);
        if (state?.isCurrentPosition) {
          ctx.strokeStyle = FOCUS_MAP_OFFICIAL_MARKER_STYLE.color;
          ctx.lineWidth = Math.max(3, cellSize * 0.12);
          ctx.strokeRect(x - 1, y - 1, width + 2, height + 2);
        }

        // ラベル文字を描画する。
        if (state?.isCurrentPosition) {
          // 現在対象セルはピンとラベルをセル上部に描画する。
          const pinFontSize = Math.max(12, cellSize * 0.45);
          ctx.font = `${pinFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          const pinY = y; // ピンの描画位置。
          drawUprightText(
            FOCUS_MAP_OFFICIAL_MARKER_STYLE.pin,
            x + width / 2,
            pinY,
          );

          // ラベルはピンの上に配置する。
          const labelFontSize = Math.max(10, cellSize * 0.35);
          ctx.font = `bold ${labelFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textBaseline = "bottom";
          ctx.fillStyle = label.textColor;
          drawUprightText(label.text, x + width / 2, pinY - pinFontSize);
        } else {
          // その他のラベルはセル中央に描画する。
          const fontSize = Math.max(10, cellSize * 0.35);
          ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = label.textColor;
          drawUprightText(label.text, x + width / 2, y + height / 2);
        }
      });

      // 一時表示先は正式位置とは独立した青い破線二重枠で描く。
      // 同じセルに正式位置もある場合は、破線の隙間からオレンジ枠を
      // 見せつつ、外側・内側の両方へ青枠を重ねる。
      cellStates.forEach((state, key) => {
        if (!state.isTemporaryPosition) return;
        const [row, col] = key.split("-").map(Number);
        if (!isCellVisible(row, col, 1, 1)) return;

        const x = (col - 1) * cellSize;
        const y = (row - 1) * cellSize;
        const merge = mergedCellsMap.get(key);
        const width = merge
          ? (merge.endCol - merge.startCol + 1) * cellSize
          : cellSize;
        const height = merge
          ? (merge.endRow - merge.startRow + 1) * cellSize
          : cellSize;
        const outerInset = Math.max(2, cellSize * 0.08);
        const innerInset = Math.max(3, cellSize * 0.14);
        const dashLength = Math.max(5, cellSize * 0.24);
        const dashGap = Math.max(3, cellSize * 0.12);

        ctx.save();
        ctx.setLineDash([dashLength, dashGap]);
        ctx.lineCap = "butt";
        ctx.strokeStyle = FOCUS_MAP_TEMPORARY_MARKER_STYLE.outerColor;
        ctx.lineWidth = Math.max(3, cellSize * 0.13);
        ctx.strokeRect(
          x - outerInset,
          y - outerInset,
          width + outerInset * 2,
          height + outerInset * 2,
        );

        ctx.setLineDash([dashLength * 0.75, dashGap * 0.75]);
        ctx.strokeStyle = FOCUS_MAP_TEMPORARY_MARKER_STYLE.innerColor;
        ctx.lineWidth = Math.max(2, cellSize * 0.08);
        ctx.strokeRect(
          x + innerInset,
          y + innerInset,
          Math.max(1, width - innerInset * 2),
          Math.max(1, height - innerInset * 2),
        );
        ctx.setLineDash([]);

        const labelFontSize = Math.max(10, cellSize * 0.32);
        const labelPaddingX = Math.max(3, cellSize * 0.1);
        const labelPaddingY = Math.max(2, cellSize * 0.06);
        ctx.font = `bold ${labelFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        const labelWidth =
          ctx.measureText(FOCUS_MAP_TEMPORARY_MARKER_STYLE.label).width +
          labelPaddingX * 2;
        const labelHeight = labelFontSize + labelPaddingY * 2;
        const labelCenterX = x + width / 2;
        const labelCenterY = y + height - labelHeight / 2 - innerInset;
        ctx.fillStyle = "rgba(29, 78, 216, 0.92)";
        ctx.fillRect(
          labelCenterX - labelWidth / 2,
          labelCenterY - labelHeight / 2,
          labelWidth,
          labelHeight,
        );
        ctx.fillStyle = "#FFFFFF";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        drawUprightText(
          FOCUS_MAP_TEMPORARY_MARKER_STYLE.label,
          labelCenterX,
          labelCenterY,
        );
        ctx.restore();
      });
    }

    ctx.restore();
  }, [
    mapData,
    cellSize,
    cellStates,
    cellLabels,
    numberCellSet,
    mergedCellsMap,
    routeSegments,
    resolvedFormalPhaseIndex,
    resolvedFormalRouteIndex,
    dpr,
    isDetailedView,
    showNumbers,
    showBorders,
    currentCellCoords,
    resolvedFormalPhase,
    isDarkMode,
    isRotationInteracting,
    rotationRadians,
    mapCenterX,
    mapCenterY,
    numberCellOutlineStyle,
    routeCrossingData,
  ]);

  // rAF から最新の描画関数を呼べるよう drawCanvasRef を更新する。
  drawCanvasRef.current = drawCanvas;

  // 依存値が変わったら再描画する。
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  const activeScrollBounds = useMemo(() => {
    const isExplicitHallSelection = selectedHallMode !== "follow";
    if (
      isExplicitHallSelection &&
      selectedHall &&
      selectedHall.vertices.length >= 4
    ) {
      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      return {
        minRow: Math.max(1, Math.min(...rows) - SCROLL_MARGIN),
        maxRow: Math.max(...rows) + SCROLL_MARGIN,
        minCol: Math.max(1, Math.min(...cols) - SCROLL_MARGIN),
        maxCol: Math.max(...cols) + SCROLL_MARGIN,
      };
    }

    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;
    let minCol = Number.POSITIVE_INFINITY;
    let maxCol = Number.NEGATIVE_INFINITY;
    let hasBounds = false;

    mapData.cells.forEach((cell) => {
      if (!hasCellInputValue(cell.value)) return;
      hasBounds = true;
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minCol = Math.min(minCol, cell.col);
      maxCol = Math.max(maxCol, cell.col);
    });

    mapData.mergedCells.forEach((merge) => {
      if (!hasCellInputValue(merge.value)) return;
      hasBounds = true;
      minRow = Math.min(minRow, merge.startRow);
      maxRow = Math.max(maxRow, merge.endRow);
      minCol = Math.min(minCol, merge.startCol);
      maxCol = Math.max(maxCol, merge.endCol);
    });

    if (hasBounds) {
      return {
        minRow: minRow - FILLED_SCROLL_MARGIN,
        maxRow: maxRow + FILLED_SCROLL_MARGIN,
        minCol: minCol - FILLED_SCROLL_MARGIN,
        maxCol: maxCol + FILLED_SCROLL_MARGIN,
      };
    }

    return {
      minRow: 1,
      maxRow: mapData.maxRow,
      minCol: 1,
      maxCol: mapData.maxCol,
    };
  }, [
    selectedHallMode,
    selectedHall,
    mapData.cells,
    mapData.mergedCells,
    mapData.maxRow,
    mapData.maxCol,
  ]);

  const calculateScrollLimits = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const boundsLeft = (activeScrollBounds.minCol - 1) * cellSize;
    const boundsRight = activeScrollBounds.maxCol * cellSize;
    const boundsTop = (activeScrollBounds.minRow - 1) * cellSize;
    const boundsBottom = activeScrollBounds.maxRow * cellSize;

    const rotatedCorners = [
      rotatePointAroundCenter(
        boundsLeft,
        boundsTop,
        mapCenterX,
        mapCenterY,
        rotationRadians,
      ),
      rotatePointAroundCenter(
        boundsRight,
        boundsTop,
        mapCenterX,
        mapCenterY,
        rotationRadians,
      ),
      rotatePointAroundCenter(
        boundsLeft,
        boundsBottom,
        mapCenterX,
        mapCenterY,
        rotationRadians,
      ),
      rotatePointAroundCenter(
        boundsRight,
        boundsBottom,
        mapCenterX,
        mapCenterY,
        rotationRadians,
      ),
    ];

    const rotatedMinX = Math.min(...rotatedCorners.map((point) => point.x));
    const rotatedMaxX = Math.max(...rotatedCorners.map((point) => point.x));
    const rotatedMinY = Math.min(...rotatedCorners.map((point) => point.y));
    const rotatedMaxY = Math.max(...rotatedCorners.map((point) => point.y));

    return {
      minX: containerWidth - rotatedMaxX,
      maxX: -rotatedMinX,
      minY: containerHeight - rotatedMaxY,
      maxY: -rotatedMinY,
    };
  }, [activeScrollBounds, cellSize, mapCenterX, mapCenterY, rotationRadians]);

  const isCellInBlock = useCallback(
    (row: number, col: number, block: BlockDefinition): boolean => {
      if (block.cellGroups && block.cellGroups.length > 0) {
        return block.cellGroups.some((group) => {
          if (group.type === "range") {
            return (
              row >= (group.startRow || 0) &&
              row <= (group.endRow || 0) &&
              col >= (group.startCol || 0) &&
              col <= (group.endCol || 0)
            );
          } else if (group.type === "individual" && group.cells) {
            return group.cells.some((c) => c.row === row && c.col === col);
          }
          return false;
        });
      }
      return (
        row >= block.startRow &&
        row <= block.endRow &&
        col >= block.startCol &&
        col <= block.endCol
      );
    },
    [],
  );

  const getPointerViewMetrics = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        viewX: (clientX - rect.left) / appScale,
        viewY: (clientY - rect.top) / appScale,
      };
    },
    [appScale],
  );

  const handleTapAtViewPosition = useCallback(
    (viewX: number, viewY: number) => {
      if (!onCellClick) return;
      const { x: mapX, y: mapY } = toMapCoordinates(viewX, viewY);
      const col = Math.floor(mapX / cellSize) + 1;
      const row = Math.floor(mapY / cellSize) + 1;

      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }

      // 結合セルの子セルがタップされた場合は、親セル座標に解決する。
      let resolvedRow = row;
      let resolvedCol = col;
      for (const merge of mapData.mergedCells) {
        if (
          row >= merge.startRow &&
          row <= merge.endRow &&
          col >= merge.startCol &&
          col <= merge.endCol
        ) {
          resolvedRow = merge.startRow;
          resolvedCol = merge.startCol;
          break;
        }
      }

      for (const block of mapData.blocks) {
        if (!isCellInBlock(resolvedRow, resolvedCol, block)) continue;

        if (
          block.nameCells &&
          block.nameCells.some(
            (nc) => nc.row === resolvedRow && nc.col === resolvedCol,
          )
        ) {
          continue;
        }

        let foundNumber: number | null = null;
        const numberCell = block.numberCells.find(
          (nc) => nc.row === resolvedRow && nc.col === resolvedCol,
        );
        if (numberCell) {
          foundNumber = numberCell.value;
        }

        if (foundNumber === null) {
          const cell = cellsMap.get(`${resolvedRow}-${resolvedCol}`);

          if (cell && cell.value !== null && cell.value !== undefined) {
            const cellValue = String(cell.value).trim();
            if (cellValue === block.name) break;
            const numMatch = cellValue.match(/^(\d+)/);
            if (numMatch) {
              foundNumber = parseInt(numMatch[1], 10);
            }
          }
        }

        if (foundNumber !== null) {
          const matchingItems = items.filter((item) => {
            if (
              normalizeSpaceBlock(item.block) !==
              normalizeSpaceBlock(block.name)
            )
              return false;
            const numStr = extractNumberFromItemNumber(
              normalizeBaseSpaceNumber(item.number),
            );
            const numValue = numStr ? parseInt(numStr, 10) : 0;
            return numValue === foundNumber;
          });
          onCellClick(block.name, foundNumber, matchingItems);
        }
        break;
      }
    },
    [
      cellSize,
      mapData,
      onCellClick,
      isCellInBlock,
      cellsMap,
      items,
      toMapCoordinates,
    ],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDraggingRef.current) return;

      const now =
        typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now < suppressClickUntilRef.current) return;

      const metrics = getPointerViewMetrics(e.clientX, e.clientY);
      if (!metrics) return;
      handleTapAtViewPosition(metrics.viewX, metrics.viewY);
    },
    [getPointerViewMetrics, handleTapAtViewPosition],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.pointerType === "touch" || e.pointerType === "pen") {
        e.preventDefault();
      }
      if (activeTouchesRef.current.size >= 2) return;
      isDraggingRef.current = false;
      setIsDragging(false);
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      dragStartOffsetRef.current = { ...offsetRef.current };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (
        (e.pointerType === "touch" || e.pointerType === "pen") &&
        isPinchGestureRef.current
      ) {
        return;
      }
      if (e.buttons !== 1) return;
      if (activeTouchesRef.current.size >= 2) return;

      const dx = (e.clientX - dragStartRef.current.x) / appScale;
      const dy = (e.clientY - dragStartRef.current.y) / appScale;
      const dragThreshold =
        e.pointerType === "touch" || e.pointerType === "pen" ? 10 : 5;

      if (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) {
        isDraggingRef.current = true;
        setIsDragging(true);
      }

      let newX = dragStartOffsetRef.current.x + dx;
      let newY = dragStartOffsetRef.current.y + dy;

      const limits = calculateScrollLimits();
      if (limits) {
        newX = Math.max(limits.minX, Math.min(limits.maxX, newX));
        newY = Math.max(limits.minY, Math.min(limits.maxY, newY));
      }

      // ドラッグ中は React の再レンダリングを避けるため、ref だけ更新して rAF で再描画する。
      offsetRef.current = { x: newX, y: newY };
      if (!rafPendingRef.current) {
        rafPendingRef.current = true;
        requestAnimationFrame(() => {
          rafPendingRef.current = false;
          drawCanvasRef.current?.();
        });
      }
    },
    [appScale, calculateScrollLimits],
  );

  const finishPointerInteraction = useCallback(() => {
    isDraggingRef.current = false;
    // ドラッグ終了時に ref の値を state へ反映する。
    setOffsetState(offsetRef.current);
    setTimeout(() => {
      setIsDragging(false);
    }, 100);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const wasDragging = isDraggingRef.current;
      const isTouchPointer =
        e.pointerType === "touch" || e.pointerType === "pen";
      if (isTouchPointer) {
        e.preventDefault();
      }

      if (!wasDragging && isTouchPointer && !isPinchGestureRef.current) {
        const metrics = getPointerViewMetrics(e.clientX, e.clientY);
        if (metrics) {
          handleTapAtViewPosition(metrics.viewX, metrics.viewY);
          const now =
            typeof performance !== "undefined" ? performance.now() : Date.now();
          suppressClickUntilRef.current = now + 400;
        }
      } else if (wasDragging) {
        const now =
          typeof performance !== "undefined" ? performance.now() : Date.now();
        suppressClickUntilRef.current = now + 400;
      }

      finishPointerInteraction();
    },
    [finishPointerInteraction, getPointerViewMetrics, handleTapAtViewPosition],
  );

  const handlePointerLeave = useCallback(() => {
    finishPointerInteraction();
  }, [finishPointerInteraction]);

  const handlePointerCancel = useCallback(() => {
    finishPointerInteraction();
  }, [finishPointerInteraction]);

  return (
    <div
      ref={containerRef}
      className="relative bg-white dark:bg-slate-800 overflow-hidden"
      style={{
        width: "100%",
        height: "100%",
      }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onPointerCancel={handlePointerCancel}
        style={{
          cursor: isDragging ? "grabbing" : "grab",
          touchAction: "none",
        }}
      />
      {routeDiagnostics && (
        <RouteDiagnosticsOverlay diagnostics={routeDiagnostics} />
      )}
    </div>
  );
};

export default React.memo(FocusModeMapCanvas);
