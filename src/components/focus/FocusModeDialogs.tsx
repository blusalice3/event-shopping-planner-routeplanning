import type React from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { FocusPhase } from "../../types/focus";
import type { ShoppingItem } from "../../types/item";
import { acquireBodyScrollLock } from "../../utils/bodyScrollLock";
import { buildQuantityOptions } from "../quantityOptions";
import type { PhaseChangeDialogState } from "./hooks/useFocusSessionState";

type VisitGroup = {
  key: string;
  items: ShoppingItem[];
};

type CellPopupState = {
  isOpen: boolean;
  blockName: string;
  number: number;
  items: ShoppingItem[];
};

export type CellTemporaryTarget = {
  visitId: string;
  spaceKey: string;
  displayLabel: string;
  itemIds: string[];
  itemCount: number;
  disabled?: boolean;
};

export type TemporaryPhaseChoice = {
  phase: FocusPhase;
  label: string;
  detail: string;
  disabled?: boolean;
};

export type TemporaryRemainingSpace = {
  visitId: string;
  spaceKey: string;
  label: string;
  circles: string[];
  itemCount: number;
  disabled?: boolean;
};

export type TemporaryRemainingSection = {
  phase: FocusPhase;
  label: string;
  entries: TemporaryRemainingSpace[];
};

type AddItemDialogState = {
  isOpen: boolean;
  eventDate: string;
  block: string;
  number: string;
};

type AddItemFormState = {
  circle: string;
  title: string;
  price: string;
  quantity: string;
  remarks: string;
  url: string;
  purchaseStatus: "Purchased" | "Postpone" | "Late";
};

const formInputClass =
  "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white";
const labelClass =
  "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";
const CELL_POPUP_OPENING_CLICK_GUARD_MS = 500;

const useModalInteractionLock = (isOpen: boolean) => {
  useEffect(() => {
    if (!isOpen) return;
    return acquireBodyScrollLock({ lockOverscroll: true });
  }, [isOpen]);
};

