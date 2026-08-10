import React, { useState, useCallback, useId, useMemo } from "react";
import type { ShoppingItem, PurchaseStatus } from "../types/item";
import type { HallDefinition } from "../types/map";
import { findHallsByBlockName } from "../utils/hallFallback";
import LimitedPurchaseExcessConfirmDialog from "./LimitedPurchaseExcessConfirmDialog";
import {
  buildQuantityOptions,
  isStandardQuantityOption,
} from "./quantityOptions";
import {
  applyLimitedPurchase,
  applyPurchasedFromLimitedInput,
  clearLimitedPurchase,
  getActualPurchasedQuantity,
  getPlannedQuantity,
  parseDecimalIntegerInput,
  validateLimitedPurchasePlannedQuantity,
  validateLimitedPurchaseQuantities,
  type LimitedPurchaseValidationError,
} from "../utils/purchaseQuantity";
import { useModalDialogBehavior } from "../hooks/useModalDialogBehavior";

interface ItemEditDialogProps {
  item: ShoppingItem;
  onSave: (updatedItem: ShoppingItem) => void;
  onClose: () => void;
  allItems?: ShoppingItem[];
  halls?: HallDefinition[];
  onPriorityChange?: (
    itemId: string,
    level: "none" | "priority" | "highest",
  ) => void;
}

const toLimitedPurchaseMessage = (
  error: LimitedPurchaseValidationError,
): string => {
  if (error === "planned_required") return "購入予定量を入力してください";
  if (error === "actual_required") return "実購入数を入力してください";
  if (error === "planned_not_integer")
    return "購入予定量は整数で入力してください";
  if (error === "actual_not_integer") return "実購入数は整数で入力してください";
  if (error === "planned_not_positive")
    return "購入予定量は1以上で入力してください";
  if (error === "actual_not_positive")
    return "実購入数は1以上で入力してください";
  return "限数購入では実購入数を購入予定量より少なくしてください";
};

