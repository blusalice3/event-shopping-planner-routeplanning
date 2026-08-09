import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  CellSelectionMode,
  CellSelectionType,
  PendingCellSelection,
  PendingVertexSelection,
  VertexSelectionMode,
} from "../../features/app-shell/types";
import type { AppNavigationCommands } from "../navigation";
import type { NewItemDefaults } from "../state/useAppUiState";
import {
  computeAddItemFromFocusMode,
  computeAddToExecuteListFromMapWithResult,
  computeHallOrderForPriorityChange,
  computeInsertIntoExecuteAtPosition,
  computeRemoveFromExecuteListFromMapWithResult,
  computeUpdateItemPriority,
  reorderExecuteIdsForSpaceAdjacency,
} from "../../features/events/itemOps";
import {
  cloneHallsForDates,
  emptyHallRouteSettings,
  remapHallRouteSettings,
  splitHallsForStorage,
  updateHallDefinitionsForHalls,
  updateHallRouteSettingsForHalls,
  updateMaplessHallDefinitions,
  updateMaplessHallRouteSettings,
} from "../../features/map/domain/hallOperations";
import type {
  BlockDefinition,
  DayMapData,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
} from "../../types/map";
import { MAPLESS_HALL_KEY, getMaplessKey } from "../../types/map";
import type {
  ExecuteModeItems,
  PurchaseStatus,
  ShoppingItem,
} from "../../types/item";
import type { ApplicationSnapshotCommitPort } from "./ApplicationSnapshotCommitPort";

type StateSetter<T> = Dispatch<SetStateAction<T>>;

export interface MutableMapEditorValue<T> {
  current: T;
}

export type MapEditorPriorityLevel = "none" | "priority" | "highest";

export interface MapEditorStatePort {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly isMapTab: boolean;
  readonly currentMapTabName: string | null;
  readonly currentMapData: DayMapData | null | undefined;
  readonly eventLists: Record<string, ShoppingItem[]>;
  readonly items: ShoppingItem[];
  readonly executeModeItemsRef: MutableMapEditorValue<
    Record<string, ExecuteModeItems>
  >;
  readonly mapData: MapDataStore;
  readonly hallDefinitions: HallDefinitionsStore;
  readonly hallRouteSettings: HallRouteSettingsStore;
  readonly visitListPanelMapTab: string | null;
  readonly cellSelectionMode: CellSelectionMode;
  readonly vertexSelectionMode: VertexSelectionMode;
}

export interface MapEditorActionPort {
  readonly setMapData: StateSetter<MapDataStore>;
  readonly setHallDefinitions: StateSetter<HallDefinitionsStore>;
  readonly setHallRouteSettings: StateSetter<HallRouteSettingsStore>;
  readonly setEventLists: StateSetter<Record<string, ShoppingItem[]>>;
  updateExecuteModeItems(
    updater: (
      current: Record<string, ExecuteModeItems>,
    ) => Record<string, ExecuteModeItems>,
  ): void;
  commitExecuteModeItemsForEvent(
    eventName: string,
    executeModeItems: ExecuteModeItems,
  ): void;
  readonly setNewItemDefaults: StateSetter<NewItemDefaults | null>;
  readonly setItemToEdit: StateSetter<ShoppingItem | null>;
  readonly navigation: Pick<AppNavigationCommands, "showImport">;
  startCellSelection(selection: NonNullable<CellSelectionMode>): void;
  toggleCellSelection(cell: { row: number; col: number }): void;
  finishCellSelection(pending: PendingCellSelection): void;
  startVertexSelection(selection: NonNullable<VertexSelectionMode>): void;
  toggleVertexSelection(vertex: { row: number; col: number }): void;
  finishVertexSelection(pending: PendingVertexSelection): void;
}

export interface MapEditorSelectorPort {
  getMapTabForDate(eventDate: string): string | null;
  getItemHallId(item: ShoppingItem, eventDate: string): string | null;
  areItemsInSameHallGroup(
    firstItemId: string,
    secondItemId: string,
    eventDate: string,
  ): boolean;
}

export interface MapEditorEffectPort {
  readonly selectionEventTarget: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  >;
}