export function PhaseChangeDialogView({
  dialog,
  visitsByPhase,
  onStart,
  onSaved,
  onCancel,
}: {
  dialog: PhaseChangeDialogState;
  visitsByPhase: Record<FocusPhase, VisitGroup[]>;
  onStart: () => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const isRendered = dialog.isOpen && dialog.targetPhase !== null;

  useModalInteractionLock(isRendered);

  useLayoutEffect(() => {
    if (!isRendered) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus({ preventScroll: true });

    return () => {
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    };
  }, [isRendered]);

  if (!isRendered || !dialog.targetPhase) return null;

  const targetPhaseName =
    dialog.targetPhase === "normal"
      ? "通常"
      : dialog.targetPhase === "postponed"
        ? "後回し"
        : "遅参";
  const targetVisits = visitsByPhase[dialog.targetPhase];
  const targetVisit = targetVisits[dialog.savedIndex];
  const savedVisitInfo = targetVisit
    ? `${targetVisit.items[0]?.block}-${targetVisit.items[0]?.number} ${targetVisit.items[0]?.circle}`
    : "";

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    const dialogElement = dialogRef.current;
    if (!dialogElement) return;
    const focusableElements = Array.from(
      dialogElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (!first || !last) return;

    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialogElement.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !dialogElement.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={handleKeyDown}
        className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-md w-full mx-4 overflow-hidden"
      >
        <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white p-4">
          <h2 id={titleId} className="text-lg font-bold">
            フェーズを切り替えますか？
          </h2>
          <p id={descriptionId} className="text-sm mt-1">
            {targetPhaseName}フェーズに移動します
          </p>
        </div>
        <div className="p-4 space-y-4">
          {targetVisits.length === 0 ? (
            <p className="text-slate-600 dark:text-slate-300 text-center py-4">
              {targetPhaseName}フェーズに該当するアイテムがありません
            </p>
          ) : (
            <>
              <p className="text-slate-600 dark:text-slate-300">
                {targetPhaseName}フェーズには {targetVisits.length}{" "}
                件の訪問先があります。
              </p>
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={onStart}
                  className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                >
                  最初から開始
                  <span className="block text-xs mt-0.5">
                    {targetVisits[0]?.items[0]?.block}-
                    {targetVisits[0]?.items[0]?.number}{" "}
                    {targetVisits[0]?.items[0]?.circle}
                  </span>
                </button>
                {dialog.hasSavedIndex && (
                  <button
                    type="button"
                    onClick={onSaved}
                    className="w-full py-3 px-4 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium transition-colors"
                  >
                    途中から再開
                    <span className="block text-xs mt-0.5">
                      {savedVisitInfo} （{dialog.savedIndex + 1}/
                      {targetVisits.length}）
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="w-full py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

export function CellItemPopup({
  state,
  canAddItem,
  temporaryTargets = [],
  onAddItem,
  onTemporaryMove,
  onClose,
}: {
  state: CellPopupState;
  canAddItem: boolean;
  temporaryTargets?: CellTemporaryTarget[];
  onAddItem: () => void;
  onTemporaryMove?: (
    target: CellTemporaryTarget,
  ) => void | boolean | Promise<void | boolean>;
  onClose: () => void;
}) {
  useModalInteractionLock(state.isOpen);
  const operationLockRef = useRef(false);
  const suppressOpeningClickRef = useRef(false);
  const openingClickGuardTimerRef = useRef<number | null>(null);
  const [busyVisitId, setBusyVisitId] = useState<string | null>(null);

  // A touch pointerup can mount this popup before its compatibility click is
  // hit-tested. Arm the guard before that click can reach a newly added button.
  useLayoutEffect(() => {
    if (openingClickGuardTimerRef.current !== null) {
      window.clearTimeout(openingClickGuardTimerRef.current);
      openingClickGuardTimerRef.current = null;
    }
    suppressOpeningClickRef.current = state.isOpen;
    if (!state.isOpen) return;

    openingClickGuardTimerRef.current = window.setTimeout(() => {
      suppressOpeningClickRef.current = false;
      openingClickGuardTimerRef.current = null;
    }, CELL_POPUP_OPENING_CLICK_GUARD_MS);

    return () => {
      if (openingClickGuardTimerRef.current !== null) {
        window.clearTimeout(openingClickGuardTimerRef.current);
        openingClickGuardTimerRef.current = null;
      }
      suppressOpeningClickRef.current = false;
    };
  }, [state.blockName, state.isOpen, state.number]);

  if (!state.isOpen) return null;

  const clearOpeningClickGuard = () => {
    suppressOpeningClickRef.current = false;
    if (openingClickGuardTimerRef.current !== null) {
      window.clearTimeout(openingClickGuardTimerRef.current);
      openingClickGuardTimerRef.current = null;
    }
  };

  const handlePopupInteractionStart = (event: React.SyntheticEvent) => {
    // A new gesture that starts inside the popup is an intentional interaction.
    clearOpeningClickGuard();
    event.stopPropagation();
  };

  const handlePopupClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const shouldSuppress = suppressOpeningClickRef.current && event.detail > 0;
    clearOpeningClickGuard();
    if (!shouldSuppress) return;

    event.preventDefault();
    event.stopPropagation();
  };

  const handleBackdropClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleTemporaryMove = async (target: CellTemporaryTarget) => {
    if (target.disabled || operationLockRef.current || !onTemporaryMove) return;
    operationLockRef.current = true;
    setBusyVisitId(target.visitId);
    try {
      const shouldClose = await onTemporaryMove(target);
      if (shouldClose !== false) onClose();
    } finally {
      operationLockRef.current = false;
      setBusyVisitId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${state.blockName}-${state.number}のアイテム`}
      onClick={handleBackdropClick}
      onClickCapture={handlePopupClickCapture}
      onPointerDown={handlePopupInteractionStart}
      onTouchStart={handlePopupInteractionStart}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-sm w-full mx-4 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <h3 className="font-semibold text-slate-900 dark:text-white">
            {state.blockName}-{state.number}{" "}
            {state.items.length > 0 ? `（${state.items.length}件）` : ""}
          </h3>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {temporaryTargets.map((target) => (
              <button
                key={target.visitId}
                type="button"
                disabled={
                  target.disabled || busyVisitId !== null || !onTemporaryMove
                }
                onClick={(event) => {
                  event.stopPropagation();
                  void handleTemporaryMove(target);
                }}
                className="w-auto whitespace-nowrap rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400 disabled:opacity-70"
              >
                {busyVisitId === target.visitId
                  ? "移動中…"
                  : `${target.displayLabel}に一時移動`}
              </button>
            ))}
          </div>
          <button
            onClick={onClose}
            className="ml-auto text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label="閉じる"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
        {canAddItem && (
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700">
            <button
              onClick={onAddItem}
              className="w-full py-2 px-4 bg-green-700 hover:bg-green-800 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              新規アイテム追加
            </button>
          </div>
        )}
        <div className="max-h-60 overflow-y-auto">
          {state.items.length === 0 ? (
            <div className="px-4 py-6 text-center text-slate-500 dark:text-slate-400">
              このセルには今回の巡回対象アイテムがありません
            </div>
          ) : (
            state.items.map((item) => (
              <div
                key={item.id}
                className="p-3 border-b border-slate-100 dark:border-slate-700 last:border-b-0"
              >
                <div className="font-medium text-slate-900 dark:text-white">
                  {item.circle}
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-400">
                  {item.title}
                </div>
                {item.price !== null && (
                  <div className="text-sm text-slate-500">
                    ¥{item.price.toLocaleString()}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700">
          <button
            onClick={onClose}
            className="w-full py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function TemporaryPhaseChoiceDialog({
  isOpen,
  title,
  description,
  choices,
  onSelect,
  onCancel,
}: {
  isOpen: boolean;
  title: string;
  description?: string;
  choices: TemporaryPhaseChoice[];
  onSelect: (phase: FocusPhase) => void;
  onCancel: () => void;
}) {
  useModalInteractionLock(isOpen);
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-800">
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-4 text-white">
          <h2 className="text-lg font-bold">{title}</h2>
          {description && <p className="mt-1 text-sm">{description}</p>}
        </div>
        <div className="space-y-2 p-4">
          {choices.map((choice) => (
            <button
              key={choice.phase}
              type="button"
              disabled={choice.disabled}
              onClick={() => onSelect(choice.phase)}
              className="w-full rounded-lg border border-slate-200 px-4 py-3 text-left transition-colors hover:border-blue-400 hover:bg-blue-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:opacity-55 dark:border-slate-600 dark:hover:border-blue-500 dark:hover:bg-slate-700 dark:disabled:bg-slate-900"
            >
              <span className="block font-semibold text-slate-900 dark:text-white">
                {choice.label}
              </span>
              <span className="mt-0.5 block text-sm text-slate-600 dark:text-slate-300">
                {choice.detail}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={onCancel}
            className="mt-2 w-full rounded-lg bg-slate-200 px-4 py-2 font-medium text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function TemporaryRemainingSpacesDialog({
  isOpen,
  sections,
  onSelect,
  onEnd,
  onCancel,
}: {
  isOpen: boolean;
  sections: TemporaryRemainingSection[];
  onSelect: (phase: FocusPhase, visitId: string) => void;
  onEnd: () => void;
  onCancel: () => void;
}) {
  useModalInteractionLock(isOpen);
  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="一時巡回の残りスペース"
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-slate-800">
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-4 text-white">
          <h2 className="text-lg font-bold">残りスペース</h2>
          <p className="mt-1 text-sm">購入状態を再集計した最新の候補です</p>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <button
            type="button"
            onClick={onEnd}
            className="w-full rounded-lg bg-slate-800 px-4 py-3 font-semibold text-white hover:bg-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            ここで一時巡回を終了
          </button>
          {sections.map((section) => (
            <section key={section.phase} aria-label={section.label}>
              <h3 className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                {section.label}
              </h3>
              {section.entries.length === 0 ? (
                <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                  該当するスペースはありません
                </p>
              ) : (
                <div className="space-y-2">
                  {section.entries.map((entry) => {
                    const circleText =
                      entry.circles.length > 2
                        ? `${entry.circles.slice(0, 2).join("・")} ほか${entry.circles.length - 2}件`
                        : entry.circles.join("・");
                    return (
                      <button
                        key={`${section.phase}:${entry.spaceKey}`}
                        type="button"
                        disabled={entry.disabled}
                        onClick={() => onSelect(section.phase, entry.visitId)}
                        className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left hover:border-blue-400 hover:bg-blue-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:opacity-60 dark:border-slate-600 dark:hover:border-blue-500 dark:hover:bg-slate-700 dark:disabled:bg-slate-900"
                      >
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {entry.label}（{entry.itemCount}件）
                          {entry.disabled ? "・表示中" : ""}
                        </span>
                        {circleText && (
                          <span className="mt-0.5 block text-xs text-slate-600 dark:text-slate-300">
                            {circleText}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded-lg bg-slate-200 px-4 py-2 font-medium text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
          >
            表示中のスペースへ戻る
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function AddItemDialogView({
  dialog,
  form,
  setDialog,
  setForm,
  currentVisit,
  priceOptions,
  onPriceInputChange,
  onPriceSelectChange,
  onClose,
  onSubmit,
}: {
  dialog: AddItemDialogState;
  form: AddItemFormState;
  setDialog: React.Dispatch<React.SetStateAction<AddItemDialogState>>;
  setForm: React.Dispatch<React.SetStateAction<AddItemFormState>>;
  currentVisit: VisitGroup | undefined;
  priceOptions: number[];
  onPriceInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onPriceSelectChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const idPrefix = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useModalInteractionLock(dialog.isOpen);

  useLayoutEffect(() => {
    if (!dialog.isOpen) return;

    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current
      ?.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )
      ?.focus({ preventScroll: true });

    return () => {
      const returnFocus = returnFocusRef.current;
      returnFocusRef.current = null;
      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    };
  }, [dialog.isOpen]);

  if (!dialog.isOpen) return null;

  const ids = {
    dialogTitle: `${idPrefix}-title`,
    dialogDescription: `${idPrefix}-description`,
    circle: `${idPrefix}-circle`,
    circleSuggestions: `${idPrefix}-circle-suggestions`,
    title: `${idPrefix}-item-title`,
    eventDate: `${idPrefix}-event-date`,
    block: `${idPrefix}-block`,
    number: `${idPrefix}-number`,
    price: `${idPrefix}-price`,
    priceQuickSelect: `${idPrefix}-price-quick-select`,
    quantity: `${idPrefix}-quantity`,
    purchaseStatus: `${idPrefix}-purchase-status`,
    remarks: `${idPrefix}-remarks`,
    url: `${idPrefix}-url`,
  };

  const circles = currentVisit
    ? [
        ...new Set(
          currentVisit.items.map((item) => item.circle).filter(Boolean),
        ),
      ]
    : [];

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialogElement = dialogRef.current;
    if (!dialogElement) return;
    const focusableElements = Array.from(
      dialogElement.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (!first || !last) return;

    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialogElement.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !dialogElement.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.dialogTitle}
        aria-describedby={ids.dialogDescription}
        onKeyDown={handleKeyDown}
        className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto"
      >
        <div className="bg-gradient-to-r from-green-700 to-emerald-700 text-white p-4">
          <h2 id={ids.dialogTitle} className="text-lg font-bold">
            新規アイテム追加
          </h2>
          <p id={ids.dialogDescription} className="text-sm mt-1">
            {dialog.eventDate} {dialog.block}-{dialog.number}
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              id={ids.circle}
              label="サークル名"
              value={form.circle}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, circle: value }))
              }
              required
              list={ids.circleSuggestions}
              placeholder="サークル名"
            >
              {circles.length > 0 && (
                <datalist id={ids.circleSuggestions}>
                  {circles.map((circle) => (
                    <option key={circle} value={circle} />
                  ))}
                </datalist>
              )}
            </TextField>
            <TextField
              id={ids.title}
              label="タイトル"
              value={form.title}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, title: value }))
              }
              placeholder="新刊セット"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <TextField
              id={ids.eventDate}
              label="参加日"
              value={dialog.eventDate}
              readOnly
            />
            <TextField
              id={ids.block}
              label="ブロック"
              value={dialog.block}
              readOnly
            />
            <TextField
              id={ids.number}
              label="ナンバー"
              value={dialog.number}
              onChange={(value) =>
                setDialog((prev) => ({ ...prev, number: value }))
              }
              placeholder="01a"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div className="relative">
              <label htmlFor={ids.price} className={labelClass}>
                購入金額
              </label>
              <input
                id={ids.price}
                type="text"
                value={form.price}
                onChange={onPriceInputChange}
                className={`${formInputClass} pr-12`}
                placeholder="0"
                inputMode="numeric"
              />
              <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">
                円
              </span>
            </div>
            <div>
              <label htmlFor={ids.priceQuickSelect} className={labelClass}>
                クイック選択
              </label>
              <select
                id={ids.priceQuickSelect}
                onChange={onPriceSelectChange}
                className={formInputClass}
                value={
                  priceOptions.includes(Number(form.price)) ? form.price : ""
                }
              >
                <option value="" disabled>
                  金額を選択...
                </option>
                {priceOptions.map((price) => (
                  <option key={price} value={price}>
                    {price.toLocaleString()}円
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SelectField
              id={ids.quantity}
              label="数量"
              value={form.quantity}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, quantity: value }))
              }
              options={buildQuantityOptions(form.quantity).map(String)}
            />
            <SelectField
              id={ids.purchaseStatus}
              label="購入状態"
              value={form.purchaseStatus}
              onChange={(value) =>
                setForm((prev) => ({
                  ...prev,
                  purchaseStatus: value as AddItemFormState["purchaseStatus"],
                }))
              }
              options={["Purchased", "Postpone", "Late"]}
              labels={{ Purchased: "購入済", Postpone: "後回し", Late: "遅参" }}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              id={ids.remarks}
              label="利用者メモ"
              value={form.remarks}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, remarks: value }))
              }
              placeholder="スケブお願い"
            />
            <TextField
              id={ids.url}
              label="URL"
              value={form.url}
              onChange={(value) => setForm((prev) => ({ ...prev, url: value }))}
              placeholder="https://example.com"
            />
          </div>
        </div>
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!form.circle.trim()}
            className="flex-1 py-2 px-4 bg-green-700 hover:bg-green-800 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
          >
            リストに追加
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  required = false,
  readOnly = false,
  list,
  placeholder,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange?: (value: string) => void;
  required?: boolean;
  readOnly?: boolean;
  list?: string;
  placeholder?: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
        {required && (
          <>
            {" "}
            <span aria-hidden="true" className="text-red-500">
              *
            </span>
          </>
        )}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className={
          readOnly
            ? `${formInputClass} bg-slate-100 dark:bg-slate-700`
            : formInputClass
        }
        required={required}
        readOnly={readOnly}
        list={list}
        placeholder={placeholder}
      />
      {children}
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  labels = {},
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={formInputClass}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {labels[option] ?? option}
          </option>
        ))}
      </select>
    </div>
  );
}
