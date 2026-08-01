import { ShoppingItem } from "../../types/item";
import { getItemKey, getItemKeyWithoutTitle } from "../../utils/itemComparison";

export type SheetItem = Omit<ShoppingItem, "id" | "purchaseStatus">;

export type EventUpdateDiff = {
  itemsToDelete: ShoppingItem[];
  itemsToUpdate: ShoppingItem[];
  itemsToAdd: SheetItem[];
  protectedFromDelete: number;
  protectedFromUpdate: number;
};

function getEffectiveProtectionLevel(
  item: ShoppingItem,
): "full" | "deletable" | "none" {
  if (item.protectionLevel) return item.protectionLevel;
  return item.source === "app" ? "full" : "none";
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
  const itemsToAdd: SheetItem[] = [];
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

    const existingWithAll = currentItemsMapWithAll.get(keyWithAll);
    if (existingWithAll) {
      const protectionLevel = getEffectiveProtectionLevel(existingWithAll);
      if (protectionLevel === "full" || protectionLevel === "deletable") {
        if (
          existingWithAll.price !== sheetItem.price ||
          existingWithAll.remarks !== sheetItem.remarks ||
          existingWithAll.url !== sheetItem.url
        ) {
          protectedFromUpdate++;
        }
        return;
      }

      if (
        existingWithAll.price !== sheetItem.price ||
        existingWithAll.remarks !== sheetItem.remarks ||
        existingWithAll.url !== sheetItem.url
      ) {
        itemsToUpdate.push({
          ...existingWithAll,
          price: sheetItem.price,
          remarks: sheetItem.remarks,
          url: sheetItem.url,
        });
      }
      return;
    }

    const existingWithoutTitle =
      currentItemsMapWithoutTitle.get(keyWithoutTitle);
    if (existingWithoutTitle) {
      const protectionLevel = getEffectiveProtectionLevel(existingWithoutTitle);
      if (protectionLevel === "full" || protectionLevel === "deletable") {
        protectedFromUpdate++;
        return;
      }

      itemsToUpdate.push({
        ...existingWithoutTitle,
        title: sheetItem.title,
        price: sheetItem.price,
        remarks: sheetItem.remarks,
        url: sheetItem.url,
      });
      return;
    }

    itemsToAdd.push(sheetItem);
  });

  return {
    itemsToDelete,
    itemsToUpdate,
    itemsToAdd,
    protectedFromDelete,
    protectedFromUpdate,
  };
}
