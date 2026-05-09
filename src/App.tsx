import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ShoppingItem,
  PurchaseStatus,
  EventMetadata,
  ViewMode,
  DayModeState,
  ExecuteModeItems,
} from './types/item';
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
} from './types/map';
import { ExportOptions } from './types/export';
import { FocusModeSessionState } from './types/focus';
import { MAPLESS_HALL_KEY, getMaplessKey } from './types/map';
import { resolveHallByBlockName, resolveManualHallId, findHallsByBlockName } from './utils/hallFallback';
import { buildMergedHallRouteSettings } from './utils/mergedHallRouteSettings';
import { isPointInPolygon, saveBlockDetectionSettings } from './components/map';
import { extractEventDates } from './utils/eventDates';
import { getSpaceKey } from './utils/spaceGrouping';
import { importFromXlsx, downloadBlob, type ItemFallbackWarning } from './utils/exportImport';
import {
  buildBulkAddUiPlan,
  buildBulkAddEventMetadata,
  buildBulkAddItems,
  buildInitialDayModesForBulkAdd,
  buildInitialExecuteItemsForBulkAdd,
  buildLayoutAppliedEventItems,
  hasBulkAddLayoutInfo,
  type BulkAddMetadata,
} from './features/events/bulkAdd';
import { type EventUpdateDiff } from './features/events/updateDiff';
import {
  applyEventUpdateToItems,
  removeDeletedIdsFromExecuteModeItems,
} from './features/events/updateApply';
import {
  buildEventUpdateDiffFromSpreadsheet,
  resolveSpreadsheetSource,
} from './features/events/updateFlow';
import { buildEventExportFile, hasExportableItems } from './features/events/exportFlow';
import { toImportedEventData } from './features/events/fileImport';
import { removeRecordKey, renameRecordKey, upsertRecordKey } from './features/events/recordOps';
import {
  computeUpdateItem,
  computeDeleteItem,
  computeAddItemFromFocusMode,
  computeAddToExecuteListFromMap,
  computeAddToExecuteListFromMapAtPosition,
  computeRemoveFromExecuteListFromMap,
  computeMoveToExecuteColumn,
  computeRemoveFromExecuteColumn,
  computeMoveItem,
  computeMoveItemVertical,
  computeUpdateItemPriority,
  computeHallOrderForPriorityChange,
  reorderExecuteIdsForSpaceAdjacency,
} from './features/events/itemOps';
import {
  buildImportCompletionMessage,
  resolveEventListTab,
} from './features/events/uiOrchestration';
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
} from './features/map/domain/hallOperations';
import { useMapSelectors } from './features/map/hooks/useMapSelectors';
import { useListInteractionState } from './features/lists/hooks/useListInteractionState';
import AppHeaderShell from './features/app-shell/components/AppHeaderShell';
import AppMainContent from './features/app-shell/components/AppMainContent';
import AppOverlayLayer from './features/app-shell/components/AppOverlayLayer';
import { useThemeMode } from './hooks/useThemeMode';
import {
  DEFAULT_UI_VISIBILITY,
  useUIVisibilitySettings,
  type UIVisibilitySettings,
} from './hooks/useUIVisibilitySettings';
import { useNumberCellOutlineStyle } from './hooks/useNumberCellOutlineStyle';
import { useDisablePriceUndefinedCheck } from './hooks/useDisablePriceUndefinedCheck';
import { usePurchaseStatusControlMode } from './hooks/usePurchaseStatusControlMode';
import { useIndexedDbPersistence } from './hooks/useIndexedDbPersistence';

type ActiveTab = 'eventList' | 'import' | string;
type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'None' | 'Purchased';
export type BulkSortDirection = 'asc' | 'desc';
type BlockSortDirection = 'asc' | 'desc';

const sortCycle: SortState[] = [
  'Manual',
  'Postpone',
  'Late',
  'Absent',
  'SoldOut',
  'None',
  'Purchased',
];
const sortLabels: Record<SortState, string> = {
  Manual: '巡回順',
  Postpone: '後回し',
  Late: '遅参',
  Absent: '欠席',
  SoldOut: '売切',
  None: '未購入',
  Purchased: '購入済',
};

// 集中モードのセッションキーは「イベント名::日付」で統一する。
const buildFocusSessionKey = (eventName: string, eventDate: string): string =>
  `${eventName}::${eventDate}`;

// イベント削除時に、対象イベントに紐づく集中モードセッションをまとめて除外する。
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

// イベント名変更時に、セッションキーの先頭だけを新しい名前へ差し替える。
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

// 集中モード再開可否の判定に使う比較関数。
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
  value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

const normalizeMapDayToken = (value: string): string =>
  toHalfWidthDigits(value)
    .replace(/[ \u3000]/g, '')
    .replace(/マップ$/, '');

const resolveImportMapTabName = (mapName: string, eventDates: string[]): string | null => {
  const normalizedMapDay = normalizeMapDayToken(mapName);
  const matchedEventDate = eventDates.find(
    (eventDate) => normalizeMapDayToken(eventDate) === normalizedMapDay,
  );
  return matchedEventDate ? `${matchedEventDate}マップ` : null;
};

type RotationScreenType = 'mapTab' | 'focusMode';

const resolveDayMapRotationState = (
  state: { initialAngle?: number; mapTabAngle?: number; focusModeAngle?: number } | undefined,
) => {
  const initialAngle = normalizeRotationAngle(state?.initialAngle ?? 0);
  return {
    initialAngle,
    mapTabAngle: normalizeRotationAngle(state?.mapTabAngle ?? initialAngle),
    focusModeAngle: normalizeRotationAngle(state?.focusModeAngle ?? initialAngle),
  };
};

