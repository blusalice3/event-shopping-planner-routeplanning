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
  hallOrder: string[];  // ホールIDの訪問順序
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

// アイテムのホールIDを取得するヘルパー
const getItemHallId = (
  item: ShoppingItem,
  mapData: DayMapData | null,
  hallDefinitions: HallDefinition[]
): string | null => {
  if (!mapData) return null;
  
  const block = mapData.blocks.find((b: BlockDefinition) => b.name === item.block);
  if (!block) return null;
  
  const numMatch = item.number?.match(/\d+/);
  if (!numMatch) return null;
  const num = parseInt(numMatch[0], 10);
  
  const cell = block.numberCells.find((nc: { row: number; col: number; value: number }) => nc.value === num);
  if (!cell) return null;
  
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
  
  for (const hall of hallDefinitions) {
    for (const vertex of hall.vertices) {
      if (vertex.row === cell.row && vertex.col === cell.col) {
        return hall.id;
      }
    }
    if (isPointInPolygon(cell.row, cell.col, hall.vertices)) {
      return hall.id;
    }
  }
  return null;
};

// ホールごとにアイテムをグループ化するヘルパー（ホール順序対応版）
const groupItemsByHallWithOrder = (
  items: ShoppingItem[],
  mapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
  hallOrder: string[]  // ホールIDの順序
): { hallId: string | null; hallName: string | null; hallColor?: string; items: { item: ShoppingItem; hallIndex: number }[] }[] => {
  if (!mapData) {
    return [{ hallId: null, hallName: null, items: items.map((item, hallIndex) => ({ item, hallIndex })) }];
  }

  // ホールID→ホール情報のマップ
  const hallMap = new Map<string, HallDefinition>();
  hallDefinitions.forEach(hall => hallMap.set(hall.id, hall));

  // グループ化（ホールIDをキーに）
  const groups = new Map<string | null, ShoppingItem[]>();
  
  items.forEach((item) => {
    const hallId = getItemHallId(item, mapData, hallDefinitions);
    if (!groups.has(hallId)) {
      groups.set(hallId, []);
    }
    groups.get(hallId)!.push(item);
  });

  // ホール順序に従ってソート
  const result: { hallId: string | null; hallName: string | null; hallColor?: string; items: { item: ShoppingItem; hallIndex: number }[] }[] = [];
  
  // まずhallOrderに従って定義済みホールを追加
  hallOrder.forEach(hallId => {
    const hall = hallMap.get(hallId);
    if (hall && groups.has(hallId)) {
      const hallItems = groups.get(hallId)!;
      result.push({
        hallId,
        hallName: hall.name,
        hallColor: hall.color || '#6366f1',
        items: hallItems.map((item, hallIndex) => ({ item, hallIndex })),
      });
      groups.delete(hallId);
    }
  });
  
  // hallOrderに含まれないがhallDefinitionsに含まれるホールを追加
  hallDefinitions.forEach(hall => {
    if (groups.has(hall.id)) {
      const hallItems = groups.get(hall.id)!;
      result.push({
        hallId: hall.id,
        hallName: hall.name,
        hallColor: hall.color || '#6366f1',
        items: hallItems.map((item, hallIndex) => ({ item, hallIndex })),
      });
      groups.delete(hall.id);
    }
  });
  
  // ホール未定義のアイテム（null）を最後に追加
  if (groups.has(null)) {
    const hallItems = groups.get(null)!;
    result.push({
      hallId: null,
      hallName: null,
      items: hallItems.map((item, hallIndex) => ({ item, hallIndex })),
    });
  }

  return result;
};

