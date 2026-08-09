import React, { useEffect, useId, useMemo, useRef } from "react";
import { ShoppingItem } from "../types/item";
import {
  getLimitedPurchaseCounts,
  getPlannedBudgetQuantity,
  getSafePriceForCalculation,
  isCountedAsPurchased,
} from "../utils/purchaseQuantity";
import { SpaceNavigatorFooterButton } from "../features/space-navigation/components/SpaceNavigatorFooterButton";
import { useOptionalSpaceNavigator } from "../features/space-navigation/SpaceNavigatorContext";
import {
  clearFooterHeightAttribute,
  setFooterHeightAttribute,
} from "../styles/runtimeLayoutAttributes";

interface SummaryBarProps {
  items: ShoppingItem[];
  layoutMode?: "pc" | "smartphone";
  filterLabel?: string;
  onFilterToggle?: () => void;
}

const SummaryBar: React.FC<SummaryBarProps> = ({
  items,
  layoutMode = "pc",
  filterLabel,
  onFilterToggle,
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const footerHeightOwnerId = useId();
  const spaceNavigator = useOptionalSpaceNavigator();
  const spaceNavigatorFooterEnabled = Boolean(
    spaceNavigator?.settings.footerButtonVisible,
  );

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;

    const updateHeight = () => {
      setFooterHeightAttribute(footerHeightOwnerId, el.offsetHeight);
    };

    const observer = new ResizeObserver(updateHeight);
    observer.observe(el);
    updateHeight();

    return () => {
      observer.disconnect();
      clearFooterHeightAttribute(footerHeightOwnerId);
    };
  }, [footerHeightOwnerId]);

  const summary = useMemo(() => {
    const totalItems = items.length;
    const purchasedItems = items.filter(isCountedAsPurchased).length;
    const limitedCounts = getLimitedPurchaseCounts(items);

    const remainingCost = items
      .filter(
        (item) =>
          item.purchaseStatus === "None" ||
          item.purchaseStatus === "Postpone" ||
          item.purchaseStatus === "Late",
      )
      .reduce(
        (sum, item) =>
          sum +
          getSafePriceForCalculation(item.price) *
            getPlannedBudgetQuantity(item),
        0,
      );

    return {
      totalItems,
      purchasedItems,
      limitedMissingItems: limitedCounts.missing,
      remainingCost,
    };
  }, [items]);

  const purchasedSummary = (
    <div
      className={
        layoutMode === "smartphone"
          ? "text-sm leading-5 text-slate-700 dark:text-slate-300"
          : "text-slate-700 dark:text-slate-300"
      }
    >
      <span className="font-semibold tabular-nums">
        {summary.purchasedItems}
      </span>{" "}
      / <span className="tabular-nums">{summary.totalItems}</span> 件購入済み
      {summary.limitedMissingItems > 0 && (
        <span className="ml-2 text-orange-600 dark:text-orange-300">
          限数未入力 {summary.limitedMissingItems}件
        </span>
      )}
    </div>
  );

  const filterButton =
    filterLabel && onFilterToggle ? (
      <button
        onClick={onFilterToggle}
        className={`touch-manipulation select-none rounded-md bg-blue-100 font-medium text-blue-600 [-webkit-tap-highlight-color:transparent] transition-colors duration-200 hover:bg-blue-200 dark:bg-blue-900/50 dark:text-blue-300 dark:hover:bg-blue-900 ${
          layoutMode === "smartphone"
            ? "min-h-11 min-w-11 px-2 py-1 text-sm"
            : "px-3 py-1.5 text-sm"
        }`}
        title="購入状態フィルタ切替"
        aria-label={`購入状態フィルタ切替（現在: ${filterLabel}）`}
        type="button"
      >
        {filterLabel}
      </button>
    ) : null;

  const spaceNavigatorButton = (
    <SpaceNavigatorFooterButton compact={layoutMode === "smartphone"} />
  );

  const remainingSummary = (
    <div
      className={
        layoutMode === "smartphone"
          ? "flex flex-wrap items-baseline gap-x-1 leading-5"
          : ""
      }
    >
      <span
        className={
          layoutMode === "smartphone"
            ? "text-xs text-slate-500 dark:text-slate-400"
            : "text-sm text-slate-500 dark:text-slate-400"
        }
      >
        残りの合計{" "}
      </span>
      <span
        className={`font-bold text-blue-600 dark:text-blue-400 tabular-nums whitespace-nowrap ${
          layoutMode === "smartphone" ? "text-lg" : "text-xl"
        }`}
      >
        ¥{summary.remainingCost.toLocaleString()}
      </span>
    </div>
  );

  return (
    <div
      ref={barRef}
      className={`fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white/80 shadow-t-lg backdrop-blur-sm dark:border-slate-700 dark:bg-slate-800/80 ${
        spaceNavigatorFooterEnabled ? "pb-[env(safe-area-inset-bottom)]" : ""
      }`}
    >
      <div
        className={`max-w-4xl mx-auto ${
          layoutMode === "smartphone"
            ? "px-3 py-2"
            : "px-4 sm:px-6 lg:px-8 py-3"
        }`}
      >
        {layoutMode === "smartphone" ? (
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-left">
            <div className="flex flex-1 basis-32 flex-col justify-center">
              {purchasedSummary}
              {remainingSummary}
            </div>
            <div className="flex shrink-0 items-center gap-2 empty:hidden">
              {filterButton}
              {spaceNavigatorButton}
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row justify-between items-center text-center sm:text-left gap-2">
            {purchasedSummary}
            {filterButton}
            {spaceNavigatorButton}
            {remainingSummary}
          </div>
        )}
      </div>
    </div>
  );
};

export default SummaryBar;
