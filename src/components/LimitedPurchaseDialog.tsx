import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LimitedPurchaseDialogResult } from '../types/limitedPurchase';
export type { LimitedPurchaseDialogResult } from '../types/limitedPurchase';
import LimitedPurchaseConfirmDialog from './LimitedPurchaseConfirmDialog';
import LimitedPurchaseExcessConfirmDialog from './LimitedPurchaseExcessConfirmDialog';
import {
  parseDecimalIntegerInput,
  validateLimitedPurchasePlannedQuantity,
  type LimitedPurchaseValidationError,
} from '../utils/purchaseQuantity';

type LimitedPurchaseDialogProps = {
  isOpen: boolean;
  itemId?: string;
  dialogKey?: string;
  itemTitle?: string;
  initialActual?: number;
  initialPlanned: number;
  showDeferButton?: boolean;
  onSubmit: (result: LimitedPurchaseDialogResult) => void;
  onCancel: () => void;
};

const toMessage = (error: LimitedPurchaseValidationError): string => {
  if (error === 'planned_required') return '購入予定量を入力してください';
  if (error === 'actual_required') return '実購入数を入力してください';
  if (error === 'planned_not_integer') return '購入予定量は整数で入力してください';
  if (error === 'actual_not_integer') return '実購入数は整数で入力してください';
  if (error === 'planned_not_positive') return '購入予定量は1以上で入力してください';
  if (error === 'actual_not_positive') return '実購入数は1以上で入力してください';
  return '限数購入では実購入数を購入予定量より少なくしてください';
};

const SINGLE_QUANTITY_LIMITED_MESSAGE =
  '限数として保存するには、購入予定数を2以上に変更してください。';

const stopDialogEvent = (event: React.SyntheticEvent) => {
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
};

