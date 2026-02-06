import React from 'react';
import { ShoppingItem } from '../../types';

export type InsertPosition =
  | { type: 'before'; referenceItemId: string }
  | { type: 'after'; referenceItemId: string }
  | { type: 'hallEnd' }
  | { type: 'listEnd' };

interface NearbyVisitItem {
  item: ShoppingItem;
  /** 訪問先リスト内でのインデックス（表示順ソート用） */
  visitIndex: number;
}

interface InsertPositionDialogProps {
  isOpen: boolean;
  /** 追加しようとしているアイテム */
  addingItem: ShoppingItem;
  /** 同ブロック±3以内で訪問先リストに存在するアイテム（visitIndex順） */
  nearbyVisitItems: NearbyVisitItem[];
  /** ホール定義が特定できるか */
  hasHallDefinition: boolean;
  onSelect: (position: InsertPosition) => void;
  onCancel: () => void;
}

/** アイテムのナンバー数値部分を抽出 */
const extractNumeric = (number: string): number => {
  const match = number.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
};

const InsertPositionDialog: React.FC<InsertPositionDialogProps> = ({
  isOpen,
  addingItem,
  nearbyVisitItems,
  hasHallDefinition,
  onSelect,
  onCancel,
}) => {
  if (!isOpen) return null;

  // visitIndex順にソート
  const sorted = [...nearbyVisitItems].sort((a, b) => a.visitIndex - b.visitIndex);

  const addingNum = extractNumeric(addingItem.number);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-[340px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* ヘッダー */}
        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 text-white px-4 py-3">
          <div className="text-sm font-bold">追加位置を選択</div>
          <div className="text-xs opacity-90 mt-1">
            {addingItem.block}-{addingItem.number}
            {addingItem.circle ? ` (${addingItem.circle})` : ''}
          </div>
        </div>

        {/* 選択肢 */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sorted.map((nearby) => {
            const nearbyNum = extractNumeric(nearby.item.number);
            const label = `${nearby.item.block}-${nearby.item.number}`;
            const circle = nearby.item.circle ? ` ${nearby.item.circle}` : '';
            // 訪問先リスト内での順番を1始まりで表示
            const orderLabel = `#${nearby.visitIndex + 1}`;

            return (
              <div key={nearby.item.id} className="rounded-lg border border-slate-200 dark:border-slate-600 overflow-hidden">
                {/* 参照アイテム情報 */}
                <div className="bg-slate-50 dark:bg-slate-700/50 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-300 flex items-center gap-2">
                  <span className="bg-slate-200 dark:bg-slate-600 px-1.5 py-0.5 rounded text-[10px] font-mono">{orderLabel}</span>
                  <span className="font-semibold">{label}</span>
                  <span className="truncate text-slate-500 dark:text-slate-400">{circle}</span>
                  {nearbyNum !== 0 && (
                    <span className="ml-auto text-[10px] text-slate-400">
                      {nearbyNum < addingNum ? `Δ-${addingNum - nearbyNum}` : nearbyNum > addingNum ? `Δ+${nearbyNum - addingNum}` : '同番'}
                    </span>
                  )}
                </div>
                {/* 上・下ボタン */}
                <div className="flex divide-x divide-slate-200 dark:divide-slate-600">
                  <button
                    onClick={() => onSelect({ type: 'before', referenceItemId: nearby.item.id })}
                    className="flex-1 px-3 py-2.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="text-base">↑</span> この上に追加
                  </button>
                  <button
                    onClick={() => onSelect({ type: 'after', referenceItemId: nearby.item.id })}
                    className="flex-1 px-3 py-2.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="text-base">↓</span> この下に追加
                  </button>
                </div>
              </div>
            );
          })}

          {/* 区切り線 */}
          <div className="border-t border-slate-200 dark:border-slate-600 my-1" />

          {/* ホール末尾 */}
          {hasHallDefinition && (
            <button
              onClick={() => onSelect({ type: 'hallEnd' })}
              className="w-full px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
            >
              <span className="text-base">🏢</span>
              同ホールの末尾に追加
            </button>
          )}

          {/* リスト末尾 */}
          <button
            onClick={() => onSelect({ type: 'listEnd' })}
            className="w-full px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
          >
            <span className="text-base">📋</span>
            リスト末尾に追加
          </button>
        </div>

        {/* キャンセル */}
        <div className="border-t border-slate-200 dark:border-slate-600 p-2">
          <button
            onClick={onCancel}
            className="w-full px-3 py-2 text-sm text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
};

export default InsertPositionDialog;
