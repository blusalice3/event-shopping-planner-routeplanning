import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  ZoomLevel,
  MergedCellInfo,
  MapCellStateDetail,
  HallDefinition,
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
  
  // 詳細表示かどうか（拡大時は詳細、縮小時はシンプル）
  const isDetailedView = zoomLevel >= 80;
  const showNumbers = zoomLevel >= 60;
  const showBorders = zoomLevel >= 40;

  // スクロール範囲の計算（ホール選択時は制限）
  const scrollBounds = useMemo(() => {
    if (selectedHall && selectedHall.vertices.length >= 4) {
      // ホールの頂点から範囲を計算
      const rows = selectedHall.vertices.map(v => v.row);
      const cols = selectedHall.vertices.map(v => v.col);
      const minRow = Math.max(1, Math.min(...rows) - SCROLL_MARGIN);
      const maxRow = Math.max(...rows) + SCROLL_MARGIN;
      const minCol = Math.max(1, Math.min(...cols) - SCROLL_MARGIN);
      const maxCol = Math.max(...cols) + SCROLL_MARGIN;
      return { minRow, maxRow, minCol, maxCol };
    }
    // ホール未選択時は全範囲
    return {
      minRow: 1,
      maxRow: mapData.maxRow,
      minCol: 1,
      maxCol: mapData.maxCol,
    };
  }, [selectedHall, mapData.maxRow, mapData.maxCol]);
  
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
    const dayName = dayMatch[1];
    
    items.forEach((item) => {
      if (item.eventDate !== dayName) return;
      
      const block = mapData.blocks.find((b) => b.name === item.block);
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
      };
      
      existing.hasItems = true;
      existing.itemCount++;
      existing.items.push(item);
      
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
  
  // ルート生成
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
    
    const points: Array<{ row: number; col: number; order: number }> = [];
    
    visitItems.forEach((item, index) => {
      const block = mapData.blocks.find((b) => b.name === item.block);
      if (!block) return;
      
      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;
      
      const num = parseInt(numStr, 10);
      const cell = block.numberCells.find((nc) => nc.value === num);
      if (cell) {
        points.push({ row: cell.row, col: cell.col, order: index });
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
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // キャンバスサイズを設定（高解像度対応）
    const displayWidth = mapData.maxCol * cellSize;
    const displayHeight = mapData.maxRow * cellSize;
    
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${displayHeight}px`;
    canvas.width = displayWidth * dpr;
    canvas.height = displayHeight * dpr;
    
    // スケール調整
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    // クリア
    ctx.clearRect(0, 0, displayWidth, displayHeight);
    
    // アンチエイリアス設定
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
      
      // セル状態に応じた背景
      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state) {
        if (state.isFullyVisited) {
          ctx.fillStyle = 'rgba(239, 83, 80, 0.5)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          ctx.fillStyle = 'rgba(255, 238, 88, 0.5)';
          ctx.fillRect(x, y, width, height);
        } else if (state.hasItems) {
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)';
          ctx.fillRect(x, y, width, height);
        }
      }
    });
    
    // 2. 罫線を描画（ズームレベルに応じて）
    if (showBorders) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;
        
        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;
        
        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;
        
        const { borders } = cell;
        
        const drawBorder = (
          startX: number, startY: number,
          endX: number, endY: number,
          border: typeof borders.top
        ) => {
          if (!border) return;
          
          ctx.beginPath();
          ctx.strokeStyle = border.color || '#4CAF50';
          
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
        
        // 数値セルの枠
        if (typeof cell.value === 'number' && cell.value > 0 && cell.value <= 100) {
          if (!borders.top && !borders.right && !borders.bottom && !borders.left) {
            ctx.strokeStyle = '#4CAF50';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
          }
        }
      });
    }
    
    // 3. テキストを描画（ズームレベルに応じて）
    if (showNumbers) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged || cell.value === null) return;
        
        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;
        
        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;
        
        const text = String(cell.value);
        
        // フォントサイズを計算
        let fontSize: number;
        if (merge) {
          // 結合セルは大きめ
          fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
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
        
        // テキスト色
        const state = cellStates.get(`${cell.row}-${cell.col}`);
        if (state?.isFullyVisited) {
          ctx.fillStyle = '#B71C1C';
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0';
        } else {
          ctx.fillStyle = '#333333';
        }
        
        ctx.fillText(text, x + width / 2, y + height / 2);
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
          ctx.fillStyle = '#EF5350';
        } else if (state.isVisited) {
          ctx.fillStyle = '#FFEE58';
        } else {
          ctx.fillStyle = '#42A5F5';
        }
        
        ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    
    // 4. ルートを描画
    if (isRouteVisible && routeSegments.length > 0) {
      routeSegments.forEach((segment) => {
        if (segment.path.length < 2) return;
        
        ctx.beginPath();
        ctx.strokeStyle = '#1976D2';
        ctx.lineWidth = Math.max(2, cellSize * 0.1);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        segment.path.forEach((point, i) => {
          const px = (point.col - 0.5) * cellSize;
          const py = (point.row - 0.5) * cellSize;
          
          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        });
        
        ctx.stroke();
        
        // 矢印
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
          ctx.fillStyle = '#1976D2';
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
      
      // 訪問順番号
      if (isDetailedView) {
        routePoints.forEach((point) => {
          const px = (point.col - 0.5) * cellSize;
          const py = (point.row - 0.5) * cellSize;
          
          const circleSize = Math.max(12, cellSize * 0.5);
          
          ctx.beginPath();
          ctx.fillStyle = '#1976D2';
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

    // 5. ホール頂点選択プレビュー（多角形オーバーレイ）
    if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length >= 3) {
      const vertices = vertexSelectionMode.clickedVertices;
      
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.4)'; // 不透明度40%の赤
      
      vertices.forEach((vertex, i) => {
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
      
      // 頂点マーカーと番号を描画
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
      
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      
      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;
      
      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }
      
      // ブロック定義パネル用のカスタムイベントを発火
      window.dispatchEvent(new CustomEvent('mapCellClick', {
        detail: { row, col }
      }));
      
      const state = cellStates.get(`${row}-${col}`);
      const matchingItems = state?.items || [];
      
      onCellClick(row, col, matchingItems);
    },
    [cellSize, mapData.maxRow, mapData.maxCol, cellStates, onCellClick, isDragging, dpr]
  );
  
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
    
    // 新しいオフセットを計算
    let newX = dragStartOffset.x + dx;
    let newY = dragStartOffset.y + dy;
    
    // スクロール範囲を制限（ホール選択時）
    if (selectedHall && selectedHall.vertices.length >= 4) {
      const container = containerRef.current;
      if (container) {
        const containerWidth = container.clientWidth;
        const containerHeight = container.clientHeight;
        
        // スクロール可能範囲の計算
        const minX = Math.min(0, containerWidth - scrollBounds.maxCol * cellSize - cellSize);
        const maxX = Math.max(0, -(scrollBounds.minCol - 1) * cellSize);
        const minY = Math.min(0, containerHeight - scrollBounds.maxRow * cellSize - cellSize);
        const maxY = Math.max(0, -(scrollBounds.minRow - 1) * cellSize);
        
        newX = Math.max(minX, Math.min(maxX, newX));
        newY = Math.max(minY, Math.min(maxY, newY));
      }
    }
    
    setOffset({
      x: newX,
      y: newY,
    });
  }, [dragStart, dragStartOffset, selectedHall, scrollBounds, cellSize]);
  
  const handlePointerUp = useCallback(() => {
    setTimeout(() => {
      setIsDragging(false);
    }, 100);
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative overflow-auto bg-white"
      style={{ width: '100%', height: '100%' }}
    >
      <div
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          transformOrigin: '0 0',
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
    </div>
  );
};

export default MapCanvas;
