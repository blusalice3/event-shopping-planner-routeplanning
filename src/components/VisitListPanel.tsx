import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { ShoppingItem, DayMapData, HallDefinition, BlockDefinition } from '../types';
import GripVerticalIcon from './icons/GripVerticalIcon';

// 優先度レベルの型
type PriorityLevel = 'none' | 'priority' | 'highest';

interface VisitListPanelProps {
  isOpen: boolean;
  onClose: () => void;
  items: ShoppingItem[];  // 実行列のアイテム（訪問順）
  onUpdateOrder: (newOrder: ShoppingItem[]) => void;
  mapData: DayMapData | null;
  hallDefinitions: HallDefinition[];
  hallOrder: string[];  // グループIDの訪問順序（{hallId}, {hallId}:priority, {hallId}:highest）
  layoutMode: 'pc' | 'smartphone';
  onHighlightCell: (row: number, col: number) => void;
  onClearHighlight: () => void;
  hasUnsavedChanges: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  selectedHallId?: string;  // 選択中のホールID（'all'は全ホール）
  onUpdateItemPriority?: (itemId: string, priorityLevel: PriorityLevel) => void;  // 優先度変更コールバック
}

interface HistoryState {
  items: ShoppingItem[];
}

// グループIDからホールIDと優先度を分離するヘルパー
const parseGroupId = (groupId: string | null): { hallId: string | null; priority: PriorityLevel } => {
  if (groupId === null) return { hallId: null, priority: 'none' };
  if (groupId.endsWith(':highest')) {
    return { hallId: groupId.replace(':highest', ''), priority: 'highest' };
  }
  if (groupId.endsWith(':priority')) {
    return { hallId: groupId.replace(':priority', ''), priority: 'priority' };
  }
  return { hallId: groupId, priority: 'none' };
};

// ホールIDと優先度からグループIDを生成するヘルパー
const buildGroupId = (hallId: string | null, priority: PriorityLevel): string | null => {
  if (hallId === null) {
    if (priority === 'highest') return 'undefined:highest';
    if (priority === 'priority') return 'undefined:priority';
    return null;
  }
  if (priority === 'highest') return `${hallId}:highest`;
  if (priority === 'priority') return `${hallId}:priority`;
  return hallId;
};

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

// アイテムのグループID（ホールID + 優先度）を取得
const getItemGroupId = (
  item: ShoppingItem,
  mapData: DayMapData | null,
  hallDefinitions: HallDefinition[]
): string | null => {
  const hallId = getItemHallId(item, mapData, hallDefinitions);
  const priority = item.priorityLevel || 'none';
  return buildGroupId(hallId, priority);
};

// グループの表示名を取得
const getGroupDisplayName = (groupId: string | null, hallDefinitions: HallDefinition[]): string => {
  if (groupId === null) return 'ホール未定義';
  if (groupId === 'undefined:highest') return '未定義最優先';
  if (groupId === 'undefined:priority') return '未定義優先';
  
  const { hallId, priority } = parseGroupId(groupId);
  const hall = hallDefinitions.find(h => h.id === hallId);
  const hallName = hall?.name || 'ホール未定義';
  
  if (priority === 'highest') return `${hallName}最優先`;
  if (priority === 'priority') return `${hallName}優先`;
  return hallName;
};

// グループのヘッダー色を取得
const getGroupHeaderStyle = (groupId: string | null, hallDefinitions: HallDefinition[]): { bgClass: string; borderColor: string } => {
  const { hallId, priority } = parseGroupId(groupId);
  const hall = hallDefinitions.find(h => h.id === hallId);
  const baseColor = hall?.color || '#9CA3AF';
  
  if (priority === 'highest') {
    return { bgClass: 'bg-red-100 dark:bg-red-900/40', borderColor: '#EF4444' };
  }
  if (priority === 'priority') {
    return { bgClass: 'bg-orange-100 dark:bg-orange-900/40', borderColor: '#F97316' };
  }
  return { bgClass: 'bg-slate-100 dark:bg-slate-800', borderColor: baseColor };
};

