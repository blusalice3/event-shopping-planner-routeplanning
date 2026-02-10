import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  ZoomLevel,
  MergedCellInfo,
  MapCellStateDetail,
  HallDefinition,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../types';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';
import { generateRouteSegments, simplifyPath } from '../../utils/pathfinding';

interface MapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];  // 配列（順序維持）
  zoomLevel: ZoomLevel;
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
}

const BASE_CELL_SIZE = 28; // 基本セルサイズ
const SCROLL_MARGIN = 5; // スクロール余白（行/列数）

const MapCanvas: React.FC<MapCanvasProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds,
  zoomLevel,
  isRouteVisible,
  onCellClick,
  selectedHall,
  vertexSelectionMode,
  cellSelectionMode,
  highlightedCell,
  onZoomChange,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  
  // デバイスピクセル比
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  
  // スケール計算
  const scale = zoomLevel / 100;
  const cellSize = BASE_CELL_SIZE * scale;
  
  // 常に100%時と同等の情報量を表示（ズームレベルに関係なく全情報を描画）
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;
  
  // 前回のセルサイズを記憶
  const prevCellSizeRef = useRef<number>(cellSize);
  const initializedRef = useRef<boolean>(false);
  
  // ピンチズーム用の状態
  const pinchStartDistRef = useRef<number>(0);
  const pinchStartZoomRef = useRef<number>(zoomLevel);
  const pinchCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());

  // ズームレベル変更時に視点を維持するオフセット調整（外部からのズーム変更に対応）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    const prevCellSize = prevCellSizeRef.current;
    
    // 初回またはセルサイズが変わっていない場合はスキップ
    if (!initializedRef.current || prevCellSize === cellSize) {
      prevCellSizeRef.current = cellSize;
      initializedRef.current = true;
      return;
    }
    
    // コンテナの中央座標を基準にズーム（外部変更の場合のフォールバック）
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;
    
    const mapCenterX = (centerX - offset.x) / prevCellSize;
    const mapCenterY = (centerY - offset.y) / prevCellSize;
    
    const newOffsetX = centerX - mapCenterX * cellSize;
    const newOffsetY = centerY - mapCenterY * cellSize;
    
    setOffset({ x: newOffsetX, y: newOffsetY });
    prevCellSizeRef.current = cellSize;
  }, [cellSize, offset.x, offset.y]);

  // ホイールズーム処理（PCブラウザ: マウスカーソル位置を中心にズーム）
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    if (!onZoomChange) return;
    
    const container = containerRef.current;
    if (!container) return;
    
    const rect = container.getBoundingClientRect();
    // マウス位置（コンテナ内座標）
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    
    // 現在のズームレベル
    const currentZoom = zoomLevel;
    // ズーム量（スクロール量に応じて）
    const zoomDelta = -e.deltaY * 0.1;
    const newZoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom + zoomDelta)));
    
    if (newZoom === currentZoom) return;
    
    // マウス位置のマップ座標を計算
    const currentCellSize = BASE_CELL_SIZE * (currentZoom / 100);
    const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
    
    const mapX = (mouseX - offset.x) / currentCellSize;
    const mapY = (mouseY - offset.y) / currentCellSize;
    
    // 新しいオフセット（マウス位置を固定）
    const newOffsetX = mouseX - mapX * newCellSize;
    const newOffsetY = mouseY - mapY * newCellSize;
    
    setOffset({ x: newOffsetX, y: newOffsetY });
    prevCellSizeRef.current = newCellSize;
    onZoomChange(newZoom);
  }, [zoomLevel, offset, onZoomChange]);

  // ピンチズーム処理（スマートフォン/タブレット: ピンチ中心を基準にズーム）
  const handleTouchStart = useCallback((e: TouchEvent) => {
    // タッチポイントを記録
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      activeTouchesRef.current.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
    
    if (activeTouchesRef.current.size === 2) {
      e.preventDefault();
      const touches = Array.from(activeTouchesRef.current.values());
      const dx = touches[1].x - touches[0].x;
      const dy = touches[1].y - touches[0].y;
      pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
      pinchStartZoomRef.current = zoomLevel;
      
      // ピンチ中心（コンテナ内座標）
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        pinchCenterRef.current = {
          x: (touches[0].x + touches[1].x) / 2 - rect.left,
          y: (touches[0].y + touches[1].y) / 2 - rect.top,
        };
      }
    }
  }, [zoomLevel]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    // タッチポイントを更新
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      activeTouchesRef.current.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
    
    if (activeTouchesRef.current.size === 2 && onZoomChange) {
      e.preventDefault();
      const touches = Array.from(activeTouchesRef.current.values());
      const dx = touches[1].x - touches[0].x;
      const dy = touches[1].y - touches[0].y;
      const currentDist = Math.sqrt(dx * dx + dy * dy);
      
      if (pinchStartDistRef.current === 0) return;
      
      const scaleRatio = currentDist / pinchStartDistRef.current;
      const newZoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoomRef.current * scaleRatio)));
      
      if (newZoom === zoomLevel) return;
      
      // ピンチ中心のマップ座標を計算
      const currentCellSize = BASE_CELL_SIZE * (zoomLevel / 100);
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const cx = pinchCenterRef.current.x;
      const cy = pinchCenterRef.current.y;
      
      const mapX = (cx - offset.x) / currentCellSize;
      const mapY = (cy - offset.y) / currentCellSize;
      
      const newOffsetX = cx - mapX * newCellSize;
      const newOffsetY = cy - mapY * newCellSize;
      
      setOffset({ x: newOffsetX, y: newOffsetY });
      prevCellSizeRef.current = newCellSize;
      onZoomChange(newZoom);
    }
  }, [zoomLevel, offset, onZoomChange]);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouchesRef.current.delete(e.changedTouches[i].identifier);
    }
    if (activeTouchesRef.current.size < 2) {
      pinchStartDistRef.current = 0;
    }
  }, []);

  // ホイール・タッチイベントの登録
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('touchstart', handleTouchStart, { passive: false });
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
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  // ホール選択時にオフセットを自動調整してホールを画面内に配置
  // selectedHallが変更された時のみ実行（ズーム変更時は実行しない）
  const prevSelectedHallRef = useRef<HallDefinition | undefined>(undefined);
  
  useEffect(() => {
    // selectedHallが変わっていない場合はスキップ
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;
    
    if (selectedHall && selectedHall.vertices.length >= 4) {
      const container = containerRef.current;
      if (!container) return;
      
      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;
      
      // ホールの範囲を計算（マージン込み）
      const rows = selectedHall.vertices.map(v => v.row);
      const cols = selectedHall.vertices.map(v => v.col);
      const minRow = Math.max(1, Math.min(...rows) - SCROLL_MARGIN);
      const maxRow = Math.max(...rows) + SCROLL_MARGIN;
      const minCol = Math.max(1, Math.min(...cols) - SCROLL_MARGIN);
      const maxCol = Math.max(...cols) + SCROLL_MARGIN;
      
      // ホール範囲のピクセル座標
      const hallLeft = (minCol - 1) * cellSize;
      const hallRight = maxCol * cellSize;
      const hallTop = (minRow - 1) * cellSize;
      const hallBottom = maxRow * cellSize;
      const hallWidth = hallRight - hallLeft;
      const hallHeight = hallBottom - hallTop;
      
      let newOffsetX: number;
      let newOffsetY: number;
      
      // ホールが画面に収まる場合は中央に配置、収まらない場合は左上を基準に
      if (hallWidth <= containerWidth) {
        // ホールを水平方向中央に
        newOffsetX = (containerWidth - hallWidth) / 2 - hallLeft;
      } else {
        // ホール左端を画面左端に合わせる
        newOffsetX = -hallLeft;
      }
      
      if (hallHeight <= containerHeight) {
        // ホールを垂直方向中央に
        newOffsetY = (containerHeight - hallHeight) / 2 - hallTop;
      } else {
        // ホール上端を画面上端に合わせる
        newOffsetY = -hallTop;
      }
      
      setOffset({ x: newOffsetX, y: newOffsetY });
    } else if (!selectedHall) {
      // ホール未選択に戻った時はオフセットをリセット
      setOffset({ x: 0, y: 0 });
    }
  }, [selectedHall, cellSize]);
  
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

  // executeModeItemIdsをSetに変換（状態計算用）
  const executeModeItemIdsSet = useMemo(() => {
    return new Set(executeModeItemIds);
  }, [executeModeItemIds]);
  
  // セルがアイテムを持つかどうかの状態を計算
  const cellStates = useMemo(() => {
    const states = new Map<string, MapCellStateDetail>();
    
    const dayMatch = mapName.match(/^(.+)マップ$/);
    if (!dayMatch) return states;
    const dayName = dayMatch[1].trim();
    
    // 優先アイテムかどうかを判定する関数
    const isPriorityItem = (item: typeof items[number]) => {
      const remarks = item.remarks?.toLowerCase() || '';
      return remarks.includes('優先') || remarks.includes('委託無');
    };
    
    items.forEach((item) => {
      // 日付の比較（トリム済み）
      const itemEventDate = item.eventDate?.trim() || '';
      if (itemEventDate !== dayName) return;
      
      // ブロック名の比較
      // まず完全一致を試み、見つからない場合のみ大文字/小文字無視
      const itemBlockName = item.block?.trim() || '';
      let block = mapData.blocks.find((b) => b.name === itemBlockName);
      
      // 完全一致がない場合、大文字/小文字を無視して検索（ただし同名ブロックが複数ある場合は除く）
      if (!block) {
        const candidates = mapData.blocks.filter((b) => 
          b.name.toLowerCase() === itemBlockName.toLowerCase()
        );
        // 候補が1つだけなら採用（複数ある場合は曖昧なので採用しない）
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
      const existing = states.get(key) || {
        hasItems: false,
        itemCount: 0,
        isVisited: false,
        isFullyVisited: false,
        items: [],
        hasPriorityItem: false,
        hasPriorityUnvisited: false,
      };
      
      existing.hasItems = true;
      existing.itemCount++;
      existing.items.push(item);
      
      // 優先アイテムかどうかをチェック
      if (isPriorityItem(item)) {
        existing.hasPriorityItem = true;
        // 訪問先に未指定の優先アイテムがあるかチェック
        if (!executeModeItemIdsSet.has(item.id)) {
          existing.hasPriorityUnvisited = true;
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
  
  // ルート生成（優先度情報付き）
  const routePoints = useMemo(() => {
    if (!isRouteVisible) return [];
    
    const dayMatch = mapName.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];
    
    // executeModeItemIdsの順序を維持するために、IDの配列順にアイテムを取得
    const itemsMap = new Map(items.map(item => [item.id, item]));
    const executeModeItemIdsArray = Array.from(executeModeItemIds);
    
    const visitItems = executeModeItemIdsArray
      .map(id => itemsMap.get(id))
      .filter((item): item is typeof items[number] => 
        item !== undefined && item.eventDate === dayName
      );
    
    const points: Array<{ row: number; col: number; order: number; priorityLevel: 'none' | 'priority' | 'highest' }> = [];
    
    visitItems.forEach((item, index) => {
      const itemBlockName = item.block?.trim() || '';
      
      // 完全一致優先でブロックを検索
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
      if (cell) {
        points.push({ 
          row: cell.row, 
          col: cell.col, 
          order: index,
          priorityLevel: item.priorityLevel || 'none'
        });
      }
    });
    
    return points;
  }, [mapData.blocks, items, mapName, executeModeItemIds, isRouteVisible]);

  // ルートセグメント
  const routeSegments = useMemo(() => {
    if (!isRouteVisible || routePoints.length < 2) return [];
    
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
    
    const segments = generateRouteSegments(mapData, routePoints, blockNameCells);
    return segments.map((seg) => ({
      ...seg,
      path: simplifyPath(seg.path),
    }));
  }, [isRouteVisible, routePoints, mapData, cellsMap]);

  // 描画
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // キャンバスサイズをコンテナ（ビューポート）サイズに設定（高解像度対応）
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;
    canvas.width = containerWidth * dpr;
    canvas.height = containerHeight * dpr;
    
    // スケール調整
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    // クリア
    ctx.clearRect(0, 0, containerWidth, containerHeight);
    
    // オフセットを適用（以降の描画はマップ座標系で行う）
    ctx.save();
    ctx.translate(offset.x, offset.y);
    
    // 可視セル範囲を計算（描画最適化）
    const visMinCol = Math.max(1, Math.floor(-offset.x / cellSize));
    const visMaxCol = Math.min(mapData.maxCol, Math.ceil((-offset.x + containerWidth) / cellSize) + 1);
    const visMinRow = Math.max(1, Math.floor(-offset.y / cellSize));
    const visMaxRow = Math.min(mapData.maxRow, Math.ceil((-offset.y + containerHeight) / cellSize) + 1);
    
    // セルが可視範囲内かチェックするヘルパー
    const isCellVisible = (row: number, col: number, spanRows = 1, spanCols = 1): boolean => {
      return col + spanCols - 1 >= visMinCol && col <= visMaxCol &&
             row + spanRows - 1 >= visMinRow && row <= visMaxRow;
    };
    
    // アンチエイリアス設定
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 黄色と黒の斜めストライプパターンを作成
    const createWarningStripePattern = () => {
      const patternCanvas = document.createElement('canvas');
      const stripeSize = Math.max(8, cellSize * 0.4); // ストライプの太さ
      patternCanvas.width = stripeSize * 2;
      patternCanvas.height = stripeSize * 2;
      const patternCtx = patternCanvas.getContext('2d');
      if (!patternCtx) return null;
      
      // 背景を黄色で塗りつぶし
      patternCtx.fillStyle = '#FFD600';
      patternCtx.fillRect(0, 0, stripeSize * 2, stripeSize * 2);
      
      // 黒の斜めストライプを描画
      patternCtx.fillStyle = '#212121';
      patternCtx.beginPath();
      // 左下から右上への斜め線（パターンとして繰り返される）
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

    // 1. 背景を描画
    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;
      
      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const spanCols = merge ? (merge.endCol - merge.startCol + 1) : 1;
      const spanRows = merge ? (merge.endRow - merge.startRow + 1) : 1;
      if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;
      
      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;
      
      const width = spanCols * cellSize;
      const height = spanRows * cellSize;
      
      // 背景色
      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }
      
      // セル状態に応じた背景
      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state) {
        if (state.isFullyVisited) {
          ctx.fillStyle = 'rgba(239, 83, 80, 0.5)';  // 赤：全訪問済み
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPriorityUnvisited && warningPattern) {
          // 黄色と黒の斜めストライプ：優先/委託無の未訪問アイテムあり（一部訪問より優先）
          ctx.fillStyle = warningPattern;
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          ctx.fillStyle = 'rgba(255, 238, 88, 0.5)';  // 黄：一部訪問済み（優先アイテムは訪問済み）
          ctx.fillRect(x, y, width, height);
        } else if (state.hasItems) {
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)';  // 青：通常の未訪問アイテムあり
          ctx.fillRect(x, y, width, height);
        }
      }
    });
    
    // 2. 罫線を描画（ズームレベルに応じて）
    if (showBorders) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;
        
        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const spanCols = merge ? (merge.endCol - merge.startCol + 1) : 1;
        const spanRows = merge ? (merge.endRow - merge.startRow + 1) : 1;
        if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;
        
        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;
        
        const width = spanCols * cellSize;
        const height = spanRows * cellSize;
        
        const { borders } = cell;
        
        const drawBorder = (
          startX: number, startY: number,
          endX: number, endY: number,
          border: typeof borders.top
        ) => {
          if (!border) return;
          
          ctx.beginPath();
          ctx.strokeStyle = border.color || '#000000';  // デフォルト色を黒に変更
          
          let lineWidth = 1;
          switch (border.style) {
            case 'thin': lineWidth = 1; break;
            case 'medium': lineWidth = 2; break;
            case 'thick': lineWidth = 3; break;
            default: lineWidth = 1;
          }
          ctx.lineWidth = lineWidth;
          
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
        };
        
        if (borders.top) drawBorder(x, y, x + width, y, borders.top);
        if (borders.right) drawBorder(x + width, y, x + width, y + height, borders.right);
        if (borders.bottom) drawBorder(x, y + height, x + width, y + height, borders.bottom);
        if (borders.left) drawBorder(x, y, x, y + height, borders.left);
        
        // 数値セルの枠（罫線がない場合のみ、薄いグレーの点線で表示）
        // 緑枠は削除 - 訪問先のセルは別の方法でハイライト
      });
    }
    
    // 3. テキストを描画（ズームレベルに応じて）
    if (showNumbers) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged || cell.value === null) return;
        
        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const spanCols = merge ? (merge.endCol - merge.startCol + 1) : 1;
        const spanRows = merge ? (merge.endRow - merge.startRow + 1) : 1;
        if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;
        
        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;
        
        const width = spanCols * cellSize;
        const height = spanRows * cellSize;
        
        const text = String(cell.value);
        const isVertical = cell.isVerticalText;
        
        // フォントサイズを計算
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
        
        // テキスト色とスタイル
        const state = cellStates.get(`${cell.row}-${cell.col}`);
        
        // 優先アイテム（黄黒ストライプ背景）の場合は白背景を描画
        if (state?.hasPriorityUnvisited && typeof cell.value === 'number') {
          const textMetrics = ctx.measureText(text);
          const textWidth = textMetrics.width;
          const textHeight = fontSize;
          const padding = fontSize * 0.3;
          
          // 角丸の白背景を描画
          const bgX = x + width / 2 - textWidth / 2 - padding;
          const bgY = y + height / 2 - textHeight / 2 - padding * 0.5;
          const bgWidth = textWidth + padding * 2;
          const bgHeight = textHeight + padding;
          const radius = Math.min(padding, bgHeight / 2);
          
          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.beginPath();
          ctx.roundRect(bgX, bgY, bgWidth, bgHeight, radius);
          ctx.fill();
          
          // テキスト色は黒で目立たせる
          ctx.fillStyle = '#212121';
        } else if (state?.isFullyVisited) {
          ctx.fillStyle = '#B71C1C';  // 濃い赤：全訪問済み
        } else if (state?.isVisited) {
          ctx.fillStyle = '#F57F17';  // オレンジ：一部訪問済み
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0';  // 青：通常の未訪問アイテムあり
        } else {
          ctx.fillStyle = cell.fontColor || '#333333';
        }
        
        // 縦書きの場合
        if (isVertical) {
          // 改行で分割されている場合は各行を別々に描画
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
    } else {
      // 縮小時は数値セルのみドット表示
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;
        
        const state = cellStates.get(`${cell.row}-${cell.col}`);
        if (!state?.hasItems) return;
        
        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;
        
        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;
        
        // ドット表示
        const dotSize = Math.max(cellSize * 0.4, 4);
        ctx.beginPath();
        
        if (state.isFullyVisited) {
          ctx.fillStyle = '#EF5350';  // 赤：全訪問済み
        } else if (state.hasPriorityUnvisited) {
          // 黄黒の警告色（ドットでは黄色に黒枠）- 一部訪問より優先
          ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#FFD600';
          ctx.fill();
          ctx.strokeStyle = '#212121';
          ctx.lineWidth = Math.max(1, dotSize * 0.2);
          ctx.stroke();
          return; // 既に描画済みなので戻る
        } else if (state.isVisited) {
          ctx.fillStyle = '#FFEE58';  // 黄：一部訪問済み
        } else {
          ctx.fillStyle = '#42A5F5';  // 青：通常の未訪問アイテムあり
        }
        
        ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    
    // 4. ルートを描画（優先度で色分け、重複部分は平行線）
    if (isRouteVisible && routeSegments.length > 0) {
      // 優先度ごとの色を定義
      const getPriorityColor = (priority: 'none' | 'priority' | 'highest' | undefined): string => {
        switch (priority) {
          case 'highest': return '#EF4444';  // 赤
          case 'priority': return '#F97316';  // オレンジ
          default: return '#1976D2';  // 青
        }
      };
      
      // グループ間接続かどうかを判定
      const isGroupTransition = (fromPriority: string | undefined, toPriority: string | undefined): boolean => {
        const from = fromPriority || 'none';
        const to = toPriority || 'none';
        return from !== to;
      };
      
      // エッジごとの通過情報を収集（重複検出用）
      // キー: "row1,col1-row2,col2"（小さい座標を先に）
      const edgeUsage = new Map<string, Set<'none' | 'priority' | 'highest'>>();
      
      const getEdgeKey = (r1: number, c1: number, r2: number, c2: number): string => {
        // 常に小さい座標を先にして正規化
        if (r1 < r2 || (r1 === r2 && c1 < c2)) {
          return `${r1},${c1}-${r2},${c2}`;
        }
        return `${r2},${c2}-${r1},${c1}`;
      };
      
      // 全セグメントのエッジを収集
      routeSegments.forEach((segment) => {
        if (segment.path.length < 2) return;
        
        // グループ間接続はグレーなので重複カウントに含めない
        if (isGroupTransition(segment.fromPriority, segment.toPriority)) return;
        
        const priority = segment.fromPriority || 'none';
        
        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];
          const key = getEdgeKey(p1.row, p1.col, p2.row, p2.col);
          
          if (!edgeUsage.has(key)) {
            edgeUsage.set(key, new Set());
          }
          edgeUsage.get(key)!.add(priority);
        }
      });
      
      // セグメントを描画
      const lineWidth = Math.max(2, cellSize * 0.08);  // 少し細く
      
      // 平行線のオフセット量を計算（セルサイズに応じて調整）
      const parallelOffset = Math.max(3, cellSize * 0.12);
      
      // 線をオフセットする関数
      const getOffsetPoints = (
        px1: number, py1: number, px2: number, py2: number,
        offset: number
      ): { x1: number; y1: number; x2: number; y2: number } => {
        // 線の方向ベクトル
        const dx = px2 - px1;
        const dy = py2 - py1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return { x1: px1, y1: py1, x2: px2, y2: py2 };
        
        // 法線ベクトル（90度回転）
        const nx = -dy / len;
        const ny = dx / len;
        
        return {
          x1: px1 + nx * offset,
          y1: py1 + ny * offset,
          x2: px2 + nx * offset,
          y2: py2 + ny * offset,
        };
      };
      
      routeSegments.forEach((segment) => {
        if (segment.path.length < 2) return;
        
        const isTransition = isGroupTransition(segment.fromPriority, segment.toPriority);
        const segmentPriority = segment.fromPriority || 'none';
        
        // グループ間接続はグレー
        const baseColor = isTransition ? '#9CA3AF' : getPriorityColor(segment.fromPriority);
        
        // パスを一度に描画するのではなく、エッジごとに描画
        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];
          const edgeKey = getEdgeKey(p1.row, p1.col, p2.row, p2.col);
          
          const px1 = (p1.col - 0.5) * cellSize;
          const py1 = (p1.row - 0.5) * cellSize;
          const px2 = (p2.col - 0.5) * cellSize;
          const py2 = (p2.row - 0.5) * cellSize;
          
          // グループ間接続は重複チェック不要（中央に描画）
          if (isTransition) {
            ctx.beginPath();
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(px1, py1);
            ctx.lineTo(px2, py2);
            ctx.stroke();
            continue;
          }
          
          // 重複しているエッジかどうかを確認
          const usedPriorities = edgeUsage.get(edgeKey);
          const isOverlapping = usedPriorities && usedPriorities.size > 1;
          
          if (isOverlapping) {
            // 重複エッジ：平行線で描画
            const priorities = Array.from(usedPriorities!).sort((a, b) => {
              const order = { 'highest': 0, 'priority': 1, 'none': 2 };
              return order[a] - order[b];
            });
            
            // このセグメントの優先度のインデックスを取得
            const priorityIndex = priorities.indexOf(segmentPriority);
            if (priorityIndex === -1) continue;
            
            // オフセット量を計算（中央を基準に均等に配置）
            const totalLines = priorities.length;
            const offsetIndex = priorityIndex - (totalLines - 1) / 2;
            const offset = offsetIndex * parallelOffset;
            
            // オフセットした座標を計算
            const offsetted = getOffsetPoints(px1, py1, px2, py2, offset);
            
            ctx.beginPath();
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(offsetted.x1, offsetted.y1);
            ctx.lineTo(offsetted.x2, offsetted.y2);
            ctx.stroke();
          } else {
            // 重複なし：通常の実線
            ctx.beginPath();
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(px1, py1);
            ctx.lineTo(px2, py2);
            ctx.stroke();
          }
        }
        
        // 矢印（セグメント終点に描画）
        if (segment.path.length >= 2) {
          const last = segment.path[segment.path.length - 1];
          const prev = segment.path[segment.path.length - 2];
          
          const endX = (last.col - 0.5) * cellSize;
          const endY = (last.row - 0.5) * cellSize;
          const angle = Math.atan2(
            (last.row - prev.row) * cellSize,
            (last.col - prev.col) * cellSize
          );
          
          const arrowSize = Math.max(6, cellSize * 0.25);
          ctx.beginPath();
          ctx.fillStyle = baseColor;
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
      });
      
      // setLineDashをリセット
      ctx.setLineDash([]);
      
      // 訪問順番号（優先度で色分け）
      if (isDetailedView) {
        routePoints.forEach((point) => {
          const px = (point.col - 0.5) * cellSize;
          const py = (point.row - 0.5) * cellSize;
          
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
          ctx.fillText(String(point.order + 1), px, py);
        });
      }
    }

    // 5. 訪問先リストからのセルハイライト
    if (highlightedCell) {
      const x = (highlightedCell.col - 1) * cellSize;
      const y = (highlightedCell.row - 1) * cellSize;
      
      // パルスアニメーション風のハイライト
      ctx.save();
      
      // 外側のリング
      ctx.strokeStyle = '#FF6B00';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);
      
      // 内側のリング
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);
      
      ctx.restore();
    }

    // 6. ホール頂点選択プレビュー（多角形オーバーレイ）
    if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length >= 3) {
      const vertices = vertexSelectionMode.clickedVertices;
      
      // プレビュー用に重心角度ソートして辺交差を防止
      const centroidRow = vertices.reduce((s, v) => s + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((s, v) => s + v.col, 0) / vertices.length;
      const sortedVertices = [...vertices].sort((a, b) => {
        return Math.atan2(a.row - centroidRow, a.col - centroidCol)
             - Math.atan2(b.row - centroidRow, b.col - centroidCol);
      });
      
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.4)'; // 不透明度40%の赤
      
      sortedVertices.forEach((vertex, i) => {
        // セルの中心座標
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
      
      // 頂点マーカーと番号を描画（クリック順で表示）
      vertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;
        
        // 頂点マーカー（白い円）
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        // 番号
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF0000';
        ctx.fillText(String(i + 1), px, py);
      });
    } else if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
      // 3点未満の場合は点と線のみ表示
      const vertices = vertexSelectionMode.clickedVertices;
      
      // 線を描画（2点以上の場合）
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
      
      // 頂点マーカーと番号を描画
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
        ctx.fillText(String(i + 1), px, py);
      });
    }
    
    // 7. ブロック定義セル選択マーカー + 範囲プレビュー
    if (cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
      const clickedCells = cellSelectionMode.clickedCells;
      const selType = cellSelectionMode.type;
      
      // Phase 3: 薄緑色の範囲プレビュー（2点以上）
      if (clickedCells.length >= 2) {
        if (selType === 'individual') {
          // 個別モード: 各セルを個別に薄緑でハイライト
          clickedCells.forEach(cell => {
            // 結合セル対応
            const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
            const cx = mergeInfo ? (mergeInfo.startCol - 1) * cellSize : (cell.col - 1) * cellSize;
            const cy = mergeInfo ? (mergeInfo.startRow - 1) * cellSize : (cell.row - 1) * cellSize;
            const cw = mergeInfo ? (mergeInfo.endCol - mergeInfo.startCol + 1) * cellSize : cellSize;
            const ch = mergeInfo ? (mergeInfo.endRow - mergeInfo.startRow + 1) * cellSize : cellSize;
            ctx.fillStyle = 'rgba(144, 238, 144, 0.35)';
            ctx.fillRect(cx, cy, cw, ch);
          });
        } else {
          // corner/multiCorner/rangeStart: バウンディングボックスを薄緑でハイライト
          const rows = clickedCells.map(c => c.row);
          const cols = clickedCells.map(c => c.col);
          const minRow = Math.min(...rows);
          const maxRow = Math.max(...rows);
          const minCol = Math.min(...cols);
          const maxCol = Math.max(...cols);
          
          // 結合セルを考慮して実際の表示範囲を拡張
          let displayMaxRow = maxRow;
          let displayMaxCol = maxCol;
          clickedCells.forEach(cell => {
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
          // 枠線
          ctx.strokeStyle = 'rgba(76, 175, 80, 0.7)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 3]);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
        }
      }
      
      // Phase 2: 青色マーカーを描画
      clickedCells.forEach((cell, i) => {
        // 結合セルの場合は結合範囲の中心にマーカーを表示
        const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        let px: number, py: number;
        if (mergeInfo) {
          px = ((mergeInfo.startCol - 1) + (mergeInfo.endCol - mergeInfo.startCol + 1) / 2) * cellSize;
          py = ((mergeInfo.startRow - 1) + (mergeInfo.endRow - mergeInfo.startRow + 1) / 2) * cellSize;
        } else {
          px = (cell.col - 0.5) * cellSize;
          py = (cell.row - 0.5) * cellSize;
        }
        
        // マーカー（白い円＋青枠）
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        // 番号
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#2196F3';
        ctx.fillText(String(i + 1), px, py);
      });
    }
    
    // ctx.translate を解除
    ctx.restore();
  }, [
    mapData,
    cellSize,
    cellStates,
    mergedCellsMap,
    isRouteVisible,
    routeSegments,
    routePoints,
    dpr,
    isDetailedView,
    showNumbers,
    showBorders,
    vertexSelectionMode,
    cellSelectionMode,
    highlightedCell,
    offset,
  ]);

  // クリック処理
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDragging) return;
      
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const rect = canvas.getBoundingClientRect();
      // Canvas表示サイズに対するクリック位置を計算
      const scaleX = canvas.width / dpr / rect.width;
      const scaleY = canvas.height / dpr / rect.height;
      
      // ビューポート座標 → マップ座標（オフセットを引く）
      const viewX = (e.clientX - rect.left) * scaleX;
      const viewY = (e.clientY - rect.top) * scaleY;
      const x = viewX - offset.x;
      const y = viewY - offset.y;
      
      // 頂点選択モード中は、まず頂点マーカーのクリックをチェック
      if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize; // クリック判定を少し広めに
        
        for (const vertex of vertexSelectionMode.clickedVertices) {
          const markerX = (vertex.col - 0.5) * cellSize;
          const markerY = (vertex.row - 0.5) * cellSize;
          const distance = Math.sqrt(Math.pow(x - markerX, 2) + Math.pow(y - markerY, 2));
          
          if (distance <= clickRadius) {
            // 頂点マーカーがクリックされた → その頂点のセル座標でイベント発火
            window.dispatchEvent(new CustomEvent('mapCellClick', {
              detail: { row: vertex.row, col: vertex.col }
            }));
            return; // 頂点クリックの場合は通常のセルクリック処理をスキップ
          }
        }
      }
      
      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;
      
      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }
      
      // セル選択モード中：青マーカーのクリック検出
      if (cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize;
        
        for (const cell of cellSelectionMode.clickedCells) {
          const mi = mergedCellsMap.get(`${cell.row}-${cell.col}`);
          let mx: number, my: number;
          if (mi) {
            mx = ((mi.startCol - 1) + (mi.endCol - mi.startCol + 1) / 2) * cellSize;
            my = ((mi.startRow - 1) + (mi.endRow - mi.startRow + 1) / 2) * cellSize;
          } else {
            mx = (cell.col - 0.5) * cellSize;
            my = (cell.row - 0.5) * cellSize;
          }
          const distance = Math.sqrt(Math.pow(x - mx, 2) + Math.pow(y - my, 2));
          if (distance <= clickRadius) {
            // マーカークリック → そのセル座標でイベント発火（解除される）
            window.dispatchEvent(new CustomEvent('mapCellClick', {
              detail: { row: cell.row, col: cell.col }
            }));
            return;
          }
        }
      }
      
      // セル選択モード中：結合セルを開始セルに解決
      let resolvedRow = row;
      let resolvedCol = col;
      if (cellSelectionMode) {
        for (const merge of mapData.mergedCells) {
          if (row >= merge.startRow && row <= merge.endRow &&
              col >= merge.startCol && col <= merge.endCol) {
            resolvedRow = merge.startRow;
            resolvedCol = merge.startCol;
            break;
          }
        }
      }
      
      // ブロック定義パネル用のカスタムイベントを発火
      window.dispatchEvent(new CustomEvent('mapCellClick', {
        detail: { row: resolvedRow, col: resolvedCol }
      }));
      
      const state = cellStates.get(`${row}-${col}`);
      const matchingItems = state?.items || [];
      
      onCellClick(row, col, matchingItems);
    },
    [cellSize, mapData.maxRow, mapData.maxCol, mapData.mergedCells, cellStates, onCellClick, isDragging, dpr, vertexSelectionMode, cellSelectionMode, mergedCellsMap, offset]
  );

  // ホールのスクロール範囲を計算
  const hallScrollBounds = useMemo(() => {
    if (selectedHall && selectedHall.vertices.length >= 4) {
      const rows = selectedHall.vertices.map(v => v.row);
      const cols = selectedHall.vertices.map(v => v.col);
      return {
        minRow: Math.max(1, Math.min(...rows) - SCROLL_MARGIN),
        maxRow: Math.max(...rows) + SCROLL_MARGIN,
        minCol: Math.max(1, Math.min(...cols) - SCROLL_MARGIN),
        maxCol: Math.max(...cols) + SCROLL_MARGIN,
      };
    }
    return null;
  }, [selectedHall]);

  // スクロール制限を計算する関数
  const calculateScrollLimits = useCallback(() => {
    if (!hallScrollBounds) return null;
    const container = containerRef.current;
    if (!container) return null;
    
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    // ホール範囲のピクセル座標
    const hallLeft = (hallScrollBounds.minCol - 1) * cellSize;
    const hallRight = hallScrollBounds.maxCol * cellSize;
    const hallTop = (hallScrollBounds.minRow - 1) * cellSize;
    const hallBottom = hallScrollBounds.maxRow * cellSize;
    const hallWidth = hallRight - hallLeft;
    const hallHeight = hallBottom - hallTop;
    
    // スクロール制限を計算
    // 原則: ホール範囲が常に画面内に表示されるようにする
    let minX: number, maxX: number, minY: number, maxY: number;
    
    if (hallWidth <= containerWidth) {
      // ホール幅が画面幅以下の場合、ホールを画面内に収める
      // offset.x = -hallLeft でホール左端が画面左端に来る
      // offset.x = containerWidth - hallRight でホール右端が画面右端に来る
      minX = containerWidth - hallRight;
      maxX = -hallLeft;
    } else {
      // ホール幅が画面幅より大きい場合
      // ホール左端が画面右端より左に、ホール右端が画面左端より右に
      minX = containerWidth - hallRight;
      maxX = -hallLeft;
    }
    
    if (hallHeight <= containerHeight) {
      // ホール高さが画面高さ以下の場合
      minY = containerHeight - hallBottom;
      maxY = -hallTop;
    } else {
      // ホール高さが画面高さより大きい場合
      minY = containerHeight - hallBottom;
      maxY = -hallTop;
    }
    
    return { minX, maxX, minY, maxY };
  }, [hallScrollBounds, cellSize]);
  
  // ドラッグ処理
  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // ピンチズーム中はドラッグを無視
    if (activeTouchesRef.current.size >= 2) return;
    setIsDragging(false);
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragStartOffset({ ...offset });
  }, [offset]);
  
  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== 1) return;
    // ピンチズーム中はドラッグを無視
    if (activeTouchesRef.current.size >= 2) return;
    
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      setIsDragging(true);
    }
    
    // 新しいオフセットを計算
    let newX = dragStartOffset.x + dx;
    let newY = dragStartOffset.y + dy;
    
    // ホール選択時はスクロール範囲を制限
    const limits = calculateScrollLimits();
    if (limits) {
      newX = Math.max(limits.minX, Math.min(limits.maxX, newX));
      newY = Math.max(limits.minY, Math.min(limits.maxY, newY));
    }
    
    setOffset({
      x: newX,
      y: newY,
    });
  }, [dragStart, dragStartOffset, calculateScrollLimits]);
  
  const handlePointerUp = useCallback(() => {
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
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        style={{
          cursor: isDragging ? 'grabbing' : 'grab',
          touchAction: 'none',
        }}
      />
    </div>
  );
};

export default MapCanvas;
