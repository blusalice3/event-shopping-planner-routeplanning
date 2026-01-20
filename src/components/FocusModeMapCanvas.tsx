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
  currentPhase: 'normal' | 'postponed' | 'late';
  // 自動ズーム用コールバック
  onZoomChange?: (newZoom: ZoomLevel) => void;
  // セルクリック時のコールバック（新規アイテム追加用）
  onCellClick?: (blockName: string, number: number, matchingItems: ShoppingItem[]) => void;
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
  currentPhase,
  onZoomChange,
  onCellClick,
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
    });

    return states;
  }, [mapData.blocks, items, dayName, currentVisitKey, nextVisitKey]);

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

  // ルートの範囲を計算（現在位置と次の目的地を含む矩形）
  const routeBounds = useMemo(() => {
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
    
    // マージンを追加
    const margin = 3;
    minRow = Math.max(1, minRow - margin);
    maxRow = maxRow + margin;
    minCol = Math.max(1, minCol - margin);
    maxCol = maxCol + margin;
    
    return { minRow, maxRow, minCol, maxCol };
  }, [currentCellCoords, nextCellCoords]);

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

    // ルートがある場合はルート全体を中心に表示
    if (routeBounds && currentCellCoords) {
      const routeWidth = (routeBounds.maxCol - routeBounds.minCol + 1);
      const routeHeight = (routeBounds.maxRow - routeBounds.minRow + 1);
      
      // ルート全体が収まる最適なズームレベルを計算
      const requiredWidthZoom = (containerWidth / (routeWidth * BASE_CELL_SIZE)) * 100;
      const requiredHeightZoom = (containerHeight / (routeHeight * BASE_CELL_SIZE)) * 100;
      const optimalZoom = Math.min(requiredWidthZoom, requiredHeightZoom, 100);
      
      // ズームレベルを調整（最小30%、最大100%）
      const newZoom = Math.max(30, Math.min(100, Math.floor(optimalZoom / 10) * 10)) as ZoomLevel;
      
      if (onZoomChange) {
        onZoomChange(newZoom);
      }
      
      // ルートの中心を画面中央に配置
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
      const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
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
  }, [selectedHall, cellSize, routeBounds, currentCellCoords, onZoomChange]);

  // 訪問先が変わった時にルート全体を画面に収める
  useEffect(() => {
    // 訪問先キーが変わっていない場合はスキップ
    if (prevVisitKeyRef.current === currentVisitKey) {
      return;
    }
    prevVisitKeyRef.current = currentVisitKey;

    if (!routeBounds || !currentCellCoords) return;
    const container = containerRef.current;
    if (!container) return;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    // ルート全体が収まる最適なズームレベルを計算
    const routeWidth = (routeBounds.maxCol - routeBounds.minCol + 1);
    const routeHeight = (routeBounds.maxRow - routeBounds.minRow + 1);
    
    const requiredWidthZoom = (containerWidth / (routeWidth * BASE_CELL_SIZE)) * 100;
    const requiredHeightZoom = (containerHeight / (routeHeight * BASE_CELL_SIZE)) * 100;
    const optimalZoom = Math.min(requiredWidthZoom, requiredHeightZoom, 100);
    
    // ズームレベルを調整（最小30%、最大100%）
    const newZoom = Math.max(30, Math.min(100, Math.floor(optimalZoom / 10) * 10)) as ZoomLevel;
    
    if (onZoomChange) {
      onZoomChange(newZoom);
    }
    
    // ルートの中心を画面中央に配置
    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    const routeCenterCol = (routeBounds.minCol + routeBounds.maxCol) / 2;
    const routeCenterRow = (routeBounds.minRow + routeBounds.maxRow) / 2;
    const routeCenterX = (routeCenterCol - 0.5) * newCellSize;
    const routeCenterY = (routeCenterRow - 0.5) * newCellSize;
    
    const newOffsetX = containerWidth / 2 - routeCenterX;
    const newOffsetY = containerHeight / 2 - routeCenterY;
    
    setOffset({ x: newOffsetX, y: newOffsetY });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentVisitKey, routeBounds, currentCellCoords, onZoomChange]);

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
          // 現在位置: オレンジ背景
          ctx.fillStyle = 'rgba(255, 152, 0, 0.6)';
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
          ctx.lineWidth = border.style === 'thick' ? 2 : border.style === 'medium' ? 1.5 : 1;
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
        const fontSize = isDetailedView
          ? Math.max(8, Math.min(cellSize * 0.5, 14))
          : Math.max(6, Math.min(cellSize * 0.4, 10));

        ctx.font = `${fontSize}px sans-serif`;
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

    // 4. ルートを描画（点線: 未訪問部分、実線: 訪問済み部分）
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

    // 6. 次の目的地マーカー（現在位置より先に描画して下に配置）
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

    // 7. 現在位置マーカー（次の目的地より上に描画）
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
    dpr,
    isDetailedView,
    showNumbers,
    showBorders,
    currentCellCoords,
    nextCellCoords,
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
      
      // クリック位置をキャンバス内の座標に変換
      const clickX = e.clientX - canvasRect.left;
      const clickY = e.clientY - canvasRect.top;
      
      // クリック位置がキャンバス内かチェック（負の値や範囲外は無視）
      if (clickX < 0 || clickY < 0 || clickX > canvasRect.width || clickY > canvasRect.height) {
        setIsDragging(false);
        return;
      }
      
      // セル座標を計算（cellSizeはCSSピクセル単位）
      const col = Math.floor(clickX / cellSize) + 1;
      const row = Math.floor(clickY / cellSize) + 1;
      
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
  }, [isDragging, onCellClick, cellSize, mapData, items, cellsMap, isCellInBlock]);

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
