import React, { useEffect, useMemo, useRef } from 'react';
import { ShoppingItem } from '../types/item';
import {
  getLimitedPurchaseCounts,
  getPlannedBudgetQuantity,
  getSafePriceForCalculation,
  isCountedAsPurchased,
} from '../utils/purchaseQuantity';

interface SummaryBarProps {
  items: ShoppingItem[];
  filterLabel?: string;
  onFilterToggle?: () => void;
}

const SummaryBar: React.FC<SummaryBarProps> = ({ items, filterLabel, onFilterToggle }) => {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;

    const updateHeight = () => {
      const height = el.offsetHeight;
      document.documentElement.style.setProperty('--footer-height', height + 'px');
    };

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    updateHeight();

    return () => {
      observer.disconnect();
      document.documentElement.style.setProperty('--footer-height', '0px');
    };
  }, []);

  const summary = useMemo(() => {
    const totalItems = items.length;
    const purchasedItems = items.filter(isCountedAsPurchased).length;
    const limitedCounts = getLimitedPurchaseCounts(items);

    const remainingCost = items
      .filter(
        (item) =>
          item.purchaseStatus === 'None' ||
          item.purchaseStatus === 'Postpone' ||
          item.purchaseStatus === 'Late',
      )
      .reduce(
        (sum, item) =>
          sum + getSafePriceForCalculation(item.price) * getPlannedBudgetQuantity(item),
        0,
      );

    return {
      totalItems,
      purchasedItems,
      limitedMissingItems: limitedCounts.missing,
      remainingCost,
    };
  }, [items]);

  return (
    <div
      ref={barRef}
      className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
          <div className="text-slate-700 dark:text-slate-300">
            <span className="font-semibold">{summary.purchasedItems}</span> /{' '}
            {summary.totalItems} 件購入済み
            {summary.limitedMissingItems > 0 && (
              <span className="ml-2 text-orange-600 dark:text-orange-300">
                限数未入力 {summary.limitedMissingItems}件
              </span>
            )}
          </div>
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
          <div>
            <span className="text-sm text-slate-500 dark:text-slate-400">残りの合計 </span>
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
