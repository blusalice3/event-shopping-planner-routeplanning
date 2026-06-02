import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ZoomLevel,
  MergedCellInfo,
  MapCellStateDetail,
  HallDefinition,
  NumberCellOutlineStyle,
  RouteSegment,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../types/map';
import { ShoppingItem } from '../../types/item';
import { useCanvasViewport } from '../../features/map/canvas/useCanvasViewport';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';
import { findRouteLookupNumberCell } from '../../utils/mapRoutingSignature';
import { generateRouteSegments, simplifyPath } from '../../utils/pathfinding';
import { filterFirstRouteMarkers, normalizeMapRouteDayText } from '../../utils/mapRouteOrder';
import type { MapRoutePoint } from '../../utils/mapRoutePoints';
import { hitTestMapRoute, type MapRouteHitResult } from '../../utils/mapRouteHitTest';
import {
  findAllCrossingsIndexed,
  buildCrossingLookup,
  getBridgeParams,
  collectEdgeWithBridges,
  BatchedPathRenderer,
  PixelEdge,
} from '../../utils/routeRendering';
import MapCanvasPresentation from './MapCanvasPresentation';

interface MapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  zoomLevel: ZoomLevel;
  rotationAngle?: number;
  isRouteVisible: boolean;
  onCellClick: (row: number, col: number, matchingItems: ShoppingItem[]) => void;
  selectedHall?: HallDefinition;
  vertexSelectionMode?: {
    clickedVertices: { row: number; col: number }[];
  } | null;
  cellSelectionMode?: {
    type: string;
    clickedCells: { row: number; col: number }[];
  } | null;
  highlightedCell?: { row: number; col: number } | null;
  onZoomChange?: (newZoom: number) => void;
  onRotationAngleChange?: (newAngle: number) => void;
  selectionGuideOptions?: {
    showGrid: boolean;
    showRuler: boolean;
  };
  initialOffset?: { x: number; y: number };
  offsetRef?: React.MutableRefObject<{ x: number; y: number }>;
  numberCellOutlineStyle?: NumberCellOutlineStyle;
  routePointsOverride?: MapRoutePoint[];
  routeSegmentsOverride?: RouteSegment[];
  routeInsertMissMapDataOverride?: DayMapData;
  forceRouteVisible?: boolean;
  routeInsertSelectionActive?: boolean;
  onRouteInsertHit?: (hit: MapRouteHitResult) => void;
  onRouteInsertMiss?: (miss: { kind: 'cell' | 'blank' }) => void;
}

const BASE_CELL_SIZE = 28; // Base cell size.
const SCROLL_MARGIN = 5; // Blank-cell scroll margin.
const FILLED_SCROLL_MARGIN = 25; // Extra margin around filled cells.
const getDragPanMultiplier = (zoom: number): number => {
  if (zoom < 70) return 2.0;
  if (zoom < 120) return 1.6;
  return 1.3;
};
const extractDayNameFromMapName = (mapName: string): string => {
  const normalizedMapName = normalizeMapRouteDayText(mapName);
  const dayMatch = normalizedMapName.match(/^(.+)マップ$/);
  if (dayMatch) {
    return normalizeMapRouteDayText(dayMatch[1]);
  }
  return normalizedMapName;
};

const hasCellInputValue = (value: string | number | null): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

const TAP_ASSIST_DURATION_MS = 900;

type PriorityIndicatorLevel = 'priority' | 'highest';

interface HoverGuideState {
  row: number;
  col: number;
  viewX: number;
  viewY: number;
}

interface TapAssistState {
  row: number;
  col: number;
  viewX: number;
  viewY: number;
}

type RgbColor = { r: number; g: number; b: number };

const parseCssColorToRgb = (color: string): RgbColor | null => {
  const normalized = color.trim().toLowerCase();
  if (normalized === 'white') return { r: 255, g: 255, b: 255 };
  if (normalized === 'black') return { r: 0, g: 0, b: 0 };

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
  fallback = '#333333',
): string => {
  const baseColor = color?.trim() || fallback;
  if (!isDarkMode) return baseColor;
  if (isWhiteLikeColor(baseColor)) return baseColor;
  return isDarkLikeColor(baseColor) ? '#FFFFFF' : baseColor;
};

const isNumberLikeCellValue = (value: string | number | null): boolean => {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  return /^\d+$/.test(value.trim());
};

