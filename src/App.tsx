import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  ShoppingItem,
  PurchaseStatus,
  EventMetadata,
  ViewMode,
  DayModeState,
  ExecuteModeItems,
} from "./types/item";
import {
  MapDataStore,
  RouteSettingsStore,
  BlockDefinition,
  HallDefinition,
  HallRouteSettings,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  DayMapData,
  BlockDetectionSettings,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  MapViewportState,
} from "./types/map";
import { ExportOptions } from "./types/export";
import { FocusModeSessionState } from "./types/focus";
import { MAPLESS_HALL_KEY, getMaplessKey } from "./types/map";
import {
  resolveHallByBlockName,
  resolveManualHallId,
  findHallsByBlockName,
} from "./utils/hallFallback";
import { buildMergedHallRouteSettings } from "./utils/mergedHallRouteSettings";
import {
  BlockDetectionSettingsRollbackError,
  isPointInPolygon,
  readBlockDetectionSettingsStoreForBackup,
  removeBlockDetectionSettingsForEvent,
  renameBlockDetectionSettingsForEvent,
  runWithBlockDetectionSettingsRestore,
  saveBlockDetectionSettings,
} from "./components/map";
import { extractEventDates } from "./utils/eventDates";
import { getSpaceKey } from "./utils/spaceGrouping";
import {
  importFromXlsx,
  downloadBlob,
  type ItemFallbackWarning,
} from "./utils/exportImport";
import {
  buildBulkAddUiPlan,
  buildBulkAddEventMetadata,
  buildBulkAddItems,
  buildInitialDayModesForBulkAdd,
  buildInitialExecuteItemsForBulkAdd,
  buildLayoutAppliedEventItems,
  hasBulkAddLayoutInfo,
  type BulkAddMetadata,
} from "./features/events/bulkAdd";
import { type EventUpdateApplyOptions } from "./features/events/updateApply";
import {
  applyPendingEventUpdate,
  buildEventUpdateDiffFromSpreadsheet,
  resolveSpreadsheetSource,
  type PendingEventUpdate,
  type SpreadsheetSource,
} from "./features/events/updateFlow";
import {
  buildEventExportFile,
  hasExportableItems,
} from "./features/events/exportFlow";
import { toImportedEventData } from "./features/events/fileImport";
import {
  removeRecordKey,
  renameRecordKey,
  upsertRecordKey,
} from "./features/events/recordOps";
import {
  computeUpdateItem,
  computeDeleteItem,
  computeAddItemFromFocusMode,
  computeAddToExecuteListFromMapWithResult,
  computeRemoveFromExecuteListFromMapWithResult,
  computeMoveToExecuteColumn,
  computeRemoveFromExecuteColumn,
  computeMoveItem,
  computeMoveItemVertical,
  computeUpdateItemPriority,
  computeHallOrderForPriorityChange,
  computeInsertIntoExecuteAtPosition,
  reorderExecuteIdsForSpaceAdjacency,
} from "./features/events/itemOps";
import {
  buildImportCompletionMessage,
  buildLegacySheetFieldFallbackMessage,
  resolveEventListTab,
} from "./features/events/uiOrchestration";
import {
  cloneHallsForDates,
  emptyHallRouteSettings,
  getCombinedHallRouteSettingsForDate,
  getGlobalHallItemCount as computeGlobalHallItemCount,
  remapHallRouteSettings,
  reorderExecuteIdsByHallOrder,
  splitGlobalHallRouteSettings,
  splitHallsForStorage,
  updateHallDefinitionsForHalls,
  updateHallRouteSettingsForHalls,
  updateMaplessHallDefinitions,
  updateMaplessHallRouteSettings,
} from "./features/map/domain/hallOperations";
import { useMapSelectors } from "./features/map/hooks/useMapSelectors";
import { useListInteractionState } from "./features/lists/hooks/useListInteractionState";
import type { RangePresentation } from "./features/lists/domain/rangeSelection";
import {
  buildMovePlan,
  getCandidateSourceOrderedIds,
} from "./features/lists/domain/movePlan";
import AppHeaderShell from "./features/app-shell/components/AppHeaderShell";
import AppMainContent from "./features/app-shell/components/AppMainContent";
import AppOverlayLayer from "./features/app-shell/components/AppOverlayLayer";
import BackupRestoreDialog from "./components/BackupRestoreDialog";
import PersistenceStatusIndicator from "./components/PersistenceStatusIndicator";
import MapReimportConfirmationDialog from "./components/map/MapReimportConfirmationDialog";
import DuplicateEventDialog from "./components/DuplicateEventDialog";
import { buildEventRestoreData } from "./features/events/backupRestore";
import {
  analyzeDuplicateEventImport,
  type DifferentSourceEventAnalysis,
  type DuplicateEventResolution,
  type SameSourceEventAnalysis,
} from "./features/events/duplicateEvent";
import { settleEventUpdatePreviewIfCurrent } from "./features/events/sourceSwitchPreview";
import {
  buildMapReimportPlan,
  type MapReimportOptions,
} from "./features/map/domain/mapReimport";
import {
  cancelPendingMapImport,
  commitPreparedMapImport as commitPreparedMapImportFlow,
  dispatchPreparedMapImport,
  type PreparedMapImport,
} from "./features/map/domain/mapImportFlow";
import {
  createAppBackup,
  parseAppBackup,
  serializeAppBackup,
  type AppBackupV1,
} from "./utils/appBackup";
import { db, type AppData } from "./utils/indexedDB";
import { useThemeMode } from "./hooks/useThemeMode";
import {
  DEFAULT_UI_VISIBILITY,
  useDeferredUIVisibilitySettings,
  useUIVisibilitySettings,
  type UIVisibilitySettings,
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
import {
  useIndexedDbPersistence,
  type PersistedStateValues,
} from "./hooks/useIndexedDbPersistence";
import type { SmartInsertMode, SortState } from "./features/app-shell/types";
import { normalizeSmartInsertMode } from "./utils/smartInsertMode";
import {
  clearLimitedPurchase,
  getLimitedPurchaseCounts,
  matchesPurchaseStatusFilter,
} from "./utils/purchaseQuantity";

type ActiveTab = "eventList" | "import" | string;
export type BulkSortDirection = "asc" | "desc";
type BlockSortDirection = "asc" | "desc";

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

const buildFocusSessionKey = (eventName: string, eventDate: string): string =>
  `${eventName}::${eventDate}`;

const removeFocusModeSessionByEvent = (
  sessions: Record<string, FocusModeSessionState>,
  eventName: string,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (key.startsWith(`${eventName}::`)) {
      changed = true;
      return;
    }
    next[key] = value;
  });

  return changed ? next : sessions;
};

const renameFocusModeSessionKeys = (
  sessions: Record<string, FocusModeSessionState>,
  oldEventName: string,
  newEventName: string,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (key.startsWith(`${oldEventName}::`)) {
      const suffix = key.slice(oldEventName.length);
      next[`${newEventName}${suffix}`] = value;
      changed = true;
    } else {
      next[key] = value;
    }
  });

  return changed ? next : sessions;
};

const areStringArraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
};

const isFocusModeSessionStateEqual = (
  a: FocusModeSessionState | undefined,
  b: FocusModeSessionState,
): boolean => {
  if (!a) return false;
  if (
    a.phase !== b.phase ||
    a.phaseIndex !== b.phaseIndex ||
    a.isCompleted !== b.isCompleted ||
    a.savedPhaseIndices.normal !== b.savedPhaseIndices.normal ||
    a.savedPhaseIndices.postponed !== b.savedPhaseIndices.postponed ||
    a.savedPhaseIndices.late !== b.savedPhaseIndices.late ||
    !areStringArraysEqual(a.postponedItemIds, b.postponedItemIds) ||
    !areStringArraysEqual(a.lateItemIds, b.lateItemIds)
  ) {
    return false;
  }

  const lpcA = a.lastPurchaseChangeAt ?? null;
  const lpcB = b.lastPurchaseChangeAt ?? null;
  if ((lpcA === null) !== (lpcB === null)) return false;
  if (
    lpcA &&
    lpcB &&
    (lpcA.phase !== lpcB.phase ||
      lpcA.phaseIndex !== lpcB.phaseIndex ||
      lpcA.visitKey !== lpcB.visitKey)
  ) {
    return false;
  }

  return true;
};

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const toHalfWidthDigits = (value: string): string =>
  value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );

const normalizeMapDayToken = (value: string): string =>
  toHalfWidthDigits(value)
    .replace(/[ \u3000]/g, "")
    .replace(/マップ$/, "");

type RotationScreenType = "mapTab" | "focusMode";

type PendingDuplicateEventImport = {
  analysis: SameSourceEventAnalysis | DifferentSourceEventAnalysis;
  metadata?: BulkAddMetadata;
};

const resolveDayMapRotationState = (
  state:
    | { initialAngle?: number; mapTabAngle?: number; focusModeAngle?: number }
    | undefined,
) => {
  const initialAngle = normalizeRotationAngle(state?.initialAngle ?? 0);
  return {
    initialAngle,
    mapTabAngle: normalizeRotationAngle(state?.mapTabAngle ?? initialAngle),
    focusModeAngle: normalizeRotationAngle(
      state?.focusModeAngle ?? initialAngle,
    ),
  };
};