const App: React.FC = () => {
  // イベント単位で保持する主要データ。
  const [eventLists, setEventLists] = useState<Record<string, ShoppingItem[]>>({});
  const [eventMetadata, setEventMetadata] = useState<Record<string, EventMetadata>>({});
  const [executeModeItems, setExecuteModeItems] = useState<Record<string, ExecuteModeItems>>({});
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});

  // 画面表示と選択状態。
  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('eventList');
  const [mapViewActive, setMapViewActive] = useState(false);
  const mapToggleLongPressRef = React.useRef<number | null>(null);
  const mapToggleLongPressFiredRef = React.useRef(false);
  const mapToggleButtonRef = React.useRef<HTMLButtonElement>(null);
  const mapToggleMenuRef = React.useRef<HTMLDivElement>(null);
  const [sortState, setSortState] = useState<SortState>('Manual');
  const [blockSortDirection, setBlockSortDirection] = useState<BlockSortDirection | null>(null);
  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [editDialogItem, setEditDialogItem] = useState<ShoppingItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<Set<string>>(new Set());
  const {
    selectedItemIds,
    setSelectedItemIds,
    selectedBlockFilters,
    setSelectedBlockFilters,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    spaceGroupingEnabled,
    setSpaceGroupingEnabled,
    collapsedSpaces,
    setCollapsedSpaces,
    executeSpaceGroupingEnabled,
    setExecuteSpaceGroupingEnabled,
    executeCollapsedSpaces,
    setExecuteCollapsedSpaces,
    clearSelection,
    clearBlockFilters,
    toggleBlockFilter,
    toggleCollapsedSpace,
    toggleExecuteCollapsedSpace,
    selectItemForRange,
    selectSpaceGroupForRange,
    toggleCurrentRangeSelection,
  } = useListInteractionState();

  // 新規追加フォームに引き継ぐ既定値。
  const [newItemDefaults, setNewItemDefaults] = useState<{
    eventDate: string;
    block: string;
    number: string;
  } | null>(null);

  // 更新・名称変更まわりのダイアログ状態。
  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [updateData, setUpdateData] = useState<EventUpdateDiff | null>(null);
  const [updateEventName, setUpdateEventName] = useState<string | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);

  // 検索 UI の状態。
  const [searchKeyword, setSearchKeyword] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // レイアウト・表示設定・集中モード表示状態。
  const [layoutMode, setLayoutMode] = useState<'pc' | 'smartphone'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'smartphone' : 'pc',
  );
  const { uiVisibilitySettings, setUiVisibilitySettings } = useUIVisibilitySettings();
  const { numberCellOutlineStyle, setNumberCellOutlineStyle, DEFAULT_OUTLINE_STYLE } = useNumberCellOutlineStyle();
  const { disablePriceUndefinedCheck, setDisablePriceUndefinedCheck } = useDisablePriceUndefinedCheck();
  const {
    purchaseStatusControlMode,
    setPurchaseStatusControlMode,
    DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  } = usePurchaseStatusControlMode();
  const [uiVisibilityOverride, setUiVisibilityOverride] = useState(false);
  const [uiSettingsPanelOpen, setUiSettingsPanelOpen] = useState(false);
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);
  const [focusModeSessions, setFocusModeSessions] = useState<Record<string, FocusModeSessionState>>(
    {},
  );

  const { themeMode, setThemeMode } = useThemeMode();

  // マップ・ホール関連の永続データ。
  const [mapData, setMapData] = useState<MapDataStore>({});
  const [mapRotationSettings, setMapRotationSettings] = useState<MapRotationSettingsStore>({});
  const [mapViewportSettings, setMapViewportSettings] = useState<MapViewportSettingsStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});
  const [simpleHallDefinitionMode, setSimpleHallDefinitionMode] = useState(false);
  const [globalHallOrderPanelOpen, setGlobalHallOrderPanelOpen] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);

  // マップ取り込みダイアログの一時データ。
  const [mapImportDialogOpen, setMapImportDialogOpen] = useState(false);
  const [mapImportPendingFile, setMapImportPendingFile] = useState<File | null>(null);
  const [mapImportPendingEventName, setMapImportPendingEventName] = useState<string>('');
  const { isInitialized } = useIndexedDbPersistence({
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
      setExecuteModeItems,
      setDayModes,
      setMapData,
      setMapRotationSettings,
      setRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
      setMapViewportSettings,
    },
  });

  // マイグレーション:
  // 1. 過去バグで mapTab 側に混入した mapless ホール (vertices 空 + blockNames 有) を寄せ直す
  // 2. 旧 MAPLESS_HALL_KEY ("__mapless__") を日付別キー ("__mapless__:<eventDate>") に分離
  const hallDefinitionsMigratedRef = useRef(false);
  useEffect(() => {
    if (!isInitialized || hallDefinitionsMigratedRef.current) return;
    hallDefinitionsMigratedRef.current = true;

    setHallDefinitions((prev) => {
      let changed = false;
      const next: HallDefinitionsStore = {};
      for (const eventName of Object.keys(prev)) {
        const byTab = { ...prev[eventName] };

        // Step 1: mapTab 側に混入した mapless ホールを収集
        const maplessById = new Map<string, HallDefinition>();
        for (const h of byTab[MAPLESS_HALL_KEY] ?? []) {
          maplessById.set(h.id, h);
        }
        for (const tabName of Object.keys(byTab)) {
          if (tabName === MAPLESS_HALL_KEY || tabName.startsWith(MAPLESS_HALL_KEY + ':')) continue;
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

        // Step 2: 旧 MAPLESS_HALL_KEY を日付別キーに分離
        const collectedMapless = Array.from(maplessById.values());
        if (collectedMapless.length > 0) {
          // イベントのアイテムから日付リストを取得
          const eventItems = eventLists[eventName] || [];
          const dates = extractEventDates(eventItems);
          if (dates.length > 0) {
            // 各日付のキーにコピー（既存の日付別キーがなければ）
            for (const date of dates) {
              const dateKey = getMaplessKey(date);
              if (!byTab[dateKey] || byTab[dateKey].length === 0) {
                byTab[dateKey] = collectedMapless.map((h) => ({ ...h }));
                changed = true;
              }
            }
          }
        }
        // 旧キーを削除
        if (byTab[MAPLESS_HALL_KEY] != null) {
          delete byTab[MAPLESS_HALL_KEY];
          changed = true;
        }

        next[eventName] = byTab;
      }
      return changed ? next : prev;
    });

    // hallRouteSettings も同様にマイグレーション
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
    () => (activeEventName && eventDates.includes(activeTab) ? activeTab : ''),
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
    [activeEventName, isMapTab, activeEventDate, currentMapData, currentHalls, items, executeModeItems],
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
    [activeEventName, isMapTab, activeEventDate, currentMapData, currentHalls, items],
  );


  const getItemHallId = useCallback(
    (item: ShoppingItem, eventDate: string): string | null => {
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return null;

      // 1. 手動ホール設定が有効なら最優先
      const manual = resolveManualHallId(item.manualHallId, halls);
      if (manual) return manual;

      // 2. 既存のポリゴン判定
      const mapDataForDate = getMapDataForDate(eventDate);
      if (mapDataForDate) {
        const block = mapDataForDate.blocks.find((b) => b.name === item.block);
        if (block) {
          const centerRow = (block.startRow + block.endRow) / 2;
          const centerCol = (block.startCol + block.endCol) / 2;
          for (const hall of halls) {
            if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
              return hall.id;
            }
          }
        }
      }

      // 3. blockNames フォールバック
      return resolveHallByBlockName(item.block, halls);
    },
    [getHallsForDate, getMapDataForDate],
  );


  // ホール+優先度+スペースの境界チェック（個別アイテム移動用）
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

      const priority1 = item1.priorityLevel || 'none';
      const priority2 = item2.priorityLevel || 'none';
      if (hallId1 !== hallId2 || priority1 !== priority2) return false;

      // 同一スペース+同一優先度のアイテムが分散配置されないよう、スペースも比較
      const spaceKey1 = getSpaceKey(item1.block, item1.number);
      const spaceKey2 = getSpaceKey(item2.block, item2.number);
      return spaceKey1 === spaceKey2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  // ホール+優先度の境界チェックのみ（スペースグループ移動用）
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

      const priority1 = item1.priorityLevel || 'none';
      const priority2 = item2.priorityLevel || 'none';
      return hallId1 === hallId2 && priority1 === priority2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    if (activeEventDate) {
      const mode = modes[activeEventDate];
      if (mode) {
        return mode;
      }
      return 'edit';
    }
    return 'edit';
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

  // 有効な集中モードセッションキーの集合（イベント名×日付）。
  const validFocusSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    Object.entries(eventLists).forEach(([eventName, eventItems]) => {
      extractEventDates(eventItems).forEach((eventDate) => {
        keys.add(buildFocusSessionKey(eventName, eventDate));
      });
    });
    return keys;
  }, [eventLists]);

  // 無効化された集中モードセッションキーを掃除する。
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

  const currentFocusEventDate = useMemo(() => activeEventDate, [activeEventDate]);

  const currentFocusMapName = useMemo(
    () => (currentFocusEventDate ? `${currentFocusEventDate}マップ` : ''),
    [currentFocusEventDate],
  );

  const getDayMapRotationState = useCallback(
    (eventName: string, dayMapName: string) =>
      resolveDayMapRotationState(mapRotationSettings[eventName]?.[dayMapName]),
    [mapRotationSettings],
  );

  const updateMapRotationAngle = useCallback(
    (eventName: string, dayMapName: string, screen: RotationScreenType, angle: number) => {
      const normalizedAngle = normalizeRotationAngle(angle);
      setMapRotationSettings((prev) => {
        const eventSettings = prev[eventName] || {};
        const currentState = resolveDayMapRotationState(eventSettings[dayMapName]);
        const nextState =
          screen === 'mapTab'
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
      updateMapRotationAngle(activeEventName, currentMapTabName, 'mapTab', angle);
    },
    [activeEventName, isMapTab, currentMapTabName, updateMapRotationAngle],
  );

  const handleFocusMapRotationAngleChange = useCallback(
    (angle: number) => {
      if (!activeEventName || !currentFocusMapName) return;
      updateMapRotationAngle(activeEventName, currentFocusMapName, 'focusMode', angle);
    },
    [activeEventName, currentFocusMapName, updateMapRotationAngle],
  );

  // マップビューポート状態の取得・更新
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
    const layout = layoutMode === 'smartphone' ? 'sp' : 'pc';
    let rawHeader = true,
      rawTabBar = true;

    if (currentMode === 'focus') {
      const key =
        `focus_${layout}_${focusModeMapVisible ? 'mapOn' : 'mapOff'}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    } else if (currentMode === 'execute') {
      const key = `execute_${layout}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    }

    const hideSomething = !rawHeader || !rawTabBar;
    if (uiVisibilityOverride) {
      return { showHeaderBar: true, showTabBar: true, rawHideSomething: hideSomething };
    }
    return { showHeaderBar: rawHeader, showTabBar: rawTabBar, rawHideSomething: hideSomething };
  }, [
    uiVisibilityOverride,
    activeEventName,
    currentMode,
    layoutMode,
    focusModeMapVisible,
    uiVisibilitySettings,
  ]);

  const updateUIVisibilityConfig = useCallback(
    (key: keyof UIVisibilitySettings, field: 'header' | 'tabBar', value: boolean) => {
      setUiVisibilitySettings((prev) => ({
        ...prev,
        [key]: {
          ...DEFAULT_UI_VISIBILITY[key],
          ...prev[key],
          [field]: value,
        },
      }));
      // 設定変更を即時反映するため、強制表示モードを解除する。
      setUiVisibilityOverride(false);
    },
    [setUiVisibilitySettings],
  );

  const handleBulkAdd = useCallback(
    (
      eventName: string,
      newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[],
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
        setExecuteModeItems((prev) => ({
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
          const initialExecuteItems = buildInitialExecuteItemsForBulkAdd(newItems);
          setExecuteModeItems((prev) => ({
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

  const handleUpdateItem = useCallback(
    (updatedItem: ShoppingItem) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      const currentMode = dayModes[activeEventName]?.[currentEventDate];

      setEventLists((prev) => {
        const currentItems = prev[activeEventName] || [];
        const currentItem = currentItems.find((item) => item.id === updatedItem.id);

        const result = computeUpdateItem(
          currentItems,
          updatedItem,
          currentMode as ViewMode | undefined,
          currentItem?.protectionLevel,
          currentItem?.source,
        );

        if (result.purchaseStatusChanged) {
          setRecentlyChangedItemIds((prevIds) => new Set(prevIds).add(updatedItem.id));
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
      targetColumn?: 'execute' | 'candidate',
      sourceColumn?: 'execute' | 'candidate',
    ) => {
      if (!activeEventName) return;
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const effectiveSelectedIds = spaceGroupIds
        ? new Set(spaceGroupIds)
        : selectedItemIds;
      spaceGroupDragItemIdsRef.current = null;

      const currentExecuteItems = executeModeItems[activeEventName]?.[currentEventDate]
        ? { ...executeModeItems[activeEventName], [currentEventDate]: [...(executeModeItems[activeEventName]?.[currentEventDate] || [])] }
        : (executeModeItems[activeEventName] || {});

      // スペースグループ移動 or 複数スペース選択時はスペースチェックを緩和
      const selectionSpansMultipleSpaces = (() => {
        if (effectiveSelectedIds.size <= 1) return false;
        const spaceKeys = new Set<string>();
        effectiveSelectedIds.forEach((id) => {
          const item = (eventLists[activeEventName] || []).find((i) => i.id === id);
          if (item) spaceKeys.add(getSpaceKey(item.block, item.number));
        });
        return spaceKeys.size > 1;
      })();
      const hallCheck = (spaceGroupIds || selectionSpansMultipleSpaces)
        ? (id1: string, id2: string) => areItemsInSameHallGroup(id1, id2, currentEventDate)
        : (id1: string, id2: string) => areItemsInSameHall(id1, id2, currentEventDate);

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
        setEventLists((prev) => ({ ...prev, [activeEventName]: result.eventListItems! }));
      }
      if (result.executeModeItems) {
        setExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems! }));
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
    ],
  );
  const handleMoveItemVerticalInternal = useCallback(
    (direction: 'up' | 'down', itemId: string, targetColumn?: 'execute' | 'candidate') => {
      if (!activeEventName) return;
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      const spaceGroupIds = spaceGroupDragItemIdsRef.current;
      const isSpaceGroupMove = !!spaceGroupIds;

      // スペースグループ移動（スペース別表示の折りたたみグループ移動 or 個別アイテムのスペース境界越え）
      // → 選択中の全スペースグループをまとめて入れ替え
      if (mode === 'edit' && targetColumn === 'execute') {
        const dayItems = [...(executeModeItems[activeEventName]?.[currentEventDate] || [])];
        const getItemSpaceKey = (id: string): string => {
          const item = items.find((i) => i.id === id);
          return item ? getSpaceKey(item.block, item.number) : '';
        };

        // 選択中のアイテム（spaceGroupIds or selectedItemIds）を考慮して移動ブロックを決定
        const effectiveIds = spaceGroupIds ? new Set(spaceGroupIds) : selectedItemIds;
        // 移動対象のスペースキー一覧（クリックしたアイテムのスペース＋選択中のアイテムのスペース）
        const movingSpaceKeys = new Set<string>();
        movingSpaceKeys.add(getItemSpaceKey(itemId));
        effectiveIds.forEach((id) => {
          if (dayItems.includes(id)) {
            movingSpaceKeys.add(getItemSpaceKey(id));
          }
        });

        // 移動ブロック：movingSpaceKeysに含まれるスペースの連続した範囲を検出
        const movingIndices = dayItems
          .map((id, idx) => movingSpaceKeys.has(getItemSpaceKey(id)) ? idx : -1)
          .filter((idx) => idx >= 0);

        if (movingIndices.length > 0) {
          const movingStart = movingIndices[0];
          const movingEnd = movingIndices[movingIndices.length - 1];

          // 隣接アイテムの検出
          const adjacentIndex = direction === 'up' ? movingStart - 1 : movingEnd + 1;
          if (adjacentIndex >= 0 && adjacentIndex < dayItems.length) {
            const adjacentId = dayItems[adjacentIndex];
            const adjacentSpaceKey = getItemSpaceKey(adjacentId);

            // 隣接アイテムが移動ブロック外かつ異スペースの場合のみ入れ替え
            if (!movingSpaceKeys.has(adjacentSpaceKey)) {
              // 隣接スペースの連続ブロック範囲を検出
              let adjStart = adjacentIndex;
              let adjEnd = adjacentIndex;
              while (adjStart > 0 && getItemSpaceKey(dayItems[adjStart - 1]) === adjacentSpaceKey) adjStart--;
              while (adjEnd < dayItems.length - 1 && getItemSpaceKey(dayItems[adjEnd + 1]) === adjacentSpaceKey) adjEnd++;

              // 移動ブロックを抜き出して隣接ブロックの前後に挿入
              const movingBlock = dayItems.slice(movingStart, movingEnd + 1);
              const remaining = [...dayItems.slice(0, movingStart), ...dayItems.slice(movingEnd + 1)];

              // 隣接ブロックの位置を残りリストから再検出
              const adjItemIdx = remaining.findIndex((id) => id === adjacentId);
              if (adjItemIdx >= 0) {
                let insertIdx: number;
                if (direction === 'up') {
                  // 上方向：隣接スペースグループの先頭に挿入
                  let targetStart = adjItemIdx;
                  while (targetStart > 0 && getItemSpaceKey(remaining[targetStart - 1]) === adjacentSpaceKey) targetStart--;
                  insertIdx = targetStart;
                } else {
                  // 下方向：隣接スペースグループの末尾の次に挿入
                  let targetEnd = adjItemIdx;
                  while (targetEnd < remaining.length - 1 && getItemSpaceKey(remaining[targetEnd + 1]) === adjacentSpaceKey) targetEnd++;
                  insertIdx = targetEnd + 1;
                }

                remaining.splice(insertIdx, 0, ...movingBlock);

                setExecuteModeItems((prev) => ({
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

      // 通常の個別アイテム移動（同一スペース内）
      const effectiveSelectedIds = spaceGroupIds
        ? new Set(spaceGroupIds)
        : selectedItemIds;
      const hallCheck = spaceGroupIds
        ? (id1: string, id2: string) => areItemsInSameHallGroup(id1, id2, currentEventDate)
        : (id1: string, id2: string) => areItemsInSameHall(id1, id2, currentEventDate);

      const result = computeMoveItemVertical(
        direction,
        itemId,
        targetColumn,
        mode as ViewMode | undefined,
        effectiveSelectedIds,
        eventLists[activeEventName] || [],
        executeModeItems[activeEventName] || {},
        currentEventDate,
        hallCheck,
      );

      if (result.eventListItems) {
        setEventLists((prev) => ({ ...prev, [activeEventName]: result.eventListItems! }));
      }
      if (result.executeModeItems) {
        setExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems! }));
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
    ],
  );

  const handleMoveItemUp = useCallback(
    (itemId: string, targetColumn?: 'execute' | 'candidate') =>
      handleMoveItemVerticalInternal('up', itemId, targetColumn),
    [handleMoveItemVerticalInternal],
  );

  const handleMoveItemDown = useCallback(
    (itemId: string, targetColumn?: 'execute' | 'candidate') =>
      handleMoveItemVerticalInternal('down', itemId, targetColumn),
    [handleMoveItemVerticalInternal],
  );

  // 選択されたアイテムIDに同一スペース+同一優先度の全アイテムを自動追加
  const expandToFullSpaceGroups = useCallback(
    (itemIds: string[]): string[] => {
      const expandedSet = new Set(itemIds);
      itemIds.forEach((id) => {
        const item = items.find((i) => i.id === id);
        if (!item) return;
        const spaceKey = getSpaceKey(item.block, item.number);
        const priority = item.priorityLevel || 'none';
        items.forEach((other) => {
          if (expandedSet.has(other.id)) return;
          if (other.eventDate !== item.eventDate) return;
          if (getSpaceKey(other.block, other.number) === spaceKey &&
              (other.priorityLevel || 'none') === priority) {
            expandedSet.add(other.id);
          }
        });
      });
      return Array.from(expandedSet);
    },
    [items],
  );

  const handleMoveToExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;

      // 同一スペース+同一優先度の全アイテムを自動追加
      const expandedIds = expandToFullSpaceGroups(itemIds);

      if (
        rangeStart &&
        expandedIds.includes(rangeStart.itemId) &&
        rangeStart.columnType === 'candidate'
      ) {
        setRangeStart(null);
        setRangeEnd(null);
      } else if (
        rangeEnd &&
        expandedIds.includes(rangeEnd.itemId) &&
        rangeEnd.columnType === 'candidate'
      ) {
        setRangeEnd(null);
      }

      const newExecuteItems = computeMoveToExecuteColumn(
        expandedIds,
        currentEventDate,
        items,
        executeModeItems[activeEventName] || {},
        selectedBlockFilters,
      );

      setExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: newExecuteItems,
      }));

      setSelectedItemIds(new Set());
    },
    [
      activeEventName,
      activeTab,
      eventDates,
      rangeStart,
      rangeEnd,
      items,
      executeModeItems,
      selectedBlockFilters,
      expandToFullSpaceGroups,
    ],
  );
  const handleRemoveFromExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;

      // 同一スペース+同一優先度の全アイテムを自動追加
      const expandedIds = expandToFullSpaceGroups(itemIds);

      if (
        rangeStart &&
        expandedIds.includes(rangeStart.itemId) &&
        rangeStart.columnType === 'execute'
      ) {
        setRangeStart(null);
        setRangeEnd(null);
      } else if (
        rangeEnd &&
        expandedIds.includes(rangeEnd.itemId) &&
        rangeEnd.columnType === 'execute'
      ) {
        setRangeEnd(null);
      }

      const newExecuteItems = computeRemoveFromExecuteColumn(
        expandedIds,
        executeModeItems[activeEventName] || {},
        currentEventDate,
      );

      setExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: newExecuteItems,
      }));

      setSelectedItemIds(new Set());
    },
    [activeEventName, activeTab, eventDates, rangeStart, rangeEnd, executeModeItems, expandToFullSpaceGroups],
  );

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;

    const currentEventDate = activeEventDate;
    if (!currentEventDate) {
      alert('参加日タブが選択されていないため、表示モードを切り替えできません。');
      return;
    }

    const currentModeValue = dayModes[activeEventName]?.[currentEventDate];
    if (!currentModeValue) {
      alert('表示モードが未設定のため、表示モードを切り替えできません。');
      return;
    }
    const newMode: ViewMode = currentModeValue === 'edit' ? 'execute' : 'edit';

    setDayModes((prev) => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: newMode,
      },
    }));

    setSelectedItemIds(new Set());
    setCandidateNumberSortDirection(null);
  }, [activeEventName, activeTab, dayModes, eventDates]);


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

      setSelectedItemIds(new Set());
      setCandidateNumberSortDirection(null);


      if (mode !== 'focus') {
        setFocusModeMapVisible(false);
      }
      setUiVisibilityOverride(false);
      setUiSettingsPanelOpen(false);


      if (scrollToItemId) {
        setTimeout(() => {
          const element = document.querySelector(`[data-item-id="${scrollToItemId}"]`);
          if (element) {
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, 100);
      }
    },
    [activeEventName, activeEventDate, activeTab, eventDates],
  );

  const handleSelectEvent = useCallback(
    (eventName: string) => {
      const eventItems = eventLists[eventName] || [];
      const nextTab = resolveEventListTab(eventItems);
      if (!nextTab) {
        alert('参加日がないため処理を停止しました。');
        return;
      }

      setActiveEventName(eventName);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());
      setActiveTab(nextTab);
    },
    [eventLists],
  );

  const handleDeleteEvent = useCallback(
    (eventName: string) => {
      setEventLists((prev) => removeRecordKey(prev, eventName));
      setEventMetadata((prev) => removeRecordKey(prev, eventName));
      setExecuteModeItems((prev) => removeRecordKey(prev, eventName));
      setDayModes((prev) => removeRecordKey(prev, eventName));
      setMapData((prev) => removeRecordKey(prev, eventName));
      setMapRotationSettings((prev) => removeRecordKey(prev, eventName));
      setRouteSettings((prev) => removeRecordKey(prev, eventName));
      setHallDefinitions((prev) => removeRecordKey(prev, eventName));
      setHallRouteSettings((prev) => removeRecordKey(prev, eventName));
      setFocusModeSessions((prev) => removeFocusModeSessionByEvent(prev, eventName));
      if (activeEventName === eventName) {
        setActiveEventName(null);
        setActiveTab('eventList');
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
        alert('同名のイベントが既に存在します。別の名前を指定してください。');
        return;
      }

      setEventLists((prev) => renameRecordKey(prev, eventToRename, newName));

      setEventMetadata((prev) => renameRecordKey(prev, eventToRename, newName));

      setDayModes((prev) => renameRecordKey(prev, eventToRename, newName));

      setExecuteModeItems((prev) => renameRecordKey(prev, eventToRename, newName));


      setMapData((prev) => renameRecordKey(prev, eventToRename, newName));
      setMapRotationSettings((prev) => renameRecordKey(prev, eventToRename, newName));


      setRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));


      setHallDefinitions((prev) => renameRecordKey(prev, eventToRename, newName));


      setHallRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));
      setFocusModeSessions((prev) => renameFocusModeSessionKeys(prev, eventToRename, newName));

      if (activeEventName === eventToRename) {
        setActiveEventName(newName);
      }

      setShowRenameDialog(false);
      setEventToRename(null);
    },
    [eventToRename, eventLists, activeEventName],
  );

  const handleSortToggle = () => {
    setSelectedItemIds(new Set());
    setBlockSortDirection(null);
    setRecentlyChangedItemIds(new Set());
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;

      const itemsForTab = allItems.filter((item) => item.eventDate === currentTabKey);

      if (itemsForTab.length === 0) return prev;

      const sortedItemsForTab = [...itemsForTab].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
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
    setSelectedItemIds(new Set());
  };

  const handleBlockSortToggleCandidate = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);


      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );

      if (candidateItems.length === 0) return prev;

      const sortedCandidateItems = [...candidateItems].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
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
    setSelectedItemIds(new Set());
  };

  const handleEditRequest = (item: ShoppingItem) => {
    setEditDialogItem(item);
  };

  const handleDeleteRequest = useCallback((item: ShoppingItem) => {
    setItemToDelete(item);
  }, []);

  const handleDeleteItemFromMap = useCallback((itemId: string) => {
    const item = items.find((i) => i.id === itemId);
    if (item) setItemToDelete(item);
  }, [items]);

  const handleClearNewItemDefaults = useCallback(() => {
    setNewItemDefaults(null);
  }, []);

  const handleModeChangeFromFocus = useCallback(
    (mode: 'edit' | 'execute', lastItemId?: string) => handleSetViewMode(mode, lastItemId),
    [handleSetViewMode],
  );

  const handleConfirmDelete = () => {
    if (!itemToDelete || !activeEventName) return;

    const result = computeDeleteItem(
      eventLists[activeEventName] || [],
      itemToDelete.id,
      executeModeItems[activeEventName] || {},
    );

    setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
    setExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems }));
    setItemToDelete(null);
  };

  const handleDoneEditing = () => {
    if (itemToEdit?.eventDate) {
      setItemToEdit(null);
      setActiveTab(itemToEdit.eventDate);
    } else {
      setItemToEdit(null);
      alert('参加日がないため処理を停止しました。');
      setActiveTab('eventList');
    }
  };

  const getListColumnItems = useCallback(
    (columnType: 'execute' | 'candidate', currentEventDate: string): ShoppingItem[] => {
      if (!activeEventName) return [];

      if (columnType === 'execute') {
        const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
        const itemsMap = new Map(items.map((item) => [item.id, item]));
        return executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
      }

      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      let filtered = items.filter(
        (item) => item.eventDate === currentEventDate && !executeIds.has(item.id),
      );
      if (selectedBlockFilters.size > 0) {
        filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
      }
      return filtered;
    },
    [activeEventName, executeModeItems, items, selectedBlockFilters],
  );

  const handleSelectItem = useCallback(
    (itemId: string, columnType?: 'execute' | 'candidate') => {
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = activeEventDate;
      const currentColumnType =
        columnType ||
        (activeEventName
          ? executeModeItems[activeEventName]?.[currentEventDate]?.includes(itemId)
            ? 'execute'
            : 'candidate'
          : 'execute');

      selectItemForRange(itemId, currentColumnType, getListColumnItems(currentColumnType, currentEventDate));
    },
    [
      activeTab,
      activeEventName,
      executeModeItems,
      eventDates,
      getListColumnItems,
      selectItemForRange,
    ],
  );

  // 折りたたみスペースグループのチェックボックス用：範囲選択対応
  const handleSelectSpaceGroupForRange = useCallback(
    (firstItemId: string, allItemIds: string[], columnType: 'execute' | 'candidate') => {
      setSortState('Manual');
      setBlockSortDirection(null);

      // 隣接グループ判定用：現在のカラムのアイテムからスペースグループ順を算出
      const currentEventDate = activeEventDate;
      selectSpaceGroupForRange(
        firstItemId,
        allItemIds,
        columnType,
        getListColumnItems(columnType, currentEventDate),
      );
    },
    [activeEventDate, getListColumnItems, selectSpaceGroupForRange],
  );

  // スペース別グループ化の状態。
  const spaceGroupDragItemIdsRef = useRef<string[] | null>(null);

  // 実行モード用スペース別グループ化の状態（編集モードとは独立）
  const [showPostponeFilterButton, setShowPostponeFilterButton] = useState(false);
  const [showLateFilterButton, setShowLateFilterButton] = useState(false);
  const executeSpaceGroupOrderRef = useRef<string[]>([]); // ShoppingListから通知される表示順序
  const executeColumnItemsRef = useRef<ShoppingItem[]>([]); // handleExecuteItemUpdate用
  const recentlyChangedItemIdsRef = useRef<Set<string>>(new Set()); // Postponeフィルタ内可視アイテム判定用

  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<
    'asc' | 'desc' | null
  >(null);

  const handleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection = candidateNumberSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = activeEventDate;

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);


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
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
      });


      const sortedCandidateMap = new Map(
        sortedCandidateItems.map((item, index) => [item.id, { item, sortIndex: index }]),
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
          const { item: sortedItem, sortIndex } = sortedCandidateMap.get(item.id)!;
          candidateItemsToSort.push({ item: sortedItem, originalIndex: index, sortIndex });
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
    setSelectedItemIds(new Set());
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    selectedBlockFilters,
    candidateNumberSortDirection,
    eventDates,
  ]);

  const handleClearSelection = clearSelection;
  const handleToggleBlockFilter = toggleBlockFilter;
  const handleClearBlockFilters = clearBlockFilters;

  const handleToggleSpaceCollapse = useCallback((spaceKey: string) => {
    toggleCollapsedSpace(spaceKey);
  }, [toggleCollapsedSpace]);

  const handleToggleAllSpaceCollapse = useCallback((collapse: boolean) => {
    if (!collapse) {
      setCollapsedSpaces(new Set());
    } else {
      const allGroupKeys = new Set<string>();
      items
        .filter((item) => item.eventDate === activeEventDate)
        .forEach((item) => {
          const spaceKey = getSpaceKey(item.block, item.number);
          const priority = item.priorityLevel || 'none';
          const groupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
          allGroupKeys.add(groupKey);
        });
      setCollapsedSpaces(allGroupKeys);
    }
  }, [items, activeEventDate]);

  // 実行モード用スペース折りたたみトグル
  const handleExecuteToggleSpaceCollapse = useCallback((spaceKey: string) => {
    toggleExecuteCollapsedSpace(spaceKey);
  }, [toggleExecuteCollapsedSpace]);

  // 実行モード用全スペース折りたたみ/展開
  const handleExecuteToggleAllSpaceCollapse = useCallback((collapse: boolean) => {
    if (!collapse) {
      setExecuteCollapsedSpaces(new Set());
    } else {
      if (!activeEventName) return;
      const currentEventDate = activeEventDate;
      const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
      const itemsMap = new Map(items.map((item) => [item.id, item]));
      const allGroupKeys = new Set<string>();
      executeIds.forEach((id) => {
        const item = itemsMap.get(id);
        if (!item) return;
        const spaceKey = getSpaceKey(item.block, item.number);
        const priority = item.priorityLevel || 'none';
        const groupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
        allGroupKeys.add(groupKey);
      });
      setExecuteCollapsedSpaces(allGroupKeys);
    }
  }, [activeEventName, activeEventDate, executeModeItems, items]);

  // 実行モード用スペース内全アイテム一括ステータス変更（トグル動作）
  const handleBulkStatusChange = useCallback(
    (groupKey: string, targetStatus: PurchaseStatus, groupItems: ShoppingItem[]) => {
      if (!activeEventName) return;
      const allAlready = groupItems.every((item) => item.purchaseStatus === targetStatus);
      const newStatus: PurchaseStatus = allAlready ? 'None' : targetStatus;
      setEventLists((prev) => {
        const allItems = [...(prev[activeEventName] || [])];
        const groupItemIds = new Set(groupItems.map((item) => item.id));
        return {
          ...prev,
          [activeEventName]: allItems.map((item) =>
            groupItemIds.has(item.id) ? { ...item, purchaseStatus: newStatus } : item,
          ),
        };
      });
      // recentlyChangedItemIds に追加
      setRecentlyChangedItemIds((prevIds) => {
        const next = new Set(prevIds);
        groupItems.forEach((item) => next.add(item.id));
        return next;
      });

      // 最下段グループの一括変更で全アイテム非未購入→後回しフィルタボタン表示
      if (sortState === 'Manual' && newStatus !== 'None') {
        const groupOrder = executeSpaceGroupOrderRef.current;
        if (groupOrder.length > 0 && groupKey === groupOrder[groupOrder.length - 1]) {
          const currentItems = executeColumnItemsRef.current;
          const groupItemIds = new Set(groupItems.map((item) => item.id));
          const allNonNone = currentItems.every(
            (item) => groupItemIds.has(item.id) || item.purchaseStatus !== 'None',
          );
          if (allNonNone) setShowPostponeFilterButton(true);
        }
      }

      // 後回しフィルタ中: 最下段グループの一括変更で全可視アイテム非未購入→遅参フィルタボタン表示
      if (sortState === 'Postpone' && newStatus !== 'None') {
        const groupOrder = executeSpaceGroupOrderRef.current;
        if (groupOrder.length > 0 && groupKey === groupOrder[groupOrder.length - 1]) {
          const currentItems = executeColumnItemsRef.current;
          const groupItemIds = new Set(groupItems.map((item) => item.id));
          const recentIds = recentlyChangedItemIdsRef.current;
          // Postponeフィルタ内の可視アイテム（グループ外）が全て非Noneか判定
          const allVisibleNonNone = currentItems.every((item) => {
            if (groupItemIds.has(item.id)) return true; // グループ内はnewStatus(非None)になる
            // 可視でないアイテムはスキップ
            if (item.purchaseStatus !== 'Postpone' && !recentIds.has(item.id)) return true;
            return item.purchaseStatus !== 'None';
          });
          if (allVisibleNonNone) setShowLateFilterButton(true);
        }
      }
    },
    [activeEventName, sortState],
  );

  // 実行モード用アイテム更新ラッパー
  const handleExecuteItemUpdate = useCallback(
    (updatedItem: ShoppingItem) => {
      handleUpdateItem(updatedItem);

      // 最下段アイテムのステータス変更で全アイテム非未購入→フィルタボタン表示
      if (sortState !== 'Manual' && sortState !== 'Postpone') return;
      if (updatedItem.purchaseStatus === 'None') return;

      const groupOrder = executeSpaceGroupOrderRef.current;
      if (groupOrder.length === 0) return;
      const lastGroupKey = groupOrder[groupOrder.length - 1];

      // このアイテムのgroupKeyを計算
      const spaceKey = getSpaceKey(updatedItem.block, updatedItem.number);
      const priority = updatedItem.priorityLevel || 'none';
      const itemGroupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
      if (itemGroupKey !== lastGroupKey) return;

      const currentItems = executeColumnItemsRef.current;

      if (sortState === 'Manual') {
        // Manual: 最後のグループ内の最後のアイテムか判定
        const lastGroupItems = currentItems.filter((item) => {
          const sk = getSpaceKey(item.block, item.number);
          const p = item.priorityLevel || 'none';
          return (p !== 'none' ? `${sk}:${p}` : sk) === lastGroupKey;
        });
        if (lastGroupItems[lastGroupItems.length - 1]?.id !== updatedItem.id) return;

        // 全アイテムが非Noneになるか
        const allNonNone = currentItems.every(
          (item) => item.id === updatedItem.id || item.purchaseStatus !== 'None',
        );
        if (allNonNone) setShowPostponeFilterButton(true);
      } else {
        // Postpone: 可視アイテム内の最後のグループの最後のアイテムか判定
        const recentIds = recentlyChangedItemIdsRef.current;
        const visibleLastGroupItems = currentItems.filter((item) => {
          const sk = getSpaceKey(item.block, item.number);
          const p = item.priorityLevel || 'none';
          const gk = p !== 'none' ? `${sk}:${p}` : sk;
          if (gk !== lastGroupKey) return false;
          return item.purchaseStatus === 'Postpone' || recentIds.has(item.id);
        });
        if (visibleLastGroupItems[visibleLastGroupItems.length - 1]?.id !== updatedItem.id) return;

        // 全可視アイテムが非Noneになるか
        const allVisibleNonNone = currentItems.every((item) => {
          if (item.id === updatedItem.id) return true; // 更新アイテムは非None確定
          if (item.purchaseStatus !== 'Postpone' && !recentIds.has(item.id)) return true;
          return item.purchaseStatus !== 'None';
        });
        if (allVisibleNonNone) setShowLateFilterButton(true);
      }
    },
    [handleUpdateItem, sortState],
  );

  // 後回しフィルタボタンのクリックで後回しフィルタを有効化
  const handleActivatePostponeFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState('Postpone');
    setShowPostponeFilterButton(false);
  }, []);

  // 遅参フィルタボタンのクリックで遅参フィルタを有効化
  const handleActivateLateFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState('Late');
    setShowLateFilterButton(false);
  }, []);

  // ShoppingListからスペースグループの表示順序を受け取るコールバック
  const handleExecuteSpaceGroupOrderChange = useCallback((orderedGroupKeys: string[]) => {
    executeSpaceGroupOrderRef.current = orderedGroupKeys;
  }, []);

  // 現スペース折りたたみ＋次スペース展開
  const handleCollapseAndOpenNext = useCallback((currentGroupKey: string) => {
    const order = executeSpaceGroupOrderRef.current;
    const currentIndex = order.indexOf(currentGroupKey);
    const nextKey = currentIndex >= 0 && currentIndex < order.length - 1
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
  }, []);

  const handleSetSpaceGroupDragItemIds = useCallback((itemIds: string[] | null) => {
    spaceGroupDragItemIdsRef.current = itemIds;
  }, []);

  const handleToggleRangeSelection = useCallback(
    (columnType: 'execute' | 'candidate') => {
      if (!activeEventName) return;

      const currentEventDate = activeEventDate;
      toggleCurrentRangeSelection(columnType, getListColumnItems(columnType, currentEventDate), {
        halls: getHallsForDate(currentEventDate),
        currentMapData: getMapDataForDate(currentEventDate),
      });
    },
    [
      activeEventName,
      activeEventDate,
      getListColumnItems,
      getHallsForDate,
      getMapDataForDate,
      toggleCurrentRangeSelection,
    ],
  );

  const handleBulkSort = useCallback(
    (direction: BulkSortDirection) => {
      if (!activeEventName || selectedItemIds.size === 0) return;
      setSortState('Manual');
      setBlockSortDirection(null);
      const currentEventDate = activeEventDate;
      const mode = dayModes[activeEventName]?.[currentEventDate];

      if (mode === 'edit') {
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
        const isInExecuteColumn = selectedItems.some((item) => executeIds.has(item.id));
        const isInCandidateColumn = selectedItems.some((item) => !executeIds.has(item.id));

        if (isInExecuteColumn && !isInCandidateColumn) {
          setExecuteModeItems((prev) => {
            const eventItems = prev[activeEventName] || {};
            const dayItems = [...(eventItems[currentEventDate] || [])];

            const itemsMap = new Map(items.map((item) => [item.id, item]));
            const selectedItems = dayItems
              .filter((id) => selectedItemIds.has(id))
              .map((id) => itemsMap.get(id)!)
              .filter(Boolean);

            const otherItems = dayItems.filter((id) => !selectedItemIds.has(id));
            selectedItems.sort((a, b) => {
              const comparison = a.number.localeCompare(b.number, undefined, {
                numeric: true,
                sensitivity: 'base',
              });
              return direction === 'asc' ? comparison : -comparison;
            });

            const firstSelectedIndex = dayItems.findIndex((id) => selectedItemIds.has(id));
            if (firstSelectedIndex === -1) return prev;
            const newDayItems = [...otherItems];
            newDayItems.splice(firstSelectedIndex, 0, ...selectedItems.map((item) => item.id));
            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: newDayItems },
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
              (item) => item.eventDate === currentTabKey && !executeIdsSet.has(item.id),
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
                sensitivity: 'base',
              });
              return direction === 'asc' ? comparison : -comparison;
            });

            const firstSelectedIndex = candidateItems.findIndex((item) =>
              selectedItemIds.has(item.id),
            );
            if (firstSelectedIndex === -1) return prev;

            const sortedCandidateItems = [...otherCandidateItems];
            sortedCandidateItems.splice(firstSelectedIndex, 0, ...selectedCandidateItems);


            const executeItems = allItems.filter(
              (item) => item.eventDate === currentTabKey && executeIdsSet.has(item.id),
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
          const selectedItems = currentItems.filter((item) => selectedItemIds.has(item.id));
          const otherItems = currentItems.filter((item) => !selectedItemIds.has(item.id));

          selectedItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, {
              numeric: true,
              sensitivity: 'base',
            });
            return direction === 'asc' ? comparison : -comparison;
          });

          const firstSelectedIndex = currentItems.findIndex((item) => selectedItemIds.has(item.id));
          if (firstSelectedIndex === -1) return prev;

          const newItems = [...otherItems];
          newItems.splice(firstSelectedIndex, 0, ...selectedItems);

          return { ...prev, [activeEventName]: newItems };
        });
      }
    },
    [activeEventName, selectedItemIds, items, activeTab, dayModes, executeModeItems, eventDates],
  );


  const handleExportEvent = useCallback(
    (eventName: string) => {
      const itemsToExport = eventLists[eventName];
      if (!hasExportableItems(itemsToExport)) {
        alert('出力できるアイテムがありません。');
        return;
      }
      setExportEventName(eventName);
      setShowExportOptions(true);
    },
    [eventLists],
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
        console.error('Export error:', error);
        alert('アイテムの出力に失敗しました。');
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

      e.target.value = '';

      try {
        const result = await importFromXlsx(file);

        if (!result.success) {
          alert(`インポートに失敗しました:\n${result.errors.join('\n')}`);
          return;
        }

        const fallbackWarnings = result.itemFallbackWarnings || [];
        const skippedItemIds = new Set<string>();
        const BULK_APPROVAL_THRESHOLD = 6;

        const describeFallbackWarning = (warning: ItemFallbackWarning): string =>
          `${warning.rowNumber}行目\n${warning.reasons.map((reason) => `- ${reason}`).join('\n')}`;

        if (fallbackWarnings.length >= BULK_APPROVAL_THRESHOLD) {
          const previewLines = fallbackWarnings
            .slice(0, 5)
            .map((warning) => `- ${warning.rowNumber}行目: ${warning.reasons[0] || '補完が必要です'}`);
          const previewText = previewLines.join('\n');
          const hasMore = fallbackWarnings.length > 5 ? '\n- ...' : '';

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

        const resolvedItems = result.items.filter((item) => !skippedItemIds.has(item.id));
        if (resolvedItems.length === 0) {
          if (result.items.length > 0 && skippedItemIds.size > 0) {
            alert('不正データをすべてスキップしたため、取り込み対象がありませんでした。');
          } else {
            alert('取り込んだファイルにアイテムが見つかりませんでした。');
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
            fallbackResolutionMessages.push(`不正データ${skippedCount}件をスキップしました。`);
          }
        }

        const resolvedResult = {
          ...result,
          items: resolvedItems,
          errors: [...result.errors, ...fallbackResolutionMessages],
        };

        if (resolvedResult.items.length === 0) {
          alert('取り込んだファイルにアイテムが見つかりませんでした。');
          return;
        }

        const importedData = toImportedEventData(resolvedResult);
        const eventName = importedData.eventName;
        const isUpdate = !!eventLists[eventName];


        setEventLists((prev) => upsertRecordKey(prev, eventName, importedData.items));


        if (importedData.metadata) {
          const metadata = importedData.metadata;
          setEventMetadata((prev) => upsertRecordKey(prev, eventName, metadata));
        }


        if (importedData.executeModeItems) {
          const executeItems = importedData.executeModeItems;
          setExecuteModeItems((prev) => upsertRecordKey(prev, eventName, executeItems));
        }
        if (importedData.dayModes) {
          const importedDayModes = importedData.dayModes;
          setDayModes((prev) => upsertRecordKey(prev, eventName, importedDayModes));
        }


        if (importedData.mapData) {
          const importedMapData = importedData.mapData;
          setMapData((prev) => upsertRecordKey(prev, eventName, importedMapData));
        }


        if (importedData.routeSettings) {
          const importedRouteSettings = importedData.routeSettings;
          setRouteSettings((prev) => upsertRecordKey(prev, eventName, importedRouteSettings));
        }


        if (importedData.hallDefinitions) {
          const importedHallDefinitions = importedData.hallDefinitions;
          setHallDefinitions((prev) => upsertRecordKey(prev, eventName, importedHallDefinitions));
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
          alert('参加日がないため処理を停止しました。');
          return;
        }
        setActiveEventName(eventName);
        setActiveTab(nextTab);
      } catch (error) {
        console.error('Import error:', error);
        alert('アイテムの取り込みに失敗しました。ファイル形式を確認してください。');
      }
    },
    [eventLists],
  );


  const handleUpdateEvent = useCallback(
    async (eventName: string, urlOverride?: { url: string; sheetName: string }) => {
      const metadata = eventMetadata[eventName];
      const source = resolveSpreadsheetSource(metadata, urlOverride);

      if (!source) {
        setPendingUpdateEventName(eventName);
        setShowUrlUpdateDialog(true);
        return;
      }

      try {
        const currentItems = eventLists[eventName] || [];
        const updateDiff = await buildEventUpdateDiffFromSpreadsheet(currentItems, source);
        setUpdateData(updateDiff);
        setUpdateEventName(eventName);
        setShowUpdateConfirmation(true);
      } catch (error) {
        console.error('Update error:', error);
        setPendingUpdateEventName(eventName);
        setShowUrlUpdateDialog(true);
      }
    },
    [eventLists, eventMetadata],
  );

  const handleConfirmUpdate = () => {
    if (!updateData || !updateEventName) return;

    const { itemsToDelete, itemsToUpdate, itemsToAdd } = updateData;
    const eventName = updateEventName;

    setEventLists((prev) => {
      const newItems = applyEventUpdateToItems(prev[eventName] || [], {
        itemsToDelete,
        itemsToUpdate,
        itemsToAdd,
      });
      return { ...prev, [eventName]: newItems };
    });


    setExecuteModeItems((prev) => {
      const eventItems = prev[eventName];
      if (!eventItems) return prev;

      const deleteIds = new Set(itemsToDelete.map((item) => item.id));
      const updatedEventItems = removeDeletedIdsFromExecuteModeItems(eventItems, deleteIds);

      return {
        ...prev,
        [eventName]: updatedEventItems,
      };
    });

    setShowUpdateConfirmation(false);
    setUpdateData(null);
    setUpdateEventName(null);
    alert('アイテムを更新しました。');
  };

  const handleUrlUpdate = useCallback(
    (newUrl: string, sheetName: string) => {
      setShowUrlUpdateDialog(false);
      if (!pendingUpdateEventName) return;

      const eventName = pendingUpdateEventName;
      const currentMetadata = eventMetadata[eventName];
      const normalizedSheetName = sheetName || currentMetadata?.spreadsheetSheetName || '';

      setEventMetadata((prev) =>
        upsertRecordKey(prev, eventName, {
          spreadsheetUrl: newUrl,
          spreadsheetSheetName: normalizedSheetName,
          lastImportDate: currentMetadata?.lastImportDate || '',
        }),
      );

      setPendingUpdateEventName(null);
      handleUpdateEvent(eventName, { url: newUrl, sheetName: normalizedSheetName });
    },
    [pendingUpdateEventName, eventMetadata, handleUpdateEvent],
  );


  const handleImportMapData = useCallback(async (eventName: string) => {
    if (mapFileInputRef.current) {
      mapFileInputRef.current.dataset.eventName = eventName;
      mapFileInputRef.current.click();
    }
  }, []);

  const handleMapFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const eventName = e.target.dataset.eventName;

    if (!file || !eventName) return;


    setMapImportPendingFile(file);
    setMapImportPendingEventName(eventName);
    setMapImportDialogOpen(true);

    e.target.value = '';
  }, []);


  const handleMapImportConfirm = useCallback(
    (
      parsedData: Record<string, DayMapData>,
      settings: BlockDetectionSettings,
      initialAngles: Record<string, number>,
    ) => {
      const eventName = mapImportPendingEventName;
      if (!eventName) return;

      saveBlockDetectionSettings(eventName, settings);

      const eventDatesForTargetEvent = extractEventDates(eventLists[eventName] || []);
      const skippedDays = new Set<string>();
      const normalizedParsedData: Record<string, DayMapData> = {};
      const normalizedInitialAngles: Record<string, number> = {};

      Object.entries(parsedData).forEach(([mapName, dayMapData]) => {
        const mapTabName = resolveImportMapTabName(mapName, eventDatesForTargetEvent);
        if (!mapTabName) {
          skippedDays.add(normalizeMapDayToken(mapName) || mapName);
          return;
        }

        normalizedParsedData[mapTabName] = dayMapData;
        normalizedInitialAngles[mapTabName] = initialAngles[mapName] ?? 0;
      });

      setMapData((prev) => ({
        ...prev,
        [eventName]: {
          ...(prev[eventName] || {}),
          ...normalizedParsedData,
        },
      }));

      setMapRotationSettings((prev) => {
        const currentEventSettings = prev[eventName] || {};
        const nextEventSettings = { ...currentEventSettings };

        Object.keys(normalizedParsedData).forEach((dayMapName) => {
          const importedInitialAngle = normalizeRotationAngle(normalizedInitialAngles[dayMapName] ?? 0);
          nextEventSettings[dayMapName] = {
            initialAngle: importedInitialAngle,
            mapTabAngle: importedInitialAngle,
            focusModeAngle: importedInitialAngle,
          };
        });

        return {
          ...prev,
          [eventName]: nextEventSettings,
        };
      });

      const mapCount = Object.keys(normalizedParsedData).length;


      const firstMapName = Object.keys(normalizedParsedData)[0];
      if (firstMapName) {
        setActiveTab(firstMapName);
      }


      setMapImportDialogOpen(false);
      setMapImportPendingFile(null);
      setMapImportPendingEventName('');

      const skippedMessages = Array.from(skippedDays)
        .sort((a, b) => a.localeCompare(b, 'ja'))
        .map((dayName) => `${dayName}はないので取り込みしませんでした`);

      const messages: string[] = [];
      if (mapCount > 0) {
        messages.push(`${mapCount}件のマップタブを取り込みました。`);
      }
      messages.push(...skippedMessages);

      if (messages.length > 0) {
        alert(messages.join('\n'));
      }
    },
    [eventLists, mapImportPendingEventName],
  );


  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
  }, []);


  const handleAddToExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab || !currentMapTabName || !activeEventDate) return;

      const dayName = activeEventDate;
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[currentMapTabName] || {
        hallOrder: [],
        hallVisitLists: [],
      };
      const currentMapData = mapData[activeEventName]?.[currentMapTabName];

      const newExecuteItems = computeAddToExecuteListFromMap(
        itemId,
        dayName,
        items,
        executeModeItems[activeEventName] || {},
        halls,
        hallRouteSettingsForMap,
        currentMapData,
      );

      setExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: newExecuteItems,
      }));
    },
    [activeEventName, activeEventDate, currentMapTabName, isMapTab, items, hallDefinitions, hallRouteSettings, mapData, executeModeItems],
  );


  const handleAddToExecuteListFromMapAtPosition = useCallback(
    (itemId: string, referenceItemId: string, position: 'before' | 'after') => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;

      const dayName = activeEventDate;
      const newExecuteItems = computeAddToExecuteListFromMapAtPosition(
        itemId,
        referenceItemId,
        position,
        executeModeItems[activeEventName] || {},
        dayName,
      );

      setExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: newExecuteItems,
      }));
    },
    [activeEventName, activeEventDate, isMapTab, executeModeItems],
  );


  const handleRemoveFromExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;

      const dayName = activeEventDate;
      const newExecuteItems = computeRemoveFromExecuteListFromMap(
        itemId,
        executeModeItems[activeEventName] || {},
        dayName,
      );

      setExecuteModeItems((prev) => ({
        ...prev,
        [activeEventName]: newExecuteItems,
      }));
    },
    [activeEventName, activeEventDate, isMapTab, executeModeItems],
  );


  const handleBatchAddToExecuteListFromMap = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName || !activeEventDate) return;
      const dayName = activeEventDate;
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[currentMapTabName] || {
        hallOrder: [],
        hallVisitLists: [],
      };
      const currentMap = mapData[activeEventName]?.[currentMapTabName];

      setExecuteModeItems((prev) => {
        let current = prev[activeEventName] || {};
        for (const id of itemIds) {
          current = computeAddToExecuteListFromMap(id, dayName, items, current, halls, hallRouteSettingsForMap, currentMap);
        }
        return { ...prev, [activeEventName]: current };
      });
    },
    [activeEventName, activeEventDate, currentMapTabName, isMapTab, items, hallDefinitions, hallRouteSettings, mapData],
  );


  const handleBatchAddToExecuteListFromMapAtPosition = useCallback(
    (itemIds: string[], referenceItemId: string, position: 'before' | 'after') => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      const dayName = activeEventDate;

      setExecuteModeItems((prev) => {
        let current = prev[activeEventName] || {};
        if (position === 'before') {
          for (let i = itemIds.length - 1; i >= 0; i--) {
            current = computeAddToExecuteListFromMapAtPosition(itemIds[i], referenceItemId, 'before', current, dayName);
          }
        } else {
          let ref = referenceItemId;
          for (const id of itemIds) {
            current = computeAddToExecuteListFromMapAtPosition(id, ref, 'after', current, dayName);
            ref = id;
          }
        }
        return { ...prev, [activeEventName]: current };
      });
    },
    [activeEventName, activeEventDate, isMapTab],
  );


  const handleBatchRemoveFromExecuteListFromMap = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName || !isMapTab || !activeEventDate) return;
      const dayName = activeEventDate;

      setExecuteModeItems((prev) => {
        let current = prev[activeEventName] || {};
        for (const id of itemIds) {
          current = computeRemoveFromExecuteListFromMap(id, current, dayName);
        }
        return { ...prev, [activeEventName]: current };
      });
    },
    [activeEventName, activeEventDate, isMapTab],
  );


  const handleAddNewItemFromMap = useCallback(
    (eventDate: string, block: string, number: string) => {
      setNewItemDefaults({ eventDate, block, number });
      setItemToEdit(null);
      setActiveTab('import');
    },
    [],
  );


  const handleAddItemFromFocusMode = useCallback(
    (newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => {
      if (!activeEventName) return;

      const result = computeAddItemFromFocusMode(
        eventLists[activeEventName] || [],
        newItem,
        executeModeItems[activeEventName] || {},
      );

      setEventLists((prev) => ({ ...prev, [activeEventName]: result.items }));
      setExecuteModeItems((prev) => ({ ...prev, [activeEventName]: result.executeModeItems }));
    },
    [activeEventName, eventLists, executeModeItems],
  );


  const handleMoveToFirstFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      if (!activeEventDate) return;
      const dayName = activeEventDate;

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = (eventItems[dayName] || []).filter((id) => id !== itemId);

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

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = (eventItems[dayName] || []).filter((id) => id !== itemId);

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
  const [mapTabMenuPosition, setMapTabMenuPosition] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });

  // ヘッダーマップトグルボタンの長押しメニュー外クリックで閉じる
  React.useEffect(() => {
    if (mapTabMenuOpen !== 'mapToggle') return;
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
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mapTabMenuOpen]);

  const [visitListPanelOpen, setVisitListPanelOpen] = useState(false);
  const [visitListPanelMapTab, setVisitListPanelMapTab] = useState<string | null>(null);
  const [visitListHasUnsavedChanges, setVisitListHasUnsavedChanges] = useState(false);
  const [visitListOriginalOrder, setVisitListOriginalOrder] = useState<string[]>([]);
  const [highlightedMapCell, setHighlightedMapCell] = useState<{ row: number; col: number } | null>(
    null,
  );
  const [showVisitListConfirmDialog, setShowVisitListConfirmDialog] = useState(false);
  const [pendingTabChange, setPendingTabChange] = useState<string | null>(null);
  const [blockDefinitionMode, setBlockDefinitionMode] = useState(false);


  const [mapSelectedHallId, setMapSelectedHallId] = useState<string>('all');
  const [mapIsRouteVisible, setMapIsRouteVisible] = useState(true);
  const [mapIsHallOrderOpen, setMapIsHallOrderOpen] = useState(false);
  const [mapHallSelectorOpen, setMapHallSelectorOpen] = useState(false);
  const [mapSmartInsertEnabled, setMapSmartInsertEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertEnabled');
      return saved !== null ? saved === 'true' : true; // 保存値が存在しない場合は有効を既定値として扱う。
    } catch {
      return true;
    }
  });
  const [mapSmartInsertMode, setMapSmartInsertMode] = useState<'card' | 'preview'>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertMode');
      return saved === 'card' || saved === 'preview' ? saved : 'card';
    } catch {
      return 'card';
    }
  });
  const [smartInsertToast, setSmartInsertToast] = useState<string | null>(null);
  const [smartInsertToastType, setSmartInsertToastType] = useState<'success' | 'error'>('success');
  const smartInsertLongPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const smartInsertLongPressTriggeredRef = React.useRef(false);

  const showSmartInsertToast = useCallback(
    (message: string, type: 'success' | 'error' = 'success') => {
      setSmartInsertToastType(type);
      setSmartInsertToast(message);
    },
    [],
  );


  React.useEffect(() => {
    try {
      localStorage.setItem('mapSmartInsertEnabled', String(mapSmartInsertEnabled));
    } catch (error) {
      console.error('Failed to persist mapSmartInsertEnabled:', error);
      showSmartInsertToast('スマート挿入設定の保存に失敗しました。', 'error');
    }
  }, [mapSmartInsertEnabled, showSmartInsertToast]);

  React.useEffect(() => {
    try {
      localStorage.setItem('mapSmartInsertMode', mapSmartInsertMode);
    } catch (error) {
      console.error('Failed to persist mapSmartInsertMode:', error);
      showSmartInsertToast('スマート挿入モードの保存に失敗しました。', 'error');
    }
  }, [mapSmartInsertMode, showSmartInsertToast]);


  React.useEffect(() => {
    if (smartInsertToast) {
      const timer = setTimeout(() => setSmartInsertToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [smartInsertToast]);


  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
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
    if (!visitListPanelOpen || !isMapTab || !activeEventName || !currentMapTabName) return;
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


      setExecuteModeItems((prev) => ({
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
      setExecuteModeItems((prev) => ({
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

    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const routeSettings = hallRouteSettings[activeEventName]?.[visitListPanelMapTab];

    if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
      return routeSettings.hallOrder;
    }


    return halls.map((h) => h.id);
  }, [visitListPanelMapTab, activeEventName, hallDefinitions, hallRouteSettings]);


  const handleUpdateItemPriority = useCallback(
    (itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
      if (!activeEventName || !visitListPanelMapTab) return;

      const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
      const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];
      const currentSettings = hallRouteSettings[activeEventName]?.[visitListPanelMapTab] || {
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

      // 優先度変更後、同一スペースの兄弟と隣接するようにexecuteIds内の位置を調整
      const item = items.find((i) => i.id === itemId);
      if (item) {
        const dayName = item.eventDate;
        setExecuteModeItems((prev) => {
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
    [activeEventName, visitListPanelMapTab, items, hallDefinitions, mapData, hallRouteSettings],
  );

  // マップビュー等から直接呼び出される優先度変更（items + hallOrder の両方を更新）。
  // 編集ダイアログ経由ではない単独呼び出しなので race condition は発生しない。
  const handleUpdateItemPriorityFromEdit = useCallback(
    (itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
      if (!activeEventName) return;

      const currentItems = eventLists[activeEventName] || [];
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;

      const resolvedHallId = getItemHallId(item, item.eventDate);
      const mapTabForItem = getMapTabForDate(item.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] || []).map((h) => h.id)
          : [],
      );
      const targetKey: string =
        resolvedHallId && mapHallIds.has(resolvedHallId)
          ? (mapTabForItem as string)
          : getMaplessKey(item.eventDate);

      const targetHalls = hallDefinitions[activeEventName]?.[targetKey] || [];
      const targetMapData =
        targetKey.startsWith(MAPLESS_HALL_KEY)
          ? undefined
          : mapData[activeEventName]?.[targetKey];
      const targetSettings = hallRouteSettings[activeEventName]?.[targetKey] || {
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

      // 優先度変更後、同一スペースの兄弟と隣接するようにexecuteIds内の位置を調整
      const dayName = item.eventDate;
      setExecuteModeItems((prev) => {
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

  // 編集ダイアログからの優先度変更に伴う hallRouteSettings.hallOrder の更新のみを行う。
  // アイテム本体 (priorityLevel) の更新は handleUpdateItem 経由の onSave に統合済み。
  // 旧 handleUpdateItemPriorityFromEdit は items と hallRouteSettings の両方に setEventLists を発行しており、
  // 同期クロージャ由来の race condition で priority が巻き戻るバグの原因だったため、
  // items 側を触らない形に縮退させた。
  const handleUpdateHallOrderForPriorityChangeFromEdit = useCallback(
    (
      itemId: string,
      newPriorityLevel: 'none' | 'priority' | 'highest',
      oldPriorityLevel: 'none' | 'priority' | 'highest',
    ) => {
      if (!activeEventName) return;

      const currentItems = eventLists[activeEventName] || [];
      const item = currentItems.find((i) => i.id === itemId);
      if (!item) return;

      // 統合ホール判定でアイテムの所属ホールを解決（manualHallId → polygon → blockNames）
      const resolvedHallId = getItemHallId(item, item.eventDate);

      // 解決されたホールが map タブ側か mapless 側かを判定して保存先を決定
      const mapTabForItem = getMapTabForDate(item.eventDate);
      const mapHallIds = new Set(
        mapTabForItem
          ? (hallDefinitions[activeEventName]?.[mapTabForItem] || []).map((h) => h.id)
          : [],
      );
      const targetKey: string =
        resolvedHallId && mapHallIds.has(resolvedHallId)
          ? (mapTabForItem as string)
          : getMaplessKey(item.eventDate);

      const targetHalls = hallDefinitions[activeEventName]?.[targetKey] || [];
      const targetMapData =
        targetKey.startsWith(MAPLESS_HALL_KEY)
          ? undefined
          : mapData[activeEventName]?.[targetKey];
      const targetSettings = hallRouteSettings[activeEventName]?.[targetKey] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      // priority 変更後のアイテム状態を反映した allItems を渡す（hallOrder 計算のため）
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

      // 優先度変更後、同一スペースの兄弟と隣接するようにexecuteIds内の位置を調整
      const dayName = item.eventDate;
      setExecuteModeItems((prev) => {
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
      if (!activeEventName || !isMapTab || !currentMapData || !currentMapTabName) return;

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
      const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;

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

  // マップなしホール定義の更新ハンドラ
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

  // マップタブが存在する日付一覧
  const mapTabDates = useMemo(
    () => eventDates.filter((date) => !!getMapTabForDate(date)),
    [eventDates, getMapTabForDate],
  );

  // マップなしホール定義を他の日付に同期
  const handleSyncMaplessHallsToOtherDates = useCallback(
    (targetDates: string[]) => {
      if (!activeEventName || !activeEventDate) return;

      const sourceKey = getMaplessKey(activeEventDate);
      const sourceHalls = hallDefinitions[activeEventName]?.[sourceKey] || [];
      if (sourceHalls.length === 0) return;

      const clonedByDate = cloneHallsForDates(sourceHalls, targetDates);

      setHallDefinitions((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          updated[activeEventName][targetKey] = clonedByDate.get(date)!.halls;
        }
        return updated;
      });

      setHallRouteSettings((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const date of targetDates) {
          const targetKey = getMaplessKey(date);
          const { idMap } = clonedByDate.get(date)!;
          const sourceSettings = prev[activeEventName]?.[sourceKey] || emptyHallRouteSettings();
          updated[activeEventName][targetKey] = remapHallRouteSettings(sourceSettings, idMap);
        }
        return updated;
      });
    },
    [activeEventName, activeEventDate, hallDefinitions, hallRouteSettings],
  );

  // ポリゴンホール定義を他の日付に同期
  const handleSyncPolygonHallsToOtherDates = useCallback(
    (targetDates: string[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      const sourceHalls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      if (sourceHalls.length === 0) return;

      const targetMapTabsByDate = new Map<string, string>();
      for (const date of targetDates) {
        const targetMapTab = getMapTabForDate(date);
        if (!targetMapTab) continue;
        targetMapTabsByDate.set(date, targetMapTab);
      }
      const clonedByDate = cloneHallsForDates(sourceHalls, Array.from(targetMapTabsByDate.keys()));

      setHallDefinitions((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const [date, { halls }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date)!;
          updated[activeEventName][targetMapTab] = halls;
        }
        return updated;
      });

      setHallRouteSettings((prev) => {
        const updated = { ...prev, [activeEventName]: { ...prev[activeEventName] } };
        for (const [date, { idMap }] of clonedByDate) {
          const targetMapTab = targetMapTabsByDate.get(date)!;
          const sourceSettings =
            prev[activeEventName]?.[currentMapTabName] || emptyHallRouteSettings();
          updated[activeEventName][targetMapTab] = remapHallRouteSettings(sourceSettings, idMap);
        }
        return updated;
      });
    },
    [activeEventName, isMapTab, currentMapTabName, hallDefinitions, hallRouteSettings, getMapTabForDate],
  );

  // ===== ホール間移動順序パネル用: マップ/maplessの統合ビュー =====

  // 現在日付のマップタブ名（mapViewActive問わず、その日付にマップがあるか）
  const globalHallOrderMapTabName = useMemo(
    () => (activeEventDate ? getMapTabForDate(activeEventDate) : null),
    [activeEventDate, getMapTabForDate],
  );

  // 現在日付の実行列に優先度付きアイテムが 1 件でもあるか
  // (ホール定義 0 件でも「ホール間移動順序」アイコンを出すための条件)
  const hasUndefinedPriorityItems = useMemo((): boolean => {
    if (!activeEventName || !activeEventDate) return false;
    const ids = executeModeItems[activeEventName]?.[activeEventDate] || [];
    return ids.some((id) => {
      const it = items.find((i) => i.id === id);
      if (!it) return false;
      const p = it.priorityLevel || 'none';
      return p === 'priority' || p === 'highest';
    });
  }, [activeEventName, activeEventDate, executeModeItems, items]);

  // マップ/maplessの両方を統合したホール一覧
  const globalHallOrderHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName) return [];
    const hasMap = !!globalHallOrderMapTabName;
    const mapHalls = hasMap
      ? hallDefinitions[activeEventName]?.[globalHallOrderMapTabName] || []
      : [];
    const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;
    const maplessHalls = maplessKey ? hallDefinitions[activeEventName]?.[maplessKey] || [] : [];
    return [...mapHalls, ...maplessHalls];
  }, [activeEventName, activeEventDate, globalHallOrderMapTabName, hallDefinitions]);

  // マップ/mapless統合されたHallRouteSettings（hallOrderのマージ）
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
          ? (hallDefinitions[activeEventName]?.[globalHallOrderMapTabName] || []).map(
              (h) => h.id,
            )
          : [],
      );
      const maplessKey = activeEventDate ? getMaplessKey(activeEventDate) : null;
      const maplessHallIds = new Set<string>(
        (maplessKey ? hallDefinitions[activeEventName]?.[maplessKey] || [] : []).map((h) => h.id),
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
    [activeEventName, activeEventDate, globalHallOrderMapTabName, hallDefinitions],
  );

  // 統合ホール用アイテム数集計（groupId対応）
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

      // ホール定義 0 件でも未定義+優先度バケットで並べ替え可能にするため早期 return しない

      setExecuteModeItems((prev) => {
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
    [activeEventName, activeEventDate, getMapTabForDate, mapData, hallDefinitions, hallRouteSettings, items],
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
    (vertices: { row: number; col: number }[]): { row: number; col: number }[] => {
      if (vertices.length <= 2) return vertices;


      const centroidRow = vertices.reduce((sum, v) => sum + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((sum, v) => sum + v.col, 0) / vertices.length;


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
      const sorted = sortVerticesNonCrossing(vertexSelectionMode.clickedVertices);
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
    const handleMapCellClickForVertex = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!vertexSelectionMode) return;

      const { row, col } = e.detail;

      setVertexSelectionMode((prev) => {
        if (!prev) return prev;


        const existingIndex = prev.clickedVertices.findIndex((v) => v.row === row && v.col === col);
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter((_, i) => i !== existingIndex),
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

    window.addEventListener('mapCellClick', handleMapCellClickForVertex as EventListener);
    return () => {
      window.removeEventListener('mapCellClick', handleMapCellClickForVertex as EventListener);
    };
  }, [vertexSelectionMode]);


  const handleStartCellSelection = useCallback(
    (type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual', editingData?: unknown) => {
      setCellSelectionMode({ type, clickedCells: [], editingBlockData: editingData });
      setBlockDefinitionMode(false); // セル選択モード中はブロック定義パネルを閉じる。
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
    setBlockDefinitionMode(true); // セル選択を確定したらブロック定義パネルを再表示する。
  }, [cellSelectionMode]);


  const handleCancelCellSelection = useCallback(() => {
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: 'cancelled', // 編集キャンセルとして確認ダイアログへ引き渡す。
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // セル選択を終了したらブロック定義パネルを再表示する。
  }, [cellSelectionMode]);


  useEffect(() => {
    const handleMapCellClick = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!cellSelectionMode) return;

      const { row, col } = e.detail;

      setCellSelectionMode((prev) => {
        if (!prev) return prev;


        const existingIndex = prev.clickedCells.findIndex((c) => c.row === row && c.col === col);
        if (existingIndex >= 0) {
          return {
            ...prev,
            clickedCells: prev.clickedCells.filter((_, i) => i !== existingIndex),
          };
        }


        return {
          ...prev,
          clickedCells: [...prev.clickedCells, { row, col }],
        };
      });
    };

    window.addEventListener('mapCellClick', handleMapCellClick as EventListener);
    return () => window.removeEventListener('mapCellClick', handleMapCellClick as EventListener);
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
        setSelectedItemIds(new Set());
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
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
        }`}
      >
        {label}{' '}
        {typeof count !== 'undefined' && (
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
    const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
    const itemsMap = new Map(items.map((item) => [item.id, item]));
    return executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
  }, [activeEventName, activeTab, executeModeItems, items, eventDates]);

  // handleExecuteItemUpdate用にrefを同期
  useEffect(() => {
    executeColumnItemsRef.current = executeColumnItems;
  }, [executeColumnItems]);

  // recentlyChangedItemIdsのref同期（Postponeフィルタ内可視アイテム判定用）
  useEffect(() => {
    recentlyChangedItemIdsRef.current = recentlyChangedItemIds;
  }, [recentlyChangedItemIds]);

  // フィルタボタンのフラグリセット（モード変更・フィルタ変更時）
  useEffect(() => {
    setShowPostponeFilterButton(false);
    setShowLateFilterButton(false);
  }, [currentMode, sortState]);

  const visibleItems = useMemo(() => {
    const currentEventDate = activeEventDate;
    const itemsForTab = currentTabItems;

    if (!activeEventName) return itemsForTab;

    const mode = dayModes[activeEventName]?.[currentEventDate];

    if (mode === 'execute') {
      if (sortState === 'Manual') {
        return executeColumnItems;
      }
      const filterStatus = sortState as Exclude<SortState, 'Manual'>;
      return executeColumnItems.filter(
        (item) => item.purchaseStatus === filterStatus || recentlyChangedItemIds.has(item.id),
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
    recentlyChangedItemIds,
  ]);



  const searchMatches = useMemo(() => {
    if (!searchKeyword.trim() || !activeEventName || !eventDates.includes(activeTab)) {
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
    if (!activeEventName || !eventDates.includes(activeTab)) return new Set<string>();
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
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const candidateItems = currentTabItems.filter((item) => !executeIds.has(item.id));
    const blocks = new Set(candidateItems.map((item) => item.block).filter(Boolean));
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
    });
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, eventDates]);

  // ホール定義用: 当該日付の全アイテムからブロック名一覧を取得（実行列・候補列を問わず）
  const allBlocksForHallDefinition = useMemo(() => {
    if (!activeEventName) return [];
    const blocks = new Set(currentTabItems.map((item) => item.block).filter(Boolean));
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b, 'ja', { numeric: true, sensitivity: 'base' });
    });
  }, [activeEventName, currentTabItems]);

  // 現在のイベント・日付のマップなしホール一覧
  const currentMaplessHalls = useMemo(() => {
    if (!activeEventName || !activeEventDate) return [];
    return hallDefinitions[activeEventName]?.[getMaplessKey(activeEventDate)] || [];
  }, [activeEventName, activeEventDate, hallDefinitions]);

  const candidateColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    let filtered = currentTabItems.filter((item) => !executeIds.has(item.id));


    if (selectedBlockFilters.size > 0) {
      filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
    }

    return filtered;
  }, [
    activeEventName,
    activeTab,
    executeModeItems,
    currentTabItems,
    selectedBlockFilters,
    eventDates,
  ]);


  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];

    const currentEventDate = activeEventDate;
    const mode = activeEventName ? dayModes[activeEventName]?.[currentEventDate] : undefined;

    let visibleItemIds: Set<string>;

    if (mode === 'execute') {
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
        alert('現在の絞り込み条件では一致する項目がありません。');
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
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);


  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const candidateItems = currentTabItems.filter((item) => !executeIds.has(item.id));

    const blocksWithPriority = new Set<string>();
    candidateItems.forEach((item) => {
      if (item.remarks && (item.remarks.includes('優先') || item.remarks.includes('委託無'))) {
        blocksWithPriority.add(item.block);
      }
    });

    return blocksWithPriority;
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, eventDates]);


  const hasCandidateSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
    return selectedItems.some((item) => currentTabItems.includes(item) && !executeIds.has(item.id));
  }, [
    activeEventName,
    activeTab,
    currentMode,
    selectedItemIds,
    items,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);


  const hasExecuteSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = activeEventDate;
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
    return selectedItems.some((item) => currentTabItems.includes(item) && executeIds.has(item.id));
  }, [
    activeEventName,
    activeTab,
    currentMode,
    selectedItemIds,
    items,
    executeModeItems,
    currentTabItems,
    eventDates,
  ]);


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
        DEFAULT_PURCHASE_STATUS_CONTROL_MODE={DEFAULT_PURCHASE_STATUS_CONTROL_MODE}
        DEFAULT_UI_VISIBILITY={DEFAULT_UI_VISIBILITY}
        disablePriceUndefinedCheck={disablePriceUndefinedCheck}
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
        handleMapTabRotationAngleChange={handleMapTabRotationAngleChange}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        handleSearchNext={handleSearchNext}
        handleSetViewMode={handleSetViewMode}
        handleSortToggle={handleSortToggle}
        hasCandidateSelection={hasCandidateSelection}
        hasExecuteSelection={hasExecuteSelection}
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
        setNumberCellOutlineStyle={setNumberCellOutlineStyle}
        setPurchaseStatusControlMode={setPurchaseStatusControlMode}
        setSearchKeyword={setSearchKeyword}
        setSelectedBlockFilters={setSelectedBlockFilters}
        setSelectedItemIds={setSelectedItemIds}
        setSimpleHallDefinitionMode={setSimpleHallDefinitionMode}
        setThemeMode={setThemeMode}
        setUiSettingsPanelOpen={setUiSettingsPanelOpen}
        setUiVisibilityOverride={setUiVisibilityOverride}
        setUiVisibilitySettings={setUiVisibilitySettings}
        showHeaderBar={showHeaderBar}
        showMoveButtons={showMoveButtons}
        showSmartInsertToast={showSmartInsertToast}
        showTabBar={showTabBar}
        smartInsertLongPressRef={smartInsertLongPressRef}
        smartInsertLongPressTriggeredRef={smartInsertLongPressTriggeredRef}
        sortLabels={sortLabels}
        sortState={sortState}
        TabButton={TabButton}
        themeMode={themeMode}
        uiSettingsPanelOpen={uiSettingsPanelOpen}
        uiVisibilitySettings={uiVisibilitySettings}
        updateUIVisibilityConfig={updateUIVisibilityConfig}
        visibleSearchMatches={visibleSearchMatches}
      />


      {rawHideSomething &&
        activeEventName &&
        (currentMode === 'focus' || currentMode === 'execute') && (
          <button
            onClick={() => {
              setUiVisibilityOverride((prev) => !prev);
              setUiSettingsPanelOpen(false);
            }}
            className={`fixed left-3 top-3 z-20 w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-all touch-manipulation select-none ${
              uiVisibilityOverride
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600 backdrop-blur-sm border border-slate-200 dark:border-slate-600'
            }`}
            title={uiVisibilityOverride ? '自動表示に戻す' : '画面要素をすべて表示'}
            style={{ WebkitTapHighlightColor: 'transparent' }}
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
        handleAddToExecuteListFromMapAtPosition={handleAddToExecuteListFromMapAtPosition}
        handleBatchAddToExecuteListFromMap={handleBatchAddToExecuteListFromMap}
        handleBatchAddToExecuteListFromMapAtPosition={handleBatchAddToExecuteListFromMapAtPosition}
        handleBatchRemoveFromExecuteListFromMap={handleBatchRemoveFromExecuteListFromMap}
        handleBulkAdd={handleBulkAdd}
        handleBulkStatusChange={handleBulkStatusChange}
        handleCandidateNumberSort={handleCandidateNumberSort}
        handleClearBlockFilters={handleClearBlockFilters}
        handleClearNewItemDefaults={handleClearNewItemDefaults}
        handleCollapseAndOpenNext={handleCollapseAndOpenNext}
        handleDeleteEvent={handleDeleteEvent}
        handleDeleteItemFromMap={handleDeleteItemFromMap}
        handleDeleteRequest={handleDeleteRequest}
        handleDoneEditing={handleDoneEditing}
        handleEditRequest={handleEditRequest}
        handleExecuteItemUpdate={handleExecuteItemUpdate}
        handleExecuteSpaceGroupOrderChange={handleExecuteSpaceGroupOrderChange}
        handleExecuteToggleAllSpaceCollapse={handleExecuteToggleAllSpaceCollapse}
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
        handleReorderExecuteListByHallOrder={handleReorderExecuteListByHallOrder}
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
        handleUpdateHallOrderForPriorityChangeFromEdit={handleUpdateHallOrderForPriorityChangeFromEdit}
        setEditDialogItem={setEditDialogItem}
        itemToDelete={itemToDelete}
        handleConfirmDelete={handleConfirmDelete}
        setItemToDelete={setItemToDelete}
        showUpdateConfirmation={showUpdateConfirmation}
        updateData={updateData}
        handleConfirmUpdate={handleConfirmUpdate}
        setShowUpdateConfirmation={setShowUpdateConfirmation}
        setUpdateData={setUpdateData}
        setUpdateEventName={setUpdateEventName}
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
        handleUpdateGlobalHallRouteSettings={handleUpdateGlobalHallRouteSettings}
        getGlobalHallItemCount={getGlobalHallItemCount}
        handleReorderExecuteListByHallOrder={handleReorderExecuteListByHallOrder}
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
        sortState={sortState}
        handleSortToggle={handleSortToggle}
        zoomLevel={zoomLevel}
        handleZoomChange={handleZoomChange}
        selectedItemIds={selectedItemIds}
        handleBulkSort={handleBulkSort}
        handleClearSelection={handleClearSelection}
        showMoveButtons={showMoveButtons}
        hasCandidateSelection={hasCandidateSelection}
        handleMoveToExecuteColumn={handleMoveToExecuteColumn}
        hasExecuteSelection={hasExecuteSelection}
        handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
        smartInsertToast={smartInsertToast}
        smartInsertToastType={smartInsertToastType}
      />
    </div>
  );
};

export default App;








