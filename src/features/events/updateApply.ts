import type { ExecuteModeItems, ShoppingItem } from "../../types/item";
import { insertItemSorted } from "../../utils/itemComparison";
import type { EventUpdateDiff } from "./updateDiff";

type EventUpdatePayload = Pick<
  EventUpdateDiff,
  "itemsToDelete" | "itemsToUpdate" | "itemsToAdd"
>;

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
    quantity: itemData.quantity ?? 1,
    remarks: itemData.remarks,
    purchaseStatus: "None",
    source: "spreadsheet",
    protectionLevel: "none",
    ...(itemData.url ? { url: itemData.url } : {}),
  };
}

export function applyEventUpdateToItems(
  currentItems: ShoppingItem[],
  updateData: EventUpdatePayload,
): ShoppingItem[] {
  const deleteIds = new Set(updateData.itemsToDelete.map((item) => item.id));
  const updateMap = new Map(
    updateData.itemsToUpdate.map((item) => [item.id, item]),
  );

  let updatedItems = currentItems.filter((item) => !deleteIds.has(item.id));
  updatedItems = updatedItems.map((item) => updateMap.get(item.id) || item);

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