const VisitListPanel: React.FC<VisitListPanelProps> = ({
  isOpen,
  onClose,
  items,
  onUpdateOrder,
  mapData,
  hallDefinitions,
  hallOrder,
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
  
  // 折りたたみ状態（ホールID -> 展開/折りたたみ）
  const [collapsedHalls, setCollapsedHalls] = useState<Set<string | null>>(new Set());
  
  // 範囲選択状態（rangeSelectionModeがtrueの時のみ有効）
  const [rangeSelectionMode, setRangeSelectionMode] = useState(false);
  const [rangeStartHallId, setRangeStartHallId] = useState<string | null>(null);
  const [rangeStartIndex, setRangeStartIndex] = useState<number | null>(null);
  const [rangeEndIndex, setRangeEndIndex] = useState<number | null>(null);
  
  // 2つ選択して入れ替えモード
  const [swapMode, setSwapMode] = useState(false);
  const [swapFirstHallId, setSwapFirstHallId] = useState<string | null>(null);
  const [swapFirstIndex, setSwapFirstIndex] = useState<number | null>(null);
  
  // ドラッグ状態（ホールIDと内部インデックス）
  const [dragHallId, setDragHallId] = useState<string | null>(null);
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

  // グループ化されたアイテム（ホール順序に従う）
  const groupedItems = useMemo(() => 
    groupItemsByHallWithOrder(items, mapData, hallDefinitions, hallOrder),
    [items, mapData, hallDefinitions, hallOrder]
  );

  // グループ化されたアイテムからフラットな配列を再構築するヘルパー
  const rebuildItemsFromGroups = useCallback((
    groups: { hallId: string | null; items: { item: ShoppingItem; hallIndex: number }[] }[]
  ): ShoppingItem[] => {
    const result: ShoppingItem[] = [];
    groups.forEach(group => {
      group.items.forEach(({ item }) => {
        result.push(item);
      });
    });
    return result;
  }, []);

  // ホール内でアイテムを移動
  const moveItemInHall = useCallback((hallId: string | null, fromHallIndex: number, toHallIndex: number) => {
    if (fromHallIndex === toHallIndex) return;
    
    const newGroups = groupedItems.map(group => {
      if (group.hallId === hallId) {
        const newHallItems = [...group.items];
        const [movedItem] = newHallItems.splice(fromHallIndex, 1);
        newHallItems.splice(toHallIndex, 0, movedItem);
        return { ...group, items: newHallItems.map((item, idx) => ({ ...item, hallIndex: idx })) };
      }
      return group;
    });
    
    const newItems = rebuildItemsFromGroups(newGroups);
    pushHistory(newItems);
    onUpdateOrder(newItems);
  }, [groupedItems, rebuildItemsFromGroups, pushHistory, onUpdateOrder]);

  // ホール内で2つのアイテムを入れ替え
  const swapItemsInHall = useCallback((hallId: string | null, index1: number, index2: number) => {
    if (index1 === index2) return;
    
    const newGroups = groupedItems.map(group => {
      if (group.hallId === hallId) {
        const newHallItems = [...group.items];
        [newHallItems[index1], newHallItems[index2]] = [newHallItems[index2], newHallItems[index1]];
        return { ...group, items: newHallItems.map((item, idx) => ({ ...item, hallIndex: idx })) };
      }
      return group;
    });
    
    const newItems = rebuildItemsFromGroups(newGroups);
    pushHistory(newItems);
    onUpdateOrder(newItems);
  }, [groupedItems, rebuildItemsFromGroups, pushHistory, onUpdateOrder]);

  // ホール内で区間反転
  const reverseRangeInHall = useCallback((hallId: string | null, start: number, end: number) => {
    const [minIndex, maxIndex] = start < end ? [start, end] : [end, start];
    
    const newGroups = groupedItems.map(group => {
      if (group.hallId === hallId) {
        const newHallItems = [...group.items];
        const rangeItems = newHallItems.slice(minIndex, maxIndex + 1).reverse();
        newHallItems.splice(minIndex, maxIndex - minIndex + 1, ...rangeItems);
        return { ...group, items: newHallItems.map((item, idx) => ({ ...item, hallIndex: idx })) };
      }
      return group;
    });
    
    const newItems = rebuildItemsFromGroups(newGroups);
    pushHistory(newItems);
    onUpdateOrder(newItems);
    
    // 範囲選択をクリア
    setRangeStartHallId(null);
    setRangeStartIndex(null);
    setRangeEndIndex(null);
    setRangeSelectionMode(false);
  }, [groupedItems, rebuildItemsFromGroups, pushHistory, onUpdateOrder]);

  // ホールの折りたたみ切り替え
  const toggleHallCollapse = useCallback((hallId: string | null) => {
    setCollapsedHalls(prev => {
      const newSet = new Set(prev);
      if (newSet.has(hallId)) {
        newSet.delete(hallId);
      } else {
        newSet.add(hallId);
      }
      return newSet;
    });
  }, []);

  // アイテムクリック処理（ホールIDとホール内インデックスを受け取る）
  const handleItemClick = useCallback((hallId: string | null, hallIndex: number) => {
    if (swapMode) {
      if (swapFirstIndex === null) {
        // 1つ目を選択
        setSwapFirstHallId(hallId);
        setSwapFirstIndex(hallIndex);
      } else {
        // 2つ目を選択
        if (swapFirstHallId === hallId) {
          // 同一ホール内なので入れ替え実行
          swapItemsInHall(hallId, swapFirstIndex, hallIndex);
        } else {
          // 異なるホールなので警告
          alert('異なるホールのアイテム同士は入れ替えできません');
        }
        setSwapFirstHallId(null);
        setSwapFirstIndex(null);
        setSwapMode(false);
      }
    } else if (rangeSelectionMode) {
      if (rangeStartIndex === null) {
        // 開始点を設定
        setRangeStartHallId(hallId);
        setRangeStartIndex(hallIndex);
        setRangeEndIndex(null);
      } else if (rangeEndIndex === null) {
        // 終了点を設定（同一ホール内のみ）
        if (rangeStartHallId === hallId) {
          setRangeEndIndex(hallIndex);
        } else {
          alert('ホールを跨いだ範囲選択はできません');
        }
      } else {
        // 既に範囲が選択されている場合は開始点を再設定
        setRangeStartHallId(hallId);
        setRangeStartIndex(hallIndex);
        setRangeEndIndex(null);
      }
    }
  }, [swapMode, swapFirstHallId, swapFirstIndex, rangeSelectionMode, rangeStartHallId, rangeStartIndex, rangeEndIndex, swapItemsInHall]);

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

  // ドラッグ開始（ホールIDとホール内インデックスを受け取る）
  const handleDragStart = useCallback((e: React.DragEvent, hallId: string | null, hallIndex: number) => {
    setDragHallId(hallId);
    setDragIndex(hallIndex);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  // ドラッグオーバー
  const handleDragOver = useCallback((e: React.DragEvent, hallId: string | null, hallIndex: number) => {
    e.preventDefault();
    // 同一ホール内のみドロップ可能
    if (dragHallId === hallId) {
      setDragOverIndex(hallIndex);
    }
  }, [dragHallId]);

  // ドロップ
  const handleDrop = useCallback((e: React.DragEvent, hallId: string | null, toHallIndex: number) => {
    e.preventDefault();
    if (dragHallId === hallId && dragIndex !== null && dragIndex !== toHallIndex) {
      moveItemInHall(hallId, dragIndex, toHallIndex);
    }
    setDragHallId(null);
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragHallId, dragIndex, moveItemInHall]);

  // ドラッグ終了
  const handleDragEnd = useCallback(() => {
    setDragHallId(null);
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

  // 選択ホールでフィルタされたグループ
  const filteredGroupedItems = useMemo(() => {
    if (selectedHallId === 'all') {
      return groupedItems;
    }
    
    const selectedHall = hallDefinitions.find(h => h.id === selectedHallId);
    if (!selectedHall) return groupedItems;
    
    // 選択ホールのみを含むグループを返す
    return groupedItems.filter(group => group.hallId === selectedHall.id);
  }, [groupedItems, selectedHallId, hallDefinitions]);

  // 範囲選択の表示用（ホール内インデックス）
  const isInRange = useCallback((hallId: string | null, hallIndex: number): boolean => {
    if (!rangeSelectionMode) return false;
    if (rangeStartHallId !== hallId) return false;
    if (rangeStartIndex === null) return false;
    if (rangeEndIndex === null) return hallIndex === rangeStartIndex;
    
    const [min, max] = rangeStartIndex < rangeEndIndex ? [rangeStartIndex, rangeEndIndex] : [rangeEndIndex, rangeStartIndex];
    return hallIndex >= min && hallIndex <= max;
  }, [rangeSelectionMode, rangeStartHallId, rangeStartIndex, rangeEndIndex]);

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
                setSwapFirstHallId(null);
                setSwapFirstIndex(null);
                setRangeSelectionMode(false);
                setRangeStartHallId(null);
                setRangeStartIndex(null);
                setRangeEndIndex(null);
              }}
              className={`px-3 py-1.5 text-sm rounded-md ${swapMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
            >
              入れ替え
            </button>
            <button
              onClick={() => {
                const newMode = !rangeSelectionMode;
                setRangeSelectionMode(newMode);
                setRangeStartHallId(null);
                setRangeStartIndex(null);
                setRangeEndIndex(null);
                setSwapMode(false);
                setSwapFirstHallId(null);
                setSwapFirstIndex(null);
              }}
              className={`px-3 py-1.5 text-sm rounded-md ${rangeSelectionMode ? 'bg-purple-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'}`}
            >
              範囲選択
            </button>
            {rangeSelectionMode && rangeStartIndex !== null && rangeEndIndex !== null && rangeStartHallId !== null && (
              <button
                onClick={() => reverseRangeInHall(rangeStartHallId, rangeStartIndex, rangeEndIndex)}
                className="px-3 py-1.5 text-sm rounded-md bg-orange-500 text-white"
              >
                区間反転
              </button>
            )}
            {/* 操作ヒント */}
            {rangeSelectionMode && rangeStartIndex === null && (
              <span className="text-xs text-purple-600 dark:text-purple-400 ml-2">開始点を選択</span>
            )}
            {rangeSelectionMode && rangeStartIndex !== null && rangeEndIndex === null && (
              <span className="text-xs text-purple-600 dark:text-purple-400 ml-2">終了点を選択</span>
            )}
            {swapMode && swapFirstIndex === null && (
              <span className="text-xs text-blue-600 dark:text-blue-400 ml-2">1つ目を選択</span>
            )}
            {swapMode && swapFirstIndex !== null && (
              <span className="text-xs text-green-600 dark:text-green-400 ml-2">2つ目を選択（同一ホール内）</span>
            )}
          </div>
          
          {/* アイテムリスト */}
          <div className="flex-1 overflow-y-auto">
            {filteredGroupedItems.map((group, groupIndex) => (
              <div key={group.hallId || `no-hall-${groupIndex}`}>
                {/* ホールヘッダー */}
                <div
                  className={`sticky top-0 flex items-center justify-between px-4 py-2 cursor-pointer z-10 ${
                    group.hallName 
                      ? 'bg-slate-100 dark:bg-slate-800' 
                      : 'bg-slate-50 dark:bg-slate-900 border-l-4 border-slate-300 dark:border-slate-600'
                  }`}
                  style={group.hallColor ? { borderLeftColor: group.hallColor, borderLeftWidth: '4px' } : {}}
                  onClick={() => toggleHallCollapse(group.hallId)}
                >
                  <span className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                    {group.hallName || 'ホール未定義'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {group.items.length}件
                    </span>
                    <svg 
                      className={`w-4 h-4 text-slate-500 transition-transform ${collapsedHalls.has(group.hallId) ? '' : 'rotate-180'}`}
                      fill="none" 
                      stroke="currentColor" 
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                
                {/* アイテム */}
                {!collapsedHalls.has(group.hallId) && group.items.map(({ item, hallIndex }) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, group.hallId, hallIndex)}
                    onDragOver={(e) => handleDragOver(e, group.hallId, hallIndex)}
                    onDrop={(e) => handleDrop(e, group.hallId, hallIndex)}
                    onDragEnd={handleDragEnd}
                    onClick={() => handleItemClick(group.hallId, hallIndex)}
                    onMouseEnter={() => handleItemHover(item)}
                    onMouseLeave={onClearHighlight}
                    className={`relative flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors ${
                      dragHallId === group.hallId && dragOverIndex === hallIndex ? 'bg-blue-100 dark:bg-blue-900/30' : ''
                    } ${
                      isInRange(group.hallId, hallIndex) ? 'bg-purple-100 dark:bg-purple-900/30' : ''
                    } ${
                      swapFirstHallId === group.hallId && swapFirstIndex === hallIndex ? 'bg-green-100 dark:bg-green-900/30' : ''
                    } ${
                      !group.hallName ? 'bg-slate-50/50 dark:bg-slate-950/50' : ''
                    }`}
                  >
                    {/* 範囲選択インジケーター */}
                    {isInRange(group.hallId, hallIndex) && rangeStartIndex !== null && rangeEndIndex !== null && (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-purple-500 flex items-center justify-center">
                        {hallIndex === Math.min(rangeStartIndex, rangeEndIndex) && (
                          <div className="absolute -left-2 text-purple-500 text-lg">↕</div>
                        )}
                      </div>
                    )}
                    
                    {/* ホール内訪問順番号 */}
                    <div className="w-8 h-8 flex items-center justify-center bg-blue-600 text-white rounded-full text-sm font-bold">
                      {hallIndex + 1}
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
            setSwapFirstHallId(null);
            setSwapFirstIndex(null);
            setRangeSelectionMode(false);
            setRangeStartHallId(null);
            setRangeStartIndex(null);
            setRangeEndIndex(null);
          }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${swapMode ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'}`}
        >
          入れ替え
        </button>
        <button
          onClick={() => {
            const newMode = !rangeSelectionMode;
            setRangeSelectionMode(newMode);
            setRangeStartHallId(null);
            setRangeStartIndex(null);
            setRangeEndIndex(null);
            setSwapMode(false);
            setSwapFirstHallId(null);
            setSwapFirstIndex(null);
          }}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${rangeSelectionMode ? 'bg-purple-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600'}`}
        >
          範囲選択
        </button>
        {rangeSelectionMode && rangeStartIndex !== null && rangeEndIndex !== null && rangeStartHallId !== null && (
          <button
            onClick={() => reverseRangeInHall(rangeStartHallId, rangeStartIndex, rangeEndIndex)}
            className="px-3 py-1.5 text-sm rounded-md bg-orange-500 text-white hover:bg-orange-600 transition-colors"
          >
            区間反転
          </button>
        )}
        
        {/* 操作ヒント */}
        <div className="flex-1 text-right">
          {swapMode && swapFirstIndex === null && (
            <span className="text-xs text-slate-500 dark:text-slate-400">1つ目を選択してください</span>
          )}
          {swapMode && swapFirstIndex !== null && (
            <span className="text-xs text-green-600 dark:text-green-400">2つ目を選択してください（同一ホール内）</span>
          )}
          {rangeSelectionMode && rangeStartIndex === null && (
            <span className="text-xs text-purple-600 dark:text-purple-400">開始点を選択してください</span>
          )}
          {rangeSelectionMode && rangeStartIndex !== null && rangeEndIndex === null && (
            <span className="text-xs text-purple-600 dark:text-purple-400">終了点を選択してください（同一ホール内）</span>
          )}
        </div>
      </div>
      
      {/* アイテムリスト */}
      <div className="flex-1 overflow-y-auto">
        {filteredGroupedItems.map((group, groupIndex) => (
          <div key={group.hallId || `no-hall-${groupIndex}`}>
            {/* ホールヘッダー */}
            <div
              className={`sticky top-0 flex items-center justify-between px-4 py-2 cursor-pointer z-10 ${
                group.hallName 
                  ? 'bg-slate-100 dark:bg-slate-800' 
                  : 'bg-slate-50 dark:bg-slate-900 border-l-4 border-slate-300 dark:border-slate-600'
              }`}
              style={group.hallColor ? { borderLeftColor: group.hallColor, borderLeftWidth: '4px' } : {}}
              onClick={() => toggleHallCollapse(group.hallId)}
            >
              <span className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                {group.hallName || 'ホール未定義'}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {group.items.length}件
                </span>
                <svg 
                  className={`w-4 h-4 text-slate-500 transition-transform ${collapsedHalls.has(group.hallId) ? '' : 'rotate-180'}`}
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
            
            {/* アイテム */}
            {!collapsedHalls.has(group.hallId) && group.items.map(({ item, hallIndex }) => (
              <div
                key={item.id}
                draggable
                onDragStart={(e) => handleDragStart(e, group.hallId, hallIndex)}
                onDragOver={(e) => handleDragOver(e, group.hallId, hallIndex)}
                onDrop={(e) => handleDrop(e, group.hallId, hallIndex)}
                onDragEnd={handleDragEnd}
                onClick={() => handleItemClick(group.hallId, hallIndex)}
                onMouseEnter={() => handleItemHover(item)}
                onMouseLeave={onClearHighlight}
                className={`relative flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                  dragHallId === group.hallId && dragOverIndex === hallIndex ? 'bg-blue-100 dark:bg-blue-900/30' : ''
                } ${
                  isInRange(group.hallId, hallIndex) ? 'bg-purple-100 dark:bg-purple-900/30' : ''
                } ${
                  swapFirstHallId === group.hallId && swapFirstIndex === hallIndex ? 'bg-green-100 dark:bg-green-900/30 ring-2 ring-green-500' : ''
                } ${
                  !group.hallName ? 'bg-slate-50/50 dark:bg-slate-950/50' : ''
                }`}
              >
                {/* 範囲選択インジケーター */}
                {isInRange(group.hallId, hallIndex) && rangeStartIndex !== null && rangeEndIndex !== null && (
                  <div 
                    className="absolute left-0 top-0 bottom-0 w-1.5 bg-purple-500"
                  >
                    {hallIndex === Math.min(rangeStartIndex, rangeEndIndex) && (
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2 text-purple-600 dark:text-purple-400 text-xl font-bold">↕</div>
                    )}
                  </div>
                )}
                
                {/* ホール内訪問順番号 */}
                <div className="w-8 h-8 flex items-center justify-center bg-blue-600 text-white rounded-full text-sm font-bold flex-shrink-0">
                  {hallIndex + 1}
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
