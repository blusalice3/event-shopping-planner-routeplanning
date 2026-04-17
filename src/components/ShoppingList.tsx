import React, { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { ShoppingItem, HallDefinition, DayMapData, PurchaseStatus } from '../types';
import { getSpaceKey, getBaseNumber, getStatusSummaryText } from '../utils/spaceGrouping';
import {
  parseGroupId,
  buildGroupId,
  getHallIdForItem,
  groupItemsByHallOrder,
  sortItemsByHallOrder,
} from '../utils/hallGrouping';
import ShoppingItemCard from './ShoppingItemCard';
import GripVerticalIcon from './icons/GripVerticalIcon';
import ChevronUpIcon from './icons/ChevronUpIcon';
import ChevronDownIcon from './icons/ChevronDownIcon';

// 優先度レベルの型
type PriorityLevel = 'none' | 'priority' | 'highest';

interface HallGroup {
  groupId: string | null;
  hallId: string | null;
  hallName: string | null;
  hallColor?: string;
  priority: PriorityLevel;
  items: ShoppingItem[];
}

interface SpaceGroup {
  groupKey: string;
  spaceKey: string;
  displayName: string;
  items: ShoppingItem[];
  isCollapsed: boolean;
  priority: PriorityLevel;
  hallGroupId: string | null;
}

interface ShoppingListProps {
  items: ShoppingItem[];
  onUpdateItem: (item: ShoppingItem) => void;
  onMoveItem: (
    dragId: string,
    hoverId: string,
    targetColumn?: 'execute' | 'candidate',
    sourceColumn?: 'execute' | 'candidate',
  ) => void;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  selectedItemIds: Set<string>;
  onSelectItem: (itemId: string, columnType?: 'execute' | 'candidate') => void;
  onMoveToColumn?: (itemIds: string[]) => void;
  onRemoveFromColumn?: (itemIds: string[]) => void;
  columnType?: 'execute' | 'candidate';
  currentDay?: string;
  onMoveItemUp?: (itemId: string, targetColumn?: 'execute' | 'candidate') => void;
  onMoveItemDown?: (itemId: string, targetColumn?: 'execute' | 'candidate') => void;
  rangeStart?: { itemId: string; columnType: 'execute' | 'candidate' } | null;
  rangeEnd?: { itemId: string; columnType: 'execute' | 'candidate' } | null;
  onToggleRangeSelection?: (columnType: 'execute' | 'candidate') => void;
  duplicateCircleItemIds?: Set<string>;
  highlightedItemId?: string | null;
  layoutMode?: 'pc' | 'smartphone';
  viewMode?: 'edit' | 'execute' | 'focus';
  // ホールグループ化用のprops
  showHallGroups?: boolean;
  hallDefinitions?: HallDefinition[];
  hallOrder?: string[];
  mapData?: DayMapData | null;
  // スペースグループ化用のprops
  showSpaceGroups?: boolean;
  collapsedSpaces?: Set<string>;
  onToggleSpaceCollapse?: (spaceKey: string) => void;
  onToggleAllSpaceCollapse?: (collapse: boolean) => void;
  onSetSpaceGroupDragItemIds?: (itemIds: string[] | null) => void;
  onSelectSpaceGroupForRange?: (firstItemId: string, allItemIds: string[], columnType: 'execute' | 'candidate') => void;
  onAddItem?: (item: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => void;
  // 実行モード用: スペース内一括ステータス変更
  onBulkStatusChange?: (groupKey: string, targetStatus: PurchaseStatus, items: ShoppingItem[]) => void;
  // 実行モード用: スペースグループの表示順序通知
  onSpaceGroupOrderChange?: (orderedGroupKeys: string[]) => void;
  // 実行モード用: 現スペース折りたたみ＋次スペース展開
  onCollapseAndOpenNext?: (currentGroupKey: string) => void;
  // 実行モード用: 最後のスペースグループで「後回しでフィルタ」ボタン表示
  showPostponeFilterButton?: boolean;
  onActivatePostponeFilter?: () => void;
  // 実行モード用: 後回しフィルタ中、最後のスペースグループで「遅参でフィルタ」ボタン表示
  showLateFilterButton?: boolean;
  onActivateLateFilter?: () => void;
}

// グループの表示名を取得
const getGroupDisplayName = (groupId: string | null, hallDefinitions: HallDefinition[]): string => {
  if (groupId === null) return 'ホール未定義';
  if (groupId === 'undefined' ) return 'ホール未定義';
  if (groupId === 'undefined:highest') return 'ホール未定義最優先';
  if (groupId === 'undefined:priority') return 'ホール未定義優先';

  const { hallId, priority } = parseGroupId(groupId);
  const hall = hallDefinitions.find((h) => h.id === hallId);
  const hallName = hall?.name || 'ホール未定義';

  if (priority === 'highest') return `${hallName}最優先`;
  if (priority === 'priority') return `${hallName}優先`;
  return hallName;
};

// グループのヘッダースタイルを取得
const getGroupHeaderStyle = (
  groupId: string | null,
  hallDefinitions: HallDefinition[],
): { bgClass: string; borderColor: string } => {
  const { hallId, priority } = parseGroupId(groupId);
  const hall = hallDefinitions.find((h) => h.id === hallId);
  const baseColor = hall?.color || '#9CA3AF';

  if (priority === 'highest') {
    return { bgClass: 'bg-red-100 dark:bg-red-900/40', borderColor: '#EF4444' };
  }
  if (priority === 'priority') {
    return { bgClass: 'bg-orange-100 dark:bg-orange-900/40', borderColor: '#F97316' };
  }
  return { bgClass: 'bg-slate-100 dark:bg-slate-800', borderColor: baseColor };
};

// Constants for drag-and-drop auto-scrolling
const SCROLL_SPEED = 20;
const TOP_SCROLL_TRIGGER_PX = 150;
const BOTTOM_SCROLL_TRIGGER_PX = 100;

// 色のパレット定義（変更なし）
const colorPalette: Array<{ light: string; dark: string }> = [
  { light: 'bg-red-50 dark:bg-red-950/30', dark: 'bg-red-100 dark:bg-red-900/40' },
  { light: 'bg-blue-50 dark:bg-blue-950/30', dark: 'bg-blue-100 dark:bg-blue-900/40' },
  { light: 'bg-yellow-50 dark:bg-yellow-950/30', dark: 'bg-yellow-100 dark:bg-yellow-900/40' },
  { light: 'bg-purple-50 dark:bg-purple-950/30', dark: 'bg-purple-100 dark:bg-purple-900/40' },
  { light: 'bg-green-50 dark:bg-green-950/30', dark: 'bg-green-100 dark:bg-green-900/40' },
  { light: 'bg-pink-50 dark:bg-pink-950/30', dark: 'bg-pink-100 dark:bg-pink-900/40' },
  { light: 'bg-cyan-50 dark:bg-cyan-950/30', dark: 'bg-cyan-100 dark:bg-cyan-900/40' },
  { light: 'bg-orange-50 dark:bg-orange-950/30', dark: 'bg-orange-100 dark:bg-orange-900/40' },
  { light: 'bg-indigo-50 dark:bg-indigo-950/30', dark: 'bg-indigo-100 dark:bg-indigo-900/40' },
  { light: 'bg-lime-50 dark:bg-lime-950/30', dark: 'bg-lime-100 dark:bg-lime-900/40' },
  { light: 'bg-rose-50 dark:bg-rose-950/30', dark: 'bg-rose-100 dark:bg-rose-900/40' },
  { light: 'bg-sky-50 dark:bg-sky-950/30', dark: 'bg-sky-100 dark:bg-sky-900/40' },
  { light: 'bg-amber-50 dark:bg-amber-950/30', dark: 'bg-amber-100 dark:bg-amber-900/40' },
  { light: 'bg-violet-50 dark:bg-violet-950/30', dark: 'bg-violet-100 dark:bg-violet-900/40' },
  { light: 'bg-emerald-50 dark:bg-emerald-950/30', dark: 'bg-emerald-100 dark:bg-emerald-900/40' },
  { light: 'bg-fuchsia-50 dark:bg-fuchsia-950/30', dark: 'bg-fuchsia-100 dark:bg-fuchsia-900/40' },
  { light: 'bg-teal-50 dark:bg-teal-950/30', dark: 'bg-teal-100 dark:bg-teal-900/40' },
  { light: 'bg-slate-50 dark:bg-slate-950/30', dark: 'bg-slate-100 dark:bg-slate-900/40' },
  { light: 'bg-gray-50 dark:bg-gray-950/30', dark: 'bg-gray-100 dark:bg-gray-900/40' },
  { light: 'bg-stone-50 dark:bg-stone-950/30', dark: 'bg-stone-100 dark:bg-stone-900/40' },
  { light: 'bg-neutral-50 dark:bg-neutral-950/30', dark: 'bg-neutral-100 dark:bg-neutral-900/40' },
  { light: 'bg-zinc-50 dark:bg-zinc-950/30', dark: 'bg-zinc-100 dark:bg-zinc-900/40' },
  { light: 'bg-red-100 dark:bg-red-900/40', dark: 'bg-red-200 dark:bg-red-800/50' },
  { light: 'bg-blue-100 dark:bg-blue-900/40', dark: 'bg-blue-200 dark:bg-blue-800/50' },
  { light: 'bg-yellow-100 dark:bg-yellow-900/40', dark: 'bg-yellow-200 dark:bg-yellow-800/50' },
  { light: 'bg-purple-100 dark:bg-purple-900/40', dark: 'bg-purple-200 dark:bg-purple-800/50' },
  { light: 'bg-green-100 dark:bg-green-900/40', dark: 'bg-green-200 dark:bg-green-800/50' },
  { light: 'bg-pink-100 dark:bg-pink-900/40', dark: 'bg-pink-200 dark:bg-pink-800/50' },
  { light: 'bg-cyan-100 dark:bg-cyan-900/40', dark: 'bg-cyan-200 dark:bg-cyan-800/50' },
  { light: 'bg-orange-100 dark:bg-orange-900/40', dark: 'bg-orange-200 dark:bg-orange-800/50' },
];

// アイテムリストからブロックベースの色情報を計算（変更なし）
const calculateBlockColors = (items: ShoppingItem[]): Map<string, string> => {
  const colorMap = new Map<string, string>();
  const uniqueBlocks = new Set<string>();
  items.forEach((item) => {
    if (item.purchaseStatus === 'None') {
      uniqueBlocks.add(item.block);
    }
  });
  const sortedBlocks = Array.from(uniqueBlocks).sort((a, b) => {
    const numA = Number(a);
    const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    return a.localeCompare(b);
  });
  const blockColorMap = new Map<string, { light: string; dark: string }>();
  sortedBlocks.forEach((block, index) => {
    const colorIndex = index % colorPalette.length;
    blockColorMap.set(block, colorPalette[colorIndex]);
  });
  items.forEach((item, index) => {
    if (item.purchaseStatus === 'None') {
      const block = item.block;
      const blockColor = blockColorMap.get(block);
      if (blockColor) {
        const prevItem = index > 0 ? items[index - 1] : null;
        const isSameBlockAsPrev =
          prevItem && prevItem.block === block && prevItem.purchaseStatus === 'None';
        if (isSameBlockAsPrev) {
          const prevColor = colorMap.get(items[index - 1].id) || '';
          const shouldUseDark = prevColor === blockColor.light;
          colorMap.set(item.id, shouldUseDark ? blockColor.dark : blockColor.light);
        } else {
          colorMap.set(item.id, blockColor.light);
        }
      }
    }
  });
  return colorMap;
};

const ShoppingList: React.FC<ShoppingListProps> = ({
  items,
  onUpdateItem,
  onMoveItem,
  onEditRequest,
  onDeleteRequest,
  selectedItemIds,
  onSelectItem,
  onMoveToColumn: _onMoveToColumn,
  onRemoveFromColumn: _onRemoveFromColumn,
  columnType,
  currentDay,
  onMoveItemUp,
  onMoveItemDown,
  rangeStart,
  rangeEnd,
  onToggleRangeSelection,
  duplicateCircleItemIds = new Set(),
  highlightedItemId = null,
  layoutMode = 'pc',
  viewMode = 'edit',
  showHallGroups = false,
  hallDefinitions = [],
  hallOrder = [],
  mapData = null,
  showSpaceGroups = false,
  collapsedSpaces,
  onToggleSpaceCollapse,
  onToggleAllSpaceCollapse,
  onSetSpaceGroupDragItemIds,
  onSelectSpaceGroupForRange,
  onAddItem,
  onBulkStatusChange,
  onSpaceGroupOrderChange,
  onCollapseAndOpenNext,
  showPostponeFilterButton,
  onActivatePostponeFilter,
  showLateFilterButton,
  onActivateLateFilter,
}) => {
  const dragItem = useRef<string | null>(null);
  const dragSourceColumn = useRef<'execute' | 'candidate' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // タッチドラッグ用state/ref
  const touchDragActive = useRef(false);
  const touchLongPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const touchDragClone = useRef<HTMLElement | null>(null);
  const touchScrollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const touchDragSpaceGroupIds = useRef<string[] | null>(null);
  const touchDragSourceEl = useRef<HTMLElement | null>(null); // ドラッグ元要素（draggable復元用）

  const [activeDropTarget, setActiveDropTarget] = useState<{
    id: string;
    position: 'top' | 'bottom';
  } | null>(null);

  // 備考展開管理（折りたたみヘッダー用）
  const [expandedRemarks, setExpandedRemarks] = useState<Set<string>>(new Set());

  // 価格未定の購入済アイテムの価格欄を強調表示するためのアイテムIDセット
  const [priceHighlightItemIds, setPriceHighlightItemIds] = useState<Set<string>>(new Set());

  // 価格が入力されたアイテムをハイライトセットから自動除外
  useEffect(() => {
    if (priceHighlightItemIds.size === 0) return;
    const remaining = new Set<string>();
    for (const id of priceHighlightItemIds) {
      const item = items.find(i => i.id === id);
      if (item && item.purchaseStatus === 'Purchased' && item.price === null) {
        remaining.add(id);
      }
    }
    if (remaining.size !== priceHighlightItemIds.size) {
      setPriceHighlightItemIds(remaining);
    }
  }, [items, priceHighlightItemIds]);

  // === アイテム追加ダイアログ ===
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogDefaults, setAddDialogDefaults] = useState({ block: '', number: '' });
  const [addDialogCircleSuggestions, setAddDialogCircleSuggestions] = useState<string[]>([]);
  const [newItemForm, setNewItemForm] = useState({
    circle: '',
    title: '',
    price: '',
    quantity: '1',
    remarks: '',
    url: '',
    block: '',
    number: '',
    purchaseStatus: 'None' as 'None' | 'Purchased' | 'Postpone' | 'Late',
  });

  const addFormPriceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);

  const openAddDialog = (block: string, number: string, circleSuggestions: string[] = []) => {
    setAddDialogDefaults({ block, number });
    setAddDialogCircleSuggestions(circleSuggestions);
    setNewItemForm({
      circle: '',
      title: '',
      price: '',
      quantity: '1',
      remarks: '',
      url: '',
      block,
      number,
      purchaseStatus: 'None',
    });
    setAddDialogOpen(true);
  };

  const closeAddDialog = () => {
    setAddDialogOpen(false);
  };

  const handleAddItemSubmit = () => {
    if (!onAddItem || !newItemForm.circle.trim()) return;
    const price = newItemForm.price === '' ? null : parseInt(newItemForm.price, 10) || 0;
    onAddItem({
      eventDate: currentDay || '',
      block: newItemForm.block,
      number: newItemForm.number,
      circle: newItemForm.circle,
      title: newItemForm.title,
      price,
      quantity: parseInt(newItemForm.quantity, 10) || 1,
      remarks: newItemForm.remarks,
      url: newItemForm.url || undefined,
      purchaseStatus: newItemForm.purchaseStatus,
    });
    closeAddDialog();
  };

  const addDialogInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addDialogOpen && addDialogInputRef.current) {
      addDialogInputRef.current.focus({ preventScroll: true });
    }
  }, [addDialogOpen]);

  const formInputClass = 'w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white';
  const labelClass = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1';

  // ホールごとにアイテムをグループ化（優先度対応版）
  const hallGroups = useMemo((): HallGroup[] => {
    if (!showHallGroups) {
      return [{ groupId: null, hallId: null, hallName: null, priority: 'none', items }];
    }
    // ホール定義なしでも groupItemsByHallOrder 内で priority 別に 3 バケットに分けて返す
    return groupItemsByHallOrder(items, mapData, hallDefinitions, hallOrder);
  }, [items, showHallGroups, hallDefinitions, hallOrder, mapData]);

  const blockColorMap = useMemo(() => calculateBlockColors(items), [items]);

  // スペースグループ化（hallOrder + 優先度順に並べ替え後にグループ化）
  const spaceGroups = useMemo((): SpaceGroup[] => {
    if (!showSpaceGroups) return [];

    // hallGroupsと同一の4段階ロジックでアイテムを並べ替え
    // (sortItemsByHallOrder はホール定義 0 件でも未定義+優先度バケットで並べる)
    const sortedItems: ShoppingItem[] = sortItemsByHallOrder(
      items,
      mapData,
      hallDefinitions,
      hallOrder,
    );

    // 並べ替え済みアイテムをスペース+優先度でグループ化
    const groupMap = new Map<string, { spaceKey: string; priority: PriorityLevel; hallGroupId: string | null; items: ShoppingItem[] }>();
    const groupOrder: string[] = [];
    sortedItems.forEach((item) => {
      const spaceKey = getSpaceKey(item.block, item.number);
      const priority = (item.priorityLevel || 'none') as PriorityLevel;
      // 優先度別にグループ化（アイテム単独表示のセクション分割と一致）
      const groupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
      if (!groupMap.has(groupKey)) {
        // 先頭アイテムのhallGroupIdを算出
        const hallId = hallDefinitions.length > 0 && mapData
          ? getHallIdForItem(item, mapData, hallDefinitions)
          : null;
        const hallGroupId = buildGroupId(hallId, priority);
        groupMap.set(groupKey, { spaceKey, priority, hallGroupId, items: [] });
        groupOrder.push(groupKey);
      }
      groupMap.get(groupKey)!.items.push(item);
    });

    return groupOrder.map((groupKey) => {
      const { spaceKey, priority, hallGroupId, items: groupItems } = groupMap.get(groupKey)!;
      return {
        groupKey,
        spaceKey,
        displayName: spaceKey,
        items: groupItems,
        isCollapsed: collapsedSpaces?.has(groupKey) ?? false,
        priority,
        hallGroupId,
      };
    });
  }, [items, showSpaceGroups, collapsedSpaces, hallDefinitions, hallOrder, mapData]);

  // スペースグループの表示順序をApp.tsxに通知
  useEffect(() => {
    if (onSpaceGroupOrderChange && spaceGroups.length > 0) {
      onSpaceGroupOrderChange(spaceGroups.map((g) => g.groupKey));
    }
  }, [spaceGroups, onSpaceGroupOrderChange]);

  // スペースグループのブロック色マップ（グループヘッダー用）
  const spaceGroupBlockColorMap = useMemo(() => {
    if (!showSpaceGroups) return new Map<string, { light: string; dark: string }>();
    const uniqueBlocks = new Set<string>();
    items.forEach((item) => uniqueBlocks.add(item.block));
    const sortedBlocks = Array.from(uniqueBlocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
    const blockColorMapResult = new Map<string, { light: string; dark: string }>();
    sortedBlocks.forEach((block, index) => {
      blockColorMapResult.set(block, colorPalette[index % colorPalette.length]);
    });
    return blockColorMapResult;
  }, [items, showSpaceGroups]);

  // グループ化表示時の範囲選択情報を計算（同一グループ内のみ）
  const groupRangeInfo = useMemo(() => {
    if (
      !showHallGroups ||
      !rangeStart ||
      !rangeEnd ||
      !columnType ||
      rangeStart.columnType !== columnType ||
      rangeEnd.columnType !== columnType
    ) {
      return null;
    }

    // rangeStartとrangeEndのアイテムがどのグループに属するか確認
    let startGroupId: string | null = null;
    let endGroupId: string | null = null;
    let startHallIndex = -1;
    let endHallIndex = -1;

    for (const group of hallGroups) {
      const startIdx = group.items.findIndex((item) => item.id === rangeStart.itemId);
      if (startIdx !== -1) {
        startGroupId = group.groupId;
        startHallIndex = startIdx;
      }
      const endIdx = group.items.findIndex((item) => item.id === rangeEnd.itemId);
      if (endIdx !== -1) {
        endGroupId = group.groupId;
        endHallIndex = endIdx;
      }
    }

    // 異なるグループ間では範囲選択を無効化
    if (startGroupId !== endGroupId || startHallIndex === -1 || endHallIndex === -1) {
      return null;
    }

    const group = hallGroups.find((g) => g.groupId === startGroupId);
    if (!group) return null;

    const minIndex = Math.min(startHallIndex, endHallIndex);
    const maxIndex = Math.max(startHallIndex, endHallIndex);
    const rangeItems = group.items.slice(minIndex, maxIndex + 1);
    const allSelected = rangeItems.every((item) => selectedItemIds.has(item.id));

    const onlyStartEndSelected =
      rangeItems.length > 2 &&
      selectedItemIds.has(rangeItems[0].id) &&
      selectedItemIds.has(rangeItems[rangeItems.length - 1].id) &&
      rangeItems.slice(1, -1).every((item) => !selectedItemIds.has(item.id));

    return {
      groupId: startGroupId,
      startIndex: minIndex,
      endIndex: maxIndex,
      rangeItems,
      allSelected,
      onlyStartEndSelected,
    };
  }, [showHallGroups, rangeStart, rangeEnd, columnType, hallGroups, selectedItemIds]);

  // スペースグループ化表示時の範囲選択情報を計算（同一スペースグループ内のみ）
  const spaceGroupRangeInfo = useMemo(() => {
    if (
      !showSpaceGroups ||
      !rangeStart ||
      !rangeEnd ||
      !columnType ||
      rangeStart.columnType !== columnType ||
      rangeEnd.columnType !== columnType
    ) {
      return null;
    }

    let startGroupKey: string | null = null;
    let endGroupKey: string | null = null;
    let startIdx = -1;
    let endIdx = -1;

    for (const group of spaceGroups) {
      const si = group.items.findIndex((item) => item.id === rangeStart.itemId);
      if (si !== -1) {
        startGroupKey = group.groupKey;
        startIdx = si;
      }
      const ei = group.items.findIndex((item) => item.id === rangeEnd.itemId);
      if (ei !== -1) {
        endGroupKey = group.groupKey;
        endIdx = ei;
      }
    }

    // 異なるスペースグループ間では範囲選択を無効化
    if (startGroupKey !== endGroupKey || startIdx === -1 || endIdx === -1) {
      return null;
    }

    const group = spaceGroups.find((g) => g.groupKey === startGroupKey);
    if (!group) return null;

    const minIndex = Math.min(startIdx, endIdx);
    const maxIndex = Math.max(startIdx, endIdx);
    const rangeItems = group.items.slice(minIndex, maxIndex + 1);
    const allSelected = rangeItems.every((item) => selectedItemIds.has(item.id));

    const onlyStartEndSelected =
      rangeItems.length > 2 &&
      selectedItemIds.has(rangeItems[0].id) &&
      selectedItemIds.has(rangeItems[rangeItems.length - 1].id) &&
      rangeItems.slice(1, -1).every((item) => !selectedItemIds.has(item.id));

    return {
      groupKey: startGroupKey,
      startIndex: minIndex,
      endIndex: maxIndex,
      rangeItems,
      allSelected,
      onlyStartEndSelected,
    };
  }, [showSpaceGroups, rangeStart, rangeEnd, columnType, spaceGroups, selectedItemIds]);

  // クロスグループ範囲選択情報（折りたたみヘッダー間のチェーン表示用）
  const crossSpaceGroupRangeInfo = useMemo(() => {
    if (
      !showSpaceGroups ||
      !rangeStart ||
      !rangeEnd ||
      !columnType ||
      rangeStart.columnType !== columnType ||
      rangeEnd.columnType !== columnType
    ) {
      return null;
    }

    let startGroupIdx = -1;
    let endGroupIdx = -1;

    for (let i = 0; i < spaceGroups.length; i++) {
      if (spaceGroups[i].items.some((item) => item.id === rangeStart.itemId)) startGroupIdx = i;
      if (spaceGroups[i].items.some((item) => item.id === rangeEnd.itemId)) endGroupIdx = i;
    }

    if (startGroupIdx === -1 || endGroupIdx === -1) return null;
    if (startGroupIdx === endGroupIdx) return null; // 同一グループはspaceGroupRangeInfoで処理

    const minIdx = Math.min(startGroupIdx, endGroupIdx);
    const maxIdx = Math.max(startGroupIdx, endGroupIdx);

    // 範囲内の全アイテムが選択済みか
    const rangeGroupItems = spaceGroups
      .slice(minIdx, maxIdx + 1)
      .flatMap((g) => g.items);
    const onlyStartEndSelected =
      rangeGroupItems.length > 2 &&
      selectedItemIds.has(rangeGroupItems[0].id) &&
      selectedItemIds.has(rangeGroupItems[rangeGroupItems.length - 1].id) &&
      rangeGroupItems.slice(1, -1).every((item) => !selectedItemIds.has(item.id));

    return {
      startGroupIndex: minIdx,
      endGroupIndex: maxIdx,
      rangeGroupIndices: Array.from({ length: maxIdx - minIdx + 1 }, (_, i) => minIdx + i),
      onlyStartEndSelected,
    };
  }, [showSpaceGroups, rangeStart, rangeEnd, columnType, spaceGroups, selectedItemIds]);

  // 通常表示時の範囲選択の状態を計算
  const rangeInfo = useMemo(() => {
    if (
      !rangeStart ||
      !rangeEnd ||
      !columnType ||
      rangeStart.columnType !== columnType ||
      rangeEnd.columnType !== columnType
    ) {
      return null;
    }

    const startIndex = items.findIndex((item) => item.id === rangeStart.itemId);
    const endIndex = items.findIndex((item) => item.id === rangeEnd.itemId);

    if (startIndex === -1 || endIndex === -1) return null;

    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    const rangeItems = items.slice(minIndex, maxIndex + 1);
    const allSelected = rangeItems.every((item) => selectedItemIds.has(item.id));

    const onlyStartEndSelected =
      rangeItems.length > 2 &&
      selectedItemIds.has(rangeItems[0].id) &&
      selectedItemIds.has(rangeItems[rangeItems.length - 1].id) &&
      rangeItems.slice(1, -1).every((item) => !selectedItemIds.has(item.id));

    return {
      startIndex: minIndex,
      endIndex: maxIndex,
      rangeItems,
      allSelected,
      onlyStartEndSelected,
    };
  }, [rangeStart, rangeEnd, columnType, items, selectedItemIds]);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    dragItem.current = item.id;
    dragSourceColumn.current = columnType || null;
    if (columnType) {
      e.dataTransfer.setData('sourceColumn', columnType);
    }
    const target = e.currentTarget;
    setTimeout(() => {
      if (target) {
        target.classList.add('opacity-40');
      }
      if (selectedItemIds.has(item.id)) {
        document.querySelectorAll('[data-is-selected="true"]').forEach((el) => {
          el.classList.add('opacity-40');
        });
      }
    }, 0);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    e.preventDefault();
    e.stopPropagation();

    const clientY = e.clientY;
    const windowHeight = window.innerHeight;
    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, -SCROLL_SPEED);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, SCROLL_SPEED);
    }

    const isCrossColumn =
      dragSourceColumn.current !== null && dragSourceColumn.current !== columnType;

    if (!isCrossColumn) {
      if (dragItem.current === item.id && selectedItemIds.size === 0) {
        setActiveDropTarget(null);
        return;
      }
      if (selectedItemIds.has(item.id) && selectedItemIds.has(dragItem.current || '')) {
        setActiveDropTarget(null);
        return;
      }
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const position = relativeY < rect.height / 2 ? 'top' : 'bottom';

    setActiveDropTarget({ id: item.id, position });
  };

  const handleContainerDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const sourceColumn = e.dataTransfer.getData('sourceColumn') as
      | 'execute'
      | 'candidate'
      | undefined;

    if (!columnType || !dragItem.current) {
      cleanUp();
      return;
    }

    if (sourceColumn && sourceColumn === columnType) {
      if (!activeDropTarget) {
        cleanUp();
        return;
      }
    } else if (sourceColumn && sourceColumn !== columnType) {
      // Allow cross-column drop
    } else {
      cleanUp();
      return;
    }

    if (!activeDropTarget) {
      if (sourceColumn && sourceColumn !== columnType) {
        onMoveItem(dragItem.current, '__END_OF_LIST__', columnType, sourceColumn);
        cleanUp();
        return;
      }
      cleanUp();
      return;
    }

    const { id: targetId, position } = activeDropTarget;

    if (dragItem.current === targetId && sourceColumn === columnType) {
      cleanUp();
      return;
    }

    if (position === 'top') {
      onMoveItem(dragItem.current, targetId, columnType, sourceColumn);
    } else {
      const targetIndex = items.findIndex((i) => i.id === targetId);
      if (targetIndex === -1) {
        cleanUp();
        return;
      }

      if (targetIndex === items.length - 1) {
        onMoveItem(dragItem.current, '__END_OF_LIST__', columnType, sourceColumn);
      } else {
        const nextItem = items[targetIndex + 1];
        onMoveItem(dragItem.current, nextItem.id, columnType, sourceColumn);
      }
    }

    cleanUp();
  };

  const cleanUp = () => {
    document.querySelectorAll('.opacity-40').forEach((el) => el.classList.remove('opacity-40'));
    dragItem.current = null;
    dragSourceColumn.current = null;
    setActiveDropTarget(null);
  };

  // === タッチドラッグ&ドロップ ===
  const TOUCH_LONG_PRESS_MS = 200;
  const TOUCH_MOVE_THRESHOLD = 5; // px — 指の微小な揺れを無視

  const touchCleanUp = useCallback(() => {
    if (touchLongPressTimer.current) {
      clearTimeout(touchLongPressTimer.current);
      touchLongPressTimer.current = null;
    }
    if (touchScrollInterval.current) {
      clearInterval(touchScrollInterval.current);
      touchScrollInterval.current = null;
    }
    if (touchDragClone.current) {
      touchDragClone.current.remove();
      touchDragClone.current = null;
    }
    // draggable属性を復元
    if (touchDragSourceEl.current) {
      touchDragSourceEl.current.setAttribute('draggable', 'true');
      touchDragSourceEl.current = null;
    }
    if (touchDragSpaceGroupIds.current && onSetSpaceGroupDragItemIds) {
      onSetSpaceGroupDragItemIds(null);
    }
    touchDragSpaceGroupIds.current = null;
    touchDragActive.current = false;
    document.body.style.overflow = '';
    cleanUp();
  }, [onSetSpaceGroupDragItemIds]);

  // クリーンアップ: コンポーネントアンマウント時
  useEffect(() => {
    return () => {
      if (touchLongPressTimer.current) clearTimeout(touchLongPressTimer.current);
      if (touchScrollInterval.current) clearInterval(touchScrollInterval.current);
      if (touchDragClone.current) touchDragClone.current.remove();
      if (touchDragSourceEl.current) touchDragSourceEl.current.setAttribute('draggable', 'true');
    };
  }, []);

  const createDragClone = useCallback((sourceEl: HTMLElement, touchX: number, touchY: number) => {
    const rect = sourceEl.getBoundingClientRect();
    const clone = sourceEl.cloneNode(true) as HTMLElement;
    clone.style.position = 'fixed';
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${touchY - 20}px`;
    clone.style.width = `${rect.width}px`;
    clone.style.opacity = '0.8';
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    clone.style.transform = 'scale(0.95)';
    clone.style.boxShadow = '0 8px 25px rgba(0,0,0,0.3)';
    clone.style.borderRadius = '8px';
    clone.style.transition = 'none';
    document.body.appendChild(clone);
    return clone;
  }, []);

  const handleTouchDragStart = useCallback((itemId: string, sourceEl: HTMLElement, touchX: number, touchY: number, spaceGroupItemIds?: string[]) => {
    touchDragActive.current = true;
    dragItem.current = itemId;
    dragSourceColumn.current = columnType || null;

    // ブラウザのネイティブドラッグゴーストを防止
    sourceEl.setAttribute('draggable', 'false');
    touchDragSourceEl.current = sourceEl;

    // 元の要素を半透明に
    sourceEl.classList.add('opacity-40');
    if (selectedItemIds.has(itemId)) {
      document.querySelectorAll('[data-is-selected="true"]').forEach((el) => {
        el.classList.add('opacity-40');
      });
    }

    // スペースグループドラッグの場合
    if (spaceGroupItemIds && onSetSpaceGroupDragItemIds) {
      touchDragSpaceGroupIds.current = spaceGroupItemIds;
      onSetSpaceGroupDragItemIds(spaceGroupItemIds);
    }

    // ドラッグクローン作成
    touchDragClone.current = createDragClone(sourceEl, touchX, touchY);

    // スクロール防止
    document.body.style.overflow = 'hidden';

    // 触覚フィードバック
    if (navigator.vibrate) navigator.vibrate(30);
  }, [columnType, selectedItemIds, createDragClone, onSetSpaceGroupDragItemIds]);

  const handleItemTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>, item: ShoppingItem) => {
    // data-no-long-press属性がある要素からのタッチは無視（チェックボックス、ボタン等）
    const target = e.target as HTMLElement;
    if (target.closest('[data-no-long-press]')) return;

    const touch = e.touches[0];
    touchStartX.current = touch.clientX;
    touchStartY.current = touch.clientY;

    const el = e.currentTarget;
    touchLongPressTimer.current = setTimeout(() => {
      handleTouchDragStart(item.id, el, touch.clientX, touch.clientY);
    }, TOUCH_LONG_PRESS_MS);
  }, [handleTouchDragStart]);

  const handleItemTouchMove = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const touch = e.touches[0];

    // ロングプレス判定中に指が動いたらキャンセル（通常スクロール）
    if (!touchDragActive.current) {
      const dx = Math.abs(touch.clientX - touchStartX.current);
      const dy = Math.abs(touch.clientY - touchStartY.current);
      if (dx > TOUCH_MOVE_THRESHOLD || dy > TOUCH_MOVE_THRESHOLD) {
        if (touchLongPressTimer.current) {
          clearTimeout(touchLongPressTimer.current);
          touchLongPressTimer.current = null;
        }
      }
      return;
    }

    e.preventDefault(); // ドラッグ中はスクロール防止

    // クローンを指の位置に追従
    if (touchDragClone.current) {
      touchDragClone.current.style.top = `${touch.clientY - 20}px`;
    }

    // 自動スクロール
    const clientY = touch.clientY;
    const windowHeight = window.innerHeight;
    if (touchScrollInterval.current) {
      clearInterval(touchScrollInterval.current);
      touchScrollInterval.current = null;
    }
    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      touchScrollInterval.current = setInterval(() => window.scrollBy(0, -SCROLL_SPEED), 16);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      touchScrollInterval.current = setInterval(() => window.scrollBy(0, SCROLL_SPEED), 16);
    }

    // ドロップターゲット判定: 指の下にあるアイテムを探す
    // クローンを一時的に非表示にしてelementFromPointを使う
    if (touchDragClone.current) touchDragClone.current.style.display = 'none';
    const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY);
    if (touchDragClone.current) touchDragClone.current.style.display = '';

    if (elementUnder) {
      const itemEl = elementUnder.closest('[data-item-id]') as HTMLElement | null;
      if (itemEl) {
        const targetId = itemEl.getAttribute('data-item-id');
        if (targetId && targetId !== dragItem.current) {
          const rect = itemEl.getBoundingClientRect();
          const relativeY = touch.clientY - rect.top;
          const position = relativeY < rect.height / 2 ? 'top' : 'bottom';
          setActiveDropTarget({ id: targetId, position });
        }
      } else {
        // アイテム上でない場合はドロップターゲットをクリア
        setActiveDropTarget(null);
      }
    }
  }, []);

  const handleItemTouchEnd = useCallback(() => {
    // ロングプレスタイマーをクリア
    if (touchLongPressTimer.current) {
      clearTimeout(touchLongPressTimer.current);
      touchLongPressTimer.current = null;
    }

    if (!touchDragActive.current) return;

    // ドロップ実行
    if (activeDropTarget && dragItem.current && columnType) {
      const sourceColumn = dragSourceColumn.current;
      const { id: targetId, position } = activeDropTarget;

      if (dragItem.current !== targetId || sourceColumn !== columnType) {
        if (position === 'top') {
          onMoveItem(dragItem.current, targetId, columnType, sourceColumn || undefined);
        } else {
          const targetIndex = items.findIndex((i) => i.id === targetId);
          if (targetIndex !== -1) {
            if (targetIndex === items.length - 1) {
              onMoveItem(dragItem.current, '__END_OF_LIST__', columnType, sourceColumn || undefined);
            } else {
              const nextItem = items[targetIndex + 1];
              onMoveItem(dragItem.current, nextItem.id, columnType, sourceColumn || undefined);
            }
          }
        }
      }
    }

    touchCleanUp();
  }, [activeDropTarget, columnType, items, onMoveItem, touchCleanUp]);

  // タッチキャンセル時（ブラウザがタッチを横取り、通知表示等）
  const handleItemTouchCancel = useCallback(() => {
    touchCleanUp();
  }, [touchCleanUp]);

  // グローバルなタッチ終了/キャンセル監視（要素外でタッチが離された場合の保険）
  useEffect(() => {
    const handleGlobalTouchEnd = () => {
      if (touchDragActive.current) {
        touchCleanUp();
      }
    };
    document.addEventListener('touchend', handleGlobalTouchEnd);
    document.addEventListener('touchcancel', handleGlobalTouchEnd);
    return () => {
      document.removeEventListener('touchend', handleGlobalTouchEnd);
      document.removeEventListener('touchcancel', handleGlobalTouchEnd);
    };
  }, [touchCleanUp]);

  if (items.length === 0) {
    return (
      <div
        className="text-center text-slate-500 dark:text-slate-400 py-12 min-h-[200px] border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg relative"
        onDragOver={handleContainerDragOver}
        onDrop={handleDrop}
      >
        この日のアイテムはありません。
      </div>
    );
  }

  // スペースグループ化表示
  if (showSpaceGroups && spaceGroups.length > 0) {
    // チェーン選択済みの全アイテムIDを収集（折りたたみグループのドラッグ・移動用）
    const getEffectiveDragIds = (group: SpaceGroup): string[] => {
      const groupIds = new Set(group.items.map((item) => item.id));
      const isGroupInSelection = group.items.some((item) => selectedItemIds.has(item.id));
      if (isGroupInSelection && selectedItemIds.size > groupIds.size) {
        // 選択中のアイテムがこのグループ以外にもある→チェーン選択されたアイテム全て含める
        return Array.from(selectedItemIds);
      }
      return group.items.map((item) => item.id);
    };

    const handleSpaceGroupDragStart = (
      e: React.DragEvent<HTMLDivElement>,
      group: SpaceGroup,
    ) => {
      const firstItemId = group.items[0]?.id;
      if (!firstItemId) return;
      dragItem.current = firstItemId;
      dragSourceColumn.current = columnType || null;
      if (columnType) {
        e.dataTransfer.setData('sourceColumn', columnType);
      }
      if (onSetSpaceGroupDragItemIds) {
        onSetSpaceGroupDragItemIds(getEffectiveDragIds(group));
      }
      const target = e.currentTarget;
      setTimeout(() => {
        if (target) target.classList.add('opacity-40');
      }, 0);
    };

    const handleSpaceGroupDragEnd = () => {
      if (onSetSpaceGroupDragItemIds) {
        onSetSpaceGroupDragItemIds(null);
      }
      cleanUp();
    };

    const allCollapsed = spaceGroups.length > 0 && spaceGroups.every((g) => g.isCollapsed);

    return (
      <div
        ref={containerRef}
        className="space-y-1 relative"
        style={{ paddingBottom: 'var(--footer-height, 96px)' }}
        onDragOver={handleContainerDragOver}
        onDrop={handleDrop}
        onDragLeave={() => setActiveDropTarget(null)}
      >
        {/* 全スペース開閉ボタン */}
        {onToggleAllSpaceCollapse && (
          <div className="flex justify-end mb-1">
            <button
              onClick={() => onToggleAllSpaceCollapse(!allCollapsed)}
              className="text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
            >
              {allCollapsed ? '全て展開' : '全て折りたたむ'}
            </button>
          </div>
        )}

        {(() => {
          const hasPriorityGroups = spaceGroups.some(g => g.priority !== 'none');
          return spaceGroups.map((group, groupIndex) => {
          // ホール+優先度セクションヘッダー（アイテム単独表示のセクションヘッダーと同等）
          const prevHallGroupId = groupIndex > 0 ? spaceGroups[groupIndex - 1].hallGroupId : undefined;
          const showHallSectionHeader =
            group.hallGroupId !== prevHallGroupId &&
            (hallDefinitions.length > 0 || hasPriorityGroups);
          const hallSectionHeader = showHallSectionHeader ? (() => {
            const headerStyle = getGroupHeaderStyle(group.hallGroupId, hallDefinitions);
            const displayName = getGroupDisplayName(group.hallGroupId, hallDefinitions);
            // このセクション内のアイテム数を算出
            let sectionItemCount = 0;
            for (let i = groupIndex; i < spaceGroups.length; i++) {
              if (i > groupIndex && spaceGroups[i].hallGroupId !== group.hallGroupId) break;
              sectionItemCount += spaceGroups[i].items.length;
            }
            return (
              <div
                className={`sticky top-0 z-30 flex items-center justify-between px-4 py-2 rounded-t-lg ${headerStyle.bgClass} ${groupIndex > 0 ? 'mt-3' : ''}`}
                style={{ borderLeft: `4px solid ${headerStyle.borderColor}` }}
              >
                <span className="font-bold text-sm text-slate-700 dark:text-slate-300">
                  {displayName}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {sectionItemCount}件
                </span>
              </div>
            );
          })() : null;

          const block = group.spaceKey.split('-')[0];
          const blockColor = spaceGroupBlockColorMap.get(block);

          // このスペースの全アイテムがチェックされているか
          const allItemsSelected =
            group.items.length > 0 && group.items.every((item) => selectedItemIds.has(item.id));
          const someItemsSelected =
            !allItemsSelected && group.items.some((item) => selectedItemIds.has(item.id));

          // 合計金額
          const totalPrice = group.items.reduce(
            (sum, item) => sum + (item.price ?? 0) * (item.quantity || 1),
            0,
          );

          // 上下移動の可否
          const canMoveGroupUp = groupIndex > 0;
          const canMoveGroupDown = groupIndex < spaceGroups.length - 1;

          // スペースグループのチェックボックスクリック
          const handleSpaceCheckbox = (e: React.MouseEvent | React.ChangeEvent) => {
            e.stopPropagation();
            const groupItemIds = group.items.map((item) => item.id);
            // 折りたたみ時は範囲選択対応のハンドラーを使用
            if (group.isCollapsed && onSelectSpaceGroupForRange && columnType) {
              onSelectSpaceGroupForRange(group.items[0].id, groupItemIds, columnType);
              return;
            }
            if (allItemsSelected) {
              // 全解除
              groupItemIds.forEach((id) => onSelectItem(id, columnType));
            } else {
              // 未選択のものを全て選択
              groupItemIds.forEach((id) => {
                if (!selectedItemIds.has(id)) {
                  onSelectItem(id, columnType);
                }
              });
            }
          };

          // スペースグループ上移動
          const handleSpaceGroupMoveUp = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!canMoveGroupUp || !onMoveItemUp) return;
            const effectiveIds = getEffectiveDragIds(group);
            if (onSetSpaceGroupDragItemIds) {
              onSetSpaceGroupDragItemIds(effectiveIds);
            }
            // 先頭アイテムを上に移動（グループ全体が移動する）
            onMoveItemUp(group.items[0].id, columnType);
            if (onSetSpaceGroupDragItemIds) {
              onSetSpaceGroupDragItemIds(null);
            }
          };

          // スペースグループ下移動
          const handleSpaceGroupMoveDown = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (!canMoveGroupDown || !onMoveItemDown) return;
            const effectiveIds = getEffectiveDragIds(group);
            if (onSetSpaceGroupDragItemIds) {
              onSetSpaceGroupDragItemIds(effectiveIds);
            }
            // 末尾アイテムを下に移動（グループ全体が移動する）
            onMoveItemDown(group.items[group.items.length - 1].id, columnType);
            if (onSetSpaceGroupDragItemIds) {
              onSetSpaceGroupDragItemIds(null);
            }
          };

          // クロスグループチェーン表示情報
          const crossRangeInGroup = crossSpaceGroupRangeInfo &&
            crossSpaceGroupRangeInfo.rangeGroupIndices.includes(groupIndex);
          const isCrossStart = crossSpaceGroupRangeInfo &&
            groupIndex === crossSpaceGroupRangeInfo.startGroupIndex;
          const isCrossEnd = crossSpaceGroupRangeInfo &&
            groupIndex === crossSpaceGroupRangeInfo.endGroupIndex;
          const isCrossMiddle = crossRangeInGroup && !isCrossStart && !isCrossEnd;

          // ドロップガイド表示判定
          const showDropGuide = group.isCollapsed &&
            activeDropTarget?.id === group.items[0]?.id &&
            activeDropTarget?.position === 'top';

          return (
            <React.Fragment key={group.groupKey}>
              {hallSectionHeader}
            <div className="mb-1 relative">
              {/* ドロップ位置ガイド */}
              {showDropGuide && (
                <div className="absolute -top-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                  <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                  <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                  <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
                </div>
              )}
              {/* スペースグループヘッダー */}
              <div
                className={`sticky top-0 z-20 rounded-lg select-none cursor-pointer ${
                  blockColor?.light || 'bg-slate-100 dark:bg-slate-800'
                } hover:brightness-95 dark:hover:brightness-110 transition-all ${
                  layoutMode === 'smartphone' && group.isCollapsed && viewMode !== 'execute' ? 'flex flex-col' : 'flex items-center'
                }`}
                style={{ borderLeft: '4px solid #9CA3AF' }}
                onClick={() => onToggleSpaceCollapse?.(group.groupKey)}
                data-item-id={group.isCollapsed ? group.items[0]?.id : undefined}
                data-space-group-key={group.groupKey}
                draggable={viewMode !== 'execute' && group.isCollapsed}
                onDragStart={
                  viewMode !== 'execute' && group.isCollapsed
                    ? (e) => handleSpaceGroupDragStart(e, group)
                    : undefined
                }
                onDragOver={viewMode !== 'execute' ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const firstItem = group.items[0];
                  if (firstItem) {
                    setActiveDropTarget({ id: firstItem.id, position: 'top' });
                  }
                } : undefined}
                onDrop={viewMode !== 'execute' ? handleDrop : undefined}
                onDragEnd={viewMode !== 'execute' && group.isCollapsed ? handleSpaceGroupDragEnd : undefined}
                onTouchStart={viewMode !== 'execute' && group.isCollapsed ? (e: React.TouchEvent<HTMLDivElement>) => {
                  const target = e.target as HTMLElement;
                  if (target.closest('[data-no-long-press]')) return;
                  const touch = e.touches[0];
                  touchStartX.current = touch.clientX;
                  touchStartY.current = touch.clientY;
                  const el = e.currentTarget;
                  const firstItemId = group.items[0]?.id;
                  if (!firstItemId) return;
                  const effectiveIds = getEffectiveDragIds(group);
                  touchLongPressTimer.current = setTimeout(() => {
                    handleTouchDragStart(firstItemId, el, touch.clientX, touch.clientY, effectiveIds);
                  }, TOUCH_LONG_PRESS_MS);
                } : undefined}
                onTouchMove={viewMode !== 'execute' && group.isCollapsed ? handleItemTouchMove : undefined}
                onTouchEnd={viewMode !== 'execute' && group.isCollapsed ? handleItemTouchEnd : undefined}
                onTouchCancel={viewMode !== 'execute' && group.isCollapsed ? handleItemTouchCancel : undefined}
              >
                {/* 折りたたみ時：編集モード＝チェックボックス+ドラッグハンドル+上下ボタン / 実行モード＝なし（サマリーはメインエリア右側に表示） */}
                {group.isCollapsed && viewMode !== 'execute' && (
                  <div
                    data-drag-handle
                    className={`flex flex-row items-center cursor-grab text-slate-400 dark:text-slate-500 ${
                      layoutMode === 'smartphone'
                        ? 'px-1 py-0.5 gap-0.5 border-b border-slate-200/80 dark:border-slate-700/80'
                        : 'px-1.5 py-1 gap-1 border-r border-slate-200/80 dark:border-slate-700/80'
                    }`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={allItemsSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someItemsSelected;
                      }}
                      onChange={handleSpaceCheckbox}
                      onClick={(e) => e.stopPropagation()}
                      data-no-long-press
                      className={`rounded text-blue-600 focus:ring-blue-500 ${
                        layoutMode === 'smartphone' ? 'w-4 h-4' : 'w-5 h-5'
                      }`}
                    />
                    {onMoveItemUp && (
                      <button
                        onClick={handleSpaceGroupMoveUp}
                        disabled={!canMoveGroupUp}
                        data-no-long-press
                        className={`p-0.5 rounded-md transition-colors ${canMoveGroupUp ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'}`}
                        aria-label="グループを上に移動"
                      >
                        <ChevronUpIcon className={layoutMode === 'smartphone' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                      </button>
                    )}
                    <GripVerticalIcon className={layoutMode === 'smartphone' ? 'w-4 h-4 mx-1' : 'w-5 h-5'} />
                    {onMoveItemDown && (
                      <button
                        onClick={handleSpaceGroupMoveDown}
                        disabled={!canMoveGroupDown}
                        data-no-long-press
                        className={`p-0.5 rounded-md transition-colors ${canMoveGroupDown ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'}`}
                        aria-label="グループを下に移動"
                      >
                        <ChevronDownIcon className={layoutMode === 'smartphone' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
                      </button>
                    )}
                    {/* スマホ時：追加ボタンをコントロールバー右端に配置 */}
                    {layoutMode === 'smartphone' && onAddItem && (
                      <>
                        <div className="flex-1" />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const spaceBlock = group.spaceKey.split('-')[0];
                            const spaceNumber = group.spaceKey.split('-').slice(1).join('-');
                            const circles = [...new Set(group.items.map((item) => item.circle).filter(Boolean))];
                            openAddDialog(spaceBlock, spaceNumber, circles);
                          }}
                          className="px-1.5 py-0.5 mr-1 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 rounded transition-colors"
                          title="このスペースにアイテムを追加"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                )}

                {/* メインのクリック可能エリア */}
                <div
                  className={`flex-1 flex flex-col min-w-0 ${
                    layoutMode === 'smartphone' ? 'px-2 py-1' : 'px-3 py-1.5'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className={`flex items-center min-w-0 ${layoutMode === 'smartphone' ? 'gap-1' : 'gap-2'}`}>
                      <span
                        className={`text-xs transition-transform duration-200 flex-shrink-0 ${
                          group.isCollapsed ? '' : 'rotate-90'
                        }`}
                      >
                        &#9654;
                      </span>
                      <span className={`font-bold text-slate-700 dark:text-slate-300 flex-shrink-0 ${
                        layoutMode === 'smartphone' ? 'text-xs' : 'text-sm'
                      }`}>
                        {group.displayName}
                      </span>
                      {(() => {
                        const uniqueCircles = [...new Set(group.items.map((item) => item.circle).filter(Boolean))];
                        if (uniqueCircles.length === 0) return null;
                        const displayText = layoutMode === 'smartphone'
                          ? uniqueCircles.map(c => c.length > 6 ? c.slice(0, 6) + '…' : c).join(' & ')
                          : uniqueCircles.join(' & ');
                        return (
                          <span className={`font-bold text-slate-700 dark:text-slate-300 truncate ${
                            layoutMode === 'smartphone' ? 'text-xs' : 'text-sm'
                          }`} title={uniqueCircles.join(' & ')}>
                            {displayText}
                          </span>
                        );
                      })()}
                    </div>
                    <div className={`flex items-center flex-shrink-0 ${layoutMode === 'smartphone' ? 'gap-1' : 'gap-2'}`}>
                      {/* スマホ折りたたみ時：備考を💬/⚠️アイコンで表示 */}
                      {layoutMode === 'smartphone' && group.isCollapsed && (() => {
                        const remarksItems = group.items.filter((item) => item.remarks);
                        if (remarksItems.length === 0) return null;
                        const hasWarningRemarks = remarksItems.some((item) =>
                          item.remarks.includes('委託無') || item.remarks.includes('優先')
                        );
                        const isExpanded = expandedRemarks.has(group.groupKey);
                        return (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedRemarks((prev) => {
                                const next = new Set(prev);
                                if (next.has(group.groupKey)) {
                                  next.delete(group.groupKey);
                                } else {
                                  next.add(group.groupKey);
                                }
                                return next;
                              });
                            }}
                            className={`text-sm leading-none p-0.5 rounded hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors ${isExpanded ? 'bg-slate-200 dark:bg-slate-700' : ''}`}
                            title="備考を表示"
                          >
                            {hasWarningRemarks ? '⚠️' : '💬'}
                          </button>
                        );
                      })()}
                      {/* 実行モード折りたたみ時：購入状態サマリー（色付き） */}
                      {viewMode === 'execute' && group.isCollapsed && (() => {
                        const statusColorMap: Record<string, string> = {
                          None: 'text-red-600 dark:text-red-400 font-bold',
                          Purchased: 'text-green-600 dark:text-green-400',
                          SoldOut: 'text-red-600 dark:text-red-400',
                          Postpone: 'text-purple-600 dark:text-purple-400',
                          Late: 'text-blue-600 dark:text-blue-400',
                          LimitedPurchase: 'text-orange-600 dark:text-orange-400',
                          Absent: 'text-yellow-600 dark:text-yellow-400',
                        };
                        const statusAbbrevMap: [string, string][] = [
                          ['None', '未'], ['Purchased', '購'], ['SoldOut', '売'],
                          ['Postpone', '後'], ['Late', '遅'], ['LimitedPurchase', '限'], ['Absent', '欠'],
                        ];
                        const counts = new Map<string, number>();
                        group.items.forEach((item) => {
                          counts.set(item.purchaseStatus, (counts.get(item.purchaseStatus) || 0) + 1);
                        });
                        const entries = statusAbbrevMap.filter(([s]) => (counts.get(s) || 0) > 0);
                        if (entries.length === 0) return null;
                        return (
                          <span className={`flex items-center ${layoutMode === 'smartphone' ? 'gap-0.5' : 'gap-1'}`}>
                            {entries.map(([status, abbrev]) => (
                              <span key={status} className={`font-medium ${statusColorMap[status]} ${
                                layoutMode === 'smartphone' ? 'text-[10px]' : 'text-xs'
                              }`}>
                                {abbrev}{counts.get(status)}
                              </span>
                            ))}
                          </span>
                        );
                      })()}
                      {/* 件数表示（全モード共通） */}
                      <span className={`text-slate-500 dark:text-slate-400 ${
                        layoutMode === 'smartphone' ? 'text-[10px]' : 'text-xs'
                      }`}>
                        {group.items.length}件
                      </span>
                      {group.isCollapsed && viewMode !== 'execute' && (() => {
                        const allPriceNull = group.items.every((item) => item.price == null);
                        if (allPriceNull) {
                          return (
                            <span className={`font-medium text-slate-500 dark:text-slate-400 ${
                              layoutMode === 'smartphone' ? 'text-[10px]' : 'text-xs'
                            }`}>
                              価格未定
                            </span>
                          );
                        }
                        return (
                          <span className={`font-medium text-slate-600 dark:text-slate-300 ${
                            layoutMode === 'smartphone' ? 'text-[10px]' : 'text-xs'
                          }`}>
                            {totalPrice.toLocaleString()}円
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                  {/* 折りたたみ時の備考表示 */}
                  {group.isCollapsed && (() => {
                    // スマホ時：💬/⚠️クリックで展開表示
                    if (layoutMode === 'smartphone') {
                      if (!expandedRemarks.has(group.groupKey)) return null;
                      const remarksItems = group.items.filter((item) => item.remarks);
                      if (remarksItems.length === 0) return null;
                      return (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {remarksItems.map((item) => (
                            <span
                              key={item.id}
                              className={`text-[10px] px-1 py-0.5 rounded bg-slate-200/60 dark:bg-slate-700/60 ${
                                item.remarks.includes('委託無') || item.remarks.includes('優先')
                                  ? 'text-red-600 dark:text-red-400 font-medium'
                                  : 'text-slate-600 dark:text-slate-400'
                              }`}
                            >
                              {item.remarks}
                            </span>
                          ))}
                        </div>
                      );
                    }
                    // PC時：従来の備考表示
                    const remarksItems = group.items.filter((item) => item.remarks);
                    if (remarksItems.length === 0) return null;
                    return (
                      <div className="flex flex-wrap gap-1 mt-0.5 ml-4">
                        {remarksItems.map((item) => {
                          const isExpanded = expandedRemarks.has(item.id);
                          const text = item.remarks;
                          const needsTruncate = text.length >= 5;
                          const displayText = needsTruncate && !isExpanded
                            ? text.slice(0, 4) + '...'
                            : text;
                          return (
                            <span
                              key={item.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (needsTruncate) {
                                  setExpandedRemarks((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(item.id)) {
                                      next.delete(item.id);
                                    } else {
                                      next.add(item.id);
                                    }
                                    return next;
                                  });
                                }
                              }}
                              className={`text-xs px-1 py-0.5 rounded bg-slate-200/60 dark:bg-slate-700/60 text-slate-600 dark:text-slate-400 ${needsTruncate ? 'cursor-pointer hover:bg-slate-300 dark:hover:bg-slate-600' : ''}`}
                            >
                              {displayText}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {/* 実行モード展開時：一括ステータス変更ボタン */}
                  {viewMode === 'execute' && !group.isCollapsed && onBulkStatusChange && (
                    <div className={`flex flex-wrap justify-end gap-1 ${layoutMode === 'smartphone' ? 'mt-0.5' : 'mt-1 ml-4'}`}>
                      {([
                        { status: 'Purchased' as PurchaseStatus, label: '全購入', activeColor: 'bg-green-600 text-white dark:bg-green-500', hoverColor: 'hover:bg-green-100 dark:hover:bg-green-900/30' },
                        { status: 'SoldOut' as PurchaseStatus, label: '全売切', activeColor: 'bg-red-600 text-white dark:bg-red-500', hoverColor: 'hover:bg-red-100 dark:hover:bg-red-900/30' },
                        { status: 'Postpone' as PurchaseStatus, label: '全後回', activeColor: 'bg-purple-600 text-white dark:bg-purple-500', hoverColor: 'hover:bg-purple-100 dark:hover:bg-purple-900/30' },
                        { status: 'Late' as PurchaseStatus, label: '全遅参', activeColor: 'bg-blue-600 text-white dark:bg-blue-500', hoverColor: 'hover:bg-blue-100 dark:hover:bg-blue-900/30' },
                      ]).map(({ status, label, activeColor, hoverColor }) => {
                        const allMatch = group.items.every((item) => item.purchaseStatus === status);
                        return (
                          <button
                            key={status}
                            onClick={(e) => { e.stopPropagation(); onBulkStatusChange(group.groupKey, status, group.items); }}
                            className={`${layoutMode === 'smartphone' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'} font-medium rounded transition-colors ${
                              allMatch
                                ? activeColor
                                : `bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-300 dark:border-slate-600 ${hoverColor}`
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {/* アイテム追加ボタン（編集モードPC時・実行モード時はここに配置、編集モードスマホ折りたたみ時はコントロールバーに移動済み） */}
                {!(viewMode !== 'execute' && layoutMode === 'smartphone' && group.isCollapsed) && onAddItem && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const spaceBlock = group.spaceKey.split('-')[0];
                      const spaceNumber = group.spaceKey.split('-').slice(1).join('-');
                      const circles = [...new Set(group.items.map((item) => item.circle).filter(Boolean))];
                      openAddDialog(spaceBlock, spaceNumber, circles);
                    }}
                    className={`text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30 rounded transition-colors ${
                      layoutMode === 'smartphone' ? 'px-1.5 py-0.5 mr-1' : 'px-2 py-1 mr-2'
                    }`}
                    title="このスペースにアイテムを追加"
                  >
                    <svg className={layoutMode === 'smartphone' ? 'w-4 h-4' : 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                )}
              </div>

              {/* クロスグループチェーンUI（折りたたみヘッダー間） */}
              {crossRangeInGroup && onToggleRangeSelection && (
                <div
                  className={`absolute top-0 bottom-0 z-40 ${
                    columnType === 'candidate' ? 'left-0' : 'right-0'
                  } cursor-pointer ${
                    crossSpaceGroupRangeInfo!.onlyStartEndSelected
                      ? 'opacity-50 hover:opacity-100'
                      : 'opacity-100'
                  }`}
                  style={{ width: '40px' }}
                  onClick={() => onToggleRangeSelection(columnType!)}
                >
                  <svg
                    className="absolute w-full h-full"
                    style={{
                      [columnType === 'candidate' ? 'left' : 'right']: '-42px',
                    }}
                    preserveAspectRatio="none"
                  >
                    <defs>
                      <linearGradient
                        id={`chainMetal-cross-${group.groupKey}`}
                        x1="0%" y1="0%" x2="100%" y2="0%"
                      >
                        <stop offset="0%" stopColor="#9CA3AF" />
                        <stop offset="50%" stopColor="#D1D5DB" />
                        <stop offset="100%" stopColor="#9CA3AF" />
                      </linearGradient>
                      <pattern
                        id={`chainPattern-cross-${group.groupKey}`}
                        x="0" y="0" width="40" height="20"
                        patternUnits="userSpaceOnUse"
                      >
                        <rect x="14" y="-2" width="12" height="18" rx="6"
                          fill="none"
                          stroke={`url(#chainMetal-cross-${group.groupKey})`}
                          strokeWidth="3"
                        />
                        <rect x="17" y="13" width="6" height="8" rx="2"
                          fill={`url(#chainMetal-cross-${group.groupKey})`}
                          stroke="#4B5563" strokeWidth="0.5"
                        />
                      </pattern>
                    </defs>

                    {isCrossStart && (
                      <rect x="0" y="50%" width="40" height="50%"
                        fill={`url(#chainPattern-cross-${group.groupKey})`}
                      />
                    )}
                    {isCrossEnd && (
                      <rect x="0" y="0" width="40" height="50%"
                        fill={`url(#chainPattern-cross-${group.groupKey})`}
                      />
                    )}
                    {isCrossMiddle && (
                      <rect x="0" y="0" width="40" height="100%"
                        fill={`url(#chainPattern-cross-${group.groupKey})`}
                      />
                    )}

                    {isCrossStart && (
                      <ellipse cx="20" cy="100%" rx="10" ry="5"
                        fill="none"
                        stroke={`url(#chainMetal-cross-${group.groupKey})`}
                        strokeWidth="3"
                      />
                    )}
                    {isCrossEnd && (
                      <ellipse cx="20" cy="0" rx="10" ry="5"
                        fill="none"
                        stroke={`url(#chainMetal-cross-${group.groupKey})`}
                        strokeWidth="3"
                      />
                    )}
                  </svg>
                </div>
              )}

              {/* グループ内アイテム（展開時のみ表示） */}
              {!group.isCollapsed && (
                <div className="space-y-4 mt-1">
                  {group.items.map((item, spaceItemIndex) => {
                    const globalIndex = items.findIndex((i) => i.id === item.id);

                    // スペースグループ内での範囲選択状態
                    const isThisGroupInRange =
                      spaceGroupRangeInfo && spaceGroupRangeInfo.groupKey === group.groupKey;
                    const isInRange =
                      isThisGroupInRange &&
                      spaceItemIndex >= spaceGroupRangeInfo!.startIndex &&
                      spaceItemIndex <= spaceGroupRangeInfo!.endIndex;
                    const isStart =
                      isThisGroupInRange && spaceItemIndex === spaceGroupRangeInfo!.startIndex;
                    const isEnd =
                      isThisGroupInRange && spaceItemIndex === spaceGroupRangeInfo!.endIndex;
                    const isMiddle =
                      isThisGroupInRange &&
                      spaceItemIndex > spaceGroupRangeInfo!.startIndex &&
                      spaceItemIndex < spaceGroupRangeInfo!.endIndex;

                    return (
                      <div
                        key={item.id}
                        data-item-id={item.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, item)}
                        onDragOver={(e) => handleDragOver(e, item)}
                        onDrop={handleDrop}
                        onDragEnd={cleanUp}
                        onTouchStart={(e) => handleItemTouchStart(e, item)}
                        onTouchMove={handleItemTouchMove}
                        onTouchEnd={handleItemTouchEnd}
                        onTouchCancel={handleItemTouchCancel}
                        className="transition-opacity duration-200 relative"
                        data-is-selected={selectedItemIds.has(item.id)}
                      >
                        {activeDropTarget?.id === item.id &&
                          activeDropTarget.position === 'top' && (
                            <div className="absolute -top-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                              <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                              <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                              <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
                            </div>
                          )}

                        <ShoppingItemCard
                          item={item}
                          onUpdate={onUpdateItem}
                          isStriped={globalIndex % 2 !== 0}
                          onEditRequest={onEditRequest}
                          onDeleteRequest={onDeleteRequest}
                          isSelected={selectedItemIds.has(item.id)}
                          onSelectItem={(itemId) => onSelectItem(itemId, columnType)}
                          blockBackgroundColor={blockColorMap.get(item.id)}
                          onMoveUp={
                            onMoveItemUp
                              ? () => onMoveItemUp(item.id, columnType)
                              : undefined
                          }
                          onMoveDown={
                            onMoveItemDown
                              ? () => onMoveItemDown(item.id, columnType)
                              : undefined
                          }
                          canMoveUp={globalIndex > 0}
                          canMoveDown={globalIndex < items.length - 1}
                          isDuplicateCircle={duplicateCircleItemIds.has(item.id)}
                          isSearchMatch={highlightedItemId === item.id}
                          layoutMode={layoutMode}
                          viewMode={viewMode}
                          highlightPrice={priceHighlightItemIds.has(item.id)}
                        />

                        {activeDropTarget?.id === item.id &&
                          activeDropTarget.position === 'bottom' && (
                            <div className="absolute -bottom-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                              <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                              <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                              <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
                            </div>
                          )}

                        {/* チェーン範囲選択UI（スペースグループ内） */}
                        {isInRange && onToggleRangeSelection && (
                          <div
                            className={`absolute top-0 bottom-0 z-40 ${
                              columnType === 'candidate' ? 'left-0' : 'right-0'
                            } cursor-pointer ${
                              spaceGroupRangeInfo!.onlyStartEndSelected
                                ? 'opacity-50 hover:opacity-100'
                                : 'opacity-100'
                            }`}
                            style={{ width: '40px' }}
                            onClick={() => onToggleRangeSelection(columnType!)}
                          >
                            <svg
                              className="absolute w-full h-full"
                              style={{
                                [columnType === 'candidate' ? 'left' : 'right']: '-42px',
                              }}
                              preserveAspectRatio="none"
                            >
                              <defs>
                                <linearGradient
                                  id={`chainMetal-space-${item.id}`}
                                  x1="0%"
                                  y1="0%"
                                  x2="100%"
                                  y2="0%"
                                >
                                  <stop offset="0%" stopColor="#9CA3AF" />
                                  <stop offset="50%" stopColor="#D1D5DB" />
                                  <stop offset="100%" stopColor="#9CA3AF" />
                                </linearGradient>
                                <pattern
                                  id={`chainPattern-space-${item.id}`}
                                  x="0"
                                  y="0"
                                  width="40"
                                  height="20"
                                  patternUnits="userSpaceOnUse"
                                >
                                  <rect
                                    x="14"
                                    y="-2"
                                    width="12"
                                    height="18"
                                    rx="6"
                                    fill="none"
                                    stroke={`url(#chainMetal-space-${item.id})`}
                                    strokeWidth="3"
                                  />
                                  <rect
                                    x="17"
                                    y="13"
                                    width="6"
                                    height="8"
                                    rx="2"
                                    fill={`url(#chainMetal-space-${item.id})`}
                                    stroke="#4B5563"
                                    strokeWidth="0.5"
                                  />
                                </pattern>
                              </defs>

                              {isStart && (
                                <rect
                                  x="0"
                                  y="50%"
                                  width="40"
                                  height="50%"
                                  fill={`url(#chainPattern-space-${item.id})`}
                                />
                              )}
                              {isEnd && (
                                <rect
                                  x="0"
                                  y="0"
                                  width="40"
                                  height="50%"
                                  fill={`url(#chainPattern-space-${item.id})`}
                                />
                              )}
                              {isMiddle && (
                                <rect
                                  x="0"
                                  y="0"
                                  width="40"
                                  height="100%"
                                  fill={`url(#chainPattern-space-${item.id})`}
                                />
                              )}

                              {isStart && (
                                <ellipse
                                  cx="20"
                                  cy="100%"
                                  rx="10"
                                  ry="5"
                                  fill="none"
                                  stroke={`url(#chainMetal-space-${item.id})`}
                                  strokeWidth="3"
                                />
                              )}
                              {isEnd && (
                                <ellipse
                                  cx="20"
                                  cy="0"
                                  rx="10"
                                  ry="5"
                                  fill="none"
                                  stroke={`url(#chainMetal-space-${item.id})`}
                                  strokeWidth="3"
                                />
                              )}
                            </svg>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/* 実行モード: 全アイテム非未購入時のボタン */}
                  {viewMode === 'execute' && (() => {
                    const allNonNone = group.items.every((item) => item.purchaseStatus !== 'None');
                    if (!allNonNone) return null;
                    const isLastGroup = groupIndex === spaceGroups.length - 1;

                    // 最後のグループ: 後回しフィルタボタン（フラグがtrueの場合のみ）
                    if (isLastGroup && showPostponeFilterButton && onActivatePostponeFilter) {
                      return (
                        <button
                          onClick={() => {
                            const purchasedWithoutPrice = group.items.filter(
                              (item) => item.purchaseStatus === 'Purchased' && item.price === null
                            );
                            if (purchasedWithoutPrice.length > 0) {
                              setPriceHighlightItemIds(new Set(purchasedWithoutPrice.map(i => i.id)));
                              return;
                            }
                            setPriceHighlightItemIds(new Set());
                            onActivatePostponeFilter();
                          }}
                          className={`w-full mt-2 py-2 rounded-lg font-medium transition-colors bg-orange-600 hover:bg-orange-700 text-white dark:bg-orange-500 dark:hover:bg-orange-600 ${
                            layoutMode === 'smartphone' ? 'text-sm' : 'text-sm'
                          }`}
                        >
                          後回しでフィルタ
                        </button>
                      );
                    }

                    // 最後のグループ: 遅参フィルタボタン（後回しフィルタ中、フラグがtrueの場合のみ）
                    if (isLastGroup && showLateFilterButton && onActivateLateFilter) {
                      return (
                        <button
                          onClick={() => {
                            const purchasedWithoutPrice = group.items.filter(
                              (item) => item.purchaseStatus === 'Purchased' && item.price === null
                            );
                            if (purchasedWithoutPrice.length > 0) {
                              setPriceHighlightItemIds(new Set(purchasedWithoutPrice.map(i => i.id)));
                              return;
                            }
                            setPriceHighlightItemIds(new Set());
                            onActivateLateFilter();
                          }}
                          className={`w-full mt-2 py-2 rounded-lg font-medium transition-colors bg-sky-600 hover:bg-sky-700 text-white dark:bg-sky-500 dark:hover:bg-sky-600 ${
                            layoutMode === 'smartphone' ? 'text-sm' : 'text-sm'
                          }`}
                        >
                          遅参でフィルタ
                        </button>
                      );
                    }

                    // 最下段以外: スペースを閉じて次のスペースを展開
                    if (!isLastGroup && onCollapseAndOpenNext) {
                      return (
                        <button
                          onClick={() => {
                            const purchasedWithoutPrice = group.items.filter(
                              (item) => item.purchaseStatus === 'Purchased' && item.price === null
                            );
                            if (purchasedWithoutPrice.length > 0) {
                              setPriceHighlightItemIds(new Set(purchasedWithoutPrice.map(i => i.id)));
                              return;
                            }
                            setPriceHighlightItemIds(new Set());
                            onCollapseAndOpenNext(group.groupKey);
                          }}
                          className={`w-full mt-2 py-2 rounded-lg font-medium transition-colors bg-blue-600 hover:bg-blue-700 text-white dark:bg-blue-500 dark:hover:bg-blue-600 ${
                            layoutMode === 'smartphone' ? 'text-sm' : 'text-sm'
                          }`}
                        >
                          スペースを閉じて次のスペースを展開
                        </button>
                      );
                    }

                    return null;
                  })()}
                </div>
              )}
            </div>
            </React.Fragment>
          );
        });
        })()}

        {/* 新規アイテム追加ダイアログ（Portalでbody直下にレンダリング） */}
        {addDialogOpen && ReactDOM.createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={closeAddDialog}
          >
            <div
              className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4">
                <h2 className="text-lg font-bold">新規アイテム追加</h2>
                <p className="text-sm opacity-80 mt-1">
                  {currentDay} {addDialogDefaults.block}-{addDialogDefaults.number}
                </p>
              </div>
              <div className="p-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>
                      サークル名 <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={newItemForm.circle}
                      onChange={(e) =>
                        setNewItemForm((prev) => ({ ...prev, circle: e.target.value }))
                      }
                      className={formInputClass}
                      placeholder="サークル名"
                      ref={addDialogInputRef}
                      list="add-dialog-circle-suggestions"
                    />
                    {addDialogCircleSuggestions.length > 0 && (
                      <datalist id="add-dialog-circle-suggestions">
                        {addDialogCircleSuggestions.map((c) => (
                          <option key={c} value={c} />
                        ))}
                      </datalist>
                    )}
                  </div>
                  <div>
                    <label className={labelClass}>タイトル</label>
                    <input
                      type="text"
                      value={newItemForm.title}
                      onChange={(e) => setNewItemForm((prev) => ({ ...prev, title: e.target.value }))}
                      className={formInputClass}
                      placeholder="新刊セット"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className={labelClass}>参加日</label>
                    <input
                      type="text"
                      value={currentDay || ''}
                      readOnly
                      className={`${formInputClass} bg-slate-100 dark:bg-slate-700`}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>ブロック</label>
                    <input
                      type="text"
                      value={newItemForm.block}
                      onChange={(e) =>
                        setNewItemForm((prev) => ({ ...prev, block: e.target.value }))
                      }
                      className={formInputClass}
                      placeholder="A"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>ナンバー</label>
                    <input
                      type="text"
                      value={newItemForm.number}
                      onChange={(e) =>
                        setNewItemForm((prev) => ({ ...prev, number: e.target.value }))
                      }
                      className={formInputClass}
                      placeholder="01a"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                  <div className="relative">
                    <label className={labelClass}>頒布価格</label>
                    <input
                      type="text"
                      value={newItemForm.price}
                      onChange={(e) => {
                        const value = e.target.value.replace(/[^0-9]/g, '');
                        setNewItemForm((prev) => ({ ...prev, price: value }));
                      }}
                      className={`${formInputClass} pr-12`}
                      placeholder="0"
                      inputMode="numeric"
                    />
                    <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">
                      円
                    </span>
                  </div>
                  <div>
                    <label className={labelClass}>クイック選択</label>
                    <select
                      onChange={(e) => {
                        setNewItemForm((prev) => ({ ...prev, price: e.target.value }));
                      }}
                      className={formInputClass}
                      value={
                        addFormPriceOptions.includes(Number(newItemForm.price)) ? newItemForm.price : ''
                      }
                    >
                      <option value="" disabled>
                        金額を選択...
                      </option>
                      {addFormPriceOptions.map((p) => (
                        <option key={p} value={p}>
                          {p.toLocaleString()}円
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>数量</label>
                    <select
                      value={newItemForm.quantity}
                      onChange={(e) =>
                        setNewItemForm((prev) => ({ ...prev, quantity: e.target.value }))
                      }
                      className={formInputClass}
                    >
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((num) => (
                        <option key={num} value={num}>
                          {num}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>購入状態</label>
                    <select
                      value={newItemForm.purchaseStatus}
                      onChange={(e) =>
                        setNewItemForm((prev) => ({
                          ...prev,
                          purchaseStatus: e.target.value as typeof newItemForm.purchaseStatus,
                        }))
                      }
                      className={formInputClass}
                    >
                      <option value="None">未購入</option>
                      <option value="Purchased">購入済</option>
                      <option value="Postpone">後回し</option>
                      <option value="Late">遅参</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>備考</label>
                    <input
                      type="text"
                      value={newItemForm.remarks}
                      onChange={(e) =>
                        setNewItemForm((prev) => ({ ...prev, remarks: e.target.value }))
                      }
                      className={formInputClass}
                      placeholder="スケブお願い"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>URL</label>
                    <input
                      type="text"
                      value={newItemForm.url}
                      onChange={(e) => setNewItemForm((prev) => ({ ...prev, url: e.target.value }))}
                      className={formInputClass}
                      placeholder="https://example.com"
                    />
                  </div>
                </div>
              </div>
              <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
                <button
                  onClick={closeAddDialog}
                  className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleAddItemSubmit}
                  disabled={!newItemForm.circle.trim()}
                  className="flex-1 py-2 px-4 bg-green-600 hover:bg-green-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
                >
                  リストに追加
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    );
  }

  // ホールグループ化表示
  // ホール定義 0 件でも、優先度別の未定義セクション (highest/priority/none) が
  // 1 つでもあれば groupItemsByHallOrder が複数バケットを返すか、または
  // 単一でも groupId が 'undefined:*' になるためグループ表示分岐に入れる。
  const shouldShowHallGroups =
    showHallGroups &&
    (hallDefinitions.length > 0 ||
      hallGroups.length > 1 ||
      (hallGroups.length === 1 && hallGroups[0].groupId !== null));
  if (shouldShowHallGroups) {
    return (
      <div
        ref={containerRef}
        className="space-y-2 relative"
        style={{ paddingBottom: 'var(--footer-height, 96px)' }}
        onDragLeave={() => setActiveDropTarget(null)}
      >
        {hallGroups.map((group, groupIndex) => {
          const headerStyle = getGroupHeaderStyle(group.groupId, hallDefinitions);
          const displayName = getGroupDisplayName(group.groupId, hallDefinitions);

          // このグループ内での範囲選択情報
          const isThisGroupInRange = groupRangeInfo && groupRangeInfo.groupId === group.groupId;

          return (
            <div key={group.groupId ?? `no-hall-${groupIndex}`} className="mb-4">
              {/* グループヘッダー */}
              <div
                className={`sticky top-0 z-20 flex items-center justify-between px-4 py-2 rounded-t-lg ${headerStyle.bgClass}`}
                style={{ borderLeft: `4px solid ${headerStyle.borderColor}` }}
              >
                <span className="font-bold text-sm text-slate-700 dark:text-slate-300">
                  {displayName}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {group.items.length}件
                </span>
              </div>

              {/* グループ内アイテム */}
              <div className="space-y-4 mt-2">
                {group.items.map((item, hallIndex) => {
                  const globalIndex = items.findIndex((i) => i.id === item.id);

                  // グループ内での範囲選択状態
                  const isInRange =
                    isThisGroupInRange &&
                    hallIndex >= groupRangeInfo!.startIndex &&
                    hallIndex <= groupRangeInfo!.endIndex;
                  const isStart = isThisGroupInRange && hallIndex === groupRangeInfo!.startIndex;
                  const isEnd = isThisGroupInRange && hallIndex === groupRangeInfo!.endIndex;
                  const isMiddle =
                    isThisGroupInRange &&
                    hallIndex > groupRangeInfo!.startIndex &&
                    hallIndex < groupRangeInfo!.endIndex;

                  return (
                    <div
                      key={item.id}
                      data-item-id={item.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, item)}
                      onDragOver={(e) => handleDragOver(e, item)}
                      onDrop={handleDrop}
                      onDragEnd={cleanUp}
                      onTouchStart={(e) => handleItemTouchStart(e, item)}
                      onTouchMove={handleItemTouchMove}
                      onTouchEnd={handleItemTouchEnd}
                      onTouchCancel={handleItemTouchCancel}
                      className={`transition-opacity duration-200 relative ${
                        group.priority === 'highest'
                          ? 'bg-red-50/30 dark:bg-red-950/20'
                          : group.priority === 'priority'
                            ? 'bg-orange-50/30 dark:bg-orange-950/20'
                            : ''
                      }`}
                      data-is-selected={selectedItemIds.has(item.id)}
                    >
                      {activeDropTarget?.id === item.id && activeDropTarget.position === 'top' && (
                        <div className="absolute -top-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                          <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                          <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                          <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
                        </div>
                      )}

                      <ShoppingItemCard
                        item={item}
                        onUpdate={onUpdateItem}
                        isStriped={globalIndex % 2 !== 0}
                        onEditRequest={onEditRequest}
                        onDeleteRequest={onDeleteRequest}
                        isSelected={selectedItemIds.has(item.id)}
                        onSelectItem={(itemId) => onSelectItem(itemId, columnType)}
                        blockBackgroundColor={blockColorMap.get(item.id)}
                        onMoveUp={
                          onMoveItemUp ? () => onMoveItemUp(item.id, columnType) : undefined
                        }
                        onMoveDown={
                          onMoveItemDown ? () => onMoveItemDown(item.id, columnType) : undefined
                        }
                        canMoveUp={globalIndex > 0}
                        canMoveDown={globalIndex < items.length - 1}
                        isDuplicateCircle={duplicateCircleItemIds.has(item.id)}
                        isSearchMatch={highlightedItemId === item.id}
                        layoutMode={layoutMode}
                        viewMode={viewMode}
                        hallIndex={hallIndex}
                        priorityLevel={group.priority}
                      />

                      {activeDropTarget?.id === item.id &&
                        activeDropTarget.position === 'bottom' && (
                          <div className="absolute -bottom-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                            <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                            <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                            <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
                          </div>
                        )}

                      {/* 範囲選択表示とチェーン選択UI（グループ内のみ） */}
                      {isInRange && onToggleRangeSelection && (
                        <div
                          className={`absolute top-0 bottom-0 z-40 ${
                            columnType === 'candidate' ? 'left-0' : 'right-0'
                          } cursor-pointer ${
                            groupRangeInfo!.onlyStartEndSelected
                              ? 'opacity-50 hover:opacity-100'
                              : 'opacity-100'
                          }`}
                          style={{ width: '40px' }}
                          onClick={() => onToggleRangeSelection(columnType!)}
                        >
                          <svg
                            className="absolute w-full h-full"
                            style={{
                              [columnType === 'candidate' ? 'left' : 'right']: '-42px',
                            }}
                            preserveAspectRatio="none"
                          >
                            <defs>
                              <linearGradient
                                id={`chainMetal-group-${item.id}`}
                                x1="0%"
                                y1="0%"
                                x2="100%"
                                y2="0%"
                              >
                                <stop offset="0%" stopColor="#9CA3AF" />
                                <stop offset="50%" stopColor="#D1D5DB" />
                                <stop offset="100%" stopColor="#9CA3AF" />
                              </linearGradient>
                              <pattern
                                id={`chainPattern-group-${item.id}`}
                                x="0"
                                y="0"
                                width="40"
                                height="20"
                                patternUnits="userSpaceOnUse"
                              >
                                <rect
                                  x="14"
                                  y="-2"
                                  width="12"
                                  height="18"
                                  rx="6"
                                  fill="none"
                                  stroke={`url(#chainMetal-group-${item.id})`}
                                  strokeWidth="3"
                                />
                                <rect
                                  x="17"
                                  y="13"
                                  width="6"
                                  height="8"
                                  rx="2"
                                  fill={`url(#chainMetal-group-${item.id})`}
                                  stroke="#4B5563"
                                  strokeWidth="0.5"
                                />
                              </pattern>
                            </defs>

                            {isStart && (
                              <rect
                                x="0"
                                y="50%"
                                width="40"
                                height="50%"
                                fill={`url(#chainPattern-group-${item.id})`}
                              />
                            )}
                            {isEnd && (
                              <rect
                                x="0"
                                y="0"
                                width="40"
                                height="50%"
                                fill={`url(#chainPattern-group-${item.id})`}
                              />
                            )}
                            {isMiddle && (
                              <rect
                                x="0"
                                y="0"
                                width="40"
                                height="100%"
                                fill={`url(#chainPattern-group-${item.id})`}
                              />
                            )}

                            {/* 端点のリング */}
                            {isStart && (
                              <ellipse
                                cx="20"
                                cy="100%"
                                rx="10"
                                ry="5"
                                fill="none"
                                stroke={`url(#chainMetal-group-${item.id})`}
                                strokeWidth="3"
                              />
                            )}
                            {isEnd && (
                              <ellipse
                                cx="20"
                                cy="0"
                                rx="10"
                                ry="5"
                                fill="none"
                                stroke={`url(#chainMetal-group-${item.id})`}
                                strokeWidth="3"
                              />
                            )}

                            {/* 中心の丸 */}
                            {isStart && (
                              <circle
                                cx="20"
                                cy="100%"
                                r="4"
                                fill={`url(#chainMetal-group-${item.id})`}
                                stroke="#4B5563"
                                strokeWidth="0.5"
                              />
                            )}
                            {isEnd && (
                              <circle
                                cx="20"
                                cy="0"
                                r="4"
                                fill={`url(#chainMetal-group-${item.id})`}
                                stroke="#4B5563"
                                strokeWidth="0.5"
                              />
                            )}
                          </svg>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // 通常表示（既存のコード）

  return (
    <div
      ref={containerRef}
      className="space-y-4 relative"
      style={{ paddingBottom: 'var(--footer-height, 96px)' }}
      onDragLeave={() => setActiveDropTarget(null)}
    >
      {items.map((item, index) => {
        // 範囲選択内かどうか判定
        const isInRange = rangeInfo && index >= rangeInfo.startIndex && index <= rangeInfo.endIndex;
        const isStart = rangeInfo && index === rangeInfo.startIndex;
        const isEnd = rangeInfo && index === rangeInfo.endIndex;
        const isMiddle = rangeInfo && index > rangeInfo.startIndex && index < rangeInfo.endIndex;

        return (
          <div
            key={item.id}
            data-item-id={item.id}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            onDragOver={(e) => handleDragOver(e, item)}
            onDrop={handleDrop}
            onDragEnd={cleanUp}
            onTouchStart={(e) => handleItemTouchStart(e, item)}
            onTouchMove={handleItemTouchMove}
            onTouchEnd={handleItemTouchEnd}
            onTouchCancel={handleItemTouchCancel}
            className="transition-opacity duration-200 relative"
            data-is-selected={selectedItemIds.has(item.id)}
          >
            {activeDropTarget?.id === item.id && activeDropTarget.position === 'top' && (
              <div className="absolute -top-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
              </div>
            )}

            <ShoppingItemCard
              item={item}
              onUpdate={onUpdateItem}
              isStriped={index % 2 !== 0}
              onEditRequest={onEditRequest}
              onDeleteRequest={onDeleteRequest}
              isSelected={selectedItemIds.has(item.id)}
              onSelectItem={(itemId) => onSelectItem(itemId, columnType)}
              blockBackgroundColor={blockColorMap.get(item.id)}
              onMoveUp={onMoveItemUp ? () => onMoveItemUp(item.id, columnType) : undefined}
              onMoveDown={onMoveItemDown ? () => onMoveItemDown(item.id, columnType) : undefined}
              canMoveUp={index > 0}
              canMoveDown={index < items.length - 1}
              isDuplicateCircle={duplicateCircleItemIds.has(item.id)}
              isSearchMatch={highlightedItemId === item.id}
              layoutMode={layoutMode}
              viewMode={viewMode}
            />

            {activeDropTarget?.id === item.id && activeDropTarget.position === 'bottom' && (
              <div className="absolute -bottom-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
              </div>
            )}

            {/* チェーンをアイテムの右側（左列: execute）または左側（右列: candidate）に表示 */}
            {isInRange && onToggleRangeSelection && (
              <div
                className={`absolute top-0 bottom-0 z-40 pointer-events-none ${
                  columnType === 'candidate' ? 'left-0' : 'right-0'
                }`}
                style={{ width: '40px' }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleRangeSelection(columnType!);
                  }}
                  className={`pointer-events-auto absolute w-full h-full transition-opacity ${
                    rangeInfo.onlyStartEndSelected ? 'opacity-50 hover:opacity-100' : 'opacity-100'
                  }`}
                  style={{
                    [columnType === 'candidate' ? 'left' : 'right']: '-42px',
                  }}
                  title={
                    rangeInfo.allSelected ? '範囲内のチェックを外す' : '範囲内のチェックを入れる'
                  }
                  data-no-long-press
                >
                  <svg
                    width="40"
                    height="100%"
                    preserveAspectRatio="none"
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-full h-full"
                  >
                    <defs>
                      <linearGradient
                        id={`chainMetal-${item.id}`}
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="0%"
                      >
                        <stop offset="0%" stopColor="#9CA3AF" />
                        <stop offset="30%" stopColor="#F3F4F6" />
                        <stop offset="50%" stopColor="#D1D5DB" />
                        <stop offset="70%" stopColor="#9CA3AF" />
                        <stop offset="100%" stopColor="#6B7280" />
                      </linearGradient>
                      <pattern
                        id={`chainPattern-${item.id}`}
                        x="0"
                        y="0"
                        width="40"
                        height="20"
                        patternUnits="userSpaceOnUse"
                      >
                        <rect
                          x="14"
                          y="-2"
                          width="12"
                          height="18"
                          rx="6"
                          fill="none"
                          stroke={`url(#chainMetal-${item.id})`}
                          strokeWidth="3"
                        />
                        <rect
                          x="17"
                          y="13"
                          width="6"
                          height="8"
                          rx="2"
                          fill={`url(#chainMetal-${item.id})`}
                          stroke="#4B5563"
                          strokeWidth="0.5"
                        />
                      </pattern>
                    </defs>

                    {/* チェーンの描画範囲を制御 */}
                    {isStart && (
                      // 起点: 中央から下まで
                      <rect
                        x="0"
                        y="50%"
                        width="40"
                        height="50%"
                        fill={`url(#chainPattern-${item.id})`}
                      />
                    )}
                    {isEnd && (
                      // 終点: 上から中央まで
                      <rect
                        x="0"
                        y="0"
                        width="40"
                        height="50%"
                        fill={`url(#chainPattern-${item.id})`}
                      />
                    )}
                    {isMiddle && (
                      // 間: 全体
                      <rect
                        x="0"
                        y="0"
                        width="40"
                        height="100%"
                        fill={`url(#chainPattern-${item.id})`}
                      />
                    )}

                    {/* フック（アイテムと鎖を繋ぐ金具） - 全ての範囲内アイテムに表示 */}
                    <g transform="translate(0, 50)">
                      {columnType === 'candidate' ? (
                        <path
                          d="M 40 0 L 20 0"
                          stroke={`url(#chainMetal-${item.id})`}
                          strokeWidth="4"
                          strokeLinecap="round"
                          fill="none"
                        />
                      ) : (
                        <path
                          d="M 0 0 L 20 0"
                          stroke={`url(#chainMetal-${item.id})`}
                          strokeWidth="4"
                          strokeLinecap="round"
                          fill="none"
                        />
                      )}
                      <circle
                        cx="20"
                        cy="0"
                        r="4"
                        fill={`url(#chainMetal-${item.id})`}
                        stroke="#4B5563"
                        strokeWidth="0.5"
                      />
                      <circle
                        cx={columnType === 'candidate' ? 38 : 2}
                        cy="0"
                        r="3"
                        fill="#9CA3AF"
                      />
                    </g>
                  </svg>
                </button>
              </div>
            )}

            {/* アイテム間の隙間を埋めるチェーン */}
            {rangeInfo && (isStart || isMiddle) && onToggleRangeSelection && (
              <div
                className={`absolute bottom-0 z-50 pointer-events-none ${
                  columnType === 'candidate' ? 'left-0' : 'right-0'
                }`}
                style={{
                  width: '40px',
                  height: '16px',
                  [columnType === 'candidate' ? 'left' : 'right']: '-42px',
                }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleRangeSelection(columnType!);
                  }}
                  className={`pointer-events-auto absolute w-full h-full transition-opacity ${
                    rangeInfo.onlyStartEndSelected ? 'opacity-50 hover:opacity-100' : 'opacity-100'
                  }`}
                  title={
                    rangeInfo.allSelected ? '範囲内のチェックを外す' : '範囲内のチェックを入れる'
                  }
                  data-no-long-press
                >
                  <svg
                    width="40"
                    height="16"
                    xmlns="http://www.w3.org/2000/svg"
                    className="w-full h-full"
                  >
                    {/* パターン定義を再利用するためにdefsを定義（本当はuseタグを使いたいが、IDスコープが面倒なので再定義） */}
                    <defs>
                      <linearGradient
                        id={`chainMetal-gap-${item.id}`}
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="0%"
                      >
                        <stop offset="0%" stopColor="#9CA3AF" />
                        <stop offset="30%" stopColor="#F3F4F6" />
                        <stop offset="50%" stopColor="#D1D5DB" />
                        <stop offset="70%" stopColor="#9CA3AF" />
                        <stop offset="100%" stopColor="#6B7280" />
                      </linearGradient>
                      <pattern
                        id={`chainPattern-gap-${item.id}`}
                        x="0"
                        y="0"
                        width="40"
                        height="20"
                        patternUnits="userSpaceOnUse"
                      >
                        <rect
                          x="14"
                          y="-2"
                          width="12"
                          height="18"
                          rx="6"
                          fill="none"
                          stroke={`url(#chainMetal-gap-${item.id})`}
                          strokeWidth="3"
                        />
                        <rect
                          x="17"
                          y="13"
                          width="6"
                          height="8"
                          rx="2"
                          fill={`url(#chainMetal-gap-${item.id})`}
                          stroke="#4B5563"
                          strokeWidth="0.5"
                        />
                      </pattern>
                    </defs>
                    <rect
                      x="0"
                      y="0"
                      width="40"
                      height="100%"
                      fill={`url(#chainPattern-gap-${item.id})`}
                    />
                  </svg>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default React.memo(ShoppingList);
