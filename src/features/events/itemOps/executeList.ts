import type { DayMapData, HallDefinition, HallRouteSettings } from '../../../types/map';
import type { ExecuteModeItems, ShoppingItem } from '../../../types/item';
import { getSpaceKey } from '../../../utils/spaceGrouping';
import { findItemHallId } from './geometry';

export interface MapExecuteInsertResult {
  accepted: boolean;
  executeModeItems: ExecuteModeItems;
  insertedItemIds: string[];
}

export interface ExecutePositionInsertResult {
  accepted: boolean;
  executeModeItems: ExecuteModeItems;
  insertedItemIds: string[];
}

export function expandSameSpacePriorityItemIds(
  itemIds: string[],
  allItems: ShoppingItem[],
  options: {
    dayName?: string;
    excludedIds?: Set<string>;
    sourceIds?: Set<string>;
    excludeSeedIdsFromSiblingExpansion?: boolean;
  } = {},
): string[] {
  const seedIdsSet = new Set(itemIds);
  const expandedIds: string[] = [];
  const expandedIdsSet = new Set<string>();

  for (const itemId of itemIds) {
    const item = allItems.find((i) => i.id === itemId);
    if (!item) continue;
    if (options.dayName && item.eventDate !== options.dayName) continue;

    const addIfAvailable = (id: string) => {
      if (options.excludedIds?.has(id) || expandedIdsSet.has(id)) return;
      if (options.sourceIds && !options.sourceIds.has(id)) return;
      expandedIds.push(id);
      expandedIdsSet.add(id);
    };

    addIfAvailable(item.id);

    const spaceKey = getSpaceKey(item.block, item.number);
    const priorityLevel = item.priorityLevel || 'none';
    for (const sibling of allItems) {
      if (options.excludeSeedIdsFromSiblingExpansion && seedIdsSet.has(sibling.id)) continue;
      if (options.dayName && sibling.eventDate !== options.dayName) continue;
      if (sibling.eventDate !== item.eventDate) continue;
      if (getSpaceKey(sibling.block, sibling.number) !== spaceKey) continue;
      if ((sibling.priorityLevel || 'none') !== priorityLevel) continue;
      addIfAvailable(sibling.id);
    }
  }

  return expandedIds;
}

export function expandMapExecuteInsertItemIds(
  itemIds: string[],
  dayName: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
): string[] {
  return expandSameSpacePriorityItemIds(itemIds, allItems, {
    dayName,
    excludedIds: new Set(executeModeItems[dayName] || []),
    excludeSeedIdsFromSiblingExpansion: true,
  });
}

export function expandExecuteRemovalItemIds(
  itemIds: string[],
  dayName: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
): string[] {
  return expandSameSpacePriorityItemIds(itemIds, allItems, {
    dayName,
    sourceIds: new Set(executeModeItems[dayName] || []),
  });
}

function isSameSpacePriorityGroup(
  id1: string,
  id2: string,
  itemsMap: Map<string, ShoppingItem>,
): boolean {
  const item1 = itemsMap.get(id1);
  const item2 = itemsMap.get(id2);
  if (!item1 || !item2) return false;
  return (
    getSpaceKey(item1.block, item1.number) === getSpaceKey(item2.block, item2.number) &&
    (item1.priorityLevel || 'none') === (item2.priorityLevel || 'none')
  );
}

