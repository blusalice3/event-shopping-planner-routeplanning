import React, { useMemo } from 'react';
import { ShoppingItem } from '../types';

interface SummaryBarProps {
  items: ShoppingItem[];
  filterLabel?: string;
  onFilterToggle?: () => void;
  onHelpRequest?: () => void;
  isInRoom?: boolean;
  myItemsOnly?: boolean;
  onToggleMyItems?: () => void;
  spaceGroupingEnabled?: boolean;
  onToggleSpaceGrouping?: () => void;
}

const SummaryBar: React.FC<SummaryBarProps> = ({
  items,
  filterLabel,
  onFilterToggle,
  onHelpRequest,
  isInRoom = false,
  myItemsOnly = false,
  onToggleMyItems,
  spaceGroupingEnabled,
  onToggleSpaceGrouping,
}) => {
  const summary = useMemo(() => {
    const totalItems = items.length;
    const purchasedItems = items.filter(
      (item) => item.purchaseStatus === 'Purchased' || item.purchaseStatus === 'LimitedPurchase',
    ).length;

    const remainingCost = items.reduce((sum, item) => {
      const isPurchasable =
        item.purchaseStatus === 'None' ||
        item.purchaseStatus === 'Postpone' ||
        item.purchaseStatus === 'Late';
      if (!isPurchasable) return sum;
      const price = item.price ?? 0;
      return sum + price;
    }, 0);

    return { totalItems, purchasedItems, remainingCost };
  }, [items]);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
          <div className="flex items-center gap-2">
            {isInRoom && onHelpRequest && (
              <button
                onClick={onHelpRequest}
                className="px-2 py-1 text-xs font-medium rounded-md text-orange-600 bg-orange-100 hover:bg-orange-200 dark:text-orange-300 dark:bg-orange-900/50 dark:hover:bg-orange-900 transition-colors touch-manipulation select-none"
                title="ヘルプ要請"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                type="button"
              >
                🆘
              </button>
            )}
            {isInRoom && onToggleMyItems && (
              <button
                onClick={onToggleMyItems}
                className={`px-2 py-1 text-xs font-medium rounded-md transition-colors touch-manipulation select-none ${
                  myItemsOnly
                    ? 'text-white bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-600'
                    : 'text-indigo-600 bg-indigo-100 hover:bg-indigo-200 dark:text-indigo-300 dark:bg-indigo-900/50 dark:hover:bg-indigo-900'
                }`}
                title={myItemsOnly ? '全アイテム表示' : '自分のアイテムのみ'}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                type="button"
              >
                👤
              </button>
            )}
            <div className="text-slate-700 dark:text-slate-300">
              <span className="font-semibold">{summary.purchasedItems}</span> / {summary.totalItems}{' '}
              件購入済み
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onToggleSpaceGrouping && (
              <button
                onClick={onToggleSpaceGrouping}
                className={`px-2 py-1 text-xs font-medium rounded transition-colors touch-manipulation select-none ${
                  spaceGroupingEnabled
                    ? 'bg-blue-600 text-white dark:bg-blue-500'
                    : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600'
                }`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                type="button"
              >
                スペース別
              </button>
            )}
            {filterLabel && onFilterToggle && (
              <button
                onClick={onFilterToggle}
                className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-200 text-blue-600 bg-blue-100 hover:bg-blue-200 dark:text-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-900 touch-manipulation select-none"
                title="購入状態フィルタ切替"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                type="button"
              >
                {filterLabel}
              </button>
            )}
          </div>
          <div>
            <span className="text-sm text-slate-500 dark:text-slate-400">残りの合計: </span>
            <span className="font-bold text-xl text-blue-600 dark:text-blue-400">
              ¥{summary.remainingCost.toLocaleString()}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SummaryBar;
