import { useCallback } from "react";
import type { AppNavigationCommands } from "../navigation";
import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
  ViewMode,
} from "../../types/item";
import type {
  BlockSortDirection,
  SortState,
} from "../../features/app-shell/types";
import type { PendingDuplicateEventImport } from "../state/appOverlayTypes";
import {
  buildBulkAddEventMetadata,
  buildBulkAddItems,
  buildBulkAddUiPlan,
  buildInitialDayModesForBulkAdd,
  buildInitialExecuteItemsForBulkAdd,
  buildLayoutAppliedEventItems,
  hasBulkAddLayoutInfo,
  type BulkAddMetadata,
} from "../../features/events/bulkAdd";
import { analyzeDuplicateEventImport } from "../../features/events/duplicateEvent";
import {
  computeDeleteItem,
  computeMoveItem,
  computeMoveItemVertical,
  computeMoveToExecuteColumn,
  computeRemoveFromExecuteColumn,
  computeUpdateItem,
} from "../../features/events/itemOps";
import {
  buildMovePlan,
  getCandidateSourceOrderedIds,
} from "../../features/lists/domain/movePlan";
import { getSpaceKey } from "../../utils/spaceGrouping";
import type { ApplicationSnapshotCommitPort } from "./ApplicationSnapshotCommitPort";

type EventLists = Record<string, ShoppingItem[]>;
type ExecuteModeItemsByEvent = Record<string, ExecuteModeItems>;
type DayModesByEvent = Record<string, DayModeState>;
type StateUpdater<T> = (current: T) => T;

export interface MutableCommandValue<T> {
  current: T;
}

export interface ShoppingItemMutationStatePort {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly eventLists: EventLists;
  readonly eventMetadata: Record<string, EventMetadata>;
  readonly dayModes: DayModesByEvent;
  readonly items: ShoppingItem[];
  readonly selectedItemIds: ReadonlySet<string>;
  readonly selectedBlockFilters: ReadonlySet<string>;
  readonly blockSortDirection: BlockSortDirection | null;
  readonly candidateNumberSortDirection: BlockSortDirection | null;
  readonly itemToDelete: ShoppingItem | null;
  readonly executeModeItemsRef: MutableCommandValue<ExecuteModeItemsByEvent>;
  readonly spaceGroupDragItemIdsRef: MutableCommandValue<
    readonly string[] | null
  >;
  readonly eventUpdatePreviewEpochRef: MutableCommandValue<number>;
}

export interface ShoppingItemMutationActionPort {
  setEventLists(updater: StateUpdater<EventLists>): void;
  setEventMetadata(updater: StateUpdater<Record<string, EventMetadata>>): void;
  setDayModes(updater: StateUpdater<DayModesByEvent>): void;
  updateExecuteModeItems(updater: StateUpdater<ExecuteModeItemsByEvent>): void;
  setRecentlyChangedItemIds(updater: StateUpdater<Set<string>>): void;
  openDuplicateEvent(value: PendingDuplicateEventImport): void;
  clearRangeSelection(): void;
  clearSelection(): void;
  setSortState(value: Extract<SortState, "Manual">): void;
  setBlockSortDirection(value: BlockSortDirection | null): void;
  setCandidateNumberSortDirection(value: BlockSortDirection | null): void;
  confirmItemDelete(): void;
  readonly navigation: Pick<AppNavigationCommands, "openEvent" | "showImport">;
}

export interface ShoppingItemMutationSelectorPort {
  areItemsInSameHall(
    firstItemId: string,
    secondItemId: string,
    eventDate: string,
  ): boolean;
  areItemsInSameHallGroup(
    firstItemId: string,
    secondItemId: string,
    eventDate: string,
  ): boolean;
}

export interface ShoppingItemMutationAlertPort {
  notify(message: string): void;
}

