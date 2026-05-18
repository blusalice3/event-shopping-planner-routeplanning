import React, { useCallback, useLayoutEffect, useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ShoppingItem,
  PurchaseStatus,
  PurchaseStatusControlMode,
  PurchaseStatuses,
  ProtectionLevel,
  ProtectionLevels,
} from '../types/item';
import GripVerticalIcon from './icons/GripVerticalIcon';
import CheckCircleIcon from './icons/CheckCircleIcon';
import CircleIcon from './icons/CircleIcon';
import XCircleIcon from './icons/XCircleIcon';
import MinusCircleIcon from './icons/MinusCircleIcon';
import PauseCircleIcon from './icons/PauseCircleIcon';
import ClockIcon from './icons/ClockIcon';
import ChevronUpIcon from './icons/ChevronUpIcon';
import ChevronDownIcon from './icons/ChevronDownIcon';
import { areSameItemSnapshot } from './itemSnapshot';
import LimitedPurchaseDialog from './LimitedPurchaseDialog';
import SingleQuantityLimitedPurchaseChoiceDialog from './SingleQuantityLimitedPurchaseChoiceDialog';
import type { LimitedPurchaseDialogResult } from '../types/limitedPurchase';
import {
  applyLimitedPurchase,
  applyPurchasedFromLimitedInput,
  clearLimitedPurchase,
  formatDisplayQuantity,
  getActualPurchasedQuantity,
  getNextPurchaseStatus,
  getPlannedQuantity,
  shouldSkipLimitedPurchaseForTransition,
} from '../utils/purchaseQuantity';

// 外部リンクアイコン
const ExternalLinkIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    strokeWidth={2}
    stroke="currentColor"
    {...props}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
    />
  </svg>
);

export interface ShoppingItemCardProps {
  item: ShoppingItem;
  onUpdate: (item: ShoppingItem) => void;
  isStriped: boolean;
  onEditRequest: (item: ShoppingItem) => void;
  onDeleteRequest: (item: ShoppingItem) => void;
  isSelected: boolean;
  onSelectItem: (itemId: string) => void;
  blockBackgroundColor?: string;
  onMoveUp?: (itemId: string) => void;
  onMoveDown?: (itemId: string) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  isDuplicateCircle?: boolean;
  isSearchMatch?: boolean;
  layoutMode?: 'pc' | 'smartphone';
  viewMode?: 'edit' | 'execute' | 'focus';
  hallIndex?: number;
  priorityLevel?: 'none' | 'priority' | 'highest';
  highlightPrice?: boolean; // 価格未定の購入済アイテムの価格欄を強調表示
  highlightLimitedMissing?: boolean;
  getLatestItemById?: (itemId: string) => ShoppingItem | undefined;
  onNotify?: (message: string) => void;
  purchaseStatusControlMode?: PurchaseStatusControlMode;
  skipLimitedPurchaseForSingleQuantity: boolean;
}

const statusConfig: Record<
  PurchaseStatus,
  { label: string; icon: React.FC<any>; color: string; dim: boolean; bg: string }
> = {
  None: {
    label: '未購入',
    icon: CircleIcon,
    color: 'text-slate-400 dark:text-slate-500',
    dim: false,
    bg: '',
  },
  Purchased: {
    label: '購入済',
    icon: CheckCircleIcon,
    color: 'text-green-600 dark:text-green-400',
    dim: true,
    bg: 'bg-green-500/20 dark:bg-green-500/30',
  },
  SoldOut: {
    label: '売切',
    icon: XCircleIcon,
    color: 'text-red-600 dark:text-red-400',
    dim: true,
    bg: 'bg-red-500/20 dark:bg-red-500/30',
  },
  Absent: {
    label: '欠席',
    icon: MinusCircleIcon,
    color: 'text-yellow-600 dark:text-yellow-400',
    dim: true,
    bg: 'bg-yellow-500/20 dark:bg-yellow-500/30',
  },
  Postpone: {
    label: '後回し',
    icon: PauseCircleIcon,
    color: 'text-purple-600 dark:text-purple-400',
    dim: false,
    bg: 'bg-purple-500/20 dark:bg-purple-500/30',
  },
  Late: {
    label: '遅参',
    icon: ClockIcon,
    color: 'text-blue-600 dark:text-blue-400',
    dim: false,
    bg: 'bg-blue-500/20 dark:bg-blue-500/30',
  },
  LimitedPurchase: {
    label: '限数',
    icon: CheckCircleIcon,
    color: 'text-orange-600 dark:text-orange-400',
    dim: true,
    bg: 'bg-orange-500/20 dark:bg-orange-500/30',
  },
};

const protectionConfig: Record<
  ProtectionLevel,
  { label: string; icon: string; color: string; title: string }
> = {
  full: {
    label: '完全保護',
    icon: '🔐',
    color: 'text-amber-600 dark:text-amber-400',
    title: '完全保護: 削除も更新もされません',
  },
  deletable: {
    label: '削除のみ許可',
    icon: '🔒',
    color: 'text-blue-600 dark:text-blue-400',
    title: '削除のみ許可: 削除されますが更新されません',
  },
  none: {
    label: '保護なし',
    icon: '🔓',
    color: 'text-slate-500 dark:text-slate-400',
    title: '保護なし: 削除も更新もされます',
  },
};

const protectionCycle: ProtectionLevel[] = ['full', 'deletable', 'none'];

type PurchaseStatusRadialMenuProps = {
  itemId: string;
  anchorRef: React.RefObject<HTMLButtonElement>;
  currentStatus: PurchaseStatus;
  onSelect: (status: PurchaseStatus) => void;
  onCancel: () => void;
};

const RADIAL_MENU_RADIUS = 46;
const RADIAL_MENU_ITEM_SIZE = 40;
export const OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS = 300;

const ITEM_NOT_FOUND_MESSAGE =
  '\u5bfe\u8c61\u306e\u30a2\u30a4\u30c6\u30e0\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093';
const ITEM_ALREADY_CHANGED_MESSAGE =
  '\u5bfe\u8c61\u306e\u30a2\u30a4\u30c6\u30e0\u306f\u3059\u3067\u306b\u5225\u306e\u8cfc\u5165\u72b6\u614b\u306b\u5909\u66f4\u3055\u308c\u3066\u3044\u307e\u3059';

type LimitedDialogSource = 'current' | 'singleQuantityChoice';

