import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  ZoomLevel,
  MergedCellInfo,
  HallDefinition,
  BlockDefinition,
} from '../types';
import { extractNumberFromItemNumber } from '../utils/xlsxMapParser';
import { findPath, simplifyPath } from '../utils/pathfinding';

interface FocusModeMapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  zoomLevel: ZoomLevel;
  selectedHall: HallDefinition | null;
  // 集中モード固有のプロパティ
  currentVisitKey: string | null;  // 現在位置（eventDate-block-baseNumber）
  nextVisitKey: string | null;     // 次の目的地
  prevVisitKey: string | null;     // 前の訪問先
  currentPhase: 'normal' | 'postponed' | 'late';
  // 自動ズーム用コールバック
  onZoomChange?: (newZoom: ZoomLevel) => void;
  // セルクリック時のコールバック（新規アイテム追加用）
  onCellClick?: (blockName: string, number: number, matchingItems: ShoppingItem[]) => void;
  // アプリ全体の表示倍率（親要素のtransform scaleに対応）
  appZoomLevel?: number;
  // ホール定義（前の訪問先と現在位置のホール比較用）
  hallDefinitions?: HallDefinition[];
}

const BASE_CELL_SIZE = 28;
const SCROLL_MARGIN = 5;

// ナンバーからベース部分（数字+アルファベット）を抽出
const extractBaseNumber = (number: string): string => {
  const match = number.match(/^(\d+[a-zA-Z])/);
  return match ? match[1].toLowerCase() : number.toLowerCase();
};