// ホールごとにアイテムをグループ化するヘルパー（優先度対応版）
const groupItemsByHallWithOrder = (
  items: ShoppingItem[],
  mapData: DayMapData | null,
  hallDefinitions: HallDefinition[],
  hallOrder: string[]  // グループIDの順序
): { groupId: string | null; hallId: string | null; hallName: string | null; hallColor?: string; priority: PriorityLevel; items: { item: ShoppingItem; hallIndex: number }[] }[] => {
  if (!mapData) {
    return [{ groupId: null, hallId: null, hallName: null, priority: 'none', items: items.map((item, hallIndex) => ({ item, hallIndex })) }];
  }

  // ホールID→ホール情報のマップ
  const hallMap = new Map<string, HallDefinition>();
  hallDefinitions.forEach(hall => hallMap.set(hall.id, hall));

  // グループ化（グループIDをキーに）
  const groups = new Map<string | null, ShoppingItem[]>();
  
  items.forEach((item) => {
    const groupId = getItemGroupId(item, mapData, hallDefinitions);
    if (!groups.has(groupId)) {
      groups.set(groupId, []);
    }
    groups.get(groupId)!.push(item);
  });

  // グループ順序に従ってソート
  const result: { groupId: string | null; hallId: string | null; hallName: string | null; hallColor?: string; priority: PriorityLevel; items: { item: ShoppingItem; hallIndex: number }[] }[] = [];
  
  // まずhallOrderに従ってグループを追加
  hallOrder.forEach(groupId => {
    if (groups.has(groupId)) {
      const { hallId, priority } = parseGroupId(groupId);
      const hall = hallMap.get(hallId || '');
      const groupItems = groups.get(groupId)!;
      result.push({
        groupId,
        hallId,
        hallName: hall?.name || null,
        hallColor: hall?.color || '#6366f1',
        priority,
        items: groupItems.map((item, hallIndex) => ({ item, hallIndex })),
      });
      groups.delete(groupId);
    }
  });
  
  // hallOrderに含まれないがhallDefinitionsに含まれるホール（通常グループ）を追加
  hallDefinitions.forEach(hall => {
    const groupId = hall.id;
    if (groups.has(groupId)) {
      const groupItems = groups.get(groupId)!;
      result.push({
        groupId,
        hallId: hall.id,
        hallName: hall.name,
        hallColor: hall.color || '#6366f1',
        priority: 'none',
        items: groupItems.map((item, hallIndex) => ({ item, hallIndex })),
      });
      groups.delete(groupId);
    }
  });
  
  // 優先度付きグループで残っているものを追加
  const remainingGroups = Array.from(groups.entries()).filter(([gId]) => gId !== null);
  remainingGroups.forEach(([groupId, groupItems]) => {
    const { hallId, priority } = parseGroupId(groupId);
    const hall = hallMap.get(hallId || '');
    result.push({
      groupId,
      hallId,
      hallName: hall?.name || null,
      hallColor: hall?.color || '#6366f1',
      priority,
      items: groupItems.map((item, hallIndex) => ({ item, hallIndex })),
    });
  });
  
  // ホール未定義のアイテム（null）を最後に追加
  if (groups.has(null)) {
    const groupItems = groups.get(null)!;
    result.push({
      groupId: null,
      hallId: null,
      hallName: null,
      priority: 'none',
      items: groupItems.map((item, hallIndex) => ({ item, hallIndex })),
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
  onUpdateItemPriority,
}) => {
  // 将来使用する可能性のあるprops
  void hasUnsavedChanges;
  
  // パネル位置（PC: left/right）
  const [panelPosition, setPanelPosition] = useState<'left' | 'right'>('right');
  
  // 折りたたみ状態（グループID -> 展開/折りたたみ）
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
  
  // 優先度メニュー用のstate（クリックで表示）
  const [menuItem, setMenuItem] = useState<ShoppingItem | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  
  // ドラッグ状態（ホールIDと内部インデックス）
  const [dragHallId, setDragHallId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  // タッチドラッグ用の状態
  const [touchDragItem, setTouchDragItem] = useState<{
    groupId: string | null;
    hallIndex: number;
    item: ShoppingItem;
  } | null>(null);
  const [touchDragPosition, setTouchDragPosition] = useState<{ x: number; y: number } | null>(null);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const touchStartTime = useRef<number>(0);
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  
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

  // グループ内でアイテムを移動
  const moveItemInHall = useCallback((groupId: string | null, fromHallIndex: number, toHallIndex: number) => {
    if (fromHallIndex === toHallIndex) return;
    
    const newGroups = groupedItems.map(group => {
      if (group.groupId === groupId) {
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

  // グループ内で2つのアイテムを入れ替え
  const swapItemsInHall = useCallback((groupId: string | null, index1: number, index2: number) => {
    if (index1 === index2) return;
    
    const newGroups = groupedItems.map(group => {
      if (group.groupId === groupId) {
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

  // グループ内で区間反転
  const reverseRangeInHall = useCallback((groupId: string | null, start: number, end: number) => {
    const [minIndex, maxIndex] = start < end ? [start, end] : [end, start];
    
    const newGroups = groupedItems.map(group => {
      if (group.groupId === groupId) {
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

  // グループの折りたたみ切り替え
  const toggleHallCollapse = useCallback((groupId: string | null) => {
    setCollapsedHalls(prev => {
      const newSet = new Set(prev);
      if (newSet.has(groupId)) {
        newSet.delete(groupId);
      } else {
        newSet.add(groupId);
      }
      return newSet;
    });
  }, []);

  // メニューを開く（クリックで表示）
  const handleOpenMenu = useCallback((e: React.MouseEvent, item: ShoppingItem) => {
    e.stopPropagation();
    e.preventDefault();
    setMenuItem(item);
    setMenuPosition({ x: e.clientX, y: e.clientY });
  }, []);

  // メニューを閉じる
  const closeMenu = useCallback(() => {
    setMenuItem(null);
    setMenuPosition(null);
  }, []);

  // 優先度変更ハンドラ
  const handleSetPriority = useCallback((priority: PriorityLevel) => {
    if (menuItem && onUpdateItemPriority) {
      onUpdateItemPriority(menuItem.id, priority);
    }
    closeMenu();
  }, [menuItem, onUpdateItemPriority, closeMenu]);

  // アイテムクリック処理（グループIDとグループ内インデックスを受け取る）
  const handleItemClick = useCallback((groupId: string | null, hallIndex: number) => {
    if (swapMode) {
      if (swapFirstIndex === null) {
        // 1つ目を選択
        setSwapFirstHallId(groupId);
        setSwapFirstIndex(hallIndex);
      } else {
        // 2つ目を選択
        if (swapFirstHallId === groupId) {
          // 同一グループ内なので入れ替え実行
          swapItemsInHall(groupId, swapFirstIndex, hallIndex);
        } else {
          // 異なるグループなので警告
          alert('異なるグループのアイテム同士は入れ替えできません');
        }
        setSwapFirstHallId(null);
        setSwapFirstIndex(null);
        setSwapMode(false);
      }
    } else if (rangeSelectionMode) {
      if (rangeStartIndex === null) {
        // 開始点を設定
        setRangeStartHallId(groupId);
        setRangeStartIndex(hallIndex);
        setRangeEndIndex(null);
      } else if (rangeEndIndex === null) {
        // 終了点を設定（同一グループ内のみ）
        if (rangeStartHallId === groupId) {
          setRangeEndIndex(hallIndex);
        } else {
          alert('グループを跨いだ範囲選択はできません');
        }
      } else {
        // 既に範囲が選択されている場合は開始点を再設定
        setRangeStartHallId(groupId);
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

  // ドラッグ開始（グループIDとグループ内インデックスを受け取る）
  const handleDragStart = useCallback((e: React.DragEvent, groupId: string | null, hallIndex: number) => {
    setDragHallId(groupId);
    setDragIndex(hallIndex);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  // ドラッグオーバー
  const handleDragOver = useCallback((e: React.DragEvent, groupId: string | null, hallIndex: number) => {
    e.preventDefault();
    // 同一グループ内のみドロップ可能
    if (dragHallId === groupId) {
      setDragOverIndex(hallIndex);
    }
  }, [dragHallId]);

  // ドロップ
  const handleDrop = useCallback((e: React.DragEvent, groupId: string | null, toHallIndex: number) => {
    e.preventDefault();
    if (dragHallId === groupId && dragIndex !== null && dragIndex !== toHallIndex) {
      moveItemInHall(groupId, dragIndex, toHallIndex);
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

  // 自動スクロール用のref
  const autoScrollTimer = useRef<NodeJS.Timeout | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  // 自動スクロールの停止
  const stopAutoScroll = useCallback(() => {
    if (autoScrollTimer.current) {
      clearInterval(autoScrollTimer.current);
      autoScrollTimer.current = null;
    }
  }, []);

  // 自動スクロールの開始
  const startAutoScroll = useCallback((direction: 'up' | 'down') => {
    stopAutoScroll();
    autoScrollTimer.current = setInterval(() => {
      const container = listContainerRef.current;
      if (container) {
        const scrollAmount = direction === 'up' ? -15 : 15;
        container.scrollTop += scrollAmount;
      }
    }, 16); // 約60fps
  }, [stopAutoScroll]);

  // タッチドラッグ用ハンドラ
  const handleTouchStart = useCallback((e: React.TouchEvent, groupId: string | null, hallIndex: number, item: ShoppingItem) => {
    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    touchStartTime.current = Date.now();
    
    // 長押しタイマー開始（300ms）
    longPressTimer.current = setTimeout(() => {
      // 長押し成功 - ドラッグ開始
      setTouchDragItem({ groupId, hallIndex, item });
      setTouchDragPosition({ x: touch.clientX, y: touch.clientY });
      setDragHallId(groupId);
      setDragIndex(hallIndex);
      
      // 振動フィードバック（対応デバイスのみ）
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, 300);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    
    // 長押し前に移動した場合はキャンセル
    if (longPressTimer.current && touchStartPos.current) {
      const dx = Math.abs(touch.clientX - touchStartPos.current.x);
      const dy = Math.abs(touch.clientY - touchStartPos.current.y);
      if (dx > 10 || dy > 10) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    }
    
    // ドラッグ中の場合
    if (touchDragItem) {
      e.preventDefault();
      e.stopPropagation();
      setTouchDragPosition({ x: touch.clientX, y: touch.clientY });
      
      // リストコンテナの位置を取得
      const container = listContainerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const touchY = touch.clientY;
        
        // 上部エッジ（ヘッダーバー付近）に近づいたら上にスクロール
        const topThreshold = rect.top + 60; // 上から60px
        // 下部エッジ（確定ボタン付近）に近づいたら下にスクロール
        const bottomThreshold = rect.bottom - 80; // 下から80px
        
        if (touchY < topThreshold) {
          startAutoScroll('up');
        } else if (touchY > bottomThreshold) {
          startAutoScroll('down');
        } else {
          stopAutoScroll();
        }
      }
      
      // ドロップ先を検出
      const elements = document.elementsFromPoint(touch.clientX, touch.clientY);
      let found = false;
      for (const el of elements) {
        const itemEl = el.closest('[data-drag-item]') as HTMLElement;
        if (itemEl) {
          const targetGroupId = itemEl.dataset.groupId || null;
          const targetHallIndex = parseInt(itemEl.dataset.hallIndex || '-1', 10);
          
          if (targetGroupId === touchDragItem.groupId && targetHallIndex !== touchDragItem.hallIndex) {
            setDragOverIndex(targetHallIndex);
            found = true;
          }
          break;
        }
      }
      if (!found) {
        setDragOverIndex(null);
      }
    }
  }, [touchDragItem, startAutoScroll, stopAutoScroll]);

  const handleTouchEnd = useCallback(() => {
    // 自動スクロールを停止
    stopAutoScroll();
    
    // 長押しタイマーをクリア
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    
    // ドラッグ中の場合はドロップ処理
    if (touchDragItem && dragOverIndex !== null && dragOverIndex !== touchDragItem.hallIndex) {
      moveItemInHall(touchDragItem.groupId, touchDragItem.hallIndex, dragOverIndex);
    }
    
    // 状態をリセット
    setTouchDragItem(null);
    setTouchDragPosition(null);
    setDragHallId(null);
    setDragIndex(null);
    setDragOverIndex(null);
    touchStartPos.current = null;
  }, [touchDragItem, dragOverIndex, moveItemInHall, stopAutoScroll]);

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
    
    // 選択ホールに関連するグループ（通常/優先/最優先）を返す
    return groupedItems.filter(group => group.hallId === selectedHall.id);
  }, [groupedItems, selectedHallId, hallDefinitions]);

  // 範囲選択の表示用（グループ内インデックス）
  const isInRange = useCallback((groupId: string | null, hallIndex: number): boolean => {
    if (!rangeSelectionMode) return false;
    if (rangeStartHallId !== groupId) return false;
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
              <span className="text-xs text-green-600 dark:text-green-400 ml-2">2つ目を選択（同一グループ内）</span>
            )}
          </div>
          
          {/* アイテムリスト */}
          <div 
            ref={listContainerRef}
            className={`flex-1 overflow-y-auto ${touchDragItem ? 'touch-none' : ''}`}
            style={{ touchAction: touchDragItem ? 'none' : 'auto' }}
          >
            {filteredGroupedItems.map((group, groupIndex) => {
              const headerStyle = getGroupHeaderStyle(group.groupId, hallDefinitions);
              const displayName = getGroupDisplayName(group.groupId, hallDefinitions);
              return (
              <div key={group.groupId ?? `no-hall-${groupIndex}`}>
                {/* グループヘッダー */}
                <div
                  className={`sticky top-0 flex items-center justify-between px-4 py-2 cursor-pointer z-10 ${headerStyle.bgClass}`}
                  style={{ borderLeftColor: headerStyle.borderColor, borderLeftWidth: '4px' }}
                  onClick={() => toggleHallCollapse(group.groupId)}
                >
                  <span className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                    {displayName}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      {group.items.length}件
                    </span>
                    <svg 
                      className={`w-4 h-4 text-slate-500 transition-transform ${collapsedHalls.has(group.groupId) ? '' : 'rotate-180'}`}
                      fill="none" 
                      stroke="currentColor" 
                      viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
                
                {/* アイテム */}
                {!collapsedHalls.has(group.groupId) && group.items.map(({ item, hallIndex }) => (
                  <div
                    key={item.id}
                    data-drag-item
                    data-group-id={group.groupId}
                    data-hall-index={hallIndex}
                    draggable
                    onDragStart={(e) => handleDragStart(e, group.groupId, hallIndex)}
                    onDragOver={(e) => handleDragOver(e, group.groupId, hallIndex)}
                    onDrop={(e) => handleDrop(e, group.groupId, hallIndex)}
                    onDragEnd={handleDragEnd}
                    onTouchStart={(e) => handleTouchStart(e, group.groupId, hallIndex, item)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    onClick={() => !touchDragItem && handleItemClick(group.groupId, hallIndex)}
                    onMouseEnter={() => handleItemHover(item)}
                    onMouseLeave={onClearHighlight}
                    className={`relative flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors touch-manipulation ${
                      dragHallId === group.groupId && dragOverIndex === hallIndex ? 'bg-blue-100 dark:bg-blue-900/30' : ''
                    } ${
                      isInRange(group.groupId, hallIndex) ? 'bg-purple-100 dark:bg-purple-900/30' : ''
                    } ${
                      swapFirstHallId === group.groupId && swapFirstIndex === hallIndex ? 'bg-green-100 dark:bg-green-900/30' : ''
                    } ${
                      group.priority === 'highest' ? 'bg-red-50/50 dark:bg-red-950/30' : 
                      group.priority === 'priority' ? 'bg-orange-50/50 dark:bg-orange-950/30' : ''
                    } ${
                      touchDragItem?.item.id === item.id ? 'opacity-50' : ''
                    }`}
                  >
                    {/* 範囲選択インジケーター */}
                    {isInRange(group.groupId, hallIndex) && rangeStartIndex !== null && rangeEndIndex !== null && (
                      <div className="absolute left-0 top-0 bottom-0 w-1 bg-purple-500 flex items-center justify-center">
                        {hallIndex === Math.min(rangeStartIndex, rangeEndIndex) && (
                          <div className="absolute -left-2 text-purple-500 text-lg">↕</div>
                        )}
                      </div>
                    )}
                    
                    {/* グループ内訪問順番号 */}
                    <div className={`w-8 h-8 flex items-center justify-center text-white rounded-full text-sm font-bold ${
                      group.priority === 'highest' ? 'bg-red-600' :
                      group.priority === 'priority' ? 'bg-orange-500' : 'bg-blue-600'
                    }`}>
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
                    
                    {/* 優先度メニューボタン */}
                    {onUpdateItemPriority && (
                      <button
                        onClick={(e) => handleOpenMenu(e, item)}
                        className="p-1.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400"
                        title="優先度を変更"
                      >
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );})}
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
        
        {/* フローティングドラッグアイテム */}
        {touchDragItem && touchDragPosition && (
          <div
            className="fixed z-[100] pointer-events-none bg-white dark:bg-slate-800 shadow-2xl rounded-lg px-4 py-2 border-2 border-blue-500"
            style={{
              left: touchDragPosition.x - 100,
              top: touchDragPosition.y - 30,
              width: '200px',
            }}
          >
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 flex items-center justify-center text-white rounded-full text-xs font-bold bg-blue-600">
                {touchDragItem.hallIndex + 1}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">
                  {touchDragItem.item.block}-{touchDragItem.item.number}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
                  {touchDragItem.item.circle}
                </p>
              </div>
            </div>
          </div>
        )}
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
            <span className="text-xs text-green-600 dark:text-green-400">2つ目を選択してください（同一グループ内）</span>
          )}
          {rangeSelectionMode && rangeStartIndex === null && (
            <span className="text-xs text-purple-600 dark:text-purple-400">開始点を選択してください</span>
          )}
          {rangeSelectionMode && rangeStartIndex !== null && rangeEndIndex === null && (
            <span className="text-xs text-purple-600 dark:text-purple-400">終了点を選択してください（同一グループ内）</span>
          )}
        </div>
      </div>
      
      {/* アイテムリスト */}
      <div 
        ref={listContainerRef}
        className={`flex-1 overflow-y-auto ${touchDragItem ? 'touch-none' : ''}`}
        style={{ touchAction: touchDragItem ? 'none' : 'auto' }}
      >
        {filteredGroupedItems.map((group, groupIndex) => {
          const headerStyle = getGroupHeaderStyle(group.groupId, hallDefinitions);
          const displayName = getGroupDisplayName(group.groupId, hallDefinitions);
          return (
          <div key={group.groupId ?? `no-hall-${groupIndex}`}>
            {/* グループヘッダー */}
            <div
              className={`sticky top-0 flex items-center justify-between px-4 py-2 cursor-pointer z-10 ${headerStyle.bgClass}`}
              style={{ borderLeftColor: headerStyle.borderColor, borderLeftWidth: '4px' }}
              onClick={() => toggleHallCollapse(group.groupId)}
            >
              <span className="font-semibold text-sm text-slate-700 dark:text-slate-300">
                {displayName}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {group.items.length}件
                </span>
                <svg 
                  className={`w-4 h-4 text-slate-500 transition-transform ${collapsedHalls.has(group.groupId) ? '' : 'rotate-180'}`}
                  fill="none" 
                  stroke="currentColor" 
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
            
            {/* アイテム */}
            {!collapsedHalls.has(group.groupId) && group.items.map(({ item, hallIndex }) => (
              <div
                key={item.id}
                data-drag-item
                data-group-id={group.groupId}
                data-hall-index={hallIndex}
                draggable
                onDragStart={(e) => handleDragStart(e, group.groupId, hallIndex)}
                onDragOver={(e) => handleDragOver(e, group.groupId, hallIndex)}
                onDrop={(e) => handleDrop(e, group.groupId, hallIndex)}
                onDragEnd={handleDragEnd}
                onTouchStart={(e) => handleTouchStart(e, group.groupId, hallIndex, item)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onClick={() => !touchDragItem && handleItemClick(group.groupId, hallIndex)}
                onMouseEnter={() => handleItemHover(item)}
                onMouseLeave={onClearHighlight}
                className={`relative flex items-center gap-2 px-4 py-2 border-b border-slate-100 dark:border-slate-800 cursor-pointer transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50 touch-manipulation ${
                  dragHallId === group.groupId && dragOverIndex === hallIndex ? 'bg-blue-100 dark:bg-blue-900/30' : ''
                } ${
                  isInRange(group.groupId, hallIndex) ? 'bg-purple-100 dark:bg-purple-900/30' : ''
                } ${
                  swapFirstHallId === group.groupId && swapFirstIndex === hallIndex ? 'bg-green-100 dark:bg-green-900/30 ring-2 ring-green-500' : ''
                } ${
                  group.priority === 'highest' ? 'bg-red-50/50 dark:bg-red-950/30' : 
                  group.priority === 'priority' ? 'bg-orange-50/50 dark:bg-orange-950/30' : ''
                } ${
                  touchDragItem?.item.id === item.id ? 'opacity-50' : ''
                }`}
              >
                {/* 範囲選択インジケーター */}
                {isInRange(group.groupId, hallIndex) && rangeStartIndex !== null && rangeEndIndex !== null && (
                  <div 
                    className="absolute left-0 top-0 bottom-0 w-1.5 bg-purple-500"
                  >
                    {hallIndex === Math.min(rangeStartIndex, rangeEndIndex) && (
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2 text-purple-600 dark:text-purple-400 text-xl font-bold">↕</div>
                    )}
                  </div>
                )}
                
                {/* グループ内訪問順番号 */}
                <div className={`w-8 h-8 flex items-center justify-center text-white rounded-full text-sm font-bold flex-shrink-0 ${
                  group.priority === 'highest' ? 'bg-red-600' :
                  group.priority === 'priority' ? 'bg-orange-500' : 'bg-blue-600'
                }`}>
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
                
                {/* 優先度メニューボタン */}
                {onUpdateItemPriority && (
                  <button
                    onClick={(e) => handleOpenMenu(e, item)}
                    className="p-2 rounded hover:bg-slate-200 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400"
                    title="優先度を変更"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>
        );})}
      </div>
      
      {/* 優先度メニュー */}
      {menuItem && menuPosition && (
        <div 
          className="fixed z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 py-2 min-w-[160px]"
          style={{ 
            left: Math.min(menuPosition.x, window.innerWidth - 180),
            top: Math.min(menuPosition.y, window.innerHeight - 150)
          }}
        >
          <div className="px-3 py-1 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700 mb-1">
            優先度設定
          </div>
          {menuItem.priorityLevel !== 'highest' && (
            <button
              onClick={() => handleSetPriority('highest')}
              className="w-full px-3 py-2 text-left text-sm hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center gap-2"
            >
              <span className="w-3 h-3 bg-red-500 rounded-full" />
              最優先
            </button>
          )}
          {menuItem.priorityLevel !== 'priority' && (
            <button
              onClick={() => handleSetPriority('priority')}
              className="w-full px-3 py-2 text-left text-sm hover:bg-orange-50 dark:hover:bg-orange-900/30 text-orange-600 dark:text-orange-400 flex items-center gap-2"
            >
              <span className="w-3 h-3 bg-orange-500 rounded-full" />
              優先
            </button>
          )}
          {(menuItem.priorityLevel === 'highest' || menuItem.priorityLevel === 'priority') && (
            <button
              onClick={() => handleSetPriority('none')}
              className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 flex items-center gap-2"
            >
              <span className="w-3 h-3 bg-slate-400 rounded-full" />
              {menuItem.priorityLevel === 'highest' ? '最優先解除' : '優先解除'}
            </button>
          )}
          <div className="border-t border-slate-200 dark:border-slate-700 mt-1 pt-1">
            <button
              onClick={closeMenu}
              className="w-full px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 dark:text-slate-400"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
      {/* メニュー背景クリックで閉じる */}
      {menuItem && menuPosition && (
        <div 
          className="fixed inset-0 z-40"
          onClick={closeMenu}
        />
      )}
      
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
      
      {/* フローティングドラッグアイテム */}
      {touchDragItem && touchDragPosition && (
        <div
          className="fixed z-[100] pointer-events-none bg-white dark:bg-slate-800 shadow-2xl rounded-lg px-4 py-2 border-2 border-blue-500"
          style={{
            left: touchDragPosition.x - 100,
            top: touchDragPosition.y - 30,
            width: '200px',
          }}
        >
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 flex items-center justify-center text-white rounded-full text-xs font-bold bg-blue-600">
              {touchDragItem.hallIndex + 1}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-slate-900 dark:text-slate-100 truncate">
                {touchDragItem.item.block}-{touchDragItem.item.number}
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400 truncate">
                {touchDragItem.item.circle}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VisitListPanel;