export const ItemEditDialog: React.FC<ItemEditDialogProps> = ({
  item,
  onSave,
  onClose,
  allItems = [],
  halls = [],
  onPriorityChange,
}) => {
  const fieldIdPrefix = useId();
  const dialogTitleId = `${fieldIdPrefix}-title`;
  const dialogDescriptionId = `${fieldIdPrefix}-description`;
  const fieldIds = {
    circle: `${fieldIdPrefix}-circle`,
    circleSuggestions: `${fieldIdPrefix}-circle-suggestions`,
    title: `${fieldIdPrefix}-item-title`,
    eventDate: `${fieldIdPrefix}-event-date`,
    block: `${fieldIdPrefix}-block`,
    number: `${fieldIdPrefix}-number`,
    price: `${fieldIdPrefix}-price`,
    priceQuickSelect: `${fieldIdPrefix}-price-quick-select`,
    limitedActual: `${fieldIdPrefix}-limited-actual`,
    limitedPlanned: `${fieldIdPrefix}-limited-planned`,
    quantity: `${fieldIdPrefix}-quantity`,
    purchaseStatus: `${fieldIdPrefix}-purchase-status`,
    manualHall: `${fieldIdPrefix}-manual-hall`,
    priority: `${fieldIdPrefix}-priority`,
    remarks: `${fieldIdPrefix}-remarks`,
    url: `${fieldIdPrefix}-url`,
  } as const;
  const [form, setForm] = useState({
    circle: item.circle,
    title: item.title,
    eventDate: item.eventDate,
    block: item.block,
    number: item.number,
    price: item.price === null ? "" : String(item.price),
    quantity: String(item.quantity ?? 1),
    purchaseStatus: item.purchaseStatus as string,
    remarks: item.remarks,
    url: item.url || "",
    priorityLevel: (item.priorityLevel || "none") as
      | "none"
      | "priority"
      | "highest",
    manualHallId: item.manualHallId || "",
  });
  const [limitedActualText, setLimitedActualText] = useState(
    item.purchaseStatus === "LimitedPurchase"
      ? String(getActualPurchasedQuantity(item) ?? "")
      : "",
  );
  const [limitedPlannedText, setLimitedPlannedText] = useState(
    String(getPlannedQuantity(item)),
  );
  const [limitedError, setLimitedError] = useState<string | null>(null);
  const [excessConfirm, setExcessConfirm] = useState<{
    item: ShoppingItem;
    planned: number;
  } | null>(null);
  const { dialogRef, onDialogKeyDown } = useModalDialogBehavior({
    isOpen: true,
    onEscape: onClose,
  });

  // 現在のブロックが属するホール候補（blockNamesに含まれているホール）
  const blockHallCandidates = useMemo(
    () => findHallsByBlockName(form.block, halls),
    [form.block, halls],
  );
  // 複数ホール所属ブロックの場合にホール選択UIを表示
  const showHallSelector = blockHallCandidates.length > 1;

  const formInputClass =
    "w-full p-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-900 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-slate-900 dark:text-white";
  const labelClass =
    "block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1";

  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);
  const quantityOptions = useMemo(
    () => buildQuantityOptions(form.quantity),
    [form.quantity],
  );

  const handlePriceInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value.replace(/[^0-9]/g, "");
      setForm((prev) => ({ ...prev, price: value }));
    },
    [],
  );

  const handlePriceSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, price: e.target.value }));
    },
    [],
  );

  const handleSave = useCallback(() => {
    if (!form.circle.trim()) return;
    const price = form.price === "" ? null : parseInt(form.price, 10) || 0;
    const baseItem: ShoppingItem = {
      ...item,
      circle: form.circle,
      title: form.title,
      eventDate: form.eventDate,
      block: form.block,
      number: form.number,
      price,
      purchaseStatus: form.purchaseStatus as PurchaseStatus,
      remarks: form.remarks,
      url: form.url || undefined,
      priorityLevel: form.priorityLevel,
      manualHallId: form.manualHallId || undefined,
    };

    if (form.purchaseStatus === "LimitedPurchase") {
      const planned = parseDecimalIntegerInput(limitedPlannedText);
      if (limitedActualText.trim() === "") {
        const plannedValidation =
          validateLimitedPurchasePlannedQuantity(planned);
        if (!plannedValidation.ok) {
          setLimitedError(toLimitedPurchaseMessage(plannedValidation.error));
          return;
        }
        onSave(applyLimitedPurchase(baseItem, { planned: planned! }));
        return;
      }

      const actual = parseDecimalIntegerInput(limitedActualText);
      const validation = validateLimitedPurchaseQuantities(actual, planned);
      if (validation.ok) {
        onSave(
          applyLimitedPurchase(baseItem, {
            actual: actual!,
            planned: planned!,
          }),
        );
        return;
      }

      if (
        validation.error === "actual_not_less_than_planned" &&
        actual !== undefined &&
        planned !== undefined
      ) {
        if (actual === planned) {
          if (
            window.confirm(
              "全て購入できているので「購入済」にします。よろしいですか？",
            )
          ) {
            onSave(applyPurchasedFromLimitedInput(baseItem, planned));
          }
          return;
        }
        if (actual > planned) {
          setExcessConfirm({ item: baseItem, planned });
          return;
        }
      }

      setLimitedError(toLimitedPurchaseMessage(validation.error));
      return;
    }

    const updatedItem: ShoppingItem = clearLimitedPurchase({
      ...baseItem,
      quantity: parseInt(form.quantity, 10) || 1,
      purchaseStatus: form.purchaseStatus as PurchaseStatus,
    });
    onSave(updatedItem);
    // priority 変更の反映は onSave 経由（handleUpdateItem + hallOrder 更新を App 側で統合）に一本化。
    // 旧 onPriorityChange による二重 setEventLists は race condition の原因だったため廃止。
  }, [form, item, limitedActualText, limitedPlannedText, onSave]);

  const circleSuggestions = useMemo(
    () => [...new Set(allItems.map((i) => i.circle).filter(Boolean))],
    [allItems],
  );

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogDescriptionId}
        className="bg-white dark:bg-slate-800 rounded-lg shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white p-4">
          <h2 id={dialogTitleId} className="text-lg font-bold">
            アイテム編集
          </h2>
          <p id={dialogDescriptionId} className="mt-1 text-sm">
            {form.eventDate} {form.block}-{form.number}
          </p>
        </div>
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor={fieldIds.circle} className={labelClass}>
                サークル名{" "}
                <span aria-hidden="true" className="text-red-500">
                  *
                </span>
              </label>
              <input
                id={fieldIds.circle}
                type="text"
                required
                value={form.circle}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, circle: e.target.value }))
                }
                className={formInputClass}
                placeholder="サークル名"
                list={fieldIds.circleSuggestions}
              />
              {circleSuggestions.length > 0 && (
                <datalist id={fieldIds.circleSuggestions}>
                  {circleSuggestions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              )}
            </div>
            <div>
              <label htmlFor={fieldIds.title} className={labelClass}>
                タイトル
              </label>
              <input
                id={fieldIds.title}
                type="text"
                value={form.title}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, title: e.target.value }))
                }
                className={formInputClass}
                placeholder="新刊セット"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label htmlFor={fieldIds.eventDate} className={labelClass}>
                参加日
              </label>
              <input
                id={fieldIds.eventDate}
                type="text"
                value={form.eventDate}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, eventDate: e.target.value }))
                }
                className={formInputClass}
              />
            </div>
            <div>
              <label htmlFor={fieldIds.block} className={labelClass}>
                ブロック
              </label>
              <input
                id={fieldIds.block}
                type="text"
                value={form.block}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, block: e.target.value }))
                }
                className={formInputClass}
              />
            </div>
            <div>
              <label htmlFor={fieldIds.number} className={labelClass}>
                ナンバー
              </label>
              <input
                id={fieldIds.number}
                type="text"
                value={form.number}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, number: e.target.value }))
                }
                className={formInputClass}
                placeholder="01a"
              />
            </div>
          </div>
          {item.catalogPrice !== undefined && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/50">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                カタログ価格（シート・読み取り専用）
              </p>
              <output
                aria-label="カタログ価格（シート・読み取り専用）"
                className="mt-1 block font-semibold text-slate-800 dark:text-slate-100"
              >
                {item.catalogPrice === null
                  ? "未定"
                  : `${item.catalogPrice.toLocaleString()}円`}
              </output>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
            <div className="relative">
              <label htmlFor={fieldIds.price} className={labelClass}>
                購入金額（利用者が編集）
              </label>
              <input
                id={fieldIds.price}
                type="text"
                value={form.price}
                onChange={handlePriceInputChange}
                aria-label="購入金額"
                className={`${formInputClass} pr-12`}
                placeholder="0"
                inputMode="numeric"
              />
              <span className="absolute right-3 top-9 text-slate-500 dark:text-slate-400">
                円
              </span>
            </div>
            <div>
              <label htmlFor={fieldIds.priceQuickSelect} className={labelClass}>
                クイック選択
              </label>
              <select
                id={fieldIds.priceQuickSelect}
                onChange={handlePriceSelectChange}
                className={formInputClass}
                value={
                  priceOptions.includes(Number(form.price)) ? form.price : ""
                }
              >
                <option value="" disabled>
                  金額を選択...
                </option>
                {priceOptions.map((p) => (
                  <option key={p} value={p}>
                    {p.toLocaleString()}円
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {form.purchaseStatus === "LimitedPurchase" ? (
              <>
                <div>
                  <label
                    htmlFor={fieldIds.limitedActual}
                    className={labelClass}
                  >
                    実購入数
                  </label>
                  <input
                    id={fieldIds.limitedActual}
                    value={limitedActualText}
                    onChange={(e) => {
                      setLimitedActualText(e.target.value);
                      setLimitedError(null);
                    }}
                    className={formInputClass}
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <label
                    htmlFor={fieldIds.limitedPlanned}
                    className={labelClass}
                  >
                    購入予定量
                  </label>
                  <input
                    id={fieldIds.limitedPlanned}
                    value={limitedPlannedText}
                    onChange={(e) => {
                      setLimitedPlannedText(e.target.value);
                      setLimitedError(null);
                    }}
                    className={formInputClass}
                    inputMode="numeric"
                  />
                </div>
              </>
            ) : (
              <div>
                <label htmlFor={fieldIds.quantity} className={labelClass}>
                  数量
                </label>
                <select
                  id={fieldIds.quantity}
                  value={form.quantity}
                  aria-label="数量"
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, quantity: e.target.value }))
                  }
                  className={formInputClass}
                >
                  {quantityOptions.map((num) => (
                    <option key={num} value={num}>
                      {isStandardQuantityOption(num) ? num : `${num}（現在値）`}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor={fieldIds.purchaseStatus} className={labelClass}>
                購入状態
              </label>
              <select
                id={fieldIds.purchaseStatus}
                value={form.purchaseStatus}
                onChange={(e) => {
                  const nextStatus = e.target.value;
                  setForm((prev) => ({
                    ...prev,
                    purchaseStatus: nextStatus,
                  }));
                  if (nextStatus === "LimitedPurchase") {
                    setLimitedPlannedText(String(getPlannedQuantity(item)));
                    setLimitedActualText(
                      String(getActualPurchasedQuantity(item) ?? ""),
                    );
                    setLimitedError(null);
                  }
                }}
                className={formInputClass}
              >
                <option value="None">未購入</option>
                <option value="Purchased">購入済</option>
                <option value="SoldOut">売切</option>
                <option value="Absent">欠席</option>
                <option value="Postpone">後回し</option>
                <option value="Late">遅参</option>
                <option value="LimitedPurchase">限数</option>
              </select>
            </div>
          </div>
          {limitedError && (
            <p className="text-sm text-red-600 dark:text-red-300">
              {limitedError}
            </p>
          )}
          {showHallSelector && (
            <div className="border border-amber-200 dark:border-amber-700/50 bg-amber-50/50 dark:bg-amber-900/20 rounded-lg p-3">
              <label htmlFor={fieldIds.manualHall} className={labelClass}>
                ホール設定
                <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-400">
                  （ブロック「{form.block}」は複数ホールに所属）
                </span>
              </label>
              <select
                id={fieldIds.manualHall}
                value={form.manualHallId}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, manualHallId: e.target.value }))
                }
                className={formInputClass}
              >
                <option value="">
                  自動判定（いずれか1つに決定できない場合は未割当）
                </option>
                {blockHallCandidates.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                このブロックが属するホールを選択してください
              </p>
            </div>
          )}
          {onPriorityChange && (
            <div>
              <label htmlFor={fieldIds.priority} className={labelClass}>
                優先度
              </label>
              <select
                id={fieldIds.priority}
                value={form.priorityLevel}
                onChange={(e) =>
                  setForm((prev) => ({
                    ...prev,
                    priorityLevel: e.target.value as
                      | "none"
                      | "priority"
                      | "highest",
                  }))
                }
                className={formInputClass}
              >
                <option value="none">なし（通常）</option>
                <option value="priority">優先</option>
                <option value="highest">最優先</option>
              </select>
              {form.priorityLevel !== "none" && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${form.priorityLevel === "highest" ? "bg-red-500" : "bg-orange-500"}`}
                  />
                  <span
                    className={`text-xs ${form.priorityLevel === "highest" ? "text-red-600 dark:text-red-400" : "text-orange-600 dark:text-orange-400"}`}
                  >
                    {form.priorityLevel === "highest"
                      ? "最優先アイテムとして設定されます"
                      : "優先アイテムとして設定されます"}
                  </span>
                </div>
              )}
            </div>
          )}
          {item.sheetRemarks?.trim() && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900/50">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                シート備考（読み取り専用）
              </p>
              <p
                aria-label="シート備考（読み取り専用）"
                className="mt-1 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100"
              >
                {item.sheetRemarks}
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor={fieldIds.remarks} className={labelClass}>
                利用者メモ
              </label>
              <input
                id={fieldIds.remarks}
                type="text"
                value={form.remarks}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, remarks: e.target.value }))
                }
                aria-label="利用者メモ"
                className={formInputClass}
                placeholder="スケブお願い"
              />
            </div>
            <div>
              <label htmlFor={fieldIds.url} className={labelClass}>
                URL
              </label>
              <input
                id={fieldIds.url}
                type="text"
                value={form.url}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, url: e.target.value }))
                }
                className={formInputClass}
                placeholder="https://example.com"
              />
            </div>
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
            onClick={handleSave}
            disabled={!form.circle.trim()}
            className="flex-1 py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-400 text-white rounded-lg font-medium transition-colors"
          >
            保存
          </button>
        </div>
        <LimitedPurchaseExcessConfirmDialog
          isOpen={excessConfirm !== null}
          onFix={() => setExcessConfirm(null)}
          onConvertToPurchased={() => {
            if (!excessConfirm) return;
            onSave(
              applyPurchasedFromLimitedInput(
                excessConfirm.item,
                excessConfirm.planned,
              ),
            );
            setExcessConfirm(null);
          }}
        />
      </div>
    </div>
  );
};
