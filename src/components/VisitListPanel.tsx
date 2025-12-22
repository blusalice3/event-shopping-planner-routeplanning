import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ShoppingItem, DayMapData, HallDefinition, BlockDefinition } from '../types';
import GripVerticalIcon from './icons/GripVerticalIcon';

interface VisitListPanelProps {
  isOpen: boolean;
  onClose: () => void;
  items: ShoppingItem[];  // 実行列のアイテム（訪問順）
  onUpdateOrder: (newOrder: ShoppingItem[]) => void;
  mapData: DayMapData | null;
  hallDefinitions: HallDefinition[];
  layoutMode: 'pc' | 'smartphone';
  onHighlightCell: (row: number, col: number) => void;
  onClearHighlight: () => void;
  hasUnsavedChanges: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  selectedHallId?: string;  // 選択中のホールID（'all'は全ホール）
}

interface HistoryState {
  items: ShoppingItem[];
}

// ホールごとにアイテムをグループ化するヘルパー
const groupItemsByHall = (
  items: ShoppingItem[],
  mapData: DayMapData | null,
  hallDefinitions: HallDefinition[]
): { hallName: string | null; hallColor?: string; items: { item: ShoppingItem; index: number }[] }[] => {
  if (!mapData) {
    return [{ hallName: null, items: items.map((item, index) => ({ item, index })) }];
  }

  // アイテムのセル位置を取得するヘルパー（大文字/小文字を区別）
  const getCellPosition = (item: ShoppingItem): { row: number; col: number } | null => {
    // 完全一致でブロックを検索（大文字/小文字を区別）
    const block = mapData.blocks.find((b: BlockDefinition) => b.name === item.block);
    if (!block) return null;
    
    const numMatch = item.number?.match(/\d+/);
    if (!numMatch) return null;
    const num = parseInt(numMatch[0], 10);
    
    const cell = block.numberCells.find((nc: { row: number; col: number; value: number }) => nc.value === num);
    if (!cell) return null;
    
    return { row: cell.row, col: cell.col };
  };

  // セルがどのホールに属するかを判定
  const getHallForCell = (row: number, col: number): HallDefinition | null => {
    for (const hall of hallDefinitions) {
      for (const vertex of hall.vertices) {
        if (vertex.row === row && vertex.col === col) {
          return hall;
        }
      }
      // ホール領域内かどうかをチェック（頂点で定義された多角形内）
      if (isPointInPolygon(row, col, hall.vertices)) {
        return hall;
      }
    }
    return null;
  };

  // 多角形内判定（レイキャスティング法）
  const isPointInPolygon = (row: number, col: number, vertices: { row: number; col: number }[]): boolean => {
    if (vertices.length < 3) return false;
    
    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
      const xi = vertices[i].col, yi = vertices[i].row;
      const xj = vertices[j].col, yj = vertices[j].row;
      
      if (((yi > row) !== (yj > row)) && (col < (xj - xi) * (row - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  };

  // グループ化
  const groups = new Map<string | null, { item: ShoppingItem; index: number }[]>();
  const hallColorMap = new Map<string, string>();
  
  hallDefinitions.forEach(hall => {
    hallColorMap.set(hall.name, hall.color || '#6366f1');
  });

  items.forEach((item, index) => {
    const cellPos = getCellPosition(item);
    let hallName: string | null = null;
    
    if (cellPos) {
      const hall = getHallForCell(cellPos.row, cellPos.col);
      hallName = hall?.name || null;
    }
    
    if (!groups.has(hallName)) {
      groups.set(hallName, []);
    }
    groups.get(hallName)!.push({ item, index });
  });

  // 訪問順でソートされた結果を返す
  const result: { hallName: string | null; hallColor?: string; items: { item: ShoppingItem; index: number }[] }[] = [];
  
  // 最初に出現するアイテムの順序でホールをソート
  const hallOrder: (string | null)[] = [];
  items.forEach((item, _index) => {
    const cellPos = getCellPosition(item);
    let hallName: string | null = null;
    if (cellPos) {
      const hall = getHallForCell(cellPos.row, cellPos.col);
      hallName = hall?.name || null;
    }
    if (!hallOrder.includes(hallName)) {
      hallOrder.push(hallName);
    }
  });

  hallOrder.forEach(hallName => {
    const groupItems = groups.get(hallName);
    if (groupItems && groupItems.length > 0) {
      result.push({
        hallName,
        hallColor: hallName ? hallColorMap.get(hallName) : undefined,
        items: groupItems,
      });
    }
  });

  return result;
};

const VisitListPanel: React.FC<VisitListPanelProps> = ({
  isOpen,
  onClose,
  items,
  onUpdateOrder,
  mapData,
  hallDefinitions,
  layoutMode,
  onHighlightCell,
  onClearHighlight,
  hasUnsavedChanges,
  onConfirm,
  onCancel,
  selectedHallId = 'all',
}) => {
  // 将来使用する可能性のあるprops
  void hasUnsavedChanges;
  
  // パネル位置（PC: left/right）
  const [panelPosition, setPanelPosition] = useState<'left' | 'right'>('right');
  
  // 折りたたみ状態（ホール名 -> 展開/折りたたみ）
  const [collapsedHalls, setCollapsedHalls] = useState<Set<string | null>>(new Set());
  
  // 範囲選択状態（rangeSelectionModeがtrueの時のみ有効）
  const [rangeSelectionMode, setRangeSelectionMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeEnd, setRangeEnd] = useState<number | null>(null);
  
  // 2つ選択して入れ替えモード
  const [swapMode, setSwapMode] = useState(false);
  const [swapFirst, setSwapFirst] = useState<number | null>(null);
  
  // ドラッグ状態
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  // Undo/Redo履歴
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  
  // スマートフォンモードのボトムシート高さ
  const [bottomSheetHeight, setBottomSheetHeight] = useState(50); // %
  const bottomSheetRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const isDraggingSheet = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // 履歴に追加
  const pushHistory = useCallback((newItems: ShoppingItem[]) => {
    setHistory(prev => {
      const newHistory = prev.slice(0, historyIndex + 1);
      newHistory.push({ items: [...newItems] });
      // 30件を超えたら古いものを削除
      if (newHistory.length > 30) {
        newHistory.shift();
        return newHistory;
      }
      return newHistory;
    });
    setHistoryIndex(prev => Math.min(prev + 1, 29));
  }, [historyIndex]);

  // Undo
  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const prevState = history[historyIndex - 1];
      onUpdateOrder(prevState.items);
      setHistoryIndex(prev => prev - 1);
    }
  }, [history, historyIndex, onUpdateOrder]);

  // Redo
  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextState = history[historyIndex + 1];
      onUpdateOrder(nextState.items);
      setHistoryIndex(prev => prev + 1);
    }
  }, [history, historyIndex, onUpdateOrder]);

  // 履歴クリア
  const clearHistory = useCallback(() => {
    setHistory([{ items: [...items] }]);
    setHistoryIndex(0);
  }, [items]);

  // パネルを開いたときに初期履歴を設定
  useEffect(() => {
    if (isOpen && history.length === 0) {
      setHistory([{ items: [...items] }]);
      setHistoryIndex(0);
    }
  }, [isOpen, items, history.length]);

  // 確定
  const handleConfirm = useCallback(() => {
    clearHistory();
    onConfirm();
  }, [clearHistory, onConfirm]);

  // キャンセル
  const handleCancel = useCallback(() => {
    if (history.length > 0) {
      onUpdateOrder(history[0].items);
    }
    clearHistory();
    onCancel();
  }, [history, onUpdateOrder, clearHistory, onCancel]);

  // アイテムの順序変更
  const moveItem = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    
    const newItems = [...items];
    const [movedItem] = newItems.splice(fromIndex, 1);
    newItems.splice(toIndex, 0, movedItem);
    
    pushHistory(newItems);
    onUpdateOrder(newItems);
  }, [items, pushHistory, onUpdateOrder]);

  // 2つのアイテムを入れ替え
  const swapItems = useCallback((index1: number, index2: number) => {
    if (index1 === index2) return;
    
    const newItems = [...items];
    [newItems[index1], newItems[index2]] = [newItems[index2], newItems[index1]];
    
    pushHistory(newItems);
    onUpdateOrder(newItems);
  }, [items, pushHistory, onUpdateOrder]);

  // 区間反転
  const reverseRange = useCallback((start: number, end: number) => {
    const [minIndex, maxIndex] = start < end ? [start, end] : [end, start];
    
    const newItems = [...items];
    const rangeItems = newItems.slice(minIndex, maxIndex + 1).reverse();
    newItems.splice(minIndex, maxIndex - minIndex + 1, ...rangeItems);
    
    pushHistory(newItems);
    onUpdateOrder(newItems);
    
    // 範囲選択をクリア
    setRangeStart(null);
    setRangeEnd(null);
  }, [items, pushHistory, onUpdateOrder]);

  // ホールの折りたたみ切り替え
  const toggleHallCollapse = useCallback((hallName: string | null) => {
    setCollapsedHalls(prev => {
      const newSet = new Set(prev);
      if (newSet.has(hallName)) {
        newSet.delete(hallName);
      } else {
        newSet.add(hallName);
      }
      return newSet;
    });
  }, []);

  // アイテムクリック処理
  const handleItemClick = useCallback((index: number, _item: ShoppingItem) => {
    if (swapMode) {
      if (swapFirst === null) {
        setSwapFirst(index);
      } else {
        swapItems(swapFirst, index);
        setSwapFirst(null);
        setSwapMode(false);
      }
    } else if (rangeSelectionMode) {
      if (rangeStart === null) {
        // 開始点を設定
        setRangeStart(index);
        setRangeEnd(null);
      } else if (rangeEnd === null) {
        // 終了点を設定（同一ホール内のみ）
        // ホールを跨いでいないかチェック
        const checkSameHall = () => {
          if (selectedHallId !== 'all') return true; // 特定ホール表示中は常にOK
          if (!mapData) return true;
          
          const startItem = items[rangeStart];
          const endItem = items[index];
          if (!startItem || !endItem) return false;
          
          // アイテムのホールを取得するヘルパー
          const getHallName = (item: ShoppingItem): string | null => {
            const block = mapData.blocks.find((b: BlockDefinition) => b.name === item.block);
            if (!block) return null;
            const numMatch = item.number?.match(/\d+/);
            if (!numMatch) return null;
            const num = parseInt(numMatch[0], 10);
            const cell = block.numberCells.find((nc: { row: number; col: number; value: number }) => nc.value === num);
            if (!cell) return null;
            
            for (const hall of hallDefinitions) {
              for (const vertex of hall.vertices) {
                if (vertex.row === cell.row && vertex.col === cell.col) return hall.name;
              }
              // 多角形内判定
              const vertices = hall.vertices;
              if (vertices.length >= 3) {
                let inside = false;
                for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
                  const xi = vertices[i].col, yi = vertices[i].row;
                  const xj = vertices[j].col, yj = vertices[j].row;
                  if (((yi > cell.row) !== (yj > cell.row)) && (cell.col < (xj - xi) * (cell.row - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                  }
                }
                if (inside) return hall.name;
              }
            }
            return null;
          };
          
          return getHallName(startItem) === getHallName(endItem);
        };
        
        if (checkSameHall()) {
          setRangeEnd(index);
        } else {
          alert('ホールを跨いだ範囲選択はできません');
        }
      } else {
        // 既に範囲が選択されている場合は開始点を再設定
        setRangeStart(index);
        setRangeEnd(null);
      }
    }
  }, [swapMode, swapFirst, rangeSelectionMode, rangeStart, rangeEnd, swapItems, selectedHallId, mapData, items, hallDefinitions]);

  // アイテムホバー処理
  const handleItemHover = useCallback((item: ShoppingItem) => {
    if (!mapData) return;
    
    // 完全一致でブロックを検索（大文字/小文字を区別）
    const block = mapData.blocks.find((b: BlockDefinition) => b.name === item.block);
    if (!block) return;
    
    const numMatch = item.number?.match(/\d+/);
    if (!numMatch) return;
    const num = parseInt(numMatch[0], 10);
    
    const cell = block.numberCells.find((nc: { row: number; col: number; value: number }) => nc.value === num);
    if (cell) {
      onHighlightCell(cell.row, cell.col);
    }
  }, [mapData, onHighlightCell]);

  // ドラッグ開始
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  // ドラッグオーバー
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  // ドロップ
  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      moveItem(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, moveItem]);

  // ドラッグ終了
  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  // ボトムシートのドラッグハンドル
  const handleSheetDragStart = useCallback((e: React.PointerEvent) => {
    isDraggingSheet.current = true;
    startY.current = e.clientY;
    startHeight.current = bottomSheetHeight;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [bottomSheetHeight]);

  const handleSheetDragMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingSheet.current) return;
    
    const deltaY = startY.current - e.clientY;
    const windowHeight = window.innerHeight;
    const deltaPercent = (deltaY / windowHeight) * 100;
    const newHeight = Math.max(20, Math.min(90, startHeight.current + deltaPercent));
    setBottomSheetHeight(newHeight);
  }, []);

  const handleSheetDragEnd = useCallback((e: React.PointerEvent) => {
    isDraggingSheet.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  // グループ化されたアイテム
  const groupedItems = useMemo(() => 
    groupItemsByHall(items, mapData, hallDefinitions),
    [items, mapData, hallDefinitions]
  );

  // 選択ホールでフィルタされたグループ
  const filteredGroupedItems = useMemo(() => {
    if (selectedHallId === 'all') {
      return groupedItems;
    }
    
    const selectedHall = hallDefinitions.find(h => h.id === selectedHallId);
    if (!selectedHall) return groupedItems;
    
    // 選択ホールのみを含むグループを返す
    return groupedItems.filter(group => group.hallName === selectedHall.name);
  }, [groupedItems, selectedHallId, hallDefinitions]);

  // 範囲選択の表示用
  const rangeIndices = useMemo(() => {
    if (!rangeSelectionMode) return new Set<number>();
    if (rangeStart === null) return new Set<number>();
    if (rangeEnd === null) return new Set([rangeStart]);
    
    const [min, max] = rangeStart < rangeEnd ? [rangeStart, rangeEnd] : [rangeEnd, rangeStart];
    const indices = new Set<number>();
    for (let i = min; i <= max; i++) {
      indices.add(i);
    }
    return indices;
  }, [rangeSelectionMode, rangeStart, rangeEnd]);

  if (!isOpen) return null;

  // スマートフォンモード: ボトムシート
  if (layoutMode === 'smartphone') {
    return (
      <div 
        className="fixed inset-0 z-50 pointer-events-none"
        style={{ top: 0 }}
      >
        {/* 背景オーバーレイ */}
        <div 
          className="absolute inset-0 bg-black/30 pointer-events-auto"
          onClick={onClose}
        />
        
        {/* ボトムシート */}
        <div
          ref={bottomSheetRef}
          className="absolute bottom-0 left-0 right-0 bg-white dark:bg-slate-900 rounded-t-2xl shadow-2xl pointer-events-auto flex flex-col"
          style={{ height: `${bottomSheetHeight}%` }}
        >
          {/* ドラッグハンドル */}
          <div
            ref={dragHandleRef}
            className="flex justify-center py-2 cursor-grab active:cursor-grabbing touch-none"
            onPointerDown={handleSheetDragStart}
            onPointerMove={handleSheetDragMove}
            onPointerUp={handleSheetDragEnd}
          >
            <div className="w-12 h-1.5 bg-slate-300 dark:bg-slate-600 rounded-full" />
          </div>
          
          {/* ヘッダー */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-700">
            <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100">訪問先リスト</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={handleUndo}
                disabled={historyIndex <= 0}
                className={`p-2 rounded-md ${historyIndex <= 0 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title="元に戻す"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              </button>
              <button
                onClick={handleRedo}
                disabled={historyIndex >= history.length - 1}
                className={`p-2 rounded-md ${historyIndex >= history.length - 1 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                title="やり直す"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
                </svg>
              </button>
            </div>
          </div>
          
          {/* ツールバー */}
          <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
            <button
              onClick={() => {
                setSwapMode(!swapMode);
                setSwapFirst(null);
                setRangeSelectionMode(false);
                setRangeStart(null);
                setRangeEnd(null);
              }}
              className={`px-3 py-1.5 text-sm rounded-md ${swapMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
            >
              入れ替え
            </button>
            <button
              onClick={() => {
                const newMode = !rangeSelectionMode;
                setRangeSelectionMode(newMode);
                setRangeStart(null);
                setRangeEnd(null);
                setSwapMode(false);
                setSwapFirst(null);
              }}
              className={`px-3 py-1.5 text-sm rounded-md ${rangeSelectionMode ? 'bg-purple-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
            >
              範囲選択
            </button>
            {rangeSelectionMode && rangeStart !== null && rangeEnd !== null && (
              <button
                onClick={() => reverseRange(rangeStart, rangeEnd)}
                className="px-3 py-1.5 text-sm rounded-md bg-orange-500 text-white"
              >
                区間反転
              </button>
            )}
            {/* 操作ヒント */}
            {rangeSelectionMode && rangeStart === null && (
              <span className="text-xs text-purple-600 dark:text-purple-400 ml-2">開始点を選択</span>
            )}
            {rangeSelectionMode && rangeStart !== null && rangeEnd === null && (
              <span className="text-xs text-purple-600 dark:text-purple-400 ml-2">終了点を選択</span>
            )}
          </div>
          
          {/* アイテムリスト */}
          <div className="flex-1 overflow-y-auto">
            {filteredGroupedItems.map((group, groupIndex) => (
              <div key={group.hallName || `no-hall-${groupIndex}`}>
                {/* ホールヘッダー */}
                <div
                  className={`sticky top-0 flex items-center justify-between px-4 py-2 cursor-pointer ${
                    group.hallName 
                      ? 'bg-slate-100 dark:bg-slate-800' 
                      : 'bg-slate-50 dark:bg-slate-900 border-l-4 border-slate-300 dark:border-slate-600'
                  }`}
                  style={group.hallColor ? { borderLeftColor: group.hallColor, borderLeftWidth: '4px' } : {}}
                  onClick={() => toggleHallCollapse(group.hallName)}
                >
                  <span className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                    {group.hallName || 'ホール未定義'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {group.items.length}件
                    </span>
                    <svg 
                      className={`w-4 h-4 text-slate-500 transition-transform ${collapsedHalls.has(group.hallName) ? '' : 'rotate-180'}`}
                      fill="none" 
                      stroke="currentColor" 
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                
                {/* アイテム */}
                {!collapsedHalls.has(group.hallName) && group.items.map(({ item, index }) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={(e) => handleDrop(e, index)}
                    onDragEnd={handleDragEnd}
                    onClick={() => handleItemClick(index, item)}
                    onMouseEnter={() => handleItemHover(item)}
                    onMouseLeave={onClearHighlight}
                    className={`relative flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors ${
                      dragOverIndex === index ? 'bg-blue-100 dark:bg-blue-900/30' : ''
                    } ${
                      rangeIndices.has(index) ? 'bg-purple-100 dark:bg-purple-900/30' : ''
                    } ${
                      swapFirst === index ? 'bg-green-100 dark:bg-green-900/30' : ''
                    } ${
                      !group.hallName ? 'bg-slate-50/50 dark:bg-slate-950/50' : ''
                    }`}
                  >
                    {/* 範囲選択インジケーター */}
                    {rangeIndices.has(index) && rangeStart !== null && rangeEnd !== null && (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-purple-500 flex items-center justify-center">
                        {index === Math.min(rangeStart, rangeEnd) && (
                          <div className="absolute -left-2 text-purple-500 text-lg">↕</div>
                        )}
                      </div>
                    )}
                    
                    {/* 訪問順番号 */}
                    <div className="w-8 h-8 flex items-center justify-center bg-blue-600 text-white rounded-full text-sm font-bold">
                      {index + 1}
                    </div>
                    
                    {/* ドラッグハンドル */}
                    <GripVerticalIcon className="w-5 h-5 text-slate-400 cursor-grab" />
                    
                    {/* アイテム情報 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-slate-900 dark:text-slate-100">
                          {item.block}-{item.number}
                        </span>
                        {item.remarks?.includes('優先') && (
                          <img src="/優先.png" alt="優先" className="h-5 w-auto" />
                        )}
                        {item.remarks?.includes('委託無') && (
                          <img src="/委託無.png" alt="委託無" className="h-5 w-auto" />
                        )}
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
                        {item.circle}
                      </p>
                      {item.title && (
                        <p className="text-xs text-slate-500 dark:text-slate-500 truncate">
                          {item.title}
                        </p>
                      )}
                      {item.remarks && (
                        <p className="text-xs text-orange-600 dark:text-orange-400 truncate">
                          {item.remarks}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          
          {/* フッター */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
            <button
              onClick={handleCancel}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
            <button
              onClick={handleConfirm}
              className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700"
            >
              確定
            </button>
          </div>
        </div>
      </div>
    );
  }

  // PCモード: サイドパネル
  return (
    <div 
      className={`fixed top-0 bottom-0 ${panelPosition === 'left' ? 'left-0' : 'right-0'} w-[30%] min-w-[300px] max-w-[400px] bg-white dark:bg-slate-900 shadow-2xl z-40 flex flex-col`}
    >
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100">訪問先リスト</h3>
        <div className="flex items-center gap-2">
          {/* 位置切り替え */}
          <button
            onClick={() => setPanelPosition(panelPosition === 'left' ? 'right' : 'left')}
            className="p-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            title={panelPosition === 'left' ? '右側に移動' : '左側に移動'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {panelPosition === 'left' ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              )}
            </svg>
          </button>
          
          {/* Undo */}
          <button
            onClick={handleUndo}
            disabled={historyIndex <= 0}
            className={`p-2 rounded-md ${historyIndex <= 0 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            title="元に戻す (Ctrl+Z)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
          
          {/* Redo */}
          <button
            onClick={handleRedo}
            disabled={historyIndex >= history.length - 1}
            className={`p-2 rounded-md ${historyIndex >= history.length - 1 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
            title="やり直す (Ctrl+Y)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
            </svg>
          </button>
          
          {/* 閉じる */}
          <button
            onClick={onClose}
            className="p-2 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            title="閉じる"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
      
      {/* ツールバー */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
        <button
          onClick={() => {
            setSwapMode(!swapMode);
            setSwapFirst(null);
            setRangeSelectionMode(false);
            setRangeStart(null);
            setRangeEnd(null);
          }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${swapMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'}`}
        >
          入れ替え
        </button>
        <button
          onClick={() => {
            const newMode = !rangeSelectionMode;
            setRangeSelectionMode(newMode);
            setRangeStart(null);
            setRangeEnd(null);
            setSwapMode(false);
            setSwapFirst(null);
          }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${rangeSelectionMode ? 'bg-purple-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'}`}
        >
          範囲選択
        </button>
        {rangeSelectionMode && rangeStart !== null && rangeEnd !== null && (
          <button
            onClick={() => reverseRange(rangeStart, rangeEnd)}
            className="px-3 py-1.5 text-sm rounded-md bg-orange-500 text-white hover:bg-orange-600 transition-colors"
          >
            区間反転
          </button>
        )}
        
        {/* 操作ヒント */}
        <div className="flex-1 text-right">
          {swapMode && swapFirst === null && (
            <span className="text-xs text-slate-500 dark:text-slate-400">1つ目を選択してください</span>
          )}
          {swapMode && swapFirst !== null && (
            <span className="text-xs text-green-600 dark:text-green-400">2つ目を選択してください</span>
          )}
          {rangeSelectionMode && rangeStart === null && (
            <span className="text-xs text-purple-600 dark:text-purple-400">開始点を選択してください</span>
          )}
          {rangeSelectionMode && rangeStart !== null && rangeEnd === null && (
            <span className="text-xs text-purple-600 dark:text-purple-400">終了点を選択してください</span>
          )}
        </div>
      </div>
      
      {/* アイテムリスト */}
      <div className="flex-1 overflow-y-auto">
        {filteredGroupedItems.map((group, groupIndex) => (
          <div key={group.hallName || `no-hall-${groupIndex}`}>
            {/* ホールヘッダー */}
            <div
              className={`sticky top-0 flex items-center justify-between px-4 py-2 cursor-pointer z-10 ${
                group.hallName 
                  ? 'bg-slate-100 dark:bg-slate-800' 
                  : 'bg-slate-50 dark:bg-slate-900 border-l-4 border-slate-300 dark:border-slate-600'
              }`}
              style={group.hallColor ? { borderLeftColor: group.hallColor, borderLeftWidth: '4px' } : {}}
              onClick={() => toggleHallCollapse(group.hallName)}
            >
              <span className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                {group.hallName || 'ホール未定義'}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {group.items.length}件
                </span>
                <svg 
                  className={`w-4 h-4 text-slate-500 transition-transform ${collapsedHalls.has(group.hallName) ? '' : 'rotate-180'}`}
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
            
            {/* アイテム */}
            {!collapsedHalls.has(group.hallName) && group.items.map(({ item, index }) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onDragEnd={handleDragEnd}
                onClick={() => handleItemClick(index, item)}
                onMouseEnter={() => handleItemHover(item)}
                onMouseLeave={onClearHighlight}
                className={`relative flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                  dragOverIndex === index ? 'bg-blue-100 dark:bg-blue-900/30' : ''
                } ${
                  rangeIndices.has(index) ? 'bg-purple-100 dark:bg-purple-900/30' : ''
                } ${
                  swapFirst === index ? 'bg-green-100 dark:bg-green-900/30 ring-2 ring-green-500' : ''
                } ${
                  !group.hallName ? 'bg-slate-50/50 dark:bg-slate-950/50' : ''
                }`}
              >
                {/* 範囲選択インジケーター */}
                {rangeIndices.has(index) && rangeStart !== null && rangeEnd !== null && (
                  <div 
                    className="absolute left-0 top-0 bottom-0 w-1.5 bg-purple-500"
                  >
                    {index === Math.min(rangeStart, rangeEnd) && (
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2 text-purple-600 dark:text-purple-400 text-xl font-bold">↕</div>
                    )}
                  </div>
                )}
                
                {/* 訪問順番号 */}
                <div className="w-8 h-8 flex items-center justify-center bg-blue-600 text-white rounded-full text-sm font-bold flex-shrink-0">
                  {index + 1}
                </div>
                
                {/* ドラッグハンドル */}
                <GripVerticalIcon className="w-5 h-5 text-slate-400 cursor-grab flex-shrink-0" />
                
                {/* アイテム情報 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-slate-900 dark:text-slate-100">
                      {item.block}-{item.number}
                    </span>
                    {item.remarks?.includes('優先') && (
                      <img src="/優先.png" alt="優先" className="h-5 w-auto" />
                    )}
                    {item.remarks?.includes('委託無') && (
                      <img src="/委託無.png" alt="委託無" className="h-5 w-auto" />
                    )}
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
                    {item.circle}
                  </p>
                  {item.title && (
                    <p className="text-xs font-medium text-slate-900 dark:text-slate-900 truncate">
                      {item.title}
                    </p>
                  )}
                  {item.remarks && (
                    <p className="text-xs text-orange-600 dark:text-orange-400 truncate">
                      {item.remarks}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      
      {/* フッター */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
        <span className="text-sm text-slate-600 dark:text-slate-400">
          {items.length}件の訪問先
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            確定
          </button>
        </div>
      </div>
    </div>
  );
};

export default VisitListPanel;
