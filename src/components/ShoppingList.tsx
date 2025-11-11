import React, { useRef, useState } from 'react';
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
  currentDay?: 'day1' | 'day2';
}

// Constants for drag-and-drop auto-scrolling
const SCROLL_SPEED = 20;
const TOP_SCROLL_TRIGGER_PX = 150;
const BOTTOM_SCROLL_TRIGGER_PX = 100;

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
}) => {
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    dragItem.current = item.id;
    if (columnType) {
      e.dataTransfer.setData('sourceColumn', columnType);
    }
    const target = e.currentTarget;
    setTimeout(() => {
      if (target) {
        target.classList.add('opacity-40');
      }
      // 複数選択時は選択されたアイテムすべての不透明度を下げる
      if (selectedItemIds.has(item.id)) {
        document.querySelectorAll('[data-is-selected="true"]').forEach(el => {
          el.classList.add('opacity-40');
        });
      }
    }, 0);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem, index: number) => {
    e.preventDefault();
    // 選択されたアイテムの上にはドロップできない
    if (selectedItemIds.has(item.id) && selectedItemIds.has(dragItem.current || '')) {
      dragOverItem.current = null;
      return;
    }
    dragOverItem.current = item.id;
    
    // 挿入位置を計算（アイテムの中央より上か下かで判定）
    const rect = e.currentTarget.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const itemHeight = rect.height || 100; // フォールバック値
    const insertIndex = relativeY < itemHeight / 2 ? index : index + 1;
    setInsertPosition(Math.min(insertIndex, items.length));
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    // 自動スクロール機能
    const clientY = e.clientY;
    const windowHeight = window.innerHeight;
    
    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      // ヘッダーに近づいたら上にスクロール
      window.scrollBy(0, -SCROLL_SPEED);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      // フッターに近づいたら下にスクロール
      window.scrollBy(0, SCROLL_SPEED);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    
    const sourceColumn = e.dataTransfer.getData('sourceColumn') as 'execute' | 'candidate' | undefined;
    
    // 同じ列内での移動のみ許可
    if (sourceColumn !== columnType) {
      setInsertPosition(null);
      dragItem.current = null;
      dragOverItem.current = null;
      return;
    }
    
    // 同じ列内での移動
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      onMoveItem(dragItem.current, dragOverItem.current, columnType);
    }
    
    setInsertPosition(null);
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove('opacity-40');
    document.querySelectorAll('[data-is-selected="true"]').forEach(el => {
      el.classList.remove('opacity-40');
    });
    dragItem.current = null;
    dragOverItem.current = null;
    setInsertPosition(null);
    e.dataTransfer.clearData();
  };

  if (items.length === 0) {
      return (
        <div className="text-center text-slate-500 dark:text-slate-400 py-12 min-h-[200px] border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg relative">
          この日のアイテムはありません。
        </div>
      );
  }

  return (
    <div 
      ref={containerRef}
      className="space-y-4 pb-24 relative"
      onDragOver={(e) => {
        e.preventDefault();
        // コンテナ全体での自動スクロール
        const clientY = e.clientY;
        const windowHeight = window.innerHeight;
        
        if (clientY < TOP_SCROLL_TRIGGER_PX) {
          window.scrollBy(0, -SCROLL_SPEED);
        } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
          window.scrollBy(0, SCROLL_SPEED);
        }
      }}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {/* 挿入位置インジケーター */}
          {insertPosition === index && (
            <div className="flex items-center justify-center h-2 my-2 relative z-10">
              <div className="w-full h-0.5 bg-blue-500"></div>
              <div className="absolute left-1/2 -translate-x-1/2 bg-blue-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg font-bold">
                +
              </div>
            </div>
          )}
          <div
            data-item-id={item.id}
            draggable
            onDragStart={(e) => handleDragStart(e, item)}
            onDragEnter={(e) => handleDragEnter(e, item, index)}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            className="transition-opacity duration-200 relative"
            data-is-selected={selectedItemIds.has(item.id)}
          >
            <ShoppingItemCard
              item={item}
              onUpdate={onUpdateItem}
              isStriped={index % 2 !== 0}
              onEditRequest={onEditRequest}
              onDeleteRequest={onDeleteRequest}
              isSelected={selectedItemIds.has(item.id)}
              onSelectItem={onSelectItem}
            />
          </div>
          {/* 最後のアイテムの後に挿入位置インジケーター */}
          {insertPosition === items.length && index === items.length - 1 && (
            <div className="flex items-center justify-center h-2 my-2 relative z-10">
              <div className="w-full h-0.5 bg-blue-500"></div>
              <div className="absolute left-1/2 -translate-x-1/2 bg-blue-500 text-white rounded-full w-8 h-8 flex items-center justify-center text-lg font-bold">
                +
              </div>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};

export default ShoppingList;
