
import React, { useRef } from 'react';
import { ShoppingItem } from '../types';
import ShoppingItemCard from './ShoppingItemCard';

interface ShoppingListProps {
  items: ShoppingItem[];
  onUpdateItem: (item: ShoppingItem) => void;
  onMoveItem: (dragId: string, hoverId: string) => void;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  selectedItemIds: Set<string>;
  onSelectItem: (itemId: string) => void;
}

// Constants for drag-and-drop auto-scrolling
const SCROLL_SPEED = 20; // Speed of scrolling in pixels
const TOP_SCROLL_TRIGGER_PX = 150; // Trigger zone from the top of the viewport (header/tabs area)
const BOTTOM_SCROLL_TRIGGER_PX = 100; // Trigger zone from the bottom of the viewport (summary bar area)

const ShoppingList: React.FC<ShoppingListProps> = ({
  items,
  onUpdateItem,
  onMoveItem,
  onEditRequest,
  onDeleteRequest,
  selectedItemIds,
  onSelectItem,
}) => {
  const dragItem = useRef<string | null>(null);
  const dragOverItem = useRef<string | null>(null);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    dragItem.current = item.id;
    const target = e.currentTarget; // Cache target to avoid issues with React event pooling
    setTimeout(() => {
        if(target) {
            target.classList.add('opacity-40');
        }
        if (selectedItemIds.has(item.id)) {
            document.querySelectorAll('[data-is-selected="true"]').forEach(el => el.classList.add('opacity-40'));
        }
    }, 0);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, item: ShoppingItem) => {
    e.preventDefault();
    // Prevent dropping a selection onto itself
    if (selectedItemIds.has(item.id)) {
        dragOverItem.current = null;
    } else {
        dragOverItem.current = item.id;
    }
  };
  
  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    
    const clientY = e.clientY;
    const windowHeight = window.innerHeight;

    if (clientY < TOP_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, -SCROLL_SPEED);
    } else if (clientY > windowHeight - BOTTOM_SCROLL_TRIGGER_PX) {
      window.scrollBy(0, SCROLL_SPEED);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      onMoveItem(dragItem.current, dragOverItem.current);
    }
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    e.currentTarget.classList.remove('opacity-40');
    document.querySelectorAll('[data-is-selected="true"]').forEach(el => el.classList.remove('opacity-40'));
    dragItem.current = null;
    dragOverItem.current = null;
  };

  if (items.length === 0) {
      return <div className="text-center text-slate-500 dark:text-slate-400 py-12">この日のアイテムはありません。</div>
  }

  return (
    <div className="space-y-4 pb-24">
      {items.map((item, index) => (
        <div
          key={item.id}
          data-item-id={item.id}
          draggable
          onDragStart={(e) => handleDragStart(e, item)}
          onDragEnter={(e) => handleDragEnter(e, item)}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
          className="transition-opacity duration-200"
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
      ))}
    </div>
  );
};

export default ShoppingList;
