import type {
  DayMapData,
  HallDefinition,
  HallRouteSettings,
} from "../../../types/map";
import type { ShoppingItem } from "../../../types/item";
import { findItemHallIdByCell } from "./geometry";

export interface UpdateItemPriorityResult {
  items: ShoppingItem[];
  hallRouteSettings: HallRouteSettings;
}

/**
 * アイテムの優先度を変更し、hallRouteSettingsのhallOrderを更新する。
 */
export function computeUpdateItemPriority(
  itemId: string,
  priorityLevel: "none" | "priority" | "highest",
  allItems: ShoppingItem[],
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
  currentHallRouteSettings: HallRouteSettings,
): UpdateItemPriorityResult {
  // アイテムの優先度更新
  const newItems = allItems.map((item) =>
    item.id === itemId ? { ...item, priorityLevel } : item,
  );

  const item = allItems.find((i) => i.id === itemId);
  if (!item) {
    return { items: newItems, hallRouteSettings: currentHallRouteSettings };
  }

  const itemHallId = findItemHallIdByCell(item, halls, mapData);

  const buildGroupId = (
    hallId: string | null,
    priority: "none" | "priority" | "highest",
  ): string => {
    if (hallId === null) {
      if (priority === "highest") return "undefined:highest";
      if (priority === "priority") return "undefined:priority";
      return "undefined";
    }
    if (priority === "highest") return `${hallId}:highest`;
    if (priority === "priority") return `${hallId}:priority`;
    return hallId;
  };

  const newGroupId = buildGroupId(itemHallId, priorityLevel);
  const oldPriority = item.priorityLevel || "none";
  const oldGroupId = buildGroupId(itemHallId, oldPriority);
  const baseGroupId = buildGroupId(itemHallId, "none");

  let newHallOrder = [...currentHallRouteSettings.hallOrder];

  if (!newHallOrder.includes(baseGroupId)) {
    newHallOrder.push(baseGroupId);
  }

  if (priorityLevel !== "none" && !newHallOrder.includes(newGroupId)) {
    const priorityGroupId = buildGroupId(itemHallId, "priority");

    let insertIndex = newHallOrder.length;

    if (priorityLevel === "highest") {
      const priorityIndex = newHallOrder.indexOf(priorityGroupId);
      const baseIndex = newHallOrder.indexOf(baseGroupId);

      if (priorityIndex !== -1) {
        insertIndex = priorityIndex;
      } else if (baseIndex !== -1) {
        insertIndex = baseIndex;
      }
    } else if (priorityLevel === "priority") {
      const baseIndex = newHallOrder.indexOf(baseGroupId);
      if (baseIndex !== -1) {
        insertIndex = baseIndex;
      }
    }

    newHallOrder.splice(insertIndex, 0, newGroupId);
  }

  if (oldPriority !== "none" && oldGroupId !== newGroupId) {
    const otherItemsInOldGroup = allItems.filter((i) => {
      if (i.id === itemId) return false;
      if ((i.priorityLevel || "none") !== oldPriority) return false;

      const iHallId = findItemHallIdByCell(i, halls, mapData);
      return iHallId === itemHallId;
    });

    if (otherItemsInOldGroup.length === 0) {
      newHallOrder = newHallOrder.filter((id) => id !== oldGroupId);
    }
  }

  return {
    items: newItems,
    hallRouteSettings: {
      ...currentHallRouteSettings,
      hallOrder: newHallOrder,
    },
  };
}

/**
 * 優先度変更に伴う hallRouteSettings.hallOrder のみを計算する
 * （items 配列には触れない、編集ダイアログの onSave 統合経路用）。
 *
 * 呼び出し元は items 側の更新を `computeUpdateItem` 経由の `handleUpdateItem` に委ね、
 * この関数の結果を `setHallRouteSettings` だけに適用する。
 * こうすることで 2 つの `setEventLists` 呼び出しによる race condition を回避する。
 */
export function computeHallOrderForPriorityChange(
  itemId: string,
  newPriorityLevel: "none" | "priority" | "highest",
  oldPriorityLevel: "none" | "priority" | "highest",
  allItems: ShoppingItem[],
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
  currentHallRouteSettings: HallRouteSettings,
): HallRouteSettings {
  const item = allItems.find((i) => i.id === itemId);
  if (!item) return currentHallRouteSettings;

  const itemHallId = findItemHallIdByCell(item, halls, mapData);

  const buildGroupId = (
    hallId: string | null,
    priority: "none" | "priority" | "highest",
  ): string => {
    if (hallId === null) {
      if (priority === "highest") return "undefined:highest";
      if (priority === "priority") return "undefined:priority";
      return "undefined";
    }
    if (priority === "highest") return `${hallId}:highest`;
    if (priority === "priority") return `${hallId}:priority`;
    return hallId;
  };

  const newGroupId = buildGroupId(itemHallId, newPriorityLevel);
  const oldGroupId = buildGroupId(itemHallId, oldPriorityLevel);
  const baseGroupId = buildGroupId(itemHallId, "none");

  let newHallOrder = [...currentHallRouteSettings.hallOrder];

  if (!newHallOrder.includes(baseGroupId)) {
    newHallOrder.push(baseGroupId);
  }

  if (newPriorityLevel !== "none" && !newHallOrder.includes(newGroupId)) {
    const priorityGroupId = buildGroupId(itemHallId, "priority");
    let insertIndex = newHallOrder.length;
    if (newPriorityLevel === "highest") {
      const priorityIndex = newHallOrder.indexOf(priorityGroupId);
      const baseIndex = newHallOrder.indexOf(baseGroupId);
      if (priorityIndex !== -1) insertIndex = priorityIndex;
      else if (baseIndex !== -1) insertIndex = baseIndex;
    } else if (newPriorityLevel === "priority") {
      const baseIndex = newHallOrder.indexOf(baseGroupId);
      if (baseIndex !== -1) insertIndex = baseIndex;
    }
    newHallOrder.splice(insertIndex, 0, newGroupId);
  }

  if (oldPriorityLevel !== "none" && oldGroupId !== newGroupId) {
    const otherItemsInOldGroup = allItems.filter((i) => {
      if (i.id === itemId) return false;
      if ((i.priorityLevel || "none") !== oldPriorityLevel) return false;
      const iHallId = findItemHallIdByCell(i, halls, mapData);
      return iHallId === itemHallId;
    });
    if (otherItemsInOldGroup.length === 0) {
      newHallOrder = newHallOrder.filter((id) => id !== oldGroupId);
    }
  }

  return {
    ...currentHallRouteSettings,
    hallOrder: newHallOrder,
  };
}