export interface ShoppingItemMutationCommandPorts {
  readonly state: ShoppingItemMutationStatePort;
  readonly actions: ShoppingItemMutationActionPort;
  readonly selectors: ShoppingItemMutationSelectorPort;
  readonly alerts: ShoppingItemMutationAlertPort;
  readonly persistence: ApplicationSnapshotCommitPort;
}

export type BulkAddItemInput = Omit<ShoppingItem, "id" | "purchaseStatus">;
export type ShoppingListColumn = "execute" | "candidate";

export interface ShoppingItemMutationCommands {
  applyBulkAdd(
    eventName: string,
    newItemsData: BulkAddItemInput[],
    metadata?: BulkAddMetadata,
  ): Promise<void>;
  handleBulkAdd(
    eventName: string,
    newItemsData: BulkAddItemInput[],
    metadata?: BulkAddMetadata,
  ): boolean;
  updateItem(updatedItem: ShoppingItem): void;
  moveItem(
    dragId: string,
    hoverId: string,
    targetColumn?: ShoppingListColumn,
    sourceColumn?: ShoppingListColumn,
  ): void;
  moveItemUp(itemId: string, targetColumn?: ShoppingListColumn): void;
  moveItemDown(itemId: string, targetColumn?: ShoppingListColumn): void;
  moveToExecuteColumn(itemIds: string[]): void;
  removeFromExecuteColumn(itemIds: string[]): void;
  confirmDeleteItem(): void;
  toggleBlockSort(): void;
  toggleCandidateBlockSort(): void;
  toggleCandidateNumberSort(): void;
}

const buildSpacePriorityKey = (
  itemId: string,
  items: readonly ShoppingItem[],
): string => {
  const item = items.find((candidate) => candidate.id === itemId);
  return item
    ? `${getSpaceKey(item.block, item.number)}::${item.priorityLevel || "none"}`
    : "";
};

const moveExecuteSpacePriorityGroup = ({
  direction,
  itemId,
  dayItems,
  items,
  effectiveIds,
}: {
  direction: "up" | "down";
  itemId: string;
  dayItems: readonly string[];
  items: readonly ShoppingItem[];
  effectiveIds: ReadonlySet<string>;
}): string[] | null => {
  const nextDayItems = [...dayItems];
  const movingGroupKeys = new Set<string>([
    buildSpacePriorityKey(itemId, items),
  ]);
  effectiveIds.forEach((id) => {
    if (nextDayItems.includes(id)) {
      movingGroupKeys.add(buildSpacePriorityKey(id, items));
    }
  });

  const movingIndices = nextDayItems
    .map((id, index) =>
      movingGroupKeys.has(buildSpacePriorityKey(id, items)) ? index : -1,
    )
    .filter((index) => index >= 0);
  if (movingIndices.length === 0) return null;

  const movingStart = movingIndices[0];
  const movingEnd = movingIndices[movingIndices.length - 1];
  const adjacentIndex = direction === "up" ? movingStart - 1 : movingEnd + 1;
  if (adjacentIndex < 0 || adjacentIndex >= nextDayItems.length) return null;

  const adjacentId = nextDayItems[adjacentIndex];
  const adjacentGroupKey = buildSpacePriorityKey(adjacentId, items);
  if (movingGroupKeys.has(adjacentGroupKey)) return null;

  const movingBlock = nextDayItems.slice(movingStart, movingEnd + 1);
  const remaining = [
    ...nextDayItems.slice(0, movingStart),
    ...nextDayItems.slice(movingEnd + 1),
  ];
  const adjacentItemIndex = remaining.findIndex((id) => id === adjacentId);
  if (adjacentItemIndex < 0) return null;

  let insertIndex: number;
  if (direction === "up") {
    let targetStart = adjacentItemIndex;
    while (
      targetStart > 0 &&
      buildSpacePriorityKey(remaining[targetStart - 1], items) ===
        adjacentGroupKey
    ) {
      targetStart -= 1;
    }
    insertIndex = targetStart;
  } else {
    let targetEnd = adjacentItemIndex;
    while (
      targetEnd < remaining.length - 1 &&
      buildSpacePriorityKey(remaining[targetEnd + 1], items) ===
        adjacentGroupKey
    ) {
      targetEnd += 1;
    }
    insertIndex = targetEnd + 1;
  }

  remaining.splice(insertIndex, 0, ...movingBlock);
  return remaining;
};

