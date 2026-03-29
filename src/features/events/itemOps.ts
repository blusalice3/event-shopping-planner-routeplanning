/**
 * アイテム操作の純粋関数群
 *
 * App.txsの巨大なcallback群から抽出した、状態変換のみを行う純粋関数。
 * setState は呼ばず、新しい状態値を返す。
 * App.tsx 側のラッパーが setState で適用する。
 */

import type {
  ShoppingItem,
  PurchaseStatus,
  ViewMode,
  ProtectionLevel,
  ItemSource,
  ExecuteModeItems,
  HallDefinition,
  HallRouteSettings,
  DayMapData,
} from '../../types';

// ────────────────────────────────────────────────
// 共通ヘルパー
// ────────────────────────────────────────────────

/** ポリゴン内判定（ray-casting） */
function isPointInPoly(
  row: number,
  col: number,
  vertices: { row: number; col: number }[],
): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].col,
      yi = vertices[i].row;
    const xj = vertices[j].col,
      yj = vertices[j].row;
    if (yi > row !== yj > row && col < ((xj - xi) * (row - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * アイテムが属するホールIDを返す。
 * block中心座標とホールポリゴンで判定する。
 */
export function findItemHallId(
  item: ShoppingItem,
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
): string | null {
  if (!mapData || halls.length === 0) return null;

  const blockName = item.block?.trim() || '';
  const block = mapData.blocks.find((b) => b.name === blockName);
  if (!block) return null;

  const centerRow = (block.startRow + block.endRow) / 2;
  const centerCol = (block.startCol + block.endCol) / 2;

  for (const hall of halls) {
    if (hall.vertices.length >= 4 && isPointInPoly(centerRow, centerCol, hall.vertices)) {
      return hall.id;
    }
  }
  return null;
}

/**
 * アイテムが属するホールIDを返す（numberセルベース、優先度変更用）。
 * セルの正確な位置を使い、頂点一致もチェックする。
 */
function findItemHallIdByCell(
  item: ShoppingItem,
  halls: HallDefinition[],
  mapData: DayMapData | undefined,
): string | null {
  if (!mapData || halls.length === 0) return null;

  const block = mapData.blocks.find((b) => b.name === item.block);
  if (!block) return null;

  const numMatch = item.number?.match(/\d+/);
  if (!numMatch) return null;
  const num = parseInt(numMatch[0], 10);
  const cell = block.numberCells.find((nc) => nc.value === num);
  if (!cell) return null;

  for (const hall of halls) {
    if (isPointInPoly(cell.row, cell.col, hall.vertices)) {
      return hall.id;
    }
    for (const vertex of hall.vertices) {
      if (vertex.row === cell.row && vertex.col === cell.col) {
        return hall.id;
      }
    }
  }
  return null;
}

// ────────────────────────────────────────────────
// 1. computeUpdateItem
// ────────────────────────────────────────────────

export interface UpdateItemResult {
  items: ShoppingItem[];
  purchaseStatusChanged: boolean;
}

/**
 * 単一アイテムの更新。protectionLevel昇格ロジックを含む。
 */
export function computeUpdateItem(
  items: ShoppingItem[],
  updatedItem: ShoppingItem,
  mode: ViewMode | undefined,
  currentProtection: ProtectionLevel | undefined,
  itemSource: ItemSource | undefined,
): UpdateItemResult {
  const currentItem = items.find((item) => item.id === updatedItem.id);
  const purchaseStatusChanged =
    currentItem != null && currentItem.purchaseStatus !== updatedItem.purchaseStatus;
  const priceChanged = currentItem != null && currentItem.price !== updatedItem.price;

  let finalItem = updatedItem;

  if (
    (mode === 'execute' || mode === 'focus') &&
    (purchaseStatusChanged || priceChanged)
  ) {
    const effectiveProtection = currentProtection ?? (itemSource === 'app' ? 'full' : 'none');
    if (effectiveProtection === 'none') {
      finalItem = { ...updatedItem, protectionLevel: 'deletable' as const };
    }
  }

  return {
    items: items.map((item) => (item.id === updatedItem.id ? finalItem : item)),
    purchaseStatusChanged,
  };
}

// ────────────────────────────────────────────────
// 2. computeDeleteItem
// ────────────────────────────────────────────────

export interface DeleteItemResult {
  items: ShoppingItem[];
  executeModeItems: ExecuteModeItems;
}

/**
 * アイテム削除。eventListsとexecuteModeItems両方から除去する。
 */
export function computeDeleteItem(
  items: ShoppingItem[],
  deletedId: string,
  executeModeItems: ExecuteModeItems,
): DeleteItemResult {
  const newItems = items.filter((item) => item.id !== deletedId);

  const newExecuteItems: ExecuteModeItems = {};
  Object.keys(executeModeItems).forEach((eventDate) => {
    newExecuteItems[eventDate] = executeModeItems[eventDate].filter((id) => id !== deletedId);
  });

  return { items: newItems, executeModeItems: newExecuteItems };
}

// ────────────────────────────────────────────────
// 3. computeAddItemFromFocusMode
// ────────────────────────────────────────────────

export interface AddItemFromFocusModeResult {
  items: ShoppingItem[];
  executeModeItems: ExecuteModeItems;
  newItemId: string;
}

/**
 * フォーカスモードからの新規アイテム追加。
 */
export function computeAddItemFromFocusMode(
  items: ShoppingItem[],
  newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus },
  executeModeItems: ExecuteModeItems,
): AddItemFromFocusModeResult {
  const purchaseStatus = newItem.purchaseStatus || 'None';

  const item: ShoppingItem = {
    ...newItem,
    id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    purchaseStatus,
    source: 'app' as const,
    protectionLevel: 'full' as const,
  };

  const newItems = [...items, item];
  let newExecuteItems = executeModeItems;

  if (purchaseStatus === 'Purchased' || purchaseStatus === 'Postpone' || purchaseStatus === 'Late') {
    const dayName = newItem.eventDate;
    if (dayName) {
      const dayItems = executeModeItems[dayName] || [];
      newExecuteItems = {
        ...executeModeItems,
        [dayName]: [...dayItems, item.id],
      };
    }
  }

  return { items: newItems, executeModeItems: newExecuteItems, newItemId: item.id };
}

// ────────────────────────────────────────────────
// 4. computeAddToExecuteListFromMap
// ────────────────────────────────────────────────

/**
 * マップからexecuteリストにアイテムを追加（ホール順序を考慮した挿入位置決定）。
 */
export function computeAddToExecuteListFromMap(
  itemId: string,
  dayName: string,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
  halls: HallDefinition[],
  hallRouteSettingsForMap: HallRouteSettings,
  mapData: DayMapData | undefined,
): ExecuteModeItems {
  const dayItems = [...(executeModeItems[dayName] || [])];

  if (dayItems.includes(itemId)) return executeModeItems;

  const item = allItems.find((i) => i.id === itemId);
  if (!item) return executeModeItems;

  const itemHallId = findItemHallId(item, halls, mapData);

  if (!itemHallId || halls.length === 0) {
    dayItems.push(itemId);
    return { ...executeModeItems, [dayName]: dayItems };
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

  dayItems.splice(insertIndex, 0, itemId);
  return { ...executeModeItems, [dayName]: dayItems };
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
  const dayItems = [...(executeModeItems[dayName] || [])];

  if (dayItems.includes(itemId)) return executeModeItems;

  const refIndex = dayItems.indexOf(referenceItemId);
  if (refIndex < 0) {
    dayItems.push(itemId);
  } else {
    const insertIndex = position === 'before' ? refIndex : refIndex + 1;
    dayItems.splice(insertIndex, 0, itemId);
  }

  return { ...executeModeItems, [dayName]: dayItems };
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
): ExecuteModeItems {
  const dayItems = (executeModeItems[dayName] || []).filter((id) => id !== itemId);
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

  return {
    ...executeModeItems,
    [dayName]: [...currentDayItems, ...newItemIds],
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
// 9. computeMoveItem (D&D)
// ────────────────────────────────────────────────

export interface MoveItemResult {
  eventListItems?: ShoppingItem[];
  executeModeItems?: ExecuteModeItems;
}

/**
 * D&Dによるアイテム移動。5つのコードパスを統合:
 * - editモード列間移動（candidate→execute, execute→candidate）
 * - editモード同列リオーダー（execute列内, candidate列内）
 * - executeモードリオーダー
 */
export function computeMoveItem(params: {
  dragId: string;
  hoverId: string;
  targetColumn?: 'execute' | 'candidate';
  sourceColumn?: 'execute' | 'candidate';
  mode: ViewMode | undefined;
  effectiveSelectedIds: Set<string>;
  allItems: ShoppingItem[];
  executeModeItems: ExecuteModeItems;
  dayName: string;
  selectedBlockFilters: Set<string>;
}): MoveItemResult {
  const {
    dragId,
    hoverId,
    targetColumn,
    sourceColumn,
    mode,
    effectiveSelectedIds,
    allItems,
    executeModeItems,
    dayName,
    selectedBlockFilters,
  } = params;

  const isDragInEffectiveSelection = effectiveSelectedIds.has(dragId);
  const isAppendToEnd = hoverId === '__END_OF_LIST__';
  const executeIdsSet = new Set(executeModeItems[dayName] || []);

  // ---- editモード列間移動 ----
  if (mode === 'edit' && sourceColumn && targetColumn && sourceColumn !== targetColumn) {
    if (sourceColumn === 'candidate' && targetColumn === 'execute') {
      // candidate → execute
      const currentTabItems = allItems.filter((item) => item.eventDate === dayName);
      let candidateItems = currentTabItems.filter((item) => !executeIdsSet.has(item.id));

      if (selectedBlockFilters.size > 0) {
        candidateItems = candidateItems.filter((item) => selectedBlockFilters.has(item.block));
      }

      let itemsToMove: ShoppingItem[] = [];
      if (isDragInEffectiveSelection) {
        itemsToMove = candidateItems.filter((item) => effectiveSelectedIds.has(item.id));
      } else {
        const item = candidateItems.find((item) => item.id === dragId);
        if (item) itemsToMove = [item];
      }

      if (itemsToMove.length === 0) return {};

      const itemIdsToMove = itemsToMove.map((item) => item.id);
      const dayItems = [...(executeModeItems[dayName] || [])];

      if (isAppendToEnd) {
        return {
          executeModeItems: { ...executeModeItems, [dayName]: [...dayItems, ...itemIdsToMove] },
        };
      } else {
        const hoverIndex = dayItems.findIndex((id) => id === hoverId);
        if (hoverIndex === -1) {
          return {
            executeModeItems: { ...executeModeItems, [dayName]: [...dayItems, ...itemIdsToMove] },
          };
        }
        dayItems.splice(hoverIndex, 0, ...itemIdsToMove);
        return {
          executeModeItems: { ...executeModeItems, [dayName]: dayItems },
        };
      }
    } else if (sourceColumn === 'execute' && targetColumn === 'candidate') {
      // execute → candidate
      const executeItems = allItems.filter(
        (item) => item.eventDate.includes(dayName) && executeIdsSet.has(item.id),
      );
      const candidateItems = allItems.filter(
        (item) => item.eventDate.includes(dayName) && !executeIdsSet.has(item.id),
      );

      let itemsToMove: ShoppingItem[] = [];
      if (isDragInEffectiveSelection) {
        itemsToMove = executeItems.filter((item) => effectiveSelectedIds.has(item.id));
      } else {
        const item = executeItems.find((item) => item.id === dragId);
        if (item) itemsToMove = [item];
      }

      if (itemsToMove.length === 0) return {};

      const itemIdsToMove = itemsToMove.map((item) => item.id);

      // executeModeItemsからの除去
      const newDayItems = (executeModeItems[dayName] || []).filter(
        (id) => !itemIdsToMove.includes(id),
      );

      // candidate列のリオーダー
      let newCandidateList: ShoppingItem[];
      if (isAppendToEnd) {
        newCandidateList = [...candidateItems, ...itemsToMove];
      } else {
        const hoverIndex = candidateItems.findIndex((item) => item.id === hoverId);
        if (hoverIndex === -1) {
          newCandidateList = [...candidateItems, ...itemsToMove];
        } else {
          const listWithoutMoved = candidateItems.filter(
            (item) => !itemIdsToMove.includes(item.id),
          );
          listWithoutMoved.splice(hoverIndex, 0, ...itemsToMove);
          newCandidateList = listWithoutMoved;
        }
      }

      // allItemsのリビルド
      const remainingExecuteItems = executeItems.filter(
        (item) => !itemIdsToMove.includes(item.id),
      );
      const execShift = [...remainingExecuteItems];
      const candShift = [...newCandidateList];

      const newItems = allItems.map((item) => {
        if (!item.eventDate.includes(dayName)) return item;
        if (executeIdsSet.has(item.id) && !itemIdsToMove.includes(item.id)) {
          return execShift.shift() || item;
        } else if (!executeIdsSet.has(item.id) || itemIdsToMove.includes(item.id)) {
          return candShift.shift() || item;
        }
        return item;
      });

      return {
        eventListItems: newItems,
        executeModeItems: { ...executeModeItems, [dayName]: newDayItems },
      };
    }
  }

  // ---- editモード同列リオーダー: execute列内 ----
  if (mode === 'edit' && targetColumn === 'execute') {
    const dayItems = [...(executeModeItems[dayName] || [])];

    if (isDragInEffectiveSelection) {
      const selectedBlock = dayItems.filter((id) => effectiveSelectedIds.has(id));
      const listWithoutSelection = dayItems.filter((id) => !effectiveSelectedIds.has(id));

      if (isAppendToEnd) {
        return {
          executeModeItems: {
            ...executeModeItems,
            [dayName]: [...listWithoutSelection, ...selectedBlock],
          },
        };
      }

      const targetIndex = listWithoutSelection.findIndex((id) => id === hoverId);
      if (targetIndex === -1) return {};
      listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);

      return {
        executeModeItems: { ...executeModeItems, [dayName]: listWithoutSelection },
      };
    } else {
      const dragIndex = dayItems.findIndex((id) => id === dragId);
      if (dragIndex === -1) return {};
      const [draggedItem] = dayItems.splice(dragIndex, 1);

      if (isAppendToEnd) {
        dayItems.push(draggedItem);
      } else {
        const hoverIndex = dayItems.findIndex((id) => id === hoverId);
        if (hoverIndex === -1) return {};
        dayItems.splice(hoverIndex, 0, draggedItem);
      }

      return {
        executeModeItems: { ...executeModeItems, [dayName]: dayItems },
      };
    }
  }

  // ---- editモード同列リオーダー: candidate列内 ----
  if (mode === 'edit' && targetColumn === 'candidate') {
    const candidateItems = allItems.filter(
      (item) => item.eventDate.includes(dayName) && !executeIdsSet.has(item.id),
    );

    const rebuildItems = (newCandidateList: ShoppingItem[]): ShoppingItem[] => {
      const executeItems = allItems.filter(
        (item) => item.eventDate.includes(dayName) && executeIdsSet.has(item.id),
      );
      const execShift = [...executeItems];
      const candShift = [...newCandidateList];

      return allItems.map((item) => {
        if (!item.eventDate.includes(dayName)) return item;
        if (executeIdsSet.has(item.id)) {
          return execShift.shift() || item;
        } else {
          return candShift.shift() || item;
        }
      });
    };

    if (isDragInEffectiveSelection) {
      const selectedBlock = candidateItems.filter((item) => effectiveSelectedIds.has(item.id));
      const listWithoutSelection = candidateItems.filter(
        (item) => !effectiveSelectedIds.has(item.id),
      );

      let newCandidateList: ShoppingItem[];
      if (isAppendToEnd) {
        newCandidateList = [...listWithoutSelection, ...selectedBlock];
      } else {
        const targetIndex = listWithoutSelection.findIndex((item) => item.id === hoverId);
        if (targetIndex === -1) return {};
        listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
        newCandidateList = listWithoutSelection;
      }

      return { eventListItems: rebuildItems(newCandidateList) };
    } else {
      const dragIndex = candidateItems.findIndex((item) => item.id === dragId);
      if (dragIndex === -1) return {};

      const [draggedItem] = candidateItems.splice(dragIndex, 1);
      if (isAppendToEnd) {
        candidateItems.push(draggedItem);
      } else {
        const hoverIndex = candidateItems.findIndex((item) => item.id === hoverId);
        if (hoverIndex === -1) return {};
        candidateItems.splice(hoverIndex, 0, draggedItem);
      }

      return { eventListItems: rebuildItems(candidateItems) };
    }
  }

  // ---- executeモードリオーダー ----
  if (mode === 'execute') {
    const newItems = [...allItems];

    if (isDragInEffectiveSelection) {
      const selectedBlock = newItems.filter((item) => effectiveSelectedIds.has(item.id));
      const listWithoutSelection = newItems.filter((item) => !effectiveSelectedIds.has(item.id));

      if (isAppendToEnd) {
        return { eventListItems: [...listWithoutSelection, ...selectedBlock] };
      }

      const targetIndex = listWithoutSelection.findIndex((item) => item.id === hoverId);
      if (targetIndex === -1) return {};
      listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);

      return { eventListItems: listWithoutSelection };
    } else {
      const dragIndex = newItems.findIndex((item) => item.id === dragId);
      if (dragIndex === -1) return {};

      const [draggedItem] = newItems.splice(dragIndex, 1);
      if (isAppendToEnd) {
        newItems.push(draggedItem);
      } else {
        const hoverIndex = newItems.findIndex((item) => item.id === hoverId);
        if (hoverIndex === -1) return {};
        newItems.splice(hoverIndex, 0, draggedItem);
      }
      return { eventListItems: newItems };
    }
  }

  return {};
}

// ────────────────────────────────────────────────
// 10. computeMoveItemVertical
// ────────────────────────────────────────────────

/**
 * 上下移動。ホール境界を尊重する。
 *
 * @param areItemsInSameHall - App.tsx側で定義されるホール判定コールバック
 */
export function computeMoveItemVertical(
  direction: 'up' | 'down',
  itemId: string,
  targetColumn: 'execute' | 'candidate' | undefined,
  mode: ViewMode | undefined,
  effectiveSelectedIds: Set<string>,
  allItems: ShoppingItem[],
  executeModeItems: ExecuteModeItems,
  dayName: string,
  areItemsInSameHall: (id1: string, id2: string) => boolean,
): MoveItemResult {
  const isDragInEffectiveSelection = effectiveSelectedIds.has(itemId);
  const executeIdsSet = new Set(executeModeItems[dayName] || []);

  // ---- editモード execute列 ----
  if (mode === 'edit' && targetColumn === 'execute') {
    const dayItems = [...(executeModeItems[dayName] || [])];
    const currentIndex = dayItems.findIndex((id) => id === itemId);

    if (direction === 'up') {
      if (currentIndex <= 0) return {};
      const targetId = dayItems[currentIndex - 1];
      if (!areItemsInSameHall(itemId, targetId)) return {};

      if (isDragInEffectiveSelection) {
        const selectedIds = dayItems.filter((id) => effectiveSelectedIds.has(id));
        const listWithoutSelection = dayItems.filter((id) => !effectiveSelectedIds.has(id));
        const firstSelectedIndex = dayItems.findIndex((id) => effectiveSelectedIds.has(id));
        if (firstSelectedIndex > 0) {
          const targetIdForGroup = dayItems[firstSelectedIndex - 1];
          if (!areItemsInSameHall(selectedIds[0], targetIdForGroup)) return {};
          const newTargetIndex = firstSelectedIndex - 1;
          listWithoutSelection.splice(newTargetIndex, 0, ...selectedIds);
          return { executeModeItems: { ...executeModeItems, [dayName]: listWithoutSelection } };
        }
        return {};
      } else {
        [dayItems[currentIndex - 1], dayItems[currentIndex]] = [
          dayItems[currentIndex],
          dayItems[currentIndex - 1],
        ];
        return { executeModeItems: { ...executeModeItems, [dayName]: dayItems } };
      }
    } else {
      // down
      if (currentIndex < 0 || currentIndex >= dayItems.length - 1) return {};
      const targetId = dayItems[currentIndex + 1];
      if (!areItemsInSameHall(itemId, targetId)) return {};

      if (isDragInEffectiveSelection) {
        const selectedIds = dayItems.filter((id) => effectiveSelectedIds.has(id));
        const listWithoutSelection = dayItems.filter((id) => !effectiveSelectedIds.has(id));

        let lastSelectedIndex = -1;
        dayItems.forEach((id, index) => {
          if (effectiveSelectedIds.has(id)) lastSelectedIndex = index;
        });

        if (lastSelectedIndex >= 0 && lastSelectedIndex < dayItems.length - 1) {
          const jumpOverItemId = dayItems[lastSelectedIndex + 1];
          if (!areItemsInSameHall(selectedIds[selectedIds.length - 1], jumpOverItemId)) return {};

          const targetIndexInListWithout = listWithoutSelection.findIndex(
            (id) => id === jumpOverItemId,
          );
          if (targetIndexInListWithout !== -1) {
            listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedIds);
            return { executeModeItems: { ...executeModeItems, [dayName]: listWithoutSelection } };
          }
        }
        return {};
      } else {
        [dayItems[currentIndex], dayItems[currentIndex + 1]] = [
          dayItems[currentIndex + 1],
          dayItems[currentIndex],
        ];
        return { executeModeItems: { ...executeModeItems, [dayName]: dayItems } };
      }
    }
  }

  // ---- editモード candidate列 ----
  if (mode === 'edit' && targetColumn === 'candidate') {
    const candidateItems = allItems.filter(
      (item) => item.eventDate.includes(dayName) && !executeIdsSet.has(item.id),
    );
    const currentIndex = candidateItems.findIndex((item) => item.id === itemId);

    const rebuildItems = (newCandidateList: ShoppingItem[]): ShoppingItem[] => {
      const executeItems = allItems.filter(
        (item) => item.eventDate.includes(dayName) && executeIdsSet.has(item.id),
      );
      const execShift = [...executeItems];
      const candShift = [...newCandidateList];

      return allItems.map((item) => {
        if (!item.eventDate.includes(dayName)) return item;
        if (executeIdsSet.has(item.id)) {
          return execShift.shift() || item;
        } else {
          return candShift.shift() || item;
        }
      });
    };

    if (direction === 'up') {
      if (currentIndex <= 0) return {};

      if (isDragInEffectiveSelection) {
        const selectedBlock = candidateItems.filter((item) => effectiveSelectedIds.has(item.id));
        const listWithoutSelection = candidateItems.filter(
          (item) => !effectiveSelectedIds.has(item.id),
        );
        const firstSelectedIndex = candidateItems.findIndex((item) =>
          effectiveSelectedIds.has(item.id),
        );

        if (firstSelectedIndex > 0) {
          const newTargetIndex = firstSelectedIndex - 1;
          listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);
          return { eventListItems: rebuildItems(listWithoutSelection) };
        }
        return {};
      } else {
        [candidateItems[currentIndex - 1], candidateItems[currentIndex]] = [
          candidateItems[currentIndex],
          candidateItems[currentIndex - 1],
        ];
        return { eventListItems: rebuildItems(candidateItems) };
      }
    } else {
      // down
      if (currentIndex < 0 || currentIndex >= candidateItems.length - 1) return {};

      if (isDragInEffectiveSelection) {
        const selectedBlock = candidateItems.filter((item) => effectiveSelectedIds.has(item.id));
        const listWithoutSelection = candidateItems.filter(
          (item) => !effectiveSelectedIds.has(item.id),
        );

        let lastSelectedIndex = -1;
        candidateItems.forEach((item, index) => {
          if (effectiveSelectedIds.has(item.id)) lastSelectedIndex = index;
        });

        if (lastSelectedIndex >= 0 && lastSelectedIndex < candidateItems.length - 1) {
          const jumpOverItemId = candidateItems[lastSelectedIndex + 1].id;
          const targetIndexInListWithout = listWithoutSelection.findIndex(
            (item) => item.id === jumpOverItemId,
          );

          if (targetIndexInListWithout !== -1) {
            listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);
            return { eventListItems: rebuildItems(listWithoutSelection) };
          }
        }
        return {};
      } else {
        [candidateItems[currentIndex], candidateItems[currentIndex + 1]] = [
          candidateItems[currentIndex + 1],
          candidateItems[currentIndex],
        ];
        return { eventListItems: rebuildItems(candidateItems) };
      }
    }
  }

  // ---- executeモード ----
  if (mode === 'execute') {
    const newItems = [...allItems];
    const currentIndex = newItems.findIndex((item) => item.id === itemId);

    if (direction === 'up') {
      if (currentIndex <= 0) return {};

      if (isDragInEffectiveSelection) {
        const selectedBlock = newItems.filter((item) => effectiveSelectedIds.has(item.id));
        const listWithoutSelection = newItems.filter(
          (item) => !effectiveSelectedIds.has(item.id),
        );
        const firstSelectedIndex = newItems.findIndex((item) =>
          effectiveSelectedIds.has(item.id),
        );

        if (firstSelectedIndex > 0) {
          const newTargetIndex = firstSelectedIndex - 1;
          listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);
          return { eventListItems: listWithoutSelection };
        }
        return {};
      } else {
        [newItems[currentIndex - 1], newItems[currentIndex]] = [
          newItems[currentIndex],
          newItems[currentIndex - 1],
        ];
        return { eventListItems: newItems };
      }
    } else {
      // down
      if (currentIndex < 0 || currentIndex >= newItems.length - 1) return {};

      if (isDragInEffectiveSelection) {
        const selectedBlock = newItems.filter((item) => effectiveSelectedIds.has(item.id));
        const listWithoutSelection = newItems.filter(
          (item) => !effectiveSelectedIds.has(item.id),
        );

        let lastSelectedIndex = -1;
        newItems.forEach((item, index) => {
          if (effectiveSelectedIds.has(item.id)) lastSelectedIndex = index;
        });

        if (lastSelectedIndex >= 0 && lastSelectedIndex < newItems.length - 1) {
          const jumpOverItemId = newItems[lastSelectedIndex + 1].id;
          const targetIndexInListWithout = listWithoutSelection.findIndex(
            (item) => item.id === jumpOverItemId,
          );

          if (targetIndexInListWithout !== -1) {
            listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);
            return { eventListItems: listWithoutSelection };
          }
        }
        return {};
      } else {
        [newItems[currentIndex], newItems[currentIndex + 1]] = [
          newItems[currentIndex + 1],
          newItems[currentIndex],
        ];
        return { eventListItems: newItems };
      }
    }
  }

  return {};
}

