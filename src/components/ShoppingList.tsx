import React from 'react';
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

const ShoppingList: React.FC<ShoppingListProps> = ({
  items,
  onUpdateItem,
  onMoveItem: _onMoveItem,
  onEditRequest,
  onDeleteRequest,
  selectedItemIds,
  onSelectItem,
  onMoveToColumn: _onMoveToColumn,
  onRemoveFromColumn: _onRemoveFromColumn,
  columnType: _columnType,
  currentDay: _currentDay,
}) => {
  if (items.length === 0) {
      return (
        <div className="text-center text-slate-500 dark:text-slate-400 py-12 min-h-[200px] border-2 border-dashed border-slate-300 dark:border-slate-600 rounded-lg relative">
          この日のアイテムはありません。
        </div>
      );
  }

  return (
    <div className="space-y-4 pb-24 relative">
      {items.map((item, index) => (
        <div
          key={item.id}
          data-item-id={item.id}
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
      ))}
    </div>
  );
};

export default ShoppingList;
