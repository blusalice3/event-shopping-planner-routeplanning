import React, { useRef, useState, useMemo } from 'react';
import { ShoppingItem } from '../types';
import ShoppingItemCard from './ShoppingItemCard';

interface ShoppingListProps {
  items: ShoppingItem[];
  onUpdateItem: (item: ShoppingItem) => void;
  onMoveItem: (dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate') => void;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  selectedItemIds: Set<string>;
  onSelectItem: (itemId: string) => void;
  onMoveToColumn?: (itemIds: string[]) => void;
  onRemoveFromColumn?: (itemIds: string[]) => void;
  columnType?: 'execute' | 'candidate';
  currentDay?: string;
  onMoveItemUp?: (itemId: string, targetColumn?: 'execute' | 'candidate') => void;
  onMoveItemDown?: (itemId: string, targetColumn?: 'execute' | 'candidate') => void;
}

// Constants for drag-and-drop auto-scrolling
const SCROLL_SPEED = 20;
const TOP_SCROLL_TRIGGER_PX = 150;
const BOTTOM_SCROLL_TRIGGER_PX = 100;

// 色のパレット定義
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

// アイテムリストからブロックベースの色情報を計算
const calculateBlockColors = (items: ShoppingItem[]): Map<string, string> => {
  const colorMap = new Map<string, string>();
  const uniqueBlocks = new Set<string>();
  items.forEach(item => { if (item.purchaseStatus === 'None') { uniqueBlocks.add(item.block); } });
  const sortedBlocks = Array.from(uniqueBlocks).sort((a, b) => {
    const numA = Number(a); const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) { return numA - numB; }
    return a.localeCompare(b);
  });
  const blockColorMap = new Map<string, { light: string; dark: string }>();
  sortedBlocks.forEach((block, index) => { const colorIndex = index % colorPalette.length; blockColorMap.set(block, colorPalette[colorIndex]); });
  items.forEach((item, index) => {
    if (item.purchaseStatus === 'None') {
      const block = item.block; const blockColor = blockColorMap.get(block);
      if (blockColor) {
        const prevItem = index > 0 ? items[index - 1] : null;
        const isSameBlockAsPrev = prevItem && prevItem.block === block && prevItem.purchaseStatus === 'None';
        if (isSameBlockAsPrev) { const prevColor = colorMap.get(items[index - 1].id) || ''; const shouldUseDark = prevColor === blockColor.light; colorMap.set(item.id, shouldUseDark ? blockColor.dark : blockColor.light); }
        else { colorMap.set(item.id, blockColor.light); }
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
  currentDay: _currentDay,
  onMoveItemUp,
  onMoveItemDown,
}) => {
  const dragItem = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // ドロップターゲットの状態管理
  const [activeDropTarget, setActiveDropTarget] = useState<{ id: string; position: 'top' | 'bottom' } | null>(null);

  const blockColorMap = useMemo(() => calculateBlockColors(items), [items]);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    dragItem.current = item.id;
    // columnType情報をセット（App.tsx側での判定には使わないが、デバッグ等で有用なため残す）
    if (columnType) {
      e.dataTransfer.setData('sourceColumn', columnType);
    }
    const target = e.currentTarget;
    // スタイル適用を遅延させて、ドラッグゴーストには適用しないようにする
    setTimeout(() => {
      if (target) {
        target.classList.add('opacity-40');
      }
      if (selectedItemIds.has(item.id)) {
        document.querySelectorAll('[data-is-selected="true"]').forEach(el => {
          el.classList.add('opacity-40');
        });
      }
    }, 0);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    e.preventDefault();
    e.stopPropagation();

    // 自動スクロール機能
    const clientY = e.clientY;
    const windowHeight = window.innerHeight;
    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, -SCROLL_SPEED);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, SCROLL_SPEED);
    }

    // 自分自身の上にはガイドを表示しない（ただし選択アイテム群の移動時は例外あり）
    if (dragItem.current === item.id && selectedItemIds.size === 0) {
       setActiveDropTarget(null);
       return;
    }
    
    // 選択済みアイテム同士でのホバーは何もしない
    if (selectedItemIds.has(item.id) && selectedItemIds.has(dragItem.current || '')) {
       setActiveDropTarget(null);
       return;
    }