const PurchaseStatusRadialMenu: React.FC<PurchaseStatusRadialMenuProps> = ({
  itemId,
  anchorRef,
  currentStatus,
  onSelect,
  onCancel,
}) => {
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null);
  const itemButtonRefs = useRef<Partial<Record<PurchaseStatus, HTMLButtonElement | null>>>({});
  const cancelTimerRef = useRef<number | null>(null);

  const stopPointerOverlayEvent = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation();
  }, []);

  const stopMouseOverlayEvent = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const clearScheduledCancel = useCallback(() => {
    if (cancelTimerRef.current === null) return;
    window.clearTimeout(cancelTimerRef.current);
    cancelTimerRef.current = null;
  }, []);

  const scheduleFallbackCancelAfterPointerUp = useCallback(() => {
    if (cancelTimerRef.current !== null) return;
    cancelTimerRef.current = window.setTimeout(() => {
      cancelTimerRef.current = null;
      onCancel();
    }, OUTSIDE_CLICK_FALLBACK_CLOSE_DELAY_MS);
  }, [onCancel]);

  const cancelAfterCapturedClick = useCallback(() => {
    clearScheduledCancel();
    onCancel();
  }, [clearScheduledCancel, onCancel]);

  useLayoutEffect(() => {
    const updateCenter = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setCenter({
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      });
    };

    updateCenter();
    window.addEventListener('resize', updateCenter);
    window.addEventListener('scroll', updateCenter, true);

    return () => {
      window.removeEventListener('resize', updateCenter);
      window.removeEventListener('scroll', updateCenter, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    if (!center) return;
    itemButtonRefs.current[currentStatus]?.focus();
  }, [center, currentStatus]);

  useEffect(() => clearScheduledCancel, [clearScheduledCancel]);

  if (!center) return null;

  // Known a11y debt: this is a non-modal dialog without focus trapping. Tab can
  // leave the dialog and reach background UI. The radiogroup uses tabbable
  // button-based radio controls without roving tabindex or arrow-key movement.
  // 3.5 guarantees focus placement, Tab reachability, Escape, and focus
  // restoration; focus trap, aria-modal, roving tabindex, and arrow-key
  // navigation are follow-ups.

  return createPortal(
    <div
      data-purchase-status-overlay={itemId}
      className="fixed inset-0 z-[90] pointer-events-auto"
      onPointerDown={stopPointerOverlayEvent}
      onPointerUp={(event) => {
        stopPointerOverlayEvent(event);
        scheduleFallbackCancelAfterPointerUp();
      }}
      onMouseDown={stopMouseOverlayEvent}
      onMouseUp={stopMouseOverlayEvent}
      onClick={(event) => {
        stopMouseOverlayEvent(event);
        cancelAfterCapturedClick();
      }}
    >
      <div
        data-purchase-status-menu={itemId}
        className="absolute"
        style={{ left: center.x, top: center.y }}
        role="dialog"
        aria-label="購入状態を選択"
        onPointerDown={(event) => {
          clearScheduledCancel();
          event.stopPropagation();
        }}
        onPointerUp={(event) => event.stopPropagation()}
        onMouseDown={(event) => {
          clearScheduledCancel();
          event.stopPropagation();
        }}
        onMouseUp={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="absolute -translate-x-1/2 -translate-y-1/2 w-34 h-34 rounded-full bg-white/90 dark:bg-slate-900/90 border border-slate-200 dark:border-slate-700 shadow-2xl backdrop-blur-sm" />

        <div role="radiogroup" aria-label="購入状態">
          {PurchaseStatuses.map((status, index) => {
            const angle = -90 + (360 / PurchaseStatuses.length) * index;
            const rad = (angle * Math.PI) / 180;
            const x = Math.cos(rad) * RADIAL_MENU_RADIUS;
            const y = Math.sin(rad) * RADIAL_MENU_RADIUS;
            const config = statusConfig[status];
            const Icon = config.icon;
            const selected = status === currentStatus;

            return (
              <button
                key={status}
                ref={(node) => {
                  itemButtonRefs.current[status] = node;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${status}に変更`}
                title={config.label}
                data-status={status}
                onClick={() => onSelect(status)}
                className={`absolute flex items-center justify-center rounded-full border shadow-md transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                  selected
                    ? 'bg-blue-600 border-blue-500 text-white'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700'
                }`}
                style={{
                  width: RADIAL_MENU_ITEM_SIZE,
                  height: RADIAL_MENU_ITEM_SIZE,
                  left: x - RADIAL_MENU_ITEM_SIZE / 2,
                  top: y - RADIAL_MENU_ITEM_SIZE / 2,
                }}
              >
                <Icon className={`w-5 h-5 ${selected ? 'text-white' : config.color}`} />
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="absolute -translate-x-1/2 -translate-y-1/2 w-12 h-12 rounded-full bg-slate-700 text-white shadow-lg border border-slate-500 hover:bg-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
          aria-label="キャンセル"
          title="キャンセル"
        >
          x
        </button>
      </div>
    </div>,
    document.body,
  );
};

export const SHOPPING_ITEM_CARD_COMPARISON_KEYS = [
  'item',
  'onUpdate',
  'onEditRequest',
  'onDeleteRequest',
  'onSelectItem',
  'onMoveUp',
  'onMoveDown',
  'isStriped',
  'isSelected',
  'blockBackgroundColor',
  'canMoveUp',
  'canMoveDown',
  'isDuplicateCircle',
  'isSearchMatch',
  'layoutMode',
  'viewMode',
  'hallIndex',
  'priorityLevel',
  'highlightPrice',
  'highlightLimitedMissing',
  'getLatestItemById',
  'onNotify',
  'purchaseStatusControlMode',
  'skipLimitedPurchaseForSingleQuantity',
] as const satisfies readonly (keyof ShoppingItemCardProps)[];

export const areSameShoppingItemCardProps = (
  prev: ShoppingItemCardProps,
  next: ShoppingItemCardProps,
): boolean =>
  areSameItemSnapshot(prev.item, next.item) &&
  prev.onUpdate === next.onUpdate &&
  prev.onEditRequest === next.onEditRequest &&
  prev.onDeleteRequest === next.onDeleteRequest &&
  prev.onSelectItem === next.onSelectItem &&
  prev.onMoveUp === next.onMoveUp &&
  prev.onMoveDown === next.onMoveDown &&
  prev.isStriped === next.isStriped &&
  prev.isSelected === next.isSelected &&
  prev.blockBackgroundColor === next.blockBackgroundColor &&
  prev.canMoveUp === next.canMoveUp &&
  prev.canMoveDown === next.canMoveDown &&
  prev.isDuplicateCircle === next.isDuplicateCircle &&
  prev.isSearchMatch === next.isSearchMatch &&
  prev.layoutMode === next.layoutMode &&
  prev.viewMode === next.viewMode &&
  prev.hallIndex === next.hallIndex &&
  prev.priorityLevel === next.priorityLevel &&
  prev.highlightPrice === next.highlightPrice &&
  prev.highlightLimitedMissing === next.highlightLimitedMissing &&
  prev.getLatestItemById === next.getLatestItemById &&
  prev.onNotify === next.onNotify &&
  prev.purchaseStatusControlMode === next.purchaseStatusControlMode &&
  prev.skipLimitedPurchaseForSingleQuantity === next.skipLimitedPurchaseForSingleQuantity;

const ShoppingItemCard: React.FC<ShoppingItemCardProps> = ({
  item: sourceItem,
  onUpdate,
  isStriped,
  onEditRequest,
  onDeleteRequest,
  isSelected,
  onSelectItem,
  blockBackgroundColor,
  onMoveUp,
  onMoveDown,
  canMoveUp = true,
  canMoveDown = true,
  isDuplicateCircle = false,
  isSearchMatch = false,
  layoutMode = 'pc',
  viewMode = 'edit',
  hallIndex,
  priorityLevel = 'none',
  highlightPrice = false,
  highlightLimitedMissing = false,
  getLatestItemById,
  onNotify,
  purchaseStatusControlMode = 'cycle',
  skipLimitedPurchaseForSingleQuantity,
}) => {
  const [menuVisible, setMenuVisible] = useState(false);
  const [optimisticItem, setOptimisticItem] = useState(sourceItem);
  const longPressTimeout = useRef<number | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const purchaseStatusButtonRef = useRef<HTMLButtonElement>(null);
  const [purchaseStatusMenuOpen, setPurchaseStatusMenuOpen] = useState(false);
  const [limitedDialogOpen, setLimitedDialogOpen] = useState(false);
  const [limitedDialogItem, setLimitedDialogItem] = useState<ShoppingItem | null>(null);
  const [limitedDialogSource, setLimitedDialogSource] =
    useState<LimitedDialogSource>('current');
  const [singleQuantityChoiceOpen, setSingleQuantityChoiceOpen] = useState(false);
  const item = optimisticItem;

  useEffect(() => {
    setOptimisticItem((prev) => (areSameItemSnapshot(prev, sourceItem) ? prev : sourceItem));
  }, [sourceItem]);

  const commitItemUpdate = useCallback(
    (updatedItem: ShoppingItem) => {
      setOptimisticItem((prev) =>
        areSameItemSnapshot(prev, updatedItem) ? prev : updatedItem,
      );
      onUpdate(updatedItem);
    },
    [onUpdate],
  );

  // サークル名・タイトルが truncate されている時、タップで展開/折り畳みを切替
  const [expanded, setExpanded] = useState<Set<'circle' | 'title'>>(new Set());
  // ref は truncate が実際に発生する <span> に付ける（button 側は inline-flex なので
  const circleTextRef = useRef<HTMLSpanElement>(null);
  const titleTextRef = useRef<HTMLSpanElement>(null);
  const [truncatedMap, setTruncatedMap] = useState<{ circle: boolean; title: boolean }>({
    circle: false,
    title: false,
  });

  const toggleExpand = useCallback((key: 'circle' | 'title') => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // truncate 判定: scrollWidth > clientWidth で実際にはみ出しているかを検出
  useLayoutEffect(() => {
    const update = () => {
      const circleEl = circleTextRef.current;
      const titleEl = titleTextRef.current;
      const nextTruncatedMap = {
        circle:
          !!circleEl && !expanded.has('circle') && circleEl.scrollWidth > circleEl.clientWidth + 1,
        title:
          !!titleEl && !expanded.has('title') && titleEl.scrollWidth > titleEl.clientWidth + 1,
      };
      setTruncatedMap((prev) =>
        prev.circle === nextTruncatedMap.circle && prev.title === nextTruncatedMap.title
          ? prev
          : nextTruncatedMap,
      );
    };
    update();
    const ro = new ResizeObserver(update);
    if (circleTextRef.current) ro.observe(circleTextRef.current);
    if (titleTextRef.current) ro.observe(titleTextRef.current);
    // 親の幅変化も捕捉するためカード全体も observe
    if (cardRef.current) ro.observe(cardRef.current);
    return () => ro.disconnect();
  }, [item.circle, item.title, expanded]);

  const handlePriceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const updatedItem: ShoppingItem = {
      ...item,
      price: value === '' ? null : parseInt(value, 10) || 0,
    };
    commitItemUpdate(updatedItem);
  };

  const handleQuantityChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = parseInt(e.target.value, 10) || 1;
    const updatedItem: ShoppingItem = {
      ...item,
      quantity: value,
    };
    commitItemUpdate(updatedItem);
  };

  const resolveLatestDialogItem = useCallback(
    (): ShoppingItem | undefined => {
      const targetItem = limitedDialogItem ?? item;
      return getLatestItemById ? getLatestItemById(targetItem.id) : targetItem;
    },
    [getLatestItemById, item, limitedDialogItem],
  );

  const commitLimitedDialogResult = useCallback(
    (baseItem: ShoppingItem, result: LimitedPurchaseDialogResult) => {
      if (result.kind === 'limited') {
        commitItemUpdate(
          applyLimitedPurchase(baseItem, {
            actual: result.actual,
            planned: result.planned,
          }),
        );
        return;
      }

      if (result.kind === 'purchased') {
        commitItemUpdate(applyPurchasedFromLimitedInput(baseItem, result.planned));
        return;
      }

      commitItemUpdate(applyLimitedPurchase(baseItem, { planned: result.planned }));
    },
    [commitItemUpdate],
  );

  const restorePurchaseStatusButtonFocus = useCallback(() => {
    const focusButton = () => purchaseStatusButtonRef.current?.focus();
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusButton);
      return;
    }
    window.setTimeout(focusButton, 0);
  }, []);

  const closeLimitedDialog = useCallback(
    (options: { restoreFocus?: boolean } = {}) => {
      const { restoreFocus = limitedDialogSource === 'singleQuantityChoice' } = options;
      setLimitedDialogOpen(false);
      setLimitedDialogItem(null);
      setLimitedDialogSource('current');
      if (restoreFocus) {
        restorePurchaseStatusButtonFocus();
      }
    },
    [limitedDialogSource, restorePurchaseStatusButtonFocus],
  );

  const handleLimitedDialogSubmit = useCallback(
    (result: LimitedPurchaseDialogResult) => {
      const latestItem = resolveLatestDialogItem();
      if (latestItem === undefined) {
        if (limitedDialogSource === 'singleQuantityChoice') {
          onNotify?.(ITEM_NOT_FOUND_MESSAGE);
        }
        closeLimitedDialog();
        return;
      }

      if (limitedDialogSource === 'singleQuantityChoice') {
        switch (latestItem.purchaseStatus) {
          case 'None':
          case 'Postpone':
          case 'Late':
          case 'LimitedPurchase':
            break;
          case 'Purchased':
            closeLimitedDialog();
            return;
          case 'SoldOut':
          case 'Absent':
            onNotify?.(ITEM_ALREADY_CHANGED_MESSAGE);
            closeLimitedDialog();
            return;
          default: {
            const _exhaustive: never = latestItem.purchaseStatus;
            void _exhaustive;
            closeLimitedDialog();
            return;
          }
        }
      }

      commitLimitedDialogResult(latestItem, result);
      closeLimitedDialog();
    },
    [
      closeLimitedDialog,
      commitLimitedDialogResult,
      limitedDialogSource,
      onNotify,
      resolveLatestDialogItem,
    ],
  );

  const commitPurchaseStatusChange = useCallback(
    (nextStatus: PurchaseStatus) => {
      if (nextStatus === 'LimitedPurchase') {
        setLimitedDialogItem(null);
        setLimitedDialogSource('current');
        setLimitedDialogOpen(true);
        return;
      }

      const nextItem =
        item.purchaseStatus === 'LimitedPurchase' || item.limitedPurchasedQuantity !== undefined
          ? clearLimitedPurchase({ ...item, purchaseStatus: nextStatus })
          : { ...item, purchaseStatus: nextStatus };

      commitItemUpdate(nextItem);
    },
    [item, commitItemUpdate],
  );

  const togglePurchaseStatus = useCallback(() => {
    const nextStatus = getNextPurchaseStatus(item.purchaseStatus, {
      item,
      skipLimitedPurchaseForSingleQuantity,
    });
    commitPurchaseStatusChange(nextStatus);
  }, [item, commitPurchaseStatusChange, skipLimitedPurchaseForSingleQuantity]);

  const closePurchaseStatusMenu = useCallback(
    (options: { restoreFocus?: boolean } = {}) => {
      const { restoreFocus = true } = options;
      setPurchaseStatusMenuOpen(false);

      if (!restoreFocus) return;

      const focusButton = () => {
        purchaseStatusButtonRef.current?.focus();
      };
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(focusButton);
        return;
      }
      window.setTimeout(focusButton, 0);
    },
    [],
  );

  const setPurchaseStatus = useCallback(
    (purchaseStatus: PurchaseStatus) => {
      if (purchaseStatus === item.purchaseStatus) {
        closePurchaseStatusMenu();
        return;
      }
      if (
        purchaseStatus === 'LimitedPurchase' &&
        shouldSkipLimitedPurchaseForTransition(
          item,
          item.purchaseStatus,
          purchaseStatus,
          skipLimitedPurchaseForSingleQuantity,
        )
      ) {
        closePurchaseStatusMenu({ restoreFocus: false });
        setSingleQuantityChoiceOpen(true);
        return;
      }
      commitPurchaseStatusChange(purchaseStatus);
      closePurchaseStatusMenu();
    },
    [
      item,
      skipLimitedPurchaseForSingleQuantity,
      commitPurchaseStatusChange,
      closePurchaseStatusMenu,
    ],
  );

  const closeSingleQuantityChoice = useCallback(() => {
    setSingleQuantityChoiceOpen(false);
    restorePurchaseStatusButtonFocus();
  }, [restorePurchaseStatusButtonFocus]);

  const handleSingleQuantityChoicePurchased = useCallback(() => {
    const latestItem = resolveLatestDialogItem();
    if (latestItem === undefined) {
      onNotify?.(ITEM_NOT_FOUND_MESSAGE);
      closeSingleQuantityChoice();
      return;
    }

    switch (latestItem.purchaseStatus) {
      case 'None':
      case 'Postpone':
      case 'Late':
      case 'LimitedPurchase':
        commitItemUpdate(applyPurchasedFromLimitedInput(latestItem, getPlannedQuantity(latestItem)));
        closeSingleQuantityChoice();
        return;

      case 'Purchased':
        closeSingleQuantityChoice();
        return;

      case 'SoldOut':
      case 'Absent':
        onNotify?.(ITEM_ALREADY_CHANGED_MESSAGE);
        closeSingleQuantityChoice();
        return;

      default: {
        const _exhaustive: never = latestItem.purchaseStatus;
        void _exhaustive;
        closeSingleQuantityChoice();
        return;
      }
    }
  }, [closeSingleQuantityChoice, commitItemUpdate, onNotify, resolveLatestDialogItem]);

  const handleSingleQuantityChoiceLimited = useCallback(() => {
    const latestItem = resolveLatestDialogItem();
    if (latestItem === undefined) {
      onNotify?.(ITEM_NOT_FOUND_MESSAGE);
      closeSingleQuantityChoice();
      return;
    }

    switch (latestItem.purchaseStatus) {
      case 'None':
      case 'Postpone':
      case 'Late':
      case 'LimitedPurchase':
        setLimitedDialogItem(latestItem);
        setLimitedDialogSource('singleQuantityChoice');
        setSingleQuantityChoiceOpen(false);
        setLimitedDialogOpen(true);
        return;

      case 'Purchased':
      case 'SoldOut':
      case 'Absent':
        onNotify?.(ITEM_ALREADY_CHANGED_MESSAGE);
        closeSingleQuantityChoice();
        return;

      default: {
        const _exhaustive: never = latestItem.purchaseStatus;
        void _exhaustive;
        closeSingleQuantityChoice();
        return;
      }
    }
  }, [closeSingleQuantityChoice, onNotify, resolveLatestDialogItem]);

  const handlePurchaseStatusButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();

      if (purchaseStatusControlMode === 'radial') {
        setMenuVisible(false);
        setPurchaseStatusMenuOpen((open) => !open);
        return;
      }

      togglePurchaseStatus();
    },
    [purchaseStatusControlMode, togglePurchaseStatus],
  );

  const getEffectiveProtectionLevel = useCallback((): ProtectionLevel => {
    if (item.protectionLevel) return item.protectionLevel;
    return item.source === 'app' ? 'full' : 'none';
  }, [item.protectionLevel, item.source]);

  const toggleProtectionLevel = useCallback(() => {
    const currentLevel = getEffectiveProtectionLevel();
    const currentIndex = protectionCycle.indexOf(currentLevel);
    const nextIndex = (currentIndex + 1) % protectionCycle.length;
    const nextLevel = protectionCycle[nextIndex];
    commitItemUpdate({ ...item, protectionLevel: nextLevel });
  }, [item, commitItemUpdate, getEffectiveProtectionLevel]);

  const itemUrlHref = useMemo(() => {
    const trimmedUrl = item.url?.trim();
    if (!trimmedUrl) return undefined;
    if (/^[a-z][a-z\d+.-]*:/i.test(trimmedUrl) || trimmedUrl.startsWith('//')) {
      return trimmedUrl;
    }
    return `https://${trimmedUrl}`;
  }, [item.url]);

  const handleRemarksChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    commitItemUpdate({ ...item, remarks: e.target.value });
  };

  const clearLongPress = useCallback(() => {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  }, []);

  const handlePointerDown = (e: React.PointerEvent) => {
    // Don't trigger on drag handle or interactive elements
    if (
      (e.target as HTMLElement).closest(
        '[data-drag-handle], button, input, select, [data-no-long-press]',
      )
    ) {
      return;
    }
    clearLongPress();
    longPressTimeout.current = window.setTimeout(() => {
      setMenuVisible(true);
    }, 500); // 500ms for long press
  };

  const handlePointerUp = () => {
    clearLongPress();
  };

  const handlePointerLeave = () => {
    clearLongPress();
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuVisible && cardRef.current && !cardRef.current.contains(event.target as Node)) {
        setMenuVisible(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [menuVisible]);

  useEffect(() => {
    if (purchaseStatusControlMode !== 'radial' && purchaseStatusMenuOpen) {
      closePurchaseStatusMenu({ restoreFocus: false });
    }
  }, [purchaseStatusControlMode, purchaseStatusMenuOpen, closePurchaseStatusMenu]);

  useEffect(() => {
    if (!purchaseStatusMenuOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePurchaseStatusMenu();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [purchaseStatusMenuOpen, closePurchaseStatusMenu]);

  const priceOptions = useMemo(() => {
    const options = new Set<number | null>();
    options.add(null); // 価格未定を最初に追加
    options.add(0); // 0円を追加
    for (let i = 1; i <= 100; i++) {
      options.add(i * 100);
    }
    if (item.price !== null) {
      options.add(item.price); // Ensure current price is always an option
    }
    return Array.from(options).sort((a, b) => {
      if (a === null) return -1;
      if (b === null) return 1;
      return a - b;
    });
  }, [item.price]);

  const currentStatus = statusConfig[item.purchaseStatus];
  const locationString = `${item.block}-${item.number}`;
  const IconComponent = currentStatus.icon;

  const warningTags = useMemo(() => {
    const tags: string[] = [];
    if (isDuplicateCircle) {
      tags.push('複数種');
    }
    if (item.remarks) {
      if (item.remarks.includes('優先')) {
        tags.push('優先');
      }
      if (item.remarks.includes('委託無')) {
        tags.push('委託無');
      }
    }
    return tags;
  }, [isDuplicateCircle, item.remarks]);

  // 警告タグが表示されるかどうか
  const hasWarningTags = warningTags.length > 0;

  const isUnpurchased = item.purchaseStatus === 'None';
  const useBlockColor = isUnpurchased && blockBackgroundColor;

  const textAreaOverlayClassName = useMemo(() => {
    if (isSelected) {
      return 'bg-blue-100/80 dark:bg-blue-900/30';
    }
    if (useBlockColor) {
      return 'bg-transparent dark:bg-slate-900/45';
    }
    if (isStriped) {
      return 'bg-blue-50/40 dark:bg-slate-900/25';
    }
    return 'bg-white/80 dark:bg-slate-800/35';
  }, [isSelected, useBlockColor, isStriped]);

  const focusInfoAreaClassName = !onMoveUp ? 'dark:bg-slate-900/35 dark:rounded-md dark:px-2' : '';

  const baseBg = isSelected
    ? 'bg-blue-100 dark:bg-blue-900/50'
    : useBlockColor
      ? blockBackgroundColor
      : isStriped
        ? 'bg-blue-50/50 dark:bg-slate-900/50'
        : 'bg-white dark:bg-slate-800';

  const cardClasses = `
    rounded-lg shadow-md transition-all duration-300 relative overflow-hidden
    ${baseBg}
    ${currentStatus.dim ? 'opacity-60 dark:opacity-50' : 'opacity-100'}
    ${isSearchMatch ? 'ring-4 ring-red-500 ring-offset-2' : ''}
  `;

  const statusBgOverlay = isUnpurchased
    ? ''
    : `absolute inset-0 rounded-lg ${currentStatus.bg} pointer-events-none`;

  const purchaseStatusRadialMenu =
    purchaseStatusControlMode === 'radial' && purchaseStatusMenuOpen ? (
      <PurchaseStatusRadialMenu
        itemId={item.id}
        anchorRef={purchaseStatusButtonRef}
        currentStatus={item.purchaseStatus}
        onSelect={setPurchaseStatus}
        onCancel={closePurchaseStatusMenu}
      />
    ) : null;

  const limitedDialogSourceItem = limitedDialogItem ?? item;
  const limitedPurchaseDialog = (
    <>
      <SingleQuantityLimitedPurchaseChoiceDialog
        isOpen={singleQuantityChoiceOpen}
        onPurchased={handleSingleQuantityChoicePurchased}
        onLimited={handleSingleQuantityChoiceLimited}
        onCancel={closeSingleQuantityChoice}
      />
      <LimitedPurchaseDialog
        isOpen={limitedDialogOpen}
        itemId={limitedDialogSourceItem.id}
        itemTitle={limitedDialogSourceItem.title || limitedDialogSourceItem.circle}
        initialActual={getActualPurchasedQuantity(limitedDialogSourceItem)}
        initialPlanned={getPlannedQuantity(limitedDialogSourceItem)}
        showDeferButton
        onSubmit={handleLimitedDialogSubmit}
        onCancel={closeLimitedDialog}
      />
    </>
  );

  if (layoutMode === 'smartphone') {
    const warningStripe = hasWarningTags ? (
      <div
        className="absolute right-0 top-0 bottom-0 w-32 pointer-events-none"
        style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, #fef08a 0px, #fef08a 10px, #000 10px, #000 20px)',
          backgroundSize: '28.28px 28.28px',
          opacity: 0.3,
        }}
      />
    ) : null;

    const contextualMenu = menuVisible ? (
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm rounded-lg shadow-2xl border border-slate-300 dark:border-slate-600 p-4">
          <button
            onClick={() => {
              onEditRequest(item);
              setMenuVisible(false);
            }}
            className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
          >
            編集
          </button>
          <button
            onClick={() => {
              onDeleteRequest(item);
              setMenuVisible(false);
            }}
            className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors"
          >
            削除
          </button>
        </div>
      </div>
    ) : null;

    const compactQuantityControl =
      item.purchaseStatus === 'LimitedPurchase' ? (
        <button
          type="button"
          onClick={() => {
            setLimitedDialogItem(null);
            setLimitedDialogSource('current');
            setLimitedDialogOpen(true);
          }}
          className={`text-xs font-semibold rounded py-0.5 px-1.5 text-center bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-200 ${
            highlightLimitedMissing ? 'ring-2 ring-orange-500 animate-pulse' : ''
          }`}
        >
          {formatDisplayQuantity(item)}
        </button>
      ) : (
        <select
          value={item.quantity}
          onChange={handleQuantityChange}
          className="text-xs font-semibold bg-slate-100 dark:bg-slate-700 rounded py-0.5 px-0.5 text-center focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none w-10"
        >
          {Array.from({ length: 10 }, (_, i) => i + 1).map((num) => (
            <option key={num} value={num}>
              {num}
            </option>
          ))}
        </select>
      );

    const compactPriceControl = (
      <div className="flex items-center gap-0.5">
        {item.price !== null && (
          <span className="text-[10px] text-slate-500 dark:text-slate-400">¥</span>
        )}
        <select
          value={item.price === null ? '' : item.price}
          onChange={handlePriceChange}
          className={`text-xs font-semibold bg-slate-100 dark:bg-slate-700 rounded py-0.5 px-0.5 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none w-16 ${
            item.price === null ? 'text-red-600 dark:text-red-400' : ''
          } ${highlightPrice && item.price === null ? 'ring-2 ring-red-500 ring-offset-1 bg-red-50 dark:bg-red-900/30 animate-pulse' : ''}`}
        >
          {priceOptions.map((p) => (
            <option key={p === null ? '' : p} value={p === null ? '' : p}>
              {p === null ? '価格未定' : p === 0 ? '0' : p.toLocaleString()}
            </option>
          ))}
        </select>
      </div>
    );

    const compactStatusButton = (
      <button
        ref={purchaseStatusButtonRef}
        onClick={handlePurchaseStatusButtonClick}
        data-no-long-press
        aria-haspopup={purchaseStatusControlMode === 'radial' ? 'dialog' : undefined}
        aria-expanded={purchaseStatusControlMode === 'radial' ? purchaseStatusMenuOpen : undefined}
        className="p-1 rounded-md bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
        aria-label={`Current status: ${currentStatus.label}. Click to change.`}
        title={currentStatus.label}
      >
        <IconComponent className={`w-4 h-4 ${currentStatus.color}`} />
      </button>
    );

    if (viewMode !== 'edit') {
      return (
        <div
          className={cardClasses}
          ref={cardRef}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onTouchMove={handlePointerLeave}
          data-search-match={isSearchMatch ? 'true' : undefined}
        >
          {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-500" />}
          {statusBgOverlay && <div className={statusBgOverlay} />}
          {warningStripe}

          <div className="flex">
            <div
              data-drag-handle
              className="relative p-2 flex flex-col items-center justify-start cursor-grab text-slate-400 dark:text-slate-500 border-r border-slate-200/80 dark:border-slate-700/80 space-y-1 z-10"
            >
              {hallIndex !== undefined && (
                <div
                  className={`w-7 h-7 flex items-center justify-center text-white rounded-full text-xs font-bold flex-shrink-0 ${
                    priorityLevel === 'highest'
                      ? 'bg-red-600'
                      : priorityLevel === 'priority'
                        ? 'bg-orange-500'
                        : 'bg-blue-600'
                  }`}
                >
                  {hallIndex + 1}
                </div>
              )}
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onSelectItem(item.id)}
                onClick={(e) => e.stopPropagation()}
                data-no-long-press
                className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500"
                aria-label={`Select item ${item.circle} - ${item.title}`}
              />
              <GripVerticalIcon className="w-5 h-5" />
            </div>

            <div className="flex-grow flex flex-col min-w-0 relative z-10">
              <div className={`p-2 pb-1 ${focusInfoAreaClassName}`}>
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-grow min-w-0">
                    <p className="font-bold text-sm text-slate-900 dark:text-slate-100">{`${item.eventDate} ${locationString}`}</p>
                    <div className="flex items-center gap-1 flex-wrap mt-0.5">
                      <p className="text-sm text-slate-600 dark:text-slate-300 truncate" title={item.circle}>
                        {item.circle}
                      </p>
                      {warningTags.map((tag, index) => (
                        <img key={index} src={`/${tag}.png`} alt={tag} className="h-8 w-auto object-contain" />
                      ))}
                    </div>
                  </div>
                </div>
                <p
                  className={`text-sm font-semibold text-slate-700 dark:text-slate-200 truncate mt-1 ${currentStatus.dim ? 'line-through' : ''}`}
                  title={item.title}
                >
                  {item.title || '（タイトルなし）'}
                </p>
              </div>

              <div className="p-2 pt-1 flex flex-col gap-1.5 border-t border-slate-200/50 dark:border-slate-700/50">
                {itemUrlHref && (
                  <div className="flex justify-end">
                    <a
                      href={itemUrlHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      data-no-long-press
                      className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-blue-500 dark:text-blue-400 transition-colors flex items-center gap-1"
                      aria-label="URLを開く"
                      title="URLを開く"
                    >
                      <ExternalLinkIcon className="w-4 h-4" />
                      <span className="text-xs">リンク</span>
                    </a>
                  </div>
                )}
                <input
                  type="text"
                  value={item.remarks}
                  onChange={handleRemarksChange}
                  placeholder="備考"
                  className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 w-full focus:ring-2 focus:ring-blue-500 focus:outline-none transition"
                />
                <div className="flex items-center justify-between">
                  <div className="flex-1" />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-slate-600 dark:text-slate-400">数量</span>
                    {compactQuantityControl}
                  </div>
                  <div className="flex-1" />
                  <div className="flex items-center gap-2">
                    {compactPriceControl}
                    <button
                      ref={purchaseStatusButtonRef}
                      onClick={handlePurchaseStatusButtonClick}
                      data-no-long-press
                      aria-haspopup={purchaseStatusControlMode === 'radial' ? 'dialog' : undefined}
                      aria-expanded={purchaseStatusControlMode === 'radial' ? purchaseStatusMenuOpen : undefined}
                      className="flex items-center space-x-1 p-1.5 rounded-md bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                      aria-label={`Current status: ${currentStatus.label}. Click to change.`}
                    >
                      <IconComponent className={`w-5 h-5 ${currentStatus.color}`} />
                      <span className={`text-xs font-semibold ${currentStatus.color}`}>
                        {currentStatus.label}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {purchaseStatusRadialMenu}
          {limitedPurchaseDialog}
          {contextualMenu}
        </div>
      );
    }

    return (
      <div
        className={cardClasses}
        ref={cardRef}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onTouchMove={handlePointerLeave}
        data-search-match={isSearchMatch ? 'true' : undefined}
      >
        {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-500" />}
        {statusBgOverlay && <div className={statusBgOverlay} />}
        {warningStripe}

        <div className="flex flex-col">
          <div
            data-drag-handle
            className="relative p-1 flex flex-row items-center cursor-grab text-slate-400 dark:text-slate-500 border-b border-slate-200/80 dark:border-slate-700/80 gap-0.5 z-10"
          >
            {hallIndex !== undefined && (
              <div
                className={`w-5 h-5 flex items-center justify-center text-white rounded-full text-[10px] font-bold flex-shrink-0 ${
                  priorityLevel === 'highest'
                    ? 'bg-red-600'
                    : priorityLevel === 'priority'
                      ? 'bg-orange-500'
                      : 'bg-blue-600'
                }`}
              >
                {hallIndex + 1}
              </div>
            )}
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => onSelectItem(item.id)}
              onClick={(e) => e.stopPropagation()}
              data-no-long-press
              className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500"
              aria-label={`Select item ${item.circle} - ${item.title}`}
            />
            {onMoveUp && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveUp(item.id);
                }}
                disabled={!canMoveUp}
                data-no-long-press
                className={`p-0.5 rounded-md transition-colors ${canMoveUp ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'}`}
                aria-label="上に移動"
              >
                <ChevronUpIcon className="w-3.5 h-3.5" />
              </button>
            )}
            <GripVerticalIcon className="w-4 h-4 mx-1" />
            {onMoveDown && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveDown(item.id);
                }}
                disabled={!canMoveDown}
                data-no-long-press
                className={`p-0.5 rounded-md transition-colors ${canMoveDown ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer' : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'}`}
                aria-label="下に移動"
              >
                <ChevronDownIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex-grow flex flex-col min-w-0 relative z-10">
            <div className={`p-1.5 pb-0.5 ${focusInfoAreaClassName}`}>
              <div className="flex items-center gap-1 flex-wrap min-w-0">
                <span className="font-bold text-xs text-slate-900 dark:text-slate-100 flex-shrink-0">{locationString}</span>
                <span className="text-xs text-slate-600 dark:text-slate-300 truncate" title={item.circle}>
                  {item.circle}
                </span>
                {warningTags.map((tag, index) => (
                  <img key={index} src={`/${tag}.png`} alt={tag} className="h-5 w-auto object-contain" />
                ))}
              </div>
              <div className="flex items-center gap-0.5 mt-0.5">
                <p
                  className={`text-xs font-semibold text-slate-700 dark:text-slate-200 truncate flex-1 ${currentStatus.dim ? 'line-through' : ''}`}
                  title={item.title}
                >
                  {item.title || '（タイトルなし）'}
                </p>
                {itemUrlHref && (
                  <a
                    href={itemUrlHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    data-no-long-press
                    className="p-0.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-blue-500 dark:text-blue-400 transition-colors flex-shrink-0"
                    aria-label="URLを開く"
                    title="URLを開く"
                  >
                    <ExternalLinkIcon className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>

            <div className="p-1.5 pt-0.5 flex flex-col gap-1 border-t border-slate-200/50 dark:border-slate-700/50">
              {item.remarks && (
                <input
                  type="text"
                  value={item.remarks}
                  onChange={handleRemarksChange}
                  placeholder="備考"
                  className="text-xs bg-slate-100 dark:bg-slate-700 rounded py-0.5 px-1.5 w-full focus:ring-2 focus:ring-blue-500 focus:outline-none transition"
                />
              )}
              <div className="flex items-center justify-end gap-1">
                {compactQuantityControl}
                {compactPriceControl}
                {compactStatusButton}
              </div>
            </div>
          </div>
        </div>

        {purchaseStatusRadialMenu}
        {limitedPurchaseDialog}
        {contextualMenu}
      </div>
    );
  }

  const pcCardClasses = `
    rounded-lg shadow-md transition-all duration-300 flex items-stretch relative overflow-hidden
    ${baseBg}
    ${currentStatus.dim ? 'opacity-60 dark:opacity-50' : 'opacity-100'}
    ${isSearchMatch ? 'ring-4 ring-red-500 ring-offset-2' : ''}
  `;

  return (
    <div
      className={pcCardClasses}
      ref={cardRef}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onTouchMove={handlePointerLeave} // Cancel on scroll
      data-search-match={isSearchMatch ? 'true' : undefined}
    >
      {isSelected && <div className="absolute left-0 top-0 bottom-0 w-1.5 bg-blue-500 z-30"></div>}
      {statusBgOverlay && <div className={statusBgOverlay}></div>}

      {/* 警告ストライプ: カード左端の縦バー（右側の可読性を阻害しない） */}
      {hasWarningTags && !isSelected && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1.5 pointer-events-none z-10"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, #fef08a 0px, #fef08a 6px, #000 6px, #000 12px)',
          }}
        />
      )}

      {/* 左サイドバー */}
      <div
        data-drag-handle
        className="relative p-3 flex flex-col items-center justify-start cursor-grab text-slate-400 dark:text-slate-500 border-r border-slate-200/80 dark:border-slate-700/80 space-y-2 z-10 flex-shrink-0"
      >
        {/* ホール内番号表示 */}
        {hallIndex !== undefined && (
          <div
            className={`w-8 h-8 flex items-center justify-center text-white rounded-full text-sm font-bold flex-shrink-0 ${
              priorityLevel === 'highest'
                ? 'bg-red-600'
                : priorityLevel === 'priority'
                  ? 'bg-orange-500'
                  : 'bg-blue-600'
            }`}
          >
            {hallIndex + 1}
          </div>
        )}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onSelectItem(item.id)}
          onClick={(e) => e.stopPropagation()}
          data-no-long-press
          className="w-5 h-5 rounded text-blue-600 focus:ring-blue-500"
          aria-label={`Select item ${item.circle} - ${item.title}`}
        />
        {onMoveUp && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp(item.id);
            }}
            disabled={!canMoveUp}
            data-no-long-press
            className={`p-1 rounded-md transition-colors ${
              canMoveUp
                ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer'
                : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'
            }`}
            aria-label="上に移動"
            title="上に移動"
          >
            <ChevronUpIcon className="w-4 h-4" />
          </button>
        )}
        <GripVerticalIcon className="w-6 h-6" />
        {onMoveDown && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown(item.id);
            }}
            disabled={!canMoveDown}
            data-no-long-press
            className={`p-1 rounded-md transition-colors ${
              canMoveDown
                ? 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 cursor-pointer'
                : 'text-slate-300 dark:text-slate-600 cursor-not-allowed opacity-50'
            }`}
            aria-label="下に移動"
            title="下に移動"
          >
            <ChevronDownIcon className="w-4 h-4" />
          </button>
        )}
        {/* 保護レベルトグルボタン（編集・実行・集中モード 全てで表示） */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleProtectionLevel();
          }}
          data-no-long-press
          className={`p-1 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 ${protectionConfig[getEffectiveProtectionLevel()].color}`}
          aria-label={protectionConfig[getEffectiveProtectionLevel()].label}
          title={protectionConfig[getEffectiveProtectionLevel()].title}
        >
          <span className="text-base">{protectionConfig[getEffectiveProtectionLevel()].icon}</span>
        </button>
      </div>

      {/* 中央エリア: CSS Grid 3行構造（情報 / タイトル / 備考） */}
      <div
        className="relative flex-grow p-4 min-w-0 z-20 grid gap-2"
        style={{ gridTemplateRows: 'auto 1fr auto' }}
      >
        {/* 背景オーバーレイ */}
        <div
          className={`absolute inset-0 rounded-lg pointer-events-none ${textAreaOverlayClassName}`}
        ></div>

        {/* Row 1: 日付バッジ + 配置バッジ + サークル名 + 警告バッジ列 */}
        <div className="relative z-10 flex items-center gap-2 flex-wrap min-w-0">
          <span className="inline-flex items-center whitespace-nowrap flex-shrink-0 px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 text-sm font-semibold">
            {item.eventDate}
          </span>
          <span className="inline-flex items-center whitespace-nowrap flex-shrink-0 px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-sm font-bold">
            {locationString}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (truncatedMap.circle || expanded.has('circle')) toggleExpand('circle');
            }}
            data-no-long-press
            title={item.circle}
            aria-expanded={expanded.has('circle')}
            className={`text-left text-slate-700 dark:text-slate-300 text-sm min-w-0 flex-1 rounded inline-flex items-center gap-1 transition-colors ${
              expanded.has('circle')
                ? 'whitespace-normal bg-blue-50 dark:bg-blue-900/30 px-2 py-0.5 ring-1 ring-blue-300 dark:ring-blue-700'
                : ''
            } ${
              truncatedMap.circle && !expanded.has('circle')
                ? 'border border-dashed border-blue-300 dark:border-blue-700 px-1.5 cursor-pointer hover:bg-blue-50/60 dark:hover:bg-blue-900/20'
                : ''
            }`}
          >
            <span
              ref={circleTextRef}
              className={
                expanded.has('circle') ? 'break-words flex-1' : 'truncate flex-1 min-w-0 block'
              }
            >
              {item.circle}
            </span>
            {(truncatedMap.circle || expanded.has('circle')) && (
              <span
                className="flex-shrink-0 text-blue-500 dark:text-blue-400 text-xs"
                aria-hidden="true"
              >
                {expanded.has('circle') ? '⌃' : '⌄'}
              </span>
            )}
          </button>
          {warningTags.map((tag, index) => (
            <img
              key={index}
              src={`/${tag}.png`}
              alt={tag}
              className="h-6 w-auto object-contain flex-shrink-0"
            />
          ))}
        </div>

        {/* Row 2: タイトル（中央寄せ、truncate + タップ展開） */}
        <div
          className={`relative z-10 flex items-center justify-center min-w-0 text-center text-slate-700 dark:text-slate-200 ${currentStatus.dim ? 'line-through' : ''}`}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (truncatedMap.title || expanded.has('title')) toggleExpand('title');
            }}
            data-no-long-press
            title={item.title}
            aria-expanded={expanded.has('title')}
            className={`text-lg font-semibold min-w-0 max-w-full rounded inline-flex items-center gap-1.5 transition-colors ${
              expanded.has('title')
                ? 'whitespace-normal bg-blue-50 dark:bg-blue-900/30 px-3 py-1 ring-1 ring-blue-300 dark:ring-blue-700'
                : ''
            } ${
              truncatedMap.title && !expanded.has('title')
                ? 'border border-dashed border-blue-300 dark:border-blue-700 px-2 cursor-pointer hover:bg-blue-50/60 dark:hover:bg-blue-900/20'
                : ''
            }`}
          >
            <span
              ref={titleTextRef}
              className={
                expanded.has('title') ? 'break-words' : 'truncate min-w-0 flex-1 block'
              }
            >
              {item.title || '（タイトルなし）'}
            </span>
            {(truncatedMap.title || expanded.has('title')) && (
              <span
                className="flex-shrink-0 text-blue-500 dark:text-blue-400 text-sm"
                aria-hidden="true"
              >
                {expanded.has('title') ? '⌃' : '⌄'}
              </span>
            )}
          </button>
        </div>

        {/* Row 3: 備考入力 + リンクアイコン（常に備考の右に統一） */}
        <div className="relative z-10 flex items-center gap-2 min-w-0">
          <input
            type="text"
            value={item.remarks}
            onChange={handleRemarksChange}
            placeholder="備考"
            className="flex-1 min-w-0 text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 focus:ring-2 focus:ring-blue-500 focus:outline-none transition"
          />
          {itemUrlHref && (
            <a
              href={itemUrlHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              data-no-long-press
              className="p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-blue-500 dark:text-blue-400 transition-colors flex items-center flex-shrink-0"
              aria-label="URLを開く"
              title="URLを開く"
            >
              <ExternalLinkIcon className="w-5 h-5" />
            </a>
          )}
        </div>
      </div>

      {/* 右サイドバー（購入トグル / 数量 / 価格） */}
      <div className="relative flex flex-col items-stretch justify-between gap-3 px-3 py-3 border-l border-slate-200/80 dark:border-slate-700/80 z-10 flex-shrink-0">
        <button
          ref={purchaseStatusButtonRef}
          onClick={handlePurchaseStatusButtonClick}
          data-no-long-press
          aria-haspopup={purchaseStatusControlMode === 'radial' ? 'dialog' : undefined}
          aria-expanded={purchaseStatusControlMode === 'radial' ? purchaseStatusMenuOpen : undefined}
          className="flex items-center space-x-2 p-2 rounded-md bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors relative z-10 justify-start"
          aria-label={`Current status: ${currentStatus.label}. Click to change.`}
        >
          <IconComponent className={`w-7 h-7 flex-shrink-0 ${currentStatus.color}`} />
          <span className={`font-semibold whitespace-nowrap ${currentStatus.color}`}>
            {currentStatus.label}
          </span>
        </button>
        <div className="flex items-center gap-2 relative z-10">
          <span className="text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">
            数量
          </span>
          {item.purchaseStatus === 'LimitedPurchase' ? (
            <button
              type="button"
              onClick={() => {
                setLimitedDialogItem(null);
                setLimitedDialogSource('current');
                setLimitedDialogOpen(true);
              }}
              className={`flex-1 text-base font-semibold rounded-md py-1 px-2 text-center bg-orange-50 text-orange-700 dark:bg-orange-900/30 dark:text-orange-200 tabular-nums ${
                highlightLimitedMissing ? 'ring-2 ring-orange-500 animate-pulse' : ''
              }`}
            >
              {formatDisplayQuantity(item)}
            </button>
          ) : (
            <select
              value={item.quantity}
              onChange={handleQuantityChange}
              className="flex-1 text-base font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 pl-2 pr-8 text-center focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none tabular-nums"
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((num) => (
                <option key={num} value={num}>
                  {num}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-1 relative z-10">
          <span className="text-sm text-slate-600 dark:text-slate-400 whitespace-nowrap">
            価格
          </span>
          {item.price !== null && (
            <span className="text-slate-500 dark:text-slate-400 text-sm">¥</span>
          )}
          <select
            value={item.price === null ? '' : item.price}
            onChange={handlePriceChange}
            className={`flex-1 text-base font-semibold bg-slate-100 dark:bg-slate-700 rounded-md py-1 pl-2 pr-8 text-right focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none tabular-nums ${
              item.price === null ? 'text-red-600 dark:text-red-400' : ''
            } ${highlightPrice && item.price === null ? 'ring-2 ring-red-500 ring-offset-1 bg-red-50 dark:bg-red-900/30 animate-pulse' : ''}`}
          >
            {priceOptions.map((p) => (
              <option key={p === null ? '' : p} value={p === null ? '' : p}>
                {p === null ? '価格未定' : p === 0 ? '0' : p.toLocaleString()}
              </option>
            ))}
          </select>
        </div>
      </div>

      {purchaseStatusRadialMenu}
      {limitedPurchaseDialog}
      {menuVisible && (
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-20"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-col gap-2 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm rounded-lg shadow-2xl border border-slate-300 dark:border-slate-600 p-4">
            <button
              onClick={() => {
                onEditRequest(item);
                setMenuVisible(false);
              }}
              className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
            >
              編集
            </button>
            <button
              onClick={() => {
                onDeleteRequest(item);
                setMenuVisible(false);
              }}
              className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-red-600 hover:bg-red-700 transition-colors"
            >
              削除
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default React.memo(ShoppingItemCard, areSameShoppingItemCardProps);
