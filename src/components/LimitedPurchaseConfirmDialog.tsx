import React, { useEffect, useId, useRef } from "react";

type LimitedPurchaseConfirmDialogProps = {
  isOpen: boolean;
  isModal?: boolean;
  title: string;
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  initialFocus: "cancel" | "confirm";
  onCancel: () => void;
  onConfirm: () => void;
};

const stopDialogEvent = (event: React.SyntheticEvent) => {
  event.stopPropagation();
  event.nativeEvent.stopImmediatePropagation?.();
};

export default function LimitedPurchaseConfirmDialog({
  isOpen,
  isModal = true,
  title,
  message,
  cancelLabel,
  confirmLabel,
  initialFocus,
  onCancel,
  onConfirm,
}: LimitedPurchaseConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const target =
      initialFocus === "confirm"
        ? confirmButtonRef.current
        : cancelButtonRef.current;
    target?.focus();
  }, [initialFocus, isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const first = cancelButtonRef.current;
    const last = confirmButtonRef.current;
    if (!first || !last) return;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal={isModal}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50"
      onClick={stopDialogEvent}
      onMouseDown={stopDialogEvent}
      onMouseUp={stopDialogEvent}
      onPointerDown={stopDialogEvent}
      onPointerUp={stopDialogEvent}
      onKeyDown={handleKeyDown}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
        onClick={stopDialogEvent}
        onMouseDown={stopDialogEvent}
        onMouseUp={stopDialogEvent}
        onPointerDown={stopDialogEvent}
        onPointerUp={stopDialogEvent}
      >
        <h3
          id={titleId}
          className="text-base font-semibold text-slate-900 dark:text-slate-100"
        >
          {title}
        </h3>
        <p
          id={descriptionId}
          className="mt-2 text-sm text-slate-600 dark:text-slate-300"
        >
          {message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-2 text-sm"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            onClick={onConfirm}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
