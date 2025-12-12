import React, { useState, useRef, useEffect } from 'react';
import { ShoppingItem, PurchaseStatus } from '../../types';

interface CellItemsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  blockName: string;
  number: number;
  items: ShoppingItem[];
  executeModeItemIds: Set<string>;
  onAddToVisitList: (itemId: string) => void;
  onRemoveFromVisitList: (itemId: string) => void;
  position: { x: number; y: number };
}

const statusLabels: Record<PurchaseStatus, string> = {
  None: '未購入',
  Purchased: '購入済',
  SoldOut: '売切',
  Absent: '欠席',
  Postpone: '後回し',
  Late: '遅参',
};

const CellItemsPopup: React.FC<CellItemsPopupProps> = ({
  isOpen,
  onClose,
  blockName,
  number,
  items,
  executeModeItemIds,
  onAddToVisitList,
  onRemoveFromVisitList,
  position,
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  const [longPressItemId, setLongPressItemId] = useState<string | null>(null);
  const longPressTimeout = useRef<number | null>(null);
  
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose]);
  
  const handleItemPointerDown = (itemId: string) => {
    longPressTimeout.current = window.setTimeout(() => {
      setLongPressItemId(itemId);
    }, 500);
  };
  
  const handleItemPointerUp = () => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };
  
  const handleAddToVisit = (itemId: string) => {
    onAddToVisitList(itemId);
    setLongPressItemId(null);
  };
  
  const handleRemoveFromVisit = (itemId: string) => {
    onRemoveFromVisitList(itemId);
    setLongPressItemId(null);
  };
  
  if (!isOpen) return null;
  
  return (
    <div
      ref={popupRef}
      className="fixed z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 max-w-sm w-80"
      style={{
        left: Math.min(position.x, window.innerWidth - 340),
        top: Math.min(position.y, window.innerHeight - 400),
      }}
    >
      {/* ヘッダー */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
        <h3 className="font-semibold text-slate-900 dark:text-white">
          {blockName}-{number} のアイテム（{items.length}件）
        </h3>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      
      {/* アイテムリスト */}
      <div className="max-h-80 overflow-y-auto">
        {items.map((item) => {
          const isInVisitList = executeModeItemIds.has(item.id);
          
          return (
            <div
              key={item.id}
              className={`relative p-4 border-b border-slate-100 dark:border-slate-700 last:border-b-0 ${
                isInVisitList ? 'bg-red-50 dark:bg-red-900/20' : ''
              }`}
              onPointerDown={() => handleItemPointerDown(item.id)}
              onPointerUp={handleItemPointerUp}
              onPointerLeave={handleItemPointerUp}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {isInVisitList && (
                      <span className="text-red-500">📍</span>
                    )}
                    <span className="font-medium text-slate-900 dark:text-white">
                      {item.circle}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    {item.title}
                  </p>
                  {item.price !== null && (
                    <p className="text-sm text-slate-500 dark:text-slate-500 mt-1">
                      頒布価格: ¥{item.price.toLocaleString()}
                    </p>
                  )}
                  {item.remarks && (
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                      備考: {item.remarks}
                    </p>
                  )}
                  {item.purchaseStatus !== 'None' && (
                    <span className={`inline-block mt-2 px-2 py-0.5 text-xs rounded-full ${
                      item.purchaseStatus === 'Purchased' ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300' :
                      item.purchaseStatus === 'SoldOut' ? 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300' :
                      'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300'
                    }`}>
                      {statusLabels[item.purchaseStatus]}
                    </span>
                  )}
                </div>
              </div>
              
              {/* 長押しメニュー */}
              {longPressItemId === item.id && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 bg-white dark:bg-slate-900 rounded-md shadow-lg border border-slate-200 dark:border-slate-700 z-10">
                  {isInVisitList ? (
                    <button
                      onClick={() => handleRemoveFromVisit(item.id)}
                      className="block w-full px-4 py-2 text-sm text-left text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/50 rounded-md"
                    >
                      訪問先から除外
                    </button>
                  ) : (
                    <button
                      onClick={() => handleAddToVisit(item.id)}
                      className="block w-full px-4 py-2 text-sm text-left text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/50 rounded-md"
                    >
                      訪問先にする
                    </button>
                  )}
                </div>
              )}
              
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-right">
                長押しでメニュー
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CellItemsPopup;
