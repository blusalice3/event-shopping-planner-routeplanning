import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import LimitedPurchaseExcessConfirmDialog from './LimitedPurchaseExcessConfirmDialog';
import {
  parseDecimalIntegerInput,
  validateLimitedPurchasePlannedQuantity,
  validateLimitedPurchaseQuantities,
  type LimitedPurchaseValidationError,
} from '../utils/purchaseQuantity';

export type LimitedPurchaseDialogResult =
  | { kind: 'limited'; actual: number; planned: number }
  | { kind: 'purchased'; planned: number }
  | { kind: 'defer'; planned: number };

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

  useEffect(() => {
    if (!isOpen) return;
    setActualText(initialActual === undefined ? '' : String(initialActual));
    setPlannedText(String(initialPlanned));
    setError(null);
    setExcessConfirm(null);
  }, [isOpen, itemId, dialogKey, initialActual, initialPlanned]);

  if (!isOpen) return null;

  const handleSubmit = () => {
    const actual = parseDecimalIntegerInput(actualText);
    const planned = parseDecimalIntegerInput(plannedText);
    const validation = validateLimitedPurchaseQuantities(actual, planned);

    if (validation.ok) {
      onSubmit({ kind: 'limited', actual: actual!, planned: planned! });
      return;
    }

    if (
      validation.error === 'actual_not_less_than_planned' &&
      actual !== undefined &&
      planned !== undefined
    ) {
      if (actual === planned) {
        if (window.confirm('全て購入できているので「購入済」にします。よろしいですか？')) {
          onSubmit({ kind: 'purchased', planned });
        }
        return;
      }

      if (actual > planned) {
        setExcessConfirm({ planned });
        return;
      }
    }

    setError(toMessage(validation.error));
  };

  const handleDefer = () => {
    const planned = parseDecimalIntegerInput(plannedText);
    const validation = validateLimitedPurchasePlannedQuantity(planned);

    if (validation.ok) {
      onSubmit({ kind: 'defer', planned: planned! });
      return;
    }

    setError(toMessage(validation.error));
  };

  const dialogContent = (
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="limited-purchase-dialog-title"
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
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
          {error && <p className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
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
              type="button"
              onClick={handleSubmit}
              className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
            >
              保存
            </button>
          </div>
        </div>
      </div>
      <LimitedPurchaseExcessConfirmDialog
        isOpen={excessConfirm !== null}
        onFix={() => setExcessConfirm(null)}
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
