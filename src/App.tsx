import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  ShoppingItem,
  EventMetadata,
  DayModeState,
  ExecuteModeItems,
} from "./types/item";
import {
  MapDataStore,
  RouteSettingsStore,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
} from "./types/map";
import { FocusModeSessionState } from "./types/focus";
import { getMaplessKey } from "./types/map";
import { extractEventDates } from "./utils/eventDates";
import { getSpaceKey } from "./utils/spaceGrouping";
import { type EventUpdateCommitState } from "./features/events/updateFlow";
import { getGlobalHallItemCount as computeGlobalHallItemCount } from "./features/map/domain/hallOperations";
import { normalizeHydratedHallState } from "./features/map/domain/normalizeHydratedHallState";
import { useMapSelectors } from "./features/map/hooks/useMapSelectors";
import { useListInteractionState } from "./features/lists/hooks/useListInteractionState";
import AppHeaderShell from "./features/app-shell/components/AppHeaderShell";
import AppMainContent from "./features/app-shell/components/AppMainContent";
import AppOverlayLayer from "./features/app-shell/components/AppOverlayLayer";
import BackupRestoreDialog from "./components/BackupRestoreDialog";
import PersistenceStatusIndicator from "./components/PersistenceStatusIndicator";
import PersistenceRecoveryScreen from "./components/PersistenceRecoveryScreen";
import MapReimportConfirmationDialog from "./components/map/MapReimportConfirmationDialog";
import DuplicateEventDialog from "./components/DuplicateEventDialog";
import { appRuntime } from "./app/composition/appRuntime";
import { useEventLifecycleCommands } from "./app/commands/useEventLifecycleCommands";
import { useEventTransferCommands } from "./app/commands/useEventTransferCommands";
import { useEventUpdateCommands } from "./app/commands/useEventUpdateCommands";
import { useShoppingItemMutationCommands } from "./app/commands/useShoppingItemMutationCommands";
import { useShoppingSelectionExecutionCommands } from "./app/commands/useShoppingSelectionExecutionCommands";
import { useMapImportCommands } from "./app/commands/useMapImportCommands";
import { useMapVisitListCommands } from "./app/commands/useMapVisitListCommands";
import { useMapRouteCommands } from "./app/commands/useMapRouteCommands";
import { useMapEditorCommands } from "./app/commands/useMapEditorCommands";
import {
  selectBaseFilteredItems,
  selectBlockOptions,
  selectCandidateColumnItems,
  selectCurrentMaplessHalls,
  selectDuplicateCircleItemIds,
  selectExecuteColumnItems,
  selectMovePlanState,
  selectSearchMatches,
  selectSortDisplayLabel,
  selectTemporaryVisibleItems,
  selectVisibleItems,
  selectVisibleSearchMatches,
} from "./app/selectors/appListViewSelectors";
import {
  areFocusModeSessionStatesEqual,
  selectAppChromeVisibility,
  selectCurrentFocusSession,
  selectCurrentMode,
  selectHallExecuteCount,
  selectHallTotalItemCount,
  selectItemHallId,
  selectItemsInSameHallGroup,
  selectItemsInSameHallVisit,
  selectValidFocusSessionKeys,
} from "./app/selectors/appMapViewSelectors";
import { useAppNavigationController } from "./app/navigation";
import { selectNavigationReadModel } from "./app/navigation/navigationSelectors";
import { useAppUiState } from "./app/state/useAppUiState";
import { useAppOverlayController } from "./app/state/useAppOverlayController";
import { useCommittedState } from "./app/state/useCommittedState";
import { useMapWorkspaceState } from "./app/state/useMapWorkspaceState";
import { useThemeMode } from "./hooks/useThemeMode";
import {
  DEFAULT_UI_VISIBILITY,
  useDeferredUIVisibilitySettings,
  useUIVisibilitySettings,
} from "./hooks/useUIVisibilitySettings";
import { useNumberCellOutlineStyle } from "./hooks/useNumberCellOutlineStyle";
import { useDisablePriceUndefinedCheck } from "./hooks/useDisablePriceUndefinedCheck";
import { useDisableLimitedPurchaseQuantityCheck } from "./hooks/useDisableLimitedPurchaseQuantityCheck";
import {
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
  useSkipLimitedPurchaseForSingleQuantity,
} from "./hooks/useSkipLimitedPurchaseForSingleQuantity";
import { usePurchaseStatusControlMode } from "./hooks/usePurchaseStatusControlMode";
import { usePostEventDistributionCheck } from "./hooks/usePostEventDistributionCheck";
import { useIndexedDbPersistence } from "./hooks/useIndexedDbPersistence";
import type { ActiveTab, SortState } from "./features/app-shell/types";
import type { PersistenceSnapshot } from "./app/ports/PersistenceCommandPort";

const sortCycle: SortState[] = [
  "Manual",
  "Postpone",
  "Late",
  "Absent",
  "SoldOut",
  "None",
  "Purchased",
  "LimitedPurchase",
];
const sortLabels: Record<SortState, string> = {
  Manual: "巡回順",
  Postpone: "後回し",
  Late: "遅参",
  Absent: "欠席",
  SoldOut: "売切",
  None: "未購入",
  Purchased: "購入済",
  LimitedPurchase: "\u9650\u6570",
};