const MapCanvas: React.FC<MapCanvasProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds,
  zoomLevel,
  rotationAngle = 0,
  isRouteVisible,
  onCellClick,
  selectedHall,
  vertexSelectionMode,
  cellSelectionMode,
  highlightedCell,
  onZoomChange,
  onRotationAngleChange,
  selectionGuideOptions,
  initialOffset,
  offsetRef: externalOffsetRef,
  numberCellOutlineStyle = 'rounded',
  routePointsOverride,
  routeSegmentsOverride,
  routeInsertMissMapDataOverride,
  forceRouteVisible = false,
  routeInsertSelectionActive = false,
  onRouteInsertHit,
  onRouteInsertMiss,
}) => {
  const {
    activeTouchesRef,
    canvasRef,
    cellSize,
    containerRef,
    dpr,
    dragStartOffsetRef,
    dragStartRef,
    drawCanvasRef,
    getPointerViewMetrics,
    isDragging,
    isDraggingRef,
    isPinchGestureRef,
    isRotationInteracting,
    mapCenterX,
    mapCenterY,
    offsetRef,
    prevCellSizeRef,
    rafPendingRef,
    rotateAroundMapCenter,
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
    initialOffset,
    offsetRef: externalOffsetRef,
    onZoomChange,
    onRotationAngleChange,
  });
  const [hoverGuide, setHoverGuide] = useState<HoverGuideState | null>(null);
  const [tapAssist, setTapAssist] = useState<TapAssistState | null>(null);
  const lastPointerTypeRef = useRef<string>('mouse');
  const tapAssistTimerRef = useRef<number | null>(null);

  const isDarkMode =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;
  const effectiveRouteVisible = isRouteVisible || forceRouteVisible;

  const initializedRef = useRef<boolean>(false);
  const showSelectionGrid = selectionGuideOptions?.showGrid ?? false;
  const showSelectionRuler = selectionGuideOptions?.showRuler ?? false;

  const showTapAssist = useCallback((next: TapAssistState) => {
    setTapAssist(next);
    if (tapAssistTimerRef.current !== null) {
      clearTimeout(tapAssistTimerRef.current);
    }
    tapAssistTimerRef.current = window.setTimeout(() => {
      setTapAssist(null);
      tapAssistTimerRef.current = null;
    }, TAP_ASSIST_DURATION_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (tapAssistTimerRef.current !== null) {
        clearTimeout(tapAssistTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prevCellSize = prevCellSizeRef.current;

    if (!initializedRef.current || prevCellSize === cellSize) {
      prevCellSizeRef.current = cellSize;
      initializedRef.current = true;
      return;
    }

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    const currentOffset = offsetRef.current;
    const mapCenterX = (centerX - currentOffset.x) / prevCellSize;
    const mapCenterY = (centerY - currentOffset.y) / prevCellSize;

    const newOffsetX = centerX - mapCenterX * cellSize;
    const newOffsetY = centerY - mapCenterY * cellSize;

    setOffset({ x: newOffsetX, y: newOffsetY });
    prevCellSizeRef.current = cellSize;
  }, [cellSize]);

  const prevSelectedHallRef = useRef<HallDefinition | undefined>(undefined);

  useEffect(() => {
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;

    if (selectedHall && selectedHall.vertices.length >= 4) {
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      const minRow = Math.max(1, Math.min(...rows) - SCROLL_MARGIN);
      const maxRow = Math.max(...rows) + SCROLL_MARGIN;
      const minCol = Math.max(1, Math.min(...cols) - SCROLL_MARGIN);
      const maxCol = Math.max(...cols) + SCROLL_MARGIN;

      const hallLeft = (minCol - 1) * cellSize;
      const hallRight = maxCol * cellSize;
      const hallTop = (minRow - 1) * cellSize;
      const hallBottom = maxRow * cellSize;
      const hallWidth = hallRight - hallLeft;
      const hallHeight = hallBottom - hallTop;

      let newOffsetX: number;
      let newOffsetY: number;

      if (hallWidth <= containerWidth) {
        newOffsetX = (containerWidth - hallWidth) / 2 - hallLeft;
      } else {
        newOffsetX = -hallLeft;
      }

      if (hallHeight <= containerHeight) {
        newOffsetY = (containerHeight - hallHeight) / 2 - hallTop;
      } else {
        newOffsetY = -hallTop;
      }

      setOffset({ x: newOffsetX, y: newOffsetY });
    } else if (!selectedHall) {
      setOffset({ x: 0, y: 0 });
    }
  }, [selectedHall, cellSize]);

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

  const executeModeItemIdsSet = useMemo(() => {
    return new Set(executeModeItemIds);
  }, [executeModeItemIds]);

  const cellStates = useMemo(() => {
    const states = new Map<string, MapCellStateDetail>();

    const dayName = extractDayNameFromMapName(mapName);
    const normalizedDayName = normalizeMapRouteDayText(dayName);
    if (!normalizedDayName) return states;

    const getPriorityIndicatorLevel = (item: (typeof items)[number]): PriorityIndicatorLevel | null => {
      const priorityLevel = item.priorityLevel || 'none';
      return priorityLevel === 'priority' || priorityLevel === 'highest' ? priorityLevel : null;
    };

    items.forEach((item) => {
      const itemEventDate = normalizeMapRouteDayText(item.eventDate);
      if (itemEventDate !== normalizedDayName) return;

      const itemBlockName = item.block?.trim() || '';
      let block = mapData.blocks.find((b) => b.name === itemBlockName);

      if (!block) {
        const candidates = mapData.blocks.filter(
          (b) => b.name.toLowerCase() === itemBlockName.toLowerCase(),
        );
        if (candidates.length === 1) {
          block = candidates[0];
        }
      }

      if (!block) return;

      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;

      const num = parseInt(numStr, 10);
      const cell = findRouteLookupNumberCell(block, num);
      if (!cell) return;

      const key = `${cell.row}-${cell.col}`;
      const existing = states.get(key) || {
        hasItems: false,
        itemCount: 0,
        isVisited: false,
        isFullyVisited: false,
        items: [],
        hasPriorityItem: false,
        hasPriorityUnvisited: false,
        hasPriorityLevel: false,
        hasHighestPriorityLevel: false,
      };

      existing.hasItems = true;
      existing.itemCount++;
      existing.items.push(item);

      const priorityIndicatorLevel = getPriorityIndicatorLevel(item);
      if (priorityIndicatorLevel) {
        existing.hasPriorityItem = true;
        if (!executeModeItemIdsSet.has(item.id)) {
          existing.hasPriorityUnvisited = true;
        }
        if (priorityIndicatorLevel === 'highest') {
          existing.hasHighestPriorityLevel = true;
        } else {
          existing.hasPriorityLevel = true;
        }
      }

      if (executeModeItemIdsSet.has(item.id)) {
        existing.isVisited = true;
      }

      states.set(key, existing);
    });

    states.forEach((state) => {
      if (state.items.length > 0) {
        const allVisited = state.items.every((item) => executeModeItemIdsSet.has(item.id));
        state.isFullyVisited = allVisited;
      }
    });

    return states;
  }, [mapData.blocks, items, mapName, executeModeItemIdsSet]);

  const routePoints = useMemo(() => {
    if (!effectiveRouteVisible) return [];
    if (routePointsOverride) return routePointsOverride;
    if (routeInsertSelectionActive) return [];

    const dayName = extractDayNameFromMapName(mapName);
    const normalizedDayName = normalizeMapRouteDayText(dayName);
    if (!normalizedDayName) return [];

    const itemsMap = new Map(items.map((item) => [item.id, item]));
    const executeModeItemIdsArray = Array.from(executeModeItemIds);

    const visitItems = executeModeItemIdsArray
      .map((id) => itemsMap.get(id))
      .filter(
        (item): item is (typeof items)[number] =>
          item !== undefined &&
          normalizeMapRouteDayText(item.eventDate) === normalizedDayName,
      );

    const points: Array<{
      row: number;
      col: number;
      order: number;
      priorityLevel: 'none' | 'priority' | 'highest';
    }> = [];

    visitItems.forEach((item, index) => {
      const itemBlockName = item.block?.trim() || '';

      let block = mapData.blocks.find((b) => b.name === itemBlockName);
      if (!block) {
        const candidates = mapData.blocks.filter(
          (b) => b.name.toLowerCase() === itemBlockName.toLowerCase(),
        );
        if (candidates.length === 1) {
          block = candidates[0];
        }
      }
      if (!block) return;

      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;

      const num = parseInt(numStr, 10);
      const cell = findRouteLookupNumberCell(block, num);
      if (cell) {
        points.push({
          row: cell.row,
          col: cell.col,
          order: index,
          priorityLevel: item.priorityLevel || 'none',
        });
      }
    });

    return points;
  }, [
    mapData.blocks,
    items,
    mapName,
    executeModeItemIds,
    effectiveRouteVisible,
    routePointsOverride,
    routeInsertSelectionActive,
  ]);

  const visibleRouteMarkers = useMemo(
    () => filterFirstRouteMarkers(routePoints),
    [routePoints],
  );

  const routeSegments = useMemo(() => {
    if (!effectiveRouteVisible) return [];
    if (routeSegmentsOverride) return routeSegmentsOverride;
    if (routeInsertSelectionActive) return [];
    if (routePoints.length < 2) return [];

    const segments = generateRouteSegments(mapData, routePoints);
    return segments.map((seg) => ({
      ...seg,
      path: simplifyPath(seg.path),
    }));
  }, [
    effectiveRouteVisible,
    routeSegmentsOverride,
    routeInsertSelectionActive,
    routePoints,
    mapData,
  ]);

  // Cache number cells for quick lookup.
  const numberCellSet = useMemo(() => {
    const set = new Set<string>();
    mapData.blocks.forEach((block) => {
      block.numberCells.forEach((nc) => set.add(`${nc.row}-${nc.col}`));
    });
    return set;
  }, [mapData.blocks]);

  // Cache route crossing data to avoid recalculating it during drag redraws.
  const routeCrossingData = useMemo(() => {
    if (!effectiveRouteVisible || routeSegments.length === 0) return null;

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

    // Use cell-rounded edge keys for parallel route rendering.
    const roundToCell = (v: number): number => Math.round(v);
    const getEdgeKeyLocal = (r1: number, c1: number, r2: number, c2: number): string => {
      const rr1 = roundToCell(r1); const rc1 = roundToCell(c1);
      const rr2 = roundToCell(r2); const rc2 = roundToCell(c2);
      if (rr1 < rr2 || (rr1 === rr2 && rc1 < rc2)) return `${rr1},${rc1}-${rr2},${rc2}`;
      return `${rr2},${rc2}-${rr1},${rc1}`;
    };

    const isGroupTransition = (fromPriority: string | undefined, toPriority: string | undefined): boolean => {
      return (fromPriority || 'none') !== (toPriority || 'none');
    };

    const edgeUsage = new Map<string, Set<'none' | 'priority' | 'highest'>>();
    routeSegments.forEach((segment) => {
      if (segment.path.length < 2) return;
      if (isGroupTransition(segment.fromPriority, segment.toPriority)) return;
      const priority = (segment.fromPriority || 'none') as 'none' | 'priority' | 'highest';
      for (let i = 0; i < segment.path.length - 1; i++) {
        const p1 = segment.path[i];
        const p2 = segment.path[i + 1];
        const key = getEdgeKeyLocal(p1.row, p1.col, p2.row, p2.col);
        if (!edgeUsage.has(key)) edgeUsage.set(key, new Set());
        edgeUsage.get(key)!.add(priority);
      }
    });

    return { crossingLookup, bridgeParams, edgeUsage };
  }, [effectiveRouteVisible, routeSegments, cellSize]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;
    canvas.width = containerWidth * dpr;
    canvas.height = containerHeight * dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.clearRect(0, 0, containerWidth, containerHeight);

    // Read from the ref so dragging reflects the latest offset immediately.
    const currentOffset = offsetRef.current;

    ctx.save();
    ctx.translate(currentOffset.x, currentOffset.y);
    if (rotationRadians !== 0) {
      ctx.translate(mapCenterX, mapCenterY);
      ctx.rotate(rotationRadians);
      ctx.translate(-mapCenterX, -mapCenterY);
    }

    // Inline viewport-to-map coordinate conversion to avoid depending on toMapCoordinates.
    const viewToMap = (viewX: number, viewY: number) => {
      const tx = viewX - currentOffset.x;
      const ty = viewY - currentOffset.y;
      if (rotationRadians === 0) return { x: tx, y: ty };
      const dx = tx - mapCenterX;
      const dy = ty - mapCenterY;
      const cos = Math.cos(rotationRadians);
      const sin = Math.sin(rotationRadians);
      return { x: dx * cos + dy * sin + mapCenterX, y: -dx * sin + dy * cos + mapCenterY };
    };
    const viewportCorners = [
      viewToMap(0, 0),
      viewToMap(containerWidth, 0),
      viewToMap(0, containerHeight),
      viewToMap(containerWidth, containerHeight),
    ];
    const visibleMinX = Math.min(...viewportCorners.map((p) => p.x)) - cellSize * 2;
    const visibleMaxX = Math.max(...viewportCorners.map((p) => p.x)) + cellSize * 2;
    const visibleMinY = Math.min(...viewportCorners.map((p) => p.y)) - cellSize * 2;
    const visibleMaxY = Math.max(...viewportCorners.map((p) => p.y)) + cellSize * 2;

    const visMinCol = Math.max(1, Math.floor(visibleMinX / cellSize) + 1);
    const visMaxCol = Math.min(mapData.maxCol, Math.ceil(visibleMaxX / cellSize) + 1);
    const visMinRow = Math.max(1, Math.floor(visibleMinY / cellSize) + 1);
    const visMaxRow = Math.min(mapData.maxRow, Math.ceil(visibleMaxY / cellSize) + 1);

    const isCellVisible = (row: number, col: number, spanRows = 1, spanCols = 1): boolean => {
      return (
        col + spanCols - 1 >= visMinCol &&
        col <= visMaxCol &&
        row + spanRows - 1 >= visMinRow &&
        row <= visMaxRow
      );
    };

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

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

    const splitTokenByWidth = (token: string, maxLineWidth: number): string[] => {
      const chunks: string[] = [];
      let current = '';

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
      return chunks.length > 0 ? chunks : [''];
    };

    const tokenizeLineForWrap = (line: string): string[] => {
      const tokens: string[] = [];
      let currentAsciiWord = '';

      const flushAsciiWord = () => {
        if (currentAsciiWord.length === 0) return;
        tokens.push(currentAsciiWord);
        currentAsciiWord = '';
      };

      Array.from(line).forEach((char) => {
        if (/\s/.test(char)) {
          flushAsciiWord();
          tokens.push(char);
          return;
        }
        if (/[0-9A-Za-z._-]/.test(char)) {
          currentAsciiWord += char;
          return;
        }
        flushAsciiWord();
        tokens.push(char);
      });
      flushAsciiWord();

      return tokens.length > 0 ? tokens : [''];
    };

    const splitTextByWidth = (sourceText: string, maxLineWidth: number): string[] => {
      const rawLines = sourceText.split('\n');
      const wrappedLines: string[] = [];

      rawLines.forEach((rawLine) => {
        if (rawLine.length === 0) {
          wrappedLines.push('');
          return;
        }

        const tokens = tokenizeLineForWrap(rawLine);
        let current = '';

        tokens.forEach((token) => {
          const next = current + token;
          if (current.length > 0 && ctx.measureText(next).width > maxLineWidth) {
            wrappedLines.push(current.trimEnd());

            const normalizedToken = token.trimStart();
            if (normalizedToken.length === 0) {
              current = '';
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

      return wrappedLines.length > 0 ? wrappedLines : [''];
    };

    const trimLineToWidth = (line: string, maxLineWidth: number): string => {
      let next = line;
      while (next.length > 0 && ctx.measureText(`${next}…`).width > maxLineWidth) {
        next = next.slice(0, -1);
      }
      return next.length > 0 ? `${next}…` : '…';
    };

    const drawFittedHorizontalTextInCell = (
      sourceText: string,
      x: number,
      y: number,
      width: number,
      height: number,
      preferredFontSize: number,
    ) => {
      const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const minFontSize = 6;
      const innerPaddingX = Math.max(1, preferredFontSize * 0.2);
      const innerPaddingY = Math.max(1, preferredFontSize * 0.2);
      const maxLineWidth = Math.max(1, width - innerPaddingX * 2);
      const maxTextHeight = Math.max(1, height - innerPaddingY * 2);

      let resolvedFontSize = Math.max(minFontSize, Math.floor(preferredFontSize));
      let resolvedLineHeight = resolvedFontSize * 1.15;
      let resolvedLines = splitTextByWidth(sourceText, maxLineWidth);

      for (let size = Math.max(minFontSize, Math.floor(preferredFontSize)); size >= minFontSize; size--) {
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
      const maxLines = Math.max(1, Math.floor(maxTextHeight / resolvedLineHeight));
      if (resolvedLines.length > maxLines) {
        const clamped = resolvedLines.slice(0, maxLines);
        clamped[maxLines - 1] = trimLineToWidth(clamped[maxLines - 1], maxLineWidth);
        resolvedLines = clamped;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const totalTextHeight = resolvedLines.length * resolvedLineHeight;
      const startY = y + (height - totalTextHeight) / 2 + resolvedLineHeight / 2;
      const centerX = x + width / 2;

      resolvedLines.forEach((line, lineIndex) => {
        const lineY = startY + lineIndex * resolvedLineHeight;
        drawUprightText(line, centerX, lineY);
      });

      ctx.restore();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };

    const drawFittedVerticalTextInCell = (
      sourceText: string,
      x: number,
      y: number,
      width: number,
      height: number,
      preferredFontSize: number,
    ) => {
      const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const minFontSize = 6;
      const columns = sourceText.split(/\n/).map((line) => line || ' ');
      const innerPaddingX = Math.max(1, preferredFontSize * 0.2);
      const innerPaddingY = Math.max(1, preferredFontSize * 0.2);
      const maxTextWidth = Math.max(1, width - innerPaddingX * 2);
      const maxTextHeight = Math.max(1, height - innerPaddingY * 2);

      const canFitVerticalText = (fontSize: number): boolean => {
        const columnSpacing = fontSize * 1.2;
        const rowSpacing = fontSize * 1.1;
        const requiredWidth = columns.length * columnSpacing;
        const requiredHeight = Math.max(...columns.map((column) => Array.from(column).length)) * rowSpacing;
        return requiredWidth <= maxTextWidth && requiredHeight <= maxTextHeight;
      };

      let resolvedFontSize = Math.max(minFontSize, Math.floor(preferredFontSize));
      for (let size = Math.max(minFontSize, Math.floor(preferredFontSize)); size >= minFontSize; size--) {
        if (canFitVerticalText(size)) {
          resolvedFontSize = size;
          break;
        }
      }

      const columnSpacing = resolvedFontSize * 1.2;
      const rowSpacing = resolvedFontSize * 1.1;
      const maxColumns = Math.max(1, Math.floor(maxTextWidth / columnSpacing));
      const maxRows = Math.max(1, Math.floor(maxTextHeight / rowSpacing));

      let drawableColumns = columns.slice(0, maxColumns).map((column) => Array.from(column));
      const hadHiddenColumns = columns.length > maxColumns;

      drawableColumns = drawableColumns.map((chars) => {
        if (chars.length <= maxRows) return chars;
        const trimmed = chars.slice(0, maxRows);
        trimmed[maxRows - 1] = '…';
        return trimmed;
      });

      if (hadHiddenColumns) {
        const lastColumnIndex = drawableColumns.length - 1;
        const lastColumn = drawableColumns[lastColumnIndex];
        if (lastColumn.length < maxRows) {
          lastColumn.push('…');
        } else {
          lastColumn[lastColumn.length - 1] = '…';
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

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
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };

    const createWarningStripePattern = () => {
      if (isRotationInteracting) return null;
      const patternCanvas = document.createElement('canvas');
      const stripeSize = Math.max(8, cellSize * 0.4);
      patternCanvas.width = stripeSize * 2;
      patternCanvas.height = stripeSize * 2;
      const patternCtx = patternCanvas.getContext('2d');
      if (!patternCtx) return null;

      patternCtx.fillStyle = '#FFD600';
      patternCtx.fillRect(0, 0, stripeSize * 2, stripeSize * 2);

      patternCtx.fillStyle = '#212121';
      patternCtx.beginPath();
      patternCtx.moveTo(0, stripeSize * 2);
      patternCtx.lineTo(stripeSize, stripeSize * 2);
      patternCtx.lineTo(stripeSize * 2, stripeSize);
      patternCtx.lineTo(stripeSize * 2, 0);
      patternCtx.lineTo(stripeSize, 0);
      patternCtx.lineTo(0, stripeSize);
      patternCtx.closePath();
      patternCtx.fill();

      return ctx.createPattern(patternCanvas, 'repeat');
    };

    const warningPattern = createWarningStripePattern();

    if (!isRotationInteracting && vertexSelectionMode && (showSelectionGrid || showSelectionRuler)) {
      if (showSelectionGrid) {
        ctx.save();
        ctx.strokeStyle = isDarkMode ? 'rgba(148, 163, 184, 0.22)' : 'rgba(59, 130, 246, 0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);

        for (let row = visMinRow; row <= visMaxRow + 1; row++) {
          const y = (row - 1) * cellSize;
          ctx.beginPath();
          ctx.moveTo((visMinCol - 1) * cellSize, y);
          ctx.lineTo(visMaxCol * cellSize, y);
          ctx.stroke();
        }

        for (let col = visMinCol; col <= visMaxCol + 1; col++) {
          const x = (col - 1) * cellSize;
          ctx.beginPath();
          ctx.moveTo(x, (visMinRow - 1) * cellSize);
          ctx.lineTo(x, visMaxRow * cellSize);
          ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.restore();
      }

      if (showSelectionRuler) {
        const labelFontSize = Math.max(8, Math.min(11, cellSize * 0.38));
        const topLabelHeight = Math.max(12, cellSize * 0.42);
        const leftLabelWidth = Math.max(18, cellSize * 0.55);
        const labelBg = isDarkMode ? 'rgba(15, 23, 42, 0.78)' : 'rgba(255, 255, 255, 0.82)';
        const labelText = isDarkMode ? '#E2E8F0' : '#1E293B';

        ctx.save();
        ctx.font = `${labelFontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = labelBg;

        for (let col = visMinCol; col <= visMaxCol; col++) {
          const x = (col - 1) * cellSize;
          const y = (visMinRow - 1) * cellSize;
          ctx.fillRect(x, y, cellSize, topLabelHeight);
        }

        for (let row = visMinRow; row <= visMaxRow; row++) {
          const x = (visMinCol - 1) * cellSize;
          const y = (row - 1) * cellSize;
          ctx.fillRect(x, y, leftLabelWidth, cellSize);
        }

        ctx.fillStyle = labelText;
        for (let col = visMinCol; col <= visMaxCol; col++) {
          const x = (col - 0.5) * cellSize;
          const y = (visMinRow - 1) * cellSize + topLabelHeight / 2;
          drawUprightText(String(col), x, y);
        }
        for (let row = visMinRow; row <= visMaxRow; row++) {
          const x = (visMinCol - 1) * cellSize + leftLabelWidth / 2;
          const y = (row - 0.5) * cellSize;
          drawUprightText(String(row), x, y);
        }
        ctx.restore();
      }
    }

    // Resolve number-cell style values outside the loop.
    const outlineStyle = numberCellOutlineStyle;
    const useInset = outlineStyle !== 'none';
    const ncPad = useInset ? cellSize * 0.1 : 0;
    const ncRadius = outlineStyle === 'rounded' ? Math.max(2, cellSize * 0.18) : 0;
    const ncBg = isDarkMode ? '#1E293B' : '#FFFFFF';
    const ncBorder = isDarkMode ? '#475569' : '#CBD5E1';
    const ncBorderWidth = Math.max(1, cellSize * 0.055);
    const drawStroke = outlineStyle !== 'none';
    const isDashed = outlineStyle === 'dashed';

    // Build the cell path once per style.
    const drawCellPath = ncRadius > 0
      ? (rx: number, ry: number, rw: number, rh: number) => ctx.roundRect(rx + ncPad, ry + ncPad, rw - ncPad * 2, rh - ncPad * 2, ncRadius)
      : (rx: number, ry: number, rw: number, rh: number) => ctx.rect(rx + ncPad, ry + ncPad, rw - ncPad * 2, rh - ncPad * 2);

    // Collect geometry for batched drawing.
    const ncRects: { x: number; y: number; w: number; h: number }[] = [];
    const overlayGroups = new Map<string, { x: number; y: number; w: number; h: number }[]>();
    const patternOverlayCells: { x: number; y: number; w: number; h: number }[] = [];

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
      if (state) {
        if (state.isFullyVisited) {
          if (isNumberCell) {
            const color = 'rgba(239, 83, 80, 0.5)';
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = 'rgba(239, 83, 80, 0.5)';
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.hasPriorityUnvisited && warningPattern) {
          if (isNumberCell) {
            patternOverlayCells.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = warningPattern;
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.hasPriorityUnvisited) {
          if (isNumberCell) {
            const color = 'rgba(255, 214, 0, 0.45)';
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = 'rgba(255, 214, 0, 0.45)';
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.isVisited) {
          if (isNumberCell) {
            const color = 'rgba(255, 238, 88, 0.5)';
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = 'rgba(255, 238, 88, 0.5)';
            ctx.fillRect(x, y, width, height);
          }
        } else if (state.hasItems) {
          if (isNumberCell) {
            const color = 'rgba(66, 165, 245, 0.3)';
            if (!overlayGroups.has(color)) overlayGroups.set(color, []);
            overlayGroups.get(color)!.push({ x, y, w: width, h: height });
          } else {
            ctx.fillStyle = 'rgba(66, 165, 245, 0.3)';
            ctx.fillRect(x, y, width, height);
          }
        }
      }
    });

    // Collect geometry for batched drawing.
    if (ncRects.length > 0) {
      ctx.beginPath();
      for (const r of ncRects) drawCellPath(r.x, r.y, r.w, r.h);
      ctx.fillStyle = ncBg;
      ctx.fill();

      // Draw borders.
      if (drawStroke) {
        ctx.strokeStyle = ncBorder;
        ctx.lineWidth = ncBorderWidth;
        if (isDashed) {
          // For dashed borders, reset the dash phase per cell.
          const dashLen = Math.max(2, cellSize * 0.12);
          ctx.setLineDash([dashLen, dashLen]);
          for (const r of ncRects) {
            ctx.beginPath();
            drawCellPath(r.x, r.y, r.w, r.h);
            ctx.stroke();
          }
          ctx.setLineDash([]);
        } else {
          // For rounded and square borders, stroke the batched path once.
          ctx.stroke();
        }
      }

      // Collect geometry for batched drawing.
      for (const [color, rects] of overlayGroups) {
        ctx.beginPath();
        for (const r of rects) drawCellPath(r.x, r.y, r.w, r.h);
        ctx.fillStyle = color;
        ctx.fill();
      }

      // CanvasPattern overlays need per-cell clipping.
      if (warningPattern) {
        for (const r of patternOverlayCells) {
          ctx.save();
          ctx.beginPath();
          drawCellPath(r.x, r.y, r.w, r.h);
          ctx.clip();
          ctx.fillStyle = warningPattern;
          ctx.fillRect(r.x, r.y, r.w, r.h);
          ctx.restore();
        }
      }
    }

    if (showBorders && !isRotationInteracting) {
      type DrawnBorder = NonNullable<CellData['borders']['top']>;
      type BorderEdge = {
        orientation: 'h' | 'v';
        gridX: number;
        gridY: number;
        border: DrawnBorder;
      };

      const borderWeight = (border: DrawnBorder): number => {
        switch (border.style) {
          case 'double':
            return 4;
          case 'thick':
            return 3;
          case 'medium':
            return 2;
          case 'thin':
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

        if (current.color === '#000000' && candidate.color !== '#000000') {
          return candidate;
        }

        return current;
      };

      const edgeMap = new Map<string, BorderEdge>();
      const upsertEdge = (
        orientation: 'h' | 'v',
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

        // Excel merged cells keep edge data distributed across member cells.
        // For the merge parent, right/bottom are often internal edges, so skip them.
        if (merge) {
          if (merge.endCol > merge.startCol) {
            rightBorder = null;
          }
          if (merge.endRow > merge.startRow) {
            bottomBorder = null;
          }
        }

        if (topBorder) {
          upsertEdge('h', startCol, startRow, topBorder);
        }
        if (bottomBorder) {
          upsertEdge('h', startCol, endRow, bottomBorder);
        }
        if (leftBorder) {
          upsertEdge('v', startCol, startRow, leftBorder);
        }
        if (rightBorder) {
          upsertEdge('v', endCol, startRow, rightBorder);
        }
      });

      const softBorderColor = (color: string | undefined): string => {
        const c = color || '#000000';
        if (c === '#000000') return isDarkMode ? '#666666' : '#555555';
        return c;
      };

      edgeMap.forEach(({ orientation, gridX, gridY, border }) => {
        let lineWidth = 1;
        switch (border.style) {
          case 'double':
          case 'thick':
            lineWidth = 3;
            break;
          case 'medium':
            lineWidth = 2;
            break;
          case 'thin':
          default:
            lineWidth = 1;
            break;
        }

        const startX = gridX * cellSize;
        const startY = gridY * cellSize;
        const endX = orientation === 'h' ? (gridX + 1) * cellSize : startX;
        const endY = orientation === 'v' ? (gridY + 1) * cellSize : startY;

        ctx.beginPath();
        ctx.strokeStyle = softBorderColor(border.color);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
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
            const charCount = text.replace(/\n/g, '').length;
            fontSize = Math.min(width * 0.6, (height / (charCount + 1)) * 0.9, 16);
          } else {
            fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
          }
        } else if (typeof cell.value === 'number') {
          fontSize = Math.min(cellSize * 0.45, 14);
        } else {
          fontSize = Math.min(cellSize * 0.4, 12);
        }

        fontSize = Math.max(fontSize, 8);

        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        const explicitFontColor = cell.fontColor?.trim();
        const enforceBlackNumberTextInDarkMode =
          isDarkMode && Boolean(state?.hasItems) && isNumberLikeCellValue(cell.value);

        if (state?.hasPriorityUnvisited && typeof cell.value === 'number') {
          const textMetrics = ctx.measureText(text);
          const textWidth = textMetrics.width;
          const textHeight = fontSize;
          const padding = fontSize * 0.3;

          const bgX = x + width / 2 - textWidth / 2 - padding;
          const bgY = y + height / 2 - textHeight / 2 - padding * 0.5;
          const bgWidth = textWidth + padding * 2;
          const bgHeight = textHeight + padding;
          const radius = Math.min(padding, bgHeight / 2);

          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.beginPath();
          ctx.roundRect(bgX, bgY, bgWidth, bgHeight, radius);
          ctx.fill();

          if (enforceBlackNumberTextInDarkMode && !isWhiteLikeColor(explicitFontColor)) {
            ctx.fillStyle = '#111111';
          } else if (explicitFontColor) {
            ctx.fillStyle = resolveMapTextColorForTheme(explicitFontColor, isDarkMode, '#212121');
          } else {
            ctx.fillStyle = '#212121';
          }
        } else if (enforceBlackNumberTextInDarkMode && !isWhiteLikeColor(explicitFontColor)) {
          ctx.fillStyle = '#111111';
        } else if (explicitFontColor) {
          ctx.fillStyle = resolveMapTextColorForTheme(explicitFontColor, isDarkMode);
        } else if (state?.isFullyVisited) {
          ctx.fillStyle = '#B71C1C';
        } else if (state?.isVisited) {
          ctx.fillStyle = '#F57F17';
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0';
        } else if (numberCellSet.has(`${cell.row}-${cell.col}`)) {
          ctx.fillStyle = isDarkMode ? '#E2E8F0' : '#334155';
        } else {
          ctx.fillStyle = resolveMapTextColorForTheme(cell.fontColor, isDarkMode);
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
              const chars = line.split('');
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
    } else {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        if (!state?.hasItems) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

        const dotSize = Math.max(cellSize * 0.4, 4);
        ctx.beginPath();

        if (state.isFullyVisited) {
          ctx.fillStyle = '#EF5350';
        } else if (state.hasPriorityUnvisited) {
          ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#FFD600';
          ctx.fill();
          ctx.strokeStyle = '#212121';
          ctx.lineWidth = Math.max(1, dotSize * 0.2);
          ctx.stroke();
          return; // Priority markers are drawn with a custom stroked dot, so skip the common fill path.
        } else if (state.isVisited) {
          ctx.fillStyle = '#FFEE58';
        } else {
          ctx.fillStyle = '#42A5F5';
        }

        ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;

      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (!state?.hasPriorityLevel && !state?.hasHighestPriorityLevel) return;

      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const spanCols = merge ? merge.endCol - merge.startCol + 1 : 1;
      const spanRows = merge ? merge.endRow - merge.startRow + 1 : 1;
      if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;

      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;
      const width = spanCols * cellSize;
      const height = spanRows * cellSize;
      const radius = Math.max(3, Math.min(7, Math.min(width, height) * 0.18));
      const inset = Math.max(2, radius * 0.6);
      const cy = y + inset + radius;

      const drawPriorityDot = (level: PriorityIndicatorLevel, cx: number) => {
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = level === 'highest' ? '#EF4444' : '#F97316';
        ctx.fill();
        ctx.lineWidth = Math.max(1, radius * 0.28);
        ctx.strokeStyle = isDarkMode ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.95)';
        ctx.stroke();
      };

      if (state.hasHighestPriorityLevel) {
        drawPriorityDot('highest', x + inset + radius);
      }
      if (state.hasPriorityLevel) {
        drawPriorityDot('priority', x + width - inset - radius);
      }
    });

    if (!isRotationInteracting && effectiveRouteVisible && routeSegments.length > 0 && routeCrossingData) {
      const getPriorityColor = (priority: 'none' | 'priority' | 'highest' | undefined): string => {
        switch (priority) {
          case 'highest':
            return '#EF4444';
          case 'priority':
            return '#F97316';
          default:
            return '#1976D2';
        }
      };

      const isGroupTransition = (
        fromPriority: string | undefined,
        toPriority: string | undefined,
      ): boolean => {
        const from = fromPriority || 'none';
        const to = toPriority || 'none';
        return from !== to;
      };

      const { crossingLookup, bridgeParams, edgeUsage } = routeCrossingData;

      const lineWidth = Math.max(2, cellSize * 0.08);
      const parallelOffset = Math.max(3, cellSize * 0.12);

      // Viewport-culling margin.
      const routeMargin = cellSize * 2;
      const visMinX = visibleMinX - routeMargin;
      const visMaxX = visibleMaxX + routeMargin;
      const visMinY = visibleMinY - routeMargin;
      const visMaxY = visibleMaxY + routeMargin;

      // Use cell-rounded edge keys for parallel route rendering.
      const roundToCell = (v: number): number => Math.round(v);
      const getEdgeKey = (r1: number, c1: number, r2: number, c2: number): string => {
        const rr1 = roundToCell(r1);
        const rc1 = roundToCell(c1);
        const rr2 = roundToCell(r2);
        const rc2 = roundToCell(c2);
        if (rr1 < rr2 || (rr1 === rr2 && rc1 < rc2)) {
          return `${rr1},${rc1}-${rr2},${rc2}`;
        }
        return `${rr2},${rc2}-${rr1},${rc1}`;
      };

      const getOffsetPoints = (
        px1: number,
        py1: number,
        px2: number,
        py2: number,
        offset: number,
      ): { x1: number; y1: number; x2: number; y2: number } => {
        const dx = px2 - px1;
        const dy = py2 - py1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return { x1: px1, y1: py1, x2: px2, y2: py2 };

        const nx = -dy / len;
        const ny = dx / len;

        return {
          x1: px1 + nx * offset,
          y1: py1 + ny * offset,
          x2: px2 + nx * offset,
          y2: py2 + ny * offset,
        };
      };

      const batcher = new BatchedPathRenderer();

      routeSegments.forEach((segment, segIdx) => {
        if (segment.path.length < 2) return;

        const isTransition = isGroupTransition(segment.fromPriority, segment.toPriority);
        const segmentPriority = segment.fromPriority || 'none';
        const baseColor = isTransition ? '#9CA3AF' : getPriorityColor(segment.fromPriority);
        const collector = batcher.beginGroup(baseColor, lineWidth);

        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];
          const edgeKey = getEdgeKey(p1.row, p1.col, p2.row, p2.col);

          let px1 = (p1.col - 0.5) * cellSize;
          let py1 = (p1.row - 0.5) * cellSize;
          let px2 = (p2.col - 0.5) * cellSize;
          let py2 = (p2.row - 0.5) * cellSize;

          if (!isTransition) {
            const usedPriorities = edgeUsage.get(edgeKey);
            const isOverlapping = usedPriorities && usedPriorities.size > 1;

            if (isOverlapping) {
              const priorities = Array.from(usedPriorities!).sort((a, b) => {
                const order = { highest: 0, priority: 1, none: 2 };
                return order[a] - order[b];
              });

              const priorityIndex = priorities.indexOf(segmentPriority);
              if (priorityIndex === -1) continue;

              const totalLines = priorities.length;
              const offsetIndex = priorityIndex - (totalLines - 1) / 2;
              const offset = offsetIndex * parallelOffset;

              const offsetted = getOffsetPoints(px1, py1, px2, py2, offset);
              px1 = offsetted.x1;
              py1 = offsetted.y1;
              px2 = offsetted.x2;
              py2 = offsetted.y2;
            }
          }

          // Viewport culling: skip segments fully outside the view.
          if (px1 < visMinX && px2 < visMinX) continue;
          if (px1 > visMaxX && px2 > visMaxX) continue;
          if (py1 < visMinY && py2 < visMinY) continue;
          if (py1 > visMaxY && py2 > visMaxY) continue;

          // Draw with bridge gaps where route lines cross.
          collectEdgeWithBridges(
            collector, px1, py1, px2, py2,
            segIdx, i,
            crossingLookup, bridgeParams,
          );
        }

        // Draw arrowheads.
        if (segment.path.length >= 2) {
          const last = segment.path[segment.path.length - 1];
          const prev = segment.path[segment.path.length - 2];

          const endX = (last.col - 0.5) * cellSize;
          const endY = (last.row - 0.5) * cellSize;

          // Cull arrowheads outside the viewport.
          if (endX >= visMinX && endX <= visMaxX && endY >= visMinY && endY <= visMaxY) {
            const angle = Math.atan2(
              (last.row - prev.row) * cellSize,
              (last.col - prev.col) * cellSize,
            );

            const arrowSize = Math.max(6, cellSize * 0.25);
            batcher.addTriangle(
              baseColor,
              endX, endY,
              endX - arrowSize * Math.cos(angle - Math.PI / 6),
              endY - arrowSize * Math.sin(angle - Math.PI / 6),
              endX - arrowSize * Math.cos(angle + Math.PI / 6),
              endY - arrowSize * Math.sin(angle + Math.PI / 6),
            );
          }
        }
      });

      batcher.flush(ctx);
      ctx.setLineDash([]);

      if (isDetailedView) {
        visibleRouteMarkers.forEach((point) => {
          const px = (point.col - 0.5) * cellSize;
          const py = (point.row - 0.5) * cellSize;

          // Viewport culling.
          if (px < visMinX || px > visMaxX || py < visMinY || py > visMaxY) return;

          const circleSize = Math.max(12, cellSize * 0.5);
          const pointColor = getPriorityColor(point.priorityLevel);

          ctx.beginPath();
          ctx.fillStyle = pointColor;
          ctx.arc(px, py, circleSize / 2, 0, Math.PI * 2);
          ctx.fill();

          ctx.font = `bold ${Math.max(8, circleSize * 0.6)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#FFFFFF';
          drawUprightText(String(point.order + 1), px, py);
        });
      }
    }

    if (!isRotationInteracting && highlightedCell) {
      const x = (highlightedCell.col - 1) * cellSize;
      const y = (highlightedCell.row - 1) * cellSize;

      ctx.save();

      ctx.strokeStyle = '#FF6B00';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);

      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);

      ctx.restore();
    }

    if (!isRotationInteracting && vertexSelectionMode && hoverGuide) {
      const hoverCellX = (hoverGuide.col - 1) * cellSize;
      const hoverCellY = (hoverGuide.row - 1) * cellSize;
      const hoverCenterX = (hoverGuide.col - 0.5) * cellSize;
      const hoverCenterY = (hoverGuide.row - 0.5) * cellSize;

      ctx.save();
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.strokeRect(hoverCellX + 1, hoverCellY + 1, cellSize - 2, cellSize - 2);

      if (vertexSelectionMode.clickedVertices.length > 0) {
        const lastVertex =
          vertexSelectionMode.clickedVertices[vertexSelectionMode.clickedVertices.length - 1];
        const lastX = (lastVertex.col - 0.5) * cellSize;
        const lastY = (lastVertex.row - 0.5) * cellSize;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(14, 165, 233, 0.85)';
        ctx.lineWidth = Math.max(2, cellSize * 0.08);
        ctx.setLineDash([6, 4]);
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(hoverCenterX, hoverCenterY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const label = `(${hoverGuide.row},${hoverGuide.col})`;
      ctx.font = `${Math.max(10, cellSize * 0.33)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelPaddingX = 7;
      const labelWidth = ctx.measureText(label).width + labelPaddingX * 2;
      const labelHeight = Math.max(18, cellSize * 0.46);
      const labelX = hoverCenterX + labelWidth / 2 + 6;
      const labelY = hoverCenterY - labelHeight / 2 - 6;

      ctx.fillStyle = isDarkMode ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)';
      ctx.fillRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.fillStyle = isDarkMode ? '#E2E8F0' : '#0F172A';
      drawUprightText(label, labelX, labelY);
      ctx.restore();
    }

    if (!isRotationInteracting && vertexSelectionMode && vertexSelectionMode.clickedVertices.length >= 3) {
      const vertices = vertexSelectionMode.clickedVertices;

      const centroidRow = vertices.reduce((s, v) => s + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((s, v) => s + v.col, 0) / vertices.length;
      const sortedVertices = [...vertices].sort((a, b) => {
        return (
          Math.atan2(a.row - centroidRow, a.col - centroidCol) -
          Math.atan2(b.row - centroidRow, b.col - centroidCol)
        );
      });

      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.4)';

      sortedVertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });

      ctx.closePath();
      ctx.fill();

      vertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Draw the vertex order label.
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF0000';
        drawUprightText(String(i + 1), px, py);
      });
    } else if (!isRotationInteracting && vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
      const vertices = vertexSelectionMode.clickedVertices;

      if (vertices.length >= 2) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
        ctx.lineWidth = Math.max(2, cellSize * 0.08);

        vertices.forEach((vertex, i) => {
          const px = (vertex.col - 0.5) * cellSize;
          const py = (vertex.row - 0.5) * cellSize;

          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        });

        ctx.stroke();
      }

      vertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF0000';
        drawUprightText(String(i + 1), px, py);
      });
    }

    if (!isRotationInteracting && cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
      const clickedCells = cellSelectionMode.clickedCells;
      const selType = cellSelectionMode.type;

      if (clickedCells.length >= 2) {
        if (selType === 'individual') {
          clickedCells.forEach((cell) => {
            const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
            const cx = mergeInfo ? (mergeInfo.startCol - 1) * cellSize : (cell.col - 1) * cellSize;
            const cy = mergeInfo ? (mergeInfo.startRow - 1) * cellSize : (cell.row - 1) * cellSize;
            const cw = mergeInfo
              ? (mergeInfo.endCol - mergeInfo.startCol + 1) * cellSize
              : cellSize;
            const ch = mergeInfo
              ? (mergeInfo.endRow - mergeInfo.startRow + 1) * cellSize
              : cellSize;
            ctx.fillStyle = 'rgba(144, 238, 144, 0.35)';
            ctx.fillRect(cx, cy, cw, ch);
          });
        } else {
          const rows = clickedCells.map((c) => c.row);
          const cols = clickedCells.map((c) => c.col);
          const minRow = Math.min(...rows);
          const maxRow = Math.max(...rows);
          const minCol = Math.min(...cols);
          const maxCol = Math.max(...cols);

          let displayMaxRow = maxRow;
          let displayMaxCol = maxCol;
          clickedCells.forEach((cell) => {
            const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
            if (mergeInfo) {
              displayMaxRow = Math.max(displayMaxRow, mergeInfo.endRow);
              displayMaxCol = Math.max(displayMaxCol, mergeInfo.endCol);
            }
          });

          const rx = (minCol - 1) * cellSize;
          const ry = (minRow - 1) * cellSize;
          const rw = (displayMaxCol - minCol + 1) * cellSize;
          const rh = (displayMaxRow - minRow + 1) * cellSize;
          ctx.fillStyle = 'rgba(144, 238, 144, 0.35)';
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = 'rgba(76, 175, 80, 0.7)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 3]);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
        }
      }

      clickedCells.forEach((cell, i) => {
        const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        let px: number, py: number;
        if (mergeInfo) {
          px =
            (mergeInfo.startCol - 1 + (mergeInfo.endCol - mergeInfo.startCol + 1) / 2) * cellSize;
          py =
            (mergeInfo.startRow - 1 + (mergeInfo.endRow - mergeInfo.startRow + 1) / 2) * cellSize;
        } else {
          px = (cell.col - 0.5) * cellSize;
          py = (cell.row - 0.5) * cellSize;
        }

        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Draw the vertex order label.
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#2196F3';
        drawUprightText(String(i + 1), px, py);
      });
    }

    ctx.restore();

    if ((vertexSelectionMode || cellSelectionMode) && tapAssist) {
      const lensRadius = Math.max(36, Math.min(64, cellSize * 1.4));
      const lensDiameter = lensRadius * 2;
      const sourceSize = Math.max(24, cellSize * 1.8);
      const srcX = Math.max(
        0,
        Math.min(containerWidth - sourceSize, tapAssist.viewX - sourceSize / 2),
      );
      const srcY = Math.max(
        0,
        Math.min(containerHeight - sourceSize, tapAssist.viewY - sourceSize / 2),
      );
      const lensCenterX = Math.max(
        lensRadius + 8,
        Math.min(containerWidth - lensRadius - 8, tapAssist.viewX),
      );
      const lensCenterY = Math.max(
        lensRadius + 8,
        Math.min(containerHeight - lensRadius - 8, tapAssist.viewY - lensRadius - 20),
      );

      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(lensCenterX, lensCenterY, lensRadius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fill();
      ctx.clip();
      ctx.drawImage(
        canvas,
        srcX * dpr,
        srcY * dpr,
        sourceSize * dpr,
        sourceSize * dpr,
        lensCenterX - lensRadius,
        lensCenterY - lensRadius,
        lensDiameter,
        lensDiameter,
      );
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(lensCenterX - 10, lensCenterY);
      ctx.lineTo(lensCenterX + 10, lensCenterY);
      ctx.moveTo(lensCenterX, lensCenterY - 10);
      ctx.lineTo(lensCenterX, lensCenterY + 10);
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      const label = `(${tapAssist.row}, ${tapAssist.col})`;
      const labelPaddingX = 7;
      const labelPaddingY = 4;
      const labelY = lensCenterY + lensRadius + 12;
      ctx.save();
      ctx.font = `${Math.max(10, cellSize * 0.34)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelWidth = ctx.measureText(label).width + labelPaddingX * 2;
      const labelHeight = Math.max(18, cellSize * 0.45) + labelPaddingY;
      const labelX = Math.max(
        labelWidth / 2 + 8,
        Math.min(containerWidth - labelWidth / 2 - 8, lensCenterX),
      );
      ctx.fillStyle = isDarkMode ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)';
      ctx.fillRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = 1;
      ctx.strokeRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.fillStyle = isDarkMode ? '#E2E8F0' : '#0F172A';
      ctx.fillText(label, labelX, labelY);
      ctx.restore();
    }
  }, [
    mapData,
    cellSize,
    cellStates,
    numberCellSet,
    mergedCellsMap,
    effectiveRouteVisible,
    routeSegments,
    visibleRouteMarkers,
    dpr,
    isDetailedView,
    showNumbers,
    showBorders,
    showSelectionGrid,
    showSelectionRuler,
    vertexSelectionMode,
    cellSelectionMode,
    highlightedCell,
    hoverGuide,
    tapAssist,
    isDarkMode,
    isRotationInteracting,
    rotationRadians,
    mapCenterX,
    mapCenterY,
    numberCellOutlineStyle,
    routeCrossingData,
  ]);

  // Keep drawCanvasRef current so rAF can call the latest draw function.
  drawCanvasRef.current = drawCanvas;

  // Redraw when dependencies change.
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  const hasRouteInsertRouteSnapshot =
    routeInsertSelectionActive &&
    routePointsOverride !== undefined &&
    routeSegmentsOverride !== undefined;

  const canHitTestRouteInsert =
    hasRouteInsertRouteSnapshot &&
    routePointsOverride.length >= 2 &&
    routeSegmentsOverride.length > 0;

  const getRouteInsertMissKind = useCallback(
    (row: number, col: number): 'cell' | 'blank' => {
      if (!routeInsertSelectionActive) return 'blank';
      if (!routeInsertMissMapDataOverride) return 'blank';

      const missMapData = routeInsertMissMapDataOverride;
      if (row < 1 || row > missMapData.maxRow || col < 1 || col > missMapData.maxCol) {
        return 'blank';
      }

      const isOnMissMap =
        missMapData.cells.some((cell) => cell.row === row && cell.col === col) ||
        missMapData.blocks.some((block) =>
          block.numberCells.some((numberCell) => numberCell.row === row && numberCell.col === col),
        ) ||
        missMapData.mergedCells.some(
          (merge) =>
            row >= merge.startRow &&
            row <= merge.endRow &&
            col >= merge.startCol &&
            col <= merge.endCol,
        );

      if (!isOnMissMap) return 'blank';
      return cellStates.has(`${row}-${col}`) || isOnMissMap ? 'cell' : 'blank';
    },
    [cellStates, routeInsertMissMapDataOverride, routeInsertSelectionActive],
  );

  const handleTapAtViewPosition = useCallback(
    (viewX: number, viewY: number, pointerType: string) => {
      const { x, y } = toMapCoordinates(viewX, viewY);
      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;

      if (routeInsertSelectionActive) {
        if (canHitTestRouteInsert) {
          const hit = hitTestMapRoute({
            mapX: x,
            mapY: y,
            cellSize,
            routePoints: routePointsOverride ?? [],
            routeSegments: routeSegmentsOverride ?? [],
          });

          if (hit) {
            onRouteInsertHit?.(hit);
            return;
          }
        }

        onRouteInsertMiss?.({ kind: getRouteInsertMissKind(row, col) });
        return;
      }

      if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize;

        for (const vertex of vertexSelectionMode.clickedVertices) {
          const markerX = (vertex.col - 0.5) * cellSize;
          const markerY = (vertex.row - 0.5) * cellSize;
          const distance = Math.sqrt(Math.pow(x - markerX, 2) + Math.pow(y - markerY, 2));

          if (distance <= clickRadius) {
            window.dispatchEvent(
              new CustomEvent('mapCellClick', {
                detail: { row: vertex.row, col: vertex.col },
              }),
            );
            return;
          }
        }
      }

      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }

      if (cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize;

        for (const cell of cellSelectionMode.clickedCells) {
          const mi = mergedCellsMap.get(`${cell.row}-${cell.col}`);
          let mx: number, my: number;
          if (mi) {
            mx = (mi.startCol - 1 + (mi.endCol - mi.startCol + 1) / 2) * cellSize;
            my = (mi.startRow - 1 + (mi.endRow - mi.startRow + 1) / 2) * cellSize;
          } else {
            mx = (cell.col - 0.5) * cellSize;
            my = (cell.row - 0.5) * cellSize;
          }
          const distance = Math.sqrt(Math.pow(x - mx, 2) + Math.pow(y - my, 2));
          if (distance <= clickRadius) {
            window.dispatchEvent(
              new CustomEvent('mapCellClick', {
                detail: { row: cell.row, col: cell.col },
              }),
            );
            return;
          }
        }
      }

      let resolvedRow = row;
      let resolvedCol = col;
      if (cellSelectionMode) {
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
      }

      const shouldShowTapAssist =
        (vertexSelectionMode || cellSelectionMode) &&
        (pointerType === 'touch' || pointerType === 'pen');
      if (shouldShowTapAssist) {
        showTapAssist({
          row: resolvedRow,
          col: resolvedCol,
          viewX,
          viewY,
        });
      }

      window.dispatchEvent(
        new CustomEvent('mapCellClick', {
          detail: { row: resolvedRow, col: resolvedCol },
        }),
      );

      const state = cellStates.get(`${row}-${col}`);
      const matchingItems = state?.items || [];

      onCellClick(row, col, matchingItems);
    },
    [
      cellSize,
      canHitTestRouteInsert,
      getRouteInsertMissKind,
      mapData.maxRow,
      mapData.maxCol,
      mapData.mergedCells,
      cellStates,
      onCellClick,
      onRouteInsertHit,
      onRouteInsertMiss,
      vertexSelectionMode,
      cellSelectionMode,
      showTapAssist,
      mergedCellsMap,
      routeInsertSelectionActive,
      routePointsOverride,
      routeSegmentsOverride,
      toMapCoordinates,
    ],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDraggingRef.current) return;

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now < suppressClickUntilRef.current) return;

      const metrics = getPointerViewMetrics(e.clientX, e.clientY);
      if (!metrics) return;

      handleTapAtViewPosition(metrics.viewX, metrics.viewY, lastPointerTypeRef.current);
    },
    [getPointerViewMetrics, handleTapAtViewPosition],
  );

  const hallScrollBounds = useMemo(() => {
    if (selectedHall && selectedHall.vertices.length >= 4) {
      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      return {
        minRow: Math.max(1, Math.min(...rows) - SCROLL_MARGIN),
        maxRow: Math.max(...rows) + SCROLL_MARGIN,
        minCol: Math.max(1, Math.min(...cols) - SCROLL_MARGIN),
        maxCol: Math.max(...cols) + SCROLL_MARGIN,
      };
    }
    return null;
  }, [selectedHall]);

  const filledCellScrollBounds = useMemo(() => {
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

    if (!hasBounds) return null;
    return {
      minRow: minRow - FILLED_SCROLL_MARGIN,
      maxRow: maxRow + FILLED_SCROLL_MARGIN,
      minCol: minCol - FILLED_SCROLL_MARGIN,
      maxCol: maxCol + FILLED_SCROLL_MARGIN,
    };
  }, [mapData.cells, mapData.mergedCells]);

  const activeScrollBounds = useMemo(
    () => filledCellScrollBounds || hallScrollBounds,
    [filledCellScrollBounds, hallScrollBounds],
  );

  const calculateScrollLimits = useCallback(() => {
    if (!activeScrollBounds) return null;
    const container = containerRef.current;
    if (!container) return null;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const boundsLeft = (activeScrollBounds.minCol - 1) * cellSize;
    const boundsRight = activeScrollBounds.maxCol * cellSize;
    const boundsTop = (activeScrollBounds.minRow - 1) * cellSize;
    const boundsBottom = activeScrollBounds.maxRow * cellSize;

    const rotatedCorners = [
      rotateAroundMapCenter(boundsLeft, boundsTop),
      rotateAroundMapCenter(boundsRight, boundsTop),
      rotateAroundMapCenter(boundsLeft, boundsBottom),
      rotateAroundMapCenter(boundsRight, boundsBottom),
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
  }, [activeScrollBounds, cellSize, rotateAroundMapCenter]);

  useEffect(() => {
    if (!vertexSelectionMode) {
      setHoverGuide(null);
    }
  }, [vertexSelectionMode]);

  const updateHoverGuideFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const metrics = getPointerViewMetrics(clientX, clientY);
      if (!metrics) {
        setHoverGuide(null);
        return;
      }

      const { viewX, viewY } = metrics;
      const { x, y } = toMapCoordinates(viewX, viewY);
      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;

      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        setHoverGuide(null);
        return;
      }

      setHoverGuide((prev) => {
        if (prev && prev.row === row && prev.col === col) {
          return prev;
        }
        return { row, col, viewX, viewY };
      });
    },
    [cellSize, getPointerViewMetrics, mapData.maxRow, mapData.maxCol, toMapCoordinates],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      if (e.pointerType === 'touch' || e.pointerType === 'pen') {
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
      lastPointerTypeRef.current = e.pointerType;
      if (e.pointerType === 'mouse' && vertexSelectionMode) {
        updateHoverGuideFromPointer(e.clientX, e.clientY);
      } else if (e.pointerType !== 'mouse' && hoverGuide) {
        setHoverGuide(null);
      }

      if ((e.pointerType === 'touch' || e.pointerType === 'pen') && isPinchGestureRef.current) {
        return;
      }
      if (e.buttons !== 1) return;
      if (activeTouchesRef.current.size >= 2) return;

      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;

      const dragThreshold =
        lastPointerTypeRef.current === 'touch' || lastPointerTypeRef.current === 'pen' ? 10 : 5;
      if (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) {
        isDraggingRef.current = true;
        setIsDragging(true);
      }

      const dragPanMultiplier = getDragPanMultiplier(zoomLevelRef.current);
      let newX = dragStartOffsetRef.current.x + dx * dragPanMultiplier;
      let newY = dragStartOffsetRef.current.y + dy * dragPanMultiplier;

      const limits = calculateScrollLimits();
      if (limits) {
        newX = Math.max(limits.minX, Math.min(limits.maxX, newX));
        newY = Math.max(limits.minY, Math.min(limits.maxY, newY));
      }

      const nextOffset = {
        x: newX,
        y: newY,
      };
      // During drag, update only the ref and redraw via rAF to avoid React rerenders.
      offsetRef.current = nextOffset;
      if (!rafPendingRef.current) {
        rafPendingRef.current = true;
        requestAnimationFrame(() => {
          rafPendingRef.current = false;
          drawCanvasRef.current?.();
        });
      }
    },
    [
      calculateScrollLimits,
      hoverGuide,
      updateHoverGuideFromPointer,
      vertexSelectionMode,
    ],
  );

  const finishPointerInteraction = useCallback(() => {
    isDraggingRef.current = false;
    // During drag, update only the ref and redraw via rAF to avoid React rerenders.
    setOffsetState(offsetRef.current);
    setTimeout(() => {
      setIsDragging(false);
    }, 100);
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      const wasDragging = isDraggingRef.current;
      const isTouchPointer = e.pointerType === 'touch' || e.pointerType === 'pen';
      if (isTouchPointer) {
        e.preventDefault();
      }

      if (!wasDragging && isTouchPointer && !isPinchGestureRef.current) {
        const metrics = getPointerViewMetrics(e.clientX, e.clientY);
        if (metrics) {
          handleTapAtViewPosition(metrics.viewX, metrics.viewY, e.pointerType);
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          suppressClickUntilRef.current = now + 450;
        }
      } else if (wasDragging) {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        suppressClickUntilRef.current = now + 450;
      }

      finishPointerInteraction();
    },
    [finishPointerInteraction, getPointerViewMetrics, handleTapAtViewPosition],
  );

  const handlePointerLeave = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      setHoverGuide(null);
      finishPointerInteraction();
    },
    [finishPointerInteraction],
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      setHoverGuide(null);
      finishPointerInteraction();
    },
    [finishPointerInteraction],
  );

  return (
    <MapCanvasPresentation
      containerRef={containerRef}
      canvasRef={canvasRef}
      isDragging={isDragging}
      onCanvasClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerCancel}
      cursor={isDragging ? 'grabbing' : routeInsertSelectionActive ? 'crosshair' : 'grab'}
    />
  );
};

export default React.memo(MapCanvas);







