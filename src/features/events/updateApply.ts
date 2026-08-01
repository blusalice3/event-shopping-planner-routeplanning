import type { ExecuteModeItems, ShoppingItem } from "../../types/item";
import { insertItemSorted } from "../../utils/itemComparison";
import type { EventUpdateDiff } from "./updateDiff";

type EventUpdatePayload = Pick<
  EventUpdateDiff,
  "itemsToDelete" | "itemsToUpdate" | "itemsToAdd"
> &
  Partial<Pick<EventUpdateDiff, "pendingPurchasedQuantityChanges">>;

export type EventUpdateApplyOptions = {
  applyPurchasedQuantityChanges?: boolean;
};

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
