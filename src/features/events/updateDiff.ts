import type { PurchaseStatus, ShoppingItem } from "../../types/item";
import { getItemKey, getItemKeyWithoutTitle } from "../../utils/itemComparison";
import {
  decideSheetQuantity,
  type QuantitySyncDecision,
  type SheetQuantityInput,
} from "./quantitySync";

export type SheetItem = Pick<
  ShoppingItem,
  | "circle"
  | "eventDate"
  | "block"
  | "number"
  | "title"
  | "price"
  | "quantity"
  | "remarks"
> &
  Partial<Pick<ShoppingItem, "catalogPrice" | "sheetRemarks" | "url">> & {
    /**
     * CSV に記載された数量。空欄・不正値を差分作成時まで失わないために保持する。
     * 既存の呼び出し元は quantity だけを渡してもよい。
     */
    rawQuantity?: string;
  };

export type SpreadsheetItemToAdd = Omit<ShoppingItem, "id" | "purchaseStatus">;

export type QuantitySyncWarning = {
  kind: "existing-quantity-not-updated" | "new-item-skipped";
  reason: Extract<QuantitySyncDecision, { kind: "invalid" }>["reason"];
  receivedValue: string;
  circle: string;
  eventDate: string;
  block: string;
  number: string;
  title: string;
};

export type PendingPurchasedQuantityChange = {
  itemId: string;
  circle: string;
  eventDate: string;
  block: string;
  number: string;
  title: string;
  purchaseStatus: Extract<PurchaseStatus, "Purchased" | "LimitedPurchase">;
  currentQuantity: number;
  nextQuantity: number;
};

export type LimitedPurchaseQuantityConflict = {
  itemId: string;
  circle: string;
  eventDate: string;
  block: string;
  number: string;
  title: string;
  currentQuantity: number;
  nextQuantity: number;
  actualPurchasedQuantity: number;
};

export type EventUpdateDiff = {
  itemsToDelete: ShoppingItem[];
  itemsToUpdate: ShoppingItem[];
  itemsToAdd: SpreadsheetItemToAdd[];
  protectedFromDelete: number;
  protectedFromUpdate: number;
  quantityWarnings: QuantitySyncWarning[];
  pendingPurchasedQuantityChanges: PendingPurchasedQuantityChange[];
  limitedPurchaseQuantityConflicts: LimitedPurchaseQuantityConflict[];
};

function getEffectiveProtectionLevel(
  item: ShoppingItem,
): "full" | "deletable" | "none" {
  if (item.protectionLevel) return item.protectionLevel;
  return item.source === "app" ? "full" : "none";
}

function isPurchasedStatus(
  status: PurchaseStatus,
): status is Extract<PurchaseStatus, "Purchased" | "LimitedPurchase"> {
  return status === "Purchased" || status === "LimitedPurchase";
}

function getSheetQuantityInput(item: SheetItem): SheetQuantityInput {
  return item.rawQuantity === undefined ? item.quantity : item.rawQuantity;
}

function getCatalogPrice(item: SheetItem): number | null {
  return item.catalogPrice === undefined ? item.price : item.catalogPrice;
}

function getSheetRemarks(item: SheetItem): string {
  return item.sheetRemarks === undefined ? item.remarks : item.sheetRemarks;
}

function toQuantityWarning(
  item: SheetItem,
  decision: Extract<QuantitySyncDecision, { kind: "invalid" }>,
  kind: QuantitySyncWarning["kind"],
): QuantitySyncWarning {
  return {
    kind,
    reason: decision.reason,
    receivedValue: decision.displayValue,
    circle: item.circle,
    eventDate: item.eventDate,
    block: item.block,
    number: item.number,
    title: item.title,
  };
}

function toItemToAdd(item: SheetItem, quantity: number): SpreadsheetItemToAdd {
  return {
    circle: item.circle,
    eventDate: item.eventDate,
    block: item.block,
    number: item.number,
    title: item.title,
    // 新規品目では、既存画面との表示互換のため利用者欄にも初期値を入れる。
    price: item.price,
    catalogPrice: getCatalogPrice(item),
    quantity,
    remarks: item.remarks,
    sheetRemarks: getSheetRemarks(item),
    ...(item.url ? { url: item.url } : {}),
  };
}

function sourceManagedFieldsChanged(
  current: ShoppingItem,
  next: ShoppingItem,
): boolean {
  return (
    current.title !== next.title ||
    current.catalogPrice !== next.catalogPrice ||
    current.sheetRemarks !== next.sheetRemarks ||
    current.url !== next.url
  );
}

export function normalizeSheetItemsUrls(sheetItems: SheetItem[]): SheetItem[] {
  const normalized = sheetItems.map((item) => ({ ...item }));
  const eventDateGroups = new Map<string, SheetItem[]>();

  normalized.forEach((item) => {
    if (!eventDateGroups.has(item.eventDate)) {
      eventDateGroups.set(item.eventDate, []);
    }
    eventDateGroups.get(item.eventDate)!.push(item);
  });

  eventDateGroups.forEach((items) => {
    const circleGroups = new Map<string, SheetItem[]>();
    items.forEach((item) => {
      if (!circleGroups.has(item.circle)) {
        circleGroups.set(item.circle, []);
      }
      circleGroups.get(item.circle)!.push(item);
    });

    circleGroups.forEach((circleItems) => {
      if (circleItems.length < 2) return;
      const itemWithUrl = circleItems.find(
        (item) => item.url && item.url.trim() !== "",
      );
      if (!itemWithUrl?.url) return;

      circleItems.forEach((item) => {
        if (!item.url || item.url.trim() === "") {
          item.url = itemWithUrl.url;
        }
      });
    });
  });

  return normalized;
}