// ────────────────────────────────────────────────
// 11. computeUpdateItemPriority
// ────────────────────────────────────────────────

export interface UpdateItemPriorityResult {
  items: ShoppingItem[];
  hallRouteSettings: HallRouteSettings;
}

/**
 * アイテムの優先度を変更し、hallRouteSettingsのhallOrderを更新する。
 */
export function computeUpdateItemPriority(
  itemId: string,
  priorityLevel: 'none' | 'priority' | 'highest',
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
    priority: 'none' | 'priority' | 'highest',
  ): string => {
    if (hallId === null) {
      if (priority === 'highest') return 'undefined:highest';
      if (priority === 'priority') return 'undefined:priority';
      return 'undefined';
    }
    if (priority === 'highest') return `${hallId}:highest`;
    if (priority === 'priority') return `${hallId}:priority`;
    return hallId;
  };

  const newGroupId = buildGroupId(itemHallId, priorityLevel);
  const oldPriority = item.priorityLevel || 'none';
  const oldGroupId = buildGroupId(itemHallId, oldPriority);
  const baseGroupId = buildGroupId(itemHallId, 'none');

  let newHallOrder = [...currentHallRouteSettings.hallOrder];

  if (!newHallOrder.includes(baseGroupId)) {
    newHallOrder.push(baseGroupId);
  }

  if (priorityLevel !== 'none' && !newHallOrder.includes(newGroupId)) {
    const priorityGroupId = buildGroupId(itemHallId, 'priority');

    let insertIndex = newHallOrder.length;

    if (priorityLevel === 'highest') {
      const priorityIndex = newHallOrder.indexOf(priorityGroupId);
      const baseIndex = newHallOrder.indexOf(baseGroupId);

      if (priorityIndex !== -1) {
        insertIndex = priorityIndex;
      } else if (baseIndex !== -1) {
        insertIndex = baseIndex;
      }
    } else if (priorityLevel === 'priority') {
      const baseIndex = newHallOrder.indexOf(baseGroupId);
      if (baseIndex !== -1) {
        insertIndex = baseIndex;
      }
    }

    newHallOrder.splice(insertIndex, 0, newGroupId);
  }

  if (oldPriority !== 'none' && oldGroupId !== newGroupId) {
    const otherItemsInOldGroup = allItems.filter((i) => {
      if (i.id === itemId) return false;
      if ((i.priorityLevel || 'none') !== oldPriority) return false;

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
