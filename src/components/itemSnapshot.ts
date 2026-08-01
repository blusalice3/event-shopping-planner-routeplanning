import type { ShoppingItem } from "../types/item";

export const SHOPPING_ITEM_SNAPSHOT_KEYS = [
  "id",
  "circle",
  "eventDate",
  "block",
  "number",
  "title",
  "price",
  "catalogPrice",
  "purchaseStatus",
  "quantity",
  "limitedPurchasedQuantity",
  "remarks",
  "sheetRemarks",
  "url",
  "priorityLevel",
  "protectionLevel",
  "source",
  "assignedTo",
  "lastSyncedAt",
  "orderIndex",
  "postponed",
  "manualHallId",
] as const satisfies readonly (keyof ShoppingItem)[];

export const areSameItemSnapshot = (
  a: ShoppingItem,
  b: ShoppingItem,
): boolean =>
  a.id === b.id &&
  a.circle === b.circle &&
  a.eventDate === b.eventDate &&
  a.block === b.block &&
  a.number === b.number &&
  a.title === b.title &&
  a.price === b.price &&
  a.catalogPrice === b.catalogPrice &&
  a.purchaseStatus === b.purchaseStatus &&
  a.quantity === b.quantity &&
  a.limitedPurchasedQuantity === b.limitedPurchasedQuantity &&
  a.remarks === b.remarks &&
  a.sheetRemarks === b.sheetRemarks &&
  a.url === b.url &&
  a.priorityLevel === b.priorityLevel &&
  a.protectionLevel === b.protectionLevel &&
  a.source === b.source &&
  a.assignedTo === b.assignedTo &&
  a.lastSyncedAt === b.lastSyncedAt &&
  a.orderIndex === b.orderIndex &&
  a.postponed === b.postponed &&
  a.manualHallId === b.manualHallId;
