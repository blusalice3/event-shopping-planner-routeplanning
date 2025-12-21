import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ShoppingItem, PurchaseStatus, PurchaseStatuses } from '../../types';

interface CellItemsPopupProps {
  isOpen: boolean;
  onClose: () => void;
  blockName: string;
  number: number;
  items: ShoppingItem[];
  executeModeItemIds: Set<string>;
  onAddToVisitList: (itemId: string) => void;
  onRemoveFromVisitList: (itemId: string) => void;
  onUpdateItem?: (item: ShoppingItem) => void;
  onDeleteItem?: (itemId: string) => void;
  position: { x: number; y: number };  // クリック位置
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
  onUpdateItem,
  onDeleteItem,
  position,
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  const [longPressItem, setLongPressItem] = useState<ShoppingItem | null>(null);
  const [editingItem, setEditingItem] = useState<ShoppingItem | null>(null);
  const longPressTimeout = useRef<number | null>(null);
  const isLongPress = useRef(false);
  const [popupSize, setPopupSize] = useState({ width: 320, height: 300 });
  
  // ポップアップサイズを測定
  useEffect(() => {
    if (popupRef.current && isOpen) {
      const rect = popupRef.current.getBoundingClientRect();
      setPopupSize({ width: rect.width, height: rect.height });
    }
  }, [isOpen, items.length]);
  