export default function LimitedPurchaseDialog({
  isOpen,
  itemId,
  dialogKey,
  itemTitle,
  initialActual,
  initialPlanned,
  showDeferButton = false,
  onSubmit,
  onCancel,
}: LimitedPurchaseDialogProps) {
  const [actualText, setActualText] = useState('');
  const [plannedText, setPlannedText] = useState(String(initialPlanned));
  const [error, setError] = useState<string | null>(null);
  const [excessConfirm, setExcessConfirm] = useState<{ planned: number } | null>(null);
  const [sameQuantityConfirm, setSameQuantityConfirm] = useState<{ planned: number } | null>(null);
  const saveButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setExcessConfirm(null);
      setSameQuantityConfirm(null);
      return;
    }
    setActualText(initialActual === undefined ? '' : String(initialActual));
    setPlannedText(String(initialPlanned));
    setError(null);
    setExcessConfirm(null);
    setSameQuantityConfirm(null);
  }, [isOpen, itemId, dialogKey, initialActual, initialPlanned]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (sameQuantityConfirm !== null) {
        setSameQuantityConfirm(null);
        window.setTimeout(() => saveButtonRef.current?.focus(), 0);
        return;
      }
      if (excessConfirm !== null) {
        setExcessConfirm(null);
        window.setTimeout(() => saveButtonRef.current?.focus(), 0);
        return;
      }
      onCancel();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [excessConfirm, isOpen, onCancel, sameQuantityConfirm]);

  if (!isOpen) return null;

  const restoreSaveFocus = () => {
    window.setTimeout(() => saveButtonRef.current?.focus(), 0);
  };

  const closeSameQuantityConfirm = () => {
    setSameQuantityConfirm(null);
    restoreSaveFocus();
  };

  const closeExcessConfirm = () => {
    setExcessConfirm(null);
    restoreSaveFocus();
  };

  const handleSubmit = () => {
    const actual = parseDecimalIntegerInput(actualText);
    const planned = parseDecimalIntegerInput(plannedText);

    if (actual === undefined) {
      setError(toMessage('actual_required'));
      return;
    }
    if (!Number.isInteger(actual)) {
      setError(toMessage('actual_not_integer'));
      return;
    }
    if (actual < 1) {
      setError(toMessage('actual_not_positive'));
      return;
    }
    if (planned === undefined) {
      setError(toMessage('planned_required'));
      return;
    }
    if (!Number.isInteger(planned)) {
      setError(toMessage('planned_not_integer'));
      return;
    }
    if (planned < 1) {
      setError(toMessage('planned_not_positive'));
      return;
    }

    if (actual === planned) {
      setSameQuantityConfirm({ planned });
      return;
    }

    if (planned === 1) {
      setError(SINGLE_QUANTITY_LIMITED_MESSAGE);
      return;
    }

    if (actual > planned) {
      setExcessConfirm({ planned });
      return;
    }

    onSubmit({ kind: 'limited', actual, planned });
  };

  const handleDefer = () => {
    const planned = parseDecimalIntegerInput(plannedText);
    const validation = validateLimitedPurchasePlannedQuantity(planned);

    if (validation.ok && planned === 1) {
      setError(SINGLE_QUANTITY_LIMITED_MESSAGE);
      return;
    }

    if (validation.ok) {
      onSubmit({ kind: 'defer', planned: planned! });
      return;
    }

    setError(toMessage(validation.error));
  };

  const isConfirmOpen = sameQuantityConfirm !== null || excessConfirm !== null;
  const parsedPlannedForHelp = parseDecimalIntegerInput(plannedText);
  const shouldShowSingleQuantityHelp =
    error === null &&
    sameQuantityConfirm === null &&
    excessConfirm === null &&
    parsedPlannedForHelp === 1;

  const dialogContent = (
    <>
      <div
        role="dialog"
        aria-modal={!isConfirmOpen}
        aria-labelledby="limited-purchase-dialog-title"
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
        onClick={stopDialogEvent}
        onMouseDown={stopDialogEvent}
        onPointerDown={stopDialogEvent}
      >
        <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800">
          <h3
            id="limited-purchase-dialog-title"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            限数購入の数量
          </h3>
          {itemTitle && (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">対象: {itemTitle}</p>
          )}
          <label className="mt-4 block text-sm font-medium text-slate-700 dark:text-slate-200">
            実購入数
            <input
              value={actualText}
              onChange={(e) => {
                setActualText(e.target.value);
                setError(null);
              }}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              inputMode="numeric"
            />
          </label>
          <label className="mt-3 block text-sm font-medium text-slate-700 dark:text-slate-200">
            購入予定量
            <input
              value={plannedText}
              onChange={(e) => {
                setPlannedText(e.target.value);
                setError(null);
              }}
              className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              inputMode="numeric"
            />
          </label>
          {error ? (
            <p className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>
          ) : shouldShowSingleQuantityHelp ? (
            <p className="mt-3 text-sm text-red-600 dark:text-red-300">
              {SINGLE_QUANTITY_LIMITED_MESSAGE}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {showDeferButton && (
              <button
                type="button"
                onClick={handleDefer}
                className="rounded px-3 py-2 text-sm text-orange-700 hover:bg-orange-50 dark:text-orange-200 dark:hover:bg-orange-900/30"
              >
                この商品を後で入力
              </button>
            )}
            <button type="button" onClick={onCancel} className="rounded px-3 py-2 text-sm">
              キャンセル
            </button>
            <button
              ref={saveButtonRef}
              type="button"
              onClick={handleSubmit}
              className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
            >
              保存
            </button>
          </div>
        </div>
      </div>
      <LimitedPurchaseConfirmDialog
        isOpen={sameQuantityConfirm !== null}
        isModal
        title="購入済として保存しますか？"
        message="実購入数と購入予定数が同じため、購入済として保存しますか？"
        cancelLabel="入力に戻る"
        confirmLabel="購入済にする"
        initialFocus="confirm"
        onCancel={closeSameQuantityConfirm}
        onConfirm={() => {
          if (!sameQuantityConfirm) return;
          onSubmit({ kind: 'purchased', planned: sameQuantityConfirm.planned });
          setSameQuantityConfirm(null);
        }}
      />
      <LimitedPurchaseExcessConfirmDialog
        isOpen={excessConfirm !== null}
        isModal
        onFix={closeExcessConfirm}
        onConvertToPurchased={() => {
          if (!excessConfirm) return;
          onSubmit({ kind: 'purchased', planned: excessConfirm.planned });
          setExcessConfirm(null);
        }}
      />
    </>
  );

  if (typeof document === 'undefined') {
    return dialogContent;
  }

  return createPortal(dialogContent, document.body);
}
