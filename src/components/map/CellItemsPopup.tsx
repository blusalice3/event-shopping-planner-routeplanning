import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  onAddItem?: (item: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => void;
  eventDate?: string;
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
  onUpdateItem,
  onDeleteItem,
  onAddItem,
  eventDate,
  position,
}) => {
  const popupRef = useRef<HTMLDivElement>(null);
  const [longPressItem, setLongPressItem] = useState<ShoppingItem | null>(null);
  const [editingItem, setEditingItem] = useState<ShoppingItem | null>(null);
  const longPressTimeout = useRef<number | null>(null);
  const isLongPress = useRef(false);
  const [popupSize, setPopupSize] = useState({ width: 320, height: 300 });

  // === アイテム追加ダイアログ ===
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newItemForm, setNewItemForm] = useState({
    circle: '',
    title: '',
    price: '',
    quantity: '1',
    remarks: '',
    url: '',
    numberOverride: '',
    purchaseStatus: 'None' as 'None' | 'Purchased' | 'Postpone' | 'Late',
  });

  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);

  const handlePriceInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9]/g, '');
    setNewItemForm(prev => ({ ...prev, price: value }));
  }, []);

  const handlePriceSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setNewItemForm(prev => ({ ...prev, price: e.target.value }));
  }, []);

  const openAddDialog = useCallback(() => {
    setNewItemForm({ circle: '', title: '', price: '', quantity: '1', remarks: '', url: '', numberOverride: String(number), purchaseStatus: 'None' });
    setAddDialogOpen(true);
  }, [number]);

  const closeAddDialog = useCallback(() => {
    setAddDialogOpen(false);
  }, []);

  const handleAddItem = useCallback(() => {
    if (!onAddItem || !newItemForm.circle.trim()) return;
    const price = newItemForm.price === '' ? null : parseInt(newItemForm.price, 10) || 0;
    onAddItem({
      eventDate: eventDate || '',
      block: blockName,
      number: newItemForm.numberOverride || String(number),
      circle: newItemForm.circle,
      title: newItemForm.title,
      price,
      quantity: parseInt(newItemForm.quantity, 10) || 1,
      remarks: newItemForm.remarks,
      url: newItemForm.url || undefined,
      purchaseStatus: newItemForm.purchaseStatus,
    });
    closeAddDialog();
    onClose();
  }, [onAddItem, newItemForm, eventDate, blockName, number, closeAddDialog, onClose]);

  // ポップアップサイズを測定
  useEffect(() => {
    if (popupRef.current && isOpen) {
      const rect = popupRef.current.getBoundingClientRect();
      setPopupSize({ width: rect.width, height: rect.height });
    }
  }, [isOpen, items.length]);

  // ダイアログが閉じたらサブ状態もリセット
  useEffect(() => {
    if (!isOpen) {
      setAddDialogOpen(false);
      setLongPressItem(null);
      setEditingItem(null);
    }
  }, [isOpen]);

  // 最適なポップアップ位置を計算
  const computedPosition = useMemo(() => {
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const padding = 16;
    const offsetFromClick = 40;
    const isMobileOrTablet = screenWidth <= 768;
    let x: number;
    let y: number;
    if (isMobileOrTablet) {
      x = Math.max(padding, Math.min(
        position.x - popupSize.width / 2,
        screenWidth - popupSize.width - padding
      ));
      const isLeftSide = position.x < screenWidth / 2;
      x = isLeftSide
        ? Math.max(padding, padding)
        : Math.max(padding, screenWidth - popupSize.width - padding);
      y = screenHeight - popupSize.height - padding - 60;
    } else {
      if (position.x < screenWidth / 2) {
        x = Math.min(position.x + offsetFromClick, screenWidth - popupSize.width - padding);
      } else {
        x = Math.max(padding, position.x - popupSize.width - offsetFromClick);
      }
      y = position.y - popupSize.height / 2;
      y = Math.max(padding + 104, Math.min(y, screenHeight - popupSize.height - padding));
    }
    return { x, y };
  }, [position, popupSize]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        if (!longPressItem && !editingItem && !addDialogOpen) {
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
  }, [isOpen, onClose, longPressItem, editingItem, addDialogOpen]);

  const handleItemPointerDown = (item: ShoppingItem) => {
    isLongPress.current = false;
    longPressTimeout.current = window.setTimeout(() => {
      isLongPress.current = true;
      setLongPressItem(item);
    }, 500);
  };

  const handleItemPointerUp = (item: ShoppingItem) => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
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

  const handleVisitToggle = (item: ShoppingItem) => {
    if (executeModeItemIds.has(item.id)) {
      onRemoveFromVisitList(item.id);
    } else {
      onAddToVisitList(item.id);
    }
  };

  const handleEdit = () => {
    if (longPressItem) {
      setEditingItem({ ...longPressItem });
      setLongPressItem(null);
    }
  };

  const handleOpenUrl = () => {
    if (longPressItem?.url) {
      window.open(longPressItem.url, '_blank', 'noopener,noreferrer');
      setLongPressItem(null);
    }
  };

  const handleDelete = () => {
    if (longPressItem && onDeleteItem) {
      if (confirm(`「${longPressItem.title || longPressItem.circle}」を削除しますか？`)) {
        onDeleteItem(longPressItem.id);
        setLongPressItem(null);
      }
    }
  };

  const handleSaveEdit = () => {
    if (editingItem && onUpdateItem) {
      onUpdateItem(editingItem);
      setEditingItem(null);
    }
  };

  if (!isOpen) return null;

  const formInputClass = "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white";
  const labelClass = "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";

  return (
    <>
      <div
        ref={popupRef}
        className="fixed z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 max-w-sm w-80 transition-all duration-150"
        style={{ left: computedPosition.x, top: computedPosition.y }}
      >
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <h3 className="font-semibold text-slate-900 dark:text-white">
            {blockName}-{number} {items.length > 0 ? `（${items.length}件）` : ''}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 新規追加ボタン */}
        {onAddItem && (
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
            <button
              onClick={openAddDialog}
              className="w-full py-2 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              新規アイテム追加
            </button>
          </div>
        )}

        {/* アイテムリスト */}
        <div className="max-h-80 overflow-y-auto">
          {items.length === 0 && !onAddItem && (
            <div className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
              このセルにはアイテムがありません
            </div>
          )}
          {items.map((item) => {
            const isInVisitList = executeModeItemIds.has(item.id);
            const numberSuffix = item.number.replace(/^\d+/, '');
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
                      {isInVisitList && <span className="text-blue-500">📍</span>}
                      <span className="font-medium text-slate-900 dark:text-white">{item.circle}</span>
                      {numberSuffix && (
                        <span className="text-sm font-medium text-slate-500 dark:text-slate-400">[{numberSuffix}]</span>
                      )}
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">{item.title}</p>
                    {item.price !== null && (
                      <p className="text-sm text-slate-500 dark:text-slate-500 mt-1">頒布価格: ¥{item.price.toLocaleString()}</p>
                    )}
                    {item.remarks && (
                      <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">備考: {item.remarks}</p>
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
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-2 text-right">長押しで編集・削除</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* 長押しメニュー */}
      {longPressItem && (
        <div className="fixed inset-0 bg-black/30 z-[60] flex items-center justify-center" onClick={() => setLongPressItem(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-64" onClick={(e) => e.stopPropagation()}>
            <div className="p-3 border-b border-slate-200 dark:border-slate-700">
              <div className="font-medium text-slate-900 dark:text-white truncate">{longPressItem.circle}</div>
              {longPressItem.title && (
                <div className="text-sm text-slate-500 dark:text-slate-400 truncate">{longPressItem.title}</div>
              )}
            </div>
            <div className="py-1">
              <button onClick={handleEdit} className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
                ✏️ 編集
              </button>
              {longPressItem.url && (
                <button onClick={handleOpenUrl} className="w-full px-4 py-2 text-left text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700">
                  🔗 URLを開く
                </button>
              )}
              {onDeleteItem && (
                <button onClick={handleDelete} className="w-full px-4 py-2 text-left text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20">
                  🗑️ 削除
                </button>
              )}
            </div>
            <div className="p-2 border-t border-slate-200 dark:border-slate-700">
              <button onClick={() => setLongPressItem(null)} className="w-full px-4 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded">
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 編集ダイアログ */}
      {editingItem && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" onClick={() => setEditingItem(null)}>
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-slate-200 dark:border-slate-700">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">アイテム編集</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">{editingItem.block}-{editingItem.number}</p>
            </div>
            <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">サークル名</label>
                <input type="text" value={editingItem.circle} onChange={(e) => setEditingItem({ ...editingItem, circle: e.target.value })} className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">タイトル</label>
                <input type="text" value={editingItem.title} onChange={(e) => setEditingItem({ ...editingItem, title: e.target.value })} className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white" />
              </div>
              {/* 頒布価格: ドロップダウン + 直接入力 */}
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">頒布価格</label>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={editingItem.price === null ? 'undecided' : (editingItem.price !== null && editingItem.price % 100 === 0 && editingItem.price >= 0 && editingItem.price <= 10000) ? String(editingItem.price) : 'custom'}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'undecided') {
                        setEditingItem({ ...editingItem, price: null });
                      } else if (v === 'custom') {
                        // カスタム選択時は現在値を維持
                      } else {
                        setEditingItem({ ...editingItem, price: parseInt(v, 10) });
                      }
                    }}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                  >
                    <option value="undecided">価格未定</option>
                    {Array.from({ length: 101 }, (_, i) => i * 100).map(p => (
                      <option key={p} value={p}>{p.toLocaleString()}円</option>
                    ))}
                    {editingItem.price !== null && (editingItem.price % 100 !== 0 || editingItem.price > 10000) && (
                      <option value="custom">{editingItem.price.toLocaleString()}円（手入力）</option>
                    )}
                  </select>
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={editingItem.price ?? ''}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        setEditingItem({ ...editingItem, price: raw === '' ? null : parseInt(raw, 10) });
                      }}
                      placeholder="直接入力"
                      className="w-full px-3 py-2 pr-8 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">円</span>
                  </div>
                </div>
                {editingItem.price === null && (
                  <p className="text-xs text-amber-500 mt-1">※ 価格未定</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">数量</label>
                  <select
                    value={editingItem.quantity}
                    onChange={(e) => setEditingItem({ ...editingItem, quantity: parseInt(e.target.value) || 1 })}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                  >
                    {Array.from({ length: 10 }, (_, i) => i + 1).map(num => (
                      <option key={num} value={num}>{num}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">購入状態</label>
                  <select value={editingItem.purchaseStatus} onChange={(e) => setEditingItem({ ...editingItem, purchaseStatus: e.target.value as PurchaseStatus })} className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white">
                    {PurchaseStatuses.map((status) => (
                      <option key={status} value={status}>{statusLabels[status]}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">備考</label>
                <textarea value={editingItem.remarks} onChange={(e) => setEditingItem({ ...editingItem, remarks: e.target.value })} rows={2} className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">URL</label>
                <input
                  type="url"
                  value={editingItem.url || ''}
                  onChange={(e) => setEditingItem({ ...editingItem, url: e.target.value || undefined })}
                  placeholder="https://example.com"
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                />
                {editingItem.url && (
                  <a href={editingItem.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 mt-1">
                    🔗 開く
                  </a>
                )}
              </div>
            </div>
            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2 justify-end">
              <button onClick={() => setEditingItem(null)} className="px-4 py-2 text-sm text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded">キャンセル</button>
              <button onClick={handleSaveEdit} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 新規アイテム追加ダイアログ */}
      {addDialogOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={closeAddDialog}>
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4">
              <h2 className="text-lg font-bold">新規アイテム追加</h2>
              <p className="text-sm opacity-80 mt-1">{eventDate} {blockName}-{number}</p>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>サークル名 <span className="text-red-500">*</span></label>
                  <input type="text" value={newItemForm.circle} onChange={(e) => setNewItemForm(prev => ({ ...prev, circle: e.target.value }))} className={formInputClass} placeholder="サークル名" autoFocus />
                </div>
                <div>
                  <label className={labelClass}>タイトル</label>
                  <input type="text" value={newItemForm.title} onChange={(e) => setNewItemForm(prev => ({ ...prev, title: e.target.value }))} className={formInputClass} placeholder="新刊セット" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className={labelClass}>参加日</label>
                  <input type="text" value={eventDate || ''} readOnly className={`${formInputClass} bg-slate-100 dark:bg-slate-700`} />
                </div>
                <div>
                  <label className={labelClass}>ブロック</label>
                  <input type="text" value={blockName} readOnly className={`${formInputClass} bg-slate-100 dark:bg-slate-700`} />
                </div>
                <div>
                  <label className={labelClass}>ナンバー</label>
                  <input type="text" value={newItemForm.numberOverride} onChange={(e) => setNewItemForm(prev => ({ ...prev, numberOverride: e.target.value }))} className={formInputClass} placeholder="01a" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
                <div className="relative">
                  <label className={labelClass}>頒布価格</label>
                  <input type="text" value={newItemForm.price} onChange={handlePriceInputChange} className={`${formInputClass} pr-12`} placeholder="0" inputMode="numeric" />
                  <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">円</span>
                </div>
                <div>
                  <label className={labelClass}>クイック選択</label>
                  <select onChange={handlePriceSelectChange} className={formInputClass} value={priceOptions.includes(Number(newItemForm.price)) ? newItemForm.price : ""}>
                    <option value="" disabled>金額を選択...</option>
                    {priceOptions.map(p => <option key={p} value={p}>{p.toLocaleString()}円</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>数量</label>
                  <select value={newItemForm.quantity} onChange={(e) => setNewItemForm(prev => ({ ...prev, quantity: e.target.value }))} className={formInputClass}>
                    {Array.from({ length: 10 }, (_, i) => i + 1).map(num => (
                      <option key={num} value={num}>{num}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>購入状態</label>
                  <select value={newItemForm.purchaseStatus} onChange={(e) => setNewItemForm(prev => ({ ...prev, purchaseStatus: e.target.value as typeof newItemForm.purchaseStatus }))} className={formInputClass}>
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
                  <input type="text" value={newItemForm.remarks} onChange={(e) => setNewItemForm(prev => ({ ...prev, remarks: e.target.value }))} className={formInputClass} placeholder="スケブお願い" />
                </div>
                <div>
                  <label className={labelClass}>URL</label>
                  <input type="text" value={newItemForm.url} onChange={(e) => setNewItemForm(prev => ({ ...prev, url: e.target.value }))} className={formInputClass} placeholder="https://example.com" />
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
              <button onClick={closeAddDialog} className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors">キャンセル</button>
              <button onClick={handleAddItem} disabled={!newItemForm.circle.trim()} className="flex-1 py-2 px-4 bg-green-600 hover:bg-green-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors">リストに追加</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default CellItemsPopup;
