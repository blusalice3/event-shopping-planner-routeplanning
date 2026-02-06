import React, { useMemo } from 'react';
import { ShoppingItem } from '../../types';

export type InsertPosition =
  | { type: 'before'; referenceItemId: string }
  | { type: 'after'; referenceItemId: string }
  | { type: 'hallEnd' }
  | { type: 'listEnd' };

export type SmartInsertMode = 'card' | 'preview';

interface NearbyVisitItem {
  item: ShoppingItem;
  /** 訪問先リスト内でのインデックス（表示順ソート用） */
  visitIndex: number;
}

interface VisitListEntry {
  item: ShoppingItem;
  visitIndex: number;
}

interface InsertPositionDialogProps {
  isOpen: boolean;
  /** 追加しようとしているアイテム */
  addingItem: ShoppingItem;
  /** 同ブロック±3以内で訪問先リストに存在するアイテム（visitIndex順） */
  nearbyVisitItems: NearbyVisitItem[];
  /** 訪問先リスト全体（preview用） */
  allVisitItems?: VisitListEntry[];
  /** ホール定義が特定できるか */
  hasHallDefinition: boolean;
  /** 表示モード */
  mode?: SmartInsertMode;
  onSelect: (position: InsertPosition) => void;
  onCancel: () => void;
}

/** アイテムのナンバー数値部分を抽出 */
const extractNumeric = (number: string): number => {
  const match = number.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
};

/** インデックスをA,B,C...に変換 */
const indexToLetter = (i: number): string => {
  return String.fromCharCode(65 + i); // A=65
};

