import React, { useState, useCallback, useMemo } from 'react';
import type { ShoppingItem, PurchaseStatus } from '../types/item';
import type { HallDefinition } from '../types/map';
import { findHallsByBlockName } from '../utils/hallFallback';

interface ItemEditDialogProps {
  item: ShoppingItem;
  onSave: (updatedItem: ShoppingItem) => void;
  onClose: () => void;
  allItems?: ShoppingItem[];
  halls?: HallDefinition[];
  onPriorityChange?: (itemId: string, level: 'none' | 'priority' | 'highest') => void;
}

export const ItemEditDialog: React.FC<ItemEditDialogProps> = ({
  item,
  onSave,
  onClose,
  allItems = [],
  halls = [],
  onPriorityChange,
}) => {
  const [form, setForm] = useState({
    circle: item.circle,
    title: item.title,
    eventDate: item.eventDate,
    block: item.block,
    number: item.number,
    price: item.price === null ? '' : String(item.price),
    quantity: String(item.quantity ?? 1),
    purchaseStatus: item.purchaseStatus as string,
    remarks: item.remarks,
    url: item.url || '',
    priorityLevel: (item.priorityLevel || 'none') as 'none' | 'priority' | 'highest',
    manualHallId: item.manualHallId || '',
  });

  // 現在のブロックが属するホール候補（blockNamesに含まれているホール）
  const blockHallCandidates = useMemo(
    () => findHallsByBlockName(form.block, halls),
    [form.block, halls],
  );
  // 複数ホール所属ブロックの場合にホール選択UIを表示
  const showHallSelector = blockHallCandidates.length > 1;

  const formInputClass =
    'w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white';
  const labelClass = 'block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1';

  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);

  const handlePriceInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/[^0-9]/g, '');
    setForm((prev) => ({ ...prev, price: value }));
  }, []);

  const handlePriceSelectChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, price: e.target.value }));
  }, []);

  const handleSave = useCallback(() => {
    if (!form.circle.trim()) return;
    const price = form.price === '' ? null : parseInt(form.price, 10) || 0;
    const updatedItem: ShoppingItem = {
      ...item,
      circle: form.circle,
      title: form.title,
      eventDate: form.eventDate,
      block: form.block,
      number: form.number,
      price,
      quantity: parseInt(form.quantity, 10) || 1,
      purchaseStatus: form.purchaseStatus as PurchaseStatus,
      remarks: form.remarks,
      url: form.url || undefined,
      priorityLevel: form.priorityLevel,
      manualHallId: form.manualHallId || undefined,
    };
    onSave(updatedItem);
    // priority 変更の反映は onSave 経由（handleUpdateItem + hallOrder 更新を App 側で統合）に一本化。
    // 旧 onPriorityChange による二重 setEventLists は race condition の原因だったため廃止。
  }, [form, item, onSave]);

  const circleSuggestions = useMemo(
    () => [...new Set(allItems.map((i) => i.circle).filter(Boolean))],
    [allItems],
  );

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 text-white p-4">
          <h2 className="text-lg font-bold">アイテム編集</h2>
          <p className="text-sm opacity-80 mt-1">
            {form.eventDate} {form.block}-{form.number}
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>
                サークル名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.circle}
                onChange={(e) => setForm((prev) => ({ ...prev, circle: e.target.value }))}
                className={formInputClass}
                placeholder="サークル名"
                autoFocus
                list="edit-circle-suggestions"
              />
              {circleSuggestions.length > 0 && (
                <datalist id="edit-circle-suggestions">
                  {circleSuggestions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              )}
            </div>
            <div>
              <label className={labelClass}>タイトル</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                className={formInputClass}
                placeholder="新刊セット"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>参加日</label>
              <input
                type="text"
                value={form.eventDate}
                onChange={(e) => setForm((prev) => ({ ...prev, eventDate: e.target.value }))}
                className={formInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>ブロック</label>
              <input
                type="text"
                value={form.block}
                onChange={(e) => setForm((prev) => ({ ...prev, block: e.target.value }))}
                className={formInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>ナンバー</label>
              <input
                type="text"
                value={form.number}
                onChange={(e) => setForm((prev) => ({ ...prev, number: e.target.value }))}
                className={formInputClass}
                placeholder="01a"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div className="relative">
              <label className={labelClass}>頒布価格</label>
              <input
                type="text"
                value={form.price}
                onChange={handlePriceInputChange}
                className={`${formInputClass} pr-12`}
                placeholder="0"
                inputMode="numeric"
              />
              <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">円</span>
            </div>
            <div>
              <label className={labelClass}>クイック選択</label>
              <select
                onChange={handlePriceSelectChange}
                className={formInputClass}
                value={priceOptions.includes(Number(form.price)) ? form.price : ''}
              >
                <option value="" disabled>
                  金額を選択...
                </option>
                {priceOptions.map((p) => (
                  <option key={p} value={p}>
                    {p.toLocaleString()}円
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>数量</label>
              <select
                value={form.quantity}
                onChange={(e) => setForm((prev) => ({ ...prev, quantity: e.target.value }))}
                className={formInputClass}
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map((num) => (
                  <option key={num} value={num}>
                    {num}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>購入状態</label>
              <select
                value={form.purchaseStatus}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    purchaseStatus: e.target.value,
                  }))
                }
                className={formInputClass}
              >
                <option value="None">未購入</option>
                <option value="Purchased">購入済</option>
                <option value="Postpone">後回し</option>
                <option value="Late">遅参</option>
              </select>
            </div>
          </div>
          {showHallSelector && (
            <div className="border border-amber-200 dark:border-amber-700/50 bg-amber-50/50 dark:bg-amber-900/20 rounded-lg p-3">
              <label className={labelClass}>
                ホール設定
                <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">
                  （ブロック「{form.block}」は複数ホールに所属）
                </span>
              </label>
              <select
                value={form.manualHallId}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, manualHallId: e.target.value }))
                }
                className={formInputClass}
              >
                <option value="">自動判定（いずれか1つに決定できない場合は未割当）</option>
                {blockHallCandidates.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                このブロックが属するホールを選択してください
              </p>
            </div>
          )}
          {onPriorityChange && (
            <div>
              <label className={labelClass}>優先度</label>
              <select
                value={form.priorityLevel}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    priorityLevel: e.target.value as 'none' | 'priority' | 'highest',
                  }))
                }
                className={formInputClass}
              >
                <option value="none">なし（通常）</option>
                <option value="priority">優先</option>
                <option value="highest">最優先</option>
              </select>
              {form.priorityLevel !== 'none' && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${form.priorityLevel === 'highest' ? 'bg-red-500' : 'bg-orange-500'}`}
                  />
                  <span className={`text-xs ${form.priorityLevel === 'highest' ? 'text-red-600 dark:text-red-400' : 'text-orange-600 dark:text-orange-400'}`}>
                    {form.priorityLevel === 'highest' ? '最優先アイテムとして設定されます' : '優先アイテムとして設定されます'}
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>備考</label>
              <input
                type="text"
                value={form.remarks}
                onChange={(e) => setForm((prev) => ({ ...prev, remarks: e.target.value }))}
                className={formInputClass}
                placeholder="スケブお願い"
              />
            </div>
            <div>
              <label className={labelClass}>URL</label>
              <input
                type="text"
                value={form.url}
                onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                className={formInputClass}
                placeholder="https://example.com"
              />
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={!form.circle.trim()}
            className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
};
