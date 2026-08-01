export const MIN_SYNC_QUANTITY = 1;
export const MAX_SYNC_QUANTITY = 20;

export type SheetQuantityInput = string | number | null | undefined;

export type QuantitySyncDecision =
  | {
      kind: "apply";
      quantity: number;
      usedDefault: boolean;
    }
  | {
      kind: "preserve";
    }
  | {
      kind: "invalid";
      reason: "not-an-integer" | "out-of-range";
      displayValue: string;
    };

function displayQuantityInput(value: SheetQuantityInput): string {
  if (value == null) return "";
  return String(value);
}

/**
 * スプレッドシートの数量だけを判定する。
 * 既存品目と新規品目で異なるのは、空欄の扱いだけ。
 */
export function decideSheetQuantity(
  value: SheetQuantityInput,
  context: "existing" | "new",
): QuantitySyncDecision {
  const normalized =
    typeof value === "string" ? value.trim() : displayQuantityInput(value);

  if (normalized === "") {
    return context === "new"
      ? { kind: "apply", quantity: MIN_SYNC_QUANTITY, usedDefault: true }
      : { kind: "preserve" };
  }

  const isStrictIntegerText =
    typeof value !== "string" || /^-?\d+$/.test(normalized);
  const numericValue =
    typeof value === "number" ? value : Number.parseInt(normalized, 10);

  if (
    !isStrictIntegerText ||
    !Number.isFinite(numericValue) ||
    !Number.isInteger(numericValue)
  ) {
    return {
      kind: "invalid",
      reason: "not-an-integer",
      displayValue: displayQuantityInput(value),
    };
  }

  if (numericValue < MIN_SYNC_QUANTITY || numericValue > MAX_SYNC_QUANTITY) {
    return {
      kind: "invalid",
      reason: "out-of-range",
      displayValue: displayQuantityInput(value),
    };
  }

  return {
    kind: "apply",
    quantity: numericValue,
    usedDefault: false,
  };
}
