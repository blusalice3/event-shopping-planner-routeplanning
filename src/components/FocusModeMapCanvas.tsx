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
  // 髮・ｸｭ繝｢繝ｼ繝牙崋譛峨・繝励Ο繝代ユ繧｣
  currentVisitKey: string | null;
  nextVisitKey: string | null; // 谺｡縺ｮ逶ｮ逧・慍
  prevVisitKey: string | null; // 蜑阪・險ｪ蝠丞・
  currentPhase: 'normal' | 'postponed' | 'late';
  // 閾ｪ蜍輔ぜ繝ｼ繝逕ｨ繧ｳ繝ｼ繝ｫ繝舌ャ繧ｯ
  onZoomChange?: (newZoom: number) => void;
  onCellClick?: (blockName: string, number: number, matchingItems: ShoppingItem[]) => void;
  appZoomLevel?: number;
  hallDefinitions?: HallDefinition[];
}

const BASE_CELL_SIZE = 28;
const SCROLL_MARGIN = 5;

// 繝翫Φ繝舌・縺九ｉ繝吶・繧ｹ驛ｨ蛻・ｼ域焚蟄・繧｢繝ｫ繝輔ぃ繝吶ャ繝茨ｼ峨ｒ謚ｽ蜃ｺ
const extractBaseNumber = (number: string): string => {
  const match = number.match(/^(\d+[a-zA-Z])/);
  return match ? match[1].toLowerCase() : number.toLowerCase();
};

