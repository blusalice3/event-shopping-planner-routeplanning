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
  onMoveToColumn,
  onRemoveFromColumn,
  columnType,
}) => {
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);
  const dragOverIndex = useRef<number | null>(null);
  const [insertPosition, setInsertPosition] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    dragItem.current = item.id;
    if (columnType) {
      e.dataTransfer.setData('sourceColumn', columnType);
    }
    const target = e.currentTarget;
    setTimeout(() => {
        if(target) {
            target.classList.add('opacity-40');
        }
        if (selectedItemIds.has(item.id)) {
            document.querySelectorAll('[data-is-selected="true"]').forEach(el => el.classList.add('opacity-40'));
        }
    }, 0);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem, index: number) => {
    e.preventDefault();
    if (selectedItemIds.has(item.id)) {
        dragOverItem.current = null;
        dragOverIndex.current = null;
    } else {
        dragOverItem.current = item.id;
        dragOverIndex.current = index;
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    
    const clientY = e.clientY;
    const windowHeight = window.innerHeight;
    const windowWidth = window.innerWidth;
    const centerX = windowWidth / 2;

    // 画面中央より左に1/3以上移動したら左列に移動
    if (e.clientX < centerX - (e.currentTarget.clientWidth / 3)) {
      // 左列への移動判定
      if (columnType === 'candidate' && onMoveToColumn) {
        // 候補リストから実行モード列への移動
        const rect = e.currentTarget.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        const itemHeight = rect.height / items.length;
        const insertIndex = Math.floor(relativeY / itemHeight);
        setInsertPosition(insertIndex);
      } else if (columnType === 'execute' && onMoveToColumn) {
        // 実行モード列内での挿入位置表示
        const rect = e.currentTarget.getBoundingClientRect();
        const relativeY = e.clientY - rect.top;
        const itemHeight = rect.height / items.length;
        const insertIndex = Math.floor(relativeY / itemHeight);
        setInsertPosition(insertIndex);
      }
    } else {
      setInsertPosition(null);
    }

    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, -SCROLL_SPEED);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, SCROLL_SPEED);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setInsertPosition(null);
    
    const windowWidth = window.innerWidth;
    const centerX = windowWidth / 2;
    const targetColumn = columnType;
    const sourceColumn = e.dataTransfer.getData('sourceColumn') as 'execute' | 'candidate' | undefined;
    
    // 画面中央より左に1/3以上移動したら左列に移動
    if (e.clientX < centerX - (e.currentTarget.clientWidth / 3)) {
      if (targetColumn === 'execute' && sourceColumn === 'candidate' && onMoveToColumn) {
        // 候補リストから実行モード列への移動
        if (selectedItemIds.has(dragItem.current!)) {
          onMoveToColumn(Array.from(selectedItemIds));
        } else if (dragItem.current) {
          onMoveToColumn([dragItem.current]);
        }
        dragItem.current = null;
        dragOverItem.current = null;
        return;
      }
    }
    
    // 同じ列内での移動
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      if (sourceColumn === targetColumn) {
        onMoveItem(dragItem.current, dragOverItem.current, columnType);
      }
    }
    
    dragItem.current = null;
    dragOverItem.current = null;
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove('opacity-40');
    document.querySelectorAll('[data-is-selected="true"]').forEach(el => el.classList.remove('opacity-40'));
    dragItem.current = null;
    dragOverItem.current = null;
    dragOverIndex.current = null;
    setInsertPosition(null);
    e.dataTransfer.clearData();
  };

  if (items.length === 0) {
      return (
        <div 
          ref={containerRef}
          className="text-center text-slate-500 dark:text-slate-400 py-12 min-h-[200px] border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg relative"
          onDragOver={(e) => {
            e.preventDefault();
            const windowWidth = window.innerWidth;
            const centerX = windowWidth / 2;
            if (e.clientX < centerX - (e.currentTarget.clientWidth / 3)) {
              e.currentTarget.classList.add('bg-blue-50', 'dark:bg-blue-900/20');
            }
          }}
          onDragLeave={(e) => {
            e.currentTarget.classList.remove('bg-blue-50', 'dark:bg-blue-900/20');
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.currentTarget.classList.remove('bg-blue-50', 'dark:bg-blue-900/20');
            const sourceColumn = e.dataTransfer.getData('sourceColumn') as 'execute' | 'candidate' | undefined;
            const windowWidth = window.innerWidth;
            const centerX = windowWidth / 2;
            if (e.clientX < centerX - (e.currentTarget.clientWidth / 3) && columnType === 'execute' && sourceColumn === 'candidate' && onMoveToColumn) {
              const dragId = dragItem.current;
              if (dragId) {
                if (selectedItemIds.has(dragId)) {
                  onMoveToColumn(Array.from(selectedItemIds));
                } else {
                  onMoveToColumn([dragId]);
                }
              }
            }
          }}
        >
          この日のアイテムはありません。
          {columnType === 'execute' && <div className="text-xs mt-2">右列からアイテムをドラッグ&ドロップできます</div>}
        </div>
      );
  }

  return (
    <div 
      ref={containerRef}
      className="space-y-4 pb-24 relative"
      onDragOver={(e) => {
        if (e.currentTarget === e.target) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        if (e.currentTarget === e.target) {
          e.preventDefault();
          const sourceColumn = e.dataTransfer.getData('sourceColumn') as 'execute' | 'candidate' | undefined;
          const windowWidth = window.innerWidth;
          const centerX = windowWidth / 2;
          if (e.clientX < centerX - (e.currentTarget.clientWidth / 3) && columnType === 'execute' && sourceColumn === 'candidate' && onMoveToColumn) {
            const dragId = dragItem.current;
            if (dragId) {
              if (selectedItemIds.has(dragId)) {
                onMoveToColumn(Array.from(selectedItemIds));
              } else {
                onMoveToColumn([dragId]);
              }
            }
          }
        }
      }}
    >
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {/* 挿入位置インジケーター */}
          {insertPosition === index && columnType === 'execute' && (
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
          {insertPosition === items.length && index === items.length - 1 && columnType === 'execute' && (
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