const App: React.FC = () => {
  const [eventLists, setEventListsState] = useState<
    Record<string, ShoppingItem[]>
  >({});
  const eventListsRef = useRef<Record<string, ShoppingItem[]>>({});
  const commitEventLists = useCallback(
    (nextAllEvents: Record<string, ShoppingItem[]>) => {
      eventListsRef.current = nextAllEvents;
      setEventListsState(nextAllEvents);
    },
    [],
  );
  const setEventLists = useCallback(
    (next: React.SetStateAction<Record<string, ShoppingItem[]>>) => {
      const nextAllEvents =
        typeof next === "function"
          ? (
              next as (
                current: Record<string, ShoppingItem[]>,
              ) => Record<string, ShoppingItem[]>
            )(eventListsRef.current)
          : next;
      commitEventLists(nextAllEvents);
    },
    [commitEventLists],
  );
  const [eventMetadata, setEventMetadataState] = useState<
    Record<string, EventMetadata>
  >({});
  const eventMetadataRef = useRef<Record<string, EventMetadata>>({});
  const commitEventMetadata = useCallback(
    (nextAllEvents: Record<string, EventMetadata>) => {
      eventMetadataRef.current = nextAllEvents;
      setEventMetadataState(nextAllEvents);
    },
    [],
  );
  const setEventMetadata = useCallback(
    (next: React.SetStateAction<Record<string, EventMetadata>>) => {
      const nextAllEvents =
        typeof next === "function"
          ? (
              next as (
                current: Record<string, EventMetadata>,
              ) => Record<string, EventMetadata>
            )(eventMetadataRef.current)
          : next;
      commitEventMetadata(nextAllEvents);
    },
    [commitEventMetadata],
  );
  const [executeModeItems, setExecuteModeItems] = useState<
    Record<string, ExecuteModeItems>
  >({});
  const executeModeItemsRef = useRef<Record<string, ExecuteModeItems>>({});
  const commitExecuteModeItems = useCallback(
    (nextAllEvents: Record<string, ExecuteModeItems>) => {
      executeModeItemsRef.current = nextAllEvents;
      setExecuteModeItems(nextAllEvents);
    },
    [],
  );
  const updateExecuteModeItems = useCallback(
    (
      updater: (
        current: Record<string, ExecuteModeItems>,
      ) => Record<string, ExecuteModeItems>,
    ) => {
      const nextAllEvents = updater(executeModeItemsRef.current);
      commitExecuteModeItems(nextAllEvents);
      return nextAllEvents;
    },
    [commitExecuteModeItems],
  );
  const setExecuteModeItemsCommitted = useCallback(
    (next: React.SetStateAction<Record<string, ExecuteModeItems>>) => {
      const nextAllEvents =
        typeof next === "function"
          ? (
              next as (
                current: Record<string, ExecuteModeItems>,
              ) => Record<string, ExecuteModeItems>
            )(executeModeItemsRef.current)
          : next;
      commitExecuteModeItems(nextAllEvents);
    },
    [commitExecuteModeItems],
  );
  const commitExecuteModeItemsForEvent = useCallback(
    (eventName: string, nextEventItems: ExecuteModeItems) => {
      commitExecuteModeItems({
        ...executeModeItemsRef.current,
        [eventName]: nextEventItems,
      });
    },
    [commitExecuteModeItems],
  );
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});

  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>("eventList");
  const [mapViewActive, setMapViewActive] = useState(false);
  const mapToggleLongPressRef = React.useRef<number | null>(null);
  const mapToggleLongPressFiredRef = React.useRef(false);
  const mapToggleButtonRef = React.useRef<HTMLButtonElement>(null);
  const mapToggleMenuRef = React.useRef<HTMLDivElement>(null);
  const [sortState, setSortState] = useState<SortState>("Manual");
  const [blockSortDirection, setBlockSortDirection] =
    useState<BlockSortDirection | null>(null);
  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [editDialogItem, setEditDialogItem] = useState<ShoppingItem | null>(
    null,
  );
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<
    Set<string>
  >(new Set());
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

  const [newItemDefaults, setNewItemDefaults] = useState<{
    eventDate: string;
    block: string;
    number: string;
  } | null>(null);

  const [pendingEventUpdate, setPendingEventUpdate] =
    useState<PendingEventUpdate | null>(null);
  const pendingEventUpdateBaseItemsRef = useRef<ShoppingItem[] | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<
    string | null
  >(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);
  const [pendingDuplicateEvent, setPendingDuplicateEvent] =
    useState<PendingDuplicateEventImport | null>(null);
  const eventUpdatePreviewEpochRef = useRef(0);

  useEffect(
    () => () => {
      eventUpdatePreviewEpochRef.current += 1;
    },
    [],
  );

  const [searchKeyword, setSearchKeyword] = useState("");
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(
    null,
  );

  const [layoutMode, setLayoutMode] = useState<"pc" | "smartphone">(() =>
    typeof window !== "undefined" && window.innerWidth < 768
      ? "smartphone"
      : "pc",
  );
  const { uiVisibilitySettings, setUiVisibilitySettings } =
    useUIVisibilitySettings();
  const [uiVisibilityOverride, setUiVisibilityOverride] = useState(false);
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
  } = useNumberCellOutlineStyle();
  const { disablePriceUndefinedCheck, setDisablePriceUndefinedCheck } =
    useDisablePriceUndefinedCheck();
  const {
    disableLimitedPurchaseQuantityCheck,
    setDisableLimitedPurchaseQuantityCheck,
  } = useDisableLimitedPurchaseQuantityCheck();
  const {
    purchaseStatusControlMode,
    setPurchaseStatusControlMode,
    DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  } = usePurchaseStatusControlMode();
  const {
    skipLimitedPurchaseForSingleQuantity,
    setSkipLimitedPurchaseForSingleQuantity,
  } = useSkipLimitedPurchaseForSingleQuantity();
  const {
    postEventDistributionCheckEnabled,
    setPostEventDistributionCheckEnabled,
  } = usePostEventDistributionCheck();
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);
  const [focusModeSessions, setFocusModeSessions] = useState<
    Record<string, FocusModeSessionState>
  >({});

  const { themeMode, setThemeMode } = useThemeMode();

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
  const [simpleHallDefinitionMode, setSimpleHallDefinitionMode] =
    useState(false);
  const [globalHallOrderPanelOpen, setGlobalHallOrderPanelOpen] =
    useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingBackup, setPendingBackup] = useState<AppBackupV1 | null>(null);

  const [mapImportDialogOpen, setMapImportDialogOpen] = useState(false);
  const [mapImportPendingFile, setMapImportPendingFile] = useState<File | null>(
    null,
  );
  const [mapImportPendingEventName, setMapImportPendingEventName] =
    useState<string>("");
  const [pendingMapReimport, setPendingMapReimport] =
    useState<PreparedMapImport | null>(null);
  const {
    isInitialized,
    persistenceStatus,
    failedStores,
    failureDetails,
    retrySave,
    runExclusiveRestore,
  } = useIndexedDbPersistence({
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

  const hallDefinitionsMigratedRef = useRef(false);
  useEffect(() => {
    if (!isInitialized || hallDefinitionsMigratedRef.current) return;
    hallDefinitionsMigratedRef.current = true;

    setHallDefinitions((prev) => {
      let changed = false;
      const next: HallDefinitionsStore = {};
      for (const eventName of Object.keys(prev)) {
        const byTab = { ...prev[eventName] };

        const maplessById = new Map<string, HallDefinition>();
        for (const h of byTab[MAPLESS_HALL_KEY] ?? []) {
          maplessById.set(h.id, h);
        }
        for (const tabName of Object.keys(byTab)) {
          if (
            tabName === MAPLESS_HALL_KEY ||
            tabName.startsWith(MAPLESS_HALL_KEY + ":")
          )
            continue;
          const original = byTab[tabName] || [];
          const keep: HallDefinition[] = [];
          for (const h of original) {
            const isMapless =
              (!h.vertices || h.vertices.length < 4) && !!h.blockNames?.length;
            if (isMapless) {
              if (!maplessById.has(h.id)) maplessById.set(h.id, h);
              changed = true;
            } else {
              keep.push(h);
            }
          }
          if (keep.length !== original.length) {
            byTab[tabName] = keep;
          }
        }

        const collectedMapless = Array.from(maplessById.values());
        if (collectedMapless.length > 0) {
          const eventItems = eventLists[eventName] || [];
          const dates = extractEventDates(eventItems);
          if (dates.length > 0) {
            for (const date of dates) {
              const dateKey = getMaplessKey(date);
              if (!byTab[dateKey] || byTab[dateKey].length === 0) {
                byTab[dateKey] = collectedMapless.map((h) => ({ ...h }));
                changed = true;
              }
            }
          }
        }
        if (byTab[MAPLESS_HALL_KEY] != null) {
          delete byTab[MAPLESS_HALL_KEY];
          changed = true;
        }

        next[eventName] = byTab;
      }
      return changed ? next : prev;
    });

    setHallRouteSettings((prev) => {
      let changed = false;
      const next: HallRouteSettingsStore = {};
      for (const eventName of Object.keys(prev)) {
        const byTab = { ...prev[eventName] };
        const oldSettings = byTab[MAPLESS_HALL_KEY];
        if (oldSettings != null) {
          const eventItems = eventLists[eventName] || [];
          const dates = extractEventDates(eventItems);
          for (const date of dates) {
            const dateKey = getMaplessKey(date);
            if (!byTab[dateKey]) {
              byTab[dateKey] = {
                hallOrder: [...oldSettings.hallOrder],
                hallVisitLists: oldSettings.hallVisitLists.map((vl) => ({
                  hallId: vl.hallId,
                  itemIds: [...vl.itemIds],
                })),
              };
              changed = true;
            }
          }
          delete byTab[MAPLESS_HALL_KEY];
          changed = true;
        }
        next[eventName] = byTab;
      }
      return changed ? next : prev;
    });
  }, [isInitialized, eventLists]);

  const items = useMemo(
    () => (activeEventName ? eventLists[activeEventName] || [] : []),
    [activeEventName, eventLists],
  );

  const eventDates = useMemo(() => extractEventDates(items), [items]);
  const activeEventDate = useMemo(
    () => (activeEventName && eventDates.includes(activeTab) ? activeTab : ""),
    [activeEventName, activeTab, eventDates],
  );

  const {
    mapTabs,
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
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      if (!activeEventDate) return 0;
      const dayName = activeEventDate;

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      return executeIds.filter((itemId) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return false;

        const block = currentMapData.blocks.find((b) => b.name === item.block);
        if (!block) return false;

        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;

        for (const hall of currentHalls) {
          if (hall.id === hallId && hall.vertices.length >= 4) {
            if (isPointInPolygon(centerRow, centerCol, hall.vertices)) {
              return true;
            }
          }
        }
        return false;
      }).length;
    },
    [
      activeEventName,
      isMapTab,
      activeEventDate,
      currentMapData,
      currentHalls,
      items,
      executeModeItems,
    ],
  );

  const getHallTotalItemCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      if (!activeEventDate) return 0;
      const dayName = activeEventDate;

      const dayItems = items.filter((item) => item.eventDate === dayName);

      return dayItems.filter((item) => {
        const block = currentMapData.blocks.find((b) => b.name === item.block);
        if (!block) return false;

        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;

        for (const hall of currentHalls) {
          if (hall.id === hallId && hall.vertices.length >= 4) {
            if (isPointInPolygon(centerRow, centerCol, hall.vertices)) {
              return true;
            }
          }
        }
        return false;
      }).length;
    },
    [
      activeEventName,
      isMapTab,
      activeEventDate,
      currentMapData,
      currentHalls,
      items,
    ],
  );

  const getItemHallId = useCallback(
    (item: ShoppingItem, eventDate: string): string | null => {
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return null;

      const manual = resolveManualHallId(item.manualHallId, halls);
      if (manual) return manual;

      const mapDataForDate = getMapDataForDate(eventDate);
      if (mapDataForDate) {
        const block = mapDataForDate.blocks.find((b) => b.name === item.block);
        if (block) {
          const centerRow = (block.startRow + block.endRow) / 2;
          const centerCol = (block.startCol + block.endCol) / 2;
          for (const hall of halls) {
            if (
              hall.vertices.length >= 4 &&
              isPointInPolygon(centerRow, centerCol, hall.vertices)
            ) {
              return hall.id;
            }
          }
        }
      }

      return resolveHallByBlockName(item.block, halls);
    },
    [getHallsForDate, getMapDataForDate],
  );

  const areItemsInSameHall = useCallback(
    (itemId1: string, itemId2: string, eventDate: string): boolean => {
      const item1 = items.find((i) => i.id === itemId1);
      const item2 = items.find((i) => i.id === itemId2);
      if (!item1 || !item2) return true;
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return true;
      const hallId1 = getItemHallId(item1, eventDate);
      const hallId2 = getItemHallId(item2, eventDate);

      if (hallId1 === null || hallId2 === null) return true;

      const priority1 = item1.priorityLevel || "none";
      const priority2 = item2.priorityLevel || "none";
      if (hallId1 !== hallId2 || priority1 !== priority2) return false;

      const spaceKey1 = getSpaceKey(item1.block, item1.number);
      const spaceKey2 = getSpaceKey(item2.block, item2.number);
      return spaceKey1 === spaceKey2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const areItemsInSameHallGroup = useCallback(
    (itemId1: string, itemId2: string, eventDate: string): boolean => {
      const item1 = items.find((i) => i.id === itemId1);
      const item2 = items.find((i) => i.id === itemId2);
      if (!item1 || !item2) return true;
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return true;
      const hallId1 = getItemHallId(item1, eventDate);
      const hallId2 = getItemHallId(item2, eventDate);

      if (hallId1 === null || hallId2 === null) return true;

      const priority1 = item1.priorityLevel || "none";
      const priority2 = item2.priorityLevel || "none";
      return hallId1 === hallId2 && priority1 === priority2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const currentMode = useMemo(() => {
    if (!activeEventName) return "execute";
    const modes = dayModes[activeEventName];
    if (!modes) return "edit";
    if (activeEventDate) {
      const mode = modes[activeEventDate];
      if (mode) {
        return mode;
      }
      return "edit";
    }
    return "edit";
  }, [activeEventName, dayModes, activeEventDate]);

  const currentFocusSessionKey = useMemo(() => {
    if (!activeEventName) return null;
    const currentEventDate = activeEventDate;
    if (!currentEventDate) return null;
    return buildFocusSessionKey(activeEventName, currentEventDate);
  }, [activeEventName, activeEventDate]);

  const currentFocusResumeState = useMemo(() => {
    if (!currentFocusSessionKey) return null;
    return focusModeSessions[currentFocusSessionKey] || null;
  }, [focusModeSessions, currentFocusSessionKey]);

  const handleFocusSessionStateChange = useCallback(
    (state: FocusModeSessionState) => {
      if (!currentFocusSessionKey) return;
      setFocusModeSessions((prev) => {
        const existing = prev[currentFocusSessionKey];
        if (isFocusModeSessionStateEqual(existing, state)) return prev;
        return {
          ...prev,
          [currentFocusSessionKey]: state,
        };
      });
    },
    [currentFocusSessionKey],
  );

  const validFocusSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    Object.entries(eventLists).forEach(([eventName, eventItems]) => {
      extractEventDates(eventItems).forEach((eventDate) => {
        keys.add(buildFocusSessionKey(eventName, eventDate));
      });
    });
    return keys;
  }, [eventLists]);

  useEffect(() => {
    setFocusModeSessions((prev) => {
      let changed = false;
      const next: Record<string, FocusModeSessionState> = {};
      Object.entries(prev).forEach(([key, value]) => {
        if (validFocusSessionKeys.has(key)) {
          next[key] = value;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [validFocusSessionKeys]);

  const currentFocusEventDate = useMemo(
    () => activeEventDate,
    [activeEventDate],
  );

  const currentFocusMapName = useMemo(
    () => (currentFocusEventDate ? `${currentFocusEventDate}マップ` : ""),
    [currentFocusEventDate],
  );

  const getDayMapRotationState = useCallback(
    (eventName: string, dayMapName: string) =>
      resolveDayMapRotationState(mapRotationSettings[eventName]?.[dayMapName]),
    [mapRotationSettings],
  );

  const updateMapRotationAngle = useCallback(
    (
      eventName: string,
      dayMapName: string,
      screen: RotationScreenType,
      angle: number,
    ) => {
      const normalizedAngle = normalizeRotationAngle(angle);
      setMapRotationSettings((prev) => {
        const eventSettings = prev[eventName] || {};
        const currentState = resolveDayMapRotationState(
          eventSettings[dayMapName],
        );
        const nextState =
          screen === "mapTab"
            ? { ...currentState, mapTabAngle: normalizedAngle }
            : { ...currentState, focusModeAngle: normalizedAngle };
        if (
          currentState.initialAngle === nextState.initialAngle &&
          currentState.mapTabAngle === nextState.mapTabAngle &&
          currentState.focusModeAngle === nextState.focusModeAngle
        ) {
          return prev;
        }
        return {
          ...prev,
          [eventName]: {
            ...eventSettings,
            [dayMapName]: nextState,
          },
        };
      });
    },
    [],
  );

  const currentMapTabRotationState = useMemo(() => {
    if (!activeEventName || !isMapTab || !currentMapTabName) {
      return resolveDayMapRotationState(undefined);
    }
    return getDayMapRotationState(activeEventName, currentMapTabName);
  }, [activeEventName, isMapTab, currentMapTabName, getDayMapRotationState]);

  const currentFocusMapRotationState = useMemo(() => {
    if (!activeEventName || !currentFocusMapName) {
      return resolveDayMapRotationState(undefined);
    }
    return getDayMapRotationState(activeEventName, currentFocusMapName);
  }, [activeEventName, currentFocusMapName, getDayMapRotationState]);

  const handleMapTabRotationAngleChange = useCallback(
    (angle: number) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      updateMapRotationAngle(
        activeEventName,
        currentMapTabName,
        "mapTab",
        angle,
      );
    },
    [activeEventName, isMapTab, currentMapTabName, updateMapRotationAngle],
  );

  const handleFocusMapRotationAngleChange = useCallback(
    (angle: number) => {
      if (!activeEventName || !currentFocusMapName) return;
      updateMapRotationAngle(
        activeEventName,
        currentFocusMapName,
        "focusMode",
        angle,
      );
    },
    [activeEventName, currentFocusMapName, updateMapRotationAngle],
  );

  const currentMapTabViewport = useMemo((): MapViewportState | undefined => {
    if (!activeEventName || !isMapTab || !currentMapTabName) return undefined;
    return mapViewportSettings[activeEventName]?.[currentMapTabName];
  }, [activeEventName, isMapTab, currentMapTabName, mapViewportSettings]);

  const handleMapViewportChange = useCallback(
    (viewport: MapViewportState) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      setMapViewportSettings((prev: MapViewportSettingsStore) => {
        const eventSettings = prev[activeEventName] || {};
        const current = eventSettings[currentMapTabName];
        if (
          current &&
          current.zoomLevel === viewport.zoomLevel &&
          current.offsetX === viewport.offsetX &&
          current.offsetY === viewport.offsetY
        ) {
          return prev;
        }
        return {
          ...prev,
          [activeEventName]: {
            ...eventSettings,
            [currentMapTabName]: viewport,
          },
        };
      });
    },
    [activeEventName, isMapTab, currentMapTabName],
  );

  const { showHeaderBar, showTabBar, rawHideSomething } = useMemo(() => {
    if (!activeEventName) {
      return { showHeaderBar: true, showTabBar: true, rawHideSomething: false };
    }
    const layout = layoutMode === "smartphone" ? "sp" : "pc";
    let rawHeader = true,
      rawTabBar = true;

    if (currentMode === "focus") {
      const key =
        `focus_${layout}_${focusModeMapVisible ? "mapOn" : "mapOff"}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    } else if (currentMode === "execute") {
      const key = `execute_${layout}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    }

    const hideSomething = !rawHeader || !rawTabBar;
    // Keep the settings panel reachable while layout changes alter the
    // currently-applied visibility profile. The draft is committed on close.
    if (uiVisibilityOverride || uiSettingsPanelOpen) {
      return {
        showHeaderBar: true,
        showTabBar: true,
        rawHideSomething: hideSomething,
      };
    }
    return {
      showHeaderBar: rawHeader,
      showTabBar: rawTabBar,
      rawHideSomething: hideSomething,
    };
  }, [
    uiVisibilityOverride,
    uiSettingsPanelOpen,
    activeEventName,
    currentMode,
    layoutMode,
    focusModeMapVisible,
    uiVisibilitySettings,
  ]);

  const applyBulkAdd = useCallback(
    (
      eventName: string,
      newItemsData: Omit<ShoppingItem, "id" | "purchaseStatus">[],
      metadata?: BulkAddMetadata,
    ) => {
      const newItems = buildBulkAddItems(newItemsData, metadata);
      const isNewEvent = !eventLists[eventName];

      if (hasBulkAddLayoutInfo(metadata) && isNewEvent) {
        const { sortedItems, executeModeItems } = buildLayoutAppliedEventItems(
          newItems,
          metadata.layoutInfo,
        );
        setEventLists((prevLists) => ({
          ...prevLists,
          [eventName]: sortedItems,
        }));
        updateExecuteModeItems((prev) => ({
          ...prev,
          [eventName]: executeModeItems,
        }));
      } else {
        setEventLists((prevLists) => {
          const currentItems: ShoppingItem[] = prevLists[eventName] || [];
          return {
            ...prevLists,
            [eventName]: [...currentItems, ...newItems],
          };
        });
      }

      const eventMeta = buildBulkAddEventMetadata(metadata);
      if (eventMeta) {
        setEventMetadata((prev) => ({
          ...prev,
          [eventName]: eventMeta,
        }));
      }

      if (isNewEvent) {
        const initialDayModes = buildInitialDayModesForBulkAdd(newItems);
        setDayModes((prev) => ({
          ...prev,
          [eventName]: initialDayModes,
        }));

        if (!hasBulkAddLayoutInfo(metadata)) {
          const initialExecuteItems =
            buildInitialExecuteItemsForBulkAdd(newItems);
          updateExecuteModeItems((prev) => ({
            ...prev,
            [eventName]: initialExecuteItems,
          }));
        }
      }

      const uiPlan = buildBulkAddUiPlan(
        eventName,
        newItems,
        isNewEvent,
        eventLists[eventName] || [],
      );
      alert(uiPlan.alertMessage);

      if (uiPlan.nextActiveEventName) {
        setActiveEventName(uiPlan.nextActiveEventName);
      }
      if (uiPlan.nextActiveTab) {
        setActiveTab(uiPlan.nextActiveTab);
      }
    },
    [eventLists],
  );

  const handleBulkAdd = useCallback(
    (
      eventName: string,
      newItemsData: Omit<ShoppingItem, "id" | "purchaseStatus">[],
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
          ? {
              url: metadata.url,
              sheetName: metadata.sheetName || "",
            }
          : null,
        eventLists,
        eventMetadata,
      });

      if (analysis.kind === "create") {
        applyBulkAdd(analysis.eventName, analysis.incomingItems, metadata);
        return true;
      }

      setPendingDuplicateEvent({ analysis, metadata });
      return false;
    },
    [activeEventName, applyBulkAdd, eventLists, eventMetadata],
  );

  const handleUpdateItem = useCallback(
    (updatedItem: ShoppingItem) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      const currentMode = dayModes[activeEventName]?.[currentEventDate];

      setEventLists((prev) => {
        const currentItems = prev[activeEventName] || [];
        const currentItem = currentItems.find(
          (item) => item.id === updatedItem.id,
        );

        const result = computeUpdateItem(
          currentItems,
          updatedItem,
          currentMode as ViewMode | undefined,
          currentItem?.protectionLevel,
          currentItem?.source,
        );

        if (result.purchaseStatusChanged || result.purchaseQuantityChanged) {
          setRecentlyChangedItemIds((prevIds) =>
            new Set(prevIds).add(updatedItem.id),
          );
        }

        return {
          ...prev,
          [activeEventName]: result.items,
        };
      });
    },
    [activeEventName, activeTab, eventDates, dayModes],
  );

  const handleMoveItem = useCallback(
    (
      dragId: string,
      hoverId: string,
      targetColumn?: "execute" | "candidate",
      sourceColumn?: "execute" | "candidate",
    ) => {
      if (!activeEventName) return;
      clearRangeSelection();
      setSortState("Manual");
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const effectiveSelectedIds = spaceGroupIds
        ? new Set(spaceGroupIds)
        : selectedItemIds;
      spaceGroupDragItemIdsRef.current = null;

      const currentEventExecuteItems =
        executeModeItemsRef.current[activeEventName] || {};
      const currentExecuteItems = currentEventExecuteItems[currentEventDate]
        ? {
            ...currentEventExecuteItems,
            [currentEventDate]: [
              ...(currentEventExecuteItems[currentEventDate] || []),
            ],
          }
        : currentEventExecuteItems;

      const selectionSpansMultipleSpaces = (() => {
        if (effectiveSelectedIds.size <= 1) return false;
        const spaceKeys = new Set<string>();
        effectiveSelectedIds.forEach((id) => {
          const item = (eventLists[activeEventName] || []).find(
            (i) => i.id === id,
          );
          if (item) spaceKeys.add(getSpaceKey(item.block, item.number));
        });
        return spaceKeys.size > 1;
      })();
      const hallCheck =
        spaceGroupIds || selectionSpansMultipleSpaces
          ? (id1: string, id2: string) =>
              areItemsInSameHallGroup(id1, id2, currentEventDate)
          : (id1: string, id2: string) =>
              areItemsInSameHall(id1, id2, currentEventDate);

      const result = computeMoveItem({
        dragId,
        hoverId,
        targetColumn,
        sourceColumn,
        mode: mode as ViewMode | undefined,
        effectiveSelectedIds,
        allItems: eventLists[activeEventName] || [],
        executeModeItems: currentExecuteItems,
        dayName: currentEventDate,
        selectedBlockFilters,
        areItemsInSameHall: hallCheck,
      });

      if (result.eventListItems) {
        setEventLists((prev) => ({
          ...prev,
          [activeEventName]: result.eventListItems!,
        }));
      }
      if (result.executeModeItems) {
        updateExecuteModeItems((prev) => ({
          ...prev,
          [activeEventName]: result.executeModeItems!,
        }));
      }
    },
    [
      activeEventName,
      selectedItemIds,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      selectedBlockFilters,
      eventLists,
      areItemsInSameHall,
      areItemsInSameHallGroup,
      clearRangeSelection,
    ],
  );
  const handleMoveItemVerticalInternal = useCallback(
    (
      direction: "up" | "down",
      itemId: string,
      targetColumn?: "execute" | "candidate",
    ) => {
      if (!activeEventName) return;
      clearRangeSelection();
      setSortState("Manual");
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];
      const currentEventExecuteItems =
        executeModeItemsRef.current[activeEventName] || {};

      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const isSpaceGroupMove = !!spaceGroupIds;

      if (mode === "edit" && targetColumn === "execute") {
        const dayItems = [
          ...(currentEventExecuteItems[currentEventDate] || []),
        ];
        const getItemSpacePriorityKey = (id: string): string => {
          const item = items.find((i) => i.id === id);
          return item
            ? `${getSpaceKey(item.block, item.number)}::${item.priorityLevel || "none"}`
            : "";
        };

        const effectiveIds = spaceGroupIds
          ? new Set(spaceGroupIds)
          : selectedItemIds;
        const movingGroupKeys = new Set<string>();
        movingGroupKeys.add(getItemSpacePriorityKey(itemId));
        effectiveIds.forEach((id) => {
          if (dayItems.includes(id)) {
            movingGroupKeys.add(getItemSpacePriorityKey(id));
          }
        });

        const movingIndices = dayItems
          .map((id, idx) =>
            movingGroupKeys.has(getItemSpacePriorityKey(id)) ? idx : -1,
          )
          .filter((idx) => idx >= 0);

        if (movingIndices.length > 0) {
          const movingStart = movingIndices[0];
          const movingEnd = movingIndices[movingIndices.length - 1];

          const adjacentIndex =
            direction === "up" ? movingStart - 1 : movingEnd + 1;
          if (adjacentIndex >= 0 && adjacentIndex < dayItems.length) {
            const adjacentId = dayItems[adjacentIndex];
            const adjacentGroupKey = getItemSpacePriorityKey(adjacentId);

            if (!movingGroupKeys.has(adjacentGroupKey)) {
              let adjStart = adjacentIndex;
              let adjEnd = adjacentIndex;
              while (
                adjStart > 0 &&
                getItemSpacePriorityKey(dayItems[adjStart - 1]) ===
                  adjacentGroupKey
              )
                adjStart--;
              while (
                adjEnd < dayItems.length - 1 &&
                getItemSpacePriorityKey(dayItems[adjEnd + 1]) ===
                  adjacentGroupKey
              )
                adjEnd++;

              const movingBlock = dayItems.slice(movingStart, movingEnd + 1);
              const remaining = [
                ...dayItems.slice(0, movingStart),
                ...dayItems.slice(movingEnd + 1),
              ];

              const adjItemIdx = remaining.findIndex((id) => id === adjacentId);
              if (adjItemIdx >= 0) {
                let insertIdx: number;
                if (direction === "up") {
                  let targetStart = adjItemIdx;
                  while (
                    targetStart > 0 &&
                    getItemSpacePriorityKey(remaining[targetStart - 1]) ===
                      adjacentGroupKey
                  )
                    targetStart--;
                  insertIdx = targetStart;
                } else {
                  let targetEnd = adjItemIdx;
                  while (
                    targetEnd < remaining.length - 1 &&
                    getItemSpacePriorityKey(remaining[targetEnd + 1]) ===
                      adjacentGroupKey
                  )
                    targetEnd++;
                  insertIdx = targetEnd + 1;
                }

                remaining.splice(insertIdx, 0, ...movingBlock);

                updateExecuteModeItems((prev) => ({
                  ...prev,
                  [activeEventName]: {
                    ...prev[activeEventName],
                    [currentEventDate]: remaining,
                  },
                }));
                return;
              }
            }
          }
        }
      }

      const effectiveSelectedIds = spaceGroupIds
        ? new Set(spaceGroupIds)
        : selectedItemIds;
      const hallCheck = spaceGroupIds
        ? (id1: string, id2: string) =>
            areItemsInSameHallGroup(id1, id2, currentEventDate)
        : (id1: string, id2: string) =>
            areItemsInSameHall(id1, id2, currentEventDate);

      const result = computeMoveItemVertical(
        direction,
        itemId,
        targetColumn,
        mode as ViewMode | undefined,
        effectiveSelectedIds,
        eventLists[activeEventName] || [],
        currentEventExecuteItems,
        currentEventDate,
        hallCheck,
      );

      if (result.eventListItems) {
        setEventLists((prev) => ({
          ...prev,
          [activeEventName]: result.eventListItems!,
        }));
      }
      if (result.executeModeItems) {
        updateExecuteModeItems((prev) => ({
          ...prev,
          [activeEventName]: result.executeModeItems!,
        }));
      }
    },
    [
      activeEventName,
      selectedItemIds,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      eventLists,
      items,
      areItemsInSameHall,
      areItemsInSameHallGroup,
      clearRangeSelection,
    ],
  );

  const handleMoveItemUp = useCallback(
    (itemId: string, targetColumn?: "execute" | "candidate") =>
      handleMoveItemVerticalInternal("up", itemId, targetColumn),
    [handleMoveItemVerticalInternal],
  );

  const handleMoveItemDown = useCallback(
    (itemId: string, targetColumn?: "execute" | "candidate") =>
      handleMoveItemVerticalInternal("down", itemId, targetColumn),
    [handleMoveItemVerticalInternal],
  );

  const handleMoveToExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      const currentExecuteIds =
        executeModeItemsRef.current[activeEventName]?.[currentEventDate] || [];
      const plan = buildMovePlan({
        requestedIds: itemIds,
        sourceOrderedIds: getCandidateSourceOrderedIds(
          items,
          currentEventDate,
          currentExecuteIds,
        ),
        allItems: items,
        dayName: currentEventDate,
        expansionPolicy: "same-visit",
      });
      const effectiveIds = plan.effective;

      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: computeMoveToExecuteColumn(
          effectiveIds,
          currentEventDate,
          items,
          prev[activeEventName] || {},
          new Set(),
        ),
      }));

      clearSelection();
    },
    [activeEventDate, activeEventName, clearSelection, items],
  );
  const handleRemoveFromExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      const plan = buildMovePlan({
        requestedIds: itemIds,
        sourceOrderedIds:
          executeModeItemsRef.current[activeEventName]?.[currentEventDate] ||
          [],
        allItems: items,
        dayName: currentEventDate,
        expansionPolicy: "same-visit",
      });
      const effectiveIds = plan.effective;

      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: computeRemoveFromExecuteColumn(
          effectiveIds,
          prev[activeEventName] || {},
          currentEventDate,
        ),
      }));

      clearSelection();
    },
    [activeEventDate, activeEventName, clearSelection, items],
  );

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;

    const currentEventDate = activeEventDate;
    if (!currentEventDate) {
      alert(
        "参加日タブが選択されていないため、表示モードを切り替えできません。",
      );
      return;
    }

    const currentModeValue = dayModes[activeEventName]?.[currentEventDate];
    if (!currentModeValue) {
      alert("表示モードが未設定のため、表示モードを切り替えできません。");
      return;
    }
    const newMode: ViewMode = currentModeValue === "edit" ? "execute" : "edit";

    setDayModes((prev) => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: newMode,
      },
    }));

    clearSelection();
    setCandidateNumberSortDirection(null);
  }, [activeEventDate, activeEventName, clearSelection, dayModes]);

  const handleSetViewMode = useCallback(
    (mode: ViewMode, scrollToItemId?: string) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      setDayModes((prev) => ({
        ...prev,
        [activeEventName]: {
          ...(prev[activeEventName] || {}),
          [currentEventDate]: mode,
        },
      }));

      clearSelection();
      setCandidateNumberSortDirection(null);

      if (mode !== "focus") {
        setFocusModeMapVisible(false);
      }
      closeUiSettingsPanel();

      if (scrollToItemId) {
        setTimeout(() => {
          const element = document.querySelector(
            `[data-item-id="${scrollToItemId}"]`,
          );
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }, 100);
      }
    },
    [
      activeEventName,
      activeEventDate,
      activeTab,
      clearSelection,
      closeUiSettingsPanel,
      eventDates,
    ],
  );

  const handleSelectEvent = useCallback(
    (eventName: string) => {
      const eventItems = eventLists[eventName] || [];
      const nextTab = resolveEventListTab(eventItems);
      if (!nextTab) {
        alert("参加日がないため処理を停止しました。");
        return;
      }

      setActiveEventName(eventName);
      clearSelection();
      setSelectedBlockFilters(new Set());
      setActiveTab(nextTab);
    },
    [clearSelection, eventLists],
  );

  const handleDeleteEvent = useCallback(
    (eventName: string) => {
      eventUpdatePreviewEpochRef.current += 1;
      setPendingEventUpdate((pending) =>
        pending?.eventName === eventName ? null : pending,
      );
      setEventLists((prev) => removeRecordKey(prev, eventName));
      setEventMetadata((prev) => removeRecordKey(prev, eventName));
      updateExecuteModeItems((prev) => removeRecordKey(prev, eventName));
      setDayModes((prev) => removeRecordKey(prev, eventName));
      setMapData((prev) => removeRecordKey(prev, eventName));
      setMapRotationSettings((prev) => removeRecordKey(prev, eventName));
      setRouteSettings((prev) => removeRecordKey(prev, eventName));
      setHallDefinitions((prev) => removeRecordKey(prev, eventName));
      setHallRouteSettings((prev) => removeRecordKey(prev, eventName));
      setMapViewportSettings((prev) => removeRecordKey(prev, eventName));
      removeBlockDetectionSettingsForEvent(eventName);
      setFocusModeSessions((prev) =>
        removeFocusModeSessionByEvent(prev, eventName),
      );
      if (activeEventName === eventName) {
        setActiveEventName(null);
        setActiveTab("eventList");
      }
    },
    [activeEventName],
  );

  const handleRenameEvent = useCallback((oldName: string) => {
    setEventToRename(oldName);
    setShowRenameDialog(true);
  }, []);

  const handleConfirmRename = useCallback(
    (newName: string) => {
      if (!eventToRename) return;

      if (eventToRename === newName) {
        setShowRenameDialog(false);
        setEventToRename(null);
        return;
      }

      if (eventLists[newName]) {
        alert("同名のイベントが既に存在します。別の名前を指定してください。");
        return;
      }

      setEventLists((prev) => renameRecordKey(prev, eventToRename, newName));

      setEventMetadata((prev) => renameRecordKey(prev, eventToRename, newName));

      setDayModes((prev) => renameRecordKey(prev, eventToRename, newName));

      updateExecuteModeItems((prev) =>
        renameRecordKey(prev, eventToRename, newName),
      );

      setMapData((prev) => renameRecordKey(prev, eventToRename, newName));
      setMapRotationSettings((prev) =>
        renameRecordKey(prev, eventToRename, newName),
      );

      setRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));

      setHallDefinitions((prev) =>
        renameRecordKey(prev, eventToRename, newName),
      );

      setHallRouteSettings((prev) =>
        renameRecordKey(prev, eventToRename, newName),
      );
      setMapViewportSettings((prev) =>
        renameRecordKey(prev, eventToRename, newName),
      );
      renameBlockDetectionSettingsForEvent(eventToRename, newName);
      setFocusModeSessions((prev) =>
        renameFocusModeSessionKeys(prev, eventToRename, newName),
      );

      if (activeEventName === eventToRename) {
        setActiveEventName(newName);
      }

      setShowRenameDialog(false);
      setEventToRename(null);
    },
    [eventToRename, eventLists, activeEventName],
  );

  const handleSortToggle = () => {
    clearSelection();
    setBlockSortDirection(null);
    setRecentlyChangedItemIds(new Set());
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === "asc" ? "desc" : "asc";
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;

      const itemsForTab = allItems.filter(
        (item) => item.eventDate === currentTabKey,
      );

      if (itemsForTab.length === 0) return prev;

      const sortedItemsForTab = [...itemsForTab].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, "ja", {
          numeric: true,
          sensitivity: "base",
        });
        return nextDirection === "asc" ? comparison : -comparison;
      });

      let sortedIndex = 0;
      const newItems = allItems.map((item) => {
        if (item.eventDate === currentTabKey) {
          return sortedItemsForTab[sortedIndex++];
        }
        return item;
      });

      return { ...prev, [activeEventName]: newItems };
    });

    setBlockSortDirection(nextDirection);
    clearSelection();
  };

  const handleBlockSortToggleCandidate = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === "asc" ? "desc" : "asc";
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(
        executeModeItems[activeEventName]?.[currentEventDate] || [],
      );

      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );

      if (candidateItems.length === 0) return prev;

      const sortedCandidateItems = [...candidateItems].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, "ja", {
          numeric: true,
          sensitivity: "base",
        });
        return nextDirection === "asc" ? comparison : -comparison;
      });

      const executeItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && executeIds.has(item.id),
      );

      const newItems = allItems.map((item) => {
        if (item.eventDate !== currentTabKey) {
          return item;
        }
        if (executeIds.has(item.id)) {
          return executeItems.shift() || item;
        } else {
          return sortedCandidateItems.shift() || item;
        }
      });

      return { ...prev, [activeEventName]: newItems };
    });

    setBlockSortDirection(nextDirection);
    clearSelection();
  };

  const handleEditRequest = (item: ShoppingItem) => {
    setEditDialogItem(item);
  };

  const handleDeleteRequest = useCallback((item: ShoppingItem) => {
    setItemToDelete(item);
  }, []);

  const handleDeleteItemFromMap = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      if (item) setItemToDelete(item);
    },
    [items],
  );

  const handleClearNewItemDefaults = useCallback(() => {
    setNewItemDefaults(null);
  }, []);

  const handleModeChangeFromFocus = useCallback(
    (mode: "edit" | "execute", lastItemId?: string) =>
      handleSetViewMode(mode, lastItemId),
    [handleSetViewMode],
  );

  const handleConfirmDelete = () => {
    if (!itemToDelete || !activeEventName) return;

    const result = computeDeleteItem(
      eventLists[activeEventName] || [],
      itemToDelete.id,
      executeModeItemsRef.current[activeEventName] || {},
    );

    setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
    updateExecuteModeItems((prev) => ({
      ...prev,
      [activeEventName]: result.executeModeItems,
    }));
    setItemToDelete(null);
  };

  const handleDoneEditing = () => {
    if (itemToEdit?.eventDate) {
      setItemToEdit(null);
      setActiveTab(itemToEdit.eventDate);
    } else {
      setItemToEdit(null);
      alert("参加日がないため処理を停止しました。");
      setActiveTab("eventList");
    }
  };

  const handleSelectItem = useCallback(
    (
      itemId: string,
      _columnType: "execute" | "candidate" | undefined,
      presentation: RangePresentation,
    ) => {
      selectItemForRange(itemId, presentation);
    },
    [selectItemForRange],
  );

  const handleSelectSpaceGroupForRange = useCallback(
    (
      groupKey: string,
      allItemIds: string[],
      presentation: RangePresentation,
    ) => {
      selectSpaceGroupForRange(groupKey, allItemIds, presentation);
    },
    [selectSpaceGroupForRange],
  );

  const spaceGroupDragItemIdsRef = useRef<string[] | null>(null);

  const [showPostponeFilterButton, setShowPostponeFilterButton] =
    useState(false);
  const [showLateFilterButton, setShowLateFilterButton] = useState(false);
  const executeSpaceGroupOrderRef = useRef<string[]>([]);
  const executeColumnItemsRef = useRef<ShoppingItem[]>([]);
  const recentlyChangedItemIdsRef = useRef<Set<string>>(new Set());

  const [candidateNumberSortDirection, setCandidateNumberSortDirection] =
    useState<"asc" | "desc" | null>(null);

  const handleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection =
      candidateNumberSortDirection === "asc" ? "desc" : "asc";
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(
        executeModeItems[activeEventName]?.[currentEventDate] || [],
      );

      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );

      let filteredCandidateItems = candidateItems;
      if (selectedBlockFilters.size > 0) {
        filteredCandidateItems = candidateItems.filter((item) =>
          selectedBlockFilters.has(item.block),
        );
      }

      if (filteredCandidateItems.length === 0) return prev;

      const sortedCandidateItems = [...filteredCandidateItems].sort((a, b) => {
        const comparison = a.number.localeCompare(b.number, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        return nextDirection === "asc" ? comparison : -comparison;
      });

      const sortedCandidateMap = new Map(
        sortedCandidateItems.map((item, index) => [
          item.id,
          { item, sortIndex: index },
        ]),
      );

      const otherItems: ShoppingItem[] = [];
      const candidateItemsToSort: {
        item: ShoppingItem;
        originalIndex: number;
        sortIndex: number;
      }[] = [];

      allItems.forEach((item, index) => {
        if (item.eventDate !== currentTabKey) {
          otherItems.push(item);
        } else if (executeIds.has(item.id)) {
          otherItems.push(item);
        } else if (sortedCandidateMap.has(item.id)) {
          const { item: sortedItem, sortIndex } = sortedCandidateMap.get(
            item.id,
          )!;
          candidateItemsToSort.push({
            item: sortedItem,
            originalIndex: index,
            sortIndex,
          });
        } else {
          otherItems.push(item);
        }
      });

      candidateItemsToSort.sort((a, b) => a.sortIndex - b.sortIndex);

      const resultItems: ShoppingItem[] = [];
      let candidateIndex = 0;

      allItems.forEach((item) => {
        if (item.eventDate !== currentTabKey) {
          resultItems.push(item);
        } else if (executeIds.has(item.id)) {
          resultItems.push(item);
        } else if (sortedCandidateMap.has(item.id)) {
          resultItems.push(candidateItemsToSort[candidateIndex++].item);
        } else {
          resultItems.push(item);
        }
      });

      return {
        ...prev,
        [activeEventName]: resultItems,
      };
    });

    setCandidateNumberSortDirection(nextDirection);
    clearSelection();
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    selectedBlockFilters,
    candidateNumberSortDirection,
    clearSelection,
    eventDates,
  ]);

  const handleClearSelection = clearSelection;
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
    [activeEventDate, clearRangeSelection, items],
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
    ],
  );

  const handleBulkStatusChange = useCallback(
    (
      groupKey: string,
      targetStatus: PurchaseStatus,
      groupItems: ShoppingItem[],
    ) => {
      if (!activeEventName) return;
      const allAlready = groupItems.every(
        (item) => item.purchaseStatus === targetStatus,
      );
      const newStatus: PurchaseStatus = allAlready ? "None" : targetStatus;
      setEventLists((prev) => {
        const allItems = [...(prev[activeEventName] || [])];
        const groupItemIds = new Set(groupItems.map((item) => item.id));
        return {
          ...prev,
          [activeEventName]: allItems.map((item) => {
            if (!groupItemIds.has(item.id)) return item;
            if (
              targetStatus === "LimitedPurchase" ||
              item.purchaseStatus === "LimitedPurchase"
            ) {
              return item;
            }
            return clearLimitedPurchase({ ...item, purchaseStatus: newStatus });
          }),
        };
      });
      // recentlyChangedItemIds に追加
      setRecentlyChangedItemIds((prevIds) => {
        const next = new Set(prevIds);
        groupItems.forEach((item) => next.add(item.id));
        return next;
      });

      if (sortState === "Manual" && newStatus !== "None") {
        const groupOrder = executeSpaceGroupOrderRef.current;
        if (
          groupOrder.length > 0 &&
          groupKey === groupOrder[groupOrder.length - 1]
        ) {
          const currentItems = executeColumnItemsRef.current;
          const groupItemIds = new Set(groupItems.map((item) => item.id));
          const allNonNone = currentItems.every(
            (item) =>
              groupItemIds.has(item.id) || item.purchaseStatus !== "None",
          );
          if (allNonNone) setShowPostponeFilterButton(true);
        }
      }

      if (sortState === "Postpone" && newStatus !== "None") {
        const groupOrder = executeSpaceGroupOrderRef.current;
        if (
          groupOrder.length > 0 &&
          groupKey === groupOrder[groupOrder.length - 1]
        ) {
          const currentItems = executeColumnItemsRef.current;
          const groupItemIds = new Set(groupItems.map((item) => item.id));
          const recentIds = recentlyChangedItemIdsRef.current;
          const allVisibleNonNone = currentItems.every((item) => {
            if (groupItemIds.has(item.id)) return true;
            if (item.purchaseStatus !== "Postpone" && !recentIds.has(item.id))
              return true;
            return item.purchaseStatus !== "None";
          });
          if (allVisibleNonNone) setShowLateFilterButton(true);
        }
      }
    },
    [activeEventName, sortState],
  );

  const handleExecuteItemUpdate = useCallback(
    (updatedItem: ShoppingItem) => {
      handleUpdateItem(updatedItem);

      if (sortState !== "Manual" && sortState !== "Postpone") return;
      if (updatedItem.purchaseStatus === "None") return;

      const groupOrder = executeSpaceGroupOrderRef.current;
      if (groupOrder.length === 0) return;
      const lastGroupKey = groupOrder[groupOrder.length - 1];

      const spaceKey = getSpaceKey(updatedItem.block, updatedItem.number);
      const priority = updatedItem.priorityLevel || "none";
      const itemGroupKey =
        priority !== "none" ? `${spaceKey}:${priority}` : spaceKey;
      if (itemGroupKey !== lastGroupKey) return;

      const currentItems = executeColumnItemsRef.current;

      if (sortState === "Manual") {
        const lastGroupItems = currentItems.filter((item) => {
          const sk = getSpaceKey(item.block, item.number);
          const p = item.priorityLevel || "none";
          return (p !== "none" ? `${sk}:${p}` : sk) === lastGroupKey;
        });
        if (lastGroupItems[lastGroupItems.length - 1]?.id !== updatedItem.id)
          return;

        const allNonNone = currentItems.every(
          (item) =>
            item.id === updatedItem.id || item.purchaseStatus !== "None",
        );
        if (allNonNone) setShowPostponeFilterButton(true);
      } else {
        const recentIds = recentlyChangedItemIdsRef.current;
        const visibleLastGroupItems = currentItems.filter((item) => {
          const sk = getSpaceKey(item.block, item.number);
          const p = item.priorityLevel || "none";
          const gk = p !== "none" ? `${sk}:${p}` : sk;
          if (gk !== lastGroupKey) return false;
          return item.purchaseStatus === "Postpone" || recentIds.has(item.id);
        });
        if (
          visibleLastGroupItems[visibleLastGroupItems.length - 1]?.id !==
          updatedItem.id
        )
          return;

        const allVisibleNonNone = currentItems.every((item) => {
          if (item.id === updatedItem.id) return true;
          if (item.purchaseStatus !== "Postpone" && !recentIds.has(item.id))
            return true;
          return item.purchaseStatus !== "None";
        });
        if (allVisibleNonNone) setShowLateFilterButton(true);
      }
    },
    [handleUpdateItem, sortState],
  );

  const handleActivatePostponeFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState("Postpone");
    setShowPostponeFilterButton(false);
  }, []);

  const handleActivateLateFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState("Late");
    setShowLateFilterButton(false);
  }, []);

  const handleExecuteSpaceGroupOrderChange = useCallback(
    (orderedGroupKeys: string[]) => {
      executeSpaceGroupOrderRef.current = orderedGroupKeys;
    },
    [],
  );

  const handleCollapseAndOpenNext = useCallback(
    (currentGroupKey: string) => {
      clearRangeSelection();
      const order = executeSpaceGroupOrderRef.current;
      const currentIndex = order.indexOf(currentGroupKey);
      const nextKey =
        currentIndex >= 0 && currentIndex < order.length - 1
          ? order[currentIndex + 1]
          : null;
      setExecuteCollapsedSpaces((prev) => {
        const next = new Set(prev);
        next.add(currentGroupKey);
        if (nextKey) {
          next.delete(nextKey);
        }
        return next;
      });
    },
    [clearRangeSelection],
  );

  const handleSetSpaceGroupDragItemIds = useCallback(
    (itemIds: string[] | null) => {
      spaceGroupDragItemIdsRef.current = itemIds;
    },
    [],
  );

  const handleToggleRangeSelection = useCallback(
    (rangeItemIds: readonly string[]) => {
      toggleRangeItemIdsSelection(rangeItemIds);
    },
    [toggleRangeItemIdsSelection],
  );

  const handleBulkSort = useCallback(
    (direction: BulkSortDirection) => {
      if (!activeEventName || selectedItemIds.size === 0) return;
      clearRangeSelection();
      setSortState("Manual");
      setBlockSortDirection(null);
      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      if (mode === "edit") {
        const executeIds = new Set(
          executeModeItems[activeEventName]?.[currentEventDate] || [],
        );
        const selectedItems = items.filter((item) =>
          selectedItemIds.has(item.id),
        );
        const isInExecuteColumn = selectedItems.some((item) =>
          executeIds.has(item.id),
        );
        const isInCandidateColumn = selectedItems.some(
          (item) => !executeIds.has(item.id),
        );

        if (isInExecuteColumn && !isInCandidateColumn) {
          updateExecuteModeItems((prev) => {
            const eventItems = prev[activeEventName] || {};
            const dayItems = [...(eventItems[currentEventDate] || [])];

            const itemsMap = new Map(items.map((item) => [item.id, item]));
            const selectedItems = dayItems
              .filter((id) => selectedItemIds.has(id))
              .map((id) => itemsMap.get(id)!)
              .filter(Boolean);

            const otherItems = dayItems.filter(
              (id) => !selectedItemIds.has(id),
            );
            selectedItems.sort((a, b) => {
              const comparison = a.number.localeCompare(b.number, undefined, {
                numeric: true,
                sensitivity: "base",
              });
              return direction === "asc" ? comparison : -comparison;
            });

            const firstSelectedIndex = dayItems.findIndex((id) =>
              selectedItemIds.has(id),
            );
            if (firstSelectedIndex === -1) return prev;
            const newDayItems = [...otherItems];
            newDayItems.splice(
              firstSelectedIndex,
              0,
              ...selectedItems.map((item) => item.id),
            );
            return {
              ...prev,
              [activeEventName]: {
                ...eventItems,
                [currentEventDate]: newDayItems,
              },
            };
          });
        } else if (isInCandidateColumn && !isInExecuteColumn) {
          setEventLists((prev) => {
            const allItems = [...(prev[activeEventName] || [])];
            const currentTabKey = currentEventDate;
            const executeIdsSet = new Set(
              executeModeItems[activeEventName]?.[currentEventDate] || [],
            );

            const candidateItems = allItems.filter(
              (item) =>
                item.eventDate === currentTabKey && !executeIdsSet.has(item.id),
            );
            const selectedCandidateItems = candidateItems.filter((item) =>
              selectedItemIds.has(item.id),
            );
            const otherCandidateItems = candidateItems.filter(
              (item) => !selectedItemIds.has(item.id),
            );

            selectedCandidateItems.sort((a, b) => {
              const comparison = a.number.localeCompare(b.number, undefined, {
                numeric: true,
                sensitivity: "base",
              });
              return direction === "asc" ? comparison : -comparison;
            });

            const firstSelectedIndex = candidateItems.findIndex((item) =>
              selectedItemIds.has(item.id),
            );
            if (firstSelectedIndex === -1) return prev;

            const sortedCandidateItems = [...otherCandidateItems];
            sortedCandidateItems.splice(
              firstSelectedIndex,
              0,
              ...selectedCandidateItems,
            );

            const executeItems = allItems.filter(
              (item) =>
                item.eventDate === currentTabKey && executeIdsSet.has(item.id),
            );

            const newItems = allItems.map((item) => {
              if (item.eventDate !== currentTabKey) {
                return item;
              }
              if (executeIdsSet.has(item.id)) {
                return executeItems.shift() || item;
              } else {
                return sortedCandidateItems.shift() || item;
              }
            });

            return { ...prev, [activeEventName]: newItems };
          });
        }
      } else {
        setEventLists((prev) => {
          const currentItems = [...(prev[activeEventName] || [])];
          const selectedItems = currentItems.filter((item) =>
            selectedItemIds.has(item.id),
          );
          const otherItems = currentItems.filter(
            (item) => !selectedItemIds.has(item.id),
          );

          selectedItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, {
              numeric: true,
              sensitivity: "base",
            });
            return direction === "asc" ? comparison : -comparison;
          });

          const firstSelectedIndex = currentItems.findIndex((item) =>
            selectedItemIds.has(item.id),
          );
          if (firstSelectedIndex === -1) return prev;

          const newItems = [...otherItems];
          newItems.splice(firstSelectedIndex, 0, ...selectedItems);

          return { ...prev, [activeEventName]: newItems };
        });
      }
    },
    [
      activeEventName,
      selectedItemIds,
      items,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      clearRangeSelection,
    ],
  );

  const handleExportEvent = useCallback(
    (eventName: string) => {
      const itemsToExport = eventLists[eventName];
      if (!hasExportableItems(itemsToExport)) {
        alert("出力できるアイテムがありません。");
        return;
      }
      setExportEventName(eventName);
      setShowExportOptions(true);
    },
    [eventLists],
  );

  const buildCurrentAppData = useCallback(
    (): AppData => ({
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
    }),
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
    ],
  );

  const handleBackupExport = useCallback(() => {
    try {
      const currentData = buildCurrentAppData();
      const backup = createAppBackup(currentData, new Date(), {
        blockDetectionSettings: readBlockDetectionSettingsStoreForBackup(
          Object.keys(currentData.eventLists),
        ),
      });
      const blob = new Blob([serializeAppBackup(backup)], {
        type: "application/json;charset=utf-8",
      });
      const timestamp = backup.exportedAt.replace(/[:.]/g, "-");
      downloadBlob(blob, `event-shopping-planner-backup-${timestamp}.json`);
    } catch (error) {
      console.error("Backup export error:", error);
      alert(
        `バックアップを完全に保存できなかったため、ファイルを作成しませんでした。現在のデータは変更されていません。${
          error instanceof Error ? `\n理由: ${error.message}` : ""
        }`,
      );
    }
  }, [buildCurrentAppData]);

  const handleBackupRestoreRequest = useCallback(() => {
    backupFileInputRef.current?.click();
  }, []);

  const handleBackupFileImport = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      try {
        const result = parseAppBackup(await file.text());
        if (!result.ok) {
          alert(
            `バックアップを読み込めませんでした。\n${result.errors.join("\n")}`,
          );
          return;
        }
        if (Object.keys(result.data.eventLists).length === 0) {
          alert("このバックアップには復元できるイベントがありません。");
          return;
        }
        setPendingBackup(result.backup);
      } catch (error) {
        console.error("Backup import error:", error);
        alert(
          "バックアップを読み込めませんでした。JSONバックアップファイルを選び直してください。",
        );
      }
    },
    [],
  );

  const handleBackupRestore = useCallback(
    async (sourceEventName: string, targetEventName: string) => {
      if (!pendingBackup) {
        throw new Error("復元するバックアップをもう一度選んでください。");
      }

      const nextData = buildEventRestoreData(
        buildCurrentAppData(),
        pendingBackup.data,
        sourceEventName,
        targetEventName,
      );
      const restoredValues: PersistedStateValues = {
        eventLists: nextData.eventLists as Record<string, ShoppingItem[]>,
        eventMetadata: nextData.eventMetadata as Record<string, EventMetadata>,
        executeModeItems: nextData.executeModeItems as Record<
          string,
          ExecuteModeItems
        >,
        dayModes: nextData.dayModes as Record<string, DayModeState>,
        mapData: nextData.mapData as MapDataStore,
        mapRotationSettings:
          nextData.mapRotationSettings as MapRotationSettingsStore,
        routeSettings: nextData.routeSettings as RouteSettingsStore,
        hallDefinitions: nextData.hallDefinitions as HallDefinitionsStore,
        hallRouteSettings: nextData.hallRouteSettings as HallRouteSettingsStore,
        mapViewportSettings:
          nextData.mapViewportSettings as MapViewportSettingsStore,
      };

      try {
        const restoredBlockDetectionSettings =
          pendingBackup.eventSettings.blockDetectionSettings[sourceEventName] ??
          null;
        await runExclusiveRestore(restoredValues, () =>
          runWithBlockDetectionSettingsRestore(
            targetEventName,
            restoredBlockDetectionSettings,
            () => db.restoreAppDataAtomically(nextData),
          ),
        );
      } catch (error) {
        console.error("Atomic backup restore error:", error);
        if (error instanceof BlockDetectionSettingsRollbackError) {
          throw new Error(
            "イベント本体は復元前のままですが、マップのブロック検出設定だけ元に戻せなかった可能性があります。次回のマップ取り込み前に検出設定を確認してください。",
          );
        }
        throw new Error(
          "復元を完了できませんでした。現在のデータは変更されていません。",
        );
      }

      setEventLists(restoredValues.eventLists);
      setEventMetadata(restoredValues.eventMetadata);
      setExecuteModeItemsCommitted(restoredValues.executeModeItems);
      setDayModes(restoredValues.dayModes);
      setMapData(restoredValues.mapData);
      setMapRotationSettings(restoredValues.mapRotationSettings);
      setRouteSettings(restoredValues.routeSettings);
      setHallDefinitions(restoredValues.hallDefinitions);
      setHallRouteSettings(restoredValues.hallRouteSettings);
      setMapViewportSettings(restoredValues.mapViewportSettings);

      const restoredItems = nextData.eventLists[
        targetEventName
      ] as ShoppingItem[];
      setActiveEventName(targetEventName);
      setActiveTab(resolveEventListTab(restoredItems) ?? "eventList");
      setMapViewActive(false);
      clearSelection();
      setPendingBackup(null);
    },
    [
      buildCurrentAppData,
      clearSelection,
      pendingBackup,
      runExclusiveRestore,
      setExecuteModeItemsCommitted,
    ],
  );

  const handleConfirmExport = useCallback(
    async (options: ExportOptions) => {
      if (!exportEventName) return;

      const itemsToExport = eventLists[exportEventName];
      if (!hasExportableItems(itemsToExport)) {
        return;
      }

      try {
        const { blob, filename } = await buildEventExportFile(
          exportEventName,
          itemsToExport,
          options,
          eventMetadata[exportEventName],
          {
            executeModeItems,
            dayModes,
            mapData,
            routeSettings,
            hallDefinitions,
            hallRouteSettings,
          },
        );

        downloadBlob(blob, filename);
      } catch (error) {
        console.error("Export error:", error);
        alert("アイテムの出力に失敗しました。");
      }

      setExportEventName(null);
    },
    [
      eventLists,
      executeModeItems,
      eventMetadata,
      dayModes,
      mapData,
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
      exportEventName,
    ],
  );

  const handleExportFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      e.target.value = "";

      try {
        const result = await importFromXlsx(file);

        if (!result.success) {
          alert(`インポートに失敗しました:\n${result.errors.join("\n")}`);
          return;
        }

        const fallbackWarnings = result.itemFallbackWarnings || [];
        const skippedItemIds = new Set<string>();
        const BULK_APPROVAL_THRESHOLD = 6;

        const describeFallbackWarning = (
          warning: ItemFallbackWarning,
        ): string =>
          `${warning.rowNumber}行目\n${warning.reasons.map((reason) => `- ${reason}`).join("\n")}`;

        if (fallbackWarnings.length >= BULK_APPROVAL_THRESHOLD) {
          const previewLines = fallbackWarnings
            .slice(0, 5)
            .map(
              (warning) =>
                `- ${warning.rowNumber}行目: ${warning.reasons[0] || "補完が必要です"}`,
            );
          const previewText = previewLines.join("\n");
          const hasMore = fallbackWarnings.length > 5 ? "\n- ..." : "";

          const complementAll = window.confirm(
            `不正データが${fallbackWarnings.length}件見つかりました。\n${previewText}${hasMore}\n\nOK: すべて補完して取り込む\nキャンセル: すべてスキップ`,
          );

          if (!complementAll) {
            fallbackWarnings.forEach((warning) => {
              skippedItemIds.add(warning.itemId);
            });
          }
        } else {
          for (const warning of fallbackWarnings) {
            const shouldComplement = window.confirm(
              `不正データを検出しました。\n${describeFallbackWarning(warning)}\n\nOK: この行を補完して取り込む\nキャンセル: この行をスキップ`,
            );
            if (!shouldComplement) {
              skippedItemIds.add(warning.itemId);
            }
          }
        }

        const resolvedItems = result.items.filter(
          (item) => !skippedItemIds.has(item.id),
        );
        if (resolvedItems.length === 0) {
          if (result.items.length > 0 && skippedItemIds.size > 0) {
            alert(
              "不正データをすべてスキップしたため、取り込み対象がありませんでした。",
            );
          } else {
            alert("取り込んだファイルにアイテムが見つかりませんでした。");
          }
          return;
        }

        const fallbackResolutionMessages: string[] = [];
        if (fallbackWarnings.length > 0) {
          const skippedCount = skippedItemIds.size;
          const complementedCount = fallbackWarnings.length - skippedCount;
          if (complementedCount > 0) {
            fallbackResolutionMessages.push(
              `不正データ${complementedCount}件を補完して取り込みました。`,
            );
          }
          if (skippedCount > 0) {
            fallbackResolutionMessages.push(
              `不正データ${skippedCount}件をスキップしました。`,
            );
          }
        }
        const legacySheetFieldFallbackMessage =
          buildLegacySheetFieldFallbackMessage({
            fallbacks: result.legacySheetFieldFallbacks || [],
            skippedItemIds,
          });
        if (legacySheetFieldFallbackMessage) {
          fallbackResolutionMessages.push(legacySheetFieldFallbackMessage);
        }

        const resolvedResult = {
          ...result,
          items: resolvedItems,
          errors: [...result.errors, ...fallbackResolutionMessages],
        };

        if (resolvedResult.items.length === 0) {
          alert("取り込んだファイルにアイテムが見つかりませんでした。");
          return;
        }

        const importedData = toImportedEventData(resolvedResult);
        const eventName = importedData.eventName;
        const isUpdate = !!eventLists[eventName];

        setEventLists((prev) =>
          upsertRecordKey(prev, eventName, importedData.items),
        );

        if (importedData.metadata) {
          const metadata = importedData.metadata;
          setEventMetadata((prev) =>
            upsertRecordKey(prev, eventName, metadata),
          );
        }

        if (importedData.executeModeItems) {
          const executeItems = importedData.executeModeItems;
          updateExecuteModeItems((prev) =>
            upsertRecordKey(prev, eventName, executeItems),
          );
        }
        if (importedData.dayModes) {
          const importedDayModes = importedData.dayModes;
          setDayModes((prev) =>
            upsertRecordKey(prev, eventName, importedDayModes),
          );
        }

        if (importedData.mapData) {
          const importedMapData = importedData.mapData;
          setMapData((prev) =>
            upsertRecordKey(prev, eventName, importedMapData),
          );
        }

        if (importedData.routeSettings) {
          const importedRouteSettings = importedData.routeSettings;
          setRouteSettings((prev) =>
            upsertRecordKey(prev, eventName, importedRouteSettings),
          );
        }

        if (importedData.hallDefinitions) {
          const importedHallDefinitions = importedData.hallDefinitions;
          setHallDefinitions((prev) =>
            upsertRecordKey(prev, eventName, importedHallDefinitions),
          );
        }

        if (importedData.hallRouteSettings) {
          const importedHallRouteSettings = importedData.hallRouteSettings;
          setHallRouteSettings((prev) =>
            upsertRecordKey(prev, eventName, importedHallRouteSettings),
          );
        }

        alert(
          buildImportCompletionMessage({
            errors: importedData.errors,
            eventName,
            isUpdate,
            itemCount: importedData.items.length,
          }),
        );

        const nextTab = resolveEventListTab(importedData.items);
        if (!nextTab) {
          alert("参加日がないため処理を停止しました。");
          return;
        }
        setActiveEventName(eventName);
        setActiveTab(nextTab);
      } catch (error) {
        console.error("Import error:", error);
        alert(
          "アイテムの取り込みに失敗しました。ファイル形式を確認してください。",
        );
      }
    },
    [eventLists],
  );

  const previewEventUpdate = useCallback(
    async ({
      kind,
      eventName,
      source,
      onError,
    }: {
      kind: PendingEventUpdate["kind"];
      eventName: string;
      source: SpreadsheetSource;
      onError: (error: unknown) => void;
    }) => {
      eventUpdatePreviewEpochRef.current += 1;
      setPendingEventUpdate(null);
      pendingEventUpdateBaseItemsRef.current = null;

      const currentItems = eventLists[eventName];
      if (!currentItems) return;
      const requestEpoch = eventUpdatePreviewEpochRef.current;
      const isCurrentRequest = () =>
        eventUpdatePreviewEpochRef.current === requestEpoch &&
        eventListsRef.current[eventName] === currentItems;

      await settleEventUpdatePreviewIfCurrent({
        loadPreview: () =>
          buildEventUpdateDiffFromSpreadsheet(currentItems, source),
        isCurrent: isCurrentRequest,
        commit: (updateDiff) => {
          pendingEventUpdateBaseItemsRef.current = currentItems;
          setPendingEventUpdate(
            kind === "source-switch"
              ? {
                  kind,
                  eventName,
                  diff: updateDiff,
                  nextSource: source,
                }
              : {
                  kind,
                  eventName,
                  diff: updateDiff,
                },
          );
        },
        onError,
      });
    },
    [eventLists],
  );

  const handleUpdateEvent = useCallback(
    async (eventName: string) => {
      const source = resolveSpreadsheetSource(eventMetadata[eventName]);
      if (!source) {
        eventUpdatePreviewEpochRef.current += 1;
        setPendingUpdateEventName(eventName);
        setShowUrlUpdateDialog(true);
        return;
      }

      await previewEventUpdate({
        kind: "items-only",
        eventName,
        source,
        onError: (error) => {
          console.error("Update error:", error);
          setPendingUpdateEventName(eventName);
          setShowUrlUpdateDialog(true);
        },
      });
    },
    [eventMetadata, previewEventUpdate],
  );

  const handleDuplicateEventResolution = useCallback(
    async (resolution: DuplicateEventResolution) => {
      const pending = pendingDuplicateEvent;
      if (!pending) return;
      eventUpdatePreviewEpochRef.current += 1;
      setPendingDuplicateEvent(null);

      if (resolution.action === "create-alias") {
        const nextMetadata: BulkAddMetadata | undefined = resolution.source
          ? {
              ...pending.metadata,
              url: resolution.source.url,
              sheetName: resolution.source.sheetName,
              source: "spreadsheet",
            }
          : pending.metadata;
        applyBulkAdd(resolution.eventName, resolution.items, nextMetadata);
        return;
      }

      if (resolution.action === "append-fixed-items") {
        if (resolution.items.length === 0) {
          alert(
            `追加できる新しい品目はありません。完全一致の${resolution.duplicateItemCount}件は追加対象から除かれました。`,
          );
        } else {
          applyBulkAdd(resolution.eventName, resolution.items, {
            source: "app",
          });
        }
        return;
      }

      if (resolution.action === "open-update") {
        await previewEventUpdate({
          kind: "items-only",
          eventName: resolution.eventName,
          source: {
            url: resolution.source.url,
            sheetName: resolution.source.sheetName,
          },
          onError: (error) => {
            console.error("Update error:", error);
            setPendingUpdateEventName(resolution.eventName);
            setShowUrlUpdateDialog(true);
          },
        });
        return;
      }

      await previewEventUpdate({
        kind: "source-switch",
        eventName: resolution.eventName,
        source: {
          url: resolution.source.url,
          sheetName: resolution.source.sheetName,
        },
        onError: (error) => {
          console.error("Source switch preview error:", error);
          alert(
            "新しい更新元の内容を確認できなかったため、更新元も品目も変更していません。",
          );
        },
      });
    },
    [applyBulkAdd, pendingDuplicateEvent, previewEventUpdate],
  );

  const handleDuplicateEventCancel = useCallback(() => {
    eventUpdatePreviewEpochRef.current += 1;
    setPendingDuplicateEvent(null);
  }, []);

  const handleCancelUpdate = useCallback(() => {
    setPendingEventUpdate(null);
  }, []);

  const handleConfirmUpdate = useCallback(
    (options: EventUpdateApplyOptions) => {
      if (!pendingEventUpdate) return;

      const nextState = applyPendingEventUpdate({
        state: {
          eventLists: eventListsRef.current,
          eventMetadata: eventMetadataRef.current,
          executeModeItems: executeModeItemsRef.current,
        },
        pending: pendingEventUpdate,
        baseItems: pendingEventUpdateBaseItemsRef.current,
        options,
      });
      if (!nextState) {
        setPendingEventUpdate(null);
        alert(
          "確認中にイベントの品目が変更または削除されたため、更新元も品目も変更していません。もう一度更新してください。",
        );
        return;
      }

      commitEventLists(nextState.eventLists);
      commitEventMetadata(nextState.eventMetadata);
      commitExecuteModeItems(nextState.executeModeItems);

      pendingEventUpdateBaseItemsRef.current = null;
      setPendingEventUpdate(null);
      alert("アイテムを更新しました。");
    },
    [
      commitEventLists,
      commitEventMetadata,
      commitExecuteModeItems,
      pendingEventUpdate,
    ],
  );

  const handleUrlUpdate = useCallback(
    async (newUrl: string, sheetName: string) => {
      setShowUrlUpdateDialog(false);
      if (!pendingUpdateEventName) return;

      const eventName = pendingUpdateEventName;
      const currentMetadata = eventMetadata[eventName];
      const normalizedSheetName =
        sheetName || currentMetadata?.spreadsheetSheetName || "";

      setPendingUpdateEventName(null);
      await previewEventUpdate({
        kind: "source-switch",
        eventName,
        source: {
          url: newUrl,
          sheetName: normalizedSheetName,
        },
        onError: (error) => {
          console.error("Update error:", error);
          setPendingUpdateEventName(eventName);
          setShowUrlUpdateDialog(true);
        },
      });
    },
    [pendingUpdateEventName, eventMetadata, previewEventUpdate],
  );

  const handleImportMapData = useCallback(async (eventName: string) => {
    if (mapFileInputRef.current) {
      mapFileInputRef.current.dataset.eventName = eventName;
      mapFileInputRef.current.click();
    }
  }, []);

  const handleMapFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const eventName = e.target.dataset.eventName;

      if (!file || !eventName) return;

      setMapImportPendingFile(file);
      setMapImportPendingEventName(eventName);
      setMapImportDialogOpen(true);

      e.target.value = "";
    },
    [],
  );

  const commitPreparedMapImport = useCallback(
    (preparedImport: PreparedMapImport, options: MapReimportOptions) => {
      commitPreparedMapImportFlow({
        state: {
          eventLists,
          executeModeItems,
          mapData,
          mapRotationSettings,
          routeSettings,
          hallDefinitions,
          hallRouteSettings,
          mapViewportSettings,
        },
        preparedImport,
        options,
        effects: {
          setEventLists,
          setMapData,
          setMapRotationSettings,
          setRouteSettings,
          setHallDefinitions,
          setHallRouteSettings,
          setMapViewportSettings,
          saveBlockDetectionSettings,
          activateTarget: (eventName, mapTabName) => {
            setActiveEventName(eventName);
            setActiveTab(mapTabName);
          },
          finishImport: () => {
            setPendingMapReimport(null);
            setMapImportDialogOpen(false);
            setMapImportPendingFile(null);
            setMapImportPendingEventName("");
          },
          notify: (message) => alert(message),
        },
      });
    },
    [
      eventLists,
      executeModeItems,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      mapRotationSettings,
      mapViewportSettings,
      routeSettings,
      setEventLists,
    ],
  );

  const handleMapImportConfirm = useCallback(
    (
      parsedData: Record<string, DayMapData>,
      settings: BlockDetectionSettings,
      initialAngles: Record<string, number>,
    ) => {
      const eventName = mapImportPendingEventName;
      if (!eventName) return;

      const eventDatesForTargetEvent = extractEventDates(
        eventLists[eventName] || [],
      );
      const skippedDays = new Set<string>();
      const targets: {
        eventDate: string;
        mapTabName: string;
        mapData: DayMapData;
        initialAngle: number;
      }[] = [];

      Object.entries(parsedData).forEach(([mapName, dayMapData]) => {
        const normalizedMapDay = normalizeMapDayToken(mapName);
        const eventDate = eventDatesForTargetEvent.find(
          (candidate) => normalizeMapDayToken(candidate) === normalizedMapDay,
        );
        if (!eventDate) {
          skippedDays.add(normalizedMapDay || mapName);
          return;
        }

        targets.push({
          eventDate,
          mapTabName: `${eventDate}マップ`,
          mapData: dayMapData,
          initialAngle: initialAngles[mapName] ?? 0,
        });
      });

      if (targets.length === 0) {
        const skippedMessages = Array.from(skippedDays)
          .sort((a, b) => a.localeCompare(b, "ja"))
          .map((dayName) => `${dayName}はないので取り込みしませんでした`);
        alert(
          skippedMessages.length > 0
            ? skippedMessages.join("\n")
            : "取り込める対象日のマップがありません。",
        );
        setMapImportDialogOpen(false);
        setMapImportPendingFile(null);
        setMapImportPendingEventName("");
        return;
      }

      try {
        const plan = buildMapReimportPlan({
          state: {
            eventLists,
            executeModeItems,
            mapData,
            mapRotationSettings,
            routeSettings,
            hallDefinitions,
            hallRouteSettings,
            mapViewportSettings,
          },
          eventName,
          targets,
        });
        const preparedImport = {
          plan,
          settings,
          skippedDays: Array.from(skippedDays),
        };
        dispatchPreparedMapImport(preparedImport, {
          requestConfirmation: (pendingImport) => {
            setPendingMapReimport(pendingImport);
            setMapImportDialogOpen(false);
            setMapImportPendingFile(null);
          },
          commit: commitPreparedMapImport,
        });
      } catch (error) {
        console.error("Map reimport planning error:", error);
        alert(
          error instanceof Error
            ? error.message
            : "マップを取り込む準備に失敗しました。",
        );
      }
    },
    [
      commitPreparedMapImport,
      eventLists,
      executeModeItems,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      mapImportPendingEventName,
      mapRotationSettings,
      mapViewportSettings,
      routeSettings,
    ],
  );

  const handleMapReimportConfirm = useCallback(
    (options: MapReimportOptions) => {
      if (!pendingMapReimport) return;
      commitPreparedMapImport(pendingMapReimport, options);
    },
    [commitPreparedMapImport, pendingMapReimport],
  );

  const handleMapReimportCancel = useCallback(() => {
    cancelPendingMapImport({
      clearPendingImport: () => setPendingMapReimport(null),
      clearPendingFile: () => setMapImportPendingFile(null),
      clearPendingEventName: () => setMapImportPendingEventName(""),
    });
  }, []);

  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName("");
  }, []);

  const handleAddToExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (
        !activeEventName ||
        !isMapTab ||
        !currentMapTabName ||
        !activeEventDate
      )
        return [];

      const dayName = activeEventDate;
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[
        currentMapTabName
      ] || {
        hallOrder: [],
        hallVisitLists: [],
      };
      const currentMapData = mapData[activeEventName]?.[currentMapTabName];

      const currentForEvent =
        executeModeItemsRef.current[activeEventName] || {};
      const result = computeAddToExecuteListFromMapWithResult(
        itemId,
        dayName,
        items,
        currentForEvent,
        halls,
        hallRouteSettingsForMap,
        currentMapData,
      );

      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.insertedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      currentMapTabName,
      isMapTab,
      items,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      commitExecuteModeItemsForEvent,
    ],
  );

  const handleAddToExecuteListFromMapAtPosition = useCallback(
    (itemId: string, referenceItemId: string, position: "before" | "after") => {
      if (!activeEventName || !isMapTab || !activeEventDate) return [];

      const dayName = activeEventDate;
      const currentForEvent =
        executeModeItemsRef.current[activeEventName] || {};
      const result = computeInsertIntoExecuteAtPosition(
        [itemId],
        referenceItemId,
        position,
        currentForEvent,
        dayName,
        items,
        {
          canInsertWithReference: (insertedItemId, refId) =>
            areItemsInSameHallGroup(insertedItemId, refId, dayName),
        },
      );
      if (!result.accepted) return [];

      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.insertedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      isMapTab,
      items,
      areItemsInSameHallGroup,
      commitExecuteModeItemsForEvent,
    ],
  );

  const handleRemoveFromExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;

      const dayName = activeEventDate;
      const currentForEvent =
        executeModeItemsRef.current[activeEventName] || {};
      const result = computeRemoveFromExecuteListFromMapWithResult(
        [itemId],
        currentForEvent,
        dayName,
        items,
      );

      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.removedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      isMapTab,
      items,
      commitExecuteModeItemsForEvent,
    ],
  );

  const handleBatchAddToExecuteListFromMap = useCallback(
    (itemIds: string[]) => {
      if (
        !activeEventName ||
        !isMapTab ||
        !currentMapTabName ||
        !activeEventDate
      )
        return [];
      const dayName = activeEventDate;
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[
        currentMapTabName
      ] || {
        hallOrder: [],
        hallVisitLists: [],
      };
      const currentMap = mapData[activeEventName]?.[currentMapTabName];

      {
        let current = executeModeItemsRef.current[activeEventName] || {};
        const insertedItemIds: string[] = [];
        for (const id of itemIds) {
          const result = computeAddToExecuteListFromMapWithResult(
            id,
            dayName,
            items,
            current,
            halls,
            hallRouteSettingsForMap,
            currentMap,
          );
          if (result.accepted) {
            current = result.executeModeItems;
            insertedItemIds.push(...result.insertedItemIds);
          }
        }
        commitExecuteModeItemsForEvent(activeEventName, current);
        return insertedItemIds;
      }
    },
    [
      activeEventName,
      activeEventDate,
      currentMapTabName,
      isMapTab,
      items,
      hallDefinitions,
      hallRouteSettings,
      mapData,
      commitExecuteModeItemsForEvent,
    ],
  );

  const handleBatchAddToExecuteListFromMapAtPosition = useCallback(
    (
      itemIds: string[],
      referenceItemId: string,
      position: "before" | "after",
    ) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return [];
      const dayName = activeEventDate;

      const current = executeModeItemsRef.current[activeEventName] || {};
      const result = computeInsertIntoExecuteAtPosition(
        itemIds,
        referenceItemId,
        position,
        current,
        dayName,
        items,
        {
          canInsertWithReference: (insertedItemId, refId) =>
            areItemsInSameHallGroup(insertedItemId, refId, dayName),
        },
      );
      if (!result.accepted) return [];
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.insertedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      isMapTab,
      items,
      areItemsInSameHallGroup,
      commitExecuteModeItemsForEvent,
    ],
  );

  const handleBatchRemoveFromExecuteListFromMap = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      const dayName = activeEventDate;

      const currentForEvent =
        executeModeItemsRef.current[activeEventName] || {};
      const result = computeRemoveFromExecuteListFromMapWithResult(
        itemIds,
        currentForEvent,
        dayName,
        items,
      );
      commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems);
      return result.removedItemIds;
    },
    [
      activeEventName,
      activeEventDate,
      isMapTab,
      items,
      commitExecuteModeItemsForEvent,
    ],
  );

  const handleAddNewItemFromMap = useCallback(
    (eventDate: string, block: string, number: string) => {
      setNewItemDefaults({ eventDate, block, number });
      setItemToEdit(null);
      setActiveTab("import");
    },
    [],
  );

  const handleAddItemFromFocusMode = useCallback(
    (
      newItem: Omit<ShoppingItem, "id"> & { purchaseStatus?: PurchaseStatus },
    ) => {
      if (!activeEventName) return;

      const result = computeAddItemFromFocusMode(
        eventLists[activeEventName] || [],
        newItem,
        executeModeItemsRef.current[activeEventName] || {},
      );

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: result.executeModeItems,
      }));
    },
    [activeEventName, eventLists, executeModeItems],
  );

  const handleMoveToFirstFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      if (!activeEventDate) return;
      const dayName = activeEventDate;

      updateExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = (eventItems[dayName] || []).filter(
          (id) => id !== itemId,
        );

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: [itemId, ...dayItems],
          },
        };
      });
    },
    [activeEventName, activeEventDate, isMapTab],
  );

  const handleMoveToLastFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      if (!activeEventDate) return;
      const dayName = activeEventDate;

      updateExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = (eventItems[dayName] || []).filter(
          (id) => id !== itemId,
        );

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: [...dayItems, itemId],
          },
        };
      });
    },
    [activeEventName, activeEventDate, isMapTab],
  );

  const currentMapExecuteItemIds = useMemo(() => {
    if (!activeEventName || !isMapTab || !activeEventDate) return [];

    const dayName = activeEventDate;

    return executeModeItems[activeEventName]?.[dayName] || [];
  }, [activeEventName, activeEventDate, isMapTab, executeModeItems]);

  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter((item) => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

  const [mapTabMenuOpen, setMapTabMenuOpen] = useState<string | null>(null);
  const [mapTabMenuPosition, setMapTabMenuPosition] = useState<{
    left: number;
    top: number;
  }>({
    left: 0,
    top: 0,
  });

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
  }, [mapTabMenuOpen]);

  const [visitListPanelOpen, setVisitListPanelOpen] = useState(false);
  const [visitListPanelMapTab, setVisitListPanelMapTab] = useState<
    string | null
  >(null);
  const [visitListHasUnsavedChanges, setVisitListHasUnsavedChanges] =
    useState(false);
  const [visitListOriginalOrder, setVisitListOriginalOrder] = useState<
    string[]
  >([]);
  const [highlightedMapCell, setHighlightedMapCell] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const [showVisitListConfirmDialog, setShowVisitListConfirmDialog] =
    useState(false);
  const [pendingTabChange, setPendingTabChange] = useState<string | null>(null);
  const [blockDefinitionMode, setBlockDefinitionMode] = useState(false);

  const [mapSelectedHallId, setMapSelectedHallId] = useState<string>("all");
  const [mapIsRouteVisible, setMapIsRouteVisible] = useState(true);
  const [mapIsHallOrderOpen, setMapIsHallOrderOpen] = useState(false);
  const [mapHallSelectorOpen, setMapHallSelectorOpen] = useState(false);
  const [mapSmartInsertEnabled, setMapSmartInsertEnabled] = useState<boolean>(
    () => {
      try {
        const saved = localStorage.getItem("mapSmartInsertEnabled");
        return saved !== null ? saved === "true" : true;
      } catch {
        return true;
      }
    },
  );
  const [mapSmartInsertMode, setMapSmartInsertMode] = useState<SmartInsertMode>(
    () => {
      try {
        return normalizeSmartInsertMode(
          localStorage.getItem("mapSmartInsertMode"),
        );
      } catch {
        return "map";
      }
    },
  );
  const [smartInsertToast, setSmartInsertToast] = useState<string | null>(null);
  const [smartInsertToastType, setSmartInsertToastType] = useState<
    "success" | "error"
  >("success");
  const smartInsertLongPressRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const smartInsertLongPressTriggeredRef = React.useRef(false);

  const showSmartInsertToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      setSmartInsertToastType(type);
      setSmartInsertToast(message);
    },
    [],
  );

  React.useEffect(() => {
    try {
      localStorage.setItem(
        "mapSmartInsertEnabled",
        String(mapSmartInsertEnabled),
      );
    } catch (error) {
      console.error("Failed to persist mapSmartInsertEnabled:", error);
      showSmartInsertToast("スマート挿入設定の保存に失敗しました。", "error");
    }
  }, [mapSmartInsertEnabled, showSmartInsertToast]);

  React.useEffect(() => {
    try {
      localStorage.setItem("mapSmartInsertMode", mapSmartInsertMode);
    } catch (error) {
      console.error("Failed to persist mapSmartInsertMode:", error);
      showSmartInsertToast("スマート挿入モードの保存に失敗しました。", "error");
    }
  }, [mapSmartInsertMode, showSmartInsertToast]);

  React.useEffect(() => {
    if (smartInsertToast) {
      const timer = setTimeout(() => setSmartInsertToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [smartInsertToast]);

  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: "corner" | "multiCorner" | "rangeStart" | "individual";
    clickedCells: { row: number; col: number }[];
    editingBlockData?: unknown;
  } | null>(null);

  const [pendingCellSelection, setPendingCellSelection] = useState<{
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  const openVisitListPanel = useCallback(
    (mapTab: string) => {
      if (!activeEventName) return;

      const dayMatch = mapTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(mapTab);
      setVisitListHasUnsavedChanges(false);
      setVisitListPanelOpen(true);
    },
    [activeEventName, executeModeItems],
  );

  React.useEffect(() => {
    if (
      !visitListPanelOpen ||
      !isMapTab ||
      !activeEventName ||
      !currentMapTabName
    )
      return;
    if (visitListPanelMapTab !== currentMapTabName) {
      if (visitListHasUnsavedChanges) {
        setVisitListHasUnsavedChanges(false);
      }
      if (!activeEventDate) return;
      const dayName = activeEventDate;
      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(currentMapTabName);
      setVisitListHasUnsavedChanges(false);
    }
  }, [
    currentMapTabName,
    isMapTab,
    activeEventName,
    visitListPanelOpen,
    visitListPanelMapTab,
    visitListHasUnsavedChanges,
    executeModeItems,
  ]);

  const handleVisitListOrderUpdate = useCallback(
    (newOrderItems: ShoppingItem[]) => {
      if (!visitListPanelMapTab || !activeEventName) return;

      const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      const newIds = newOrderItems.map((item) => item.id);

      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [dayName]: newIds,
        },
      }));
      setVisitListHasUnsavedChanges(true);
    },
    [visitListPanelMapTab, activeEventName],
  );

  const handleVisitListConfirm = useCallback(() => {
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, []);

  const handleVisitListCancel = useCallback(() => {
    if (!visitListPanelMapTab || !activeEventName) return;

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];

    if (visitListOriginalOrder.length > 0) {
      updateExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [dayName]: [...visitListOriginalOrder],
        },
      }));
    }
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, [visitListOriginalOrder, visitListPanelMapTab, activeEventName]);

  const handleVisitListClose = useCallback(() => {
    setVisitListPanelOpen(false);
  }, []);

  const handleHighlightMapCell = useCallback((row: number, col: number) => {
    setHighlightedMapCell({ row, col });
  }, []);

  const handleClearMapCellHighlight = useCallback(() => {
    setHighlightedMapCell(null);
  }, []);

  const visitListItems = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    const dayItems = items.filter((item) => item.eventDate === dayName);
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

    return executeIds
      .filter((id: string) => dayItems.some((item) => item.id === id))
      .map((id: string) => dayItems.find((item) => item.id === id)!)
      .filter(Boolean);
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

  const handleUpdateItemPriority = useCallback(
    (itemId: string, priorityLevel: "none" | "priority" | "highest") => {
      if (!activeEventName || !visitListPanelMapTab) return;

      const halls =
        hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
      const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];
      const currentSettings = hallRouteSettings[activeEventName]?.[
        visitListPanelMapTab
      ] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      const result = computeUpdateItemPriority(
        itemId,
        priorityLevel,
        items,
        halls,
        mapDataForTab,
        currentSettings,
      );

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [visitListPanelMapTab]: result.hallRouteSettings,
        },
      }));

      const item = items.find((i) => i.id === itemId);
      if (item) {
        const dayName = item.eventDate;
        updateExecuteModeItems((prev) => {
          const currentExecItems = prev[activeEventName] || {};
          const reordered = reorderExecuteIdsForSpaceAdjacency(
            itemId,
            result.items,
            currentExecItems,
            dayName,
          );
          return {
            ...prev,
            [activeEventName]: reordered,
          };
        });
      }
    },
    [
      activeEventName,
      visitListPanelMapTab,
      items,
      hallDefinitions,
      mapData,
      hallRouteSettings,
    ],
  );

  const handleUpdateItemPriorityFromEdit = useCallback(
    (itemId: string, priorityLevel: "none" | "priority" | "highest") => {
      if (!activeEventName) return;

      const currentItems = eventLists[activeEventName] || [];
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;

      const resolvedHallId = getItemHallId(item, item.eventDate);
      const mapTabForItem = getMapTabForDate(item.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] || []).map(
              (h) => h.id,
            )
          : [],
      );
      const targetKey: string =
        resolvedHallId && mapHallIds.has(resolvedHallId)
          ? (mapTabForItem as string)
          : getMaplessKey(item.eventDate);

      const targetHalls = hallDefinitions[activeEventName]?.[targetKey] || [];
      const targetMapData = targetKey.startsWith(MAPLESS_HALL_KEY)
        ? undefined
        : mapData[activeEventName]?.[targetKey];
      const targetSettings = hallRouteSettings[activeEventName]?.[
        targetKey
      ] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      const result = computeUpdateItemPriority(
        itemId,
        priorityLevel,
        currentItems,
        targetHalls,
        targetMapData,
        targetSettings,
      );

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [targetKey]: result.hallRouteSettings,
        },
      }));

      const dayName = item.eventDate;
      updateExecuteModeItems((prev) => {
        const currentExecItems = prev[activeEventName] || {};
        const reordered = reorderExecuteIdsForSpaceAdjacency(
          itemId,
          result.items,
          currentExecItems,
          dayName,
        );
        return {
          ...prev,
          [activeEventName]: reordered,
        };
      });
    },
    [
      activeEventName,
      eventLists,
      hallDefinitions,
      mapData,
      hallRouteSettings,
      getItemHallId,
      getMapTabForDate,
    ],
  );

  const handleUpdateHallOrderForPriorityChangeFromEdit = useCallback(
    (
      itemId: string,
      newPriorityLevel: "none" | "priority" | "highest",
      oldPriorityLevel: "none" | "priority" | "highest",
    ) => {
      if (!activeEventName) return;

      const currentItems = eventLists[activeEventName] || [];
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;

      const resolvedHallId = getItemHallId(item, item.eventDate);

      const mapTabForItem = getMapTabForDate(item.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] || []).map(
              (h) => h.id,
            )
          : [],
      );
      const targetKey: string =
        resolvedHallId && mapHallIds.has(resolvedHallId)
          ? (mapTabForItem as string)
          : getMaplessKey(item.eventDate);

      const targetHalls = hallDefinitions[activeEventName]?.[targetKey] || [];
      const targetMapData = targetKey.startsWith(MAPLESS_HALL_KEY)
        ? undefined
        : mapData[activeEventName]?.[targetKey];
      const targetSettings = hallRouteSettings[activeEventName]?.[
        targetKey
      ] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      const itemsAfter = currentItems.map((i) =>
        i.id === itemId ? { ...i, priorityLevel: newPriorityLevel } : i,
      );

      const nextSettings = computeHallOrderForPriorityChange(
        itemId,
        newPriorityLevel,
        oldPriorityLevel,
        itemsAfter,
        targetHalls,
        targetMapData,
        targetSettings,
      );

      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [targetKey]: nextSettings,
        },
      }));

      const dayName = item.eventDate;
      updateExecuteModeItems((prev) => {
        const currentExecItems = prev[activeEventName] || {};
        const reordered = reorderExecuteIdsForSpaceAdjacency(
          itemId,
          itemsAfter,
          currentExecItems,
          dayName,
        );
        return {
          ...prev,
          [activeEventName]: reordered,
        };
      });
    },
    [
      activeEventName,
      eventLists,
      hallDefinitions,
      mapData,
      hallRouteSettings,
      getItemHallId,
      getMapTabForDate,
    ],
  );

  const handleTabChangeWithVisitListCheck = (newTab: string): boolean => {
    if (visitListPanelOpen && visitListHasUnsavedChanges) {
      setPendingTabChange(newTab);
      setShowVisitListConfirmDialog(true);
      return false;
    }
    return true;
  };

  const handleVisitListDialogConfirm = useCallback(() => {
    handleVisitListConfirm();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListConfirm, pendingTabChange]);

  const handleVisitListDialogCancel = useCallback(() => {
    handleVisitListCancel();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListCancel, pendingTabChange]);

  const handleUpdateBlocks = useCallback(
    (blocks: BlockDefinition[]) => {
      if (
        !activeEventName ||
        !isMapTab ||
        !currentMapData ||
        !currentMapTabName
      )
        return;

      setMapData((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [currentMapTabName]: {
            ...currentMapData,
            blocks,
          },
        },
      }));
    },
    [activeEventName, isMapTab, currentMapTabName, currentMapData],
  );

  const handleUpdateHalls = useCallback(
    (halls: HallDefinition[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      const { polygonHalls, maplessHalls } = splitHallsForStorage(halls);
      const maplessKey = activeEventDate
        ? getMaplessKey(activeEventDate)
        : null;

      setHallDefinitions((prev) =>
        updateHallDefinitionsForHalls({
          previous: prev,
          eventName: activeEventName,
          mapTabName: currentMapTabName,
          maplessKey,
          polygonHalls,
          maplessHalls,
        }),
      );

      setHallRouteSettings((prev) =>
        updateHallRouteSettingsForHalls({
          previous: prev,
          eventName: activeEventName,
          mapTabName: currentMapTabName,
          maplessKey,
          polygonHalls,
          maplessHalls,
        }),
      );
    },
    [activeEventName, activeEventDate, isMapTab, currentMapTabName],
  );

  const handleUpdateHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [currentMapTabName]: settings,
        },
      }));
    },
    [activeEventName, isMapTab, currentMapTabName],
  );

  const handleUpdateMaplessHalls = useCallback(
    (halls: HallDefinition[]) => {
      if (!activeEventName || !activeEventDate) return;

      const maplessKey = getMaplessKey(activeEventDate);

      setHallDefinitions((prev) =>
        updateMaplessHallDefinitions({
          previous: prev,
          eventName: activeEventName,
          maplessKey,
          halls,
        }),
      );

      setHallRouteSettings((prev) =>
        updateMaplessHallRouteSettings({
          previous: prev,
          eventName: activeEventName,
          maplessKey,
          halls,
        }),
      );
    },
    [activeEventName, activeEventDate],
  );

  const mapTabDates = useMemo(
    () => eventDates.filter((date) => !!getMapTabForDate(date)),
    [eventDates, getMapTabForDate],
  );

  const handleSyncMaplessHallsToOtherDates = useCallback(
    (targetDates: string[]) => {
      if (!activeEventName || !activeEventDate) return;

      const sourceKey = getMaplessKey(activeEventDate);
      const sourceHalls = hallDefinitions[activeEventName]?.[sourceKey] || [];
      if (sourceHalls.length === 0) return;

      const clonedByDate = cloneHallsForDates(sourceHalls, targetDates);

      setHallDefinitions((prev) => {
        const updated = {
          ...prev,
          [activeEventName]: { ...prev[activeEventName] },
        };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          updated[activeEventName][targetKey] = clonedByDate.get(date)!.halls;
        }
        return updated;
      });

      setHallRouteSettings((prev) => {
        const updated = {
          ...prev,
          [activeEventName]: { ...prev[activeEventName] },
        };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          const { idMap } = clonedByDate.get(date)!;
          const sourceSettings =
            prev[activeEventName]?.[sourceKey] || emptyHallRouteSettings();
          updated[activeEventName][targetKey] = remapHallRouteSettings(
            sourceSettings,
            idMap,
          );
        }
        return updated;
      });
    },
    [activeEventName, activeEventDate, hallDefinitions, hallRouteSettings],
  );

  const handleSyncPolygonHallsToOtherDates = useCallback(
    (targetDates: string[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      const sourceHalls =
        hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      if (sourceHalls.length === 0) return;

      const targetMapTabsByDate = new Map<string, string>();
      for (const date of targetDates) {
        const targetMapTab = getMapTabForDate(date);
        if (!targetMapTab) continue;
        targetMapTabsByDate.set(date, targetMapTab);
      }
      const clonedByDate = cloneHallsForDates(
        sourceHalls,
        Array.from(targetMapTabsByDate.keys()),
      );

      setHallDefinitions((prev) => {
        const updated = {
          ...prev,
          [activeEventName]: { ...prev[activeEventName] },
        };
        for (const [date, { halls }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date)!;
          updated[activeEventName][targetMapTab] = halls;
        }
        return updated;
      });

      setHallRouteSettings((prev) => {
        const updated = {
          ...prev,
          [activeEventName]: { ...prev[activeEventName] },
        };
        for (const [date, { idMap }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date)!;
          const sourceSettings =
            prev[activeEventName]?.[currentMapTabName] ||
            emptyHallRouteSettings();
          updated[activeEventName][targetMapTab] = remapHallRouteSettings(
            sourceSettings,
            idMap,
          );
        }
        return updated;
      });
    },
    [
      activeEventName,
      isMapTab,
      currentMapTabName,
      hallDefinitions,
      hallRouteSettings,
      getMapTabForDate,
    ],
  );

  const globalHallOrderMapTabName = useMemo(
    () => (activeEventDate ? getMapTabForDate(activeEventDate) : null),
    [activeEventDate, getMapTabForDate],
  );

  const hasUndefinedPriorityItems = useMemo((): boolean => {
    if (!activeEventName || !activeEventDate) return false;
    const ids = executeModeItems[activeEventName]?.[activeEventDate] || [];
    return ids.some((id) => {
      const it = items.find((i) => i.id === id);
      if (!it) return false;
      const p = it.priorityLevel || "none";
      return p === "priority" || p === "highest";
    });
  }, [activeEventName, activeEventDate, executeModeItems, items]);

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

  const globalHallOrderRouteSettings = useMemo((): HallRouteSettings => {
    const executeIds =
      activeEventName && activeEventDate
        ? executeModeItems[activeEventName]?.[activeEventDate] || []
        : [];
    return buildMergedHallRouteSettings({
      eventName: activeEventName,
      dayName: activeEventDate,
      mapTabName: globalHallOrderMapTabName,
      hallDefinitionsStore: hallDefinitions,
      hallRouteSettingsStore: hallRouteSettings,
      executeIds,
      items,
      mapDataStore: mapData,
    }).mergedSettings;
  }, [
    activeEventName,
    activeEventDate,
    globalHallOrderMapTabName,
    hallDefinitions,
    hallRouteSettings,
    executeModeItems,
    items,
    mapData,
  ]);

  // 統合順序の保存: hallIDごとにmap側/mapless側を判別して分離保存
  const handleUpdateGlobalHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName) return;

      const mapHallIds = new Set<string>(
        globalHallOrderMapTabName
          ? (
              hallDefinitions[activeEventName]?.[globalHallOrderMapTabName] ||
              []
            ).map((h) => h.id)
          : [],
      );
      const maplessKey = activeEventDate
        ? getMaplessKey(activeEventDate)
        : null;
      const maplessHallIds = new Set<string>(
        (maplessKey
          ? hallDefinitions[activeEventName]?.[maplessKey] || []
          : []
        ).map((h) => h.id),
      );

      const { mapSettings, maplessSettings } = splitGlobalHallRouteSettings({
        settings,
        mapHallIds,
        maplessHallIds,
        hasMapTab: !!globalHallOrderMapTabName,
      });

      setHallRouteSettings((prev) => {
        const eventSettings = { ...(prev[activeEventName] || {}) };
        if (globalHallOrderMapTabName) {
          eventSettings[globalHallOrderMapTabName] = mapSettings;
        }
        if (maplessKey) eventSettings[maplessKey] = maplessSettings;
        return {
          ...prev,
          [activeEventName]: eventSettings,
        };
      });
    },
    [
      activeEventName,
      activeEventDate,
      globalHallOrderMapTabName,
      hallDefinitions,
    ],
  );

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

  const handleReorderExecuteListByHallOrder = useCallback(
    (hallOrder: string[]) => {
      if (!activeEventName) return;

      if (!activeEventDate) return;
      const dayName = activeEventDate;

      const mapTabForDate = getMapTabForDate(dayName);
      const currentMapData = mapTabForDate
        ? mapData[activeEventName]?.[mapTabForDate]
        : undefined;
      const mapHalls = mapTabForDate
        ? hallDefinitions[activeEventName]?.[mapTabForDate] || []
        : [];
      const maplessKey = getMaplessKey(dayName);
      const maplessHalls = hallDefinitions[activeEventName]?.[maplessKey] || [];
      const halls = [...mapHalls, ...maplessHalls];
      const currentHallRouteSettings = getCombinedHallRouteSettingsForDate({
        eventName: activeEventName,
        dayName,
        mapTabName: mapTabForDate,
        hallRouteSettings,
      });

      updateExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];

        if (dayItems.length === 0) return prev;

        const reorderedItems = reorderExecuteIdsByHallOrder({
          hallOrder,
          dayItems,
          items,
          halls,
          mapData: currentMapData,
          hallRouteSettings: currentHallRouteSettings,
        });

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: reorderedItems,
          },
        };
      });
    },
    [
      activeEventName,
      activeEventDate,
      getMapTabForDate,
      mapData,
      hallDefinitions,
      hallRouteSettings,
      items,
    ],
  );

  const [hallDefinitionMode, setHallDefinitionMode] = useState(false);

  const [vertexSelectionMode, setVertexSelectionMode] = useState<{
    clickedVertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  const [pendingVertexSelection, setPendingVertexSelection] = useState<{
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);
  const [vertexGuideOptions, setVertexGuideOptions] = useState({
    showGrid: true,
    showRuler: true,
  });

  const handleStartVertexSelection = useCallback((editingData?: unknown) => {
    setVertexSelectionMode({ clickedVertices: [], editingData });
    setHallDefinitionMode(false);
  }, []);

  const sortVerticesNonCrossing = useCallback(
    (
      vertices: { row: number; col: number }[],
    ): { row: number; col: number }[] => {
      if (vertices.length <= 2) return vertices;

      const centroidRow =
        vertices.reduce((sum, v) => sum + v.row, 0) / vertices.length;
      const centroidCol =
        vertices.reduce((sum, v) => sum + v.col, 0) / vertices.length;

      const sorted = [...vertices].sort((a, b) => {
        const angleA = Math.atan2(a.row - centroidRow, a.col - centroidCol);
        const angleB = Math.atan2(b.row - centroidRow, b.col - centroidCol);
        return angleA - angleB;
      });

      return sorted;
    },
    [],
  );

  const handleConfirmVertexSelection = useCallback(() => {
    if (vertexSelectionMode) {
      const sorted = sortVerticesNonCrossing(
        vertexSelectionMode.clickedVertices,
      );
      setPendingVertexSelection({
        vertices: sorted,
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [sortVerticesNonCrossing, vertexSelectionMode]);

  const handleCancelVertexSelection = useCallback(() => {
    if (vertexSelectionMode?.editingData) {
      setPendingVertexSelection({
        vertices: [],
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [vertexSelectionMode]);

  useEffect(() => {
    const handleMapCellClickForVertex = (
      e: CustomEvent<{ row: number; col: number }>,
    ) => {
      if (!vertexSelectionMode) return;

      const { row, col } = e.detail;

      setVertexSelectionMode((prev) => {
        if (!prev) return prev;

        const existingIndex = prev.clickedVertices.findIndex(
          (v) => v.row === row && v.col === col,
        );
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter(
              (_, i) => i !== existingIndex,
            ),
          };
        }

        if (prev.clickedVertices.length >= 6) {
          return prev;
        }

        return {
          ...prev,
          clickedVertices: [...prev.clickedVertices, { row, col }],
        };
      });
    };

    window.addEventListener(
      "mapCellClick",
      handleMapCellClickForVertex as EventListener,
    );
    return () => {
      window.removeEventListener(
        "mapCellClick",
        handleMapCellClickForVertex as EventListener,
      );
    };
  }, [vertexSelectionMode]);

  const handleStartCellSelection = useCallback(
    (
      type: "corner" | "multiCorner" | "rangeStart" | "individual",
      editingData?: unknown,
    ) => {
      setCellSelectionMode({
        type,
        clickedCells: [],
        editingBlockData: editingData,
      });
      setBlockDefinitionMode(false);
    },
    [],
  );

  const handleConfirmCellSelection = useCallback(() => {
    if (cellSelectionMode) {
      setPendingCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true);
  }, [cellSelectionMode]);

  const handleCancelCellSelection = useCallback(() => {
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: "cancelled",
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true);
  }, [cellSelectionMode]);

  useEffect(() => {
    const handleMapCellClick = (
      e: CustomEvent<{ row: number; col: number }>,
    ) => {
      if (!cellSelectionMode) return;

      const { row, col } = e.detail;

      setCellSelectionMode((prev) => {
        if (!prev) return prev;

        const existingIndex = prev.clickedCells.findIndex(
          (c) => c.row === row && c.col === col,
        );
        if (existingIndex >= 0) {
          return {
            ...prev,
            clickedCells: prev.clickedCells.filter(
              (_, i) => i !== existingIndex,
            ),
          };
        }

        return {
          ...prev,
          clickedCells: [...prev.clickedCells, { row, col }],
        };
      });
    };

    window.addEventListener(
      "mapCellClick",
      handleMapCellClick as EventListener,
    );
    return () =>
      window.removeEventListener(
        "mapCellClick",
        handleMapCellClick as EventListener,
      );
  }, [cellSelectionMode]);

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
        setActiveTab(tab);
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

  const executeColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds =
      executeModeItems[activeEventName]?.[currentEventDate] || [];
    const itemsMap = new Map(items.map((item) => [item.id, item]));
    return executeIds
      .map((id) => itemsMap.get(id))
      .filter(Boolean) as ShoppingItem[];
  }, [activeEventName, activeTab, executeModeItems, items, eventDates]);

  useEffect(() => {
    executeColumnItemsRef.current = executeColumnItems;
  }, [executeColumnItems]);

  useEffect(() => {
    recentlyChangedItemIdsRef.current = recentlyChangedItemIds;
  }, [recentlyChangedItemIds]);

  useEffect(() => {
    setShowPostponeFilterButton(false);
    setShowLateFilterButton(false);
  }, [currentMode, sortState]);

  const baseFilteredItems = useMemo(() => {
    const currentEventDate = activeEventDate;
    const itemsForTab = currentTabItems;

    if (!activeEventName) return itemsForTab;

    const mode = dayModes[activeEventName]?.[currentEventDate];

    if (mode === "execute") {
      if (sortState === "Manual") {
        return executeColumnItems;
      }
      const filterStatus = sortState as Exclude<SortState, "Manual">;
      return executeColumnItems.filter((item) =>
        matchesPurchaseStatusFilter(item, filterStatus),
      );
    }

    return itemsForTab;
  }, [
    activeTab,
    currentTabItems,
    sortState,
    activeEventName,
    dayModes,
    executeColumnItems,
    eventDates,
  ]);

  const baseFilteredItemIds = useMemo(
    () => new Set(baseFilteredItems.map((item) => item.id)),
    [baseFilteredItems],
  );

  const temporaryVisibleItems = useMemo(() => {
    if (!activeEventName) return [];
    const mode = dayModes[activeEventName]?.[activeEventDate];
    if (mode !== "execute" || sortState === "Manual") return [];

    return executeColumnItems.filter(
      (item) =>
        recentlyChangedItemIds.has(item.id) &&
        !baseFilteredItemIds.has(item.id),
    );
  }, [
    activeEventDate,
    activeEventName,
    baseFilteredItemIds,
    dayModes,
    executeColumnItems,
    recentlyChangedItemIds,
    sortState,
  ]);

  const temporaryVisibleCount = temporaryVisibleItems.length;
  const limitedCounts = useMemo(
    () => getLimitedPurchaseCounts(baseFilteredItems),
    [baseFilteredItems],
  );

  const sortDisplayLabel = useMemo(() => {
    const buildTemporaryLabel = (baseLabel: string): string =>
      temporaryVisibleCount > 0
        ? `${baseLabel}\uFF08\u4E00\u6642\u8868\u793A${temporaryVisibleCount}\u4EF6\uFF09`
        : baseLabel;

    if (sortState !== "LimitedPurchase") {
      return buildTemporaryLabel(sortLabels[sortState]);
    }

    const details = [
      limitedCounts.missing > 0
        ? `\u672A\u5165\u529B${limitedCounts.missing}`
        : null,
      temporaryVisibleCount > 0
        ? `\u4E00\u6642\u8868\u793A${temporaryVisibleCount}`
        : null,
    ].filter(Boolean);

    return details.length > 0
      ? `\u9650\u6570 ${limitedCounts.total}\u4EF6\uFF08${details.join("\u30FB")}\uFF09`
      : `\u9650\u6570 ${limitedCounts.total}\u4EF6`;
  }, [
    limitedCounts.missing,
    limitedCounts.total,
    sortState,
    temporaryVisibleCount,
  ]);

  const visibleItemIds = useMemo(() => {
    const currentEventDate = activeEventDate;
    if (!activeEventName)
      return new Set(baseFilteredItems.map((item) => item.id));
    const mode = dayModes[activeEventName]?.[currentEventDate];
    if (mode !== "execute" || sortState === "Manual") {
      return new Set(baseFilteredItems.map((item) => item.id));
    }

    return new Set([
      ...baseFilteredItems.map((item) => item.id),
      ...temporaryVisibleItems.map((item) => item.id),
    ]);
  }, [
    activeEventDate,
    activeEventName,
    baseFilteredItems,
    dayModes,
    sortState,
    temporaryVisibleItems,
  ]);

  const visibleItems = useMemo(() => {
    if (!activeEventName) return currentTabItems;
    const mode = dayModes[activeEventName]?.[activeEventDate];
    if (mode === "execute") {
      return executeColumnItems.filter((item) => visibleItemIds.has(item.id));
    }
    return baseFilteredItems;
  }, [
    activeEventDate,
    activeEventName,
    baseFilteredItems,
    currentTabItems,
    dayModes,
    executeColumnItems,
    visibleItemIds,
  ]);

  const searchMatches = useMemo(() => {
    if (
      !searchKeyword.trim() ||
      !activeEventName ||
      !eventDates.includes(activeTab)
    ) {
      return [];
    }

    const keyword = searchKeyword.trim().toLowerCase();
    const matches: string[] = [];

    currentTabItems.forEach((item) => {
      const circleMatch = item.circle.toLowerCase().includes(keyword);
      const titleMatch = item.title.toLowerCase().includes(keyword);
      const remarksMatch = item.remarks.toLowerCase().includes(keyword);

      if (circleMatch || titleMatch || remarksMatch) {
        matches.push(item.id);
      }
    });

    return matches;
  }, [searchKeyword, activeEventName, activeTab, currentTabItems, eventDates]);

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
  }, [searchKeyword, searchMatches]);

  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab]);

  const duplicateCircleItemIds = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab))
      return new Set<string>();
    const itemsForTab = currentTabItems;
    const circleCountMap = new Map<string, number>();
    const circleItemIdsMap = new Map<string, string[]>();

    itemsForTab.forEach((item) => {
      const circle = item.circle.trim();
      if (circle) {
        const count = circleCountMap.get(circle) || 0;
        circleCountMap.set(circle, count + 1);

        if (!circleItemIdsMap.has(circle)) {
          circleItemIdsMap.set(circle, []);
        }
        circleItemIdsMap.get(circle)!.push(item.id);
      }
    });

    const duplicateIds = new Set<string>();
    circleCountMap.forEach((count, circle) => {
      if (count > 1) {
        const itemIds = circleItemIdsMap.get(circle) || [];
        itemIds.forEach((id) => duplicateIds.add(id));
      }
    });

    return duplicateIds;
  }, [activeEventName, activeTab, currentTabItems, eventDates]);

  const availableBlocks = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds = new Set(
      executeModeItems[activeEventName]?.[currentEventDate] || [],
    );
    const candidateItems = currentTabItems.filter(
      (item) => !executeIds.has(item.id),
    );
    const blocks = new Set(
      candidateItems.map((item) => item.block).filter(Boolean),
    );
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" });
    });
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);

  const allBlocksForHallDefinition = useMemo(() => {
    if (!activeEventName) return [];
    const blocks = new Set(
      currentTabItems.map((item) => item.block).filter(Boolean),
    );
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, "ja", { numeric: true, sensitivity: "base" });
    });
  }, [activeEventName, currentTabItems]);

  const currentMaplessHalls = useMemo(() => {
    if (!activeEventName || !activeEventDate) return [];
    return (
      hallDefinitions[activeEventName]?.[getMaplessKey(activeEventDate)] || []
    );
  }, [activeEventName, activeEventDate, hallDefinitions]);

  const candidateColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds = new Set(
      executeModeItems[activeEventName]?.[currentEventDate] || [],
    );
    let filtered = currentTabItems.filter((item) => !executeIds.has(item.id));

    if (selectedBlockFilters.size > 0) {
      filtered = filtered.filter((item) =>
        selectedBlockFilters.has(item.block),
      );
    }

    if (candidateNumberSortDirection !== null) {
      return filtered;
    }

    return [...filtered].sort((a, b) => {
      const blockComparison = a.block.localeCompare(b.block, "ja", {
        numeric: true,
        sensitivity: "base",
      });
      if (blockComparison !== 0) return blockComparison;

      return a.number.localeCompare(b.number, "ja", {
        numeric: true,
        sensitivity: "base",
      });
    });
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    currentTabItems,
    selectedBlockFilters,
    eventDates,
    candidateNumberSortDirection,
  ]);

  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];

    const currentEventDate = activeEventDate;
    const mode = activeEventName
      ? dayModes[activeEventName]?.[currentEventDate]
      : undefined;

    let visibleItemIds: Set<string>;

    if (mode === "execute") {
      visibleItemIds = new Set(visibleItems.map((item) => item.id));
    } else {
      const allVisibleIds = new Set([
        ...executeColumnItems.map((item) => item.id),
        ...candidateColumnItems.map((item) => item.id),
      ]);
      visibleItemIds = allVisibleIds;
    }

    return searchMatches.filter((id) => visibleItemIds.has(id));
  }, [
    searchMatches,
    activeEventName,
    activeTab,
    eventDates,
    dayModes,
    visibleItems,
    executeColumnItems,
    candidateColumnItems,
  ]);

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
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);

  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const currentEventDate = activeEventDate;
    const executeIds = new Set(
      executeModeItems[activeEventName]?.[currentEventDate] || [],
    );
    const candidateItems = currentTabItems.filter(
      (item) => !executeIds.has(item.id),
    );

    const blocksWithPriority = new Set<string>();
    candidateItems.forEach((item) => {
      if (
        item.remarks &&
        (item.remarks.includes("優先") || item.remarks.includes("委託無"))
      ) {
        blocksWithPriority.add(item.block);
      }
    });

    return blocksWithPriority;
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);

  const currentExecuteOrderedIds = useMemo(
    () =>
      activeEventName
        ? executeModeItems[activeEventName]?.[activeEventDate] || []
        : [],
    [activeEventDate, activeEventName, executeModeItems],
  );
  const candidateSourceOrderedIds = useMemo(
    () =>
      getCandidateSourceOrderedIds(
        items,
        activeEventDate,
        currentExecuteOrderedIds,
      ),
    [activeEventDate, currentExecuteOrderedIds, items],
  );
  const selectedIdsForMovePlan = useMemo(
    () => Array.from(selectedItemIds),
    [selectedItemIds],
  );
  const candidateMovePlan = useMemo(
    () =>
      buildMovePlan({
        requestedIds: selectedIdsForMovePlan,
        sourceOrderedIds: candidateSourceOrderedIds,
        allItems: items,
        dayName: activeEventDate,
        expansionPolicy: "same-visit",
      }),
    [activeEventDate, candidateSourceOrderedIds, items, selectedIdsForMovePlan],
  );
  const executeMovePlan = useMemo(
    () =>
      buildMovePlan({
        requestedIds: selectedIdsForMovePlan,
        sourceOrderedIds: currentExecuteOrderedIds,
        allItems: items,
        dayName: activeEventDate,
        expansionPolicy: "same-visit",
      }),
    [activeEventDate, currentExecuteOrderedIds, items, selectedIdsForMovePlan],
  );

  const hasCandidateSelection =
    currentMode === "edit" && candidateMovePlan.requested.length > 0;
  const hasExecuteSelection =
    currentMode === "edit" && executeMovePlan.requested.length > 0;

  const showMoveButtons =
    (hasCandidateSelection && !hasExecuteSelection) ||
    (hasExecuteSelection && !hasCandidateSelection);

  if (!isInitialized) {
    return null;
  }

  const mainContentVisible = eventDates.includes(activeTab);

  const handleZoomChange = (newZoom: number) => {
    setZoomLevel(Math.max(15, Math.min(150, newZoom)));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200 font-sans">
      <AppHeaderShell
        activeEventDate={activeEventDate}
        activeEventName={activeEventName}
        activeTab={activeTab}
        blockSortDirection={blockSortDirection}
        currentHalls={currentHalls}
        currentMapData={currentMapData}
        currentMapTabName={currentMapTabName}
        currentMapTabRotationState={currentMapTabRotationState}
        currentMode={currentMode}
        currentSearchIndex={currentSearchIndex}
        DEFAULT_OUTLINE_STYLE={DEFAULT_OUTLINE_STYLE}
        DEFAULT_PURCHASE_STATUS_CONTROL_MODE={
          DEFAULT_PURCHASE_STATUS_CONTROL_MODE
        }
        DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY={
          DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY
        }
        DEFAULT_UI_VISIBILITY={DEFAULT_UI_VISIBILITY}
        disablePriceUndefinedCheck={disablePriceUndefinedCheck}
        disableLimitedPurchaseQuantityCheck={
          disableLimitedPurchaseQuantityCheck
        }
        skipLimitedPurchaseForSingleQuantity={
          skipLimitedPurchaseForSingleQuantity
        }
        postEventDistributionCheckEnabled={postEventDistributionCheckEnabled}
        eventDates={eventDates}
        executeSpaceGroupingEnabled={executeSpaceGroupingEnabled}
        getHallExecuteCount={getHallExecuteCount}
        getHallTotalItemCount={getHallTotalItemCount}
        getMapTabForDate={getMapTabForDate}
        globalHallOrderHalls={globalHallOrderHalls}
        globalHallOrderMapTabName={globalHallOrderMapTabName}
        handleBlockSortToggle={handleBlockSortToggle}
        handleBlockSortToggleCandidate={handleBlockSortToggleCandidate}
        handleBulkSort={handleBulkSort}
        handleClearSelection={handleClearSelection}
        handleClearRangeSelection={clearRangeSelection}
        handleMapTabRotationAngleChange={handleMapTabRotationAngleChange}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        handleSearchNext={handleSearchNext}
        handleSetViewMode={handleSetViewMode}
        handleSortToggle={handleSortToggle}
        handleZoomChange={handleZoomChange}
        hasCandidateSelection={hasCandidateSelection}
        hasExecuteSelection={hasExecuteSelection}
        candidateMovePlan={candidateMovePlan}
        executeMovePlan={executeMovePlan}
        hasUndefinedPriorityItems={hasUndefinedPriorityItems}
        isMapTab={isMapTab}
        items={items}
        itemToEdit={itemToEdit}
        layoutMode={layoutMode}
        mainContentVisible={mainContentVisible}
        mapHallSelectorOpen={mapHallSelectorOpen}
        mapIsRouteVisible={mapIsRouteVisible}
        mapSelectedHallId={mapSelectedHallId}
        mapSmartInsertEnabled={mapSmartInsertEnabled}
        mapSmartInsertMode={mapSmartInsertMode}
        mapTabMenuOpen={mapTabMenuOpen}
        mapTabMenuPosition={mapTabMenuPosition}
        mapToggleButtonRef={mapToggleButtonRef}
        mapToggleLongPressFiredRef={mapToggleLongPressFiredRef}
        mapToggleLongPressRef={mapToggleLongPressRef}
        mapToggleMenuRef={mapToggleMenuRef}
        mapViewActive={mapViewActive}
        numberCellOutlineStyle={numberCellOutlineStyle}
        openVisitListPanel={openVisitListPanel}
        purchaseStatusControlMode={purchaseStatusControlMode}
        searchKeyword={searchKeyword}
        selectedItemIds={selectedItemIds}
        setActiveEventName={setActiveEventName}
        setActiveTab={setActiveTab}
        setBlockDefinitionMode={setBlockDefinitionMode}
        setExecuteCollapsedSpaces={setExecuteCollapsedSpaces}
        setExecuteSpaceGroupingEnabled={setExecuteSpaceGroupingEnabled}
        setGlobalHallOrderPanelOpen={setGlobalHallOrderPanelOpen}
        setHallDefinitionMode={setHallDefinitionMode}
        setItemToEdit={setItemToEdit}
        setLayoutMode={setLayoutMode}
        setMapHallSelectorOpen={setMapHallSelectorOpen}
        setMapIsHallOrderOpen={setMapIsHallOrderOpen}
        setMapIsRouteVisible={setMapIsRouteVisible}
        setMapSelectedHallId={setMapSelectedHallId}
        setMapSmartInsertEnabled={setMapSmartInsertEnabled}
        setMapSmartInsertMode={setMapSmartInsertMode}
        setMapTabMenuOpen={setMapTabMenuOpen}
        setMapTabMenuPosition={setMapTabMenuPosition}
        setMapViewActive={setMapViewActive}
        setDisablePriceUndefinedCheck={setDisablePriceUndefinedCheck}
        setDisableLimitedPurchaseQuantityCheck={
          setDisableLimitedPurchaseQuantityCheck
        }
        setSkipLimitedPurchaseForSingleQuantity={
          setSkipLimitedPurchaseForSingleQuantity
        }
        setPostEventDistributionCheckEnabled={
          setPostEventDistributionCheckEnabled
        }
        setNumberCellOutlineStyle={setNumberCellOutlineStyle}
        setPurchaseStatusControlMode={setPurchaseStatusControlMode}
        setSearchKeyword={setSearchKeyword}
        setSelectedBlockFilters={setSelectedBlockFilters}
        setSimpleHallDefinitionMode={setSimpleHallDefinitionMode}
        setThemeMode={setThemeMode}
        onCloseUiSettingsPanel={closeUiSettingsPanel}
        onToggleUiSettingsPanel={toggleUiSettingsPanel}
        setUiVisibilitySettings={setDraftUIVisibilitySettings}
        showHeaderBar={showHeaderBar}
        showMoveButtons={showMoveButtons}
        showSmartInsertToast={showSmartInsertToast}
        showTabBar={showTabBar}
        smartInsertLongPressRef={smartInsertLongPressRef}
        smartInsertLongPressTriggeredRef={smartInsertLongPressTriggeredRef}
        sortLabels={sortLabels}
        sortDisplayLabel={sortDisplayLabel}
        sortState={sortState}
        TabButton={TabButton}
        themeMode={themeMode}
        uiSettingsPanelOpen={uiSettingsPanelOpen}
        uiVisibilitySettings={draftUIVisibilitySettings}
        updateUIVisibilityConfig={updateUIVisibilityConfig}
        visibleSearchMatches={visibleSearchMatches}
        zoomLevel={zoomLevel}
      />

      {rawHideSomething &&
        activeEventName &&
        (currentMode === "focus" || currentMode === "execute") && (
          <button
            onClick={() => {
              closeUiSettingsPanel({ resetVisibilityOverride: false });
              setUiVisibilityOverride((prev) => !prev);
            }}
            className={`fixed left-3 top-3 z-[110] w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-all touch-manipulation select-none ${
              uiVisibilityOverride
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-white/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600 backdrop-blur-sm border border-slate-200 dark:border-slate-600"
            }`}
            title={
              uiVisibilityOverride ? "自動表示に戻す" : "画面要素をすべて表示"
            }
            style={{ WebkitTapHighlightColor: "transparent" }}
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
        activeEventDate={activeEventDate}
        activeEventName={activeEventName}
        activeTab={activeTab}
        availableBlocks={availableBlocks}
        blocksWithPriorityRemarks={blocksWithPriorityRemarks}
        candidateColumnItems={candidateColumnItems}
        candidateNumberSortDirection={candidateNumberSortDirection}
        cellSelectionMode={cellSelectionMode}
        collapsedSpaces={collapsedSpaces}
        currentFocusMapRotationState={currentFocusMapRotationState}
        currentFocusResumeState={currentFocusResumeState}
        currentFocusSessionKey={currentFocusSessionKey}
        currentHallRouteSettings={currentHallRouteSettings}
        currentHalls={currentHalls}
        currentMapData={currentMapData}
        currentMapExecuteItemIds={currentMapExecuteItemIds}
        currentMapTabName={currentMapTabName}
        currentMapTabRotationState={currentMapTabRotationState}
        currentMapTabViewport={currentMapTabViewport}
        currentMode={currentMode}
        disablePriceUndefinedCheck={disablePriceUndefinedCheck}
        disableLimitedPurchaseQuantityCheck={
          disableLimitedPurchaseQuantityCheck
        }
        skipLimitedPurchaseForSingleQuantity={
          skipLimitedPurchaseForSingleQuantity
        }
        postEventDistributionCheckEnabled={postEventDistributionCheckEnabled}
        duplicateCircleItemIds={duplicateCircleItemIds}
        eventDates={eventDates}
        eventLists={eventLists}
        executeCollapsedSpaces={executeCollapsedSpaces}
        executeColumnItems={executeColumnItems}
        executeModeItems={executeModeItems}
        executeSpaceGroupingEnabled={executeSpaceGroupingEnabled}
        exportFileInputRef={exportFileInputRef}
        getHallOrderForDate={getHallOrderForDate}
        getHallsForDate={getHallsForDate}
        getMapDataForDate={getMapDataForDate}
        hallDefinitions={hallDefinitions}
        hallRouteSettings={hallRouteSettings}
        handleActivateLateFilter={handleActivateLateFilter}
        handleActivatePostponeFilter={handleActivatePostponeFilter}
        handleAddItemFromFocusMode={handleAddItemFromFocusMode}
        handleAddNewItemFromMap={handleAddNewItemFromMap}
        handleAddToExecuteListFromMap={handleAddToExecuteListFromMap}
        handleAddToExecuteListFromMapAtPosition={
          handleAddToExecuteListFromMapAtPosition
        }
        handleBatchAddToExecuteListFromMap={handleBatchAddToExecuteListFromMap}
        handleBatchAddToExecuteListFromMapAtPosition={
          handleBatchAddToExecuteListFromMapAtPosition
        }
        handleBatchRemoveFromExecuteListFromMap={
          handleBatchRemoveFromExecuteListFromMap
        }
        handleBulkAdd={handleBulkAdd}
        handleBulkStatusChange={handleBulkStatusChange}
        handleCandidateNumberSort={handleCandidateNumberSort}
        handleClearBlockFilters={handleClearBlockFilters}
        handleClearNewItemDefaults={handleClearNewItemDefaults}
        handleClearRangeSelection={clearRangeSelection}
        handleCollapseAndOpenNext={handleCollapseAndOpenNext}
        handleBackupExport={handleBackupExport}
        handleBackupRestoreRequest={handleBackupRestoreRequest}
        handleDeleteEvent={handleDeleteEvent}
        handleDeleteItemFromMap={handleDeleteItemFromMap}
        handleDeleteRequest={handleDeleteRequest}
        handleDoneEditing={handleDoneEditing}
        handleEditRequest={handleEditRequest}
        handleExecuteItemUpdate={handleExecuteItemUpdate}
        handleExecuteSpaceGroupOrderChange={handleExecuteSpaceGroupOrderChange}
        handleExecuteToggleAllSpaceCollapse={
          handleExecuteToggleAllSpaceCollapse
        }
        handleExecuteToggleSpaceCollapse={handleExecuteToggleSpaceCollapse}
        handleExportEvent={handleExportEvent}
        handleFocusMapRotationAngleChange={handleFocusMapRotationAngleChange}
        handleFocusSessionStateChange={handleFocusSessionStateChange}
        handleImportMapData={handleImportMapData}
        handleMapTabRotationAngleChange={handleMapTabRotationAngleChange}
        handleMapViewportChange={handleMapViewportChange}
        handleModeChangeFromFocus={handleModeChangeFromFocus}
        handleMoveItem={handleMoveItem}
        handleMoveItemDown={handleMoveItemDown}
        handleMoveItemUp={handleMoveItemUp}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        handleMoveToFirstFromMap={handleMoveToFirstFromMap}
        handleMoveToLastFromMap={handleMoveToLastFromMap}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        handleRemoveFromExecuteListFromMap={handleRemoveFromExecuteListFromMap}
        handleRenameEvent={handleRenameEvent}
        handleReorderExecuteListByHallOrder={
          handleReorderExecuteListByHallOrder
        }
        handleSelectEvent={handleSelectEvent}
        handleSelectItem={handleSelectItem}
        handleSelectSpaceGroupForRange={handleSelectSpaceGroupForRange}
        handleSetSpaceGroupDragItemIds={handleSetSpaceGroupDragItemIds}
        handleToggleAllSpaceCollapse={handleToggleAllSpaceCollapse}
        handleToggleBlockFilter={handleToggleBlockFilter}
        handleToggleRangeSelection={handleToggleRangeSelection}
        handleToggleSpaceCollapse={handleToggleSpaceCollapse}
        handleUpdateEvent={handleUpdateEvent}
        handleUpdateHallRouteSettings={handleUpdateHallRouteSettings}
        handleUpdateItem={handleUpdateItem}
        handleUpdateItemPriorityFromEdit={handleUpdateItemPriorityFromEdit}
        highlightedItemId={highlightedItemId}
        highlightedMapCell={highlightedMapCell}
        isMapTab={isMapTab}
        items={items}
        itemToEdit={itemToEdit}
        layoutMode={layoutMode}
        mainContentVisible={mainContentVisible}
        mapData={mapData}
        mapIsHallOrderOpen={mapIsHallOrderOpen}
        mapIsRouteVisible={mapIsRouteVisible}
        mapSelectedHallId={mapSelectedHallId}
        mapSmartInsertEnabled={mapSmartInsertEnabled}
        mapSmartInsertMode={mapSmartInsertMode}
        newItemDefaults={newItemDefaults}
        numberCellOutlineStyle={numberCellOutlineStyle}
        purchaseStatusControlMode={purchaseStatusControlMode}
        rangeEnd={rangeEnd}
        rangeStart={rangeStart}
        selectedBlockFilters={selectedBlockFilters}
        selectedItemIds={selectedItemIds}
        setCollapsedSpaces={setCollapsedSpaces}
        setFocusModeMapVisible={setFocusModeMapVisible}
        setLayoutMode={setLayoutMode}
        setMapIsHallOrderOpen={setMapIsHallOrderOpen}
        setMapIsRouteVisible={setMapIsRouteVisible}
        setMapSelectedHallId={setMapSelectedHallId}
        setSpaceGroupingEnabled={setSpaceGroupingEnabled}
        showLateFilterButton={showLateFilterButton}
        showPostponeFilterButton={showPostponeFilterButton}
        spaceGroupingEnabled={spaceGroupingEnabled}
        vertexGuideOptions={vertexGuideOptions}
        vertexSelectionMode={vertexSelectionMode}
        visibleItems={visibleItems}
        visitListPanelOpen={visitListPanelOpen}
        zoomLevel={zoomLevel}
      />

      <AppOverlayLayer
        editDialogItem={editDialogItem}
        items={items}
        getHallsForDate={getHallsForDate}
        handleUpdateItem={handleUpdateItem}
        handleUpdateHallOrderForPriorityChangeFromEdit={
          handleUpdateHallOrderForPriorityChangeFromEdit
        }
        setEditDialogItem={setEditDialogItem}
        itemToDelete={itemToDelete}
        handleConfirmDelete={handleConfirmDelete}
        setItemToDelete={setItemToDelete}
        pendingEventUpdate={pendingEventUpdate}
        handleConfirmUpdate={handleConfirmUpdate}
        handleCancelUpdate={handleCancelUpdate}
        showUrlUpdateDialog={showUrlUpdateDialog}
        pendingUpdateEventName={pendingUpdateEventName}
        eventMetadata={eventMetadata}
        handleUrlUpdate={handleUrlUpdate}
        setShowUrlUpdateDialog={setShowUrlUpdateDialog}
        setPendingUpdateEventName={setPendingUpdateEventName}
        setActiveEventName={setActiveEventName}
        setActiveTab={setActiveTab}
        showRenameDialog={showRenameDialog}
        eventToRename={eventToRename}
        handleConfirmRename={handleConfirmRename}
        setShowRenameDialog={setShowRenameDialog}
        setEventToRename={setEventToRename}
        showExportOptions={showExportOptions}
        exportEventName={exportEventName}
        setShowExportOptions={setShowExportOptions}
        setExportEventName={setExportEventName}
        handleConfirmExport={handleConfirmExport}
        mapData={mapData}
        blockDefinitionMode={blockDefinitionMode}
        currentMapData={currentMapData}
        setBlockDefinitionMode={setBlockDefinitionMode}
        setPendingCellSelection={setPendingCellSelection}
        handleUpdateBlocks={handleUpdateBlocks}
        handleStartCellSelection={handleStartCellSelection}
        pendingCellSelection={pendingCellSelection}
        cellSelectionMode={cellSelectionMode}
        handleConfirmCellSelection={handleConfirmCellSelection}
        handleCancelCellSelection={handleCancelCellSelection}
        simpleHallDefinitionMode={simpleHallDefinitionMode}
        setSimpleHallDefinitionMode={setSimpleHallDefinitionMode}
        currentMaplessHalls={currentMaplessHalls}
        handleUpdateMaplessHalls={handleUpdateMaplessHalls}
        allBlocksForHallDefinition={allBlocksForHallDefinition}
        eventDates={eventDates}
        activeEventDate={activeEventDate}
        handleSyncMaplessHallsToOtherDates={handleSyncMaplessHallsToOtherDates}
        globalHallOrderPanelOpen={globalHallOrderPanelOpen}
        setGlobalHallOrderPanelOpen={setGlobalHallOrderPanelOpen}
        globalHallOrderHalls={globalHallOrderHalls}
        globalHallOrderRouteSettings={globalHallOrderRouteSettings}
        handleUpdateGlobalHallRouteSettings={
          handleUpdateGlobalHallRouteSettings
        }
        getGlobalHallItemCount={getGlobalHallItemCount}
        handleReorderExecuteListByHallOrder={
          handleReorderExecuteListByHallOrder
        }
        hallDefinitionMode={hallDefinitionMode}
        setHallDefinitionMode={setHallDefinitionMode}
        setPendingVertexSelection={setPendingVertexSelection}
        currentHalls={currentHalls}
        handleUpdateHalls={handleUpdateHalls}
        handleStartVertexSelection={handleStartVertexSelection}
        pendingVertexSelection={pendingVertexSelection}
        mapTabDates={mapTabDates}
        handleSyncPolygonHallsToOtherDates={handleSyncPolygonHallsToOtherDates}
        visitListPanelOpen={visitListPanelOpen}
        handleVisitListClose={handleVisitListClose}
        visitListItems={visitListItems}
        handleVisitListOrderUpdate={handleVisitListOrderUpdate}
        visitListHallOrder={visitListHallOrder}
        layoutMode={layoutMode}
        handleHighlightMapCell={handleHighlightMapCell}
        handleClearMapCellHighlight={handleClearMapCellHighlight}
        visitListHasUnsavedChanges={visitListHasUnsavedChanges}
        handleVisitListConfirm={handleVisitListConfirm}
        handleVisitListCancel={handleVisitListCancel}
        handleUpdateItemPriority={handleUpdateItemPriority}
        showVisitListConfirmDialog={showVisitListConfirmDialog}
        handleVisitListDialogCancel={handleVisitListDialogCancel}
        handleVisitListDialogConfirm={handleVisitListDialogConfirm}
        vertexSelectionMode={vertexSelectionMode}
        vertexGuideOptions={vertexGuideOptions}
        setVertexGuideOptions={setVertexGuideOptions}
        handleConfirmVertexSelection={handleConfirmVertexSelection}
        handleCancelVertexSelection={handleCancelVertexSelection}
        mapFileInputRef={mapFileInputRef}
        handleMapFileChange={handleMapFileChange}
        mapImportDialogOpen={mapImportDialogOpen}
        mapImportPendingFile={mapImportPendingFile}
        mapImportPendingEventName={mapImportPendingEventName}
        handleMapImportConfirm={handleMapImportConfirm}
        handleMapImportClose={handleMapImportClose}
        exportFileInputRef={exportFileInputRef}
        handleExportFileImport={handleExportFileImport}
        activeEventName={activeEventName}
        mainContentVisible={mainContentVisible}
        currentMode={currentMode}
        visibleItems={visibleItems}
        showHeaderBar={showHeaderBar}
        sortLabels={sortLabels}
        sortDisplayLabel={sortDisplayLabel}
        sortState={sortState}
        handleSortToggle={handleSortToggle}
        selectedItemIds={selectedItemIds}
        handleBulkSort={handleBulkSort}
        handleClearSelection={handleClearSelection}
        showMoveButtons={showMoveButtons}
        hasCandidateSelection={hasCandidateSelection}
        candidateMovePlan={candidateMovePlan}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        hasExecuteSelection={hasExecuteSelection}
        executeMovePlan={executeMovePlan}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        smartInsertToast={smartInsertToast}
        smartInsertToastType={smartInsertToastType}
      />
      <input
        ref={backupFileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleBackupFileImport}
        aria-label="バックアップファイルを選択"
      />
      <BackupRestoreDialog
        isOpen={pendingBackup !== null}
        backupEventNames={
          pendingBackup ? Object.keys(pendingBackup.data.eventLists).sort() : []
        }
        currentEventNames={Object.keys(eventLists)}
        onClose={() => setPendingBackup(null)}
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
        failedStores={failedStores}
        failureDetails={failureDetails}
        onRetry={retrySave}
        onExportBackup={handleBackupExport}
      />
    </div>
  );
};

export default App;