const getVisitKey = (item: ShoppingItem): string => {
  const baseNumber = extractBaseNumber(item.number);
  return `${item.eventDate}-${item.block}-${baseNumber}`;
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
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });

  // 繝斐Φ繝√ぜ繝ｼ繝逕ｨrefs
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartDistRef = useRef<number>(0);
  const pinchStartZoomRef = useRef<number>(zoomLevel);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scale = zoomLevel / 100;
  const cellSize = BASE_CELL_SIZE * scale;
  // 陦ｨ遉ｺ蛟咲紫縺ｫ髢｢繧上ｉ縺壼・縺ｦ縺ｮ蜀・ｮｹ繧定｡ｨ遉ｺ
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;

  const prevSelectedHallRef = useRef<HallDefinition | null>(null);

  // 繧ｻ繝ｫ繝槭ャ繝励ｒ菴懈・
  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  // 邨仙粋繧ｻ繝ｫ縺ｮ繝槭ャ繝励ｒ菴懈・
  const mergedCellsMap = useMemo(() => {
    const map = new Map<string, MergedCellInfo>();
    mapData.mergedCells.forEach((merge) => {
      map.set(`${merge.startRow}-${merge.startCol}`, merge);
    });
    return map;
  }, [mapData.mergedCells]);

  const dayName = useMemo(() => {
    const dayMatch = mapName.match(/^(.+)繝槭ャ繝・/);
    return dayMatch ? dayMatch[1].trim() : '';
  }, [mapName]);

  const cellStates = useMemo(() => {
    const states = new Map<
      string,
      {
        hasItems: boolean;
        items: ShoppingItem[];
        visitKeys: Set<string>; // 隍・焚縺ｮvisitKey繧剃ｿ晄戟
        isCurrentPosition: boolean;
        isNextDestination: boolean;
        isPreviousPosition: boolean;
        allNone: boolean; // 蜈ｨ縺ｦ譛ｪ雉ｼ蜈･
        allProcessed: boolean; // 蜈ｨ縺ｦ蜃ｦ逅・ｸ医∩・域悴雉ｼ蜈･莉･螟厄ｼ・
        hasPostponed: boolean; // 蠕悟屓縺励い繧､繝・Β縺ゅｊ
        hasLate: boolean; // 驕・盾繧｢繧､繝・Β縺ゅｊ
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
      existing.visitKeys.add(visitKey); // 隍・焚縺ｮvisitKey繧剃ｿ晄戟

      // 雉ｼ蜈･迥ｶ諷九・譖ｴ譁ｰ
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

    // 險ｪ蝠乗ｸ医∩蛻､螳壹→迴ｾ蝨ｨ菴咲ｽｮ/谺｡縺ｮ逶ｮ逧・慍縺ｮ險ｭ螳・
    states.forEach((state, _key) => {
      // 險ｪ蝠乗ｸ医∩: 蜈ｨ縺ｦ譛ｪ雉ｼ蜈･縺ｧ縺ｯ縺ｪ縺・縺九▽ (蠕悟屓縺・驕・盾縺ｮ縺ｿ縺ｧ縺ｪ縺・
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

    // 蜑阪・險ｪ蝠丞・縺ｨ迴ｾ蝨ｨ菴咲ｽｮ縺悟酔縺伜ｴ蜷医・繧ｹ繧ｭ繝・・
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

  // 繧ｻ繝ｫ縺後・繝ｼ繝ｫ蜀・↓縺ゅｋ縺九ｒpoint-in-polygon縺ｧ蛻､螳壹☆繧九・繝ｫ繝代・
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

  // 蜑阪・險ｪ蝠丞・縺ｨ迴ｾ蝨ｨ菴咲ｽｮ縺悟酔縺倥・繝ｼ繝ｫ縺ｫ縺ゅｋ縺九←縺・°
  const prevInSameHall = useMemo(() => {
    if (!prevCellCoords || !currentCellCoords) return false;
    if (!hallDefinitions || hallDefinitions.length === 0) return true;
    const prevHall = findHallForCell(prevCellCoords.row, prevCellCoords.col);
    const currentHall = findHallForCell(currentCellCoords.row, currentCellCoords.col);
    if (!prevHall || !currentHall) return false;
    return prevHall.id === currentHall.id;
  }, [prevCellCoords, currentCellCoords, hallDefinitions, findHallForCell]);

  // 蜑阪・險ｪ蝠丞・繝ｫ繝ｼ繝医ｒ陦ｨ遉ｺ縺吶ｋ縺句愛螳夲ｼ医・繝ｼ繝ｫ蟾ｮ逡ｰ + 霍晞屬繝吶・繧ｹ・・  // 繝帙・繝ｫ縺檎焚縺ｪ繧句ｴ蜷医・陦ｨ遉ｺ縺励↑縺・ょ酔縺倥・繝ｼ繝ｫ縺ｧ繧・轤ｹ縺碁□縺吶℃繧句ｴ蜷医・2轤ｹ縺ｫ繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ
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

  // 螳滄圀縺ｫ菴ｿ逕ｨ縺吶ｋ繝ｫ繝ｼ繝育ｯ・峇繧呈ｱｺ螳壹☆繧九◆繧√・譛驕ｩ繧ｺ繝ｼ繝險育ｮ励・繝ｫ繝代・
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

      const newOffsetX = containerWidth / 2 - routeCenterX;
      const newOffsetY = containerHeight / 2 - routeCenterY;

      setOffset({ x: newOffsetX, y: newOffsetY });
      return;
    }

    if (selectedHall && selectedHall.vertices.length >= 4) {
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
      // 繝帙・繝ｫ縺梧悴驕ｸ謚槭・蝣ｴ蜷医√Ν繝ｼ繝医′縺ゅｌ縺ｰ繝ｫ繝ｼ繝井ｸｭ蠢・√↑縺代ｌ縺ｰ蜴溽せ
      if (routeBounds) {
        const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
        const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
        const routeCenterX = (routeCenterCol - 0.5) * cellSize;
        const routeCenterY = (routeCenterRow - 0.5) * cellSize;

        const newOffsetX = containerWidth / 2 - routeCenterX;
        const newOffsetY = containerHeight / 2 - routeCenterY;

        setOffset({ x: newOffsetX, y: newOffsetY });
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
  ]);

  useEffect(() => {
    // 險ｪ蝠丞・繧ｭ繝ｼ縺悟､峨ｏ縺｣縺ｦ縺・↑縺・ｴ蜷医・繧ｹ繧ｭ繝・・
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
        // 3轤ｹ縺稽in zoom莉･荳翫〒蜿弱∪繧・竊・3轤ｹ陦ｨ遉ｺ
        useBounds = routeBoundsAll;
        useShowPrev = true;
      }
      // 3轤ｹ縺縺ｨmin zoom譛ｪ貅 竊・2轤ｹ縺ｫ繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ・・seBounds縺ｯ縺昴・縺ｾ縺ｾ・・
    }

    effectiveShowPrevRef.current = useShowPrev;

    const optimalZoom = calcOptimalZoom(useBounds, containerWidth, containerHeight);
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(optimalZoom)));

    if (onZoomChange) {
      onZoomChange(newZoom);
    }

    // 繝ｫ繝ｼ繝医・荳ｭ蠢・ｒ逕ｻ髱｢荳ｭ螟ｮ縺ｫ驟咲ｽｮ
    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    const routeCenterCol = (useBounds.minCol + useBounds.maxCol) / 2;
    const routeCenterRow = (useBounds.minRow + useBounds.maxRow) / 2;
    const routeCenterX = (routeCenterCol - 0.5) * newCellSize;
    const routeCenterY = (routeCenterRow - 0.5) * newCellSize;

    const newOffsetX = containerWidth / 2 - routeCenterX;
    const newOffsetY = containerHeight / 2 - routeCenterY;

    setOffset({ x: newOffsetX, y: newOffsetY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentVisitKey,
    routeBoundsCurrentNext,
    routeBoundsAll,
    currentCellCoords,
    onZoomChange,
    showPrevRoute,
    calcOptimalZoom,
  ]);

  // 謠冗判
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

    // 繧ｪ繝輔そ繝・ヨ繧帝←逕ｨ
    ctx.save();
    ctx.translate(offset.x, offset.y);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 繝薙Η繝ｼ繝昴・繝医・繝ｼ繧ｹ縺ｮ繧ｻ繝ｫ蜿ｯ隕也ｯ・峇繧ｫ繝ｪ繝ｳ繧ｰ
    const visMinCol = Math.max(1, Math.floor(-offset.x / cellSize));
    const visMaxCol = Math.min(
      mapData.maxCol,
      Math.ceil((-offset.x + containerWidth) / cellSize) + 1,
    );
    const visMinRow = Math.max(1, Math.floor(-offset.y / cellSize));
    const visMaxRow = Math.min(
      mapData.maxRow,
      Math.ceil((-offset.y + containerHeight) / cellSize) + 1,
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

    // 1. 閭梧勹繧呈緒逕ｻ
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

      // 閭梧勹濶ｲ
      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }

      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state && state.hasItems) {
        if (state.isCurrentPosition) {
          // 迴ｾ蝨ｨ菴咲ｽｮ: 邱題レ譎ｯ
          ctx.fillStyle = 'rgba(34, 197, 94, 0.6)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isNextDestination) {
          // 谺｡縺ｮ險ｪ蝠丞・: 繧ｪ繝ｬ繝ｳ繧ｸ閭梧勹
          ctx.fillStyle = 'rgba(255, 152, 0, 0.6)';
          ctx.fillRect(x, y, width, height);
        } else if (effectiveShowPrevRef.current && state.isPreviousPosition) {
          // 蜑阪・險ｪ蝠丞・: 阮・＞髱堤ｴｫ閭梧勹・亥燕繝ｫ繝ｼ繝郁｡ｨ遉ｺ譎ゅ・縺ｿ・・
          ctx.fillStyle = 'rgba(139, 148, 191, 0.45)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          // 險ｪ蝠乗ｸ医∩・亥・縺ｦ蜃ｦ逅・ｸ医∩縲∝ｾ悟屓縺・驕・盾縺ｮ縺ｿ縺ｧ縺ｪ縺・ｼ・ 繧ｰ繝ｬ繝ｼ
          ctx.fillStyle = 'rgba(158, 158, 158, 0.5)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPostponed && currentPhase !== 'postponed') {
          // 蠕悟屓縺励い繧､繝・Β縺ゅｊ・亥ｾ悟屓縺励ヵ繧ｧ繝ｼ繧ｺ莉･螟厄ｼ・ 邏ｫ邉ｻ
          ctx.fillStyle = 'rgba(156, 39, 176, 0.4)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasLate && currentPhase !== 'late') {
          // 驕・盾繧｢繧､繝・Β縺ゅｊ・磯≦蜿ゅヵ繧ｧ繝ｼ繧ｺ莉･螟厄ｼ・ 髱堤ｳｻ
          ctx.fillStyle = 'rgba(33, 150, 243, 0.4)';
          ctx.fillRect(x, y, width, height);
        } else if (state.allNone) {
          // 蜈ｨ縺ｦ譛ｪ雉ｼ蜈･: 騾壼ｸｸ縺ｮ髱・
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)';
          ctx.fillRect(x, y, width, height);
        }
      }
    });

    // 2. 鄂ｫ邱壹ｒ謠冗判
    if (showBorders) {
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

    // 3. 繝・く繧ｹ繝医ｒ謠冗判
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
          // 邨仙粋繧ｻ繝ｫ縺ｯ螟ｧ縺阪ａ
          if (isVertical) {
            // 邵ｦ譖ｸ縺阪・蝣ｴ蜷医・鬮倥＆縺ｫ蝓ｺ縺･縺・※繧ｵ繧､繧ｺ繧定ｪｿ謨ｴ
            const charCount = text.replace(/\n/g, '').length;
            fontSize = Math.min(width * 0.6, (height / (charCount + 1)) * 0.9, 16);
          } else {
            fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
          }
        } else if (typeof cell.value === 'number') {
          // 謨ｰ蛟､繧ｻ繝ｫ
          fontSize = Math.min(cellSize * 0.45, 14);
        } else {
          // 繝・く繧ｹ繝医そ繝ｫ
          fontSize = Math.min(cellSize * 0.4, 12);
        }
        fontSize = Math.max(fontSize, 8); // 譛蟆上し繧､繧ｺ

        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        const explicitFontColor = cell.fontColor?.trim();
        if (explicitFontColor) {
          ctx.fillStyle = explicitFontColor;
        } else if (state?.isCurrentPosition) {
          ctx.fillStyle = '#E65100';
        } else if (state?.isVisited) {
          ctx.fillStyle = '#616161';
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0';
        } else {
          ctx.fillStyle = cell.fontColor || '#333333';
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
              ctx.fillText(char, lineX, charY);
            });
          });
        } else {
          ctx.fillText(text, x + width / 2, y + height / 2);
        }
      });
    }

    // 4a. 蜑阪・險ｪ蝠丞・竊堤樟蝨ｨ菴咲ｽｮ縺ｮ繝ｫ繝ｼ繝医ｒ謠冗判・郁埋縺・ｮ溽ｷ夲ｼ・    // effectiveShowPrevRef: 繝帙・繝ｫ縺檎焚縺ｪ繧・or 3轤ｹ縺碁□縺吶℃繧句ｴ蜷医・髱櫁｡ｨ遉ｺ
    const isPrevSameAsCurrent =
      prevCellCoords &&
      currentCellCoords &&
      prevCellCoords.row === currentCellCoords.row &&
      prevCellCoords.col === currentCellCoords.col;

    if (effectiveShowPrevRef.current && prevRoutePath.length >= 2 && !isPrevSameAsCurrent) {
      const lineWidth = Math.max(2, cellSize * 0.08);

      // 阮・＞螳溽ｷ壹〒謠冗判・郁ｨｪ蝠乗ｸ医∩繝ｫ繝ｼ繝茨ｼ・
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(156, 163, 175, 0.6)'; // 繧ｰ繝ｬ繝ｼ蜊企乗・
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

      // 蟋狗せ・亥燕縺ｮ險ｪ蝠丞・・峨↓蟆上＆縺・ｸｸ繝槭・繧ｫ繝ｼ
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

      // 邨らせ・育樟蝨ｨ菴咲ｽｮ譁ｹ蜷托ｼ峨↓遏｢蜊ｰ
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

    // 4b. 繝ｫ繝ｼ繝医ｒ謠冗判・育せ邱・ 譛ｪ險ｪ蝠城Κ蛻・∝ｮ溽ｷ・ 險ｪ蝠乗ｸ医∩驛ｨ蛻・ｼ・    // 迴ｾ蝨ｨ菴咲ｽｮ縺ｨ谺｡縺ｮ逶ｮ逧・慍縺檎焚縺ｪ繧句ｴ蜷医・縺ｿ繝ｫ繝ｼ繝医ｒ謠冗判
    const isSamePosition =
      currentCellCoords &&
      nextCellCoords &&
      currentCellCoords.row === nextCellCoords.row &&
      currentCellCoords.col === nextCellCoords.col;

    if (routePath.length >= 2 && !isSamePosition) {
      const lineWidth = Math.max(3, cellSize * 0.1);

      // 轤ｹ邱壹〒謠冗判・域悴險ｪ蝠上Ν繝ｼ繝茨ｼ・
      ctx.beginPath();
      ctx.strokeStyle = '#FF5722'; // 繧ｪ繝ｬ繝ｳ繧ｸ
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

      // 邨らせ縺ｫ遏｢蜊ｰ
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

    // 5. 蠕悟屓縺・驕・盾繧ｪ繝ｼ繝舌・繝ｬ繧､
    cellStates.forEach((state, key) => {
      if (!state.hasItems) return;

      const [row, col] = key.split('-').map(Number);
      const x = (col - 1) * cellSize;
      const y = (row - 1) * cellSize;

      const merge = mergedCellsMap.get(key);
      const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
      const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

      if (state.hasPostponed && !state.allNone && currentPhase !== 'postponed') {
        // 蜊企乗・繧ｪ繝ｼ繝舌・繝ｬ繧､
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillRect(x, y, width, height);

        // 縲悟ｾ後阪い繧､繧ｳ繝ｳ
        const iconSize = Math.max(12, cellSize * 0.4);
        ctx.font = `bold ${iconSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#7B1FA2'; // 邏ｫ
        ctx.fillText('後', x + width / 2, y + height / 2);
      }

      if (state.hasLate && !state.allNone && currentPhase !== 'late') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillRect(x, y, width, height);

        const iconSize = Math.max(12, cellSize * 0.4);
        ctx.font = `bold ${iconSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1976D2';
        ctx.fillText('遅', x + width / 2, y + height / 2);
      }
    });

    if (effectiveShowPrevRef.current && prevCellCoords && !isPrevSameAsCurrent) {
      const x = (prevCellCoords.col - 1) * cellSize;
      const y = (prevCellCoords.row - 1) * cellSize;

      // 繧ｰ繝ｬ繝ｼ譫・域而縺医ａ・・
      ctx.strokeStyle = 'rgba(107, 114, 128, 0.6)';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.setLineDash([cellSize * 0.15, cellSize * 0.1]);
      ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);
      ctx.setLineDash([]);

      // 漠繝槭・繧ｫ繝ｼ
      const markerSize = Math.max(12, cellSize * 0.38);
      ctx.font = `${markerSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('漠', x + cellSize / 2, y - 1);
    }

    if (nextCellCoords) {
      const x = (nextCellCoords.col - 1) * cellSize;
      const y = (nextCellCoords.row - 1) * cellSize;

      // 繧ｪ繝ｬ繝ｳ繧ｸ譫
      ctx.strokeStyle = '#FF6D00';
      ctx.lineWidth = Math.max(3, cellSize * 0.12);
      ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);

      // 圸繝槭・繧ｫ繝ｼ
      const markerSize = Math.max(14, cellSize * 0.45);
      ctx.font = `${markerSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('圸', x + cellSize / 2, y - 2);
    }

    if (currentCellCoords) {
      const x = (currentCellCoords.col - 1) * cellSize;
      const y = (currentCellCoords.row - 1) * cellSize;

      // 邱第棧
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);

      // 桃繝槭・繧ｫ繝ｼ
      const markerSize = Math.max(16, cellSize * 0.5);
      ctx.font = `${markerSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('桃', x + cellSize / 2, y - 2);
    }

    // ctx.translate 繧定ｧ｣髯､
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
    offset,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // 繝帙う繝ｼ繝ｫ繧ｺ繝ｼ繝
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!onZoomChange) return;

      const rect = container.getBoundingClientRect();
      const zoomCenter = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      const oldCellSize = BASE_CELL_SIZE * (zoomLevel / 100);
      const delta = -e.deltaY * 0.1;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoomLevel + delta)));
      if (newZoom === zoomLevel) return;

      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const mapCoordX = (zoomCenter.x - offset.x) / oldCellSize;
      const mapCoordY = (zoomCenter.y - offset.y) / oldCellSize;
      const newOffsetX = zoomCenter.x - mapCoordX * newCellSize;
      const newOffsetY = zoomCenter.y - mapCoordY * newCellSize;

      setOffset({ x: newOffsetX, y: newOffsetY });
      onZoomChange(newZoom);
    };

    // 繝斐Φ繝√ぜ繝ｼ繝
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
        const oldCellSize = BASE_CELL_SIZE * (zoomLevel / 100);
        const newZoom = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, Math.round(pinchStartZoomRef.current * scaleRatio)),
        );
        if (newZoom === zoomLevel) return;

        const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
        const mapCoordX = (midX - offset.x) / oldCellSize;
        const mapCoordY = (midY - offset.y) / oldCellSize;
        setOffset({ x: midX - mapCoordX * newCellSize, y: midY - mapCoordY * newCellSize });
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
  }, [zoomLevel, offset, onZoomChange]);

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

      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        setIsDragging(true);
      }

      setOffset({
        x: dragStartOffset.x + dx,
        y: dragStartOffset.y + dy,
      });
    },
    [dragStart, dragStartOffset],
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
    // 騾壼ｸｸ縺ｮ遏ｩ蠖｢繝悶Ο繝・け
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

        // 繧｢繝励Μ蜈ｨ菴薙・繧ｺ繝ｼ繝繧ｹ繧ｱ繝ｼ繝ｫ
        const appScale = appZoomLevel / 100;

        const viewX = (e.clientX - canvasRect.left) / appScale;
        const viewY = (e.clientY - canvasRect.top) / appScale;
        const mapX = viewX - offset.x;
        const mapY = viewY - offset.y;

        const col = Math.floor(mapX / cellSize) + 1;
        const row = Math.floor(mapY / cellSize) + 1;

        if (row >= 1 && row <= mapData.maxRow && col >= 1 && col <= mapData.maxCol) {
          for (const block of mapData.blocks) {
            // 螢√ヶ繝ｭ繝・け繧ょ性繧√※蜈ｨ縺ｦ縺ｮ繝悶Ο繝・け繧貞・逅・
            if (isCellInBlock(row, col, block)) {
              // 繝悶Ο繝・け蜷阪そ繝ｫ縺ｪ繧峨せ繧ｭ繝・・
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

                // 繧ｻ繝ｫ縺瑚ｦ九▽縺九ｉ縺ｪ縺・ｴ蜷医∫ｵ仙粋繧ｻ繝ｫ蜀・°繝√ぉ繝・け
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
      offset,
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