export interface MapEditorCommandPorts {
  readonly state: MapEditorStatePort;
  readonly actions: MapEditorActionPort;
  readonly selectors: MapEditorSelectorPort;
  readonly effects: MapEditorEffectPort;
  readonly persistence: ApplicationSnapshotCommitPort;
}

export interface MapEditorCommands {
  handleAddToExecuteListFromMap(itemId: string): string[];
  handleAddToExecuteListFromMapAtPosition(
    itemId: string,
    referenceItemId: string,
    position: "before" | "after",
  ): string[];
  handleRemoveFromExecuteListFromMap(itemId: string): string[] | undefined;
  handleBatchAddToExecuteListFromMap(itemIds: string[]): string[];
  handleBatchAddToExecuteListFromMapAtPosition(
    itemIds: string[],
    referenceItemId: string,
    position: "before" | "after",
  ): string[];
  handleBatchRemoveFromExecuteListFromMap(
    itemIds: string[],
  ): string[] | undefined;
  handleAddNewItemFromMap(
    eventDate: string,
    block: string,
    number: string,
  ): void;
  handleAddItemFromFocusMode(
    item: Omit<ShoppingItem, "id"> & { purchaseStatus?: PurchaseStatus },
  ): void;
  handleMoveToFirstFromMap(itemId: string): void;
  handleMoveToLastFromMap(itemId: string): void;
  handleUpdateItemPriority(
    itemId: string,
    priorityLevel: MapEditorPriorityLevel,
  ): void;
  handleUpdateItemPriorityFromEdit(
    itemId: string,
    priorityLevel: MapEditorPriorityLevel,
  ): void;
  handleUpdateHallOrderForPriorityChangeFromEdit(
    itemId: string,
    newPriorityLevel: MapEditorPriorityLevel,
    oldPriorityLevel: MapEditorPriorityLevel,
  ): void;
  handleUpdateBlocks(blocks: BlockDefinition[]): void;
  handleUpdateHalls(halls: HallDefinition[]): void;
  handleUpdateMaplessHalls(halls: HallDefinition[]): void;
  handleSyncMaplessHallsToOtherDates(targetDates: string[]): void;
  handleSyncPolygonHallsToOtherDates(targetDates: string[]): void;
  handleStartVertexSelection(editingData?: unknown): void;
  handleConfirmVertexSelection(): void;
  handleCancelVertexSelection(): void;
  handleStartCellSelection(
    type: CellSelectionType,
    editingData?: unknown,
  ): void;
  handleConfirmCellSelection(): void;
  handleCancelCellSelection(): void;
}

const MAP_CELL_CLICK_EVENT = "mapCellClick";

export const sortMapEditorVerticesNonCrossing = (
  vertices: ReadonlyArray<{ row: number; col: number }>,
): Array<{ row: number; col: number }> => {
  if (vertices.length <= 2) return [...vertices];

  const centroidRow =
    vertices.reduce((sum, vertex) => sum + vertex.row, 0) / vertices.length;
  const centroidCol =
    vertices.reduce((sum, vertex) => sum + vertex.col, 0) / vertices.length;

  return [...vertices].sort((first, second) => {
    const firstAngle = Math.atan2(
      first.row - centroidRow,
      first.col - centroidCol,
    );
    const secondAngle = Math.atan2(
      second.row - centroidRow,
      second.col - centroidCol,
    );
    return firstAngle - secondAngle;
  });
};

