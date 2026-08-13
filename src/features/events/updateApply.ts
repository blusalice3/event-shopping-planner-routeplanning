import type { ExecuteModeItems, ShoppingItem } from "../../types/item";
import { insertItemSorted } from "../../utils/itemComparison";
import type {
  AppFieldSyncCandidate,
  AppFieldSyncMode,
  EventUpdateDiff,
} from "./updateDiff";

export type { AppFieldSyncMode };

type EventUpdatePayload = Pick<
  EventUpdateDiff,
  "itemsToDelete" | "itemsToUpdate" | "itemsToAdd" | "appFieldSyncCandidates"
> &
  Partial<Pick<EventUpdateDiff, "pendingPurchasedQuantityChanges">>;

export type EventUpdateApplyOptions = {
  applyPurchasedQuantityChanges?: boolean;
  priceSyncMode?: AppFieldSyncMode;
  remarksSyncMode?: AppFieldSyncMode;
};

function getEffectiveProtectionLevel(
  item: ShoppingItem,
): "full" | "deletable" | "none" {
  if (item.protectionLevel) return item.protectionLevel;
  return item.source === "app" ? "full" : "none";
}

function getPreviousCatalogPrice(item: ShoppingItem): number | null {
  return item.catalogPrice === undefined ? item.price : item.catalogPrice;
}

