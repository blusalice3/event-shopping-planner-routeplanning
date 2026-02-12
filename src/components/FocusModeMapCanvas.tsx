import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  MergedCellInfo,
  HallDefinition,
  BlockDefinition,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../types';
import { extractNumberFromItemNumber } from '../utils/xlsxMapParser';
import { findPath, simplifyPath } from '../utils/pathfinding';

interface FocusModeMapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  zoomLevel: number;
  selectedHall: HallDefinition | null;
  currentVisitKey: string | null;
  nextVisitKey: string | null;
  prevVisitKey: string | null;
  currentPhase: 'normal' | 'postponed' | 'late';
  onZoomChange?: (newZoom: number) => void;
  onCellClick?: (blockName: string, number: number, matchingItems: ShoppingItem[]) => void;
  appZoomLevel?: number;
  hallDefinitions?: HallDefinition[];
  rotationAngle?: number;
  onRotationAngleChange?: (angle: number) => void;
}

const BASE_CELL_SIZE = 28;
const SCROLL_MARGIN = 5;

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const rotatePointAroundCenter = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  angleRad: number,
): { x: number; y: number } => {
  if (angleRad === 0) return { x, y };
  const dx = x - centerX;
  const dy = y - centerY;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: dx * cos - dy * sin + centerX,
    y: dx * sin + dy * cos + centerY,
  };
};

const extractBaseNumber = (number: string): string => {
  const match = number.match(/^(\d+[a-zA-Z])/);
  return match ? match[1].toLowerCase() : number.toLowerCase();
};

const getVisitKey = (item: ShoppingItem): string => {
  const baseNumber = extractBaseNumber(item.number);
  return `${item.eventDate}-${item.block}-${baseNumber}`;
};

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

