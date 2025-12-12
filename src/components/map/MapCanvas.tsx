import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  ZoomLevel,
  MapCellState,
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

const CELL_SIZE = 20; // 基本セルサイズ

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
  
  // 結合セルマップ
  const mergedCellsMap = useMemo(() => {
    const map = new Map<string, { width: number; height: number; value: string | number | null }>();
    mapData.mergedCells.forEach((merge) => {
      const key = `${merge.startRow}-${merge.startCol}`;
      map.set(key, {
        width: merge.endCol - merge.startCol + 1,
        height: merge.endRow - merge.startRow + 1,
        value: merge.value,
      });
    });
    return map;
  }, [mapData.mergedCells]);
  
  // ブロック名セルのセット
  const blockNameCells = useMemo(() => {
    const set = new Set<string>();
    mapData.blocks.forEach((block) => {
      // ブロック名が入力されているセルを特定
      mapData.mergedCells.forEach((merge) => {
        if (merge.value === block.name) {
          for (let r = merge.startRow; r <= merge.endRow; r++) {
            for (let c = merge.startCol; c <= merge.endCol; c++) {
              set.add(`${r}-${c}`);
            }
          }
        }
      });
    });
    return set;
  }, [mapData.blocks, mapData.mergedCells]);
  
  // アイテムとセルの照合結果をキャッシュ
  const cellItemsMap = useMemo(() => {
    const map = new Map<string, ShoppingItem[]>();
    
    // mapNameから参加日を抽出（「1日目マップ」→「1日目」）
    const dayMatch = mapName.match(/^(.+)マップ$/);
    if (!dayMatch) return map;
    const dayName = dayMatch[1];
    
    items.forEach((item) => {
      if (item.eventDate !== dayName) return;
      
      // 該当するブロックを探す
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
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(item);
    });
    
    return map;
  }, [items, mapData.blocks, mapName]);
  
  // セルの状態を計算
  const getCellState = useCallback(
    (row: number, col: number): MapCellState => {
      const key = `${row}-${col}`;
      const matchingItems = cellItemsMap.get(key);
      
      if (!matchingItems || matchingItems.length === 0) {
        return 'default';
      }
      
      const inExecuteCount = matchingItems.filter((item) =>
        executeModeItemIds.has(item.id)
      ).length;
      
      if (inExecuteCount === 0) {
        return 'hasItems';
      } else if (inExecuteCount === matchingItems.length) {
        return 'allVisit';
      } else {
        return 'partialVisit';
      }
    },
    [cellItemsMap, executeModeItemIds]
  );
  
  // 訪問先のセル一覧
  const visitCells = useMemo(() => {
    const cells: { row: number; col: number; order: number; itemIds: string[] }[] = [];
    const processedCells = new Set<string>();
    
    // 実行列のアイテムIDを順序付きで取得
    const executeItemIds = Array.from(executeModeItemIds);
    
    executeItemIds.forEach((itemId) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;
      
      // mapNameから参加日を抽出
      const dayMatch = mapName.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];
      
      if (item.eventDate !== dayName) return;
      
      // 該当するブロックを探す
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
      
      // 同じセルは1回のみ追加
      if (processedCells.has(key)) {
        // 既存のエントリにアイテムIDを追加
        const existingCell = cells.find(
          (c) => c.row === numberCell.row && c.col === numberCell.col
        );
        if (existingCell && !existingCell.itemIds.includes(itemId)) {
          existingCell.itemIds.push(itemId);
        }
        return;
      }
      
      processedCells.add(key);
      cells.push({
        row: numberCell.row,
        col: numberCell.col,
        order: cells.length + 1,
        itemIds: [itemId],
      });
    });
    
    return cells;
  }, [executeModeItemIds, items, mapData.blocks, mapName]);
  
  // ルートセグメントを計算
  const routeSegments = useMemo(() => {
    if (!isRouteVisible || visitCells.length < 2) return [];
    
    const points = visitCells.map((cell) => ({ row: cell.row, col: cell.col }));
    return generateRouteSegments(mapData, points, blockNameCells);
  }, [isRouteVisible, visitCells, mapData, blockNameCells]);
  
  // キャンバスの描画
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const { rows, cols } = mapData;
    const width = cols * cellSize;
    const height = rows * cellSize;
    
    canvas.width = width;
    canvas.height = height;
    
    // 背景をクリア
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    
    // セルを描画
    for (let row = 1; row <= rows; row++) {
      for (let col = 1; col <= cols; col++) {
        const key = `${row}-${col}`;
        const cell = cellsMap.get(key);
        const mergeInfo = mergedCellsMap.get(key);
        
        const x = (col - 1) * cellSize;
        const y = (row - 1) * cellSize;
        
        // 結合セルの子セルはスキップ
        if (cell?.isMerged && cell.mergeParent) {
          const parentKey = `${cell.mergeParent.row}-${cell.mergeParent.col}`;
          if (key !== parentKey) continue;
        }
        
        const cellWidth = mergeInfo ? mergeInfo.width * cellSize : cellSize;
        const cellHeight = mergeInfo ? mergeInfo.height * cellSize : cellSize;
        
        // セルの状態に応じた背景色
        const state = getCellState(row, col);
        let bgColor = cell?.backgroundColor || '#FFFFFF';
        
        if (state === 'hasItems') {
          bgColor = '#E3F2FD'; // 薄青
        } else if (state === 'allVisit') {
          // 赤グラデーション
          const gradient = ctx.createRadialGradient(
            x + cellWidth / 2, y + cellHeight / 2, 0,
            x + cellWidth / 2, y + cellHeight / 2, Math.max(cellWidth, cellHeight) / 2
          );
          gradient.addColorStop(0, '#EF5350');
          gradient.addColorStop(1, 'rgba(239, 83, 80, 0.2)');
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, cellWidth, cellHeight);
          bgColor = ''; // グラデーションを使用
        } else if (state === 'partialVisit') {
          // 黄グラデーション
          const gradient = ctx.createRadialGradient(
            x + cellWidth / 2, y + cellHeight / 2, 0,
            x + cellWidth / 2, y + cellHeight / 2, Math.max(cellWidth, cellHeight) / 2
          );
          gradient.addColorStop(0, '#FFEE58');
          gradient.addColorStop(1, 'rgba(255, 238, 88, 0.2)');
          ctx.fillStyle = gradient;
          ctx.fillRect(x, y, cellWidth, cellHeight);
          bgColor = ''; // グラデーションを使用
        }
        
        if (bgColor) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(x, y, cellWidth, cellHeight);
        }
        
        // 罫線を描画
        if (cell?.borders) {
          const { top, right, bottom, left } = cell.borders;
          
          const drawBorder = (
            border: typeof top,
            startX: number,
            startY: number,
            endX: number,
            endY: number
          ) => {
            if (!border || border.style === 'none') return;
            
            ctx.strokeStyle = border.color || '#000000';
            ctx.lineWidth =
              border.style === 'thick' ? 3 * scale :
              border.style === 'medium' ? 2 * scale :
              border.style === 'double' ? 2 * scale :
              1 * scale;
            
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.stroke();
          };
          
          drawBorder(top, x, y, x + cellWidth, y);
          drawBorder(right, x + cellWidth, y, x + cellWidth, y + cellHeight);
          drawBorder(bottom, x, y + cellHeight, x + cellWidth, y + cellHeight);
          drawBorder(left, x, y, x, y + cellHeight);
        }
        
        // 値を描画
        const value = mergeInfo?.value ?? cell?.value;
        if (value !== null && value !== undefined) {
          ctx.fillStyle = '#000000';
          ctx.font = `${12 * scale}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(
            String(value),
            x + cellWidth / 2,
            y + cellHeight / 2
          );
        }
      }
    }
    
    // ルートを描画
    if (isRouteVisible && routeSegments.length > 0) {
      ctx.strokeStyle = '#EF5350';
      ctx.lineWidth = 3 * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      routeSegments.forEach((segment) => {
        const simplifiedPath = simplifyPath(segment.path);
        
        if (simplifiedPath.length < 2) return;
        
        ctx.beginPath();
        const startX = (simplifiedPath[0].col - 0.5) * cellSize;
        const startY = (simplifiedPath[0].row - 0.5) * cellSize;
        ctx.moveTo(startX, startY);
        
        for (let i = 1; i < simplifiedPath.length; i++) {
          const x = (simplifiedPath[i].col - 0.5) * cellSize;
          const y = (simplifiedPath[i].row - 0.5) * cellSize;
          ctx.lineTo(x, y);
        }
        
        ctx.stroke();
        
        // 矢印を描画
        if (simplifiedPath.length >= 2) {
          const midIndex = Math.floor(simplifiedPath.length / 2);
          const prevPoint = simplifiedPath[midIndex - 1] || simplifiedPath[0];
          const nextPoint = simplifiedPath[midIndex];
          
          const fromX = (prevPoint.col - 0.5) * cellSize;
          const fromY = (prevPoint.row - 0.5) * cellSize;
          const toX = (nextPoint.col - 0.5) * cellSize;
          const toY = (nextPoint.row - 0.5) * cellSize;
          
          const angle = Math.atan2(toY - fromY, toX - fromX);
          const arrowSize = 8 * scale;
          
          const midX = (fromX + toX) / 2;
          const midY = (fromY + toY) / 2;
          
          ctx.beginPath();
          ctx.moveTo(
            midX - arrowSize * Math.cos(angle - Math.PI / 6),
            midY - arrowSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(midX, midY);
          ctx.lineTo(
            midX - arrowSize * Math.cos(angle + Math.PI / 6),
            midY - arrowSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.stroke();
        }
      });
    }
    
    // 訪問順序番号を描画
    if (isRouteVisible) {
      visitCells.forEach((cell) => {
        const x = (cell.col - 0.5) * cellSize;
        const y = (cell.row - 0.5) * cellSize;
        
        // 番号の位置を決定（セルの右上）
        const numX = x + cellSize * 0.6;
        const numY = y - cellSize * 0.3;
        
        // 背景円
        ctx.beginPath();
        ctx.arc(numX, numY, 10 * scale, 0, Math.PI * 2);
        ctx.fillStyle = '#EF5350';
        ctx.fill();
        
        // 番号テキスト
        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${10 * scale}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(cell.order), numX, numY);
      });
    }
  }, [
    mapData,
    cellsMap,
    mergedCellsMap,
    cellSize,
    scale,
    getCellState,
    isRouteVisible,
    routeSegments,
    visitCells,
  ]);
  
  // マウス/タッチイベントハンドラ
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragStartOffset({ ...offset });
    },
    [offset]
  );
  
  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDragging) return;
      
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      
      setOffset({
        x: dragStartOffset.x + dx,
        y: dragStartOffset.y + dy,
      });
    },
    [isDragging, dragStart, dragStartOffset]
  );
  
  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
  }, []);
  
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - offset.x) / scale;
      const y = (e.clientY - rect.top - offset.y) / scale;
      
      const col = Math.floor(x / CELL_SIZE) + 1;
      const row = Math.floor(y / CELL_SIZE) + 1;
      
      if (row < 1 || col < 1 || row > mapData.rows || col > mapData.cols) return;
      
      const key = `${row}-${col}`;
      const matchingItems = cellItemsMap.get(key) || [];
      
      if (matchingItems.length > 0) {
        onCellClick(row, col, matchingItems);
      }
    },
    [offset, scale, mapData.rows, mapData.cols, cellItemsMap, onCellClick]
  );
  
  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden bg-slate-100 dark:bg-slate-900 rounded-lg"
      style={{ width: '100%', height: 'calc(100vh - 200px)' }}
    >
      <canvas
        ref={canvasRef}
        className="cursor-grab active:cursor-grabbing"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px)`,
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={handleClick}
      />
    </div>
  );
};

export default MapCanvas;