export function computeInsertIntoExecuteAtPosition(
  itemIds: string[],
  referenceItemId: string,
  position: 'before' | 'after',
  executeModeItems: ExecuteModeItems,
  dayName: string,
  allItems: ShoppingItem[],
  options: {
    expandSiblings?: boolean;
    requireReference?: boolean;
    canInsertWithReference?: (insertedItemId: string, referenceItemId: string) => boolean;
  } = {},
): ExecutePositionInsertResult {
  const currentDayItems = [...(executeModeItems[dayName] || [])];
  const refIndex = currentDayItems.indexOf(referenceItemId);
  if (refIndex < 0 && options.requireReference !== false) {
    return { accepted: false, executeModeItems, insertedItemIds: [] };
  }

  const insertedItemIds = options.expandSiblings === false
    ? itemIds.filter((id) => !currentDayItems.includes(id))
    : expandMapExecuteInsertItemIds(itemIds, dayName, allItems, executeModeItems);
  if (insertedItemIds.length === 0) {
    return { accepted: false, executeModeItems, insertedItemIds: [] };
  }

  if (
    options.canInsertWithReference &&
    refIndex >= 0 &&
    insertedItemIds.some((id) => !options.canInsertWithReference!(id, referenceItemId))
  ) {
    return { accepted: false, executeModeItems, insertedItemIds: [] };
  }

  const itemsMap = new Map(allItems.map((item) => [item.id, item]));
  const dayItems = currentDayItems.filter((id) => !insertedItemIds.includes(id));
  let insertIndex = dayItems.length;

  const currentRefIndex = dayItems.indexOf(referenceItemId);
  if (currentRefIndex >= 0) {
    let groupStart = currentRefIndex;
    let groupEnd = currentRefIndex;

    while (
      groupStart > 0 &&
      isSameSpacePriorityGroup(dayItems[groupStart - 1], referenceItemId, itemsMap)
    ) {
      groupStart--;
    }
    while (
      groupEnd < dayItems.length - 1 &&
      isSameSpacePriorityGroup(dayItems[groupEnd + 1], referenceItemId, itemsMap)
    ) {
      groupEnd++;
    }

    insertIndex = position === 'before' ? groupStart : groupEnd + 1;
  } else if (options.requireReference !== false) {
    return { accepted: false, executeModeItems, insertedItemIds: [] };
  }

  dayItems.splice(insertIndex, 0, ...insertedItemIds);
  return {
    accepted: true,
    executeModeItems: { ...executeModeItems, [dayName]: dayItems },
    insertedItemIds,
  };
}

export function computeAddToExecuteListFromMap(
  itemId: string,
  dayName: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
  halls: HallDefinition[],
  hallRouteSettingsForMap: HallRouteSettings,
  mapData: DayMapData | undefined,
): ExecuteModeItems {
  return computeAddToExecuteListFromMapWithResult(
    itemId,
    dayName,
    allItems,
    executeModeItems,
    halls,
    hallRouteSettingsForMap,
    mapData,
  ).executeModeItems;
}

export function computeAddToExecuteListFromMapWithResult(
  itemId: string,
  dayName: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
  halls: HallDefinition[],
  hallRouteSettingsForMap: HallRouteSettings,
  mapData: DayMapData | undefined,
): MapExecuteInsertResult {
  const insertItemIds = expandMapExecuteInsertItemIds([itemId], dayName, allItems, executeModeItems);
  if (insertItemIds.length === 0) {
    return { accepted: false, executeModeItems, insertedItemIds: [] };
  }

  const dayItems = [...(executeModeItems[dayName] || [])];

  for (const insertItemId of insertItemIds) {
    const item = allItems.find((i) => i.id === insertItemId);
    if (!item) continue;

    const itemHallId = findItemHallId(item, halls, mapData);

    if (!itemHallId || halls.length === 0) {
      dayItems.push(insertItemId);
      continue;
    }

    const hallOrder =
      hallRouteSettingsForMap.hallOrder.length > 0
        ? hallRouteSettingsForMap.hallOrder
        : halls.map((h) => h.id);

    const itemsMap = new Map(allItems.map((i) => [i.id, i]));
    const getHallIdForItem = (id: string): string | null => {
      const targetItem = itemsMap.get(id);
      if (!targetItem) return null;
      return findItemHallId(targetItem, halls, mapData);
    };

    let insertIndex = dayItems.length;
    const itemHallIndex = hallOrder.indexOf(itemHallId);

    if (itemHallIndex >= 0) {
      let lastSameHallIndex = -1;
      let firstLaterHallIndex = -1;

      for (let i = 0; i < dayItems.length; i++) {
        const existingItemHallId = getHallIdForItem(dayItems[i]);
        if (existingItemHallId === itemHallId) {
          lastSameHallIndex = i;
        } else if (existingItemHallId) {
          const existingHallIndex = hallOrder.indexOf(existingItemHallId);
          if (existingHallIndex > itemHallIndex && firstLaterHallIndex === -1) {
            firstLaterHallIndex = i;
          }
        }
      }

      if (lastSameHallIndex >= 0) {
        insertIndex = lastSameHallIndex + 1;
      } else if (firstLaterHallIndex >= 0) {
        insertIndex = firstLaterHallIndex;
      }
    }

    dayItems.splice(insertIndex, 0, insertItemId);
  }

  return {
    accepted: true,
    executeModeItems: { ...executeModeItems, [dayName]: dayItems },
    insertedItemIds: insertItemIds,
  };
}

