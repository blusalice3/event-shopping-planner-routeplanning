import React, { useRef, useState, useMemo } from 'react';
import { ShoppingItem } from '../types';
import ShoppingItemCard from './ShoppingItemCard';

interface ShoppingListProps {
  items: ShoppingItem[];
  onUpdateItem: (item: ShoppingItem) => void;
  onMoveItem: (dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => void;
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
}

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
  rangeStart,
  rangeEnd,
  onToggleRangeSelection,
}) => {
  const dragItem = useRef<string | null>(null);
  const dragSourceColumn = useRef<'execute' | 'candidate' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [activeDropTarget, setActiveDropTarget] = useState<{ id: string; position: 'top' | 'bottom' } | null>(null);

  const blockColorMap = useMemo(() => calculateBlockColors(items), [items]);

  // 範囲選択の状態を計算
  const rangeInfo = useMemo(() => {
    if (!rangeStart || !rangeEnd || !columnType || rangeStart.columnType !== columnType || rangeEnd.columnType !== columnType) {
      return null;
    }

    const startIndex = items.findIndex(item => item.id === rangeStart.itemId);
    const endIndex = items.findIndex(item => item.id === rangeEnd.itemId);

    if (startIndex === -1 || endIndex === -1) return null;

    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    const rangeItems = items.slice(minIndex, maxIndex + 1);
    const allSelected = rangeItems.every(item => selectedItemIds.has(item.id));
    
    const onlyStartEndSelected = rangeItems.length > 2 && 
      selectedItemIds.has(rangeItems[0].id) && 
      selectedItemIds.has(rangeItems[rangeItems.length - 1].id) &&
      rangeItems.slice(1, -1).every(item => !selectedItemIds.has(item.id));

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
        document.querySelectorAll('[data-is-selected="true"]').forEach(el => {
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

    const isCrossColumn = dragSourceColumn.current !== null && dragSourceColumn.current !== columnType;
    
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
    
    const sourceColumn = e.dataTransfer.getData('sourceColumn') as 'execute' | 'candidate' | undefined;
    
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
        const targetIndex = items.findIndex(i => i.id === targetId);
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
    document.querySelectorAll('.opacity-40').forEach(el => el.classList.remove('opacity-40'));
    dragItem.current = null;
    dragSourceColumn.current = null;
    setActiveDropTarget(null);
  };

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

  return (
    <div 
      ref={containerRef}
      className="space-y-4 pb-24 relative"
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
                  columnType === 'candidate' 
                    ? 'left-0' 
                    : 'right-0'
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
                  title={rangeInfo.allSelected ? "範囲内のチェックを外す" : "範囲内のチェックを入れる"}
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
                      <linearGradient id={`chainMetal-${item.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#9CA3AF" />
                        <stop offset="30%" stopColor="#F3F4F6" />
                        <stop offset="50%" stopColor="#D1D5DB" />
                        <stop offset="70%" stopColor="#9CA3AF" />
                        <stop offset="100%" stopColor="#6B7280" />
                      </linearGradient>
                      <pattern id={`chainPattern-${item.id}`} x="0" y="0" width="40" height="20" patternUnits="userSpaceOnUse">
                         <rect x="14" y="-2" width="12" height="18" rx="6" fill="none" stroke={`url(#chainMetal-${item.id})`} strokeWidth="3" />
                         <rect x="17" y="13" width="6" height="8" rx="2" fill={`url(#chainMetal-${item.id})`} stroke="#4B5563" strokeWidth="0.5" />
                      </pattern>
                    </defs>

                    {/* チェーンの描画範囲を制御 */}
                    {isStart && (
                        // 起点: 中央から下まで
                        <rect x="0" y="50%" width="40" height="50%" fill={`url(#chainPattern-${item.id})`} />
                    )}
                    {isEnd && (
                        // 終点: 上から中央まで
                        <rect x="0" y="0" width="40" height="50%" fill={`url(#chainPattern-${item.id})`} />
                    )}
                    {isMiddle && (
                        // 間: 全体
                        <rect x="0" y="0" width="40" height="100%" fill={`url(#chainPattern-${item.id})`} />
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
                        <circle cx="20" cy="0" r="4" fill={`url(#chainMetal-${item.id})`} stroke="#4B5563" strokeWidth="0.5" />
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
                  title={rangeInfo.allSelected ? "範囲内のチェックを外す" : "範囲内のチェックを入れる"}
                  data-no-long-press
                >
                  <svg width="40" height="16" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                     {/* パターン定義を再利用するためにdefsを定義（本当はuseタグを使いたいが、IDスコープが面倒なので再定義） */}
                     <defs>
                      <linearGradient id={`chainMetal-gap-${item.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="#9CA3AF" />
                        <stop offset="30%" stopColor="#F3F4F6" />
                        <stop offset="50%" stopColor="#D1D5DB" />
                        <stop offset="70%" stopColor="#9CA3AF" />
                        <stop offset="100%" stopColor="#6B7280" />
                      </linearGradient>
                      <pattern id={`chainPattern-gap-${item.id}`} x="0" y="0" width="40" height="20" patternUnits="userSpaceOnUse">
                         <rect x="14" y="-2" width="12" height="18" rx="6" fill="none" stroke={`url(#chainMetal-gap-${item.id})`} strokeWidth="3" />
                         <rect x="17" y="13" width="6" height="8" rx="2" fill={`url(#chainMetal-gap-${item.id})`} stroke="#4B5563" strokeWidth="0.5" />
                      </pattern>
                    </defs>
                     <rect x="0" y="0" width="40" height="100%" fill={`url(#chainPattern-gap-${item.id})`} />
                  </svg>
                </button>
              </div>
            )}
        </div>
      )})}
    </div>
  );
};

export default ShoppingList;
