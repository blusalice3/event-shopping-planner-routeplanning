import React, { useMemo, useState } from "react";
import type { ShoppingItem } from "../../types/item";
import LimitedPurchaseExcessConfirmDialog from "../LimitedPurchaseExcessConfirmDialog";
import {
  applyLimitedPurchase,
  applyPurchasedFromLimitedInput,
  getPlannedQuantity,
  hasMissingLimitedPurchaseQuantity,
  parseDecimalIntegerInput,
  validateLimitedPurchasePlannedQuantity,
  validateLimitedPurchaseQuantities,
  type LimitedPurchaseValidationError,
} from "../../utils/purchaseQuantity";

type LimitedPurchaseMissingListViewProps = {
  items: ShoppingItem[];
  onUpdateItem: (item: ShoppingItem) => void;
  onBack: () => void;
};

type RowState = {
  actualText: string;
  plannedText: string;
  priceText: string;
  error: string | null;
};

type PriceInputParseResult =
  | { ok: true; price: number | null }
  | { ok: false; message: string };

const toMessage = (error: LimitedPurchaseValidationError): string => {
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

const parsePriceInput = (value: string): PriceInputParseResult => {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, price: null };
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: "価格は半角数字で入力してください" };
  }
  return { ok: true, price: Number(trimmed) };
};

const createRowState = (item: ShoppingItem): RowState => ({
  actualText: "",
  plannedText: String(getPlannedQuantity(item)),
  priceText: item.price === null ? "" : String(item.price),
  error: null,
});

export function LimitedPurchaseMissingListView({
  items,
  onUpdateItem,
  onBack,
}: LimitedPurchaseMissingListViewProps) {
  const missingItems = useMemo(
    () => items.filter(hasMissingLimitedPurchaseQuantity),
    [items],
  );
  const [rows, setRows] = useState<Record<string, RowState>>(() =>
    Object.fromEntries(
      missingItems.map((item) => [item.id, createRowState(item)]),
    ),
  );
  const [excessConfirm, setExcessConfirm] = useState<{
    item: ShoppingItem;
    planned: number;
    price: number | null;
  } | null>(null);

  const getRow = (item: ShoppingItem): RowState =>
    rows[item.id] ?? createRowState(item);

  const updateRow = (itemId: string, patch: Partial<RowState>) => {
    setRows((prev) => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] ??
          createRowState(items.find((item) => item.id === itemId)!)),
        ...patch,
      },
    }));
  };

  const handleSave = (item: ShoppingItem) => {
    const row = getRow(item);
    const parsedPrice = parsePriceInput(row.priceText);
    if (!parsedPrice.ok) {
      updateRow(item.id, { error: parsedPrice.message });
      return;
    }

    const planned = parseDecimalIntegerInput(row.plannedText);

    if (row.actualText.trim() === "") {
      const plannedValidation = validateLimitedPurchasePlannedQuantity(planned);
      if (!plannedValidation.ok) {
        updateRow(item.id, { error: toMessage(plannedValidation.error) });
        return;
      }
      onUpdateItem(
        applyLimitedPurchase(
          { ...item, price: parsedPrice.price },
          { planned: planned! },
        ),
      );
      updateRow(item.id, { error: null });
      return;
    }

    const actual = parseDecimalIntegerInput(row.actualText);
    const validation = validateLimitedPurchaseQuantities(actual, planned);
    if (validation.ok) {
      onUpdateItem(
        applyLimitedPurchase(
          { ...item, price: parsedPrice.price },
          { actual: actual!, planned: planned! },
        ),
      );
      updateRow(item.id, { error: null });
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
          onUpdateItem(
            applyPurchasedFromLimitedInput(
              { ...item, price: parsedPrice.price },
              planned,
            ),
          );
          updateRow(item.id, { error: null });
        }
        return;
      }
      if (actual > planned) {
        setExcessConfirm({ item, planned, price: parsedPrice.price });
        return;
      }
    }

    updateRow(item.id, { error: toMessage(validation.error) });
  };

  return (
    <div className="min-h-[50vh] p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100">
              限数未入力を確認
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              限数未入力が {missingItems.length} 件あります
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="rounded bg-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
          >
            戻る
          </button>
        </div>

        <div className="space-y-3">
          {missingItems.map((item) => {
            const row = getRow(item);
            return (
              <div
                key={item.id}
                className="rounded-lg border border-orange-200 bg-white p-4 shadow-sm dark:border-orange-800 dark:bg-slate-800"
              >
                <div className="mb-3">
                  <div className="font-semibold text-slate-900 dark:text-slate-100">
                    {item.circle}
                  </div>
                  {item.title && (
                    <div className="text-sm text-slate-500 dark:text-slate-400">
                      {item.title}
                    </div>
                  )}
                  <div className="text-xs text-slate-400">
                    {item.eventDate} {item.block}-{item.number}
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    実購入数
                    <input
                      value={row.actualText}
                      onChange={(e) =>
                        updateRow(item.id, {
                          actualText: e.target.value,
                          error: null,
                        })
                      }
                      className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                      inputMode="numeric"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    購入予定量
                    <input
                      value={row.plannedText}
                      onChange={(e) =>
                        updateRow(item.id, {
                          plannedText: e.target.value,
                          error: null,
                        })
                      }
                      className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                      inputMode="numeric"
                    />
                  </label>
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
                    価格
                    <input
                      value={row.priceText}
                      onChange={(e) =>
                        updateRow(item.id, {
                          priceText: e.target.value,
                          error: null,
                        })
                      }
                      className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                      inputMode="numeric"
                    />
                  </label>
                </div>
                {row.error && (
                  <p className="mt-2 text-sm text-red-600">{row.error}</p>
                )}
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => handleSave(item)}
                    className="rounded bg-orange-700 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-800"
                  >
                    保存
                  </button>
                </div>
              </div>
            );
          })}
          {missingItems.length === 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
              限数未入力はありません
            </div>
          )}
        </div>
      </div>
      <LimitedPurchaseExcessConfirmDialog
        isOpen={excessConfirm !== null}
        onFix={() => setExcessConfirm(null)}
        onConvertToPurchased={() => {
          if (!excessConfirm) return;
          onUpdateItem(
            applyPurchasedFromLimitedInput(
              { ...excessConfirm.item, price: excessConfirm.price },
              excessConfirm.planned,
            ),
          );
          setExcessConfirm(null);
        }}
      />
    </div>
  );
}
