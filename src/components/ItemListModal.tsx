import React, { useState, useRef, useEffect } from 'react';
import { ShoppingItem, RoutePoint } from '../types';

interface ItemListModalProps {
  items: ShoppingItem[];
  cellInfo: {
    row: number;
    col: number;
    eventDate: string;
    block: string;
    number: string;
  };
  routePoints: RoutePoint[];
  onItemSelect: (item: ShoppingItem, isVisiting: boolean) => void;
  onClose: () => void;
}

const ItemListModal: React.FC<ItemListModalProps> = ({
  items,
  cellInfo,
  routePoints,
  onItemSelect,
  onClose,
}) => {
  const [longPressItem, setLongPressItem] = useState<ShoppingItem | null>(null);
  const longPressTimeoutRef = useRef<number | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modalRef.current && !modalRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleItemLongPress = (item: ShoppingItem) => {
    setLongPressItem(item);
  };

  const handleItemPointerDown = (item: ShoppingItem) => {
    longPressTimeoutRef.current = window.setTimeout(() => {
      handleItemLongPress(item);
    }, 500);
  };

  const handleItemPointerUp = () => {
    if (longPressTimeoutRef.current) {
      clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  const isItemVisiting = (item: ShoppingItem): boolean => {
    return routePoints.some(point => 
      point.row === cellInfo.row &&
      point.col === cellInfo.col &&
      point.itemIds.includes(item.id)
    );
  };

  const handleMenuAction = (item: ShoppingItem, action: 'add' | 'remove') => {
    onItemSelect(item, action === 'add');
    setLongPressItem(null);
  };

  if (items.length === 0) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div ref={modalRef} className="bg-white dark:bg-slate-800 rounded-lg p-6 max-w-md w-full mx-4">
          <h2 className="text-lg font-bold mb-4">該当するアイテムがありません</h2>
          <button
            onClick={onClose}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            閉じる
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        ref={modalRef}
        className="bg-white dark:bg-slate-800 rounded-lg p-4 max-w-2xl w-full mx-4 max-h-[60vh] overflow-y-auto"
      >
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">
            {cellInfo.eventDate} {cellInfo.block}-{cellInfo.number}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2">
          {items.map(item => {
            const isVisiting = isItemVisiting(item);
            const isLongPressed = longPressItem?.id === item.id;

            return (
              <div
                key={item.id}
                className="relative"
                onPointerDown={() => handleItemPointerDown(item)}
                onPointerUp={handleItemPointerUp}
                onPointerLeave={handleItemPointerUp}
              >
                <div className={`p-2 rounded ${isVisiting ? 'bg-red-50 dark:bg-red-900/20' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="font-medium">{item.circle}</div>
                      <div className="text-sm text-slate-600 dark:text-slate-400">{item.title}</div>
                      {item.price !== null && (
                        <div className="text-sm text-slate-600 dark:text-slate-400">
                          ¥{item.price.toLocaleString()}
                        </div>
                      )}
                    </div>
                    {isVisiting && (
                      <span className="text-xs bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200 px-2 py-1 rounded">
                        訪問先
                      </span>
                    )}
                  </div>
                </div>

                {isLongPressed && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded shadow-lg z-10">
                    <button
                      onClick={() => handleMenuAction(item, 'add')}
                      className="w-full px-4 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-600"
                    >
                      訪問先にする
                    </button>
                    {isVisiting && (
                      <button
                        onClick={() => handleMenuAction(item, 'remove')}
                        className="w-full px-4 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-600"
                      >
                        訪問先から除外
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ItemListModal;