    // カーソル位置で上半分か下半分かを判定
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const position = relativeY < rect.height / 2 ? 'top' : 'bottom';

    setActiveDropTarget({ id: item.id, position });
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!dragItem.current || !activeDropTarget) {
      cleanUp();
      return;
    }

    const { id: targetId, position } = activeDropTarget;

    // 自分自身へのドロップは無視
    if (dragItem.current === targetId) {
        cleanUp();
        return;
    }

    if (position === 'top') {
        // アイテムの上半分にドロップ -> そのアイテムの「前」に挿入
        onMoveItem(dragItem.current, targetId, columnType);
    } else {
        // アイテムの下半分にドロップ -> そのアイテムの「後」（＝次のアイテムの前）に挿入
        const targetIndex = items.findIndex(i => i.id === targetId);
        
        // リストの末尾の場合
        if (targetIndex === -1 || targetIndex === items.length - 1) {
            onMoveItem(dragItem.current, '__END_OF_LIST__', columnType);
        } else {
            // 次のアイテムの前に挿入
            const nextItem = items[targetIndex + 1];
            if (nextItem) {
                onMoveItem(dragItem.current, nextItem.id, columnType);
            } else {
                onMoveItem(dragItem.current, '__END_OF_LIST__', columnType);
            }
        }
    }
    
    cleanUp();
  };

  const cleanUp = () => {
    document.querySelectorAll('.opacity-40').forEach(el => el.classList.remove('opacity-40'));
    dragItem.current = null;
    setActiveDropTarget(null);
  };

  if (items.length === 0) {
    // 空のリストへのドロップ対応（末尾追加として扱う）
    return (
        <div 
            className="text-center text-slate-500 dark:text-slate-400 py-12 min-h-[200px] border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg relative transition-colors"
            onDragOver={(e) => {
                e.preventDefault();
                e.currentTarget.classList.add('bg-blue-50', 'dark:bg-blue-900/20', 'border-blue-400');
            }}
            onDragLeave={(e) => {
                e.currentTarget.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-blue-400');
            }}
            onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.classList.remove('bg-blue-50', 'dark:bg-blue-900/20', 'border-blue-400');
                if (dragItem.current) {
                    onMoveItem(dragItem.current, '__END_OF_LIST__', columnType);
                }
                cleanUp();
            }}
        >
          この日のアイテムはありません。<br/>
          <span className="text-sm opacity-70">アイテムをここにドロップして移動</span>
        </div>
      );
  }

  return (
    <div 
      ref={containerRef}
      className="space-y-4 pb-24 relative"
      // Note: onDragLeave removed from container to prevent guide flickering/disappearing during drag
    >
      {items.map((item, index) => (
        <div
            key={item.id}
            data-item-id={item.id}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            onDragOver={(e) => handleDragOver(e, item)}
            onDrop={handleDrop}
            onDragEnd={cleanUp}
            className="transition-opacity duration-200 relative"
            data-is-selected={selectedItemIds.has(item.id)}
        >
            {/* 上ガイドバー */}
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
              onSelectItem={onSelectItem}
              blockBackgroundColor={blockColorMap.get(item.id)}
              onMoveUp={onMoveItemUp ? () => onMoveItemUp(item.id, columnType) : undefined}
              onMoveDown={onMoveItemDown ? () => onMoveItemDown(item.id, columnType) : undefined}
              canMoveUp={index > 0}
              canMoveDown={index < items.length - 1}
            />

            {/* 下ガイドバー */}
            {activeDropTarget?.id === item.id && activeDropTarget.position === 'bottom' && (
                <div className="absolute -bottom-3 left-0 right-0 h-2 flex items-center justify-center z-30 pointer-events-none">
                    <div className="w-full h-1.5 bg-blue-500 rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 transform scale-x-95 transition-transform duration-75" />
                    <div className="absolute w-4 h-4 bg-blue-500 rounded-full -left-1 ring-2 ring-white dark:ring-slate-800" />
                    <div className="absolute w-4 h-4 bg-blue-500 rounded-full -right-1 ring-2 ring-white dark:ring-slate-800" />
                </div>
            )}
        </div>
      ))}
    </div>
  );
};

export default ShoppingList;
