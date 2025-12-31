import React, { useMemo } from 'react';
import { ShoppingItem } from '../types';

interface SummaryBarProps {
  items: ShoppingItem[];
  layoutMode: 'pc' | 'smartphone';
  onLayoutModeChange: (mode: 'pc' | 'smartphone') => void;
}

const SummaryBar: React.FC<SummaryBarProps> = ({ items, layoutMode, onLayoutModeChange }) => {
  const summary = useMemo(() => {
    const totalItems = items.length;
    const purchasedItems = items.filter(item => item.purchaseStatus === 'Purchased').length;
    
    const remainingCost = items.reduce((sum, item) => {
      const isPurchasable = item.purchaseStatus === 'None' || item.purchaseStatus === 'Postpone' || item.purchaseStatus === 'Late';
      if (!isPurchasable) return sum;
      const price = item.price ?? 0; // nullの場合は0として扱う
      return sum + price;
    }, 0);

    return { totalItems, purchasedItems, remainingCost };
  }, [items]);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white/80 dark:bg-slate-800/80 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-t-lg z-20">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
          <div className="text-slate-700 dark:text-slate-300">
            <span className="font-semibold">{summary.purchasedItems}</span> / {summary.totalItems} 件購入済み
          </div>
          <div className="flex items-center gap-3">
            <div>
              <span className="text-sm text-slate-500 dark:text-slate-400">残りの合計: </span>
              <span className="font-bold text-xl text-blue-600 dark:text-blue-400">
                ¥{summary.remainingCost.toLocaleString()}
              </span>
            </div>
            <button
              onClick={() => onLayoutModeChange(layoutMode === 'pc' ? 'smartphone' : 'pc')}
              className={`p-2 rounded-md transition-colors ${
                layoutMode === 'smartphone'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
              }`}
              title={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
              aria-label={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
            >
              {layoutMode === 'smartphone' ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SummaryBar;