const App: React.FC = () => {
  const {
    value: eventLists,
    valueRef: eventListsRef,
    commit: commitEventLists,
    set: setEventLists,
  } = useCommittedState<Record<string, ShoppingItem[]>>({});
  const {
    value: eventMetadata,
    valueRef: eventMetadataRef,
    commit: commitEventMetadata,
    set: setEventMetadata,
  } = useCommittedState<Record<string, EventMetadata>>({});
  const {
    value: executeModeItems,
    valueRef: executeModeItemsRef,
    commit: commitExecuteModeItems,
    set: setExecuteModeItemsCommitted,
    update: updateExecuteModeItems,
  } = useCommittedState<Record<string, ExecuteModeItems>>({});
  const commitExecuteModeItemsForEvent = useCallback(
    (eventName: string, nextEventItems: ExecuteModeItems) => {
      commitExecuteModeItems({
        ...executeModeItemsRef.current,
        [eventName]: nextEventItems,
      });
    },
    [commitExecuteModeItems, executeModeItemsRef],
  );
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});

  const navigation = useAppNavigationController();
  const { activeEventName, activeTab, mapViewActive } =
    selectNavigationReadModel(navigation.state);
  const navigationCommands = navigation.commands;
  const navigateToTab = useCallback(
    (tab: ActiveTab) => {
      if (tab === "eventList") {
        navigationCommands.showEventList();
        return;
      }
      if (tab === "import") {
        navigationCommands.showImport(activeEventName);
        return;
      }
      if (navigation.state.kind === "event") {
        navigationCommands.changeDay(tab);
        return;
      }
      if (activeEventName) {
        navigationCommands.openEvent(activeEventName, tab);
      }
    },
    [activeEventName, navigation.state.kind, navigationCommands],
  );
  const {
    sortState,
    setSortState,
    blockSortDirection,
    setBlockSortDirection,
    itemToEdit,
    setItemToEdit,
    zoomLevel,
    setZoomLevel,
    recentlyChangedItemIds,
    setRecentlyChangedItemIds,
    newItemDefaults,
    setNewItemDefaults,
    searchKeyword,
    setSearchKeyword,
    currentSearchIndex,
    setCurrentSearchIndex,
    highlightedItemId,
    setHighlightedItemId,
    layoutMode,
    setLayoutMode,
    uiVisibilityOverride,
    setUiVisibilityOverride,
    focusModeMapVisible,
    setFocusModeMapVisible,
    focusModeSessions,
    setFocusModeSessions,
    showPostponeFilterButton,
    setShowPostponeFilterButton,
    showLateFilterButton,
    setShowLateFilterButton,
    candidateNumberSortDirection,
    setCandidateNumberSortDirection,
  } = useAppUiState();
  const overlayController = useAppOverlayController();
  const {
    readModel: {
      itemToDelete,
      pendingEventUpdate,
      pendingUpdateEventName,
      eventToRename,
      pendingDuplicateEvent,
      exportEventName,
      pendingBackup,
      pendingXlsxRestoreCompletion,
      mapImportPendingEventName,
      pendingMapReimport,
      cellSelectionMode,
      vertexSelectionMode,
      visitListPanelOpen,
      visitListPanelMapTab,
      visitListHasUnsavedChanges,
      visitListOriginalOrder,
      showVisitListConfirmDialog,
      pendingTabChange,
    },
    concurrentStatus,
    commands: overlayCommands,
  } = overlayController;
  const xlsxOperationActivity =
    concurrentStatus.xlsxOperation?.activity ?? null;
  const {
    mapTabMenuOpen,
    setMapTabMenuOpen,
    highlightedMapCell,
    setHighlightedMapCell,
    mapSelectedHallId,
    setMapSelectedHallId,
    mapIsRouteVisible,
    setMapIsRouteVisible,
    mapIsHallOrderOpen,
    setMapIsHallOrderOpen,
    mapHallSelectorOpen,
    setMapHallSelectorOpen,
    mapSmartInsertEnabled,
    setMapSmartInsertEnabled,
    mapSmartInsertMode,
    setMapSmartInsertMode,
    vertexGuideOptions,
    setVertexGuideOptions,
  } = useMapWorkspaceState(
    appRuntime.persistenceCommands,
    (message, tone = "success") => {
      overlayCommands.status.showSmartInsertToast(message, tone);
    },
  );
  const mapToggleLongPressRef = React.useRef<number | null>(null);
  const mapToggleLongPressFiredRef = React.useRef(false);
  const mapToggleButtonRef = React.useRef<HTMLButtonElement>(null);
  const mapToggleMenuRef = React.useRef<HTMLDivElement>(null);
  const {
    selectedItemIds,
    selectedBlockFilters,
    setSelectedBlockFilters,
    rangeStart,
    rangeEnd,
    spaceGroupingEnabled,
    setSpaceGroupingEnabled,
    collapsedSpaces,
    setCollapsedSpaces,
    executeSpaceGroupingEnabled,
    setExecuteSpaceGroupingEnabled,
    executeCollapsedSpaces,
    setExecuteCollapsedSpaces,
    clearSelection,
    clearRangeSelection,
    clearBlockFilters,
    toggleBlockFilter,
    toggleCollapsedSpace,
    toggleExecuteCollapsedSpace,
    selectItemForRange,
    selectSpaceGroupForRange,
    toggleRangeItemIdsSelection,
  } = useListInteractionState();

  const pendingEventUpdateBaseItemsRef = useRef<ShoppingItem[] | null>(null);
  const eventUpdatePreviewEpochRef = useRef(0);

  useEffect(
    () => () => {
      eventUpdatePreviewEpochRef.current += 1;
    },
    [],
  );

  const { uiVisibilitySettings, setUiVisibilitySettings } =
    useUIVisibilitySettings(appRuntime.persistenceCommands);
  const {
    draftSettings: draftUIVisibilitySettings,
    isPanelOpen: uiSettingsPanelOpen,
    setDraftSettings: setDraftUIVisibilitySettings,
    closePanel: closeUiSettingsPanel,
    togglePanel: toggleUiSettingsPanel,
    updateDraftConfig: updateUIVisibilityConfig,
  } = useDeferredUIVisibilitySettings({
    appliedSettings: uiVisibilitySettings,
    setAppliedSettings: setUiVisibilitySettings,
    setVisibilityOverride: setUiVisibilityOverride,
  });
  const {
    numberCellOutlineStyle,
    setNumberCellOutlineStyle,
    DEFAULT_OUTLINE_STYLE,
  } = useNumberCellOutlineStyle(appRuntime.persistenceCommands);
  const { disablePriceUndefinedCheck, setDisablePriceUndefinedCheck } =
    useDisablePriceUndefinedCheck(appRuntime.persistenceCommands);
  const {
    disableLimitedPurchaseQuantityCheck,
    setDisableLimitedPurchaseQuantityCheck,
  } = useDisableLimitedPurchaseQuantityCheck(appRuntime.persistenceCommands);
  const {
    purchaseStatusControlMode,
    setPurchaseStatusControlMode,
    DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  } = usePurchaseStatusControlMode(appRuntime.persistenceCommands);
  const {
    skipLimitedPurchaseForSingleQuantity,
    setSkipLimitedPurchaseForSingleQuantity,
  } = useSkipLimitedPurchaseForSingleQuantity(appRuntime.persistenceCommands);
  const {
    postEventDistributionCheckEnabled,
    setPostEventDistributionCheckEnabled,
  } = usePostEventDistributionCheck(appRuntime.persistenceCommands);
  const { themeMode, setThemeMode } = useThemeMode(
    appRuntime.persistenceCommands,
  );

  const [mapData, setMapData] = useState<MapDataStore>({});
  const [mapRotationSettings, setMapRotationSettings] =
    useState<MapRotationSettingsStore>({});
  const [mapViewportSettings, setMapViewportSettings] =
    useState<MapViewportSettingsStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>(
    {},
  );
  const [hallRouteSettings, setHallRouteSettings] =
    useState<HallRouteSettingsStore>({});
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);
  const {
    isInitialized,
    startupState,
    persistenceStatus,
    legacyCleanupStatus,
    isAdoptingRecoveryCandidate,
    recoveryAdoptionError,
    failedStores,
    failureDetails,
    retryInitialization,
    adoptRecoveryCandidate,
    retrySave,
    isUpdateBlocked,
    flushPendingSave,
    runExclusiveRestore,
  } = useIndexedDbPersistence({
    persistenceCommands: appRuntime.persistenceCommands,
    values: {
      eventLists,
      eventMetadata,
      executeModeItems,
      dayModes,
      mapData,
      mapRotationSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      mapViewportSettings,
    },
    setters: {
      setEventLists,
      setEventMetadata,
      setExecuteModeItems: setExecuteModeItemsCommitted,
      setDayModes,
      setMapData,
      setMapRotationSettings,
      setRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
      setMapViewportSettings,
    },
  });

  const commitApplicationSnapshotPatch = useCallback(
    async (
      patch: Partial<PersistenceSnapshot>,
      blockDetectionSettings?: {
        eventName: string;
        settings: import("./types/map").BlockDetectionSettings | null;
      },
    ): Promise<void> => {
      const nextSnapshot = {
        eventLists,
        eventMetadata,
        executeModeItems,
        dayModes,
        mapData,
        mapRotationSettings,
        routeSettings,
        hallDefinitions,
        hallRouteSettings,
        mapViewportSettings,
        ...patch,
      } as unknown as PersistenceSnapshot;
      await runExclusiveRestore(
        nextSnapshot as Parameters<typeof runExclusiveRestore>[0],
        () =>
          blockDetectionSettings
            ? appRuntime.persistenceCommands.restoreAppDataWithBlockDetectionSettings(
                nextSnapshot,
                blockDetectionSettings.eventName,
                blockDetectionSettings.settings,
              )
            : appRuntime.persistenceCommands.commitApplicationSnapshotAtomically(
                nextSnapshot,
              ),
      );
    },
    [
      dayModes,
      eventLists,
      eventMetadata,
      executeModeItems,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      mapRotationSettings,
      mapViewportSettings,
      routeSettings,
      runExclusiveRestore,
    ],
  );

  useEffect(
    () =>
      appRuntime.registerUpdateBlocker({
        id: "event-autosave",
        label: "イベントを保存中",
        isBlocking: isUpdateBlocked,
        flush: flushPendingSave,
      }),
    [flushPendingSave, isUpdateBlocked],
  );

  const hallDefinitionsMigratedRef = useRef(false);
  useEffect(() => {
    if (!isInitialized || hallDefinitionsMigratedRef.current) return;
    hallDefinitionsMigratedRef.current = true;
    const normalized = normalizeHydratedHallState({
      eventLists,
      hallDefinitions,
      hallRouteSettings,
    });
    if (normalized.hallDefinitions !== hallDefinitions) {
      setHallDefinitions(normalized.hallDefinitions);
    }
    if (normalized.hallRouteSettings !== hallRouteSettings) {
      setHallRouteSettings(normalized.hallRouteSettings);
    }
  }, [eventLists, hallDefinitions, hallRouteSettings, isInitialized]);

  const items = useMemo(
    () => (activeEventName ? eventLists[activeEventName] || [] : []),
    [activeEventName, eventLists],
  );
  const firstItemById = useMemo(() => {
    const index = new Map<string, ShoppingItem>();
    items.forEach((item) => {
      if (!index.has(item.id)) index.set(item.id, item);
    });
    return index;
  }, [items]);

  const eventDates = useMemo(() => extractEventDates(items), [items]);
  const activeEventDate = useMemo(
    () => (activeEventName && eventDates.includes(activeTab) ? activeTab : ""),
    [activeEventName, activeTab, eventDates],
  );
  const executeColumnItems = useMemo(
    () =>
      selectExecuteColumnItems({
        activeEventName,
        activeEventDate,
        executeModeItems,
        items,
      }),
    [activeEventDate, activeEventName, executeModeItems, items],
  );

  const {
    isMapTab,
    currentMapTabName,
    currentMapData,
    currentHalls,
    currentHallRouteSettings,
    getMapTabForDate,
    getHallsForDate,
    getMapDataForDate,
    getHallOrderForDate,
  } = useMapSelectors({
    activeEventName,
    activeTab,
    activeEventDate: activeEventDate || null,
    mapViewActive,
    mapData,
    hallDefinitions,
    hallRouteSettings,
  });

  const getHallExecuteCount = useCallback(
    (hallId: string): number =>
      selectHallExecuteCount({
        hallId,
        activeEventName,
        activeEventDate,
        isMapTab,
        currentMapData,
        currentHalls,
        items,
        executeModeItems,
      }),
    [
      activeEventDate,
      activeEventName,
      currentHalls,
      currentMapData,
      executeModeItems,
      isMapTab,
      items,
    ],
  );

  const getHallTotalItemCount = useCallback(
    (hallId: string): number =>
      selectHallTotalItemCount({
        hallId,
        activeEventName,
        activeEventDate,
        isMapTab,
        currentMapData,
        currentHalls,
        items,
        executeModeItems,
      }),
    [
      activeEventDate,
      activeEventName,
      currentHalls,
      currentMapData,
      executeModeItems,
      isMapTab,
      items,
    ],
  );

  const getItemHallId = useCallback(
    (item: ShoppingItem, eventDate: string): string | null =>
      selectItemHallId({
        item,
        halls: getHallsForDate(eventDate),
        mapData: getMapDataForDate(eventDate),
      }),
    [getHallsForDate, getMapDataForDate],
  );

  const areItemsInSameHall = useCallback(
    (firstItemId: string, secondItemId: string, eventDate: string): boolean =>
      selectItemsInSameHallVisit({
        firstItemId,
        secondItemId,
        items,
        halls: getHallsForDate(eventDate),
        mapData: getMapDataForDate(eventDate),
      }),
    [getHallsForDate, getMapDataForDate, items],
  );

  const areItemsInSameHallGroup = useCallback(
    (firstItemId: string, secondItemId: string, eventDate: string): boolean =>
      selectItemsInSameHallGroup({
        firstItemId,
        secondItemId,
        items,
        halls: getHallsForDate(eventDate),
        mapData: getMapDataForDate(eventDate),
      }),
    [getHallsForDate, getMapDataForDate, items],
  );

  const currentMode = useMemo(
    () =>
      selectCurrentMode({
        activeEventName,
        activeEventDate,
        dayModes,
      }),
    [activeEventDate, activeEventName, dayModes],
  );

  const {
    sessionKey: currentFocusSessionKey,
    resumeState: currentFocusResumeState,
    mapName: currentFocusMapName,
  } = useMemo(
    () =>
      selectCurrentFocusSession({
        activeEventName,
        activeEventDate,
        focusModeSessions,
      }),
    [activeEventDate, activeEventName, focusModeSessions],
  );

  const handleFocusSessionStateChange = useCallback(
    (state: FocusModeSessionState) => {
      if (!currentFocusSessionKey) return;
      setFocusModeSessions((previous) => {
        const existing = previous[currentFocusSessionKey];
        if (areFocusModeSessionStatesEqual(existing, state)) return previous;
        return {
          ...previous,
          [currentFocusSessionKey]: state,
        };
      });
    },
    [currentFocusSessionKey, setFocusModeSessions],
  );

  const validFocusSessionKeys = useMemo(
    () => selectValidFocusSessionKeys({ eventLists }),
    [eventLists],
  );

  useEffect(() => {
    setFocusModeSessions((previous) => {
      let changed = false;
      const next: Record<string, FocusModeSessionState> = {};
      Object.entries(previous).forEach(([key, value]) => {
        if (validFocusSessionKeys.has(key)) {
          next[key] = value;
        } else {
          changed = true;
        }
      });
      return changed ? next : previous;
    });
  }, [setFocusModeSessions, validFocusSessionKeys]);

  const {
    currentMapTabRotation: currentMapTabRotationState,
    currentFocusMapRotation: currentFocusMapRotationState,
    currentMapTabViewport,
    globalMapTabName: globalHallOrderMapTabName,
    globalHallRouteSettings: globalHallOrderRouteSettings,
    setRouteVisibility: handleSetMapRouteVisibility,
    updateMapTabRotation: handleMapTabRotationAngleChange,
    updateFocusMapRotation: handleFocusMapRotationAngleChange,
    updateMapViewport: handleMapViewportChange,
    updateCurrentHallRouteSettings: handleUpdateHallRouteSettings,
    updateGlobalHallRouteSettings: handleUpdateGlobalHallRouteSettings,
    reorderExecuteListByHallOrder: handleReorderExecuteListByHallOrder,
  } = useMapRouteCommands({
    state: {
      activeEventName,
      activeEventDate,
      isMapTab,
      currentMapTabName,
      currentFocusMapName,
      routeVisible: mapIsRouteVisible,
      mapRotationSettings,
      mapViewportSettings,
      mapData,
      hallDefinitions,
      hallRouteSettings,
      executeModeItems,
      items,
    },
    actions: {
      setRouteVisible: setMapIsRouteVisible,
      setMapRotationSettings,
      setMapViewportSettings,
      setHallRouteSettings,
      updateExecuteModeItems,
    },
    selectors: {
      getMapTabForDate,
    },
  });
  const { showHeaderBar, showTabBar, rawHideSomething } = useMemo(
    () =>
      selectAppChromeVisibility({
        activeEventName,
        currentMode,
        layoutMode,
        focusModeMapVisible,
        uiVisibilitySettings,
        uiVisibilityOverride,
        uiSettingsPanelOpen,
      }),
    [
      activeEventName,
      currentMode,
      focusModeMapVisible,
      layoutMode,
      uiSettingsPanelOpen,
      uiVisibilityOverride,
      uiVisibilitySettings,
    ],
  );

  const spaceGroupDragItemIdsRef = useRef<readonly string[] | null>(null);
  const {
    applyBulkAdd,
    handleBulkAdd,
    updateItem: handleUpdateItem,
    moveItem: handleMoveItem,
    moveItemUp: handleMoveItemUp,
    moveItemDown: handleMoveItemDown,
    moveToExecuteColumn: handleMoveToExecuteColumn,
    removeFromExecuteColumn: handleRemoveFromExecuteColumn,
    confirmDeleteItem: handleConfirmDelete,
    toggleBlockSort: handleBlockSortToggle,
    toggleCandidateBlockSort: handleBlockSortToggleCandidate,
    toggleCandidateNumberSort: handleCandidateNumberSort,
  } = useShoppingItemMutationCommands({
    state: {
      activeEventName,
      activeEventDate,
      eventLists,
      eventMetadata,
      dayModes,
      items,
      selectedItemIds,
      selectedBlockFilters,
      executeModeItemsRef,
      spaceGroupDragItemIdsRef,
      eventUpdatePreviewEpochRef,
      blockSortDirection,
      candidateNumberSortDirection,
      itemToDelete,
    },
    actions: {
      setEventLists,
      setEventMetadata,
      setDayModes,
      updateExecuteModeItems,
      setRecentlyChangedItemIds,
      openDuplicateEvent: overlayCommands.event.openDuplicate,
      clearRangeSelection,
      clearSelection,
      setSortState,
      setBlockSortDirection,
      setCandidateNumberSortDirection,
      confirmItemDelete: overlayCommands.item.confirm,
      navigation: navigationCommands,
    },
    selectors: {
      areItemsInSameHall,
      areItemsInSameHallGroup,
    },
    alerts: { notify: alert },
    persistence: { commitApplicationSnapshotPatch },
  });

  const scheduleCenteredItemScroll = useCallback((itemId: string) => {
    window.setTimeout(() => {
      document
        .querySelector(`[data-item-id="${itemId}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
  }, []);
  const {
    toggleMode: handleToggleMode,
    setViewMode: handleSetViewMode,
    selectItem: handleSelectItem,
    selectSpaceGroup: handleSelectSpaceGroupForRange,
    toggleItemsSelection: handleToggleRangeSelection,
    clearSelection: handleClearSelection,
    setSpaceGroupDragItemIds: handleSetSpaceGroupDragItemIds,
    changeBulkStatus: handleBulkStatusChange,
    updateExecuteItem: handleExecuteItemUpdate,
    activatePostponeFilter: handleActivatePostponeFilter,
    activateLateFilter: handleActivateLateFilter,
    setExecuteSpaceGroupOrder: handleExecuteSpaceGroupOrderChange,
    collapseAndOpenNext: handleCollapseAndOpenNext,
    sortSelectedItems: handleBulkSort,
  } = useShoppingSelectionExecutionCommands({
    state: {
      activeEventName,
      activeEventDate,
      currentMode,
      dayModes,
      sortState,
      executeColumnItems,
      recentlyChangedItemIds,
      spaceGroupDragItemIdsRef,
      items,
      selectedItemIds,
      executeModeItemsRef,
    },
    interaction: {
      clearSelection,
      clearRangeSelection,
      selectItemForRange,
      selectSpaceGroupForRange,
      toggleRangeItemIdsSelection,
    },
    actions: {
      setDayModes,
      setEventLists,
      setRecentlyChangedItemIds,
      setCandidateNumberSortDirection,
      setFocusModeMapVisible,
      closeUiSettingsPanel,
      setShowPostponeFilterButton,
      setShowLateFilterButton,
      setSortState,
      setBlockSortDirection,
      setExecuteCollapsedSpaces,
      updateExecuteModeItems,
      updateItem: handleUpdateItem,
    },
    effects: {
      notify: alert,
      scheduleCenteredItemScroll,
    },
  });

  const {
    selectEvent: handleSelectEvent,
    deleteEvent: handleDeleteEvent,
    requestRename: handleRenameEvent,
    confirmRename: handleConfirmRename,
  } = useEventLifecycleCommands({
    persistenceCommands: appRuntime.persistenceCommands,
    flushPendingSave,
    runExclusiveRestore,
    activeEventName,
    eventToRename,
    eventLists,
    eventMetadata,
    executeModeItems,
    dayModes,
    mapData,
    mapRotationSettings,
    routeSettings,
    hallDefinitions,
    hallRouteSettings,
    mapViewportSettings,
    navigation: navigationCommands,
    notify: alert,
    clearSelection,
    setSelectedBlockFilters,
    closeEventUpdateForEvent: (eventName) => {
      if (pendingEventUpdate?.eventName === eventName) {
        overlayCommands.event.close();
      }
    },
    setEventLists,
    setEventMetadata,
    updateExecuteModeItems,
    setDayModes,
    setMapData,
    setMapRotationSettings,
    setRouteSettings,
    setHallDefinitions,
    setHallRouteSettings,
    setMapViewportSettings,
    setFocusModeSessions,
    openRename: overlayCommands.event.openRename,
    confirmEventOverlay: overlayCommands.event.confirm,
  });

  const handleSortToggle = () => {
    clearSelection();
    setBlockSortDirection(null);
    setRecentlyChangedItemIds(new Set());
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleEditRequest = (item: ShoppingItem) => {
    overlayCommands.item.openEdit(item);
  };

  const handleDeleteRequest = useCallback(
    (item: ShoppingItem) => {
      overlayCommands.item.openDelete(item);
    },
    [overlayCommands.item],
  );

  const handleDeleteItemFromMap = useCallback(
    (itemId: string) => {
      const item = firstItemById.get(itemId);
      if (item) overlayCommands.item.openDelete(item);
    },
    [firstItemById, overlayCommands.item],
  );

  const handleClearNewItemDefaults = useCallback(() => {
    setNewItemDefaults(null);
  }, [setNewItemDefaults]);

  const handleModeChangeFromFocus = useCallback(
    (mode: "edit" | "execute", lastItemId?: string) =>
      handleSetViewMode(mode, lastItemId),
    [handleSetViewMode],
  );

  const handleDoneEditing = () => {
    if (itemToEdit?.eventDate) {
      setItemToEdit(null);
      if (activeEventName) {
        navigationCommands.openEvent(activeEventName, itemToEdit.eventDate);
      } else {
        navigationCommands.showEventList();
      }
    } else {
      setItemToEdit(null);
      alert("参加日がないため処理を停止しました。");
      navigationCommands.showEventList();
    }
  };

  const handleToggleBlockFilter = useCallback(
    (block: string) => {
      clearRangeSelection();
      toggleBlockFilter(block);
    },
    [clearRangeSelection, toggleBlockFilter],
  );
  const handleClearBlockFilters = useCallback(() => {
    clearRangeSelection();
    clearBlockFilters();
  }, [clearBlockFilters, clearRangeSelection]);

  const handleToggleSpaceCollapse = useCallback(
    (spaceKey: string) => {
      clearRangeSelection();
      toggleCollapsedSpace(spaceKey);
    },
    [clearRangeSelection, toggleCollapsedSpace],
  );

  const handleToggleAllSpaceCollapse = useCallback(
    (collapse: boolean) => {
      clearRangeSelection();
      if (!collapse) {
        setCollapsedSpaces(new Set());
      } else {
        const allGroupKeys = new Set<string>();
        items
          .filter((item) => item.eventDate === activeEventDate)
          .forEach((item) => {
            const spaceKey = getSpaceKey(item.block, item.number);
            const priority = item.priorityLevel || "none";
            const groupKey =
              priority !== "none" ? `${spaceKey}:${priority}` : spaceKey;
            allGroupKeys.add(groupKey);
          });
        setCollapsedSpaces(allGroupKeys);
      }
    },
    [activeEventDate, clearRangeSelection, items, setCollapsedSpaces],
  );

  const handleExecuteToggleSpaceCollapse = useCallback(
    (spaceKey: string) => {
      clearRangeSelection();
      toggleExecuteCollapsedSpace(spaceKey);
    },
    [clearRangeSelection, toggleExecuteCollapsedSpace],
  );

  const handleExecuteToggleAllSpaceCollapse = useCallback(
    (collapse: boolean) => {
      clearRangeSelection();
      if (!collapse) {
        setExecuteCollapsedSpaces(new Set());
      } else {
        if (!activeEventName) return;
        const currentEventDate = activeEventDate;
        const executeIds =
          executeModeItems[activeEventName]?.[currentEventDate] || [];
        const itemsMap = new Map(items.map((item) => [item.id, item]));
        const allGroupKeys = new Set<string>();
        executeIds.forEach((id) => {
          const item = itemsMap.get(id);
          if (!item) return;
          const spaceKey = getSpaceKey(item.block, item.number);
          const priority = item.priorityLevel || "none";
          const groupKey =
            priority !== "none" ? `${spaceKey}:${priority}` : spaceKey;
          allGroupKeys.add(groupKey);
        });
        setExecuteCollapsedSpaces(allGroupKeys);
      }
    },
    [
      activeEventDate,
      activeEventName,
      clearRangeSelection,
      executeModeItems,
      items,
      setExecuteCollapsedSpaces,
    ],
  );

  const {
    backupFileInputRef,
    cancelXlsxOperation,
    handleExportEvent,
    handleBackupExport,
    handlePersistenceRecoveryExport,
    handleBackupRestoreRequest,
    handleBackupFileImport,
    handleBackupRestore,
    handleConfirmExport,
    handleExportFileImport,
  } = useEventTransferCommands({
    appRuntime,
    eventLists,
    eventMetadata,
    executeModeItems,
    dayModes,
    mapData,
    mapRotationSettings,
    routeSettings,
    hallDefinitions,
    hallRouteSettings,
    mapViewportSettings,
    startupState,
    exportEventName,
    pendingBackup,
    pendingXlsxRestoreCompletion,
    navigationCommands,
    clearSelection,
    runExclusiveRestore,
    openExport: overlayCommands.event.openExport,
    confirmEventOverlay: overlayCommands.event.confirm,
    openBackupRestore: overlayCommands.backup.openRestore,
    confirmBackupRestore: overlayCommands.backup.confirm,
    startXlsxOperation: overlayCommands.status.startXlsxOperation,
    updateXlsxOperation: overlayCommands.status.updateXlsxOperation,
    clearXlsxOperation: overlayCommands.status.clearXlsxOperation,
    setEventLists,
    setEventMetadata,
    setExecuteModeItemsCommitted,
    setDayModes,
    setMapData,
    setMapRotationSettings,
    setRouteSettings,
    setHallDefinitions,
    setHallRouteSettings,
    setMapViewportSettings,
  });
  const commitEventUpdateState = useCallback(
    async (nextState: EventUpdateCommitState): Promise<boolean> => {
      try {
        await commitApplicationSnapshotPatch({
          eventLists: nextState.eventLists,
          eventMetadata: nextState.eventMetadata,
          executeModeItems: nextState.executeModeItems,
        });
      } catch {
        alert("イベントを保存できませんでした。表示内容は変更されていません。");
        return false;
      }
      commitEventLists(nextState.eventLists);
      commitEventMetadata(nextState.eventMetadata);
      commitExecuteModeItems(nextState.executeModeItems);
      return true;
    },
    [
      commitApplicationSnapshotPatch,
      commitEventLists,
      commitEventMetadata,
      commitExecuteModeItems,
    ],
  );
  const {
    handleUpdateEvent,
    handleDuplicateEventResolution,
    handleDuplicateEventCancel,
    handleCancelUpdate,
    handleConfirmUpdate,
    handleUrlUpdate,
  } = useEventUpdateCommands({
    state: {
      eventLists,
      eventMetadata,
      pendingDuplicateEvent,
      pendingEventUpdate,
      pendingUpdateEventName,
      eventListsRef,
      eventMetadataRef,
      executeModeItemsRef,
      pendingEventUpdateBaseItemsRef,
      eventUpdatePreviewEpochRef,
    },
    actions: {
      applyBulkAdd,
      commitEventUpdateState,
      openEventUpdate: overlayCommands.event.openUpdate,
      openUrlUpdate: overlayCommands.event.openUrlUpdate,
      closeEventOverlay: overlayCommands.event.close,
      confirmEventOverlay: overlayCommands.event.confirm,
    },
    effects: {
      notify: (message) => alert(message),
      reportError: (message) => console.error(message),
    },
  });

  const {
    requestFileSelection: handleImportMapData,
    selectFile: handleMapFileChange,
    prepareImport: handleMapImportConfirm,
    confirmReimport: handleMapReimportConfirm,
    cancelReimport: handleMapReimportCancel,
    closeImport: handleMapImportClose,
  } = useMapImportCommands({
    fileInput: mapFileInputRef,
    state: {
      eventLists,
      executeModeItems,
      mapData,
      mapRotationSettings,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      mapViewportSettings,
      pendingEventName: mapImportPendingEventName,
      pendingReimport: pendingMapReimport,
      mapViewActive,
    },
    actions: {
      setEventLists,
      setMapData,
      setMapRotationSettings,
      setRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
      setMapViewportSettings,
      openImport: overlayCommands.mapImport.open,
      requestReimport: overlayCommands.mapImport.requestReimport,
      closeImportDialog: overlayCommands.mapImport.closeDialog,
      cancelReimport: overlayCommands.mapImport.cancelReimport,
      confirmReimport: overlayCommands.mapImport.confirmReimport,
    },
    settings: {
      commitApplicationSnapshotPatch,
    },
    navigation: {
      openEvent: navigationCommands.openEvent,
    },
    effects: {
      notify: (message) => alert(message),
      reportDiagnostic: (message) => console.error(message),
    },
  });

  const {
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
  } = useMapEditorCommands({
    state: {
      activeEventName,
      activeEventDate,
      isMapTab,
      currentMapTabName,
      currentMapData: currentMapData ?? undefined,
      eventLists,
      items,
      executeModeItemsRef,
      mapData,
      hallDefinitions,
      hallRouteSettings,
      visitListPanelMapTab,
      cellSelectionMode,
      vertexSelectionMode,
    },
    actions: {
      setMapData,
      setHallDefinitions,
      setHallRouteSettings,
      setEventLists,
      updateExecuteModeItems,
      commitExecuteModeItemsForEvent,
      setNewItemDefaults,
      setItemToEdit,
      navigation: navigationCommands,
      startCellSelection: overlayCommands.mapEditor.startCellSelection,
      toggleCellSelection: overlayCommands.mapEditor.toggleCellSelection,
      finishCellSelection: (pending) =>
        overlayCommands.mapEditor.finishCellSelection(pending ?? null),
      startVertexSelection: overlayCommands.mapEditor.startVertexSelection,
      toggleVertexSelection: overlayCommands.mapEditor.toggleVertexSelection,
      finishVertexSelection: (pending) =>
        overlayCommands.mapEditor.finishVertexSelection(pending ?? null),
    },
    selectors: {
      getMapTabForDate,
      getItemHallId,
      areItemsInSameHallGroup,
    },
    effects: { selectionEventTarget: window },
    persistence: { commitApplicationSnapshotPatch },
  });

  const currentMapExecuteItemIds = useMemo(() => {
    if (!activeEventName || !isMapTab || !activeEventDate) return [];

    const dayName = activeEventDate;

    return executeModeItems[activeEventName]?.[dayName] || [];
  }, [activeEventName, activeEventDate, isMapTab, executeModeItems]);

  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter((item) => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

  React.useEffect(() => {
    if (mapTabMenuOpen !== "mapToggle") return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        mapToggleMenuRef.current &&
        !mapToggleMenuRef.current.contains(e.target as Node) &&
        mapToggleButtonRef.current &&
        !mapToggleButtonRef.current.contains(e.target as Node)
      ) {
        setMapTabMenuOpen(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [mapTabMenuOpen, setMapTabMenuOpen]);

  const smartInsertLongPressRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const smartInsertLongPressTriggeredRef = React.useRef(false);

  const {
    openPanel: openVisitListPanel,
    updateOrder: handleVisitListOrderUpdate,
    saveChanges: handleVisitListConfirm,
    discardChanges: handleVisitListCancel,
    requestClose: handleVisitListClose,
    requestTabChange: requestVisitListTabChange,
    confirmPendingTransition: handleVisitListDialogConfirm,
    discardPendingTransition: handleVisitListDialogCancel,
  } = useMapVisitListCommands({
    state: {
      activeEventName,
      activeEventDate,
      isMapTab,
      currentMapTabName,
      executeModeItems,
      panelOpen: visitListPanelOpen,
      panelMapTab: visitListPanelMapTab,
      hasUnsavedChanges: visitListHasUnsavedChanges,
      originalOrder: visitListOriginalOrder,
      confirmDialogOpen: showVisitListConfirmDialog,
      pendingTabChange,
    },
    actions: {
      updateExecuteModeItems,
      openPanel: overlayCommands.visitList.open,
      setUnsaved: overlayCommands.visitList.setUnsaved,
      requestConfirmClose: overlayCommands.visitList.requestConfirmClose,
      closePanel: overlayCommands.visitList.closePanel,
      confirmClose: overlayCommands.visitList.confirmClose,
      discardClose: overlayCommands.visitList.discardClose,
    },
    navigation: {
      navigateToTab,
    },
  });

  const handleHighlightMapCell = useCallback(
    (row: number, col: number) => {
      setHighlightedMapCell({ row, col });
    },
    [setHighlightedMapCell],
  );

  const handleClearMapCellHighlight = useCallback(() => {
    setHighlightedMapCell(null);
  }, [setHighlightedMapCell]);

  const visitListItems = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    const dayItemsById = new Map<string, ShoppingItem>();
    items.forEach((item) => {
      if (item.eventDate === dayName && !dayItemsById.has(item.id)) {
        dayItemsById.set(item.id, item);
      }
    });
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

    return executeIds.flatMap((id: string) => {
      const item = dayItemsById.get(id);
      return item ? [item] : [];
    });
  }, [visitListPanelMapTab, activeEventName, items, executeModeItems]);

  const visitListHallOrder = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const halls =
      hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const routeSettings =
      hallRouteSettings[activeEventName]?.[visitListPanelMapTab];

    if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
      return routeSettings.hallOrder;
    }

    return halls.map((h) => h.id);
  }, [
    visitListPanelMapTab,
    activeEventName,
    hallDefinitions,
    hallRouteSettings,
  ]);

  const mapTabDates = useMemo(
    () => eventDates.filter((date) => !!getMapTabForDate(date)),
    [eventDates, getMapTabForDate],
  );

  const hasUndefinedPriorityItems = useMemo((): boolean => {
    if (!activeEventName || !activeEventDate) return false;
    const ids = executeModeItems[activeEventName]?.[activeEventDate] || [];
    return ids.some((id) => {
      const it = firstItemById.get(id);
      if (!it) return false;
      const p = it.priorityLevel || "none";
      return p === "priority" || p === "highest";
    });
  }, [activeEventName, activeEventDate, executeModeItems, firstItemById]);

  const globalHallOrderHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName) return [];
    const hasMap = !!globalHallOrderMapTabName;
    const mapHalls = hasMap
      ? hallDefinitions[activeEventName]?.[globalHallOrderMapTabName] || []
      : [];
    const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;
    const maplessHalls = maplessKey
      ? hallDefinitions[activeEventName]?.[maplessKey] || []
      : [];
    return [...mapHalls, ...maplessHalls];
  }, [
    activeEventName,
    activeEventDate,
    globalHallOrderMapTabName,
    hallDefinitions,
  ]);

  const getGlobalHallItemCount = useCallback(
    (groupId: string): number => {
      if (!activeEventName || !activeEventDate) return 0;
      const executeIds =
        executeModeItems[activeEventName]?.[activeEventDate] || [];
      return computeGlobalHallItemCount({
        groupId,
        executeIds,
        items,
        getItemHallId,
      });
    },
    [activeEventName, activeEventDate, executeModeItems, items, getItemHallId],
  );

  const TabButton: React.FC<{
    tab: ActiveTab;
    label: string;
    count?: number;
    onClick?: () => void;
  }> = ({ tab, label, count, onClick }) => {
    const longPressTimeout = React.useRef<number | null>(null);

    const handlePointerDown = () => {
      if (!activeEventName) return;

      longPressTimeout.current = window.setTimeout(() => {
        if (eventDates.includes(tab)) {
          handleToggleMode();
        }
        longPressTimeout.current = null;
      }, 500);
    };

    const handlePointerUp = () => {
      if (longPressTimeout.current) {
        clearTimeout(longPressTimeout.current);
        longPressTimeout.current = null;
      }
    };

    const handleClick = () => {
      if (mapTabMenuOpen) {
        setMapTabMenuOpen(null);
      }
      if (onClick) {
        onClick();
      } else {
        setItemToEdit(null);
        clearSelection();
        setSelectedBlockFilters(new Set());
        setCandidateNumberSortDirection(null);
        setCollapsedSpaces(new Set());
        requestVisitListTabChange(tab);
      }
    };

    return (
      <button
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
          activeTab === tab
            ? "bg-blue-600 text-white"
            : "text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
        }`}
      >
        {label}{" "}
        {typeof count !== "undefined" && (
          <span className="text-xs bg-slate-200 dark:text-slate-700 rounded-full px-2 py-0.5 ml-1">
            {count}
          </span>
        )}
      </button>
    );
  };

  const baseFilteredItems = useMemo(
    () =>
      selectBaseFilteredItems({
        activeEventName,
        activeEventDate,
        currentTabItems,
        dayModes,
        executeColumnItems,
        sortState,
      }),
    [
      activeEventDate,
      activeEventName,
      currentTabItems,
      dayModes,
      executeColumnItems,
      sortState,
    ],
  );

  const temporaryVisibleItems = useMemo(
    () =>
      selectTemporaryVisibleItems({
        activeEventName,
        activeEventDate,
        dayModes,
        executeColumnItems,
        baseFilteredItems,
        recentlyChangedItemIds,
        sortState,
      }),
    [
      activeEventDate,
      activeEventName,
      baseFilteredItems,
      dayModes,
      executeColumnItems,
      recentlyChangedItemIds,
      sortState,
    ],
  );
  const temporaryVisibleCount = temporaryVisibleItems.length;

  const sortDisplayLabel = useMemo(
    () =>
      selectSortDisplayLabel({
        sortState,
        sortLabels,
        baseFilteredItems,
        temporaryVisibleCount,
      }),
    [baseFilteredItems, sortState, temporaryVisibleCount],
  );

  const { visibleItems } = useMemo(
    () =>
      selectVisibleItems({
        activeEventName,
        activeEventDate,
        currentTabItems,
        dayModes,
        executeColumnItems,
        baseFilteredItems,
        temporaryVisibleItems,
        sortState,
      }),
    [
      activeEventDate,
      activeEventName,
      baseFilteredItems,
      currentTabItems,
      dayModes,
      executeColumnItems,
      sortState,
      temporaryVisibleItems,
    ],
  );

  const searchMatches = useMemo(
    () =>
      selectSearchMatches({
        searchKeyword,
        activeEventName,
        activeTab,
        eventDates,
        currentTabItems,
      }),
    [activeEventName, activeTab, currentTabItems, eventDates, searchKeyword],
  );

  useEffect(() => {
    if (searchKeyword.trim()) {
      if (searchMatches.length > 0) {
        setCurrentSearchIndex(0);
      } else {
        setCurrentSearchIndex(-1);
        setHighlightedItemId(null);
      }
    } else {
      setCurrentSearchIndex(-1);
      setHighlightedItemId(null);
    }
  }, [
    searchKeyword,
    searchMatches,
    setCurrentSearchIndex,
    setHighlightedItemId,
  ]);

  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab, setCurrentSearchIndex, setHighlightedItemId]);

  const duplicateCircleItemIds = useMemo(
    () =>
      selectDuplicateCircleItemIds({
        activeEventName,
        activeTab,
        eventDates,
        currentTabItems,
      }),
    [activeEventName, activeTab, currentTabItems, eventDates],
  );

  const {
    availableBlocks,
    allBlocksForHallDefinition,
    blocksWithPriorityRemarks,
  } = useMemo(
    () =>
      selectBlockOptions({
        activeEventName,
        activeEventDate,
        executeModeItems,
        currentTabItems,
      }),
    [activeEventDate, activeEventName, currentTabItems, executeModeItems],
  );

  const currentMaplessHalls = useMemo(
    () =>
      selectCurrentMaplessHalls({
        activeEventName,
        activeEventDate,
        hallDefinitions,
      }),
    [activeEventDate, activeEventName, hallDefinitions],
  );

  const candidateColumnItems = useMemo(
    () =>
      selectCandidateColumnItems({
        activeEventName,
        activeEventDate,
        executeModeItems,
        currentTabItems,
        selectedBlockFilters,
        candidateNumberSortDirection,
      }),
    [
      activeEventDate,
      activeEventName,
      candidateNumberSortDirection,
      currentTabItems,
      executeModeItems,
      selectedBlockFilters,
    ],
  );

  const visibleSearchMatches = useMemo(
    () =>
      selectVisibleSearchMatches({
        searchMatches,
        activeEventName,
        activeEventDate,
        dayModes,
        visibleItems,
        executeColumnItems,
        candidateColumnItems,
      }),
    [
      activeEventDate,
      activeEventName,
      candidateColumnItems,
      dayModes,
      executeColumnItems,
      searchMatches,
      visibleItems,
    ],
  );

  const handleSearchNext = useCallback(() => {
    if (!searchKeyword.trim() || visibleSearchMatches.length === 0) {
      if (searchMatches.length > 0 && visibleSearchMatches.length === 0) {
        alert("現在の絞り込み条件では一致する項目がありません。");
      }
      return;
    }

    const startIndex = currentSearchIndex === -1 ? -1 : currentSearchIndex;
    const nextIndex = (startIndex + 1) % visibleSearchMatches.length;
    setCurrentSearchIndex(nextIndex);

    const nextItemId = visibleSearchMatches[nextIndex];
    setHighlightedItemId(nextItemId);

    setTimeout(() => {
      const element = document.querySelector(`[data-item-id="${nextItemId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  }, [
    searchKeyword,
    visibleSearchMatches,
    currentSearchIndex,
    setCurrentSearchIndex,
    setHighlightedItemId,
    searchMatches.length,
  ]);

  const {
    candidateMovePlan,
    executeMovePlan,
    hasCandidateSelection,
    hasExecuteSelection,
    showMoveButtons,
  } = useMemo(
    () =>
      selectMovePlanState({
        activeEventName,
        activeEventDate,
        currentMode,
        executeModeItems,
        items,
        selectedItemIds,
      }),
    [
      activeEventDate,
      activeEventName,
      currentMode,
      executeModeItems,
      items,
      selectedItemIds,
    ],
  );

  if (!isInitialized) {
    if (startupState.status === "recovery-required") {
      return (
        <PersistenceRecoveryScreen
          message={startupState.message}
          details={startupState.details}
          canExport={(startupState.recoveryBundle?.candidates.length ?? 0) > 0}
          isRetrying={startupState.isRetrying}
          candidates={startupState.recoveryBundle?.candidates ?? []}
          isAdopting={isAdoptingRecoveryCandidate}
          adoptionError={recoveryAdoptionError}
          onRetry={retryInitialization}
          onExport={handlePersistenceRecoveryExport}
          onAdopt={adoptRecoveryCandidate}
        />
      );
    }

    return (
      <main
        className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-slate-800 dark:bg-slate-900 dark:text-slate-100"
        aria-live="polite"
      >
        <p className="text-sm font-medium">保存データを確認しています…</p>
      </main>
    );
  }

  const mainContentVisible = eventDates.includes(activeTab);

  const handleZoomChange = (newZoom: number) => {
    setZoomLevel(Math.max(15, Math.min(150, newZoom)));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200 font-sans">
      <AppHeaderShell
        model={{
          navigation: {
            activeEventDate,
            activeEventName,
            activeTab,
            currentMode,
            eventDates,
            isMapTab,
          },
          map: {
            currentHalls,
            currentMapData,
            currentMapTabName,
            currentMapTabRotationState,
            globalHallOrderHalls,
            globalHallOrderMapTabName,
            hasUndefinedPriorityItems,
            mapHallSelectorOpen,
            mapIsRouteVisible,
            mapSelectedHallId,
            mapSmartInsertEnabled,
            mapSmartInsertMode,
            mapTabMenuOpen,
            mapToggleButtonRef,
            mapToggleLongPressFiredRef,
            mapToggleLongPressRef,
            mapToggleMenuRef,
            mapViewActive,
            smartInsertLongPressRef,
            smartInsertLongPressTriggeredRef,
          },
          list: {
            blockSortDirection,
            candidateMovePlan,
            currentSearchIndex,
            executeMovePlan,
            executeSpaceGroupingEnabled,
            hasCandidateSelection,
            hasExecuteSelection,
            items,
            searchKeyword,
            selectedItemIds,
            showMoveButtons,
            sortDisplayLabel,
            visibleSearchMatches,
          },
          preferences: {
            DEFAULT_OUTLINE_STYLE,
            DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
            DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
            DEFAULT_UI_VISIBILITY,
            disableLimitedPurchaseQuantityCheck,
            disablePriceUndefinedCheck,
            numberCellOutlineStyle,
            postEventDistributionCheckEnabled,
            purchaseStatusControlMode,
            skipLimitedPurchaseForSingleQuantity,
            themeMode,
            uiVisibilitySettings: draftUIVisibilitySettings,
            zoomLevel,
          },
          ui: {
            layoutMode,
            mainContentVisible,
            showHeaderBar,
            showTabBar,
            TabButton,
            uiSettingsPanelOpen,
          },
        }}
        actions={{
          navigation: {
            getMapTabForDate,
            handleSetViewMode,
            onShowEventList: navigationCommands.showEventList,
            onShowImport: navigationCommands.showImport,
            onToggleEventSurface: navigationCommands.toggleEventSurface,
          },
          map: {
            getHallExecuteCount,
            getHallTotalItemCount,
            handleMapTabRotationAngleChange,
            openVisitListPanel,
            setBlockDefinitionMode: (open) => {
              if (open) overlayCommands.mapEditor.openBlockDefinition(null);
            },
            setGlobalHallOrderPanelOpen: (open) => {
              if (open) overlayCommands.mapEditor.openGlobalHallOrder();
            },
            setHallDefinitionMode: (open) => {
              if (open) overlayCommands.mapEditor.openHallDefinition(null);
            },
            setMapHallSelectorOpen,
            setMapIsHallOrderOpen,
            setMapIsRouteVisible: handleSetMapRouteVisibility,
            setMapSelectedHallId,
            setMapSmartInsertEnabled,
            setMapSmartInsertMode,
            setMapTabMenuOpen,
            setSimpleHallDefinitionMode: (open) => {
              if (open) overlayCommands.mapEditor.openSimpleHallDefinition();
            },
            showSmartInsertToast: (message, tone = "success") => {
              overlayCommands.status.showSmartInsertToast(message, tone);
            },
          },
          list: {
            handleBlockSortToggle,
            handleBlockSortToggleCandidate,
            handleBulkSort,
            handleClearRangeSelection: clearRangeSelection,
            handleClearSelection,
            handleMoveToExecuteColumn,
            handleRemoveFromExecuteColumn,
            handleSearchNext,
            handleSortToggle,
            setExecuteCollapsedSpaces,
            setExecuteSpaceGroupingEnabled,
            setItemToEdit,
            setSearchKeyword,
            setSelectedBlockFilters,
          },
          preferences: {
            handleZoomChange,
            setDisableLimitedPurchaseQuantityCheck,
            setDisablePriceUndefinedCheck,
            setNumberCellOutlineStyle,
            setPostEventDistributionCheckEnabled,
            setPurchaseStatusControlMode,
            setSkipLimitedPurchaseForSingleQuantity,
            setThemeMode,
            setUiVisibilitySettings: setDraftUIVisibilitySettings,
            updateUIVisibilityConfig,
          },
          ui: {
            onCloseUiSettingsPanel: closeUiSettingsPanel,
            onToggleUiSettingsPanel: toggleUiSettingsPanel,
            setLayoutMode,
          },
        }}
      />

      {rawHideSomething &&
        activeEventName &&
        (currentMode === "focus" || currentMode === "execute") && (
          <button
            onClick={() => {
              closeUiSettingsPanel({ resetVisibilityOverride: false });
              setUiVisibilityOverride((prev) => !prev);
            }}
            className={`fixed z-[110] flex h-10 w-10 touch-manipulation select-none items-center justify-center rounded-full shadow-lg transition-all [-webkit-tap-highlight-color:transparent] ${
              layoutMode === "smartphone" &&
              currentMode === "focus" &&
              focusModeMapVisible
                ? "left-3 top-[4.25rem]"
                : "left-3 top-3"
            } ${
              uiVisibilityOverride
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-white/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600 backdrop-blur-sm border border-slate-200 dark:border-slate-600"
            }`}
            title={
              uiVisibilityOverride ? "自動表示に戻す" : "画面要素をすべて表示"
            }
            aria-label={
              uiVisibilityOverride ? "自動表示に戻す" : "画面要素をすべて表示"
            }
            type="button"
          >
            {uiVisibilityOverride ? (
              <svg
                className="w-5 h-5 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                />
              </svg>
            ) : (
              <svg
                className="w-5 h-5 pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                />
              </svg>
            )}
          </button>
        )}

      <AppMainContent
        model={{
          navigation: {
            activeEventDate,
            activeEventName,
            activeTab,
            currentMode,
            eventDates,
            isMapTab,
            mainContentVisible,
          },
          events: {
            eventLists,
            exportFileInputRef,
          },
          list: {
            availableBlocks,
            blocksWithPriorityRemarks,
            candidateColumnItems,
            candidateNumberSortDirection,
            collapsedSpaces,
            duplicateCircleItemIds,
            executeCollapsedSpaces,
            executeColumnItems,
            executeModeItems,
            executeSpaceGroupingEnabled,
            items,
            itemToEdit,
            newItemDefaults,
            rangeEnd,
            rangeStart,
            selectedBlockFilters,
            selectedItemIds,
            showLateFilterButton,
            showPostponeFilterButton,
            spaceGroupingEnabled,
            visibleItems,
          },
          map: {
            cellSelectionMode,
            currentHallRouteSettings,
            currentHalls,
            currentMapData,
            currentMapExecuteItemIds,
            currentMapTabName,
            currentMapTabRotationState,
            currentMapTabViewport,
            getHallOrderForDate,
            getHallsForDate,
            getMapDataForDate,
            hallDefinitions,
            hallRouteSettings,
            highlightedItemId,
            highlightedMapCell,
            mapData,
            mapIsHallOrderOpen,
            mapIsRouteVisible,
            mapSelectedHallId,
            mapSmartInsertEnabled,
            mapSmartInsertMode,
            vertexGuideOptions,
            vertexSelectionMode,
            visitListPanelOpen,
          },
          focus: {
            currentFocusMapRotationState,
            currentFocusResumeState,
            currentFocusSessionKey,
          },
          ui: {
            disableLimitedPurchaseQuantityCheck,
            disablePriceUndefinedCheck,
            layoutMode,
            numberCellOutlineStyle,
            postEventDistributionCheckEnabled,
            purchaseStatusControlMode,
            skipLimitedPurchaseForSingleQuantity,
            zoomLevel,
          },
        }}
        actions={{
          events: {
            handleBackupExport,
            handleBackupRestoreRequest,
            handleBulkAdd,
            handleDeleteEvent,
            handleExportEvent,
            handleImportMapData,
            handleRenameEvent,
            handleSelectEvent,
            handleUpdateEvent,
          },
          list: {
            handleActivateLateFilter,
            handleActivatePostponeFilter,
            handleBulkStatusChange,
            handleCandidateNumberSort,
            handleClearBlockFilters,
            handleClearNewItemDefaults,
            handleClearRangeSelection: clearRangeSelection,
            handleCollapseAndOpenNext,
            handleDeleteRequest,
            handleDoneEditing,
            handleEditRequest,
            handleExecuteItemUpdate,
            handleExecuteSpaceGroupOrderChange,
            handleExecuteToggleAllSpaceCollapse,
            handleExecuteToggleSpaceCollapse,
            handleMoveItem,
            handleMoveItemDown,
            handleMoveItemUp,
            handleMoveToExecuteColumn,
            handleRemoveFromExecuteColumn,
            handleSelectItem,
            handleSelectSpaceGroupForRange,
            handleSetSpaceGroupDragItemIds,
            handleToggleAllSpaceCollapse,
            handleToggleBlockFilter,
            handleToggleRangeSelection,
            handleToggleSpaceCollapse,
            handleUpdateItem,
            setCollapsedSpaces,
            setSpaceGroupingEnabled,
          },
          map: {
            handleAddNewItemFromMap,
            handleAddToExecuteListFromMap,
            handleAddToExecuteListFromMapAtPosition,
            handleBatchAddToExecuteListFromMap,
            handleBatchAddToExecuteListFromMapAtPosition,
            handleBatchRemoveFromExecuteListFromMap,
            handleDeleteItemFromMap,
            handleMapTabRotationAngleChange,
            handleMapViewportChange,
            handleMoveToFirstFromMap,
            handleMoveToLastFromMap,
            handleRemoveFromExecuteListFromMap,
            handleReorderExecuteListByHallOrder,
            handleUpdateHallRouteSettings,
            handleUpdateItemPriorityFromEdit,
            setMapIsHallOrderOpen,
            setMapIsRouteVisible: handleSetMapRouteVisibility,
            setMapSelectedHallId,
          },
          focus: {
            handleAddItemFromFocusMode,
            handleFocusMapRotationAngleChange,
            handleFocusSessionStateChange,
            handleModeChangeFromFocus,
            setFocusModeMapVisible,
          },
          ui: {
            setLayoutMode,
          },
        }}
      />

      <AppOverlayLayer
        overlay={overlayController.readModel}
        overlayCommands={overlayCommands}
        model={{
          item: {
            items,
          },
          event: {
            activeEventDate,
            activeEventName,
            eventDates,
            eventMetadata,
          },
          mapEditor: {
            allBlocksForHallDefinition,
            currentHalls,
            currentMapData,
            currentMaplessHalls,
            getGlobalHallItemCount,
            getHallsForDate,
            globalHallOrderHalls,
            globalHallOrderRouteSettings,
            mapData,
            mapTabDates,
            vertexGuideOptions,
          },
          visitList: {
            layoutMode,
            visitListHallOrder,
            visitListItems,
          },
          imports: {
            exportFileInputRef,
            mapFileInputRef,
            mapImportSavedSettings: mapImportPendingEventName
              ? appRuntime.persistenceCommands.readBlockDetectionSettings(
                  mapImportPendingEventName,
                )
              : null,
          },
          list: {
            candidateMovePlan,
            currentMode,
            executeMovePlan,
            hasCandidateSelection,
            hasExecuteSelection,
            mainContentVisible,
            selectedItemIds,
            showHeaderBar,
            showMoveButtons,
            sortDisplayLabel,
            visibleItems,
          },
        }}
        actions={{
          item: {
            handleCancelUpdate,
            handleConfirmDelete,
            handleConfirmUpdate,
            handleUpdateHallOrderForPriorityChangeFromEdit,
            handleUpdateItem,
          },
          event: {
            handleConfirmExport,
            handleConfirmRename,
            handleUrlUpdate,
            onShowEventList: navigationCommands.showEventList,
          },
          mapEditor: {
            handleCancelCellSelection,
            handleCancelVertexSelection,
            handleConfirmCellSelection,
            handleConfirmVertexSelection,
            handleReorderExecuteListByHallOrder,
            handleStartCellSelection,
            handleStartVertexSelection,
            handleSyncMaplessHallsToOtherDates,
            handleSyncPolygonHallsToOtherDates,
            handleUpdateBlocks,
            handleUpdateGlobalHallRouteSettings,
            handleUpdateHalls,
            handleUpdateMaplessHalls,
            setVertexGuideOptions,
          },
          visitList: {
            handleClearMapCellHighlight,
            handleHighlightMapCell,
            handleUpdateItemPriority,
            handleVisitListCancel,
            handleVisitListClose,
            handleVisitListConfirm,
            handleVisitListDialogCancel,
            handleVisitListDialogConfirm,
            handleVisitListOrderUpdate,
          },
          imports: {
            handleExportFileImport,
            handleMapFileChange,
            handleMapImportClose,
            handleMapImportConfirm,
            xlsxExecutionPort: appRuntime.xlsxCommands,
          },
          list: {
            handleBulkSort,
            handleClearSelection,
            handleMoveToExecuteColumn,
            handleRemoveFromExecuteColumn,
            handleSortToggle,
          },
        }}
      />
      <input
        ref={backupFileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleBackupFileImport}
        aria-label="バックアップファイルを選択"
      />
      {xlsxOperationActivity && (
        <section
          aria-label="Excel処理状況"
          className="fixed bottom-4 right-4 z-50 rounded-lg border border-slate-300 bg-white p-3 shadow-lg dark:border-slate-600 dark:bg-slate-800"
          data-xlsx-operation={xlsxOperationActivity.kind}
          data-xlsx-cancel-requested={
            xlsxOperationActivity.cancelRequested ? "true" : "false"
          }
        >
          <p role="status" aria-live="polite" className="text-sm">
            {xlsxOperationActivity.cancelRequested
              ? "Excel処理を取り消しています…"
              : xlsxOperationActivity.progress
                ? `Excel処理中: ${xlsxOperationActivity.progress.phase} ${xlsxOperationActivity.progress.completed}/${xlsxOperationActivity.progress.total}`
                : "Excel処理を開始しています…"}
          </p>
          <button
            type="button"
            className="mt-2 rounded bg-red-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={xlsxOperationActivity.cancelRequested}
            onClick={cancelXlsxOperation}
          >
            Excel処理を取り消す
          </button>
        </section>
      )}
      <BackupRestoreDialog
        isOpen={pendingBackup !== null}
        backupEventNames={
          pendingBackup ? Object.keys(pendingBackup.data.eventLists).sort() : []
        }
        currentEventNames={Object.keys(eventLists)}
        onClose={overlayCommands.backup.close}
        onRestore={handleBackupRestore}
      />
      <MapReimportConfirmationDialog
        isOpen={pendingMapReimport !== null}
        plan={pendingMapReimport?.plan ?? null}
        onCancel={handleMapReimportCancel}
        onConfirm={handleMapReimportConfirm}
      />
      {pendingDuplicateEvent && (
        <DuplicateEventDialog
          analysis={pendingDuplicateEvent.analysis}
          existingEventNames={Object.keys(eventLists)}
          onResolve={(resolution) => {
            void handleDuplicateEventResolution(resolution);
          }}
          onCancel={handleDuplicateEventCancel}
        />
      )}
      <PersistenceStatusIndicator
        status={persistenceStatus}
        legacyCleanupStatus={legacyCleanupStatus}
        showRoutineStatus={uiVisibilitySettings.showPersistenceStatus}
        failedStores={failedStores}
        failureDetails={failureDetails}
        onRetry={retrySave}
        onExportBackup={handleBackupExport}
      />
    </div>
  );
};

export default App;
