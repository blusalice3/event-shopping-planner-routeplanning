import React, { useMemo } from 'react';
import { ShoppingItem } from '../../types/item';

export type InsertPosition =
  | { type: 'before'; referenceItemId: string }
  | { type: 'after'; referenceItemId: string }
  | { type: 'hallEnd' }
  | { type: 'listEnd' };

interface NearbyVisitItem {
  item: ShoppingItem;
  visitIndex: number;
}

interface VisitListEntry {
  item: ShoppingItem;
  visitIndex: number;
}

interface InsertPositionDialogProps {
  isOpen: boolean;
  addingItem: ShoppingItem;
  nearbyVisitItems: NearbyVisitItem[];
  allVisitItems?: VisitListEntry[];
  hasHallDefinition: boolean;
  onSelect: (position: InsertPosition) => void;
  onCancel: () => void;
}

const extractNumeric = (number: string): number => {
  const match = number.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
};

const indexToLetter = (i: number): string => String.fromCharCode(65 + i);

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

const PreviewMode: React.FC<{
  addingItem: ShoppingItem;
  nearbyVisitItems: NearbyVisitItem[];
  allVisitItems: VisitListEntry[];
  hasHallDefinition: boolean;
  onSelect: (position: InsertPosition) => void;
}> = ({ addingItem, nearbyVisitItems, allVisitItems, hasHallDefinition, onSelect }) => {
  const contextCount = 3;
  const addingNum = extractNumeric(addingItem.number);

  const nearbyIndicesSet = useMemo(
    () => new Set(nearbyVisitItems.map((nearby) => nearby.visitIndex)),
    [nearbyVisitItems],
  );

  const displayItems = useMemo(() => {
    if (nearbyVisitItems.length === 0) return [] as VisitListEntry[];
    const sorted = [...nearbyVisitItems].sort((a, b) => a.visitIndex - b.visitIndex);
    const minIdx = sorted[0].visitIndex;
    const maxIdx = sorted[sorted.length - 1].visitIndex;
    const rangeStart = Math.max(0, minIdx - contextCount);
    const rangeEnd = Math.min(allVisitItems.length - 1, maxIdx + contextCount);
    return allVisitItems.filter((entry) => entry.visitIndex >= rangeStart && entry.visitIndex <= rangeEnd);
  }, [nearbyVisitItems, allVisitItems]);

  return (
    <div className="flex-1 overflow-y-auto p-2">
      <div className="space-y-0">
        {displayItems.map((entry, idx) => {
          const isNearby = nearbyIndicesSet.has(entry.visitIndex);
          const nearbyNum = extractNumeric(entry.item.number);
          const label = `${entry.item.block}-${entry.item.number}`;
          const circle = entry.item.circle || '';
          const letter = indexToLetter(idx);
          const isLast = idx === displayItems.length - 1;
          const lastLetter = indexToLetter(displayItems.length);

          return (
            <React.Fragment key={entry.item.id}>
              <InsertMarker
                letter={letter}
                onSelect={() =>
                  onSelect(
                    idx === 0
                      ? { type: 'before', referenceItemId: entry.item.id }
                      : { type: 'after', referenceItemId: displayItems[idx - 1].item.id },
                  )
                }
              />

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
                <span
                  className={`font-semibold flex-shrink-0 ${isNearby ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-400'}`}
                >
                  {label}
                </span>
                <span className="truncate text-slate-500 dark:text-slate-400 text-[11px]">
                  {circle}
                </span>
                {isNearby && nearbyNum !== 0 && (
                  <span className="ml-auto text-[10px] text-blue-400 dark:text-blue-500 flex-shrink-0">
                    {nearbyNum < addingNum
                      ? `-${addingNum - nearbyNum}`
                      : nearbyNum > addingNum
                        ? `+${nearbyNum - addingNum}`
                        : '同番'}
                  </span>
                )}
              </div>

              {isLast && (
                <InsertMarker
                  letter={lastLetter}
                  onSelect={() => onSelect({ type: 'after', referenceItemId: entry.item.id })}
                />
              )}
            </React.Fragment>
          );
        })}
      </div>

      <div className="border-t border-slate-200 dark:border-slate-600 my-2" />

      {hasHallDefinition && (
        <button
          onClick={() => onSelect({ type: 'hallEnd' })}
          className="w-full px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
        >
          同じホールの末尾に追加
        </button>
      )}
      <button
        onClick={() => onSelect({ type: 'listEnd' })}
        className="w-full px-3 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors text-left flex items-center gap-2"
      >
        リスト末尾に追加
      </button>
    </div>
  );
};

const InsertPositionDialog: React.FC<InsertPositionDialogProps> = ({
  isOpen,
  addingItem,
  nearbyVisitItems,
  allVisitItems = [],
  hasHallDefinition,
  onSelect,
  onCancel,
}) => {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-[340px] max-h-[80vh] flex flex-col overflow-hidden">
        <div className="bg-gradient-to-r from-blue-500 to-indigo-600 text-white px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold">追加位置を選択</div>
            <span className="text-[10px] opacity-70 bg-white/20 px-1.5 py-0.5 rounded">
              プレビュー
            </span>
          </div>
          <div className="text-xs opacity-90 mt-1">
            {addingItem.block}-{addingItem.number}
            {addingItem.circle ? ` (${addingItem.circle})` : ''}
          </div>
        </div>

        <PreviewMode
          addingItem={addingItem}
          nearbyVisitItems={nearbyVisitItems}
          allVisitItems={allVisitItems}
          hasHallDefinition={hasHallDefinition}
          onSelect={onSelect}
        />

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
