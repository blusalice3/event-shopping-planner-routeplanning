import React, { useMemo } from 'react';
import { ShoppingItem } from '../types';

interface SummaryBarProps {
  items: ShoppingItem[];
}

const SummaryBar: React.FC<SummaryBarProps> = ({ items }) => {
  const summary = useMemo(() => {
    const totalItems = items.length;
    const purchasedItems = items.filter(item => item.purchaseStatus === 'Purchased').length;
    
    const remainingCost = items.reduce((sum, item) => {
      const isPurchasable = item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late';
      return isPurchasable ? sum + item.price : sum;
    }, 0);

    return { totalItems, purchasedItems, remainingCost };
  }, [items]);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left">
          <div className="text-slate-700 dark:text-slate-300">
            <span className="font-semibold">{summary.purchasedItems}</span> / {summary.totalItems} 件購入済み
          </div>
          <div className="mt-2 sm:mt-0">
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
