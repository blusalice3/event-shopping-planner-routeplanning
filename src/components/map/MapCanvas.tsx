import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  ZoomLevel,
  MergedCellInfo,
  MapCellStateDetail,
} from '../../types';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';
import { generateRouteSegments, simplifyPath } from '../../utils/pathfinding';

interface MapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: Set<string>;
  zoomLevel: ZoomLevel;
  isRouteVisible: boolean;
  onCellClick: (row: number, col: number, matchingItems: ShoppingItem[]) => void;
}

const CELL_SIZE = 24; // 基本セルサイズ（少し大きく）

const MapCanvas: React.FC<MapCanvasProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds,
  zoomLevel,
  isRouteVisible,
  onCellClick,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  
  // スケール計算
  const scale = zoomLevel / 100;
  const cellSize = CELL_SIZE * scale;
  
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
      // 結合セルの開始位置にのみ登録
      map.set(`${merge.startRow}-${merge.startCol}`, merge);
    });
    return map;
  }, [mapData.mergedCells]);
  
  // セルがアイテムを持つかどうかの状態を計算
  const cellStates = useMemo(() => {
    const states = new Map<string, MapCellStateDetail>();
    
    // mapNameから参加日を抽出
    const dayMatch = mapName.match(/^(.+)マップ$/);
    if (!dayMatch) return states;
    const dayName = dayMatch[1];
    
    // アイテムをセルにマッピング
    items.forEach((item) => {
      if (item.eventDate !== dayName) return;
      
      // ブロックを探す
      const block = mapData.blocks.find((b) => b.name === item.block);
      if (!block) return;
      
      // ナンバーの数値部分を抽出
      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;
      const numValue = parseInt(numStr, 10);
      
      // ブロック内の該当する数値セルを探す
      const numberCell = block.numberCells.find((c) => c.value === numValue);
      if (!numberCell) return;
      
      const key = `${numberCell.row}-${numberCell.col}`;
      const existing = states.get(key);
      const isVisited = executeModeItemIds.has(item.id);
      const isFullyVisited = item.purchaseStatus !== 'None';
      
      if (!existing) {
        states.set(key, {
          hasItems: true,
          itemCount: 1,
          isVisited,
          isFullyVisited,
          items: [item],
        });
      } else {
        existing.itemCount++;
        existing.items.push(item);
        existing.isVisited = existing.isVisited || isVisited;
        existing.isFullyVisited = existing.isFullyVisited && isFullyVisited;
      }
    });
    
    return states;
  }, [items, mapData.blocks, mapName, executeModeItemIds]);
  
  // 訪問順序を計算
  const visitOrder = useMemo(() => {
    const order: Array<{ row: number; col: number; visitIndex: number; items: ShoppingItem[] }> = [];
    const processedCells = new Set<string>();
    
    const executeItemIds = Array.from(executeModeItemIds);
    const dayMatch = mapName.match(/^(.+)マップ$/);
    if (!dayMatch) return order;
    const dayName = dayMatch[1];
    
    executeItemIds.forEach((itemId) => {
      const item = items.find((i) => i.id === itemId);
      if (!item || item.eventDate !== dayName) return;
      
      const block = mapData.blocks.find((b) => b.name === item.block);
      if (!block) return;
      
      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;
      const numValue = parseInt(numStr, 10);
      
      const numberCell = block.numberCells.find((c) => c.value === numValue);
      if (!numberCell) return;
      
      const key = `${numberCell.row}-${numberCell.col}`;
      if (processedCells.has(key)) {
        // 既存のエントリにアイテムを追加
        const existing = order.find((o) => `${o.row}-${o.col}` === key);
        if (existing) {
          existing.items.push(item);
        }
        return;
      }
      
      processedCells.add(key);
      order.push({
        row: numberCell.row,
        col: numberCell.col,
        visitIndex: order.length + 1,
        items: [item],
      });
    });
    
    return order;
  }, [executeModeItemIds, items, mapData.blocks, mapName]);
  
  // ルートセグメントを計算
  const routeSegments = useMemo(() => {
    if (!isRouteVisible || visitOrder.length < 2) return [];
    
    const points = visitOrder.map((v) => ({ row: v.row, col: v.col }));
    
    // ブロック名セルを収集
    const blockNameCells = new Set<string>();
    mapData.blocks.forEach((block) => {
      // ブロック名がある結合セルの位置を追加
      blockNameCells.add(`${block.startRow}-${block.startCol}`);
    });
    
    return generateRouteSegments(mapData, points, blockNameCells);
  }, [isRouteVisible, visitOrder, mapData]);
  
  // キャンバスサイズ
  const canvasWidth = mapData.maxCol * cellSize + 50;
  const canvasHeight = mapData.maxRow * cellSize + 50;
  
  // 描画処理
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // キャンバスをクリア
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // オフセット適用
    ctx.save();
    ctx.translate(offset.x, offset.y);
    
    // 結合セルの親位置を追跡
    const mergeParentSet = new Set<string>();
    mapData.mergedCells.forEach((merge) => {
      mergeParentSet.add(`${merge.startRow}-${merge.startCol}`);
    });
    
    // 1. 背景を描画（結合セルを考慮）
    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return; // 結合セルの子は描画しない
      
      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;
      
      // 結合セルかチェック
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
          // 全訪問済み: 赤のグラデーション
          const gradient = ctx.createRadialGradient(
            x + width / 2, y + height / 2, 0,
            x + width / 2, y + height / 2, Math.max(width, height) / 2
          );
          gradient.addColorStop(0, 'rgba(239, 83, 80, 0.6)');
          gradient.addColorStop(1, 'rgba(239, 83, 80, 0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          // 一部訪問済み: 黄のグラデーション
          const gradient = ctx.createRadialGradient(
            x + width / 2, y + height / 2, 0,
            x + width / 2, y + height / 2, Math.max(width, height) / 2
          );
          gradient.addColorStop(0, 'rgba(255, 238, 88, 0.6)');
          gradient.addColorStop(1, 'rgba(255, 238, 88, 0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, width, height);
        } else if (state.hasItems) {
          // アイテムあり: 薄い青
          ctx.fillStyle = 'rgba(227, 242, 253, 0.7)';
          ctx.fillRect(x, y, width, height);
        }
      }
    });
    
    // 2. 罫線を描画
    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;
      
      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;
      
      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
      const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;
      
      // 罫線の描画
      const { borders } = cell;
      
      // 罫線がある場合は描画
      const drawBorder = (
        startX: number, startY: number,
        endX: number, endY: number,
        border: typeof borders.top
      ) => {
        if (!border) return;
        
        ctx.beginPath();
        ctx.strokeStyle = border.color || '#4CAF50'; // デフォルトは緑色
        
        // 線の太さ
        switch (border.style) {
          case 'thin':
            ctx.lineWidth = 1 * scale;
            break;
          case 'medium':
            ctx.lineWidth = 2 * scale;
            break;
          case 'thick':
            ctx.lineWidth = 3 * scale;
            break;
          case 'double':
            ctx.lineWidth = 1 * scale;
            break;
          default:
            ctx.lineWidth = 1 * scale;
        }
        
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      };
      
      // 上罫線
      if (borders.top) {
        drawBorder(x, y, x + width, y, borders.top);
      }
      // 右罫線
      if (borders.right) {
        drawBorder(x + width, y, x + width, y + height, borders.right);
      }
      // 下罫線
      if (borders.bottom) {
        drawBorder(x, y + height, x + width, y + height, borders.bottom);
      }
      // 左罫線
      if (borders.left) {
        drawBorder(x, y, x, y + height, borders.left);
      }
      
      // 罫線がない場合でも数値セルには薄い枠を描画
      if (typeof cell.value === 'number' && cell.value > 0 && cell.value <= 100) {
        if (!borders.top && !borders.right && !borders.bottom && !borders.left) {
          ctx.strokeStyle = '#4CAF50';
          ctx.lineWidth = 1.5 * scale;
          ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
        }
      }
    });
    
    // 3. セルの値を描画
    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;
      if (cell.value === null || cell.value === undefined) return;
      
      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;
      
      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
      const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;
      
      const valueStr = String(cell.value);
      
      // フォントサイズを計算
      let fontSize = 10 * scale;
      
      // 結合セルの場合は大きいフォント
      if (merge) {
        const cellCount = (merge.endRow - merge.startRow + 1) * (merge.endCol - merge.startCol + 1);
        if (cellCount >= 4) {
          // ブロック名っぽい場合は大きく薄く
          fontSize = Math.min(width, height) * 0.6;
          ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        } else {
          fontSize = Math.min(width, height) * 0.5;
          ctx.fillStyle = '#333333';
        }
      } else {
        // 数値セルの場合
        if (typeof cell.value === 'number') {
          fontSize = Math.min(cellSize * 0.6, 14 * scale);
          ctx.fillStyle = '#333333';
        } else {
          ctx.fillStyle = '#666666';
        }
      }
      
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      ctx.fillText(valueStr, x + width / 2, y + height / 2);
    });
    
    // 4. ルートを描画
    if (isRouteVisible && routeSegments.length > 0) {
      ctx.strokeStyle = '#EF5350';
      ctx.lineWidth = 3 * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      routeSegments.forEach((segment) => {
        const simplified = simplifyPath(segment.path, 0.5);
        if (simplified.length < 2) return;
        
        ctx.beginPath();
        const startX = (simplified[0].col - 0.5) * cellSize;
        const startY = (simplified[0].row - 0.5) * cellSize;
        ctx.moveTo(startX, startY);
        
        simplified.slice(1).forEach((point) => {
          const px = (point.col - 0.5) * cellSize;
          const py = (point.row - 0.5) * cellSize;
          ctx.lineTo(px, py);
        });
        
        ctx.stroke();
        
        // 矢印を描画（セグメントの中間点）
        if (simplified.length >= 2) {
          const midIdx = Math.floor(simplified.length / 2);
          const p1 = simplified[midIdx - 1] || simplified[0];
          const p2 = simplified[midIdx];
          
          const x1 = (p1.col - 0.5) * cellSize;
          const y1 = (p1.row - 0.5) * cellSize;
          const x2 = (p2.col - 0.5) * cellSize;
          const y2 = (p2.row - 0.5) * cellSize;
          
          const angle = Math.atan2(y2 - y1, x2 - x1);
          const arrowSize = 8 * scale;
          
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          
          ctx.beginPath();
          ctx.moveTo(midX, midY);
          ctx.lineTo(
            midX - arrowSize * Math.cos(angle - Math.PI / 6),
            midY - arrowSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.moveTo(midX, midY);
          ctx.lineTo(
            midX - arrowSize * Math.cos(angle + Math.PI / 6),
            midY - arrowSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.stroke();
        }
      });
    }
    
    // 5. 訪問順番号を描画
    visitOrder.forEach((visit) => {
      const x = (visit.col - 1) * cellSize;
      const y = (visit.row - 1) * cellSize;
      
      // バッジを描画
      const badgeSize = 16 * scale;
      const badgeX = x + cellSize - badgeSize / 2;
      const badgeY = y - badgeSize / 2;
      
      ctx.fillStyle = '#EF5350';
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeSize / 2, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${10 * scale}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(visit.visitIndex), badgeX, badgeY);
    });
    
    ctx.restore();
  }, [
    mapData,
    cellsMap,
    mergedCellsMap,
    cellStates,
    visitOrder,
    routeSegments,
    isRouteVisible,
    cellSize,
    scale,
    offset,
  ]);
  
  // クリック処理
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDragging) return;
      
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left - offset.x;
      const y = e.clientY - rect.top - offset.y;
      
      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;
      
      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }
      
      // ブロック定義パネル用のカスタムイベントを発火
      window.dispatchEvent(new CustomEvent('mapCellClick', {
        detail: { row, col }
      }));
      
      // このセルに関連するアイテムを取得
      const state = cellStates.get(`${row}-${col}`);
      const matchingItems = state?.items || [];
      
      onCellClick(row, col, matchingItems);
    },
    [cellSize, offset, mapData.maxRow, mapData.maxCol, cellStates, onCellClick, isDragging]
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
    
    setOffset({
      x: dragStartOffset.x + dx,
      y: dragStartOffset.y + dy,
    });
  }, [dragStart, dragStartOffset]);
  
  const handlePointerUp = useCallback(() => {
    // ドラッグ終了後、少し遅延してフラグをリセット
    setTimeout(() => {
      setIsDragging(false);
    }, 100);
  }, []);
  
  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden bg-white"
      style={{ height: 'calc(100vh - 200px)', minHeight: '500px' }}
    >
      <canvas
        ref={canvasRef}
        width={canvasWidth}
        height={canvasHeight}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className="cursor-grab active:cursor-grabbing"
        style={{ touchAction: 'none' }}
      />
    </div>
  );
};

export default MapCanvas;