// ────────────────────────────────────────────────
// 5. computeAddToExecuteListFromMapAtPosition
// ────────────────────────────────────────────────

/**
 * 指定位置にアイテムを挿入する。
 */
export function computeAddToExecuteListFromMapAtPosition(
  itemId: string,
  referenceItemId: string,
  position: 'before' | 'after',
  executeModeItems: ExecuteModeItems,
  dayName: string,
): ExecuteModeItems {
  return computeInsertIntoExecuteAtPosition(
    [itemId],
    referenceItemId,
    position,
    executeModeItems,
    dayName,
    [],
    { expandSiblings: false, requireReference: false },
  ).executeModeItems;
}

// ────────────────────────────────────────────────
// 6. computeRemoveFromExecuteListFromMap
// ────────────────────────────────────────────────

/**
 * マップからexecuteリストのアイテムを除去する。
 */
export function computeRemoveFromExecuteListFromMap(
  itemId: string,
  executeModeItems: ExecuteModeItems,
  dayName: string,
  allItems?: ShoppingItem[],
): ExecuteModeItems {
  const removeIds = allItems
    ? expandExecuteRemovalItemIds([itemId], dayName, allItems, executeModeItems)
    : [itemId];
  const dayItems = (executeModeItems[dayName] || []).filter((id) => !removeIds.includes(id));
  return { ...executeModeItems, [dayName]: dayItems };
}

// ────────────────────────────────────────────────
// 7. computeMoveToExecuteColumn
// ────────────────────────────────────────────────

/**
 * 選択アイテムをexecute列に移動する。
 */
export function computeMoveToExecuteColumn(
  itemIds: string[],
  dayName: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
  selectedBlockFilters: Set<string>,
): ExecuteModeItems {
  const executeIdsSet = new Set(executeModeItems[dayName] || []);
  const currentTabItems = allItems.filter((item) => item.eventDate === dayName);

  let candidateItems = currentTabItems.filter((item) => !executeIdsSet.has(item.id));
  if (selectedBlockFilters.size > 0) {
    candidateItems = candidateItems.filter((item) => selectedBlockFilters.has(item.block));
  }

  const itemIdsSet = new Set(itemIds);
  const itemsToMove = candidateItems.filter((item) => itemIdsSet.has(item.id));
  const orderedItemIds = itemsToMove.map((item) => item.id);

  const currentDayItems = [...(executeModeItems[dayName] || [])];
  const existingIdsSet = new Set(currentDayItems);
  const newItemIds = orderedItemIds.filter((id) => !existingIdsSet.has(id));

  // 同一スペース+同一優先度の兄弟が既にいる場合、その直後に挿入する
  const itemsMap = new Map(allItems.map((item) => [item.id, item]));
  const resultIds = [...currentDayItems];

  for (const newId of newItemIds) {
    const newItem = itemsMap.get(newId);
    if (!newItem) {
      resultIds.push(newId);
      continue;
    }

    const newSpaceKey = getSpaceKey(newItem.block, newItem.number);
    const newPriority = newItem.priorityLevel || 'none';

    // resultIds内で同一spaceKey+priorityLevelの最後の兄弟を検索
    let lastSiblingIndex = -1;
    for (let i = resultIds.length - 1; i >= 0; i--) {
      const existingItem = itemsMap.get(resultIds[i]);
      if (!existingItem) continue;
      if (
        getSpaceKey(existingItem.block, existingItem.number) === newSpaceKey &&
        (existingItem.priorityLevel || 'none') === newPriority
      ) {
        lastSiblingIndex = i;
        break;
      }
    }

    if (lastSiblingIndex !== -1) {
      resultIds.splice(lastSiblingIndex + 1, 0, newId);
    } else {
      resultIds.push(newId);
    }
  }

  return {
    ...executeModeItems,
    [dayName]: resultIds,
  };
}