  // 最適なポップアップ位置を計算
  const computedPosition = useMemo(() => {
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const padding = 16; // 画面端からのマージン
    const offsetFromClick = 40; // クリック位置からの距離
    
    // モバイル/タブレット判定（画面幅768px以下）
    const isMobileOrTablet = screenWidth <= 768;
    
    let x: number;
    let y: number;
    
    if (isMobileOrTablet) {
      // モバイル/タブレット: 画面下部に表示
      x = Math.max(padding, Math.min(
        position.x - popupSize.width / 2,
        screenWidth - popupSize.width - padding
      ));
      // 画面下部の左寄りまたは右寄り
      const isLeftSide = position.x < screenWidth / 2;
      x = isLeftSide 
        ? Math.max(padding, padding) 
        : Math.max(padding, screenWidth - popupSize.width - padding);
      y = screenHeight - popupSize.height - padding - 60; // 60pxは下部ナビゲーション用
    } else {
      // デスクトップ: クリック位置から少し離れた位置
      // 水平位置: クリック位置から離れた側に表示
      if (position.x < screenWidth / 2) {
        // クリックが左半分 → 右側に表示
        x = Math.min(position.x + offsetFromClick, screenWidth - popupSize.width - padding);
      } else {
        // クリックが右半分 → 左側に表示
        x = Math.max(padding, position.x - popupSize.width - offsetFromClick);
      }
      
      // 垂直位置: クリック位置を中心に、画面内に収まるように調整
      y = position.y - popupSize.height / 2;
      
      // 画面上端・下端の制限
      y = Math.max(padding + 104, Math.min(y, screenHeight - popupSize.height - padding));
    }
    
    return { x, y };
  }, [position, popupSize]);
  
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        if (!longPressItem && !editingItem) {
          onClose();
        }
      }
    };
    
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, longPressItem, editingItem]);
  
  // 長押し開始
  const handleItemPointerDown = (item: ShoppingItem) => {
    isLongPress.current = false;
    longPressTimeout.current = window.setTimeout(() => {
      isLongPress.current = true;
      setLongPressItem(item);
    }, 500);
  };
  
  // 長押し終了
  const handleItemPointerUp = (item: ShoppingItem) => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
    // 長押しでなければクリックとして処理
    if (!isLongPress.current) {
      handleVisitToggle(item);
    }
  };
  
  const handleItemPointerLeave = () => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  };
  
  // クリックで訪問先切り替え
  const handleVisitToggle = (item: ShoppingItem) => {
    if (executeModeItemIds.has(item.id)) {
      onRemoveFromVisitList(item.id);
    } else {
      onAddToVisitList(item.id);
    }
  };
  
  // 長押しメニュー：編集
  const handleEdit = () => {
    if (longPressItem) {
      setEditingItem({ ...longPressItem });
      setLongPressItem(null);
    }
  };
  
  // 長押しメニュー：URLを開く
  const handleOpenUrl = () => {
    if (longPressItem?.url) {
      window.open(longPressItem.url, '_blank', 'noopener,noreferrer');
      setLongPressItem(null);
    }
  };
  
  // 長押しメニュー：削除
  const handleDelete = () => {
    if (longPressItem && onDeleteItem) {
      if (confirm(`「${longPressItem.title || longPressItem.circle}」を削除しますか？`)) {
        onDeleteItem(longPressItem.id);
        setLongPressItem(null);
      }
    }
  };
  
  // 編集保存
  const handleSaveEdit = () => {
    if (editingItem && onUpdateItem) {
      onUpdateItem(editingItem);
      setEditingItem(null);
    }
  };
  
  if (!isOpen) return null;
  
  return (
    <>
      <div
        ref={popupRef}
        className="fixed z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 max-w-sm w-80 transition-all duration-150"
        style={{
          left: computedPosition.x,
          top: computedPosition.y,
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
                className={`relative p-4 border-b border-slate-100 dark:border-slate-700 last:border-b-0 cursor-pointer select-none ${
                  isInVisitList ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                }`}
                onPointerDown={() => handleItemPointerDown(item)}
                onPointerUp={() => handleItemPointerUp(item)}
                onPointerLeave={handleItemPointerLeave}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      {isInVisitList && (
                        <span className="text-blue-500">📍</span>
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
                  <div className={`text-xs px-2 py-1 rounded ${isInVisitList ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'}`}>
                    {isInVisitList ? '訪問先' : 'タップで追加'}
                  </div>
                </div>
                
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-right">
                  長押しで編集・削除
                </p>
              </div>
            );
          })}
        </div>
      </div>
      
      {/* 長押しメニュー（編集/URLを開く/削除） */}
      {longPressItem && (
        <div className="fixed inset-0 bg-black/30 z-[60] flex items-center justify-center" onClick={() => setLongPressItem(null)}>
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-64"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-slate-200 dark:border-slate-700">
              <div className="font-medium text-slate-900 dark:text-white truncate">{longPressItem.circle}</div>
              {longPressItem.title && (
                <div className="text-sm text-slate-500 dark:text-slate-400 truncate">{longPressItem.title}</div>
              )}
            </div>
            <div className="py-1">
              <button
                onClick={handleEdit}
                className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
              >
                ✏️ 編集
              </button>
              {longPressItem.url && (
                <button
                  onClick={handleOpenUrl}
                  className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  🔗 URLを開く
                </button>
              )}
              {onDeleteItem && (
                <button
                  onClick={handleDelete}
                  className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                >
                  🗑️ 削除
                </button>
              )}
            </div>
            <div className="p-2 border-t border-slate-200 dark:border-slate-700">
              <button
                onClick={() => setLongPressItem(null)}
                className="w-full px-4 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 編集ダイアログ */}
      {editingItem && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" onClick={() => setEditingItem(null)}>
          <div
            className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">アイテム編集</h3>
            </div>
            <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">サークル名</label>
                <input
                  type="text"
                  value={editingItem.circle}
                  onChange={(e) => setEditingItem({ ...editingItem, circle: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">タイトル</label>
                <input
                  type="text"
                  value={editingItem.title}
                  onChange={(e) => setEditingItem({ ...editingItem, title: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">価格</label>
                  <input
                    type="number"
                    value={editingItem.price ?? ''}
                    onChange={(e) => setEditingItem({ ...editingItem, price: e.target.value ? parseInt(e.target.value) : null })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">数量</label>
                  <input
                    type="number"
                    value={editingItem.quantity}
                    onChange={(e) => setEditingItem({ ...editingItem, quantity: parseInt(e.target.value) || 1 })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">購入状態</label>
                <select
                  value={editingItem.purchaseStatus}
                  onChange={(e) => setEditingItem({ ...editingItem, purchaseStatus: e.target.value as PurchaseStatus })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  {PurchaseStatuses.map((status) => (
                    <option key={status} value={status}>{statusLabels[status]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">備考</label>
                <textarea
                  value={editingItem.remarks}
                  onChange={(e) => setEditingItem({ ...editingItem, remarks: e.target.value })}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
              </div>
            </div>
            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2 justify-end">
              <button
                onClick={() => setEditingItem(null)}
                className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded"
              >
                キャンセル
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CellItemsPopup;