// 訪問先キーを生成（参加日 + ブロック + ベースナンバー）
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

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scale = zoomLevel / 100;
  const cellSize = BASE_CELL_SIZE * scale;
  // 表示倍率に関わらず全ての内容を表示
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;

  const prevCellSizeRef = useRef<number>(cellSize);
  const initializedRef = useRef<boolean>(false);
  const prevSelectedHallRef = useRef<HallDefinition | null>(null);

  // セルマップを作成
  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  // 結合セルのマップを作成
  const mergedCellsMap = useMemo(() => {
    const map = new Map<string, MergedCellInfo>();
    mapData.mergedCells.forEach((merge) => {
      map.set(`${merge.startRow}-${merge.startCol}`, merge);
    });
    return map;
  }, [mapData.mergedCells]);

  // 日名を取得
  const dayName = useMemo(() => {
    const dayMatch = mapName.match(/^(.+)マップ$/);
    return dayMatch ? dayMatch[1].trim() : '';
  }, [mapName]);

  // セルごとの状態を計算（購入状態を考慮）
  const cellStates = useMemo(() => {
    const states = new Map<string, {
      hasItems: boolean;
      items: ShoppingItem[];
      visitKeys: Set<string>;  // 複数のvisitKeyを保持
      isCurrentPosition: boolean;
      isNextDestination: boolean;
      isPreviousPosition: boolean;
      // 購入状態の集計
      allNone: boolean;  // 全て未購入
      allProcessed: boolean;  // 全て処理済み（未購入以外）
      hasPostponed: boolean;  // 後回しアイテムあり
      hasLate: boolean;  // 遅参アイテムあり
      // 訪問済みかどうか（未購入がないかつ後回し/遅参のみでない）
      isVisited: boolean;
    }>();

    if (!dayName) return states;

    items.forEach((item) => {
      const itemEventDate = item.eventDate?.trim() || '';
      if (itemEventDate !== dayName) return;

      const itemBlockName = item.block?.trim() || '';
      let block = mapData.blocks.find((b) => b.name === itemBlockName);
      if (!block) {
        const candidates = mapData.blocks.filter((b) =>
          b.name.toLowerCase() === itemBlockName.toLowerCase()
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
      existing.visitKeys.add(visitKey);  // 複数のvisitKeyを保持

      // 購入状態の更新
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

    // 訪問済み判定と現在位置/次の目的地の設定
    states.forEach((state, _key) => {
      // 訪問済み: 全て未購入ではない かつ (後回し/遅参のみでない)
      // つまり、購入済み/売切/欠席のいずれかがある場合
      const hasFinalStatus = state.items.some(item => 
        item.purchaseStatus === 'Purchased' ||
        item.purchaseStatus === 'SoldOut' ||
        item.purchaseStatus === 'Absent'
      );
      // 後回し/遅参のみの場合は訪問済みとしない
      const onlyPostponedOrLate = state.items.every(item =>
        item.purchaseStatus === 'Postpone' ||
        item.purchaseStatus === 'Late'
      );
      state.isVisited = !state.allNone && (hasFinalStatus || (!state.allNone && !onlyPostponedOrLate));

      // 現在位置と次の目的地（visitKeysのSetで判定）
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

  // 現在位置と次の目的地のセル座標を取得
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

  // ルート計算（現在位置→次の目的地）
  const routePath = useMemo(() => {
    if (!currentCellCoords || !nextCellCoords) return [];

    // ブロック名セルを収集（通過可能）
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
      blockNameCells
    );

    return simplifyPath(path);
  }, [currentCellCoords, nextCellCoords, mapData, cellsMap]);

  // ルート計算（前の訪問先→現在位置）
  const prevRoutePath = useMemo(() => {
    if (!prevCellCoords || !currentCellCoords) return [];

    // 前の訪問先と現在位置が同じ場合はスキップ
    if (prevCellCoords.row === currentCellCoords.row && prevCellCoords.col === currentCellCoords.col) return [];

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
      blockNameCells
    );

    return simplifyPath(path);
  }, [prevCellCoords, currentCellCoords, mapData, cellsMap]);

  // セルがホール内にあるかをpoint-in-polygonで判定するヘルパー
  const findHallForCell = useCallback((row: number, col: number): HallDefinition | null => {
    if (!hallDefinitions || hallDefinitions.length === 0) return null;
    for (const hall of hallDefinitions) {
      if (hall.vertices.length < 3) continue;
      let inside = false;
      const vertices = hall.vertices;
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i].col, yi = vertices[i].row;
        const xj = vertices[j].col, yj = vertices[j].row;
        if (((yi > row) !== (yj > row)) &&
            (col < (xj - xi) * (row - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      if (inside) return hall;
    }
    return null;
  }, [hallDefinitions]);

  // 前の訪問先と現在位置が同じホールにあるかどうか
  const prevInSameHall = useMemo(() => {
    if (!prevCellCoords || !currentCellCoords) return false;
    // ホール定義がない場合は同じホールとみなす（ルートを表示）
    if (!hallDefinitions || hallDefinitions.length === 0) return true;
    const prevHall = findHallForCell(prevCellCoords.row, prevCellCoords.col);
    const currentHall = findHallForCell(currentCellCoords.row, currentCellCoords.col);
    // どちらかがホール外の場合は異なるホール扱い
    if (!prevHall || !currentHall) return false;
    return prevHall.id === currentHall.id;
  }, [prevCellCoords, currentCellCoords, hallDefinitions, findHallForCell]);

  // 前の訪問先ルートを表示するか判定（ホール差異 + 距離ベース）
  // ホールが異なる場合は表示しない。同じホールでも3点が遠すぎる場合は2点にフォールバック
  const showPrevRoute = useMemo(() => {
    // 前の訪問先がない場合は表示しない
    if (!prevCellCoords || !currentCellCoords) return false;
    // 同一セルの場合は表示しない
    if (prevCellCoords.row === currentCellCoords.row && prevCellCoords.col === currentCellCoords.col) return false;
    // ホールが異なる場合は表示しない
    if (!prevInSameHall) return false;
    return true;
  }, [prevCellCoords, currentCellCoords, prevInSameHall]);

  // 3点ルートの範囲（前の訪問先が同じホールの場合のみprevを含む）
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

  // 2点ルートの範囲（現在位置と次の目的地のみ）
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

  // 実際に使用するルート範囲を決定するための最適ズーム計算ヘルパー
  const calcOptimalZoom = useCallback((bounds: { minRow: number; maxRow: number; minCol: number; maxCol: number }, containerWidth: number, containerHeight: number): number => {
    const bWidth = bounds.maxCol - bounds.minCol + 1;
    const bHeight = bounds.maxRow - bounds.minRow + 1;
    const requiredWidthZoom = (containerWidth / (bWidth * BASE_CELL_SIZE)) * 100;
    const requiredHeightZoom = (containerHeight / (bHeight * BASE_CELL_SIZE)) * 100;
    return Math.min(requiredWidthZoom, requiredHeightZoom, 100);
  }, []);

  // 3点が遠すぎるかどうかの判定用ref（描画やauto-zoomで共有）
  const effectiveShowPrevRef = useRef<boolean>(true);

  // 基本のルート範囲（現在位置+次の目的地ベース、ズーム維持等で使用）
  const routeBounds = routeBoundsCurrentNext;

  // 前回の訪問先キーを記憶（変更検知用）
  const prevVisitKeyRef = useRef<string | null>(null);

  // ズームレベル変更時の視点維持（ルートの中心を維持）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prevCellSize = prevCellSizeRef.current;

    // 初回はスキップ
    if (!initializedRef.current) {
      prevCellSizeRef.current = cellSize;
      initializedRef.current = true;
      return;
    }

    // セルサイズが変わっていない場合はスキップ
    if (prevCellSize === cellSize) {
      return;
    }

    // ルートの中心を維持してズーム
    if (routeBounds) {
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      
      const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
      const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
      
      const routeCenterX = (routeCenterCol - 0.5) * cellSize;
      const routeCenterY = (routeCenterRow - 0.5) * cellSize;
      
      const newOffsetX = containerWidth / 2 - routeCenterX;
      const newOffsetY = containerHeight / 2 - routeCenterY;
      
      setOffset({ x: newOffsetX, y: newOffsetY });
    }

    prevCellSizeRef.current = cellSize;
  }, [cellSize, routeBounds]);

  // ホール選択時のオフセット自動調整（ルート全体が収まるように）
  useEffect(() => {
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;

    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const MIN_ZOOM = 30;

    // ルートがある場合はルート全体を中心に表示（3→2フォールバック付き）
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
      const newZoom = Math.max(MIN_ZOOM, Math.min(100, Math.floor(optimalZoom / 10) * 10)) as ZoomLevel;
      
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

    // ルートがない場合でホールが選択されている場合
    if (selectedHall && selectedHall.vertices.length >= 4) {
      const rows = selectedHall.vertices.map(v => v.row);
      const cols = selectedHall.vertices.map(v => v.col);
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
      // ホールが未選択の場合、ルートがあればルート中心、なければ原点
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
  }, [selectedHall, cellSize, routeBoundsCurrentNext, routeBoundsAll, currentCellCoords, onZoomChange, showPrevRoute, calcOptimalZoom]);

  // 訪問先が変わった時にルート全体を画面に収める（3点→2点フォールバック付き）
  useEffect(() => {
    // 訪問先キーが変わっていない場合はスキップ
    if (prevVisitKeyRef.current === currentVisitKey) {
      return;
    }
    prevVisitKeyRef.current = currentVisitKey;

    if (!routeBoundsCurrentNext || !currentCellCoords) return;
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const MIN_ZOOM = 30;

    // 3点表示を試行（前の訪問先が同じホールにある場合のみ）
    let useBounds = routeBoundsCurrentNext;
    let useShowPrev = false;

    if (showPrevRoute && routeBoundsAll) {
      const allZoom = calcOptimalZoom(routeBoundsAll, containerWidth, containerHeight);
      if (allZoom >= MIN_ZOOM) {
        // 3点がmin zoom以上で収まる → 3点表示
        useBounds = routeBoundsAll;
        useShowPrev = true;
      }
      // 3点だとmin zoom未満 → 2点にフォールバック（useBoundsはそのまま）
    }

    effectiveShowPrevRef.current = useShowPrev;

    // 選択したboundsで最適なズームを計算
    const optimalZoom = calcOptimalZoom(useBounds, containerWidth, containerHeight);
    const newZoom = Math.max(MIN_ZOOM, Math.min(100, Math.floor(optimalZoom / 10) * 10)) as ZoomLevel;
    
    if (onZoomChange) {
      onZoomChange(newZoom);
    }
    
    // ルートの中心を画面中央に配置
    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    const routeCenterCol = (useBounds.minCol + useBounds.maxCol) / 2;
    const routeCenterRow = (useBounds.minRow + useBounds.maxRow) / 2;
    const routeCenterX = (routeCenterCol - 0.5) * newCellSize;
    const routeCenterY = (routeCenterRow - 0.5) * newCellSize;
    
    const newOffsetX = containerWidth / 2 - routeCenterX;
    const newOffsetY = containerHeight / 2 - routeCenterY;
    
    setOffset({ x: newOffsetX, y: newOffsetY });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVisitKey, routeBoundsCurrentNext, routeBoundsAll, currentCellCoords, onZoomChange, showPrevRoute, calcOptimalZoom]);

  // 描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const displayWidth = mapData.maxCol * cellSize;
    const displayHeight = mapData.maxRow * cellSize;

    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayWidth, displayHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. 背景を描画
    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;

      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;

      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
      const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

      // 背景色
      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }

      // セル状態に応じた背景（購入状態ベース）
      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state && state.hasItems) {
        if (state.isCurrentPosition) {
          // 現在位置: 緑背景
          ctx.fillStyle = 'rgba(34, 197, 94, 0.6)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isNextDestination) {
          // 次の訪問先: オレンジ背景
          ctx.fillStyle = 'rgba(255, 152, 0, 0.6)';
          ctx.fillRect(x, y, width, height);
        } else if (effectiveShowPrevRef.current && state.isPreviousPosition) {
          // 前の訪問先: 薄い青紫背景（前ルート表示時のみ）
          ctx.fillStyle = 'rgba(139, 148, 191, 0.45)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          // 訪問済み（全て処理済み、後回し/遅参のみでない）: グレー
          ctx.fillStyle = 'rgba(158, 158, 158, 0.5)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPostponed && currentPhase !== 'postponed') {
          // 後回しアイテムあり（後回しフェーズ以外）: 紫系
          ctx.fillStyle = 'rgba(156, 39, 176, 0.4)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasLate && currentPhase !== 'late') {
          // 遅参アイテムあり（遅参フェーズ以外）: 青系
          ctx.fillStyle = 'rgba(33, 150, 243, 0.4)';
          ctx.fillRect(x, y, width, height);
        } else if (state.allNone) {
          // 全て未購入: 通常の青
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)';
          ctx.fillRect(x, y, width, height);
        }
      }
    });

    // 2. 罫線を描画
    if (showBorders) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

        const drawBorder = (
          fromX: number, fromY: number,
          toX: number, toY: number,
          border: { style: string; color: string } | null
        ) => {
          if (!border || border.style === 'none') return;

          ctx.beginPath();
          ctx.strokeStyle = border.color || '#000000';
          // MapCanvasと同じ罫線太さ
          let lineWidth = 1;
          switch (border.style) {
            case 'thin': lineWidth = 1; break;
            case 'medium': lineWidth = 2; break;
            case 'thick': lineWidth = 3; break;
            default: lineWidth = 1;
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

    // 3. テキストを描画
    if (showNumbers) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged || cell.value === null) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

        const text = String(cell.value);
        const isVertical = cell.isVerticalText;
        
        // MapCanvasと同じフォントサイズ計算
        let fontSize: number;
        if (merge) {
          // 結合セルは大きめ
          if (isVertical) {
            // 縦書きの場合は高さに基づいてサイズを調整
            const charCount = text.replace(/\n/g, '').length;
            fontSize = Math.min(width * 0.6, height / (charCount + 1) * 0.9, 16);
          } else {
            fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
          }
        } else if (typeof cell.value === 'number') {
          // 数値セル
          fontSize = Math.min(cellSize * 0.45, 14);
        } else {
          // テキストセル
          fontSize = Math.min(cellSize * 0.4, 12);
        }
        fontSize = Math.max(fontSize, 8); // 最小サイズ

        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        if (state?.isCurrentPosition) {
          ctx.fillStyle = '#E65100';  // オレンジ（現在位置）
        } else if (state?.isVisited) {
          ctx.fillStyle = '#616161';  // グレー（訪問済み）
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0';  // 青（未訪問）
        } else {
          ctx.fillStyle = '#333333';
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

    // 4a. 前の訪問先→現在位置のルートを描画（薄い実線）
    // effectiveShowPrevRef: ホールが異なる or 3点が遠すぎる場合は非表示
    const isPrevSameAsCurrent = prevCellCoords && currentCellCoords &&
      prevCellCoords.row === currentCellCoords.row &&
      prevCellCoords.col === currentCellCoords.col;

    if (effectiveShowPrevRef.current && prevRoutePath.length >= 2 && !isPrevSameAsCurrent) {
      const lineWidth = Math.max(2, cellSize * 0.08);

      // 薄い実線で描画（訪問済みルート）
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(156, 163, 175, 0.6)';  // グレー半透明
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

      // 始点（前の訪問先）に小さい丸マーカー
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

      // 終点（現在位置方向）に矢印
      if (prevRoutePath.length >= 2) {
        const last = prevRoutePath[prevRoutePath.length - 1];
        const prev = prevRoutePath[prevRoutePath.length - 2];

        const endX = (last.col - 0.5) * cellSize;
        const endY = (last.row - 0.5) * cellSize;
        const angle = Math.atan2(
          (last.row - prev.row) * cellSize,
          (last.col - prev.col) * cellSize
        );

        const arrowSize = Math.max(6, cellSize * 0.2);
        ctx.beginPath();
        ctx.fillStyle = 'rgba(156, 163, 175, 0.7)';
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle - Math.PI / 6),
          endY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle + Math.PI / 6),
          endY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    // 4b. ルートを描画（点線: 未訪問部分、実線: 訪問済み部分）
    // 現在位置と次の目的地が異なる場合のみルートを描画
    const isSamePosition = currentCellCoords && nextCellCoords && 
      currentCellCoords.row === nextCellCoords.row && 
      currentCellCoords.col === nextCellCoords.col;
    
    if (routePath.length >= 2 && !isSamePosition) {
      const lineWidth = Math.max(3, cellSize * 0.1);

      // 点線で描画（未訪問ルート）
      ctx.beginPath();
      ctx.strokeStyle = '#FF5722';  // オレンジ
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

      // 終点に矢印
      if (routePath.length >= 2) {
        const last = routePath[routePath.length - 1];
        const prev = routePath[routePath.length - 2];

        const endX = (last.col - 0.5) * cellSize;
        const endY = (last.row - 0.5) * cellSize;
        const angle = Math.atan2(
          (last.row - prev.row) * cellSize,
          (last.col - prev.col) * cellSize
        );

        const arrowSize = Math.max(8, cellSize * 0.3);
        ctx.beginPath();
        ctx.fillStyle = '#FF5722';
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle - Math.PI / 6),
          endY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          endX - arrowSize * Math.cos(angle + Math.PI / 6),
          endY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();
      }
    }

    // 5. 後回し/遅参オーバーレイ
    cellStates.forEach((state, key) => {
      if (!state.hasItems) return;

      const [row, col] = key.split('-').map(Number);
      const x = (col - 1) * cellSize;
      const y = (row - 1) * cellSize;

      const merge = mergedCellsMap.get(key);
      const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
      const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

      // 後回しオーバーレイ（後回しフェーズ以外で表示）
      if (state.hasPostponed && !state.allNone && currentPhase !== 'postponed') {
        // 半透明オーバーレイ
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillRect(x, y, width, height);
        
        // 「後」アイコン
        const iconSize = Math.max(12, cellSize * 0.4);
        ctx.font = `bold ${iconSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#7B1FA2';  // 紫
        ctx.fillText('後', x + width / 2, y + height / 2);
      }

      // 遅参オーバーレイ（遅参フェーズ以外で表示）
      if (state.hasLate && !state.allNone && currentPhase !== 'late') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillRect(x, y, width, height);

        const iconSize = Math.max(12, cellSize * 0.4);
        ctx.font = `bold ${iconSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1976D2';  // 青
        ctx.fillText('遅', x + width / 2, y + height / 2);
      }
    });

    // 6. 前の訪問先マーカー（最も下のレイヤー、前ルート非表示時はスキップ）
    if (effectiveShowPrevRef.current && prevCellCoords && !isPrevSameAsCurrent) {
      const x = (prevCellCoords.col - 1) * cellSize;
      const y = (prevCellCoords.row - 1) * cellSize;

      // グレー枠（控えめ）
      ctx.strokeStyle = 'rgba(107, 114, 128, 0.6)';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.setLineDash([cellSize * 0.15, cellSize * 0.1]);
      ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);
      ctx.setLineDash([]);

      // 🔙マーカー
      const markerSize = Math.max(12, cellSize * 0.38);
      ctx.font = `${markerSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('🔙', x + cellSize / 2, y - 1);
    }

    // 7. 次の目的地マーカー（現在位置より先に描画して下に配置）
    if (nextCellCoords) {
      const x = (nextCellCoords.col - 1) * cellSize;
      const y = (nextCellCoords.row - 1) * cellSize;

      // オレンジ枠
      ctx.strokeStyle = '#FF6D00';
      ctx.lineWidth = Math.max(3, cellSize * 0.12);
      ctx.strokeRect(x - 1, y - 1, cellSize + 2, cellSize + 2);

      // 🚩マーカー
      const markerSize = Math.max(14, cellSize * 0.45);
      ctx.font = `${markerSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('🚩', x + cellSize / 2, y - 2);
    }

    // 8. 現在位置マーカー（次の目的地より上に描画）
    if (currentCellCoords) {
      const x = (currentCellCoords.col - 1) * cellSize;
      const y = (currentCellCoords.row - 1) * cellSize;

      // 緑枠
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);

      // 📍マーカー
      const markerSize = Math.max(16, cellSize * 0.5);
      ctx.font = `${markerSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('📍', x + cellSize / 2, y - 2);
    }

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
  ]);

  // ドラッグ処理
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    setIsDragging(false);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragStartOffset({ ...offset });
  }, [offset]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1) return;

    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;

    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      setIsDragging(true);
    }

    setOffset({
      x: dragStartOffset.x + dx,
      y: dragStartOffset.y + dy,
    });
  }, [dragStart, dragStartOffset]);

  // セルがブロックの範囲内にあるかチェック（cellGroups対応）
  const isCellInBlock = useCallback((row: number, col: number, block: BlockDefinition): boolean => {
    // cellGroupsがある場合（複数範囲ブロックや壁ブロック）
    if (block.cellGroups && block.cellGroups.length > 0) {
      return block.cellGroups.some(group => {
        if (group.type === 'range') {
          return row >= (group.startRow || 0) && row <= (group.endRow || 0) &&
                 col >= (group.startCol || 0) && col <= (group.endCol || 0);
        } else if (group.type === 'individual' && group.cells) {
          return group.cells.some(c => c.row === row && c.col === col);
        }
        return false;
      });
    }
    // 通常の矩形ブロック
    return row >= block.startRow && row <= block.endRow &&
           col >= block.startCol && col <= block.endCol;
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // ドラッグ中でなければクリックとして処理
    if (!isDragging && onCellClick) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      // キャンバスの位置を取得（offsetによる移動が反映されている）
      const canvasRect = canvas.getBoundingClientRect();
      
      // アプリ全体のズームスケール
      const appScale = appZoomLevel / 100;
      
      // クリック位置をキャンバス内の座標に変換
      // getBoundingClientRect()はCSSのtransform: scaleが適用された後の座標を返すため、
      // クリック位置もスケール適用後の座標になっている
      const clickX = e.clientX - canvasRect.left;
      const clickY = e.clientY - canvasRect.top;
      
      // アプリ全体のズームが適用されているため、キャンバス内の論理座標に変換するには
      // スケールで割る必要がある
      const adjustedClickX = clickX / appScale;
      const adjustedClickY = clickY / appScale;
      
      // クリック位置がキャンバス内かチェック（スケール補正前の座標で判定）
      // canvasRect.width/heightはスケール適用後の値なので、これもスケールで割る
      const logicalCanvasWidth = canvasRect.width / appScale;
      const logicalCanvasHeight = canvasRect.height / appScale;
      
      if (adjustedClickX < 0 || adjustedClickY < 0 || adjustedClickX > logicalCanvasWidth || adjustedClickY > logicalCanvasHeight) {
        setIsDragging(false);
        return;
      }
      
      // セル座標を計算（cellSizeはCSSピクセル単位）
      const col = Math.floor(adjustedClickX / cellSize) + 1;
      const row = Math.floor(adjustedClickY / cellSize) + 1;
      
      if (row >= 1 && row <= mapData.maxRow && col >= 1 && col <= mapData.maxCol) {
        // ブロック定義内の数値セルか確認
        for (const block of mapData.blocks) {
          // 壁ブロックも含めて全てのブロックを処理
          
          // ブロック範囲内かチェック（cellGroups対応）
          if (isCellInBlock(row, col, block)) {
            // numberCells配列から数値セルを探す
            let foundNumber: number | null = null;
            const numberCell = block.numberCells.find(nc => nc.row === row && nc.col === col);
            if (numberCell) {
              foundNumber = numberCell.value;
            }
            
            // numberCellsに見つからない場合、セルの内容が数値かチェック（ユーザー定義ブロック対応）
            if (foundNumber === null) {
              // まずクリック位置のセルを探す
              let cell = cellsMap.get(`${row}-${col}`);
              
              // セルが見つからない場合、結合セル内かチェック
              if (!cell) {
                // 結合セルの開始位置を探す
                for (const merge of mapData.mergedCells) {
                  if (row >= merge.startRow && row <= merge.endRow &&
                      col >= merge.startCol && col <= merge.endCol) {
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
              // このセルに対応するアイテムを取得
              const matchingItems = items.filter(item => {
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
  }, [isDragging, onCellClick, cellSize, mapData, items, cellsMap, isCellInBlock, appZoomLevel]);

  // ポインターがキャンバスから離れた時のハンドラ（ドラッグ状態のリセットのみ）
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
      <div
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          transformOrigin: '0 0',
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
    </div>
  );
};

export default FocusModeMapCanvas;