export const useMapEditorCommands = ({
  state,
  actions,
  selectors,
  effects,
  persistence,
}: MapEditorCommandPorts): MapEditorCommands => {
  const {
    activeEventName,
    activeEventDate,
    isMapTab,
    currentMapTabName,
    currentMapData,
    eventLists,
    items,
    executeModeItemsRef,
    mapData,
    hallDefinitions,
    hallRouteSettings,
    visitListPanelMapTab,
    cellSelectionMode,
    vertexSelectionMode,
  } = state;
  const {
    setMapData,
    setHallDefinitions,
    setHallRouteSettings,
    setEventLists,
    updateExecuteModeItems,
    commitExecuteModeItemsForEvent,
    setNewItemDefaults,
    setItemToEdit,
    navigation,
    startCellSelection,
    toggleCellSelection,
    finishCellSelection,
    startVertexSelection,
    toggleVertexSelection,
    finishVertexSelection,
  } = actions;
  const { commitApplicationSnapshotPatch } = persistence;
  const { getMapTabForDate, getItemHallId, areItemsInSameHallGroup } =
    selectors;
  const { selectionEventTarget } = effects;

  const handleAddToExecuteListFromMap = useCallback(
    (itemId: string): string[] => {
      if (
        !activeEventName ||
        !isMapTab ||
        !currentMapTabName ||
        !activeEventDate
      ) {
        return [];
      }

      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] ?? [];
      const routeSettings = hallRouteSettings[activeEventName]?.[
        currentMapTabName
      ] ?? { hallOrder: [], hallVisitLists: [] };
      const result = computeAddToExecuteListFromMapWithResult(
        itemId,
        activeEventDate,
        items,
        executeModeItemsRef.current[activeEventName] ?? {},
        halls,
        routeSettings,
        mapData[activeEventName]?.[currentMapTabName],
      );
      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.insertedItemIds;
    },
    [
      activeEventDate,
      activeEventName,
      commitExecuteModeItemsForEvent,
      currentMapTabName,
      executeModeItemsRef,
      hallDefinitions,
      hallRouteSettings,
      isMapTab,
      items,
      mapData,
    ],
  );

  const handleAddToExecuteListFromMapAtPosition = useCallback(
    (
      itemId: string,
      referenceItemId: string,
      position: "before" | "after",
    ): string[] => {
      if (!activeEventName || !isMapTab || !activeEventDate) return [];
      const result = computeInsertIntoExecuteAtPosition(
        [itemId],
        referenceItemId,
        position,
        executeModeItemsRef.current[activeEventName] ?? {},
        activeEventDate,
        items,
        {
          canInsertWithReference: (insertedItemId, referenceId) =>
            areItemsInSameHallGroup(
              insertedItemId,
              referenceId,
              activeEventDate,
            ),
        },
      );
      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.insertedItemIds;
    },
    [
      activeEventDate,
      activeEventName,
      areItemsInSameHallGroup,
      commitExecuteModeItemsForEvent,
      executeModeItemsRef,
      isMapTab,
      items,
    ],
  );

  const handleRemoveFromExecuteListFromMap = useCallback(
    (itemId: string): string[] | undefined => {
      if (!activeEventName || !isMapTab || !activeEventDate) return undefined;
      const result = computeRemoveFromExecuteListFromMapWithResult(
        [itemId],
        executeModeItemsRef.current[activeEventName] ?? {},
        activeEventDate,
        items,
      );
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.removedItemIds;
    },
    [
      activeEventDate,
      activeEventName,
      commitExecuteModeItemsForEvent,
      executeModeItemsRef,
      isMapTab,
      items,
    ],
  );

  const handleBatchAddToExecuteListFromMap = useCallback(
    (itemIds: string[]): string[] => {
      if (
        !activeEventName ||
        !isMapTab ||
        !currentMapTabName ||
        !activeEventDate
      ) {
        return [];
      }
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] ?? [];
      const routeSettings = hallRouteSettings[activeEventName]?.[
        currentMapTabName
      ] ?? { hallOrder: [], hallVisitLists: [] };
      const currentMap = mapData[activeEventName]?.[currentMapTabName];
      let current = executeModeItemsRef.current[activeEventName] ?? {};
      const insertedItemIds: string[] = [];
      for (const itemId of itemIds) {
        const result = computeAddToExecuteListFromMapWithResult(
          itemId,
          activeEventDate,
          items,
          current,
          halls,
          routeSettings,
          currentMap,
        );
        if (result.accepted) {
          current = result.executeModeItems;
          insertedItemIds.push(...result.insertedItemIds);
        }
      }
      commitExecuteModeItemsForEvent(activeEventName, current);
      return insertedItemIds;
    },
    [
      activeEventDate,
      activeEventName,
      commitExecuteModeItemsForEvent,
      currentMapTabName,
      executeModeItemsRef,
      hallDefinitions,
      hallRouteSettings,
      isMapTab,
      items,
      mapData,
    ],
  );

  const handleBatchAddToExecuteListFromMapAtPosition = useCallback(
    (
      itemIds: string[],
      referenceItemId: string,
      position: "before" | "after",
    ): string[] => {
      if (!activeEventName || !isMapTab || !activeEventDate) return [];
      const result = computeInsertIntoExecuteAtPosition(
        itemIds,
        referenceItemId,
        position,
        executeModeItemsRef.current[activeEventName] ?? {},
        activeEventDate,
        items,
        {
          canInsertWithReference: (insertedItemId, referenceId) =>
            areItemsInSameHallGroup(
              insertedItemId,
              referenceId,
              activeEventDate,
            ),
        },
      );
      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.insertedItemIds;
    },
    [
      activeEventDate,
      activeEventName,
      areItemsInSameHallGroup,
      commitExecuteModeItemsForEvent,
      executeModeItemsRef,
      isMapTab,
      items,
    ],
  );

  const handleBatchRemoveFromExecuteListFromMap = useCallback(
    (itemIds: string[]): string[] | undefined => {
      if (!activeEventName || !isMapTab || !activeEventDate) return undefined;
      const result = computeRemoveFromExecuteListFromMapWithResult(
        itemIds,
        executeModeItemsRef.current[activeEventName] ?? {},
        activeEventDate,
        items,
      );
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.removedItemIds;
    },
    [
      activeEventDate,
      activeEventName,
      commitExecuteModeItemsForEvent,
      executeModeItemsRef,
      isMapTab,
      items,
    ],
  );

  const handleAddNewItemFromMap = useCallback(
    (eventDate: string, block: string, number: string): void => {
      setNewItemDefaults({ eventDate, block, number });
      setItemToEdit(null);
      navigation.showImport(activeEventName);
    },
    [activeEventName, navigation, setItemToEdit, setNewItemDefaults],
  );

  const handleAddItemFromFocusMode = useCallback(
    (
      newItem: Omit<ShoppingItem, "id"> & {
        purchaseStatus?: PurchaseStatus;
      },
    ): void => {
      if (!activeEventName) return;
      const result = computeAddItemFromFocusMode(
        eventLists[activeEventName] ?? [],
        newItem,
        executeModeItemsRef.current[activeEventName] ?? {},
      );
      setEventLists((previous) => ({
        ...previous,
        [activeEventName]: result.items,
      }));
      updateExecuteModeItems((previous) => ({
        ...previous,
        [activeEventName]: result.executeModeItems,
      }));
    },
    [
      activeEventName,
      eventLists,
      executeModeItemsRef,
      setEventLists,
      updateExecuteModeItems,
    ],
  );

  const handleMoveToFirstFromMap = useCallback(
    (itemId: string): void => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      updateExecuteModeItems((previous) => {
        const eventItems = previous[activeEventName] ?? {};
        const remaining = (eventItems[activeEventDate] ?? []).filter(
          (currentId) => currentId !== itemId,
        );
        return {
          ...previous,
          [activeEventName]: {
            ...eventItems,
            [activeEventDate]: [itemId, ...remaining],
          },
        };
      });
    },
    [activeEventDate, activeEventName, isMapTab, updateExecuteModeItems],
  );

  const handleMoveToLastFromMap = useCallback(
    (itemId: string): void => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      updateExecuteModeItems((previous) => {
        const eventItems = previous[activeEventName] ?? {};
        const remaining = (eventItems[activeEventDate] ?? []).filter(
          (currentId) => currentId !== itemId,
        );
        return {
          ...previous,
          [activeEventName]: {
            ...eventItems,
            [activeEventDate]: [...remaining, itemId],
          },
        };
      });
    },
    [activeEventDate, activeEventName, isMapTab, updateExecuteModeItems],
  );

  const handleUpdateItemPriority = useCallback(
    async (
      itemId: string,
      priorityLevel: MapEditorPriorityLevel,
    ): Promise<void> => {
      if (!activeEventName || !visitListPanelMapTab) return;
      const halls =
        hallDefinitions[activeEventName]?.[visitListPanelMapTab] ?? [];
      const result = computeUpdateItemPriority(
        itemId,
        priorityLevel,
        items,
        halls,
        mapData[activeEventName]?.[visitListPanelMapTab],
        hallRouteSettings[activeEventName]?.[visitListPanelMapTab] ??
          emptyHallRouteSettings(),
      );
      const nextEventLists = {
        ...eventLists,
        [activeEventName]: result.items,
      };
      const nextHallRouteSettings = {
        ...hallRouteSettings,
        [activeEventName]: {
          ...hallRouteSettings[activeEventName],
          [visitListPanelMapTab]: result.hallRouteSettings,
        },
      };

      const changedItem = items.find((item) => item.id === itemId);
      if (!changedItem) return;
      const nextExecuteModeItems = {
        ...executeModeItemsRef.current,
        [activeEventName]: reorderExecuteIdsForSpaceAdjacency(
          itemId,
          result.items,
          executeModeItemsRef.current[activeEventName] ?? {},
          changedItem.eventDate,
        ),
      };
      try {
        await commitApplicationSnapshotPatch({
          eventLists: nextEventLists,
          hallRouteSettings: nextHallRouteSettings,
          executeModeItems: nextExecuteModeItems,
        });
      } catch {
        return;
      }
      setEventLists(() => nextEventLists);
      setHallRouteSettings(() => nextHallRouteSettings);
      updateExecuteModeItems(() => nextExecuteModeItems);
    },
    [
      activeEventName,
      commitApplicationSnapshotPatch,
      eventLists,
      executeModeItemsRef,
      hallDefinitions,
      hallRouteSettings,
      items,
      mapData,
      setEventLists,
      setHallRouteSettings,
      updateExecuteModeItems,
      visitListPanelMapTab,
    ],
  );

  const handleUpdateItemPriorityFromEdit = useCallback(
    async (
      itemId: string,
      priorityLevel: MapEditorPriorityLevel,
    ): Promise<void> => {
      if (!activeEventName) return;
      const currentItems = eventLists[activeEventName] ?? [];
      const changedItem = currentItems.find((item) => item.id === itemId);
      if (!changedItem) return;
      const resolvedHallId = getItemHallId(changedItem, changedItem.eventDate);
      const mapTabForItem = getMapTabForDate(changedItem.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] ?? []).map(
              (hall) => hall.id,
            )
          : [],
      );
      const targetKey =
        resolvedHallId && mapHallIds.has(resolvedHallId) && mapTabForItem
          ? mapTabForItem
          : getMaplessKey(changedItem.eventDate);
      const result = computeUpdateItemPriority(
        itemId,
        priorityLevel,
        currentItems,
        hallDefinitions[activeEventName]?.[targetKey] ?? [],
        targetKey.startsWith(MAPLESS_HALL_KEY)
          ? undefined
          : mapData[activeEventName]?.[targetKey],
        hallRouteSettings[activeEventName]?.[targetKey] ??
          emptyHallRouteSettings(),
      );
      const nextEventLists = {
        ...eventLists,
        [activeEventName]: result.items,
      };
      const nextHallRouteSettings = {
        ...hallRouteSettings,
        [activeEventName]: {
          ...hallRouteSettings[activeEventName],
          [targetKey]: result.hallRouteSettings,
        },
      };
      const nextExecuteModeItems = {
        ...executeModeItemsRef.current,
        [activeEventName]: reorderExecuteIdsForSpaceAdjacency(
          itemId,
          result.items,
          executeModeItemsRef.current[activeEventName] ?? {},
          changedItem.eventDate,
        ),
      };
      try {
        await commitApplicationSnapshotPatch({
          eventLists: nextEventLists,
          hallRouteSettings: nextHallRouteSettings,
          executeModeItems: nextExecuteModeItems,
        });
      } catch {
        return;
      }
      setEventLists(() => nextEventLists);
      setHallRouteSettings(() => nextHallRouteSettings);
      updateExecuteModeItems(() => nextExecuteModeItems);
    },
    [
      activeEventName,
      commitApplicationSnapshotPatch,
      eventLists,
      executeModeItemsRef,
      getItemHallId,
      getMapTabForDate,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      setEventLists,
      setHallRouteSettings,
      updateExecuteModeItems,
    ],
  );

  const handleUpdateHallOrderForPriorityChangeFromEdit = useCallback(
    (
      itemId: string,
      newPriorityLevel: MapEditorPriorityLevel,
      oldPriorityLevel: MapEditorPriorityLevel,
    ): void => {
      if (!activeEventName) return;
      const currentItems = eventLists[activeEventName] ?? [];
      const changedItem = currentItems.find((item) => item.id === itemId);
      if (!changedItem) return;
      const resolvedHallId = getItemHallId(changedItem, changedItem.eventDate);
      const mapTabForItem = getMapTabForDate(changedItem.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] ?? []).map(
              (hall) => hall.id,
            )
          : [],
      );
      const targetKey =
        resolvedHallId && mapHallIds.has(resolvedHallId) && mapTabForItem
          ? mapTabForItem
          : getMaplessKey(changedItem.eventDate);
      const itemsAfter = currentItems.map((item) =>
        item.id === itemId
          ? { ...item, priorityLevel: newPriorityLevel }
          : item,
      );
      const nextSettings = computeHallOrderForPriorityChange(
        itemId,
        newPriorityLevel,
        oldPriorityLevel,
        itemsAfter,
        hallDefinitions[activeEventName]?.[targetKey] ?? [],
        targetKey.startsWith(MAPLESS_HALL_KEY)
          ? undefined
          : mapData[activeEventName]?.[targetKey],
        hallRouteSettings[activeEventName]?.[targetKey] ??
          emptyHallRouteSettings(),
      );
      setHallRouteSettings((previous) => ({
        ...previous,
        [activeEventName]: {
          ...previous[activeEventName],
          [targetKey]: nextSettings,
        },
      }));
      updateExecuteModeItems((previous) => ({
        ...previous,
        [activeEventName]: reorderExecuteIdsForSpaceAdjacency(
          itemId,
          itemsAfter,
          previous[activeEventName] ?? {},
          changedItem.eventDate,
        ),
      }));
    },
    [
      activeEventName,
      eventLists,
      getItemHallId,
      getMapTabForDate,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      setHallRouteSettings,
      updateExecuteModeItems,
    ],
  );

  const handleUpdateBlocks = useCallback(
    (blocks: BlockDefinition[]): void => {
      if (
        !activeEventName ||
        !isMapTab ||
        !currentMapData ||
        !currentMapTabName
      ) {
        return;
      }

      setMapData((previous) => ({
        ...previous,
        [activeEventName]: {
          ...previous[activeEventName],
          [currentMapTabName]: {
            ...currentMapData,
            blocks,
          },
        },
      }));
    },
    [activeEventName, currentMapData, currentMapTabName, isMapTab, setMapData],
  );

  const handleUpdateHalls = useCallback(
    async (halls: HallDefinition[]): Promise<void> => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      const { polygonHalls, maplessHalls } = splitHallsForStorage(halls);
      const maplessKey = activeEventDate
        ? getMaplessKey(activeEventDate)
        : null;

      const nextHallDefinitions = updateHallDefinitionsForHalls({
        previous: hallDefinitions,
        eventName: activeEventName,
        mapTabName: currentMapTabName,
        maplessKey,
        polygonHalls,
        maplessHalls,
      });
      const nextHallRouteSettings = updateHallRouteSettingsForHalls({
        previous: hallRouteSettings,
        eventName: activeEventName,
        mapTabName: currentMapTabName,
        maplessKey,
        polygonHalls,
        maplessHalls,
      });
      try {
        await commitApplicationSnapshotPatch({
          hallDefinitions: nextHallDefinitions,
          hallRouteSettings: nextHallRouteSettings,
        });
      } catch {
        return;
      }
      setHallDefinitions(() => nextHallDefinitions);
      setHallRouteSettings(() => nextHallRouteSettings);
    },
    [
      activeEventDate,
      activeEventName,
      commitApplicationSnapshotPatch,
      currentMapTabName,
      hallDefinitions,
      hallRouteSettings,
      isMapTab,
      setHallDefinitions,
      setHallRouteSettings,
    ],
  );

  const handleUpdateMaplessHalls = useCallback(
    async (halls: HallDefinition[]): Promise<void> => {
      if (!activeEventName || !activeEventDate) return;

      const maplessKey = getMaplessKey(activeEventDate);
      const nextHallDefinitions = updateMaplessHallDefinitions({
        previous: hallDefinitions,
        eventName: activeEventName,
        maplessKey,
        halls,
      });
      const nextHallRouteSettings = updateMaplessHallRouteSettings({
        previous: hallRouteSettings,
        eventName: activeEventName,
        maplessKey,
        halls,
      });
      try {
        await commitApplicationSnapshotPatch({
          hallDefinitions: nextHallDefinitions,
          hallRouteSettings: nextHallRouteSettings,
        });
      } catch {
        return;
      }
      setHallDefinitions(() => nextHallDefinitions);
      setHallRouteSettings(() => nextHallRouteSettings);
    },
    [
      activeEventDate,
      activeEventName,
      commitApplicationSnapshotPatch,
      hallDefinitions,
      hallRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
    ],
  );

  const handleSyncMaplessHallsToOtherDates = useCallback(
    async (targetDates: string[]): Promise<void> => {
      if (!activeEventName || !activeEventDate) return;

      const sourceKey = getMaplessKey(activeEventDate);
      const sourceHalls = hallDefinitions[activeEventName]?.[sourceKey] ?? [];
      if (sourceHalls.length === 0) return;
      const clonedByDate = cloneHallsForDates(sourceHalls, targetDates);

      const nextHallDefinitions = (() => {
        const updated: HallDefinitionsStore = {
          ...hallDefinitions,
          [activeEventName]: { ...hallDefinitions[activeEventName] },
        };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          const cloned = clonedByDate.get(date);
          if (!cloned) continue;
          updated[activeEventName][targetKey] = cloned.halls;
        }
        return updated;
      })();

      const nextHallRouteSettings = (() => {
        const updated: HallRouteSettingsStore = {
          ...hallRouteSettings,
          [activeEventName]: { ...hallRouteSettings[activeEventName] },
        };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          const cloned = clonedByDate.get(date);
          if (!cloned) continue;
          const sourceSettings =
            hallRouteSettings[activeEventName]?.[sourceKey] ??
            emptyHallRouteSettings();
          updated[activeEventName][targetKey] = remapHallRouteSettings(
            sourceSettings,
            cloned.idMap,
          );
        }
        return updated;
      })();
      try {
        await commitApplicationSnapshotPatch({
          hallDefinitions: nextHallDefinitions,
          hallRouteSettings: nextHallRouteSettings,
        });
      } catch {
        return;
      }
      setHallDefinitions(() => nextHallDefinitions);
      setHallRouteSettings(() => nextHallRouteSettings);
    },
    [
      activeEventDate,
      activeEventName,
      commitApplicationSnapshotPatch,
      hallDefinitions,
      hallRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
    ],
  );

  const handleSyncPolygonHallsToOtherDates = useCallback(
    async (targetDates: string[]): Promise<void> => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      const sourceHalls =
        hallDefinitions[activeEventName]?.[currentMapTabName] ?? [];
      if (sourceHalls.length === 0) return;
      const targetMapTabsByDate = new Map<string, string>();
      for (const date of targetDates) {
        const targetMapTab = getMapTabForDate(date);
        if (targetMapTab) targetMapTabsByDate.set(date, targetMapTab);
      }
      const clonedByDate = cloneHallsForDates(
        sourceHalls,
        Array.from(targetMapTabsByDate.keys()),
      );

      const nextHallDefinitions = (() => {
        const updated: HallDefinitionsStore = {
          ...hallDefinitions,
          [activeEventName]: { ...hallDefinitions[activeEventName] },
        };
        for (const [date, { halls }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date);
          if (targetMapTab) updated[activeEventName][targetMapTab] = halls;
        }
        return updated;
      })();

      const nextHallRouteSettings = (() => {
        const updated: HallRouteSettingsStore = {
          ...hallRouteSettings,
          [activeEventName]: { ...hallRouteSettings[activeEventName] },
        };
        for (const [date, { idMap }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date);
          if (!targetMapTab) continue;
          const sourceSettings =
            hallRouteSettings[activeEventName]?.[currentMapTabName] ??
            emptyHallRouteSettings();
          updated[activeEventName][targetMapTab] = remapHallRouteSettings(
            sourceSettings,
            idMap,
          );
        }
        return updated;
      })();
      try {
        await commitApplicationSnapshotPatch({
          hallDefinitions: nextHallDefinitions,
          hallRouteSettings: nextHallRouteSettings,
        });
      } catch {
        return;
      }
      setHallDefinitions(() => nextHallDefinitions);
      setHallRouteSettings(() => nextHallRouteSettings);
    },
    [
      activeEventName,
      commitApplicationSnapshotPatch,
      currentMapTabName,
      getMapTabForDate,
      hallDefinitions,
      hallRouteSettings,
      isMapTab,
      setHallDefinitions,
      setHallRouteSettings,
    ],
  );

  const handleStartVertexSelection = useCallback(
    (editingData?: unknown): void => {
      startVertexSelection({ clickedVertices: [], editingData });
    },
    [startVertexSelection],
  );

  const handleConfirmVertexSelection = useCallback((): void => {
    if (vertexSelectionMode) {
      finishVertexSelection({
        vertices: sortMapEditorVerticesNonCrossing(
          vertexSelectionMode.clickedVertices,
        ),
        editingData: vertexSelectionMode.editingData,
      });
      return;
    }
    finishVertexSelection(null);
  }, [finishVertexSelection, vertexSelectionMode]);

  const handleCancelVertexSelection = useCallback((): void => {
    if (vertexSelectionMode?.editingData) {
      finishVertexSelection({
        vertices: [],
        editingData: vertexSelectionMode.editingData,
      });
      return;
    }
    finishVertexSelection(null);
  }, [finishVertexSelection, vertexSelectionMode?.editingData]);

  useEffect(() => {
    const handleMapCellClickForVertex = (event: Event): void => {
      if (!vertexSelectionMode) return;
      const { row, col } = (event as CustomEvent<{ row: number; col: number }>)
        .detail;
      toggleVertexSelection({ row, col });
    };

    selectionEventTarget.addEventListener(
      MAP_CELL_CLICK_EVENT,
      handleMapCellClickForVertex,
    );
    return () => {
      selectionEventTarget.removeEventListener(
        MAP_CELL_CLICK_EVENT,
        handleMapCellClickForVertex,
      );
    };
  }, [selectionEventTarget, toggleVertexSelection, vertexSelectionMode]);

  const handleStartCellSelection = useCallback(
    (type: CellSelectionType, editingData?: unknown): void => {
      startCellSelection({
        type,
        clickedCells: [],
        editingBlockData: editingData,
      });
    },
    [startCellSelection],
  );

  const handleConfirmCellSelection = useCallback((): void => {
    if (cellSelectionMode) {
      finishCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
      return;
    }
    finishCellSelection(null);
  }, [cellSelectionMode, finishCellSelection]);

  const handleCancelCellSelection = useCallback((): void => {
    if (cellSelectionMode?.editingBlockData) {
      finishCellSelection({
        type: "cancelled",
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
      return;
    }
    finishCellSelection(null);
  }, [cellSelectionMode?.editingBlockData, finishCellSelection]);

  useEffect(() => {
    const handleMapCellClick = (event: Event): void => {
      if (!cellSelectionMode) return;
      const { row, col } = (event as CustomEvent<{ row: number; col: number }>)
        .detail;
      toggleCellSelection({ row, col });
    };

    selectionEventTarget.addEventListener(
      MAP_CELL_CLICK_EVENT,
      handleMapCellClick,
    );
    return () => {
      selectionEventTarget.removeEventListener(
        MAP_CELL_CLICK_EVENT,
        handleMapCellClick,
      );
    };
  }, [cellSelectionMode, selectionEventTarget, toggleCellSelection]);

  return {
    handleAddToExecuteListFromMap,
    handleAddToExecuteListFromMapAtPosition,
    handleRemoveFromExecuteListFromMap,
    handleBatchAddToExecuteListFromMap,
    handleBatchAddToExecuteListFromMapAtPosition,
    handleBatchRemoveFromExecuteListFromMap,
    handleAddNewItemFromMap,
    handleAddItemFromFocusMode,
    handleMoveToFirstFromMap,
    handleMoveToLastFromMap,
    handleUpdateItemPriority,
    handleUpdateItemPriorityFromEdit,
    handleUpdateHallOrderForPriorityChangeFromEdit,
    handleUpdateBlocks,
    handleUpdateHalls,
    handleUpdateMaplessHalls,
    handleSyncMaplessHallsToOtherDates,
    handleSyncPolygonHallsToOtherDates,
    handleStartVertexSelection,
    handleConfirmVertexSelection,
    handleCancelVertexSelection,
    handleStartCellSelection,
    handleConfirmCellSelection,
    handleCancelCellSelection,
  };
};
