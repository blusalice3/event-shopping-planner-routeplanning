import type React from "react";
import { createPortal } from "react-dom";
import type { FocusPhase } from "../../types/focus";
import type { ShoppingItem } from "../../types/item";
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
  if (!dialog.isOpen || !dialog.targetPhase) return null;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4">
          <h2 className="text-lg font-bold">フェーズを切り替えますか？</h2>
          <p className="text-sm opacity-80 mt-1">
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
                  onClick={onStart}
                  className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                >
                  最初から開始
                  <span className="block text-xs opacity-80 mt-0.5">
                    {targetVisits[0]?.items[0]?.block}-
                    {targetVisits[0]?.items[0]?.number}{" "}
                    {targetVisits[0]?.items[0]?.circle}
                  </span>
                </button>
                {dialog.hasSavedIndex && (
                  <button
                    onClick={onSaved}
                    className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
                  >
                    途中から再開
                    <span className="block text-xs opacity-80 mt-0.5">
                      {savedVisitInfo} （{dialog.savedIndex + 1}/
                      {targetVisits.length}）
                    </span>
                  </button>
                )}
              </div>
            </>
          )}
          <button
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
  onAddItem,
  onClose,
}: {
  state: CellPopupState;
  canAddItem: boolean;
  onAddItem: () => void;
  onClose: () => void;
}) {
  if (!state.isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-sm w-full mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700">
          <h3 className="font-semibold text-slate-900 dark:text-white">
            {state.blockName}-{state.number}{" "}
            {state.items.length > 0 ? `（${state.items.length}件）` : ""}
          </h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
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
              className="w-full py-2 px-4 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors flex items-center justify-center gap-2"
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
              このセルにはアイテムがありません
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
  if (!dialog.isOpen) return null;

  const circles = currentVisit
    ? [
        ...new Set(
          currentVisit.items.map((item) => item.circle).filter(Boolean),
        ),
      ]
    : [];

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white p-4">
          <h2 className="text-lg font-bold">新規アイテム追加</h2>
          <p className="text-sm opacity-80 mt-1">
            {dialog.eventDate} {dialog.block}-{dialog.number}
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TextField
              label="サークル名"
              value={form.circle}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, circle: value }))
              }
              required
              list="focus-add-circle-suggestions"
              placeholder="サークル名"
            >
              {circles.length > 0 && (
                <datalist id="focus-add-circle-suggestions">
                  {circles.map((circle) => (
                    <option key={circle} value={circle} />
                  ))}
                </datalist>
              )}
            </TextField>
            <TextField
              label="タイトル"
              value={form.title}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, title: value }))
              }
              placeholder="新刊セット"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <TextField label="参加日" value={dialog.eventDate} readOnly />
            <TextField label="ブロック" value={dialog.block} readOnly />
            <TextField
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
              <label className={labelClass}>頒布価格</label>
              <input
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
              <label className={labelClass}>クイック選択</label>
              <select
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
              label="数量"
              value={form.quantity}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, quantity: value }))
              }
              options={Array.from({ length: 10 }, (_, i) => String(i + 1))}
            />
            <SelectField
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
              label="備考"
              value={form.remarks}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, remarks: value }))
              }
              placeholder="スケブお願い"
            />
            <TextField
              label="URL"
              value={form.url}
              onChange={(value) => setForm((prev) => ({ ...prev, url: value }))}
              placeholder="https://example.com"
            />
          </div>
        </div>
        <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-2 px-4 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-lg font-medium transition-colors"
          >
            キャンセル
          </button>
          <button
            onClick={onSubmit}
            disabled={!form.circle.trim()}
            className="flex-1 py-2 px-4 bg-green-600 hover:bg-green-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
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
  label,
  value,
  onChange,
  required = false,
  readOnly = false,
  list,
  placeholder,
  children,
}: {
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
      <label className={labelClass}>
        {label}
        {required && (
          <>
            {" "}
            <span className="text-red-500">*</span>
          </>
        )}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className={
          readOnly
            ? `${formInputClass} bg-slate-100 dark:bg-slate-700`
            : formInputClass
        }
        readOnly={readOnly}
        list={list}
        placeholder={placeholder}
      />
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  labels = {},
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <select
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