export const useShoppingItemMutationCommands = ({
  state,
  actions,
  selectors,
  alerts,
  persistence,
}: ShoppingItemMutationCommandPorts): ShoppingItemMutationCommands => {
  const {
    activeEventName,
    activeEventDate,
    eventLists,
    eventMetadata,
    dayModes,
    items,
    selectedItemIds,
    selectedBlockFilters,
    blockSortDirection,
    candidateNumberSortDirection,
    itemToDelete,
    executeModeItemsRef,
    spaceGroupDragItemIdsRef,
    eventUpdatePreviewEpochRef,
  } = state;
  const {
    setEventLists,
    setEventMetadata,
    setDayModes,
    updateExecuteModeItems,
    setRecentlyChangedItemIds,
    openDuplicateEvent,
    clearRangeSelection,
    clearSelection,
    setSortState,
    setBlockSortDirection,
    setCandidateNumberSortDirection,
    confirmItemDelete,
    navigation,
  } = actions;
  const { areItemsInSameHall, areItemsInSameHallGroup } = selectors;
  const { notify } = alerts;
  const { commitApplicationSnapshotPatch } = persistence;

  const applyBulkAdd = useCallback(
    async (
      eventName: string,
      newItemsData: BulkAddItemInput[],
      metadata?: BulkAddMetadata,
    ): Promise<void> => {
      const newItems = buildBulkAddItems(newItemsData, metadata);
      const isNewEvent = !eventLists[eventName];
      let nextEventLists = eventLists;
      let nextExecuteModeItems = executeModeItemsRef.current;
      let nextEventMetadata = eventMetadata;
      let nextDayModes = dayModes;

      if (hasBulkAddLayoutInfo(metadata) && isNewEvent) {
        const layoutResult = buildLayoutAppliedEventItems(
          newItems,
          metadata.layoutInfo,
        );
        nextEventLists = {
          ...eventLists,
          [eventName]: layoutResult.sortedItems,
        };
        nextExecuteModeItems = {
          ...executeModeItemsRef.current,
          [eventName]: layoutResult.executeModeItems,
        };
      } else {
        nextEventLists = {
          ...eventLists,
          [eventName]: [...(eventLists[eventName] || []), ...newItems],
        };
      }

      const nextMetadata = buildBulkAddEventMetadata(metadata);
      if (nextMetadata) {
        nextEventMetadata = {
          ...eventMetadata,
          [eventName]: nextMetadata,
        };
      }

      if (isNewEvent) {
        const initialDayModes = buildInitialDayModesForBulkAdd(newItems);
        nextDayModes = {
          ...dayModes,
          [eventName]: initialDayModes,
        };

        if (!hasBulkAddLayoutInfo(metadata)) {
          const initialExecuteItems =
            buildInitialExecuteItemsForBulkAdd(newItems);
          nextExecuteModeItems = {
            ...executeModeItemsRef.current,
            [eventName]: initialExecuteItems,
          };
        }
      }

      try {
        await commitApplicationSnapshotPatch({
          eventLists: nextEventLists,
          eventMetadata: nextEventMetadata,
          executeModeItems: nextExecuteModeItems,
          dayModes: nextDayModes,
        });
      } catch {
        notify(
          "イベントを保存できませんでした。表示内容は変更されていません。",
        );
        return;
      }
      setEventLists(() => nextEventLists);
      setEventMetadata(() => nextEventMetadata);
      updateExecuteModeItems(() => nextExecuteModeItems);
      setDayModes(() => nextDayModes);

      const uiPlan = buildBulkAddUiPlan(
        eventName,
        newItems,
        isNewEvent,
        eventLists[eventName] || [],
      );
      notify(uiPlan.alertMessage);
      if (uiPlan.nextActiveTab) {
        navigation.openEvent(
          uiPlan.nextActiveEventName ?? eventName,
          uiPlan.nextActiveTab,
        );
      } else if (uiPlan.nextActiveEventName) {
        navigation.showImport(uiPlan.nextActiveEventName);
      }
    },
    [
      eventLists,
      eventMetadata,
      dayModes,
      executeModeItemsRef,
      commitApplicationSnapshotPatch,
      navigation,
      notify,
      setDayModes,
      setEventLists,
      setEventMetadata,
      updateExecuteModeItems,
    ],
  );

  const handleBulkAdd = useCallback(
    (
      eventName: string,
      newItemsData: BulkAddItemInput[],
      metadata?: BulkAddMetadata,
    ): boolean => {
      eventUpdatePreviewEpochRef.current += 1;
      const normalizedEventName = eventName.trim();
      const isExplicitAddToOpenEvent =
        metadata?.source === "app" &&
        activeEventName === normalizedEventName &&
        Object.prototype.hasOwnProperty.call(eventLists, normalizedEventName);

      if (isExplicitAddToOpenEvent) {
        applyBulkAdd(normalizedEventName, newItemsData, metadata);
        return true;
      }

      const analysis = analyzeDuplicateEventImport({
        eventName: normalizedEventName,
        incomingItems: newItemsData,
        incomingSource: metadata?.url
          ? { url: metadata.url, sheetName: metadata.sheetName || "" }
          : null,
        eventLists,
        eventMetadata,
      });
      if (analysis.kind === "create") {
        applyBulkAdd(analysis.eventName, analysis.incomingItems, metadata);
        return true;
      }

      openDuplicateEvent({ analysis, metadata });
      return false;
    },
    [
      activeEventName,
      applyBulkAdd,
      eventLists,
      eventMetadata,
      eventUpdatePreviewEpochRef,
      openDuplicateEvent,
    ],
  );

  const updateItem = useCallback(
    (updatedItem: ShoppingItem) => {
      if (!activeEventName) return;
      const currentMode = dayModes[activeEventName]?.[activeEventDate];

      setEventLists((current) => {
        const currentItems = current[activeEventName] || [];
        const currentItem = currentItems.find(
          (candidate) => candidate.id === updatedItem.id,
        );
        const result = computeUpdateItem(
          currentItems,
          updatedItem,
          currentMode as ViewMode | undefined,
          currentItem?.protectionLevel,
          currentItem?.source,
        );

        if (result.purchaseStatusChanged || result.purchaseQuantityChanged) {
          setRecentlyChangedItemIds((currentIds) =>
            new Set(currentIds).add(updatedItem.id),
          );
        }
        return { ...current, [activeEventName]: result.items };
      });
    },
    [
      activeEventDate,
      activeEventName,
      dayModes,
      setEventLists,
      setRecentlyChangedItemIds,
    ],
  );

  const moveItem = useCallback(
    (
      dragId: string,
      hoverId: string,
      targetColumn?: ShoppingListColumn,
      sourceColumn?: ShoppingListColumn,
    ) => {
      if (!activeEventName) return;
      clearRangeSelection();
      setSortState("Manual");
      setBlockSortDirection(null);

      const mode = dayModes[activeEventName]?.[activeEventDate];
      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const effectiveSelectedIds = new Set(spaceGroupIds ?? selectedItemIds);
      spaceGroupDragItemIdsRef.current = null;

      const currentEventExecuteItems =
        executeModeItemsRef.current[activeEventName] || {};
      const currentExecuteItems = currentEventExecuteItems[activeEventDate]
        ? {
            ...currentEventExecuteItems,
            [activeEventDate]: [
              ...(currentEventExecuteItems[activeEventDate] || []),
            ],
          }
        : currentEventExecuteItems;

      const selectionSpansMultipleSpaces = (() => {
        if (effectiveSelectedIds.size <= 1) return false;
        const spaceKeys = new Set<string>();
        effectiveSelectedIds.forEach((id) => {
          const selectedItem = (eventLists[activeEventName] || []).find(
            (candidate) => candidate.id === id,
          );
          if (selectedItem) {
            spaceKeys.add(getSpaceKey(selectedItem.block, selectedItem.number));
          }
        });
        return spaceKeys.size > 1;
      })();
      const hallCheck =
        spaceGroupIds || selectionSpansMultipleSpaces
          ? (firstId: string, secondId: string) =>
              areItemsInSameHallGroup(firstId, secondId, activeEventDate)
          : (firstId: string, secondId: string) =>
              areItemsInSameHall(firstId, secondId, activeEventDate);

      const result = computeMoveItem({
        dragId,
        hoverId,
        targetColumn,
        sourceColumn,
        mode: mode as ViewMode | undefined,
        effectiveSelectedIds,
        allItems: eventLists[activeEventName] || [],
        executeModeItems: currentExecuteItems,
        dayName: activeEventDate,
        selectedBlockFilters: new Set(selectedBlockFilters),
        areItemsInSameHall: hallCheck,
      });
      if (result.eventListItems) {
        setEventLists((current) => ({
          ...current,
          [activeEventName]: result.eventListItems!,
        }));
      }
      if (result.executeModeItems) {
        updateExecuteModeItems((current) => ({
          ...current,
          [activeEventName]: result.executeModeItems!,
        }));
      }
    },
    [
      activeEventDate,
      activeEventName,
      areItemsInSameHall,
      areItemsInSameHallGroup,
      clearRangeSelection,
      dayModes,
      eventLists,
      executeModeItemsRef,
      selectedBlockFilters,
      selectedItemIds,
      setBlockSortDirection,
      setEventLists,
      setSortState,
      spaceGroupDragItemIdsRef,
      updateExecuteModeItems,
    ],
  );

  const moveItemVertical = useCallback(
    (
      direction: "up" | "down",
      itemId: string,
      targetColumn?: ShoppingListColumn,
    ) => {
      if (!activeEventName) return;
      clearRangeSelection();
      setSortState("Manual");
      setBlockSortDirection(null);

      const mode = dayModes[activeEventName]?.[activeEventDate];
      const currentEventExecuteItems =
        executeModeItemsRef.current[activeEventName] || {};
      const spaceGroupIds = spaceGroupDragItemIdsRef.current;

      if (mode === "edit" && targetColumn === "execute") {
        const reordered = moveExecuteSpacePriorityGroup({
          direction,
          itemId,
          dayItems: currentEventExecuteItems[activeEventDate] || [],
          items,
          effectiveIds: new Set(spaceGroupIds ?? selectedItemIds),
        });
        if (reordered) {
          updateExecuteModeItems((current) => ({
            ...current,
            [activeEventName]: {
              ...current[activeEventName],
              [activeEventDate]: reordered,
            },
          }));
          return;
        }
      }

      const effectiveSelectedIds = new Set(spaceGroupIds ?? selectedItemIds);
      const hallCheck = spaceGroupIds
        ? (firstId: string, secondId: string) =>
            areItemsInSameHallGroup(firstId, secondId, activeEventDate)
        : (firstId: string, secondId: string) =>
            areItemsInSameHall(firstId, secondId, activeEventDate);
      const result = computeMoveItemVertical(
        direction,
        itemId,
        targetColumn,
        mode as ViewMode | undefined,
        effectiveSelectedIds,
        eventLists[activeEventName] || [],
        currentEventExecuteItems,
        activeEventDate,
        hallCheck,
      );

      if (result.eventListItems) {
        setEventLists((current) => ({
          ...current,
          [activeEventName]: result.eventListItems!,
        }));
      }
      if (result.executeModeItems) {
        updateExecuteModeItems((current) => ({
          ...current,
          [activeEventName]: result.executeModeItems!,
        }));
      }
    },
    [
      activeEventDate,
      activeEventName,
      areItemsInSameHall,
      areItemsInSameHallGroup,
      clearRangeSelection,
      dayModes,
      eventLists,
      executeModeItemsRef,
      items,
      selectedItemIds,
      setBlockSortDirection,
      setEventLists,
      setSortState,
      spaceGroupDragItemIdsRef,
      updateExecuteModeItems,
    ],
  );

  const moveItemUp = useCallback(
    (itemId: string, targetColumn?: ShoppingListColumn) =>
      moveItemVertical("up", itemId, targetColumn),
    [moveItemVertical],
  );
  const moveItemDown = useCallback(
    (itemId: string, targetColumn?: ShoppingListColumn) =>
      moveItemVertical("down", itemId, targetColumn),
    [moveItemVertical],
  );

  const moveToExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;
      const currentExecuteIds =
        executeModeItemsRef.current[activeEventName]?.[activeEventDate] || [];
      const plan = buildMovePlan({
        requestedIds: itemIds,
        sourceOrderedIds: getCandidateSourceOrderedIds(
          items,
          activeEventDate,
          currentExecuteIds,
        ),
        allItems: items,
        dayName: activeEventDate,
        expansionPolicy: "same-visit",
      });
      updateExecuteModeItems((current) => ({
        ...current,
        [activeEventName]: computeMoveToExecuteColumn(
          plan.effective,
          activeEventDate,
          items,
          current[activeEventName] || {},
          new Set(),
        ),
      }));
      clearSelection();
    },
    [
      activeEventDate,
      activeEventName,
      clearSelection,
      executeModeItemsRef,
      items,
      updateExecuteModeItems,
    ],
  );

  const removeFromExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;
      const plan = buildMovePlan({
        requestedIds: itemIds,
        sourceOrderedIds:
          executeModeItemsRef.current[activeEventName]?.[activeEventDate] || [],
        allItems: items,
        dayName: activeEventDate,
        expansionPolicy: "same-visit",
      });
      updateExecuteModeItems((current) => ({
        ...current,
        [activeEventName]: computeRemoveFromExecuteColumn(
          plan.effective,
          current[activeEventName] || {},
          activeEventDate,
        ),
      }));
      clearSelection();
    },
    [
      activeEventDate,
      activeEventName,
      clearSelection,
      executeModeItemsRef,
      items,
      updateExecuteModeItems,
    ],
  );

  const confirmDeleteItem = useCallback(() => {
    if (!itemToDelete || !activeEventName) return;

    const result = computeDeleteItem(
      eventLists[activeEventName] || [],
      itemToDelete.id,
      executeModeItemsRef.current[activeEventName] || {},
    );
    setEventLists((current) => ({
      ...current,
      [activeEventName]: result.items,
    }));
    updateExecuteModeItems((current) => ({
      ...current,
      [activeEventName]: result.executeModeItems,
    }));
    confirmItemDelete();
  }, [
    activeEventName,
    confirmItemDelete,
    eventLists,
    executeModeItemsRef,
    itemToDelete,
    setEventLists,
    updateExecuteModeItems,
  ]);

  const toggleBlockSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection: BlockSortDirection =
      blockSortDirection === "asc" ? "desc" : "asc";
    setEventLists((current) => {
      const allItems = [...(current[activeEventName] || [])];
      const itemsForDate = allItems.filter(
        (item) => item.eventDate === activeEventDate,
      );
      if (itemsForDate.length === 0) return current;

      const sortedItemsForDate = [...itemsForDate].sort((first, second) => {
        if (!first.block && !second.block) return 0;
        if (!first.block) return 1;
        if (!second.block) return -1;
        const comparison = first.block.localeCompare(second.block, "ja", {
          numeric: true,
          sensitivity: "base",
        });
        return nextDirection === "asc" ? comparison : -comparison;
      });
      let sortedIndex = 0;
      return {
        ...current,
        [activeEventName]: allItems.map((item) =>
          item.eventDate === activeEventDate
            ? sortedItemsForDate[sortedIndex++]
            : item,
        ),
      };
    });
    setBlockSortDirection(nextDirection);
    clearSelection();
  }, [
    activeEventDate,
    activeEventName,
    blockSortDirection,
    clearSelection,
    setBlockSortDirection,
    setEventLists,
  ]);

  const toggleCandidateBlockSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection: BlockSortDirection =
      blockSortDirection === "asc" ? "desc" : "asc";
    const executeIds = new Set(
      executeModeItemsRef.current[activeEventName]?.[activeEventDate] || [],
    );
    setEventLists((current) => {
      const allItems = [...(current[activeEventName] || [])];
      const candidateItems = allItems.filter(
        (item) =>
          item.eventDate === activeEventDate && !executeIds.has(item.id),
      );
      if (candidateItems.length === 0) return current;

      const sortedCandidateItems = [...candidateItems].sort((first, second) => {
        if (!first.block && !second.block) return 0;
        if (!first.block) return 1;
        if (!second.block) return -1;
        const comparison = first.block.localeCompare(second.block, "ja", {
          numeric: true,
          sensitivity: "base",
        });
        return nextDirection === "asc" ? comparison : -comparison;
      });
      const executeItems = allItems.filter(
        (item) => item.eventDate === activeEventDate && executeIds.has(item.id),
      );
      return {
        ...current,
        [activeEventName]: allItems.map((item) => {
          if (item.eventDate !== activeEventDate) return item;
          return executeIds.has(item.id)
            ? executeItems.shift() || item
            : sortedCandidateItems.shift() || item;
        }),
      };
    });
    setBlockSortDirection(nextDirection);
    clearSelection();
  }, [
    activeEventDate,
    activeEventName,
    blockSortDirection,
    clearSelection,
    executeModeItemsRef,
    setBlockSortDirection,
    setEventLists,
  ]);

  const toggleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection: BlockSortDirection =
      candidateNumberSortDirection === "asc" ? "desc" : "asc";
    const executeIds = new Set(
      executeModeItemsRef.current[activeEventName]?.[activeEventDate] || [],
    );
    setEventLists((current) => {
      const allItems = [...(current[activeEventName] || [])];
      const candidateItems = allItems.filter(
        (item) =>
          item.eventDate === activeEventDate && !executeIds.has(item.id),
      );
      const filteredCandidateItems =
        selectedBlockFilters.size === 0
          ? candidateItems
          : candidateItems.filter((item) =>
              selectedBlockFilters.has(item.block),
            );
      if (filteredCandidateItems.length === 0) return current;

      const sortedCandidateItems = [...filteredCandidateItems].sort(
        (first, second) => {
          const comparison = first.number.localeCompare(
            second.number,
            undefined,
            { numeric: true, sensitivity: "base" },
          );
          return nextDirection === "asc" ? comparison : -comparison;
        },
      );
      const sortableIds = new Set(
        filteredCandidateItems.map((item) => item.id),
      );
      let sortedIndex = 0;
      return {
        ...current,
        [activeEventName]: allItems.map((item) =>
          sortableIds.has(item.id) ? sortedCandidateItems[sortedIndex++] : item,
        ),
      };
    });
    setCandidateNumberSortDirection(nextDirection);
    clearSelection();
  }, [
    activeEventDate,
    activeEventName,
    candidateNumberSortDirection,
    clearSelection,
    executeModeItemsRef,
    selectedBlockFilters,
    setCandidateNumberSortDirection,
    setEventLists,
  ]);

  return {
    applyBulkAdd,
    handleBulkAdd,
    updateItem,
    moveItem,
    moveItemUp,
    moveItemDown,
    moveToExecuteColumn,
    removeFromExecuteColumn,
    confirmDeleteItem,
    toggleBlockSort,
    toggleCandidateBlockSort,
    toggleCandidateNumberSort,
  };
};
