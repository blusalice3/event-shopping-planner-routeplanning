type LimitedPurchaseExcessConfirmDialogProps = {
  isOpen: boolean;
  onFix: () => void;
  onConvertToPurchased: () => void;
};

export default function LimitedPurchaseExcessConfirmDialog({
  isOpen,
  onFix,
  onConvertToPurchased,
}: LimitedPurchaseExcessConfirmDialogProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="limited-purchase-excess-title"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50"
    >
      <div className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800">
        <h3
          id="limited-purchase-excess-title"
          className="text-base font-semibold text-slate-900 dark:text-slate-100"
        >
          実購入数が購入予定量を超過しています
        </h3>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">修正しますか</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onFix} className="rounded px-3 py-2 text-sm">
            修正する
          </button>
          <button
            type="button"
            onClick={onConvertToPurchased}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
          >
            購入済にする
          </button>
        </div>
      </div>
    </div>
  );
}