const FocusModeMapCanvas: React.FC<FocusModeMapCanvasProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds: _executeModeItemIds,
  zoomLevel,
  selectedHall,
  currentVisitKey,
  nextVisitKey,
  prevVisitKey,
  currentPhase,
  onZoomChange,
  onCellClick,
  appZoomLevel = 100,
  hallDefinitions,
  rotationAngle = 0,
  onRotationAngleChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  const [isRotationInteracting, setIsRotationInteracting] = useState(false);
  const rotationInteractionTimerRef = useRef<number | null>(null);

  // ピンチ操作中のタッチ座標を識別子ごとに保持する。
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartDistRef = useRef<number>(0);
  const pinchStartZoomRef = useRef<number>(zoomLevel);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scale = zoomLevel / 100;
  const appScale = Math.max(0.01, appZoomLevel / 100);
  const cellSize = BASE_CELL_SIZE * scale;
  const isDarkMode =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;

  const prevSelectedHallRef = useRef<HallDefinition | null>(null);
  const normalizedRotationAngle = useMemo(
    () => normalizeRotationAngle(rotationAngle),
    [rotationAngle],
  );
  const rotationRadians = useMemo(
    () => (normalizedRotationAngle * Math.PI) / 180,
    [normalizedRotationAngle],
  );
  const mapCenterX = useMemo(() => (mapData.maxCol * cellSize) / 2, [mapData.maxCol, cellSize]);
  const mapCenterY = useMemo(() => (mapData.maxRow * cellSize) / 2, [mapData.maxRow, cellSize]);

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
    return dayMatch ? dayMatch[1].trim() : '';
  }, [mapName]);

  const cellStates = useMemo(() => {
    const states = new Map<
      string,
      {
        hasItems: boolean;
        items: ShoppingItem[];
        visitKeys: Set<string>;
        isCurrentPosition: boolean;
        isNextDestination: boolean;
        isPreviousPosition: boolean;
        allNone: boolean;
        allProcessed: boolean;
        hasPostponed: boolean;
        hasLate: boolean;
        isVisited: boolean;
      }
    >();

    if (!dayName) return states;

    items.forEach((item) => {
      const itemEventDate = item.eventDate?.trim() || '';
      if (itemEventDate !== dayName) return;

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
      const cell = block.numberCells.find((nc) => nc.value === num);
      if (!cell) return;

      const key = `${cell.row}-${cell.col}`;
      const visitKey = getVisitKey(item);
      const existing = states.get(key) || {
        hasItems: false,
        items: [],
        visitKeys: new Set<string>(),
        isCurrentPosition: false,
        isNextDestination: false,
        isPreviousPosition: false,
        allNone: true,
        allProcessed: true,
        hasPostponed: false,
        hasLate: false,
        isVisited: false,
      };

      existing.hasItems = true;
      existing.items.push(item);
      existing.visitKeys.add(visitKey);

      if (item.purchaseStatus === 'None') {
        existing.allProcessed = false;
      } else {
        existing.allNone = false;
      }
      if (item.purchaseStatus === 'Postpone') {
        existing.hasPostponed = true;
      }
      if (item.purchaseStatus === 'Late') {
        existing.hasLate = true;
      }

      states.set(key, existing);
    });

    states.forEach((state, _key) => {
      const hasFinalStatus = state.items.some(
        (item) =>
          item.purchaseStatus === 'Purchased' ||
          item.purchaseStatus === 'SoldOut' ||
          item.purchaseStatus === 'Absent',
      );
      const onlyPostponedOrLate = state.items.every(
        (item) => item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late',
      );
      state.isVisited =
        !state.allNone && (hasFinalStatus || (!state.allNone && !onlyPostponedOrLate));

      if (currentVisitKey && state.visitKeys.has(currentVisitKey)) {
        state.isCurrentPosition = true;
      }
      if (nextVisitKey && state.visitKeys.has(nextVisitKey)) {
        state.isNextDestination = true;
      }
      if (prevVisitKey && state.visitKeys.has(prevVisitKey)) {
        state.isPreviousPosition = true;
      }
    });

    return states;
  }, [mapData.blocks, items, dayName, currentVisitKey, nextVisitKey, prevVisitKey]);

  const currentCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isCurrentPosition) {
        const [row, col] = key.split('-').map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  const nextCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isNextDestination) {
        const [row, col] = key.split('-').map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  const prevCellCoords = useMemo(() => {
    for (const [key, state] of cellStates.entries()) {
      if (state.isPreviousPosition) {
        const [row, col] = key.split('-').map(Number);
        return { row, col };
      }
    }
    return null;
  }, [cellStates]);

  const routePath = useMemo(() => {
    if (!currentCellCoords || !nextCellCoords) return [];

    const blockNameCells = new Set<string>();
    mapData.blocks.forEach((block) => {
      for (let r = block.startRow; r <= block.endRow; r++) {
        for (let c = block.startCol; c <= block.endCol; c++) {
          const cell = cellsMap.get(`${r}-${c}`);
          if (cell && cell.value !== null && typeof cell.value === 'string') {
            blockNameCells.add(`${r}-${c}`);
          }
        }
      }
    });

    const path = findPath(
      mapData,
      currentCellCoords.row,
      currentCellCoords.col,
      nextCellCoords.row,
      nextCellCoords.col,
      blockNameCells,
    );

    return simplifyPath(path);
  }, [currentCellCoords, nextCellCoords, mapData, cellsMap]);

  const prevRoutePath = useMemo(() => {
    if (!prevCellCoords || !currentCellCoords) return [];

    if (
      prevCellCoords.row === currentCellCoords.row &&
      prevCellCoords.col === currentCellCoords.col
    )
      return [];

    const blockNameCells = new Set<string>();
    mapData.blocks.forEach((block) => {
      for (let r = block.startRow; r <= block.endRow; r++) {
        for (let c = block.startCol; c <= block.endCol; c++) {
          const cell = cellsMap.get(`${r}-${c}`);
          if (cell && cell.value !== null && typeof cell.value === 'string') {
            blockNameCells.add(`${r}-${c}`);
          }
        }
      }
    });

    const path = findPath(
      mapData,
      prevCellCoords.row,
      prevCellCoords.col,
      currentCellCoords.row,
      currentCellCoords.col,
      blockNameCells,
    );

    return simplifyPath(path);
  }, [prevCellCoords, currentCellCoords, mapData, cellsMap]);

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
          if (yi > row !== yj > row && col < ((xj - xi) * (row - yi)) / (yj - yi) + xi) {
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
    const currentHall = findHallForCell(currentCellCoords.row, currentCellCoords.col);
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
      bounds: { minRow: number; maxRow: number; minCol: number; maxCol: number },
      containerWidth: number,
      containerHeight: number,
    ): number => {
      const bWidth = bounds.maxCol - bounds.minCol + 1;
      const bHeight = bounds.maxRow - bounds.minRow + 1;
      const requiredWidthZoom = (containerWidth / (bWidth * BASE_CELL_SIZE)) * 100;
      const requiredHeightZoom = (containerHeight / (bHeight * BASE_CELL_SIZE)) * 100;
      return Math.min(requiredWidthZoom, requiredHeightZoom, 100);
    },
    [],
  );

  const effectiveShowPrevRef = useRef<boolean>(true);

  const routeBounds = routeBoundsCurrentNext;

  const prevVisitKeyRef = useRef<string | null>(null);

  const toMapCoordinates = useCallback(
    (viewX: number, viewY: number, currentOffset = offset) => {
      const translatedX = viewX - currentOffset.x;
      const translatedY = viewY - currentOffset.y;
      if (rotationRadians === 0) return { x: translatedX, y: translatedY };

      const dx = translatedX - mapCenterX;
      const dy = translatedY - mapCenterY;
      const cos = Math.cos(rotationRadians);
      const sin = Math.sin(rotationRadians);

      return {
        x: dx * cos + dy * sin + mapCenterX,
        y: -dx * sin + dy * cos + mapCenterY,
      };
    },
    [offset, rotationRadians, mapCenterX, mapCenterY],
  );

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
    setIsRotationInteracting(true);
    if (rotationInteractionTimerRef.current !== null) {
      clearTimeout(rotationInteractionTimerRef.current);
    }
    rotationInteractionTimerRef.current = window.setTimeout(() => {
      setIsRotationInteracting(false);
      rotationInteractionTimerRef.current = null;
    }, 150);

    return () => {
      if (rotationInteractionTimerRef.current !== null) {
        clearTimeout(rotationInteractionTimerRef.current);
      }
    };
  }, [normalizedRotationAngle]);


  useEffect(() => {
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;

    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    if (routeBoundsCurrentNext && currentCellCoords) {
      let useBounds = routeBoundsCurrentNext;

      if (showPrevRoute && routeBoundsAll) {
        const allZoom = calcOptimalZoom(routeBoundsAll, containerWidth, containerHeight);
        if (allZoom >= MIN_ZOOM) {
          useBounds = routeBoundsAll;
          effectiveShowPrevRef.current = true;
        } else {
          effectiveShowPrevRef.current = false;
        }
      } else {
        effectiveShowPrevRef.current = false;
      }

      const optimalZoom = calcOptimalZoom(useBounds, containerWidth, containerHeight);
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(optimalZoom)));

      if (onZoomChange) {
        onZoomChange(newZoom);
      }

      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const routeCenterCol = (useBounds.minCol + useBounds.maxCol) / 2;
      const routeCenterRow = (useBounds.minRow + useBounds.maxRow) / 2;
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
    routeBoundsCurrentNext,
    routeBoundsAll,
    currentCellCoords,
    onZoomChange,
    showPrevRoute,
    calcOptimalZoom,
    calculateCenteredOffset,
  ]);

  useEffect(() => {
    if (prevVisitKeyRef.current === currentVisitKey) {
      return;
    }
    prevVisitKeyRef.current = currentVisitKey;

    if (!routeBoundsCurrentNext || !currentCellCoords) return;
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    let useBounds = routeBoundsCurrentNext;
    let useShowPrev = false;

    if (showPrevRoute && routeBoundsAll) {
      const allZoom = calcOptimalZoom(routeBoundsAll, containerWidth, containerHeight);
      if (allZoom >= MIN_ZOOM) {
        useBounds = routeBoundsAll;
        useShowPrev = true;
      }
    }

    effectiveShowPrevRef.current = useShowPrev;

    const optimalZoom = calcOptimalZoom(useBounds, containerWidth, containerHeight);
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(optimalZoom)));

    if (onZoomChange) {
      onZoomChange(newZoom);
    }

    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    const routeCenterCol = (useBounds.minCol + useBounds.maxCol) / 2;
    const routeCenterRow = (useBounds.minRow + useBounds.maxRow) / 2;
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
    currentVisitKey,
    routeBoundsCurrentNext,
    routeBoundsAll,
    currentCellCoords,
    onZoomChange,
    showPrevRoute,
    calcOptimalZoom,
    calculateCenteredOffset,
  ]);

  useEffect(() => {
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

    ctx.save();
    ctx.translate(offset.x, offset.y);
    if (rotationRadians !== 0) {
      ctx.translate(mapCenterX, mapCenterY);
      ctx.rotate(rotationRadians);
      ctx.translate(-mapCenterX, -mapCenterY);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const viewportCorners = [
      toMapCoordinates(0, 0),
      toMapCoordinates(containerWidth, 0),
      toMapCoordinates(0, containerHeight),
      toMapCoordinates(containerWidth, containerHeight),
    ];
    const visibleMinX = Math.min(...viewportCorners.map((point) => point.x)) - cellSize * 2;
    const visibleMaxX = Math.max(...viewportCorners.map((point) => point.x)) + cellSize * 2;
    const visibleMinY = Math.min(...viewportCorners.map((point) => point.y)) - cellSize * 2;
    const visibleMaxY = Math.max(...viewportCorners.map((point) => point.y)) + cellSize * 2;

    const visMinCol = Math.max(1, Math.floor(visibleMinX / cellSize) + 1);
    const visMaxCol = Math.min(mapData.maxCol, Math.ceil(visibleMaxX / cellSize) + 1);
    const visMinRow = Math.max(1, Math.floor(visibleMinY / cellSize) + 1);
    const visMaxRow = Math.min(mapData.maxRow, Math.ceil(visibleMaxY / cellSize) + 1);

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

      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }

      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state && state.hasItems) {
        if (state.isCurrentPosition) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.6)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isNextDestination) {
          ctx.fillStyle = 'rgba(255, 152, 0, 0.6)';
          ctx.fillRect(x, y, width, height);
        } else if (effectiveShowPrevRef.current && state.isPreviousPosition) {
          ctx.fillStyle = 'rgba(139, 148, 191, 0.45)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          ctx.fillStyle = 'rgba(158, 158, 158, 0.5)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPostponed && currentPhase !== 'postponed') {
          ctx.fillStyle = 'rgba(156, 39, 176, 0.4)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasLate && currentPhase !== 'late') {
          ctx.fillStyle = 'rgba(33, 150, 243, 0.4)';
          ctx.fillRect(x, y, width, height);
        } else if (state.allNone) {
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)';
          ctx.fillRect(x, y, width, height);
        }
      }
    });

    // 2. セルの罫線を描画する。
    if (showBorders && !isRotationInteracting) {
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

        const drawBorder = (
          fromX: number,
          fromY: number,
          toX: number,
          toY: number,
          border: { style: string; color: string } | null,
        ) => {
          if (!border || border.style === 'none') return;

          ctx.beginPath();
          ctx.strokeStyle = border.color || '#000000';
          let lineWidth = 1;
          switch (border.style) {
            case 'thin':
              lineWidth = 1;
              break;
            case 'medium':
              lineWidth = 2;
              break;
            case 'thick':
              lineWidth = 3;
              break;
            default:
              lineWidth = 1;
          }
          ctx.lineWidth = lineWidth;
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(toX, toY);
          ctx.stroke();
        };

        if (cell.borders) {
          drawBorder(x, y, x + width, y, cell.borders.top);
          drawBorder(x + width, y, x + width, y + height, cell.borders.right);
          drawBorder(x, y + height, x + width, y + height, cell.borders.bottom);
          drawBorder(x, y, x, y + height, cell.borders.left);
        }
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
        if (explicitFontColor) {
          ctx.fillStyle = resolveMapTextColorForTheme(explicitFontColor, isDarkMode);
        } else if (state?.isCurrentPosition) {
          ctx.fillStyle = '#E65100';
        } else if (state?.isVisited) {
          ctx.fillStyle = resolveMapTextColorForTheme('#616161', isDarkMode);
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0';
        } else {
          ctx.fillStyle = resolveMapTextColorForTheme(cell.fontColor, isDarkMode);
        }

        if (isVertical) {
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
        } else {
          drawUprightText(text, x + width / 2, y + height / 2);
        }
      });
    }

    const isPrevSameAsCurrent =
      prevCellCoords &&
      currentCellCoords &&
      prevCellCoords.row === currentCellCoords.row &&
      prevCellCoords.col === currentCellCoords.col;

    if (
      !isRotationInteracting &&
      effectiveShowPrevRef.current &&
      prevRoutePath.length >= 2 &&
      !isPrevSameAsCurrent
    ) {
      const lineWidth = Math.max(2, cellSize * 0.08);

      ctx.beginPath();
      ctx.strokeStyle = 'rgba(156, 163, 175, 0.6)';
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);

      prevRoutePath.forEach((point, i) => {
        const px = (point.col - 0.5) * cellSize;
        const py = (point.row - 0.5) * cellSize;

        if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });
      ctx.stroke();

      if (prevRoutePath.length >= 1) {
        const first = prevRoutePath[0];
        const startX = (first.col - 0.5) * cellSize;
        const startY = (first.row - 0.5) * cellSize;
        const dotRadius = Math.max(3, cellSize * 0.1);
        ctx.beginPath();
        ctx.fillStyle = 'rgba(156, 163, 175, 0.7)';
        ctx.arc(startX, startY, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      if (prevRoutePath.length >= 2) {
        const last = prevRoutePath[prevRoutePath.length - 1];
        const prev = prevRoutePath[prevRoutePath.length - 2];

        const endX = (last.col - 0.5) * cellSize;
        const endY = (last.row - 0.5) * cellSize;
        const angle = Math.atan2(
          (last.row - prev.row) * cellSize,
          (last.col - prev.col) * cellSize,
        );

        const arrowSize = Math.max(6, cellSize * 0.2);
        ctx.beginPath();
        ctx.fillStyle = 'rgba(156, 163, 175, 0.7)';
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle - Math.PI / 6),
          endY - arrowSize * Math.sin(angle - Math.PI / 6),
        );
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle + Math.PI / 6),
          endY - arrowSize * Math.sin(angle + Math.PI / 6),
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    const isSamePosition =
      currentCellCoords &&
      nextCellCoords &&
      currentCellCoords.row === nextCellCoords.row &&
      currentCellCoords.col === nextCellCoords.col;

    if (!isRotationInteracting && routePath.length >= 2 && !isSamePosition) {
      const lineWidth = Math.max(3, cellSize * 0.1);

      ctx.beginPath();
      ctx.strokeStyle = '#FF5722';
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.setLineDash([cellSize * 0.2, cellSize * 0.1]);

      routePath.forEach((point, i) => {
        const px = (point.col - 0.5) * cellSize;
        const py = (point.row - 0.5) * cellSize;

        if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });
      ctx.stroke();
      ctx.setLineDash([]);

      if (routePath.length >= 2) {
        const last = routePath[routePath.length - 1];
        const prev = routePath[routePath.length - 2];

        const endX = (last.col - 0.5) * cellSize;
        const endY = (last.row - 0.5) * cellSize;
        const angle = Math.atan2(
          (last.row - prev.row) * cellSize,
          (last.col - prev.col) * cellSize,
        );

        const arrowSize = Math.max(8, cellSize * 0.3);
        ctx.beginPath();
        ctx.fillStyle = '#FF5722';
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle - Math.PI / 6),
          endY - arrowSize * Math.sin(angle - Math.PI / 6),
        );
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle + Math.PI / 6),
          endY - arrowSize * Math.sin(angle + Math.PI / 6),
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    if (!isRotationInteracting) {
      cellStates.forEach((state, key) => {
        if (!state.hasItems) return;

        const [row, col] = key.split('-').map(Number);
        const x = (col - 1) * cellSize;
        const y = (row - 1) * cellSize;

        const merge = mergedCellsMap.get(key);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

        if (state.hasPostponed && !state.allNone && currentPhase !== 'postponed') {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.fillRect(x, y, width, height);

          const iconSize = Math.max(12, cellSize * 0.4);
          ctx.font = `bold ${iconSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#7B1FA2';
          drawUprightText('後', x + width / 2, y + height / 2);
        }

        if (state.hasLate && !state.allNone && currentPhase !== 'late') {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.fillRect(x, y, width, height);

          const iconSize = Math.max(12, cellSize * 0.4);
          ctx.font = `bold ${iconSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#1976D2';
          drawUprightText('遅', x + width / 2, y + height / 2);
        }
      });
    }

    if (!isRotationInteracting && effectiveShowPrevRef.current && prevCellCoords && !isPrevSameAsCurrent) {
      const x = (prevCellCoords.col - 1) * cellSize;
      const y = (prevCellCoords.row - 1) * cellSize;

      ctx.strokeStyle = 'rgba(107, 114, 128, 0.6)';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.setLineDash([cellSize * 0.15, cellSize * 0.1]);
      ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);
      ctx.setLineDash([]);

      const markerSize = Math.max(12, cellSize * 0.38);
      ctx.font = `${markerSize}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      drawUprightText('🔙', x + cellSize / 2, y - 1);
    }

    if (!isRotationInteracting && nextCellCoords) {
      const x = (nextCellCoords.col - 1) * cellSize;
      const y = (nextCellCoords.row - 1) * cellSize;

      ctx.strokeStyle = '#FF6D00';
      ctx.lineWidth = Math.max(3, cellSize * 0.12);
      ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);

      const markerSize = Math.max(14, cellSize * 0.45);
      ctx.font = `${markerSize}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      drawUprightText('🚩', x + cellSize / 2, y - 2);
    }

    if (!isRotationInteracting && currentCellCoords) {
      const x = (currentCellCoords.col - 1) * cellSize;
      const y = (currentCellCoords.row - 1) * cellSize;

      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);

      const markerSize = Math.max(16, cellSize * 0.5);
      ctx.font = `${markerSize}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      drawUprightText('📍', x + cellSize / 2, y - 2);
    }

    ctx.restore();
  }, [
    mapData,
    cellSize,
    cellStates,
    mergedCellsMap,
    routePath,
    prevRoutePath,
    dpr,
    isDetailedView,
    showNumbers,
    showBorders,
    currentCellCoords,
    nextCellCoords,
    prevCellCoords,
    currentPhase,
    isDarkMode,
    isRotationInteracting,
    rotationRadians,
    mapCenterX,
    mapCenterY,
    toMapCoordinates,
    offset,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const calculateOffsetForZoomPoint = (viewX: number, viewY: number, newZoom: number) => {
      const oldCellSize = BASE_CELL_SIZE * (zoomLevel / 100);
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const mapPoint = toMapCoordinates(viewX, viewY);
      const normalizedMapX = mapPoint.x / oldCellSize;
      const normalizedMapY = mapPoint.y / oldCellSize;
      const scaledMapX = normalizedMapX * newCellSize;
      const scaledMapY = normalizedMapY * newCellSize;
      const newMapCenterX = (mapData.maxCol * newCellSize) / 2;
      const newMapCenterY = (mapData.maxRow * newCellSize) / 2;
      const rotatedPoint = rotatePointAroundCenter(
        scaledMapX,
        scaledMapY,
        newMapCenterX,
        newMapCenterY,
        rotationRadians,
      );
      return {
        x: viewX - rotatedPoint.x,
        y: viewY - rotatedPoint.y,
      };
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey && onRotationAngleChange) {
        const deltaAngle = e.deltaY < 0 ? -15 : 15;
        onRotationAngleChange(normalizeRotationAngle(rotationAngle + deltaAngle));
        return;
      }
      if (!onZoomChange) return;

      const rect = container.getBoundingClientRect();
      const zoomCenter = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      const delta = -e.deltaY * 0.1;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoomLevel + delta)));
      if (newZoom === zoomLevel) return;

      setOffset(calculateOffsetForZoomPoint(zoomCenter.x, zoomCenter.y, newZoom));
      onZoomChange(newZoom);
    };

    const handleTouchStart = (e: TouchEvent) => {
      Array.from(e.changedTouches).forEach((t) => {
        activeTouchesRef.current.set(t.identifier, { x: t.clientX, y: t.clientY });
      });
      if (activeTouchesRef.current.size === 2) {
        const touches = Array.from(activeTouchesRef.current.values());
        pinchStartDistRef.current = Math.sqrt(
          Math.pow(touches[1].x - touches[0].x, 2) + Math.pow(touches[1].y - touches[0].y, 2),
        );
        pinchStartZoomRef.current = zoomLevel;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      Array.from(e.changedTouches).forEach((t) => {
        activeTouchesRef.current.set(t.identifier, { x: t.clientX, y: t.clientY });
      });
      if (activeTouchesRef.current.size === 2 && onZoomChange) {
        e.preventDefault();
        const touches = Array.from(activeTouchesRef.current.values());
        const currentDist = Math.sqrt(
          Math.pow(touches[1].x - touches[0].x, 2) + Math.pow(touches[1].y - touches[0].y, 2),
        );
        if (pinchStartDistRef.current === 0) return;

        const rect = container.getBoundingClientRect();
        const midX = (touches[0].x + touches[1].x) / 2 - rect.left;
        const midY = (touches[0].y + touches[1].y) / 2 - rect.top;

        const scaleRatio = currentDist / pinchStartDistRef.current;
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, Math.round(pinchStartZoomRef.current * scaleRatio)),
        );
        if (newZoom === zoomLevel) return;

        setOffset(calculateOffsetForZoomPoint(midX, midY, newZoom));
        onZoomChange(newZoom);
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      Array.from(e.changedTouches).forEach((t) => {
        activeTouchesRef.current.delete(t.identifier);
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);
    container.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [
    zoomLevel,
    onZoomChange,
    mapData.maxCol,
    mapData.maxRow,
    rotationRadians,
    toMapCoordinates,
    onRotationAngleChange,
    rotationAngle,
  ]);

  const activeScrollBounds = useMemo(() => {
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

    if (showPrevRoute && routeBoundsAll) {
      return routeBoundsAll;
    }
    if (routeBoundsCurrentNext) {
      return routeBoundsCurrentNext;
    }

    return {
      minRow: 1,
      maxRow: mapData.maxRow,
      minCol: 1,
      maxCol: mapData.maxCol,
    };
  }, [
    selectedHall,
    showPrevRoute,
    routeBoundsAll,
    routeBoundsCurrentNext,
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
      rotatePointAroundCenter(boundsLeft, boundsTop, mapCenterX, mapCenterY, rotationRadians),
      rotatePointAroundCenter(boundsRight, boundsTop, mapCenterX, mapCenterY, rotationRadians),
      rotatePointAroundCenter(boundsLeft, boundsBottom, mapCenterX, mapCenterY, rotationRadians),
      rotatePointAroundCenter(boundsRight, boundsBottom, mapCenterX, mapCenterY, rotationRadians),
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

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (activeTouchesRef.current.size >= 2) return;
      setIsDragging(false);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragStartOffset({ ...offset });
    },
    [offset],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (e.buttons !== 1) return;
      if (activeTouchesRef.current.size >= 2) return;

      const dx = (e.clientX - dragStart.x) / appScale;
      const dy = (e.clientY - dragStart.y) / appScale;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        setIsDragging(true);
      }

      let newX = dragStartOffset.x + dx;
      let newY = dragStartOffset.y + dy;

      const limits = calculateScrollLimits();
      if (limits) {
        newX = Math.max(limits.minX, Math.min(limits.maxX, newX));
        newY = Math.max(limits.minY, Math.min(limits.maxY, newY));
      }

      setOffset({
        x: newX,
        y: newY,
      });
    },
    [dragStart, dragStartOffset, appScale, calculateScrollLimits],
  );

  const isCellInBlock = useCallback((row: number, col: number, block: BlockDefinition): boolean => {
    if (block.cellGroups && block.cellGroups.length > 0) {
      return block.cellGroups.some((group) => {
        if (group.type === 'range') {
          return (
            row >= (group.startRow || 0) &&
            row <= (group.endRow || 0) &&
            col >= (group.startCol || 0) &&
            col <= (group.endCol || 0)
          );
        } else if (group.type === 'individual' && group.cells) {
          return group.cells.some((c) => c.row === row && c.col === col);
        }
        return false;
      });
    }
    return (
      row >= block.startRow && row <= block.endRow && col >= block.startCol && col <= block.endCol
    );
  }, []);

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDragging && onCellClick) {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const canvasRect = canvas.getBoundingClientRect();

        const appScale = appZoomLevel / 100;

        const viewX = (e.clientX - canvasRect.left) / appScale;
        const viewY = (e.clientY - canvasRect.top) / appScale;
        const { x: mapX, y: mapY } = toMapCoordinates(viewX, viewY);

        const col = Math.floor(mapX / cellSize) + 1;
        const row = Math.floor(mapY / cellSize) + 1;

        if (row >= 1 && row <= mapData.maxRow && col >= 1 && col <= mapData.maxCol) {
          for (const block of mapData.blocks) {
            if (isCellInBlock(row, col, block)) {
              if (
                block.nameCells &&
                block.nameCells.some((nc) => nc.row === row && nc.col === col)
              ) {
                continue;
              }

              let foundNumber: number | null = null;
              const numberCell = block.numberCells.find((nc) => nc.row === row && nc.col === col);
              if (numberCell) {
                foundNumber = numberCell.value;
              }

              if (foundNumber === null) {
                let cell = cellsMap.get(`${row}-${col}`);

                if (!cell) {
                  for (const merge of mapData.mergedCells) {
                    if (
                      row >= merge.startRow &&
                      row <= merge.endRow &&
                      col >= merge.startCol &&
                      col <= merge.endCol
                    ) {
                      cell = cellsMap.get(`${merge.startRow}-${merge.startCol}`);
                      break;
                    }
                  }
                }

                if (cell && cell.value !== null && cell.value !== undefined) {
                  const cellValue = String(cell.value).trim();
                  const numMatch = cellValue.match(/^(\d+)/);
                  if (numMatch) {
                    foundNumber = parseInt(numMatch[1], 10);
                  }
                }
              }

              if (foundNumber !== null) {
                const matchingItems = items.filter((item) => {
                  if (item.block !== block.name) return false;
                  const numStr = extractNumberFromItemNumber(item.number);
                  const numValue = numStr ? parseInt(numStr, 10) : 0;
                  return numValue === foundNumber;
                });

                onCellClick(block.name, foundNumber, matchingItems);
                break;
              }
            }
          }
        }
      }

      setTimeout(() => {
        setIsDragging(false);
      }, 100);
    },
    [
      isDragging,
      onCellClick,
      cellSize,
      mapData,
      items,
      cellsMap,
      isCellInBlock,
      appZoomLevel,
      toMapCoordinates,
    ],
  );

  const handlePointerLeave = useCallback(() => {
    setTimeout(() => {
      setIsDragging(false);
    }, 100);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative bg-white dark:bg-slate-800 overflow-hidden"
      style={{
        width: '100%',
        height: '100%',
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        style={{
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      />
    </div>
  );
};

export default FocusModeMapCanvas;

