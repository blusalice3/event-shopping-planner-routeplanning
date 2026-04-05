import React, { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import {
  ShoppingItem,
  PurchaseStatus,
  EventMetadata,
  ViewMode,
  DayModeState,
  ExecuteModeItems,
  MapDataStore,
  RouteSettingsStore,
  ExportOptions,
  BlockDefinition,
  HallDefinition,
  HallRouteSettings,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  DayMapData,
  BlockDetectionSettings,
  FocusModeSessionState,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  MapViewportState,
} from './types';
const ImportScreen = React.lazy(() => import('./components/ImportScreen'));
import ShoppingList from './components/ShoppingList';
import SummaryBar from './components/SummaryBar';
import EventListScreen from './components/EventListScreen';
import DeleteConfirmationModal from './components/DeleteConfirmationModal';
import ZoomControl from './components/ZoomControl';
import BulkActionControls from './components/BulkActionControls';
import UpdateConfirmationModal from './components/UpdateConfirmationModal';
import UrlUpdateDialog from './components/UrlUpdateDialog';
import EventRenameDialog from './components/EventRenameDialog';
import ExportOptionsDialog from './components/ExportOptionsDialog';
import SortAscendingIcon from './components/icons/SortAscendingIcon';
import SortDescendingIcon from './components/icons/SortDescendingIcon';
import SearchBar from './components/SearchBar';
import {
  MapView,
  BlockDefinitionPanel,
  HallDefinitionPanel,
  isPointInPolygon,
  MapImportDialog,
  loadBlockDetectionSettings,
  saveBlockDetectionSettings,
} from './components/map';
import VisitListPanel from './components/VisitListPanel';
const FocusModeContainer = React.lazy(() => import('./features/map/components/FocusModeContainer'));
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
} from './features/events/itemOps';
import {
  buildImportCompletionMessage,
  resolveEventListTab,
} from './features/events/uiOrchestration';
import { useMapSelectors } from './features/map/hooks/useMapSelectors';
import { useThemeMode } from './hooks/useThemeMode';
import {
  DEFAULT_UI_VISIBILITY,
  useUIVisibilitySettings,
  type UIVisibilitySettings,
} from './hooks/useUIVisibilitySettings';
import { useNumberCellOutlineStyle } from './hooks/useNumberCellOutlineStyle';
import { useIndexedDbPersistence } from './hooks/useIndexedDbPersistence';
import MapRotationControls from './components/map/MapRotationControls';

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
  return (
    a.phase === b.phase &&
    a.phaseIndex === b.phaseIndex &&
    a.isCompleted === b.isCompleted &&
    a.savedPhaseIndices.normal === b.savedPhaseIndices.normal &&
    a.savedPhaseIndices.postponed === b.savedPhaseIndices.postponed &&
    a.savedPhaseIndices.late === b.savedPhaseIndices.late &&
    areStringArraysEqual(a.postponedItemIds, b.postponedItemIds) &&
    areStringArraysEqual(a.lateItemIds, b.lateItemIds)
  );
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
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectedBlockFilters, setSelectedBlockFilters] = useState<Set<string>>(new Set());
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<Set<string>>(new Set());
  const [rangeStart, setRangeStart] = useState<{
    itemId: string;
    columnType: 'execute' | 'candidate';
    sourceType?: 'item' | 'spaceHeader';
  } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{
    itemId: string;
    columnType: 'execute' | 'candidate';
    sourceType?: 'item' | 'spaceHeader';
  } | null>(null);

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
      const mapDataForDate = getMapDataForDate(eventDate);
      if (!halls.length || !mapDataForDate) return null;


      const block = mapDataForDate.blocks.find((b) => b.name === item.block);
      if (!block) return null;

      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;


      for (const hall of halls) {
        if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
          return hall.id;
        }
      }
      return null;
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

      const currentItems = eventLists[activeEventName] || [];
      const currentItem = currentItems.find((item) => item.id === updatedItem.id);
      const currentEventDate = activeEventDate;
      const currentMode = dayModes[activeEventName]?.[currentEventDate];

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

      setEventLists((prev) => ({
        ...prev,
        [activeEventName]: result.items,
      }));
    },
    [activeEventName, activeTab, eventDates, dayModes, eventLists],
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
        if (currentEventDate) {
          const sessionKey = buildFocusSessionKey(activeEventName, currentEventDate);
          setFocusModeSessions((prev) => {
            if (!prev[sessionKey]) return prev;
            const next = { ...prev };
            delete next[sessionKey];
            return next;
          });
        }
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
    [activeEventName, activeTab, eventDates],
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
    setItemToEdit(item);
    setActiveTab('import');
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


      let currentItems: ShoppingItem[] = [];
      if (activeEventName) {
        if (currentColumnType === 'execute') {
          const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
          const itemsMap = new Map(items.map((item) => [item.id, item]));
          currentItems = executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
        } else {
          const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
          let filtered = items.filter(
            (item) => item.eventDate === currentEventDate && !executeIds.has(item.id),
          );
          if (selectedBlockFilters.size > 0) {
            filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
          }
          currentItems = filtered;
        }
      }

      setSelectedItemIds((prev) => {
        const newSet = new Set(prev);
        const wasSelected = newSet.has(itemId);

        if (wasSelected) {
          newSet.delete(itemId);
          if (rangeStart?.itemId === itemId && rangeStart.columnType === currentColumnType) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (rangeEnd?.itemId === itemId && rangeEnd.columnType === currentColumnType) {
            setRangeEnd(null);
          }
        } else {
          newSet.add(itemId);


          if (!rangeStart || rangeStart.columnType !== currentColumnType || rangeStart.sourceType === 'spaceHeader') {
            setRangeStart({ itemId, columnType: currentColumnType, sourceType: 'item' });
            setRangeEnd(null);
          } else {
            const startIndex = currentItems.findIndex((item) => item.id === rangeStart.itemId);
            const currentIndex = currentItems.findIndex((item) => item.id === itemId);


            if (startIndex !== -1 && currentIndex !== -1) {
              const isAdjacent = Math.abs(startIndex - currentIndex) === 1;
              if (!isAdjacent) {
                setRangeEnd({ itemId, columnType: currentColumnType, sourceType: 'item' });
              } else {
                setRangeEnd(null);
              }
            }
          }
        }

        return newSet;
      });
    },
    [
      activeTab,
      activeEventName,
      executeModeItems,
      eventDates,
      rangeStart,
      rangeEnd,
      items,
      selectedBlockFilters,
    ],
  );

  // 折りたたみスペースグループのチェックボックス用：範囲選択対応
  const handleSelectSpaceGroupForRange = useCallback(
    (firstItemId: string, allItemIds: string[], columnType: 'execute' | 'candidate') => {
      setSortState('Manual');
      setBlockSortDirection(null);

      // 隣接グループ判定用：現在のカラムのアイテムからスペースグループ順を算出
      const currentEventDate = activeEventDate;
      let currentItems: ShoppingItem[] = [];
      if (activeEventName) {
        if (columnType === 'execute') {
          const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
          const itemsMap = new Map(items.map((item) => [item.id, item]));
          currentItems = executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
        } else {
          const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
          let filtered = items.filter(
            (item) => item.eventDate === currentEventDate && !executeIds.has(item.id),
          );
          if (selectedBlockFilters.size > 0) {
            filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
          }
          currentItems = filtered;
        }
      }

      // スペースグループ順序を構築
      const groupOrder: string[] = [];
      const groupFirstItemMap = new Map<string, string>();
      for (const item of currentItems) {
        const key = getSpaceKey(item.block, item.number);
        if (!groupFirstItemMap.has(key)) {
          groupOrder.push(key);
          groupFirstItemMap.set(key, item.id);
        }
      }

      setSelectedItemIds((prev) => {
        const newSet = new Set(prev);
        const allSelected = allItemIds.every((id) => newSet.has(id));

        if (allSelected) {
          // 全解除
          allItemIds.forEach((id) => newSet.delete(id));
          if (rangeStart && allItemIds.includes(rangeStart.itemId)) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (rangeEnd && allItemIds.includes(rangeEnd.itemId)) {
            setRangeEnd(null);
          }
        } else {
          // 全選択
          allItemIds.forEach((id) => newSet.add(id));
          // rangeStart/rangeEndは先頭アイテムIDで設定
          // rangeStartがアイテムカード由来の場合はスペースヘッダーとの混在を防ぐ
          if (!rangeStart || rangeStart.columnType !== columnType || rangeStart.sourceType === 'item') {
            setRangeStart({ itemId: firstItemId, columnType, sourceType: 'spaceHeader' });
            setRangeEnd(null);
          } else {
            // 隣接グループチェック：隣接なら rangeEnd を設定しない
            const startKey = (() => {
              const startItem = currentItems.find((item) => item.id === rangeStart.itemId);
              return startItem ? getSpaceKey(startItem.block, startItem.number) : null;
            })();
            const currentKey = (() => {
              const currentItem = currentItems.find((item) => item.id === firstItemId);
              return currentItem ? getSpaceKey(currentItem.block, currentItem.number) : null;
            })();

            if (startKey && currentKey) {
              const startGroupIdx = groupOrder.indexOf(startKey);
              const currentGroupIdx = groupOrder.indexOf(currentKey);
              const isAdjacent = startGroupIdx !== -1 && currentGroupIdx !== -1 &&
                Math.abs(startGroupIdx - currentGroupIdx) === 1;
              if (!isAdjacent) {
                setRangeEnd({ itemId: firstItemId, columnType, sourceType: 'spaceHeader' });
              } else {
                setRangeEnd(null);
              }
            } else {
              setRangeEnd({ itemId: firstItemId, columnType, sourceType: 'spaceHeader' });
            }
          }
        }
        return newSet;
      });
    },
    [rangeStart, rangeEnd, activeEventDate, activeEventName, executeModeItems, items, selectedBlockFilters],
  );

  const handleToggleBlockFilter = useCallback((block: string) => {
    setSelectedBlockFilters((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(block)) {
        newSet.delete(block);
      } else {
        newSet.add(block);
      }
      return newSet;
    });
  }, []);

  const handleClearBlockFilters = useCallback(() => {
    setSelectedBlockFilters(new Set());
  }, []);

  // スペース別グループ化の状態。
  const [spaceGroupingEnabled, setSpaceGroupingEnabled] = useState(false);
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(new Set());
  const spaceGroupDragItemIdsRef = useRef<string[] | null>(null);

  // 実行モード用スペース別グループ化の状態（編集モードとは独立）
  const [executeSpaceGroupingEnabled, setExecuteSpaceGroupingEnabled] = useState(true);
  const [executeCollapsedSpaces, setExecuteCollapsedSpaces] = useState<Set<string>>(new Set());
  const [showPostponeFilterButton, setShowPostponeFilterButton] = useState(false);
  const executeSpaceGroupOrderRef = useRef<string[]>([]); // ShoppingListから通知される表示順序
  const executeColumnItemsRef = useRef<ShoppingItem[]>([]); // handleExecuteItemUpdate用

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

  const handleClearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
    setRangeStart(null);
    setRangeEnd(null);
  }, []);

  const handleToggleSpaceCollapse = useCallback((spaceKey: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceKey)) {
        next.delete(spaceKey);
      } else {
        next.add(spaceKey);
      }
      return next;
    });
  }, []);

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
    setExecuteCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceKey)) {
        next.delete(spaceKey);
      } else {
        next.add(spaceKey);
      }
      return next;
    });
  }, []);

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
    },
    [activeEventName, sortState],
  );

  // 実行モード用アイテム更新ラッパー
  const handleExecuteItemUpdate = useCallback(
    (updatedItem: ShoppingItem) => {
      handleUpdateItem(updatedItem);

      // 最下段アイテムのステータス変更で全アイテム非未購入→後回しフ���ルタボタン表示
      if (sortState !== 'Manual') return;
      if (updatedItem.purchaseStatus === 'None') return;

      const groupOrder = executeSpaceGroupOrderRef.current;
      if (groupOrder.length === 0) return;
      const lastGroupKey = groupOrder[groupOrder.length - 1];

      // このアイテムのgroupKeyを計算
      const spaceKey = getSpaceKey(updatedItem.block, updatedItem.number);
      const priority = updatedItem.priorityLevel || 'none';
      const itemGroupKey = priority !== 'none' ? `${spaceKey}:${priority}` : spaceKey;
      if (itemGroupKey !== lastGroupKey) return;

      // 最後のグループ内の最後のアイテムか判定
      const currentItems = executeColumnItemsRef.current;
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
    },
    [handleUpdateItem, sortState],
  );

  // 後回しフィルタボタンのクリックで後回しフィルタを有効化
  const handleActivatePostponeFilter = useCallback(() => {
    setRecentlyChangedItemIds(new Set());
    setSortState('Postpone');
    setShowPostponeFilterButton(false);
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
      if (
        !rangeStart ||
        rangeStart.columnType !== columnType ||
        !rangeEnd ||
        rangeEnd.columnType !== columnType
      ) {
        return;
      }

      if (!activeEventName) return;

      const currentEventDate = activeEventDate;


      let currentItems: ShoppingItem[] = [];
      if (columnType === 'execute') {
        const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
        const itemsMap = new Map(items.map((item) => [item.id, item]));
        currentItems = executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
      } else {
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        let filtered = items.filter(
          (item) => item.eventDate === currentEventDate && !executeIds.has(item.id),
        );
        if (selectedBlockFilters.size > 0) {
          filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
        }
        currentItems = filtered;
      }


      // スペースグループ化有効時の範囲選択
      if (spaceGroupingEnabled) {
        const startItem = currentItems.find((item) => item.id === rangeStart.itemId);
        const endItem = currentItems.find((item) => item.id === rangeEnd.itemId);
        if (!startItem || !endItem) return;

        const startKey = getSpaceKey(startItem.block, startItem.number);
        const endKey = getSpaceKey(endItem.block, endItem.number);

        let rangeItems: ShoppingItem[];

        if (startKey === endKey) {
          // 同一スペース内の範囲選択
          const groupItems = currentItems.filter(
            (item) => getSpaceKey(item.block, item.number) === startKey,
          );
          const startIndex = groupItems.findIndex((item) => item.id === rangeStart.itemId);
          const endIndex = groupItems.findIndex((item) => item.id === rangeEnd.itemId);
          if (startIndex === -1 || endIndex === -1) return;
          const minIndex = Math.min(startIndex, endIndex);
          const maxIndex = Math.max(startIndex, endIndex);
          rangeItems = groupItems.slice(minIndex, maxIndex + 1);
        } else {
          // クロスグループ範囲選択：開始・終了スペース間の全スペースの全アイテムを対象にする
          // スペースグループの出現順を構築
          const groupOrder: string[] = [];
          for (const item of currentItems) {
            const key = getSpaceKey(item.block, item.number);
            if (!groupOrder.includes(key)) {
              groupOrder.push(key);
            }
          }
          const startGrpIdx = groupOrder.indexOf(startKey);
          const endGrpIdx = groupOrder.indexOf(endKey);
          if (startGrpIdx === -1 || endGrpIdx === -1) return;
          const minGrpIdx = Math.min(startGrpIdx, endGrpIdx);
          const maxGrpIdx = Math.max(startGrpIdx, endGrpIdx);
          const rangeSpaceKeys = new Set(groupOrder.slice(minGrpIdx, maxGrpIdx + 1));
          rangeItems = currentItems.filter((item) =>
            rangeSpaceKeys.has(getSpaceKey(item.block, item.number)),
          );
        }

        setSelectedItemIds((prev) => {
          const allSelected = rangeItems.every((item) => prev.has(item.id));
          const newSet = new Set(prev);
          if (allSelected) {
            rangeItems.forEach((item) => newSet.delete(item.id));
            setRangeStart(null);
            setRangeEnd(null);
          } else {
            rangeItems.forEach((item) => newSet.add(item.id));
          }
          return newSet;
        });
        return;
      }

      const halls = getHallsForDate(currentEventDate);
      const currentMapData = getMapDataForDate(currentEventDate);


      if (halls.length > 0 && currentMapData) {
        const getHallIdForItem = (item: ShoppingItem): string | null => {
          const block = currentMapData.blocks.find((b) => b.name === item.block);
          if (!block) return null;

          const numMatch = item.number?.match(/\d+/);
          if (!numMatch) return null;
          const num = parseInt(numMatch[0], 10);

          const cell = block.numberCells.find(
            (nc: { row: number; col: number; value: number }) => nc.value === num,
          );
          if (!cell) return null;


          const isPointInPoly = (
            row: number,
            col: number,
            vertices: { row: number; col: number }[],
          ): boolean => {
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
          };

          for (const hall of halls) {
            for (const vertex of hall.vertices) {
              if (vertex.row === cell.row && vertex.col === cell.col) {
                return hall.id;
              }
            }
            if (isPointInPoly(cell.row, cell.col, hall.vertices)) {
              return hall.id;
            }
          }
          return null;
        };


        const buildGroupId = (
          hallId: string | null,
          priority: 'none' | 'priority' | 'highest',
        ): string | null => {
          if (hallId === null) {
            if (priority === 'highest') return 'undefined:highest';
            if (priority === 'priority') return 'undefined:priority';
            return null;
          }
          if (priority === 'highest') return `${hallId}:highest`;
          if (priority === 'priority') return `${hallId}:priority`;
          return hallId;
        };

        const getItemGroupId = (item: ShoppingItem): string | null => {
          const hallId = getHallIdForItem(item);
          const priority = item.priorityLevel || 'none';
          return buildGroupId(hallId, priority);
        };


        const startItem = currentItems.find((item) => item.id === rangeStart.itemId);
        const endItem = currentItems.find((item) => item.id === rangeEnd.itemId);

        if (!startItem || !endItem) return;

        const startGroupId = getItemGroupId(startItem);
        const endGroupId = getItemGroupId(endItem);


        if (startGroupId !== endGroupId) {
          return;
        }


        const groupItems = currentItems.filter((item) => getItemGroupId(item) === startGroupId);

        const startIndex = groupItems.findIndex((item) => item.id === rangeStart.itemId);
        const endIndex = groupItems.findIndex((item) => item.id === rangeEnd.itemId);

        if (startIndex === -1 || endIndex === -1) return;

        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);
        const rangeItems = groupItems.slice(minIndex, maxIndex + 1);


        setSelectedItemIds((prev) => {
          const allSelected = rangeItems.every((item) => prev.has(item.id));
          const newSet = new Set(prev);
          if (allSelected) {
            rangeItems.forEach((item) => newSet.delete(item.id));
            setRangeStart(null);
            setRangeEnd(null);
          } else {
            rangeItems.forEach((item) => newSet.add(item.id));
          }
          return newSet;
        });
        return;
      }


      const startIndex = currentItems.findIndex((item) => item.id === rangeStart.itemId);
      const endIndex = currentItems.findIndex((item) => item.id === rangeEnd.itemId);

      if (startIndex === -1 || endIndex === -1) return;

      const minIndex = Math.min(startIndex, endIndex);
      const maxIndex = Math.max(startIndex, endIndex);
      const rangeItems = currentItems.slice(minIndex, maxIndex + 1);


      setSelectedItemIds((prev) => {
        const allSelected = rangeItems.every((item) => prev.has(item.id));
        const newSet = new Set(prev);
        if (allSelected) {
          rangeItems.forEach((item) => newSet.delete(item.id));
          setRangeStart(null);
          setRangeEnd(null);
        } else {
          rangeItems.forEach((item) => newSet.add(item.id));
        }
        return newSet;
      });
    },
    [
      rangeStart,
      rangeEnd,
      activeTab,
      activeEventName,
      eventDates,
      executeModeItems,
      items,
      selectedBlockFilters,
      spaceGroupingEnabled,
      getHallsForDate,
      getMapDataForDate,
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
    },
    [activeEventName, visitListPanelMapTab, items, hallDefinitions, mapData, hallRouteSettings],
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

      setHallDefinitions((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [currentMapTabName]: halls,
        },
      }));


      const existingOrder = currentHallRouteSettings.hallOrder;
      const newHallIds = halls.map((h) => h.id);
      const updatedOrder = [
        ...existingOrder.filter((id) => newHallIds.includes(id)),
        ...newHallIds.filter((id) => !existingOrder.includes(id)),
      ];

      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [currentMapTabName]: {
            ...currentHallRouteSettings,
            hallOrder: updatedOrder,
          },
        },
      }));
    },
    [activeEventName, isMapTab, currentMapTabName, currentHallRouteSettings],
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


  const handleReorderExecuteListByHallOrder = useCallback(
    (hallOrder: string[]) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;

      if (!activeEventDate) return;
      const dayName = activeEventDate;

      const currentMapData = mapData[activeEventName]?.[currentMapTabName];
      const halls = hallDefinitions[activeEventName]?.[currentMapTabName] || [];
      const currentHallRouteSettings = hallRouteSettings[activeEventName]?.[currentMapTabName] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      if (!currentMapData || halls.length === 0) return;

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];

        if (dayItems.length === 0) return prev;


        const itemsMap = new Map(items.map((i) => [i.id, i]));
        const getHallIdForItem = (itemId: string): string | null => {
          const item = itemsMap.get(itemId);
          if (!item || !currentMapData) return null;

          const blockName = item.block?.trim() || '';
          let block = currentMapData.blocks.find((b) => b.name === blockName);
          if (!block) {
            const candidates = currentMapData.blocks.filter(
              (b) => b.name.toLowerCase() === blockName.toLowerCase(),
            );
            if (candidates.length === 1) {
              block = candidates[0];
            }
          }
          if (!block) return null;

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
          return null;
        };


        const itemsByHall = new Map<string | null, Set<string>>();
        dayItems.forEach((itemId) => {
          const hallId = getHallIdForItem(itemId);
          if (!itemsByHall.has(hallId)) {
            itemsByHall.set(hallId, new Set());
          }
          itemsByHall.get(hallId)!.add(itemId);
        });


        const visitOrderMap = new Map<string, number>();
        currentHallRouteSettings.hallVisitLists.forEach((list) => {
          list.itemIds.forEach((itemId, index) => {
            visitOrderMap.set(itemId, index);
          });
        });


        const sortItemsInHall = (itemIds: Set<string>): string[] => {
          const itemsArray = Array.from(itemIds);
          return itemsArray.sort((a, b) => {
            const orderA = visitOrderMap.get(a);
            const orderB = visitOrderMap.get(b);


            if (orderA !== undefined && orderB !== undefined) {
              return orderA - orderB;
            }
            if (orderA !== undefined) return -1;
            if (orderB !== undefined) return 1;
            return dayItems.indexOf(a) - dayItems.indexOf(b);
          });
        };


        const reorderedItems: string[] = [];

        hallOrder.forEach((hallId) => {
          const hallItems = itemsByHall.get(hallId);
          if (hallItems && hallItems.size > 0) {
            reorderedItems.push(...sortItemsInHall(hallItems));
            itemsByHall.delete(hallId);
          }
        });

        itemsByHall.forEach((hallItems) => {
          if (hallItems.size > 0) {
            reorderedItems.push(...sortItemsInHall(hallItems));
          }
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
    [activeEventName, isMapTab, currentMapTabName, activeEventDate, mapData, hallDefinitions, hallRouteSettings, items],
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

  // 後回しフィルタボタンのフラグリセット（モード変更・フィルタ変更時）
  useEffect(() => {
    setShowPostponeFilterButton(false);
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
    setZoomLevel(Math.max(30, Math.min(150, newZoom)));
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200 font-sans">
      {(showHeaderBar || showTabBar) && (
        <header className="bg-white dark:bg-slate-800 shadow-sm sticky top-0 z-10">
          {showHeaderBar && (
            <div className="max-w-7xl mx-auto py-2 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg font-bold text-slate-900 dark:text-white truncate max-w-[200px]">
                    {activeEventName || '即売会購入巡回表'}
                  </h1>
                  {activeEventName &&
                    mainContentVisible &&
                    items.length > 0 &&
                    currentMode === 'execute' && (
                      <button
                        onClick={handleBlockSortToggle}
                        className={`p-2 rounded-md transition-colors duration-200 ${
                          blockSortDirection
                            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                            : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                        }`}
                        title={
                          blockSortDirection === 'desc'
                            ? 'ブロックを降順で並べ替え'
                            : blockSortDirection === 'asc'
                              ? 'ブロックを昇順で並べ替え'
                              : 'ブロック番号で並べ替え'
                        }
                      >
                        {blockSortDirection === 'desc' ? (
                          <SortDescendingIcon className="w-5 h-5" />
                        ) : (
                          <SortAscendingIcon className="w-5 h-5" />
                        )}
                      </button>
                    )}
                  {activeEventName &&
                    mainContentVisible &&
                    items.length > 0 &&
                    currentMode === 'edit' && (
                      <button
                        onClick={handleBlockSortToggleCandidate}
                        className={`p-2 rounded-md transition-colors duration-200 ${
                          blockSortDirection
                            ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                            : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                        }`}
                        title={
                          blockSortDirection === 'desc'
                            ? '候補ブロックを降順で並べ替え'
                            : blockSortDirection === 'asc'
                              ? '候補ブロックを昇順で並べ替え'
                              : '候補ブロックを番号で並べ替え'
                        }
                      >
                        {blockSortDirection === 'desc' ? (
                          <SortDescendingIcon className="w-5 h-5" />
                        ) : (
                          <SortAscendingIcon className="w-5 h-5" />
                        )}
                      </button>
                    )}
                  {activeEventName &&
                    mainContentVisible &&
                    getMapTabForDate(activeEventDate || '') && (
                        <div className="relative">
                          <button
                            ref={mapToggleButtonRef}
                            onClick={() => {
                              if (mapToggleLongPressFiredRef.current) {
                                mapToggleLongPressFiredRef.current = false;
                                return;
                              }
                              setMapViewActive((prev) => !prev);
                            }}
                            onPointerDown={(e) => {
                              if (!mapViewActive) return;
                              const target = e.currentTarget as HTMLButtonElement;
                              const rect = target.getBoundingClientRect();
                              const menuLeft = rect.left + rect.width / 2;
                              const menuTop = rect.bottom + 4;
                              mapToggleLongPressRef.current = window.setTimeout(() => {
                                mapToggleLongPressFiredRef.current = true;
                                setMapTabMenuPosition({ left: menuLeft, top: menuTop });
                                setMapTabMenuOpen('mapToggle');
                                mapToggleLongPressRef.current = null;
                              }, 500);
                            }}
                            onPointerUp={() => {
                              if (mapToggleLongPressRef.current) {
                                clearTimeout(mapToggleLongPressRef.current);
                                mapToggleLongPressRef.current = null;
                              }
                            }}
                            onPointerCancel={() => {
                              if (mapToggleLongPressRef.current) {
                                clearTimeout(mapToggleLongPressRef.current);
                                mapToggleLongPressRef.current = null;
                              }
                            }}
                            className={`p-2 rounded-md transition-colors duration-200 ${
                              mapViewActive
                                ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                                : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                            }`}
                            title={mapViewActive ? 'リスト表示に切り替え' : 'マップ表示に切り替え'}
                          >
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
                            </svg>
                          </button>
                          {mapTabMenuOpen === 'mapToggle' && (
                            <div
                              ref={mapToggleMenuRef}
                              className="fixed bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 z-50 min-w-[160px]"
                              style={{
                                left: `${mapTabMenuPosition.left}px`,
                                top: `${mapTabMenuPosition.top}px`,
                                transform: 'translateX(-50%)',
                              }}
                            >
                              <div className="py-1">
                                <button
                                  onClick={() => {
                                    setMapTabMenuOpen(null);
                                    if (currentMapTabName) openVisitListPanel(currentMapTabName);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                                >
                                  <span>📍</span> 訪問リスト
                                </button>
                                <button
                                  onClick={() => {
                                    setMapTabMenuOpen(null);
                                    setBlockDefinitionMode(true);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                                >
                                  <span>🔲</span> ブロック定義
                                </button>
                                <button
                                  onClick={() => {
                                    setMapTabMenuOpen(null);
                                    setHallDefinitionMode(true);
                                  }}
                                  className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                                >
                                  <span>🏛️</span> ホール定義
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                    )}
                  {/* 表示処理の補足 */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setUiSettingsPanelOpen(!uiSettingsPanelOpen);
                      }}
                      className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                        uiSettingsPanelOpen
                          ? 'bg-slate-200 dark:bg-slate-700'
                          : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                      }`}
                      title="表示項目の設定"
                      style={{
                        WebkitTapHighlightColor: 'transparent',
                        minWidth: '44px',
                        minHeight: '44px',
                      }}
                      type="button"
                    >
                      <svg
                        className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                    </button>

                    {/* 表示処理の補足 */}
                    {uiSettingsPanelOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setUiSettingsPanelOpen(false)}
                        />
                        <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-4 min-w-[320px] max-h-[70vh] overflow-y-auto">
                          {/* テーマ切替 */}
                          <div className="mb-3 flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">テーマ</span>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setThemeMode((prev) => {
                                  const next =
                                    prev === 'system' ? 'light' : prev === 'light' ? 'dark' : 'system';
                                  return next;
                                });
                              }}
                              className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
                              title={
                                themeMode === 'system'
                                  ? 'システム設定 → ライトモードへ'
                                  : themeMode === 'light'
                                    ? 'ライトモード → ダークモードへ'
                                    : 'ダークモード → システム設定へ'
                              }
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                              type="button"
                            >
                              {themeMode === 'system' ? (
                                <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                </svg>
                              ) : themeMode === 'light' ? (
                                <svg className="w-5 h-5 text-amber-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                                </svg>
                              ) : (
                                <svg className="w-5 h-5 text-indigo-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                                </svg>
                              )}
                            </button>
                          </div>

                          {/* レイアウト切替 */}
                          <div className="mb-3 pb-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">レイアウト</span>
                            <button
                              onClick={() => setLayoutMode(layoutMode === 'pc' ? 'smartphone' : 'pc')}
                              className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                                layoutMode === 'smartphone'
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                              }`}
                              title={layoutMode === 'pc' ? 'スマートフォンモードに切替' : 'タブレット/PCモードに切替'}
                              style={{ WebkitTapHighlightColor: 'transparent' }}
                              type="button"
                            >
                              {layoutMode === 'smartphone' ? (
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
                                </svg>
                              ) : (
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </div>

                          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
                            ヘッダー/タブバー表示設定
                          </h3>

                          {/* 表示処理の補足 */}
                          <div className="mb-3">
                            <h4 className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">
                              集中モード
                            </h4>
                            <div className="space-y-2">
                              {(
                                [
                                  ['focus_sp_mapOn', 'スマホ・マップ表示'],
                                  ['focus_sp_mapOff', 'スマホ・マップ非表示'],
                                  ['focus_pc_mapOn', 'パソコン・マップ表示'],
                                  ['focus_pc_mapOff', 'パソコン・マップ非表示'],
                                ] as [keyof typeof uiVisibilitySettings, string][]
                              ).map(([key, label]) => (
                                <div
                                  key={key}
                                  className="flex items-center justify-between text-xs"
                                >
                                  <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">
                                    {label}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={uiVisibilitySettings[key].header}
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(key, 'header', e.target.checked)
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        ヘッダー
                                      </span>
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={uiVisibilitySettings[key].tabBar}
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(key, 'tabBar', e.target.checked)
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        タブバー
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* 表示処理の補足 */}
                          <div className="mb-3">
                            <h4 className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2">
                              実行モード
                            </h4>
                            <div className="space-y-2">
                              {(
                                [
                                  ['execute_sp', 'スマートフォン'],
                                  ['execute_pc', 'パソコン / タブレット'],
                                ] as [keyof typeof uiVisibilitySettings, string][]
                              ).map(([key, label]) => (
                                <div
                                  key={key}
                                  className="flex items-center justify-between text-xs"
                                >
                                  <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">
                                    {label}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={uiVisibilitySettings[key].header}
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(key, 'header', e.target.checked)
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        ヘッダー
                                      </span>
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={uiVisibilitySettings[key].tabBar}
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(key, 'tabBar', e.target.checked)
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        タブバー
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* セル輪郭スタイル */}
                          <div className="mb-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                            <h4 className="text-xs font-semibold text-orange-600 dark:text-orange-400 mb-2">
                              セル輪郭スタイル
                            </h4>
                            <div className="space-y-1">
                              {([
                                ['rounded', '角丸（デフォルト）'],
                                ['square', '直角'],
                                ['dashed', '破線'],
                                ['none', '輪郭なし'],
                              ] as [import('./types').NumberCellOutlineStyle, string][]).map(([value, label]) => (
                                <label key={value} className="flex items-center gap-2 cursor-pointer text-xs">
                                  <input
                                    type="radio"
                                    name="numberCellOutlineStyle"
                                    value={value}
                                    checked={numberCellOutlineStyle === value}
                                    onChange={() => setNumberCellOutlineStyle(value)}
                                    className="text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-slate-600 dark:text-slate-400">{label}</span>
                                </label>
                              ))}
                            </div>
                          </div>

                          {/* 表示処理の補足 */}
                          <button
                            onClick={() => {
                              setUiVisibilitySettings(DEFAULT_UI_VISIBILITY);
                              setUiVisibilityOverride(false);
                              setNumberCellOutlineStyle(DEFAULT_OUTLINE_STYLE);
                            }}
                            className="w-full mt-1 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                          >
                            デフォルトに戻す
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* 表示処理の補足 */}
                  {activeEventName && mainContentVisible && !mapViewActive && (
                    <div className="flex items-center gap-1 ml-2 border-l border-slate-300 dark:border-slate-600 pl-2">
                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => handleSetViewMode('edit')}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          currentMode === 'edit'
                            ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                        title="編集モード"
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '40px',
                          minHeight: '40px',
                        }}
                        type="button"
                      >
                        <span className="text-lg">📝</span>
                      </button>

                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => handleSetViewMode('execute')}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          currentMode === 'execute'
                            ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                        title="実行モード"
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '40px',
                          minHeight: '40px',
                        }}
                        type="button"
                      >
                        <span className="text-lg">🏃‍♂️</span>
                      </button>

                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => handleSetViewMode('focus')}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          currentMode === 'focus'
                            ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                        title="集中モード"
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '40px',
                          minHeight: '40px',
                        }}
                        type="button"
                      >
                        <span className="text-lg">🔍</span>
                      </button>
                    </div>
                  )}

                  {/* 表示処理の補足 */}
                  {activeEventName && isMapTab && currentMapData && (
                    <>
                      {currentHalls.length > 0 && (
                        <>
                          {/* 表示処理の補足 */}
                          <div className="relative">
                            <button
                              onClick={() => setMapHallSelectorOpen(!mapHallSelectorOpen)}
                              className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                                mapHallSelectorOpen
                                  ? 'bg-slate-200 dark:bg-slate-700'
                                  : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                              }`}
                              title={`表示ホール: ${mapSelectedHallId === 'all' ? '全ホール' : currentHalls.find((h) => h.id === mapSelectedHallId)?.name || ''}`}
                              style={{
                                WebkitTapHighlightColor: 'transparent',
                                minWidth: '44px',
                                minHeight: '44px',
                              }}
                              type="button"
                            >
                              {/* 表示処理の補足 */}
                              <svg
                                className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                              >
                                <path d="M2 18h3v-4h2v4h2v-6H7l-2-4-2 4H2v6zm5-8h2V8h2V6h2v2h2v2h2v8h-3v-4h-2v4h-3v-8z" />
                                <path d="M14 10h2v2h-2zM14 14h2v2h-2zM18 10h2v2h-2zM18 14h2v2h-2z" />
                              </svg>
                            </button>
                            {mapSelectedHallId !== 'all' && (
                              <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full"></span>
                            )}

                            {/* 表示処理の補足 */}
                            {mapHallSelectorOpen && (
                              <>
                                {/* 表示処理の補足 */}
                                <div
                                  className="fixed inset-0 z-40"
                                  onClick={() => setMapHallSelectorOpen(false)}
                                />
                                <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 min-w-[200px]">
                                  <button
                                    onClick={() => {
                                      setMapSelectedHallId('all');
                                      setMapHallSelectorOpen(false);
                                    }}
                                    className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                                      mapSelectedHallId === 'all'
                                        ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                                    }`}
                                  >
                                    全ホール
                                  </button>
                                  {currentHalls.map((hall) => {
                                    const executeCount = getHallExecuteCount(hall.id);
                                    const totalCount = getHallTotalItemCount(hall.id);
                                    return (
                                      <button
                                        key={hall.id}
                                        onClick={() => {
                                          setMapSelectedHallId(hall.id);
                                          setMapHallSelectorOpen(false);
                                        }}
                                        className={`w-full px-4 py-2 text-left text-sm transition-colors flex justify-between items-center ${
                                          mapSelectedHallId === hall.id
                                            ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                                        }`}
                                      >
                                        <span>{hall.name}</span>
                                        <span className="text-xs text-slate-500 dark:text-slate-400 ml-2">
                                          ({executeCount}/{totalCount}件)
                                        </span>
                                      </button>
                                    );
                                  })}
                                </div>
                              </>
                            )}
                          </div>

                          {/* 表示処理の補足 */}
                          <button
                            onClick={() => setMapIsHallOrderOpen(true)}
                            className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
                            title="ホール順を編集"
                            style={{
                              WebkitTapHighlightColor: 'transparent',
                              minWidth: '44px',
                              minHeight: '44px',
                            }}
                            type="button"
                          >
                            <svg
                              className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                          </button>
                        </>
                      )}

                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => setMapIsRouteVisible(!mapIsRouteVisible)}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          mapIsRouteVisible
                            ? 'bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-800'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                        }`}
                        title={mapIsRouteVisible ? 'ルート表示: 有効' : 'ルート表示: 無効'}
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '44px',
                          minHeight: '44px',
                        }}
                        type="button"
                      >
                        {/* 表示処理の補足 */}
                        <svg
                          className={`w-5 h-5 pointer-events-none ${mapIsRouteVisible ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <circle cx="6" cy="6" r="2" strokeWidth={2} />
                          <circle cx="18" cy="18" r="2" strokeWidth={2} />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 8v4a4 4 0 004 4h4M14 12l4 4m0 0l-4 4"
                          />
                        </svg>
                      </button>

                      {/* 表示処理の補足 */}
                      <button
                        onPointerDown={() => {
                          smartInsertLongPressTriggeredRef.current = false;
                          smartInsertLongPressRef.current = setTimeout(() => {
                            smartInsertLongPressTriggeredRef.current = true;
                            const newMode = mapSmartInsertMode === 'card' ? 'preview' : 'card';
                            setMapSmartInsertMode(newMode);
                            showSmartInsertToast(
                              newMode === 'preview'
                                ? 'プレビューモードに切り替え'
                                : 'カードモードに切り替え',
                            );
                          }, 500);
                        }}
                        onPointerUp={() => {
                          if (smartInsertLongPressRef.current) {
                            clearTimeout(smartInsertLongPressRef.current);
                            smartInsertLongPressRef.current = null;
                          }
                        }}
                        onPointerLeave={() => {
                          if (smartInsertLongPressRef.current) {
                            clearTimeout(smartInsertLongPressRef.current);
                            smartInsertLongPressRef.current = null;
                          }
                        }}
                        onClick={() => {
                          if (smartInsertLongPressTriggeredRef.current) {
                            smartInsertLongPressTriggeredRef.current = false;
                            return;
                          }
                          setMapSmartInsertEnabled(!mapSmartInsertEnabled);
                        }}
                        className={`relative p-2 rounded-md transition-colors touch-manipulation select-none ${
                          mapSmartInsertEnabled
                            ? 'bg-green-100 dark:bg-green-900/50 hover:bg-green-200 dark:hover:bg-green-800'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                        }`}
                        title={`スマート挿入: ${mapSmartInsertEnabled ? '有効' : '無効'}（${mapSmartInsertMode === 'card' ? 'カード' : 'プレビュー'}）`}
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '44px',
                          minHeight: '44px',
                        }}
                        type="button"
                      >
                        <svg
                          className={`w-5 h-5 pointer-events-none ${mapSmartInsertEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-600 dark:text-slate-400'}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4v16m0-8l-4-4m4 4l4-4"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 12h14"
                          />
                        </svg>
                        {/* 表示処理の補足 */}
                        {mapSmartInsertEnabled && (
                          <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-bold leading-none text-green-600 dark:text-green-400">
                            {mapSmartInsertMode === 'preview' ? 'P' : 'C'}
                          </div>
                        )}
                      </button>
                    </>
                  )}
                  {activeEventName && isMapTab && currentMapData && (
                    <MapRotationControls
                      angle={currentMapTabRotationState.mapTabAngle}
                      initialAngle={currentMapTabRotationState.initialAngle}
                      onAngleChange={handleMapTabRotationAngleChange}
                      showHint={true}
                    />
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4">
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  selectedItemIds.size > 0 &&
                  layoutMode !== 'smartphone' && (
                    <>
                      <BulkActionControls onSort={handleBulkSort} onClear={handleClearSelection} />
                      {showMoveButtons && hasCandidateSelection && (
                        <button
                          onClick={() => handleMoveToExecuteColumn(Array.from(selectedItemIds))}
                          className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                        >
                          選択したアイテムを実行列に移動 ({selectedItemIds.size}件)
                        </button>
                      )}
                      {showMoveButtons && hasExecuteSelection && (
                        <button
                          onClick={() => handleRemoveFromExecuteColumn(Array.from(selectedItemIds))}
                          className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                        >
                          選択したアイテムを実行列から戻す ({selectedItemIds.size}件)
                        </button>
                      )}
                    </>
                  )}
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  currentMode === 'execute' && (
                    <button
                      onClick={handleSortToggle}
                      className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-200 text-blue-600 bg-blue-100 hover:bg-blue-200 dark:text-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-900 flex-shrink-0"
                    >
                      {sortLabels[sortState]}
                    </button>
                  )}
                {/* PC: 実行モード スペース別切替ボタン */}
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  currentMode === 'execute' &&
                  layoutMode !== 'smartphone' && (
                    <button
                      onClick={() => {
                        setExecuteSpaceGroupingEnabled((prev) => !prev);
                        setExecuteCollapsedSpaces(new Set());
                      }}
                      className={`px-2 py-1 text-xs font-medium rounded transition-colors flex-shrink-0 ${
                        executeSpaceGroupingEnabled
                          ? 'bg-blue-600 text-white dark:bg-blue-500'
                          : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600'
                      }`}
                    >
                      スペース別
                    </button>
                  )}
              </div>
            </div>
          )}
          {showTabBar && (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-slate-200 dark:border-slate-700">
              <div className="flex space-x-2 pt-2 pb-2 overflow-x-auto">
                <TabButton
                  tab="eventList"
                  label="イベント一覧"
                  onClick={() => {
                    setActiveEventName(null);
                    setItemToEdit(null);
                    setSelectedItemIds(new Set());
                    setSelectedBlockFilters(new Set());
                    setActiveTab('eventList');
                  }}
                />
                {activeEventName ? (
                  <>
                    {eventDates.map((eventDate) => {
                      const count = items.filter((item) => item.eventDate === eventDate).length;
                      return (
                        <React.Fragment key={eventDate}>
                          <TabButton tab={eventDate} label={eventDate} count={count} />
                        </React.Fragment>
                      );
                    })}
                    <TabButton
                      tab="import"
                      label={itemToEdit ? 'アイテム編集' : 'アイテム追加'}
                    />
                    {activeEventName && (mainContentVisible || isMapTab) && (
                      <SearchBar
                        searchKeyword={searchKeyword}
                        onSearchKeywordChange={setSearchKeyword}
                        onSearchNext={handleSearchNext}
                        matchCount={visibleSearchMatches.length}
                        currentMatchIndex={currentSearchIndex}
                      />
                    )}
                    {/* スマホ: 実行モード スペース別切替ボタン（フッターに表示） */}
                    {activeEventName &&
                      mainContentVisible &&
                      currentMode === 'execute' &&
                      layoutMode === 'smartphone' && (
                        <button
                          onClick={() => {
                            setExecuteSpaceGroupingEnabled((prev) => !prev);
                            setExecuteCollapsedSpaces(new Set());
                          }}
                          className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap flex-shrink-0 ${
                            executeSpaceGroupingEnabled
                              ? 'bg-blue-600 text-white dark:bg-blue-500'
                              : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600'
                          }`}
                        >
                          スペース別
                        </button>
                      )}
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setItemToEdit(null);
                      setActiveTab('import');
                    }}
                    className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
                      activeTab === 'import'
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                    }`}
                  >
                    新規リスト作成
                  </button>
                )}
              </div>
            </div>
          )}
        </header>
      )}

      {/* 表示処理の補足 */}
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

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
        {activeTab === 'eventList' && (
          <EventListScreen
            eventNames={Object.keys(eventLists).sort()}
            onSelect={handleSelectEvent}
            onDelete={handleDeleteEvent}
            onExport={handleExportEvent}
            onUpdate={handleUpdateEvent}
            onRename={(oldName) => handleRenameEvent(oldName)}
            onImportMap={handleImportMapData}
            onImportExportFile={() => exportFileInputRef.current?.click()}
          />
        )}
        {activeTab === 'import' && (
          <Suspense fallback={<div className="flex justify-center p-8"><div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>}>
            <ImportScreen
              onBulkAdd={handleBulkAdd}
              activeEventName={activeEventName}
              itemToEdit={itemToEdit}
              onUpdateItem={handleUpdateItem}
              onDoneEditing={handleDoneEditing}
              newItemDefaults={newItemDefaults}
              onClearNewItemDefaults={handleClearNewItemDefaults}
            />
          </Suspense>
        )}
        {/* 表示処理の補足 */}
        {activeEventName && isMapTab && currentMapData && currentMapTabName && (
          <MapView
            mapData={currentMapData}
            mapName={currentMapTabName}
            items={items}
            executeModeItemIds={currentMapExecuteItemIds}
            onAddToExecuteList={handleAddToExecuteListFromMap}
            onAddToExecuteListAtPosition={handleAddToExecuteListFromMapAtPosition}
            onRemoveFromExecuteList={handleRemoveFromExecuteListFromMap}
            onMoveToFirst={handleMoveToFirstFromMap}
            onMoveToLast={handleMoveToLastFromMap}
            onUpdateItem={handleUpdateItem}
            onDeleteItem={handleDeleteItemFromMap}
            onAddNewItem={handleAddNewItemFromMap}
            onAddItem={handleAddItemFromFocusMode}
            halls={currentHalls}
            hallRouteSettings={currentHallRouteSettings}
            onUpdateHallRouteSettings={handleUpdateHallRouteSettings}
            onReorderExecuteList={handleReorderExecuteListByHallOrder}
            vertexSelectionMode={vertexSelectionMode}
            cellSelectionMode={cellSelectionMode}
            highlightedCell={visitListPanelOpen ? highlightedMapCell : null}
            externalSelectedHallId={mapSelectedHallId}
            onSelectedHallIdChange={setMapSelectedHallId}
            externalIsRouteVisible={mapIsRouteVisible}
            onRouteVisibleChange={setMapIsRouteVisible}
            externalIsHallOrderOpen={mapIsHallOrderOpen}
            onHallOrderOpenChange={setMapIsHallOrderOpen}
            hideInternalControls={true}
            smartInsertEnabled={mapSmartInsertEnabled}
            smartInsertMode={mapSmartInsertMode}
            rotationAngle={currentMapTabRotationState.mapTabAngle}
            onRotationAngleChange={handleMapTabRotationAngleChange}
            selectionGuideOptions={vertexGuideOptions}
            initialViewport={currentMapTabViewport}
            onViewportChange={handleMapViewportChange}
            numberCellOutlineStyle={numberCellOutlineStyle}
          />
        )}
        {activeEventName && mainContentVisible && !isMapTab && (
          <div
            style={{
              transform: `scale(${zoomLevel / 100})`,
              transformOrigin: 'top left',
              width: `${100 * (100 / zoomLevel)}%`,
            }}
          >
            {currentMode === 'edit' ? (
              <div className="grid grid-cols-2 gap-4">
                {/* 表示処理の補足 */}
                <div className="space-y-2">
                  <div className="bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-700 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                        実行リストアイテム
                      </h3>
                      <button
                        onClick={() => {
                          setSpaceGroupingEnabled((prev) => !prev);
                          setCollapsedSpaces(new Set());
                        }}
                        className={`px-2 py-0.5 text-xs font-medium rounded transition-colors ${
                          spaceGroupingEnabled
                            ? 'bg-blue-600 text-white dark:bg-blue-500'
                            : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600'
                        }`}
                      >
                        スペース別
                      </button>
                    </div>
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">
                      実行対象として選択中のアイテムを管理します。
                    </p>
                  </div>
                  <ShoppingList
                    items={executeColumnItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={handleMoveItem}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    columnType="execute"
                    currentDay={activeEventDate}
                    onMoveItemUp={handleMoveItemUp}
                    onMoveItemDown={handleMoveItemDown}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onToggleRangeSelection={handleToggleRangeSelection}
                    duplicateCircleItemIds={duplicateCircleItemIds}
                    highlightedItemId={highlightedItemId}
                    layoutMode={layoutMode}
                    viewMode="edit"
                    showHallGroups={!spaceGroupingEnabled}
                    hallDefinitions={getHallsForDate(
                      activeEventDate,
                    )}
                    hallOrder={getHallOrderForDate(
                      activeEventDate,
                    )}
                    mapData={getMapDataForDate(
                      activeEventDate,
                    )}
                    showSpaceGroups={spaceGroupingEnabled}
                    collapsedSpaces={collapsedSpaces}
                    onToggleSpaceCollapse={handleToggleSpaceCollapse}
                    onToggleAllSpaceCollapse={handleToggleAllSpaceCollapse}
                    onSetSpaceGroupDragItemIds={handleSetSpaceGroupDragItemIds}
                    onSelectSpaceGroupForRange={handleSelectSpaceGroupForRange}
                    onAddItem={handleAddItemFromFocusMode}
                  />
                </div>

                {/* 表示処理の補足 */}
                <div className="space-y-2">
                  <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
                      候補アイテム
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                      このリストから選択したアイテムを実行リストへ移動します。
                    </p>
                    {availableBlocks.length > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            ブロックでフィルタ:
                          </span>
                          <div className="flex items-center gap-2">
                            {selectedBlockFilters.size > 0 && (
                              <>
                                <button
                                  onClick={handleCandidateNumberSort}
                                  className={`p-1.5 rounded-md transition-colors ${
                                    candidateNumberSortDirection
                                      ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                                      : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600'
                                  }`}
                                  title={
                                    candidateNumberSortDirection === 'desc'
                                      ? '番号を降順で並べ替え'
                                      : candidateNumberSortDirection === 'asc'
                                        ? '番号を昇順で並べ替え'
                                        : '番号で並べ替え'
                                  }
                                >
                                  {candidateNumberSortDirection === 'desc' ? (
                                    <SortDescendingIcon className="w-4 h-4" />
                                  ) : (
                                    <SortAscendingIcon className="w-4 h-4" />
                                  )}
                                </button>
                                <button
                                  onClick={handleClearBlockFilters}
                                  className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
                                >
                                  すべて解除
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {availableBlocks.map((block) => (
                            <button
                              key={block}
                              onClick={() => handleToggleBlockFilter(block)}
                              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                selectedBlockFilters.has(block)
                                  ? 'bg-blue-600 text-white dark:bg-blue-500'
                                  : blocksWithPriorityRemarks.has(block)
                                    ? 'bg-yellow-300 dark:bg-yellow-600 text-slate-700 dark:text-slate-300 hover:bg-yellow-400 dark:hover:bg-yellow-500 border border-slate-300 dark:border-slate-600'
                                    : 'bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600'
                              }`}
                            >
                              {block}
                            </button>
                          ))}
                        </div>
                        {selectedBlockFilters.size > 0 && (
                          <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
                            選択中: {selectedBlockFilters.size}件のブロック
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  <ShoppingList
                    items={candidateColumnItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={handleMoveItem}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    columnType="candidate"
                    currentDay={activeEventDate}
                    onMoveItemUp={handleMoveItemUp}
                    onMoveItemDown={handleMoveItemDown}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onToggleRangeSelection={handleToggleRangeSelection}
                    duplicateCircleItemIds={duplicateCircleItemIds}
                    highlightedItemId={highlightedItemId}
                    layoutMode={layoutMode}
                    viewMode="edit"
                    showSpaceGroups={spaceGroupingEnabled}
                    collapsedSpaces={collapsedSpaces}
                    onToggleSpaceCollapse={handleToggleSpaceCollapse}
                    onToggleAllSpaceCollapse={handleToggleAllSpaceCollapse}
                    onSetSpaceGroupDragItemIds={handleSetSpaceGroupDragItemIds}
                    onSelectSpaceGroupForRange={handleSelectSpaceGroupForRange}
                    onAddItem={handleAddItemFromFocusMode}
                  />
                </div>
              </div>
            ) : currentMode === 'focus' ? (
              <Suspense fallback={<div className="flex justify-center p-8"><div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" /></div>}>
                <FocusModeContainer
                  key={currentFocusSessionKey || 'focus-mode'}
                  activeEventName={activeEventName}
                  activeTab={activeTab}
                  eventDates={eventDates}
                  items={items}
                  executeModeItems={executeModeItems}
                  mapData={mapData}
                  hallDefinitions={hallDefinitions}
                  hallRouteSettings={hallRouteSettings}
                  onUpdateItem={handleUpdateItem}
                  onModeChange={handleModeChangeFromFocus}
                  layoutMode={layoutMode}
                  onLayoutModeChange={setLayoutMode}
                  onMapVisibilityChange={setFocusModeMapVisible}
                  onAddItem={handleAddItemFromFocusMode}
                  onEditRequest={handleEditRequest}
                  onDeleteRequest={handleDeleteRequest}
                  appZoomLevel={zoomLevel}
                  resumeState={currentFocusResumeState}
                  onSessionStateChange={handleFocusSessionStateChange}
                  mapRotationAngle={currentFocusMapRotationState.focusModeAngle}
                  mapInitialRotationAngle={currentFocusMapRotationState.initialAngle}
                  onMapRotationAngleChange={handleFocusMapRotationAngleChange}
                  numberCellOutlineStyle={numberCellOutlineStyle}
                />
              </Suspense>
            ) : (
              <ShoppingList
                items={visibleItems}
                onUpdateItem={handleExecuteItemUpdate}
                onMoveItem={handleMoveItem}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds}
                onSelectItem={handleSelectItem}
                columnType="execute"
                currentDay={activeEventDate}
                onMoveItemUp={handleMoveItemUp}
                onMoveItemDown={handleMoveItemDown}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                onToggleRangeSelection={handleToggleRangeSelection}
                duplicateCircleItemIds={duplicateCircleItemIds}
                highlightedItemId={highlightedItemId}
                layoutMode={layoutMode}
                viewMode="execute"
                showSpaceGroups={executeSpaceGroupingEnabled}
                showHallGroups={!executeSpaceGroupingEnabled}
                collapsedSpaces={executeCollapsedSpaces}
                onToggleSpaceCollapse={handleExecuteToggleSpaceCollapse}
                onToggleAllSpaceCollapse={handleExecuteToggleAllSpaceCollapse}
                onAddItem={handleAddItemFromFocusMode}
                onBulkStatusChange={handleBulkStatusChange}
                onSpaceGroupOrderChange={handleExecuteSpaceGroupOrderChange}
                onCollapseAndOpenNext={handleCollapseAndOpenNext}
                showPostponeFilterButton={showPostponeFilterButton}
                onActivatePostponeFilter={handleActivatePostponeFilter}
                hallDefinitions={getHallsForDate(
                  activeEventDate,
                )}
                hallOrder={getHallOrderForDate(
                  activeEventDate,
                )}
                mapData={getMapDataForDate(
                  activeEventDate,
                )}
              />
            )}
          </div>
        )}
      </main>

      {itemToDelete && (
        <DeleteConfirmationModal
          item={itemToDelete}
          onConfirm={handleConfirmDelete}
          onCancel={() => setItemToDelete(null)}
        />
      )}

      {showUpdateConfirmation && updateData && (
        <UpdateConfirmationModal
          itemsToDelete={updateData.itemsToDelete}
          itemsToUpdate={updateData.itemsToUpdate}
          itemsToAdd={updateData.itemsToAdd}
          protectedFromDelete={updateData.protectedFromDelete}
          protectedFromUpdate={updateData.protectedFromUpdate}
          onConfirm={handleConfirmUpdate}
          onCancel={() => {
            setShowUpdateConfirmation(false);
            setUpdateData(null);
            setUpdateEventName(null);
          }}
        />
      )}

      {showUrlUpdateDialog && (
        <UrlUpdateDialog
          currentUrl={
            pendingUpdateEventName
              ? eventMetadata[pendingUpdateEventName]?.spreadsheetUrl || ''
              : ''
          }
          onConfirm={handleUrlUpdate}
          onCancel={() => {
            setShowUrlUpdateDialog(false);
            setPendingUpdateEventName(null);
            setActiveEventName(null);
            setActiveTab('eventList');
          }}
        />
      )}

      {showRenameDialog && eventToRename && (
        <EventRenameDialog
          currentName={eventToRename}
          onConfirm={handleConfirmRename}
          onCancel={() => {
            setShowRenameDialog(false);
            setEventToRename(null);
          }}
        />
      )}

      {/* 表示処理の補足 */}
      {showExportOptions && exportEventName && (
        <ExportOptionsDialog
          isOpen={showExportOptions}
          onClose={() => {
            setShowExportOptions(false);
            setExportEventName(null);
          }}
          onExport={handleConfirmExport}
          hasMapData={
            !!(
              exportEventName &&
              mapData[exportEventName] &&
              Object.keys(mapData[exportEventName]).length > 0
            )
          }
        />
      )}

      {/* 表示処理の補足 */}
      {blockDefinitionMode && currentMapData && (
        <BlockDefinitionPanel
          isOpen={blockDefinitionMode}
          onClose={() => {
            setBlockDefinitionMode(false);
            setPendingCellSelection(null);
          }}
          mapData={currentMapData}
          onUpdateBlocks={handleUpdateBlocks}
          onStartCellSelection={handleStartCellSelection}
          pendingCellSelection={pendingCellSelection}
          onClearPendingCellSelection={() => setPendingCellSelection(null)}
        />
      )}

      {/* 表示処理の補足 */}
      {cellSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
              {(() => {
                const data = cellSelectionMode.editingBlockData as { block?: { name?: string } } | undefined;
                const name = data?.block?.name?.trim();
                return name ? `「${name}」設定中` : '「名称不明ブロック」設定中';
              })()}
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              {cellSelectionMode.type === 'corner' &&
                `セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === 'multiCorner' &&
                `セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === 'rangeStart' &&
                `対角の2セルをクリック (${cellSelectionMode.clickedCells.length}/2)`}
              {cellSelectionMode.type === 'individual' &&
                `対象セルをクリック (${cellSelectionMode.clickedCells.length}セル選択中)`}
            </div>
            {cellSelectionMode.clickedCells.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                選択: {cellSelectionMode.clickedCells.map((c) => `(${c.row},${c.col})`).join(', ')}
              </div>
            )}
            <div className="text-xs text-blue-500 dark:text-blue-400 mt-1">
              マーカーをクリックで選択解除
            </div>
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleConfirmCellSelection}
              disabled={
                ((cellSelectionMode.type === 'corner' ||
                  cellSelectionMode.type === 'multiCorner') &&
                  cellSelectionMode.clickedCells.length < 4) ||
                (cellSelectionMode.type === 'rangeStart' &&
                  cellSelectionMode.clickedCells.length < 2) ||
                (cellSelectionMode.type === 'individual' &&
                  cellSelectionMode.clickedCells.length === 0)
              }
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              選択を確定
            </button>
            <button
              onClick={handleCancelCellSelection}
              className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 表示処理の補足 */}
      {hallDefinitionMode && currentMapData && (
        <HallDefinitionPanel
          isOpen={hallDefinitionMode}
          onClose={() => {
            setHallDefinitionMode(false);
            setPendingVertexSelection(null);
          }}
          mapData={currentMapData}
          halls={currentHalls}
          onUpdateHalls={handleUpdateHalls}
          onStartVertexSelection={handleStartVertexSelection}
          pendingVertexSelection={pendingVertexSelection}
          onClearPendingVertexSelection={() => setPendingVertexSelection(null)}
        />
      )}

      {/* 表示処理の補足 */}
      {visitListPanelOpen && currentMapData && (
        <VisitListPanel
          isOpen={visitListPanelOpen}
          onClose={handleVisitListClose}
          items={visitListItems}
          onUpdateOrder={handleVisitListOrderUpdate}
          mapData={currentMapData}
          hallDefinitions={currentHalls}
          hallOrder={visitListHallOrder}
          layoutMode={layoutMode}
          onHighlightCell={handleHighlightMapCell}
          onClearHighlight={handleClearMapCellHighlight}
          hasUnsavedChanges={visitListHasUnsavedChanges}
          onConfirm={handleVisitListConfirm}
          onCancel={handleVisitListCancel}
          onUpdateItemPriority={handleUpdateItemPriority}
        />
      )}

      {/* 表示処理の補足 */}
      {showVisitListConfirmDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-3">
              変更を保存しますか？
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              訪問リストに未保存の変更があります。保存して確定するか、キャンセルして破棄してください。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleVisitListDialogCancel}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
              >
                キャンセル（破棄）
              </button>
              <button
                onClick={handleVisitListDialogConfirm}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                保存して確定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 表示処理の補足 */}
      {vertexSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
              {(() => {
                const data = vertexSelectionMode.editingData as { hall?: { name?: string } } | undefined;
                const name = data?.hall?.name?.trim();
                return name ? `「${name}」設定中` : '「名称不明ホール」設定中';
              })()}
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              ホールの頂点をクリック ({vertexSelectionMode.clickedVertices.length}
              /6)
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
              クリック順に多角形を作成します。
            </div>
            {vertexSelectionMode.clickedVertices.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                選択:{' '}
                {vertexSelectionMode.clickedVertices.map((v) => `(${v.row},${v.col})`).join(' → ')}
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-center mb-3">
            <button
              onClick={() =>
                setVertexGuideOptions((prev) => ({ ...prev, showGrid: !prev.showGrid }))
              }
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                vertexGuideOptions.showGrid
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
              }`}
            >
              補助グリッド {vertexGuideOptions.showGrid ? 'ON' : 'OFF'}
            </button>
            <button
              onClick={() =>
                setVertexGuideOptions((prev) => ({ ...prev, showRuler: !prev.showRuler }))
              }
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                vertexGuideOptions.showRuler
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
              }`}
            >
              座標尺 {vertexGuideOptions.showRuler ? 'ON' : 'OFF'}
            </button>
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleConfirmVertexSelection}
              disabled={vertexSelectionMode.clickedVertices.length < 4}
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              確定
            </button>
            <button
              onClick={handleCancelVertexSelection}
              className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 表示処理の補足 */}
      <input
        type="file"
        ref={mapFileInputRef}
        accept=".xlsx"
        onChange={handleMapFileChange}
        style={{ display: 'none' }}
      />

      {/* 表示処理の補足 */}
      <MapImportDialog
        isOpen={mapImportDialogOpen}
        file={mapImportPendingFile}
        eventName={mapImportPendingEventName}
        savedSettings={
          mapImportPendingEventName ? loadBlockDetectionSettings(mapImportPendingEventName) : null
        }
        onImport={handleMapImportConfirm}
        onClose={handleMapImportClose}
      />

      {/* 表示処理の補足 */}
      <input
        type="file"
        ref={exportFileInputRef}
        accept=".xlsx"
        onChange={handleExportFileImport}
        style={{ display: 'none' }}
      />

      {activeEventName && items.length > 0 && mainContentVisible && (
        <>
          {currentMode === 'execute' && (
            <SummaryBar
              items={visibleItems}
              filterLabel={!showHeaderBar ? sortLabels[sortState] : undefined}
              onFilterToggle={!showHeaderBar ? handleSortToggle : undefined}
            />
          )}
        </>
      )}
      {activeEventName && items.length > 0 && mainContentVisible && (
        <ZoomControl zoomLevel={zoomLevel} onZoomChange={handleZoomChange} />
      )}

      {/* スマホ時：選択アイテム操作の下部固定バー */}
      {layoutMode === 'smartphone' &&
        activeEventName &&
        mainContentVisible &&
        items.length > 0 &&
        selectedItemIds.size > 0 && (
          <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-lg px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <BulkActionControls onSort={handleBulkSort} onClear={handleClearSelection} />
              <div className="flex items-center gap-2">
                {showMoveButtons && hasCandidateSelection && (
                  <button
                    onClick={() => handleMoveToExecuteColumn(Array.from(selectedItemIds))}
                    className="px-3 py-2 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ⇦実行列へ ({selectedItemIds.size})
                  </button>
                )}
                {showMoveButtons && hasExecuteSelection && (
                  <button
                    onClick={() => handleRemoveFromExecuteColumn(Array.from(selectedItemIds))}
                    className="px-3 py-2 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ⇨候補へ ({selectedItemIds.size})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      {/* 表示処理の補足 */}
      {smartInsertToast && (
        <div
          className={`fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-pulse ${
            smartInsertToastType === 'error' ? 'bg-red-600' : 'bg-green-600'
          }`}
        >
          {smartInsertToast}
        </div>
      )}
    </div>
  );
};

export default App;