function getPreviousSheetRemarks(item: ShoppingItem): string {
  return item.sheetRemarks === undefined ? item.remarks : item.sheetRemarks;
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

function isCandidateStillEligible(
  item: ShoppingItem,
  candidate: AppFieldSyncCandidate,
): boolean {
  return (
    item.source === "spreadsheet" &&
    getEffectiveProtectionLevel(item) === "none" &&
    item.purchaseStatus === candidate.purchaseStatus
  );
}

function shouldApplyPriceCandidate(
  item: ShoppingItem,
  candidate: NonNullable<AppFieldSyncCandidate["price"]>,
  mode: AppFieldSyncMode,
): boolean {
  if (
    mode === "preserve" ||
    item.price !== candidate.currentValue ||
    getPreviousCatalogPrice(item) !== candidate.previousSheetValue
  ) {
    return false;
  }

  if (mode === "overwrite") return true;

  return (
    candidate.canFillEmpty &&
    item.price === null &&
    candidate.previousSheetValue === null &&
    candidate.sheetValue !== null
  );
}

function shouldApplyRemarksCandidate(
  item: ShoppingItem,
  candidate: NonNullable<AppFieldSyncCandidate["remarks"]>,
  mode: AppFieldSyncMode,
): boolean {
  if (
    mode === "preserve" ||
    item.remarks !== candidate.currentValue ||
    getPreviousSheetRemarks(item) !== candidate.previousSheetValue
  ) {
    return false;
  }

  if (mode === "overwrite") return true;

  return (
    candidate.canFillEmpty &&
    isBlank(item.remarks) &&
    isBlank(candidate.previousSheetValue) &&
    !isBlank(candidate.sheetValue)
  );
}

function createSpreadsheetItem(
  itemData: EventUpdatePayload["itemsToAdd"][number],
): ShoppingItem {
  return {
    id: crypto.randomUUID(),
    circle: itemData.circle,
    eventDate: itemData.eventDate,
    block: itemData.block,
    number: itemData.number,
    title: itemData.title,
    price: itemData.price,
    catalogPrice: itemData.catalogPrice,
    quantity: itemData.quantity ?? 1,
    remarks: itemData.remarks,
    sheetRemarks: itemData.sheetRemarks,
    purchaseStatus: "None",
    source: "spreadsheet",
    protectionLevel: "none",
    ...(itemData.url ? { url: itemData.url } : {}),
  };
}

export function applyEventUpdateToItems(
  currentItems: ShoppingItem[],
  updateData: EventUpdatePayload,
  options: EventUpdateApplyOptions = {},
): ShoppingItem[] {
  const deleteIds = new Set(updateData.itemsToDelete.map((item) => item.id));
  const updateMap = new Map(
    updateData.itemsToUpdate.map((item) => [item.id, item]),
  );
  const appFieldSyncCandidateMap = new Map(
    updateData.appFieldSyncCandidates.map((candidate) => [
      candidate.itemId,
      candidate,
    ]),
  );
  const priceSyncMode = options.priceSyncMode ?? "preserve";
  const remarksSyncMode = options.remarksSyncMode ?? "preserve";
  const pendingQuantityMap = options.applyPurchasedQuantityChanges
    ? new Map(
        (updateData.pendingPurchasedQuantityChanges ?? []).map((change) => [
          change.itemId,
          change,
        ]),
      )
    : new Map();

  let updatedItems = currentItems.filter((item) => !deleteIds.has(item.id));
  updatedItems = updatedItems.map((item) => {
    const sourceUpdate = updateMap.get(item.id);
    const appFieldSyncCandidate = appFieldSyncCandidateMap.get(item.id);
    const pendingQuantity = pendingQuantityMap.get(item.id);
    const limitedActualQuantity = item.limitedPurchasedQuantity;
    const isCompatibleLimitedQuantity =
      item.purchaseStatus !== "LimitedPurchase" ||
      limitedActualQuantity === undefined ||
      (Number.isInteger(limitedActualQuantity) &&
        limitedActualQuantity >= 1 &&
        limitedActualQuantity < (pendingQuantity?.nextQuantity ?? 0));
    let nextItem = item;

    if (sourceUpdate) {
      // シート同期で変更できる項目だけを明示する。
      // 購入状態・購入金額・利用者メモ・実購入数などは常に元の値を使う。
      nextItem = {
        ...item,
        title: sourceUpdate.title,
        quantity: sourceUpdate.quantity,
        catalogPrice: sourceUpdate.catalogPrice,
        sheetRemarks: sourceUpdate.sheetRemarks,
        url: sourceUpdate.url,
      };
    }

    if (
      appFieldSyncCandidate &&
      isCandidateStillEligible(item, appFieldSyncCandidate)
    ) {
      const priceCandidate = appFieldSyncCandidate.price;
      const remarksCandidate = appFieldSyncCandidate.remarks;

      if (
        priceCandidate &&
        shouldApplyPriceCandidate(item, priceCandidate, priceSyncMode)
      ) {
        nextItem = {
          ...nextItem,
          price: priceCandidate.sheetValue,
        };
      }

      if (
        remarksCandidate &&
        shouldApplyRemarksCandidate(item, remarksCandidate, remarksSyncMode)
      ) {
        nextItem = {
          ...nextItem,
          remarks: remarksCandidate.sheetValue,
        };
      }
    }

    if (
      pendingQuantity &&
      item.purchaseStatus === pendingQuantity.purchaseStatus &&
      item.quantity === pendingQuantity.currentQuantity &&
      Number.isInteger(pendingQuantity.nextQuantity) &&
      pendingQuantity.nextQuantity >= 1 &&
      pendingQuantity.nextQuantity <= 20 &&
      isCompatibleLimitedQuantity
    ) {
      nextItem = {
        ...nextItem,
        quantity: pendingQuantity.nextQuantity,
      };
    }

    return nextItem;
  });

  updateData.itemsToAdd.forEach((itemData) => {
    const newItem = createSpreadsheetItem(itemData);
    updatedItems = insertItemSorted(updatedItems, newItem);
  });

  return updatedItems;
}

export function removeDeletedIdsFromExecuteModeItems(
  executeModeItems: ExecuteModeItems,
  deleteIds: Set<string>,
): ExecuteModeItems {
  const updatedEventItems: ExecuteModeItems = {};

  Object.keys(executeModeItems).forEach((eventDate) => {
    updatedEventItems[eventDate] = executeModeItems[eventDate].filter(
      (id) => !deleteIds.has(id),
    );
  });

  return updatedEventItems;
}