export function createEventUpdateDiff(
  currentItems: ShoppingItem[],
  sheetItems: SheetItem[],
): EventUpdateDiff {
  const currentItemsMapWithAll = new Map(
    currentItems.map((item) => [getItemKey(item), item]),
  );
  const sheetItemsMapWithoutTitle = new Map(
    sheetItems.map((item) => [getItemKeyWithoutTitle(item), item]),
  );
  const currentItemsMapWithoutTitle = new Map(
    currentItems.map((item) => [getItemKeyWithoutTitle(item), item]),
  );

  const itemsToDelete: ShoppingItem[] = [];
  const itemsToUpdate: ShoppingItem[] = [];
  const itemsToAdd: SpreadsheetItemToAdd[] = [];
  const quantityWarnings: QuantitySyncWarning[] = [];
  const pendingPurchasedQuantityChanges: PendingPurchasedQuantityChange[] = [];
  const limitedPurchaseQuantityConflicts: LimitedPurchaseQuantityConflict[] =
    [];
  let protectedFromDelete = 0;
  let protectedFromUpdate = 0;

  currentItems.forEach((item) => {
    const keyWithoutTitle = getItemKeyWithoutTitle(item);
    if (!sheetItemsMapWithoutTitle.has(keyWithoutTitle)) {
      const protectionLevel = getEffectiveProtectionLevel(item);
      if (protectionLevel !== "full") {
        itemsToDelete.push(item);
      } else {
        protectedFromDelete++;
      }
    }
  });

  sheetItems.forEach((sheetItem) => {
    const keyWithAll = getItemKey(sheetItem);
    const keyWithoutTitle = getItemKeyWithoutTitle(sheetItem);
    const existing =
      currentItemsMapWithAll.get(keyWithAll) ??
      currentItemsMapWithoutTitle.get(keyWithoutTitle);

    if (!existing) {
      const quantityDecision = decideSheetQuantity(
        getSheetQuantityInput(sheetItem),
        "new",
      );
      if (quantityDecision.kind === "invalid") {
        quantityWarnings.push(
          toQuantityWarning(sheetItem, quantityDecision, "new-item-skipped"),
        );
        return;
      }

      const quantity =
        quantityDecision.kind === "apply" ? quantityDecision.quantity : 1;
      itemsToAdd.push(toItemToAdd(sheetItem, quantity));
      return;
    }

    const quantityDecision = decideSheetQuantity(
      getSheetQuantityInput(sheetItem),
      "existing",
    );
    if (quantityDecision.kind === "invalid") {
      quantityWarnings.push(
        toQuantityWarning(
          sheetItem,
          quantityDecision,
          "existing-quantity-not-updated",
        ),
      );
    }

    const nextItem: ShoppingItem = {
      ...existing,
      title: sheetItem.title,
      catalogPrice: getCatalogPrice(sheetItem),
      sheetRemarks: getSheetRemarks(sheetItem),
      url: sheetItem.url,
    };
    const nextSheetQuantity =
      quantityDecision.kind === "apply" ? quantityDecision.quantity : undefined;
    const hasQuantityChange =
      nextSheetQuantity !== undefined &&
      nextSheetQuantity !== existing.quantity;
    const protectionLevel = getEffectiveProtectionLevel(existing);
    const hasSourceManagedChange = sourceManagedFieldsChanged(
      existing,
      nextItem,
    );

    if (protectionLevel !== "none") {
      if (hasSourceManagedChange || hasQuantityChange) {
        protectedFromUpdate++;
      }
      return;
    }

    if (hasQuantityChange && isPurchasedStatus(existing.purchaseStatus)) {
      const actualPurchasedQuantity = existing.limitedPurchasedQuantity;
      if (
        existing.purchaseStatus === "LimitedPurchase" &&
        typeof actualPurchasedQuantity === "number" &&
        Number.isInteger(actualPurchasedQuantity) &&
        actualPurchasedQuantity >= 1 &&
        nextSheetQuantity <= actualPurchasedQuantity
      ) {
        limitedPurchaseQuantityConflicts.push({
          itemId: existing.id,
          circle: existing.circle,
          eventDate: existing.eventDate,
          block: existing.block,
          number: existing.number,
          title: nextItem.title,
          currentQuantity: existing.quantity,
          nextQuantity: nextSheetQuantity,
          actualPurchasedQuantity,
        });
      } else {
        pendingPurchasedQuantityChanges.push({
          itemId: existing.id,
          circle: existing.circle,
          eventDate: existing.eventDate,
          block: existing.block,
          number: existing.number,
          title: nextItem.title,
          purchaseStatus: existing.purchaseStatus,
          currentQuantity: existing.quantity,
          nextQuantity: nextSheetQuantity,
        });
      }
    } else if (hasQuantityChange) {
      nextItem.quantity = nextSheetQuantity;
    }

    if (hasSourceManagedChange || nextItem.quantity !== existing.quantity) {
      itemsToUpdate.push(nextItem);
    }
  });

  return {
    itemsToDelete,
    itemsToUpdate,
    itemsToAdd,
    protectedFromDelete,
    protectedFromUpdate,
    quantityWarnings,
    pendingPurchasedQuantityChanges,
    limitedPurchaseQuantityConflicts,
  };
}
