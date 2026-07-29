import { useEffect, useId, useRef, type KeyboardEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

type SingleQuantityLimitedPurchaseChoiceDialogProps = {
  isOpen: boolean;
  onPurchased: () => void;
  onLimited: () => void;
  onCancel: () => void;
};

const stopDialogEvent = (event: SyntheticEvent) => {
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
};

export default function SingleQuantityLimitedPurchaseChoiceDialog({
  isOpen,
  onPurchased,
  onLimited,
  onCancel,
}: SingleQuantityLimitedPurchaseChoiceDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const limitedButtonRef = useRef<HTMLButtonElement | null>(null);
  const purchasedButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    purchasedButtonRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onCancel]);

  if (!isOpen) return null;

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;

    const focusableButtons = [
      cancelButtonRef.current,
      limitedButtonRef.current,
      purchasedButtonRef.current,
    ].filter((button): button is HTMLButtonElement => button !== null);
    if (focusableButtons.length === 0) return;

    const firstButton = focusableButtons[0];
    const lastButton = focusableButtons[focusableButtons.length - 1];

    if (event.shiftKey && document.activeElement === firstButton) {
      event.preventDefault();
      lastButton.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault();
      firstButton.focus();
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onClick={stopDialogEvent}
      onMouseDown={stopDialogEvent}
      onMouseUp={stopDialogEvent}
      onPointerDown={stopDialogEvent}
      onPointerUp={stopDialogEvent}
      onKeyDown={handleDialogKeyDown}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
        onClick={stopDialogEvent}
        onMouseDown={stopDialogEvent}
        onMouseUp={stopDialogEvent}
        onPointerDown={stopDialogEvent}
        onPointerUp={stopDialogEvent}
      >
        <h3 id={titleId} className="text-base font-semibold text-slate-900 dark:text-slate-100">
          限数にしますか？
        </h3>
        <p id={descriptionId} className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          数量が1のため、通常は購入済として扱います。限数にしますか？
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-2 text-sm"
          >
            キャンセル
          </button>
          <button
            ref={limitedButtonRef}
            type="button"
            onClick={onLimited}
            className="rounded px-3 py-2 text-sm text-orange-700 hover:bg-orange-50 dark:text-orange-200 dark:hover:bg-orange-900/30"
          >
            限数
          </button>
          <button
            ref={purchasedButtonRef}
            type="button"
            onClick={onPurchased}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
          >
            購入済
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