// ===== カードモード =====
const CardMode: React.FC<{
  sorted: NearbyVisitItem[];
  addingNum: number;
  hasHallDefinition: boolean;
  onSelect: (position: InsertPosition) => void;
}> = ({ sorted, addingNum, hasHallDefinition, onSelect }) => {
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1">
      {sorted.map((nearby) => {
        const nearbyNum = extractNumeric(nearby.item.number);
        const label = `${nearby.item.block}-${nearby.item.number}`;
        const circle = nearby.item.circle ? ` ${nearby.item.circle}` : '';
        const orderLabel = `#${nearby.visitIndex + 1}`;

        return (
          <div key={nearby.item.id} className="rounded-lg border border-slate-200 dark:border-slate-600 overflow-hidden">
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

      <div className="border-t border-slate-200 dark:border-slate-600 my-1" />

      {hasHallDefinition && (
        <button
          onClick={() => onSelect({ type: 'hallEnd' })}
          className="w-full px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
        >
          <span className="text-base">🏢</span>
          同ホールの末尾に追加
        </button>
      )}

      <button
        onClick={() => onSelect({ type: 'listEnd' })}
        className="w-full px-3 py-2.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
      >
        <span className="text-base">📋</span>
        リスト末尾に追加
      </button>
    </div>
  );
};

// ===== 挿入候補マーカー =====
const InsertMarker: React.FC<{
  letter: string;
  onSelect: () => void;
}> = ({ letter, onSelect }) => (
  <button
    onClick={onSelect}
    className="w-full group flex items-center gap-1 py-0.5 px-1 my-0.5 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
  >
    <div className="flex-1 flex items-center gap-1.5">
      <div className="h-px flex-1 bg-green-300 dark:bg-green-600 group-hover:bg-green-500 dark:group-hover:bg-green-400 transition-colors" />
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 dark:bg-green-600 text-white text-xs font-bold shadow-sm group-hover:bg-green-600 dark:group-hover:bg-green-500 group-hover:scale-110 transition-all">
        {letter}
      </span>
      <div className="h-px flex-1 bg-green-300 dark:bg-green-600 group-hover:bg-green-500 dark:group-hover:bg-green-400 transition-colors" />
    </div>
  </button>
);

// ===== プレビューモード =====
const PreviewMode: React.FC<{
  addingItem: ShoppingItem;
  nearbyVisitItems: NearbyVisitItem[];
  allVisitItems: VisitListEntry[];
  hasHallDefinition: boolean;
  onSelect: (position: InsertPosition) => void;
}> = ({ addingItem, nearbyVisitItems, allVisitItems, hasHallDefinition, onSelect }) => {
  const CONTEXT_COUNT = 3;
  const addingNum = extractNumeric(addingItem.number);

  // 近接アイテムのvisitIndexのセット
  const nearbyIndicesSet = useMemo(() => {
    return new Set(nearbyVisitItems.map(n => n.visitIndex));
  }, [nearbyVisitItems]);

  // 表示範囲と挿入ポイントを計算
  const { displayItems, insertionSlots } = useMemo(() => {
    if (nearbyVisitItems.length === 0) {
      return { displayItems: [] as VisitListEntry[], insertionSlots: [] as { letter: string; position: InsertPosition; slotAfterVisitIndex: number }[] };
    }

    const sorted = [...nearbyVisitItems].sort((a, b) => a.visitIndex - b.visitIndex);
    const minIdx = sorted[0].visitIndex;
    const maxIdx = sorted[sorted.length - 1].visitIndex;

    const rangeStart = Math.max(0, minIdx - CONTEXT_COUNT);
    const rangeEnd = Math.min(allVisitItems.length - 1, maxIdx + CONTEXT_COUNT);

    const display = allVisitItems.filter(v => v.visitIndex >= rangeStart && v.visitIndex <= rangeEnd);

    // 挿入候補スロットを生成
    // 各近接アイテムの直前(=1個前のvisitIndexの後)と、最後の近接アイテムの直後に配置
    const slots: { letter: string; position: InsertPosition; slotAfterVisitIndex: number }[] = [];
    let letterIdx = 0;

    // 最初の近接アイテムの前
    slots.push({
      letter: indexToLetter(letterIdx++),
      position: { type: 'before', referenceItemId: sorted[0].item.id },
      slotAfterVisitIndex: sorted[0].visitIndex - 1,
    });

    // 各近接アイテムの後
    for (let i = 0; i < sorted.length; i++) {
      slots.push({
        letter: indexToLetter(letterIdx++),
        position: { type: 'after', referenceItemId: sorted[i].item.id },
        slotAfterVisitIndex: sorted[i].visitIndex,
      });
    }

    return { displayItems: display, insertionSlots: slots };
  }, [nearbyVisitItems, allVisitItems]);

  // slotAfterVisitIndex でグループ化したマップ
  const slotsMap = useMemo(() => {
    const map = new Map<number, typeof insertionSlots>();
    for (const slot of insertionSlots) {
      const existing = map.get(slot.slotAfterVisitIndex) || [];
      existing.push(slot);
      map.set(slot.slotAfterVisitIndex, existing);
    }
    return map;
  }, [insertionSlots]);

  return (
    <div className="flex-1 overflow-y-auto p-2">
      {/* プレビューリスト */}
      <div className="space-y-0">
        {displayItems.map((entry, idx) => {
          const isNearby = nearbyIndicesSet.has(entry.visitIndex);
          const nearbyNum = extractNumeric(entry.item.number);
          const label = `${entry.item.block}-${entry.item.number}`;
          const circle = entry.item.circle || '';

          // この行の前に表示する挿入候補（= visitIndex - 1 のスロット）
          const slotsBefore = idx === 0 || isNearby
            ? slotsMap.get(entry.visitIndex - 1) || []
            : [];

          // 最後の行の後に表示する挿入候補
          const isLast = idx === displayItems.length - 1;
          const slotsAfterLast = isLast
            ? slotsMap.get(entry.visitIndex) || []
            : [];

          return (
            <React.Fragment key={entry.item.id}>
              {/* この行の前の挿入候補 */}
              {slotsBefore.map(slot => (
                <InsertMarker key={slot.letter} letter={slot.letter} onSelect={() => onSelect(slot.position)} />
              ))}

              {/* アイテム行 */}
              <div
                className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${
                  isNearby
                    ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700'
                    : 'bg-slate-50/50 dark:bg-slate-700/20'
                }`}
              >
                <span className="bg-slate-200 dark:bg-slate-600 px-1.5 py-0.5 rounded text-[10px] font-mono flex-shrink-0">
                  #{entry.visitIndex + 1}
                </span>
                <span className={`font-semibold flex-shrink-0 ${isNearby ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-400'}`}>
                  {label}
                </span>
                <span className="truncate text-slate-500 dark:text-slate-400 text-[11px]">{circle}</span>
                {isNearby && nearbyNum !== 0 && (
                  <span className="ml-auto text-[10px] text-blue-400 dark:text-blue-500 flex-shrink-0">
                    {nearbyNum < addingNum ? `Δ-${addingNum - nearbyNum}` : nearbyNum > addingNum ? `Δ+${nearbyNum - addingNum}` : '同番'}
                  </span>
                )}
              </div>

              {/* 最後の行の後の挿入候補 */}
              {slotsAfterLast.map(slot => (
                <InsertMarker key={slot.letter} letter={slot.letter} onSelect={() => onSelect(slot.position)} />
              ))}
            </React.Fragment>
          );
        })}
      </div>

      {/* 区切り線 */}
      <div className="border-t border-slate-200 dark:border-slate-600 my-2" />

      {/* ホール末尾・リスト末尾 */}
      {hasHallDefinition && (
        <button
          onClick={() => onSelect({ type: 'hallEnd' })}
          className="w-full px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
        >
          <span className="text-base">🏢</span>
          同ホールの末尾に追加
        </button>
      )}
      <button
        onClick={() => onSelect({ type: 'listEnd' })}
        className="w-full px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
      >
        <span className="text-base">📋</span>
        リスト末尾に追加
      </button>
    </div>
  );
};

// ===== メインコンポーネント =====
const InsertPositionDialog: React.FC<InsertPositionDialogProps> = ({
  isOpen,
  addingItem,
  nearbyVisitItems,
  allVisitItems = [],
  hasHallDefinition,
  mode = 'card',
  onSelect,
  onCancel,
}) => {
  if (!isOpen) return null;

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
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">追加位置を選択</div>
            <span className="text-[10px] opacity-70 bg-white/20 px-1.5 py-0.5 rounded">
              {mode === 'card' ? 'カード' : 'プレビュー'}
            </span>
          </div>
          <div className="text-xs opacity-90 mt-1">
            {addingItem.block}-{addingItem.number}
            {addingItem.circle ? ` (${addingItem.circle})` : ''}
          </div>
        </div>

        {/* モード別コンテンツ */}
        {mode === 'card' ? (
          <CardMode
            sorted={sorted}
            addingNum={addingNum}
            hasHallDefinition={hasHallDefinition}
            onSelect={onSelect}
          />
        ) : (
          <PreviewMode
            addingItem={addingItem}
            nearbyVisitItems={nearbyVisitItems}
            allVisitItems={allVisitItems}
            hasHallDefinition={hasHallDefinition}
            onSelect={onSelect}
          />
        )}

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