// ────────────────────────────────────────────────
// 8. computeRemoveFromExecuteColumn
// ────────────────────────────────────────────────

/**
 * 選択アイテムをexecute列から除去する。
 */
export function computeRemoveFromExecuteColumn(
  itemIds: string[],
  executeModeItems: ExecuteModeItems,
  dayName: string,
): ExecuteModeItems {
  const currentDayItems = (executeModeItems[dayName] || []).filter(
    (id) => !itemIds.includes(id),
  );
  return {
    ...executeModeItems,
    [dayName]: currentDayItems,
  };
}

// ────────────────────────────────────────────────
// 8b. reorderExecuteIdsForSpaceAdjacency
// ────────────────────────────────────────────────

/**
 * 優先度変更後に、executeIds内で同一スペース+同一優先度の兄弟と隣接するようにアイテムを移動する。
 */
export function reorderExecuteIdsForSpaceAdjacency(
  itemId: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
  dayName: string,
): ExecuteModeItems {
  const currentDayItems = executeModeItems[dayName] || [];
  if (!currentDayItems.includes(itemId)) return executeModeItems;

  const itemsMap = new Map(allItems.map((item) => [item.id, item]));
  const targetItem = itemsMap.get(itemId);
  if (!targetItem) return executeModeItems;

  const targetSpaceKey = getSpaceKey(targetItem.block, targetItem.number);
  const targetPriority = targetItem.priorityLevel || 'none';

  // 同一spaceKey+priorityLevelの兄弟インデックスを収集
  const siblingIndices: number[] = [];
  const targetIndex = currentDayItems.indexOf(itemId);

  for (let i = 0; i < currentDayItems.length; i++) {
    if (i === targetIndex) continue;
    const item = itemsMap.get(currentDayItems[i]);
    if (!item) continue;
    if (
      getSpaceKey(item.block, item.number) === targetSpaceKey &&
      (item.priorityLevel || 'none') === targetPriority
    ) {
      siblingIndices.push(i);
    }
  }

  // 兄弟がいない場合は何もしない
  if (siblingIndices.length === 0) return executeModeItems;

  // 既に兄弟と隣接している場合は何もしない
  const lastSiblingIndex = siblingIndices[siblingIndices.length - 1];
  const firstSiblingIndex = siblingIndices[0];
  if (targetIndex >= firstSiblingIndex - 1 && targetIndex <= lastSiblingIndex + 1) {
    // 兄弟の範囲内または直接隣接している
    return executeModeItems;
  }

  // 対象を現在位置から除去し、兄弟グループの最後の直後に挿入
  const newDayItems = currentDayItems.filter((id) => id !== itemId);
  // 除去後のインデックスを再計算（targetIndexが兄弟より前にあった場合、インデックスが1つずれる）
  const adjustedLastSiblingIndex =
    targetIndex < lastSiblingIndex ? lastSiblingIndex - 1 : lastSiblingIndex;
  newDayItems.splice(adjustedLastSiblingIndex + 1, 0, itemId);

  return {
    ...executeModeItems,
    [dayName]: newDayItems,
  };
}

// ────────────────────────────────────────────────
// 9. computeMoveItem (D&D)
// ────────────────────────────────────────────────
