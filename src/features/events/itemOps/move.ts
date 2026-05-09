import type { ExecuteModeItems, ShoppingItem, ViewMode } from '../../../types/item';
import { getSpaceKey } from '../../../utils/spaceGrouping';

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
  areItemsInSameHall?: (id1: string, id2: string) => boolean;
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
    areItemsInSameHall,
  } = params;

  const isDragInEffectiveSelection = effectiveSelectedIds.has(dragId);
  const isAppendToEnd = hoverId === '__END_OF_LIST__';
  const executeIdsSet = new Set(executeModeItems[dayName] || []);

  // 同一スペース+同一優先度の全アイテムIDに展開するヘルパー
  const expandSpaceGroup = (itemIds: string[], sourceItems: ShoppingItem[]): string[] => {
    const expandedSet = new Set(itemIds);
    itemIds.forEach((id) => {
      const item = sourceItems.find((i) => i.id === id);
      if (!item) return;
      const sk = getSpaceKey(item.block, item.number);
      const pr = item.priorityLevel || 'none';
      sourceItems.forEach((other) => {
        if (expandedSet.has(other.id)) return;
        if (other.eventDate !== item.eventDate) return;
        if (getSpaceKey(other.block, other.number) === sk && (other.priorityLevel || 'none') === pr) {
          expandedSet.add(other.id);
        }
      });
    });
    return Array.from(expandedSet);
  };

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
        // スペースグループ展開：選択アイテムの同一スペース+同一優先度を自動追加
        const expandedIds = expandSpaceGroup(
          Array.from(effectiveSelectedIds),
          candidateItems,
        );
        itemsToMove = candidateItems.filter((item) => expandedIds.includes(item.id));
      } else {
        const item = candidateItems.find((item) => item.id === dragId);
        if (item) {
          // 単一アイテムでもスペースグループ全体を移動
          const expandedIds = expandSpaceGroup([dragId], candidateItems);
          itemsToMove = candidateItems.filter((i) => expandedIds.includes(i.id));
        }
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
        // スペースグループ展開：選択アイテムの同一スペース+同一優先度を自動追加
        const expandedIds = expandSpaceGroup(
          Array.from(effectiveSelectedIds),
          executeItems,
        );
        itemsToMove = executeItems.filter((item) => expandedIds.includes(item.id));
      } else {
        const item = executeItems.find((item) => item.id === dragId);
        if (item) {
          // 単一アイテムでもスペースグループ全体を移動
          const expandedIds = expandSpaceGroup([dragId], executeItems);
          itemsToMove = executeItems.filter((i) => expandedIds.includes(i.id));
        }
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
    // ホール・優先度境界チェック（isAppendToEndでもスキップしない）
    if (areItemsInSameHall && !isAppendToEnd && !areItemsInSameHall(dragId, hoverId)) {
      return {};
    }
    // 末尾追加時もチェック: ドラッグ元の末尾隣接アイテムと比較してスペース分断を防止
    if (areItemsInSameHall && isAppendToEnd) {
      const dayItemsCurrent = executeModeItems[dayName] || [];
      if (dayItemsCurrent.length > 0) {
        const lastId = dayItemsCurrent[dayItemsCurrent.length - 1];
        if (lastId !== dragId && !areItemsInSameHall(dragId, lastId)) {
          return {};
        }
      }
    }

    const dayItems = [...(executeModeItems[dayName] || [])];

    // スペースキー取得ヘルパー
    const getIdSpaceKey = (id: string): string => {
      const item = allItems.find((i) => i.id === id);
      return item ? getSpaceKey(item.block, item.number) : '';
    };

    // 選択をスペースグループ全体に展開
    const expandedSelection = new Set(effectiveSelectedIds);
    if (isDragInEffectiveSelection) {
      effectiveSelectedIds.forEach((id) => {
        const item = allItems.find((i) => i.id === id);
        if (!item) return;
        const sk = getSpaceKey(item.block, item.number);
        const pr = item.priorityLevel || 'none';
        dayItems.forEach((did) => {
          if (expandedSelection.has(did)) return;
          const ditem = allItems.find((i) => i.id === did);
          if (!ditem) return;
          if (getSpaceKey(ditem.block, ditem.number) === sk && (ditem.priorityLevel || 'none') === pr) {
            expandedSelection.add(did);
          }
        });
      });
    } else {
      // 単一アイテムでもスペースグループ全体を展開
      const dragItem = allItems.find((i) => i.id === dragId);
      if (dragItem) {
        const sk = getSpaceKey(dragItem.block, dragItem.number);
        const pr = dragItem.priorityLevel || 'none';
        dayItems.forEach((did) => {
          if (expandedSelection.has(did)) return;
          const ditem = allItems.find((i) => i.id === did);
          if (!ditem) return;
          if (getSpaceKey(ditem.block, ditem.number) === sk && (ditem.priorityLevel || 'none') === pr) {
            expandedSelection.add(did);
          }
        });
      }
    }

    const selectedBlock = dayItems.filter((id) => expandedSelection.has(id));
    const listWithoutSelection = dayItems.filter((id) => !expandedSelection.has(id));

    if (isAppendToEnd) {
      return {
        executeModeItems: {
          ...executeModeItems,
          [dayName]: [...listWithoutSelection, ...selectedBlock],
        },
      };
    }

    // 挿入先をスペースグループ境界にスナップ
    let targetIndex = listWithoutSelection.findIndex((id) => id === hoverId);
    if (targetIndex === -1) return {};

    // hoverIdのスペースグループの先頭にスナップ（途中に割り込まない）
    const hoverSpaceKey = getIdSpaceKey(hoverId);
    while (targetIndex > 0 && getIdSpaceKey(listWithoutSelection[targetIndex - 1]) === hoverSpaceKey) {
      targetIndex--;
    }

    listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);

    return {
      executeModeItems: { ...executeModeItems, [dayName]: listWithoutSelection },
    };
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
