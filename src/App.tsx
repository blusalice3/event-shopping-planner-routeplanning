import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
} from './types';
import ImportScreen from './components/ImportScreen';
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
import FocusModeContainer from './features/map/components/FocusModeContainer';
import { extractEventDates } from './utils/eventDates';
import { importFromXlsx, downloadBlob } from './utils/exportImport';
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

const App: React.FC = () => {
  const [eventLists, setEventLists] = useState<Record<string, ShoppingItem[]>>({});
  const [eventMetadata, setEventMetadata] = useState<Record<string, EventMetadata>>({});
  const [executeModeItems, setExecuteModeItems] = useState<Record<string, ExecuteModeItems>>({});
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});

  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('eventList');
  const [sortState, setSortState] = useState<SortState>('Manual');
  const [blockSortDirection, setBlockSortDirection] = useState<BlockSortDirection | null>(null);
  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectedBlockFilters, setSelectedBlockFilters] = useState<Set<string>>(new Set());
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<Set<string>>(new Set());
  // 処理の補足です。
  const [rangeStart, setRangeStart] = useState<{
    itemId: string;
    columnType: 'execute' | 'candidate';
  } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{
    itemId: string;
    columnType: 'execute' | 'candidate';
  } | null>(null);

  // 処理の補足です。

  const [newItemDefaults, setNewItemDefaults] = useState<{
    eventDate: string;
    block: string;
    number: string;
  } | null>(null);

  // 処理の補足です。

  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [updateData, setUpdateData] = useState<EventUpdateDiff | null>(null);
  const [updateEventName, setUpdateEventName] = useState<string | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);

  // 処理の補足です。

  const [searchKeyword, setSearchKeyword] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // 処理の補足です。

  const [layoutMode, setLayoutMode] = useState<'pc' | 'smartphone'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'smartphone' : 'pc',
  );
  const { uiVisibilitySettings, setUiVisibilitySettings } = useUIVisibilitySettings();
  const [uiVisibilityOverride, setUiVisibilityOverride] = useState(false);
  const [uiSettingsPanelOpen, setUiSettingsPanelOpen] = useState(false);
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);
  const [focusModeSessions, setFocusModeSessions] = useState<Record<string, FocusModeSessionState>>(
    {},
  );

  const { themeMode, setThemeMode } = useThemeMode();

  // 処理の補足です。

  const [mapData, setMapData] = useState<MapDataStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);

  // 処理の補足です。

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
      routeSettings,
      hallDefinitions,
      hallRouteSettings,
    },
    setters: {
      setEventLists,
      setEventMetadata,
      setExecuteModeItems,
      setDayModes,
      setMapData,
      setRouteSettings,
      setHallDefinitions,
      setHallRouteSettings,
    },
  });

  const items = useMemo(
    () => (activeEventName ? eventLists[activeEventName] || [] : []),
    [activeEventName, eventLists],
  );

  // 処理の補足です。

  const eventDates = useMemo(() => extractEventDates(items), [items]);

  const {
    mapTabs,
    isMapTab,
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
    mapData,
    hallDefinitions,
    hallRouteSettings,
  });

  // 処理の補足です。

  const getHallExecuteCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return 0;
      const dayName = dayMatch[1];

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      return executeIds.filter((itemId) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return false;

        // 処理の補足です。

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
    [activeEventName, isMapTab, activeTab, currentMapData, currentHalls, items, executeModeItems],
  );

  // 処理の補足です。

  const getHallTotalItemCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return 0;
      const dayName = dayMatch[1];

      const dayItems = items.filter((item) => item.eventDate === dayName);

      return dayItems.filter((item) => {
        // 処理の補足です。
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
    [activeEventName, isMapTab, activeTab, currentMapData, currentHalls, items],
  );

  // 処理の補足です。

  const getItemHallId = useCallback(
    (item: ShoppingItem, eventDate: string): string | null => {
      const halls = getHallsForDate(eventDate);
      const mapDataForDate = getMapDataForDate(eventDate);
      if (!halls.length || !mapDataForDate) return null;

      // 処理の補足です。

      const block = mapDataForDate.blocks.find((b) => b.name === item.block);
      if (!block) return null;

      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;

      // 処理の補足です。

      for (const hall of halls) {
        if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
          return hall.id;
        }
      }
      return null;
    },
    [getHallsForDate, getMapDataForDate],
  );

  // 処理の補足です。

  const areItemsInSameHall = useCallback(
    (itemId1: string, itemId2: string, eventDate: string): boolean => {
      const item1 = items.find((i) => i.id === itemId1);
      const item2 = items.find((i) => i.id === itemId2);
      if (!item1 || !item2) return true; // 判定に必要な情報が不足するため true を返します。
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return true; // 判定に必要な情報が不足するため true を返します。
      const hallId1 = getItemHallId(item1, eventDate);
      const hallId2 = getItemHallId(item2, eventDate);

      // 処理の補足です。

      if (hallId1 === null || hallId2 === null) return true;

      return hallId1 === hallId2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    // 処理の補足です。
    if (isMapTab) return 'edit';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    // 処理の補足です。
    if (eventDates.includes(activeTab)) {
      return modes[activeTab] || 'edit';
    }
    return 'edit';
  }, [activeEventName, dayModes, activeTab, eventDates, isMapTab]);

  // 処理の補足です。

  const currentFocusSessionKey = useMemo(() => {
    if (!activeEventName) return null;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    if (!currentEventDate) return null;
    return buildFocusSessionKey(activeEventName, currentEventDate);
  }, [activeEventName, activeTab, eventDates]);

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
      // 設定変更時は強制表示モードを解除して即時反映する
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

      setEventLists((prev) => {
        // 処理の補足です。
        const currentItem = prev[activeEventName]?.find((item) => item.id === updatedItem.id);
        const purchaseStatusChanged =
          currentItem && currentItem.purchaseStatus !== updatedItem.purchaseStatus;
        const priceChanged = currentItem && currentItem.price !== updatedItem.price;

        // 処理の補足です。

        if (purchaseStatusChanged) {
          setRecentlyChangedItemIds((prevIds) => new Set(prevIds).add(updatedItem.id));
        }

        // 処理の補足です。
        // 処理の補足です。
        const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
        const currentMode = dayModes[activeEventName]?.[currentEventDate] || 'edit';
        let finalItem = updatedItem;

        if (
          (currentMode === 'execute' || currentMode === 'focus') &&
          (purchaseStatusChanged || priceChanged)
        ) {
          // 処理の補足です。
          const currentProtection =
            currentItem?.protectionLevel ?? (currentItem?.source === 'app' ? 'full' : 'none');
          if (currentProtection === 'none') {
            finalItem = { ...updatedItem, protectionLevel: 'deletable' as const };
          }
        }

        return {
          ...prev,
          [activeEventName]: prev[activeEventName].map((item) =>
            item.id === updatedItem.id ? finalItem : item,
          ),
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

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
      const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

      // 処理の補足です。

      const isAppendToEnd = hoverId === '__END_OF_LIST__';

      // 処理の補足です。

      if (mode === 'edit' && sourceColumn && targetColumn && sourceColumn !== targetColumn) {
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

        if (sourceColumn === 'candidate' && targetColumn === 'execute') {
          // 処理の補足です。
          const currentTabItemsForMove = items.filter((item) => item.eventDate === activeTab);
          let candidateItems = currentTabItemsForMove.filter((item) => !executeIdsSet.has(item.id));

          // 処理の補足です。

          if (selectedBlockFilters.size > 0) {
            candidateItems = candidateItems.filter((item) => selectedBlockFilters.has(item.block));
          }

          // 処理の補足です。

          let itemsToMove: ShoppingItem[] = [];
          if (selectedItemIds.has(dragId)) {
            // 処理の補足です。
            itemsToMove = candidateItems.filter((item) => selectedItemIds.has(item.id));
          } else {
            const item = candidateItems.find((item) => item.id === dragId);
            if (item) itemsToMove = [item];
          }

          if (itemsToMove.length === 0) return;

          const itemIdsToMove = itemsToMove.map((item) => item.id);

          // 処理の補足です。

          setExecuteModeItems((prevExecute) => {
            const eventItems = prevExecute[activeEventName] || {};
            const dayItems = [...(eventItems[currentEventDate] || [])];

            if (isAppendToEnd) {
              return {
                ...prevExecute,
                [activeEventName]: {
                  ...eventItems,
                  [currentEventDate]: [...dayItems, ...itemIdsToMove],
                },
              };
            } else {
              const hoverIndex = dayItems.findIndex((id) => id === hoverId);
              if (hoverIndex === -1) {
                return {
                  ...prevExecute,
                  [activeEventName]: {
                    ...eventItems,
                    [currentEventDate]: [...dayItems, ...itemIdsToMove],
                  },
                };
              }
              dayItems.splice(hoverIndex, 0, ...itemIdsToMove);
              return {
                ...prevExecute,
                [activeEventName]: { ...eventItems, [currentEventDate]: dayItems },
              };
            }
          });
          return;
        } else if (sourceColumn === 'execute' && targetColumn === 'candidate') {
          // 処理の補足です。
          setEventLists((prev) => {
            const allItems = [...(prev[activeEventName] || [])];
            const executeItems = allItems.filter(
              (item) => item.eventDate.includes(currentEventDate) && executeIdsSet.has(item.id),
            );
            const candidateItems = allItems.filter(
              (item) => item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id),
            );

            // 処理の補足です。

            let itemsToMove: ShoppingItem[] = [];
            if (selectedItemIds.has(dragId)) {
              itemsToMove = executeItems.filter((item) => selectedItemIds.has(item.id));
            } else {
              const item = executeItems.find((item) => item.id === dragId);
              if (item) itemsToMove = [item];
            }

            if (itemsToMove.length === 0) return prev;

            const itemIdsToMove = itemsToMove.map((item) => item.id);

            // 処理の補足です。

            setExecuteModeItems((prevExecute) => {
              const eventItems = prevExecute[activeEventName] || {};
              const dayItems = (eventItems[currentEventDate] || []).filter(
                (id) => !itemIdsToMove.includes(id),
              );
              return {
                ...prevExecute,
                [activeEventName]: { ...eventItems, [currentEventDate]: dayItems },
              };
            });

            // 処理の補足です。

            let newCandidateList: ShoppingItem[] = [];
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

            // 処理の補足です。

            const remainingExecuteItems = executeItems.filter(
              (item) => !itemIdsToMove.includes(item.id),
            );

            const newItems = allItems.map((item) => {
              if (!item.eventDate.includes(currentEventDate)) {
                return item;
              }
              if (executeIdsSet.has(item.id) && !itemIdsToMove.includes(item.id)) {
                return remainingExecuteItems.shift() || item;
              } else if (!executeIdsSet.has(item.id) || itemIdsToMove.includes(item.id)) {
                return newCandidateList.shift() || item;
              }
              return item;
            });

            return { ...prev, [activeEventName]: newItems };
          });
          return;
        }
      }

      if (mode === 'edit' && targetColumn === 'execute') {
        // 処理の補足です。
        setExecuteModeItems((prev) => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];

          if (selectedItemIds.has(dragId)) {
            // 処理の補足です。
            const selectedBlock = dayItems.filter((id) => selectedItemIds.has(id));
            const listWithoutSelection = dayItems.filter((id) => !selectedItemIds.has(id));

            if (isAppendToEnd) {
              return {
                ...prev,
                [activeEventName]: {
                  ...eventItems,
                  [currentEventDate]: [...listWithoutSelection, ...selectedBlock],
                },
              };
            }

            const targetIndex = listWithoutSelection.findIndex((id) => id === hoverId);
            if (targetIndex === -1) return prev;
            listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);

            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection },
            };
          } else {
            // 処理の補足です。
            const dragIndex = dayItems.findIndex((id) => id === dragId);
            if (dragIndex === -1) return prev; // 条件に合わないため状態は変更しません。
            const [draggedItem] = dayItems.splice(dragIndex, 1);

            if (isAppendToEnd) {
              dayItems.push(draggedItem);
            } else {
              const hoverIndex = dayItems.findIndex((id) => id === hoverId);
              if (hoverIndex === -1) return prev;
              dayItems.splice(hoverIndex, 0, draggedItem);
            }

            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: dayItems },
            };
          }
        });
      } else if (mode === 'edit' && targetColumn === 'candidate') {
        // 処理の補足です。
        setEventLists((prev) => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = currentEventDate;
          const executeIdsSet = new Set(
            executeModeItems[activeEventName]?.[currentEventDate] || [],
          );

          const candidateItems = allItems.filter(
            (item) => item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id),
          );

          if (selectedItemIds.has(dragId)) {
            // 処理の補足です。
            const selectedBlock = candidateItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = candidateItems.filter(
              (item) => !selectedItemIds.has(item.id),
            );

            let newCandidateList: ShoppingItem[] = [];

            if (isAppendToEnd) {
              newCandidateList = [...listWithoutSelection, ...selectedBlock];
            } else {
              const targetIndex = listWithoutSelection.findIndex((item) => item.id === hoverId);
              if (targetIndex === -1) return prev;
              listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
              newCandidateList = listWithoutSelection;
            }

            // 処理の補足です。

            const executeItems = allItems.filter(
              (item) => item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id),
            );

            const newItems = allItems.map((item) => {
              if (!item.eventDate.includes(currentTabKey)) {
                return item;
              }
              if (executeIdsSet.has(item.id)) {
                return executeItems.shift() || item;
              } else {
                return newCandidateList.shift() || item;
              }
            });

            return { ...prev, [activeEventName]: newItems };
          } else {
            // 処理の補足です。
            const dragIndex = candidateItems.findIndex((item) => item.id === dragId);
            if (dragIndex === -1) return prev;

            const [draggedItem] = candidateItems.splice(dragIndex, 1);

            if (isAppendToEnd) {
              candidateItems.push(draggedItem);
            } else {
              const hoverIndex = candidateItems.findIndex((item) => item.id === hoverId);
              if (hoverIndex === -1) return prev;
              candidateItems.splice(hoverIndex, 0, draggedItem);
            }

            // 蜀咲ｵ仙粋

            const executeItems = allItems.filter(
              (item) => item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id),
            );

            const newItems = allItems.map((item) => {
              if (!item.eventDate.includes(currentTabKey)) {
                return item;
              }
              if (executeIdsSet.has(item.id)) {
                return executeItems.shift() || item;
              } else {
                return candidateItems.shift() || item;
              }
            });

            return { ...prev, [activeEventName]: newItems };
          }
        });
      } else if (mode === 'execute') {
        // 処理の補足です。
        setEventLists((prev) => {
          const newItems = [...(prev[activeEventName] || [])];

          if (selectedItemIds.has(dragId)) {
            const selectedBlock = newItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = newItems.filter((item) => !selectedItemIds.has(item.id));

            if (isAppendToEnd) {
              return { ...prev, [activeEventName]: [...listWithoutSelection, ...selectedBlock] };
            }

            const targetIndex = listWithoutSelection.findIndex((item) => item.id === hoverId);
            if (targetIndex === -1) return prev;
            listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);

            return { ...prev, [activeEventName]: listWithoutSelection };
          } else {
            const dragIndex = newItems.findIndex((item) => item.id === dragId);
            if (dragIndex === -1) return prev;

            const [draggedItem] = newItems.splice(dragIndex, 1);

            if (isAppendToEnd) {
              newItems.push(draggedItem);
            } else {
              const hoverIndex = newItems.findIndex((item) => item.id === hoverId);
              if (hoverIndex === -1) return prev;
              newItems.splice(hoverIndex, 0, draggedItem);
            }
            return { ...prev, [activeEventName]: newItems };
          }
        });
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
      items,
    ],
  );
  const handleMoveItemUp = useCallback(
    (itemId: string, targetColumn?: 'execute' | 'candidate') => {
      if (!activeEventName) return;
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
      const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

      if (mode === 'edit' && targetColumn === 'execute') {
        // 処理の補足です。
        setExecuteModeItems((prev) => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];
          const currentIndex = dayItems.findIndex((id) => id === itemId);

          if (currentIndex <= 0) return prev; // 条件に合わないため状態は変更しません。
          // 処理の補足です。
          const targetId = dayItems[currentIndex - 1];
          if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
            return prev; // 条件に合わないため状態は変更しません。
          }

          // 処理の補足です。

          if (selectedItemIds.has(itemId)) {
            const selectedIds = dayItems.filter((id) => selectedItemIds.has(id));
            const listWithoutSelection = dayItems.filter((id) => !selectedItemIds.has(id));

            // 処理の補足です。

            const firstSelectedIndex = dayItems.findIndex((id) => selectedItemIds.has(id));
            if (firstSelectedIndex > 0) {
              // 処理の補足です。
              const targetIdForGroup = dayItems[firstSelectedIndex - 1];
              if (!areItemsInSameHall(selectedIds[0], targetIdForGroup, currentEventDate)) {
                return prev; // 条件に合わないため状態は変更しません。
              }
              const newTargetIndex = firstSelectedIndex - 1;
              listWithoutSelection.splice(newTargetIndex, 0, ...selectedIds);
              return {
                ...prev,
                [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection },
              };
            }
            return prev;
          } else {
            // 処理の補足です。
            [dayItems[currentIndex - 1], dayItems[currentIndex]] = [
              dayItems[currentIndex],
              dayItems[currentIndex - 1],
            ];
            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: dayItems },
            };
          }
        });
      } else if (mode === 'edit' && targetColumn === 'candidate') {
        // 処理の補足です。
        setEventLists((prev) => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = currentEventDate;
          const executeIdsSet = new Set(
            executeModeItems[activeEventName]?.[currentEventDate] || [],
          );

          // 処理の補足です。

          const candidateItems = allItems.filter(
            (item) => item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id),
          );

          const currentIndex = candidateItems.findIndex((item) => item.id === itemId);
          if (currentIndex <= 0) return prev; // 条件に合わないため状態は変更しません。
          if (selectedItemIds.has(itemId)) {
            // 処理の補足です。
            const selectedBlock = candidateItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = candidateItems.filter(
              (item) => !selectedItemIds.has(item.id),
            );
            const firstSelectedIndex = candidateItems.findIndex((item) =>
              selectedItemIds.has(item.id),
            );

            if (firstSelectedIndex > 0) {
              const newTargetIndex = firstSelectedIndex - 1;
              listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);

              // 処理の補足です。

              const executeItems = allItems.filter(
                (item) => item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id),
              );

              const newItems = allItems.map((item) => {
                if (!item.eventDate.includes(currentTabKey)) {
                  return item;
                }
                if (executeIdsSet.has(item.id)) {
                  return executeItems.shift() || item;
                } else {
                  return listWithoutSelection.shift() || item;
                }
              });

              return { ...prev, [activeEventName]: newItems };
            }
            return prev;
          } else {
            // 処理の補足です。
            [candidateItems[currentIndex - 1], candidateItems[currentIndex]] = [
              candidateItems[currentIndex],
              candidateItems[currentIndex - 1],
            ];

            // 処理の補足です。

            const executeItems = allItems.filter(
              (item) => item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id),
            );

            const newItems = allItems.map((item) => {
              if (!item.eventDate.includes(currentTabKey)) {
                return item;
              }
              if (executeIdsSet.has(item.id)) {
                return executeItems.shift() || item;
              } else {
                return candidateItems.shift() || item;
              }
            });

            return { ...prev, [activeEventName]: newItems };
          }
        });
      } else if (mode === 'execute') {
        // 処理の補足です。
        setEventLists((prev) => {
          const newItems = [...(prev[activeEventName] || [])];
          const currentIndex = newItems.findIndex((item) => item.id === itemId);

          if (currentIndex <= 0) return prev; // 条件に合わないため状態は変更しません。
          if (selectedItemIds.has(itemId)) {
            const selectedBlock = newItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = newItems.filter((item) => !selectedItemIds.has(item.id));
            const firstSelectedIndex = newItems.findIndex((item) => selectedItemIds.has(item.id));

            if (firstSelectedIndex > 0) {
              const newTargetIndex = firstSelectedIndex - 1;
              listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);
              return { ...prev, [activeEventName]: listWithoutSelection };
            }
            return prev;
          } else {
            [newItems[currentIndex - 1], newItems[currentIndex]] = [
              newItems[currentIndex],
              newItems[currentIndex - 1],
            ];
            return { ...prev, [activeEventName]: newItems };
          }
        });
      }
    },
    [
      activeEventName,
      selectedItemIds,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      areItemsInSameHall,
    ],
  );

  const handleMoveItemDown = useCallback(
    (itemId: string, targetColumn?: 'execute' | 'candidate') => {
      if (!activeEventName) return;
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
      const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

      if (mode === 'edit' && targetColumn === 'execute') {
        // 処理の補足です。
        setExecuteModeItems((prev) => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];
          const currentIndex = dayItems.findIndex((id) => id === itemId);

          if (currentIndex < 0 || currentIndex >= dayItems.length - 1) return prev; // 条件に合わないため状態は変更しません。
          // 処理の補足です。
          const targetId = dayItems[currentIndex + 1];
          if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
            return prev; // 条件に合わないため状態は変更しません。
          }

          // 処理の補足です。

          if (selectedItemIds.has(itemId)) {
            const selectedIds = dayItems.filter((id) => selectedItemIds.has(id));
            const listWithoutSelection = dayItems.filter((id) => !selectedItemIds.has(id));

            // 処理の補足です。

            let lastSelectedIndex = -1;
            dayItems.forEach((id, index) => {
              if (selectedItemIds.has(id)) lastSelectedIndex = index;
            });

            // 処理の補足です。

            if (lastSelectedIndex >= 0 && lastSelectedIndex < dayItems.length - 1) {
              // 処理の補足です。
              const jumpOverItemId = dayItems[lastSelectedIndex + 1];

              // 処理の補足です。

              if (
                !areItemsInSameHall(
                  selectedIds[selectedIds.length - 1],
                  jumpOverItemId,
                  currentEventDate,
                )
              ) {
                return prev; // 条件に合わないため状態は変更しません。
              }

              // 処理の補足です。

              const targetIndexInListWithout = listWithoutSelection.findIndex(
                (id) => id === jumpOverItemId,
              );

              if (targetIndexInListWithout !== -1) {
                // 処理の補足です。
                listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedIds);
                return {
                  ...prev,
                  [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection },
                };
              }
            }
            return prev;
          } else {
            // 処理の補足です。
            [dayItems[currentIndex], dayItems[currentIndex + 1]] = [
              dayItems[currentIndex + 1],
              dayItems[currentIndex],
            ];
            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: dayItems },
            };
          }
        });
      } else if (mode === 'edit' && targetColumn === 'candidate') {
        // 処理の補足です。
        setEventLists((prev) => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = currentEventDate;
          const executeIdsSet = new Set(
            executeModeItems[activeEventName]?.[currentEventDate] || [],
          );

          // 処理の補足です。

          const candidateItems = allItems.filter(
            (item) => item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id),
          );

          const currentIndex = candidateItems.findIndex((item) => item.id === itemId);
          if (currentIndex < 0 || currentIndex >= candidateItems.length - 1) return prev; // 条件に合わないため状態は変更しません。
          if (selectedItemIds.has(itemId)) {
            // 処理の補足です。
            const selectedBlock = candidateItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = candidateItems.filter(
              (item) => !selectedItemIds.has(item.id),
            );

            // 処理の補足です。

            let lastSelectedIndex = -1;
            candidateItems.forEach((item, index) => {
              if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
            });

            // 処理の補足です。

            if (lastSelectedIndex >= 0 && lastSelectedIndex < candidateItems.length - 1) {
              const jumpOverItemId = candidateItems[lastSelectedIndex + 1].id;
              const targetIndexInListWithout = listWithoutSelection.findIndex(
                (item) => item.id === jumpOverItemId,
              );

              if (targetIndexInListWithout !== -1) {
                listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);

                // 処理の補足です。

                const executeItems = allItems.filter(
                  (item) => item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id),
                );

                const newItems = allItems.map((item) => {
                  if (!item.eventDate.includes(currentTabKey)) {
                    return item;
                  }
                  if (executeIdsSet.has(item.id)) {
                    return executeItems.shift() || item;
                  } else {
                    return listWithoutSelection.shift() || item;
                  }
                });

                return { ...prev, [activeEventName]: newItems };
              }
            }
            return prev;
          } else {
            // 処理の補足です。
            [candidateItems[currentIndex], candidateItems[currentIndex + 1]] = [
              candidateItems[currentIndex + 1],
              candidateItems[currentIndex],
            ];

            // 処理の補足です。

            const executeItems = allItems.filter(
              (item) => item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id),
            );

            const newItems = allItems.map((item) => {
              if (!item.eventDate.includes(currentTabKey)) {
                return item;
              }
              if (executeIdsSet.has(item.id)) {
                return executeItems.shift() || item;
              } else {
                return candidateItems.shift() || item;
              }
            });

            return { ...prev, [activeEventName]: newItems };
          }
        });
      } else if (mode === 'execute') {
        // 処理の補足です。
        setEventLists((prev) => {
          const newItems = [...(prev[activeEventName] || [])];
          const currentIndex = newItems.findIndex((item) => item.id === itemId);

          if (currentIndex < 0 || currentIndex >= newItems.length - 1) return prev; // 条件に合わないため状態は変更しません。
          if (selectedItemIds.has(itemId)) {
            const selectedBlock = newItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = newItems.filter((item) => !selectedItemIds.has(item.id));

            // 処理の補足です。

            let lastSelectedIndex = -1;
            newItems.forEach((item, index) => {
              if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
            });

            // 処理の補足です。

            if (lastSelectedIndex >= 0 && lastSelectedIndex < newItems.length - 1) {
              const jumpOverItemId = newItems[lastSelectedIndex + 1].id;
              const targetIndexInListWithout = listWithoutSelection.findIndex(
                (item) => item.id === jumpOverItemId,
              );

              if (targetIndexInListWithout !== -1) {
                listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);
                return { ...prev, [activeEventName]: listWithoutSelection };
              }
            }
            return prev;
          } else {
            [newItems[currentIndex], newItems[currentIndex + 1]] = [
              newItems[currentIndex + 1],
              newItems[currentIndex],
            ];
            return { ...prev, [activeEventName]: newItems };
          }
        });
      }
    },
    [
      activeEventName,
      selectedItemIds,
      activeTab,
      dayModes,
      executeModeItems,
      eventDates,
      areItemsInSameHall,
    ],
  );

  const handleMoveToExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;

      // 処理の補足です。

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

      // 処理の補足です。

      const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

      // 処理の補足です。

      if (
        rangeStart &&
        itemIds.includes(rangeStart.itemId) &&
        rangeStart.columnType === 'candidate'
      ) {
        setRangeStart(null);
        setRangeEnd(null);
      } else if (
        rangeEnd &&
        itemIds.includes(rangeEnd.itemId) &&
        rangeEnd.columnType === 'candidate'
      ) {
        setRangeEnd(null);
      }

      // 処理の補足です。

      const currentTabItemsForMove = items.filter((item) => item.eventDate === currentEventDate);

      // 処理の補足です。

      let candidateItems = currentTabItemsForMove.filter((item) => !executeIdsSet.has(item.id));

      // 処理の補足です。

      if (selectedBlockFilters.size > 0) {
        candidateItems = candidateItems.filter((item) => selectedBlockFilters.has(item.block));
      }

      // 処理の補足です。

      const itemIdsSet = new Set(itemIds);
      const itemsToMove = candidateItems.filter((item) => itemIdsSet.has(item.id));
      const orderedItemIds = itemsToMove.map((item) => item.id);

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const currentDayItems = [...(eventItems[currentEventDate] || [])];

        // 処理の補足です。

        const existingIdsSet = new Set(currentDayItems);
        const newItemIds = orderedItemIds.filter((id) => !existingIdsSet.has(id));

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [currentEventDate]: [...currentDayItems, ...newItemIds],
          },
        };
      });

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
    ],
  );
  const handleRemoveFromExecuteColumn = useCallback(
    (itemIds: string[]) => {
      if (!activeEventName) return;

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

      // 処理の補足です。

      if (
        rangeStart &&
        itemIds.includes(rangeStart.itemId) &&
        rangeStart.columnType === 'execute'
      ) {
        setRangeStart(null);
        setRangeEnd(null);
      } else if (
        rangeEnd &&
        itemIds.includes(rangeEnd.itemId) &&
        rangeEnd.columnType === 'execute'
      ) {
        setRangeEnd(null);
      }

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const currentDayItems = (eventItems[currentEventDate] || []).filter(
          (id) => !itemIds.includes(id),
        );

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [currentEventDate]: currentDayItems,
          },
        };
      });

      setSelectedItemIds(new Set());
    },
    [activeEventName, activeTab, eventDates, rangeStart, rangeEnd],
  );

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;

    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const currentModeValue = dayModes[activeEventName]?.[currentEventDate] || 'edit';
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

  // 処理の補足です。

  const handleSetViewMode = useCallback(
    (mode: ViewMode, scrollToItemId?: string) => {
      if (!activeEventName) return;

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

      setDayModes((prev) => ({
        ...prev,
        [activeEventName]: {
          ...(prev[activeEventName] || {}),
          [currentEventDate]: mode,
        },
      }));

      setSelectedItemIds(new Set());
      setCandidateNumberSortDirection(null);

      // 処理の補足です。

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
      // 処理の補足です。
      setUiVisibilityOverride(false);
      setUiSettingsPanelOpen(false);

      // 処理の補足です。

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
      setActiveEventName(eventName);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());
      const eventItems = eventLists[eventName] || [];
      setActiveTab(resolveEventListTab(eventItems));
    },
    [eventLists],
  );

  const handleDeleteEvent = useCallback(
    (eventName: string) => {
      setEventLists((prev) => removeRecordKey(prev, eventName));
      setEventMetadata((prev) => removeRecordKey(prev, eventName));
      setExecuteModeItems((prev) => removeRecordKey(prev, eventName));
      setDayModes((prev) => removeRecordKey(prev, eventName));
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

      // 処理の補足です。

      setMapData((prev) => renameRecordKey(prev, eventToRename, newName));

      // 処理の補足です。

      setRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));

      // 処理の補足です。

      setHallDefinitions((prev) => renameRecordKey(prev, eventToRename, newName));

      // 処理の補足です。

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
    // 処理の補足です。
    setRecentlyChangedItemIds(new Set());
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

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
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

      // 処理の補足です。

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

      // 処理の補足です。

      const executeItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && executeIds.has(item.id),
      );

      // 処理の補足です。

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

  const handleDeleteRequest = (item: ShoppingItem) => {
    setItemToDelete(item);
  };

  const handleConfirmDelete = () => {
    if (!itemToDelete || !activeEventName) return;

    const deletedId = itemToDelete.id;

    setEventLists((prev) => ({
      ...prev,
      [activeEventName]: prev[activeEventName].filter((item) => item.id !== deletedId),
    }));

    // 処理の補足です。

    setExecuteModeItems((prev) => {
      const eventItems = prev[activeEventName];
      if (!eventItems) return prev;

      const updatedEventItems: ExecuteModeItems = {};
      Object.keys(eventItems).forEach((eventDate) => {
        updatedEventItems[eventDate] = eventItems[eventDate].filter((id) => id !== deletedId);
      });

      return {
        ...prev,
        [activeEventName]: updatedEventItems,
      };
    });

    setItemToDelete(null);
  };

  const handleDoneEditing = () => {
    if (itemToEdit?.eventDate) {
      setItemToEdit(null);
      setActiveTab(itemToEdit.eventDate);
    } else {
      setItemToEdit(null);
      if (eventDates.length > 0) {
        setActiveTab(eventDates[0]);
      }
    }
  };

  const handleSelectItem = useCallback(
    (itemId: string, columnType?: 'execute' | 'candidate') => {
      setSortState('Manual');
      setBlockSortDirection(null);

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
      const currentColumnType =
        columnType ||
        (activeEventName
          ? executeModeItems[activeEventName]?.[currentEventDate]?.includes(itemId)
            ? 'execute'
            : 'candidate'
          : 'execute');

      // 処理の補足です。

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
          // 処理の補足です。
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
          // 処理の補足です。
          if (rangeStart?.itemId === itemId && rangeStart.columnType === currentColumnType) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (rangeEnd?.itemId === itemId && rangeEnd.columnType === currentColumnType) {
            setRangeEnd(null);
          }
        } else {
          newSet.add(itemId);

          // 処理の補足です。

          if (!rangeStart || rangeStart.columnType !== currentColumnType) {
            setRangeStart({ itemId, columnType: currentColumnType });
            setRangeEnd(null);
          } else {
            // 処理の補足です。
            const startIndex = currentItems.findIndex((item) => item.id === rangeStart.itemId);
            const currentIndex = currentItems.findIndex((item) => item.id === itemId);

            // 処理の補足です。

            if (startIndex !== -1 && currentIndex !== -1) {
              const isAdjacent = Math.abs(startIndex - currentIndex) === 1;
              if (!isAdjacent) {
                setRangeEnd({ itemId, columnType: currentColumnType });
              } else {
                // 処理の補足です。
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

  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<
    'asc' | 'desc' | null
  >(null);

  const handleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;

    const nextDirection = candidateNumberSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

    setEventLists((prev) => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

      // 処理の補足です。

      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );

      // 処理の補足です。

      let filteredCandidateItems = candidateItems;
      if (selectedBlockFilters.size > 0) {
        filteredCandidateItems = candidateItems.filter((item) =>
          selectedBlockFilters.has(item.block),
        );
      }

      if (filteredCandidateItems.length === 0) return prev;

      // 処理の補足です。

      const sortedCandidateItems = [...filteredCandidateItems].sort((a, b) => {
        const comparison = a.number.localeCompare(b.number, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      // 処理の補足です。

      const sortedCandidateMap = new Map(
        sortedCandidateItems.map((item, index) => [item.id, { item, sortIndex: index }]),
      );

      // 処理の補足です。

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

      // 処理の補足です。
      candidateItemsToSort.sort((a, b) => a.sortIndex - b.sortIndex);

      // 処理の補足です。

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

  // 処理の補足です。

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

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

      // 処理の補足です。

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
        // 処理の補足です。
        if (selectedBlockFilters.size > 0) {
          filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
        }
        currentItems = filtered;
      }

      // 処理の補足です。

      const halls = getHallsForDate(currentEventDate);
      const currentMapData = getMapDataForDate(currentEventDate);

      // 処理の補足です。

      if (halls.length > 0 && currentMapData) {
        // 処理の補足です。
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

          // 処理の補足です。

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

        // 処理の補足です。

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

        // 処理の補足です。

        const startItem = currentItems.find((item) => item.id === rangeStart.itemId);
        const endItem = currentItems.find((item) => item.id === rangeEnd.itemId);

        if (!startItem || !endItem) return;

        const startGroupId = getItemGroupId(startItem);
        const endGroupId = getItemGroupId(endItem);

        // 処理の補足です。

        if (startGroupId !== endGroupId) {
          return;
        }

        // 処理の補足です。

        const groupItems = currentItems.filter((item) => getItemGroupId(item) === startGroupId);

        const startIndex = groupItems.findIndex((item) => item.id === rangeStart.itemId);
        const endIndex = groupItems.findIndex((item) => item.id === rangeEnd.itemId);

        if (startIndex === -1 || endIndex === -1) return;

        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);
        const rangeItems = groupItems.slice(minIndex, maxIndex + 1);

        // 処理の補足です。

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

      // 処理の補足です。

      const startIndex = currentItems.findIndex((item) => item.id === rangeStart.itemId);
      const endIndex = currentItems.findIndex((item) => item.id === rangeEnd.itemId);

      if (startIndex === -1 || endIndex === -1) return;

      const minIndex = Math.min(startIndex, endIndex);
      const maxIndex = Math.max(startIndex, endIndex);
      const rangeItems = currentItems.slice(minIndex, maxIndex + 1);

      // 処理の補足です。

      setSelectedItemIds((prev) => {
        const allSelected = rangeItems.every((item) => prev.has(item.id));
        const newSet = new Set(prev);
        if (allSelected) {
          // 処理の補足です。
          // 処理の補足です。
          rangeItems.forEach((item) => newSet.delete(item.id));
          setRangeStart(null);
          setRangeEnd(null);
        } else {
          // 処理の補足です。
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
      getHallsForDate,
      getMapDataForDate,
    ],
  );

  const handleBulkSort = useCallback(
    (direction: BulkSortDirection) => {
      if (!activeEventName || selectedItemIds.size === 0) return;
      setSortState('Manual');
      setBlockSortDirection(null);
      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
      const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

      if (mode === 'edit') {
        // 処理の補足です。
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
        const isInExecuteColumn = selectedItems.some((item) => executeIds.has(item.id));
        const isInCandidateColumn = selectedItems.some((item) => !executeIds.has(item.id));

        if (isInExecuteColumn && !isInCandidateColumn) {
          // 処理の補足です。
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
          // 処理の補足です。
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

            // 処理の補足です。

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
        // 処理の補足です。
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

  // 処理の補足です。

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

  // 処理の補足です。

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

  // 処理の補足です。

  const handleExportFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // 処理の補足です。
      e.target.value = '';

      try {
        const result = await importFromXlsx(file);

        if (!result.success) {
          alert(`インポートに失敗しました:\n${result.errors.join('\n')}`);
          return;
        }

        if (result.items.length === 0) {
          alert('取り込んだファイルにアイテムが見つかりませんでした。');
          return;
        }

        // 処理の補足です。
        const importedData = toImportedEventData(result);
        const eventName = importedData.eventName;
        const isUpdate = !!eventLists[eventName];

        // 処理の補足です。

        setEventLists((prev) => upsertRecordKey(prev, eventName, importedData.items));

        // 処理の補足です。

        if (importedData.metadata) {
          const metadata = importedData.metadata;
          setEventMetadata((prev) => upsertRecordKey(prev, eventName, metadata));
        }

        // 処理の補足です。

        if (importedData.executeModeItems) {
          const executeItems = importedData.executeModeItems;
          setExecuteModeItems((prev) => upsertRecordKey(prev, eventName, executeItems));
        }
        if (importedData.dayModes) {
          const importedDayModes = importedData.dayModes;
          setDayModes((prev) => upsertRecordKey(prev, eventName, importedDayModes));
        }

        // 処理の補足です。

        if (importedData.mapData) {
          const importedMapData = importedData.mapData;
          setMapData((prev) => upsertRecordKey(prev, eventName, importedMapData));
        }

        // 処理の補足です。

        if (importedData.routeSettings) {
          const importedRouteSettings = importedData.routeSettings;
          setRouteSettings((prev) => upsertRecordKey(prev, eventName, importedRouteSettings));
        }

        // 処理の補足です。

        if (importedData.hallDefinitions) {
          const importedHallDefinitions = importedData.hallDefinitions;
          setHallDefinitions((prev) => upsertRecordKey(prev, eventName, importedHallDefinitions));
        }

        // 処理の補足です。

        if (importedData.hallRouteSettings) {
          const importedHallRouteSettings = importedData.hallRouteSettings;
          setHallRouteSettings((prev) =>
            upsertRecordKey(prev, eventName, importedHallRouteSettings),
          );
        }

        // 処理の補足です。

        alert(
          buildImportCompletionMessage({
            errors: importedData.errors,
            eventName,
            isUpdate,
            itemCount: importedData.items.length,
          }),
        );

        // 処理の補足です。

        setActiveEventName(eventName);
        setActiveTab(resolveEventListTab(importedData.items));
      } catch (error) {
        console.error('Import error:', error);
        alert('アイテムの取り込みに失敗しました。ファイル形式を確認してください。');
      }
    },
    [eventLists],
  );

  // 処理の補足です。

  const handleUpdateEvent = useCallback(
    async (eventName: string, urlOverride?: { url: string; sheetName: string }) => {
      const metadata = eventMetadata[eventName];
      const source = resolveSpreadsheetSource(metadata, urlOverride);

      if (!source) {
        alert('先にスプレッドシートURLを設定してください。');
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

    // 処理の補足です。

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
      if (pendingUpdateEventName) {
        handleUpdateEvent(pendingUpdateEventName, { url: newUrl, sheetName });
        setPendingUpdateEventName(null);
      }
    },
    [pendingUpdateEventName, handleUpdateEvent],
  );

  // 処理の補足です。

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

    // 処理の補足です。

    setMapImportPendingFile(file);
    setMapImportPendingEventName(eventName);
    setMapImportDialogOpen(true);

    // 処理の補足です。
    e.target.value = '';
  }, []);

  // 処理の補足です。

  const handleMapImportConfirm = useCallback(
    (parsedData: Record<string, DayMapData>, settings: BlockDetectionSettings) => {
      const eventName = mapImportPendingEventName;
      if (!eventName) return;

      // 処理の補足です。
      saveBlockDetectionSettings(eventName, settings);

      // 処理の補足です。

      setMapData((prev) => ({
        ...prev,
        [eventName]: {
          ...(prev[eventName] || {}),
          ...parsedData,
        },
      }));

      const mapCount = Object.keys(parsedData).length;

      // 処理の補足です。

      const firstMapName = Object.keys(parsedData)[0];
      if (firstMapName) {
        setActiveTab(firstMapName);
      }

      // 処理の補足です。

      setMapImportDialogOpen(false);
      setMapImportPendingFile(null);
      setMapImportPendingEventName('');

      alert(`${mapCount}件のマップタブを取り込みました。`);
    },
    [mapImportPendingEventName],
  );

  // 処理の補足です。

  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
  }, []);

  // 処理の補足です。

  const handleAddToExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      // 処理の補足です。

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      // 処理の補足です。

      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      // 処理の補足です。

      const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[activeTab] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      // 処理の補足です。

      const currentMapData = mapData[activeEventName]?.[activeTab];
      let itemHallId: string | null = null;

      if (currentMapData && halls.length > 0) {
        const itemBlockName = item.block?.trim() || '';
        const block = currentMapData.blocks.find((b) => b.name === itemBlockName);

        if (block) {
          const centerRow = (block.startRow + block.endRow) / 2;
          const centerCol = (block.startCol + block.endCol) / 2;

          for (const hall of halls) {
            if (
              hall.vertices.length >= 4 &&
              isPointInPolygon(centerRow, centerCol, hall.vertices)
            ) {
              itemHallId = hall.id;
              break;
            }
          }
        }
      }

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];

        // 処理の補足です。

        if (dayItems.includes(itemId)) return prev;

        // 処理の補足です。

        if (!itemHallId || halls.length === 0) {
          dayItems.push(itemId);
          return {
            ...prev,
            [activeEventName]: {
              ...eventItems,
              [dayName]: dayItems,
            },
          };
        }

        // 処理の補足です。

        const hallOrder =
          hallRouteSettingsForMap.hallOrder.length > 0
            ? hallRouteSettingsForMap.hallOrder
            : halls.map((h) => h.id);

        // 処理の補足です。

        const itemsMap = new Map(items.map((i) => [i.id, i]));
        const getHallIdForItem = (id: string): string | null => {
          const targetItem = itemsMap.get(id);
          if (!targetItem || !currentMapData) return null;

          const blockName = targetItem.block?.trim() || '';
          const targetBlock = currentMapData.blocks.find((b) => b.name === blockName);
          if (!targetBlock) return null;

          const cRow = (targetBlock.startRow + targetBlock.endRow) / 2;
          const cCol = (targetBlock.startCol + targetBlock.endCol) / 2;

          for (const hall of halls) {
            if (hall.vertices.length >= 4 && isPointInPolygon(cRow, cCol, hall.vertices)) {
              return hall.id;
            }
          }
          return null;
        };

        // 処理の補足です。

        let insertIndex = dayItems.length; // 処理の補足です。
        const itemHallIndex = hallOrder.indexOf(itemHallId);

        if (itemHallIndex >= 0) {
          // 処理の補足です。
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
            // 処理の補足です。
            insertIndex = lastSameHallIndex + 1;
          } else if (firstLaterHallIndex >= 0) {
            // 処理の補足です。
            insertIndex = firstLaterHallIndex;
          }
        }

        dayItems.splice(insertIndex, 0, itemId);

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: dayItems,
          },
        };
      });
    },
    [activeEventName, activeTab, isMapTab, items, hallDefinitions, hallRouteSettings, mapData],
  );

  // 処理の補足です。

  const handleAddToExecuteListFromMapAtPosition = useCallback(
    (itemId: string, referenceItemId: string, position: 'before' | 'after') => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];

        // 処理の補足です。

        if (dayItems.includes(itemId)) return prev;

        // 処理の補足です。

        const refIndex = dayItems.indexOf(referenceItemId);
        if (refIndex < 0) {
          // 処理の補足です。
          dayItems.push(itemId);
        } else {
          const insertIndex = position === 'before' ? refIndex : refIndex + 1;
          dayItems.splice(insertIndex, 0, itemId);
        }

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: dayItems,
          },
        };
      });
    },
    [activeEventName, activeTab, isMapTab],
  );

  // 処理の補足です。

  const handleRemoveFromExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      // 処理の補足です。

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = (eventItems[dayName] || []).filter((id) => id !== itemId);

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: dayItems,
          },
        };
      });
    },
    [activeEventName, activeTab, isMapTab],
  );

  // 処理の補足です。

  const handleAddNewItemFromMap = useCallback(
    (eventDate: string, block: string, number: string) => {
      // 処理の補足です。
      setNewItemDefaults({ eventDate, block, number });
      setItemToEdit(null);
      setActiveTab('import');
    },
    [],
  );

  // 処理の補足です。

  const handleAddItemFromFocusMode = useCallback(
    (newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => {
      if (!activeEventName) return;

      // 処理の補足です。

      const purchaseStatus = newItem.purchaseStatus || 'None';

      // 処理の補足です。

      const item: ShoppingItem = {
        ...newItem,
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        purchaseStatus,
        source: 'app' as const, // アプリ側で生成したデータとして扱います。
        protectionLevel: 'full' as const, // 完全保護レベルで設定します。
      };

      // 処理の補足です。

      setEventLists((prev) => ({
        ...prev,
        [activeEventName]: [...(prev[activeEventName] || []), item],
      }));

      // 処理の補足です。

      if (purchaseStatus === 'Purchased') {
        return;
      }

      // 処理の補足です。

      const dayName = newItem.eventDate;
      const mapTab = getMapTabForDate(dayName);

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];
        const allItems = eventLists[activeEventName] || [];
        const itemsMap = new Map(allItems.map((i) => [i.id, i]));
        itemsMap.set(item.id, item); // 新しいアイテムをマップに登録します。

        // 処理の補足です。

        const currentMapData = mapData[activeEventName]?.[mapTab];
        const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
        const hallSettings = hallRouteSettings[activeEventName]?.[mapTab];

        // 処理の補足です。

        const hallOrder = hallSettings?.hallOrder || halls.map((h) => h.id);

        // 処理の補足です。

        const getItemPosition = (id: string): { row: number; col: number } | null => {
          const targetItem = itemsMap.get(id);
          if (!targetItem || !currentMapData) return null;

          const blockName = targetItem.block?.trim() || '';
          const targetBlock = currentMapData.blocks.find((b) => b.name === blockName);
          if (!targetBlock) return null;

          // 処理の補足です。

          const numberCells = targetBlock.numberCells || [];
          const normalizedNumber = targetItem.number.toLowerCase();

          for (const nc of numberCells) {
            if (String(nc.value).toLowerCase() === normalizedNumber) {
              return { row: nc.row, col: nc.col };
            }
          }

          // 処理の補足です。

          return {
            row: (targetBlock.startRow + targetBlock.endRow) / 2,
            col: (targetBlock.startCol + targetBlock.endCol) / 2,
          };
        };

        // 処理の補足です。

        const calcDistance = (
          pos1: { row: number; col: number },
          pos2: { row: number; col: number },
        ): number => {
          return Math.abs(pos1.row - pos2.row) + Math.abs(pos1.col - pos2.col);
        };

        // 処理の補足です。

        const phaseStatus = purchaseStatus; // 'Postpone' or 'Late'
        const samePhaseIndices: number[] = [];

        for (let i = 0; i < dayItems.length; i++) {
          const existingItem = itemsMap.get(dayItems[i]);
          if (existingItem && existingItem.purchaseStatus === phaseStatus) {
            samePhaseIndices.push(i);
          }
        }

        // 処理の補足です。

        const newItemPos = getItemPosition(item.id);

        if (samePhaseIndices.length === 0 || !newItemPos) {
          // 処理の補足です。
          dayItems.push(item.id);
        } else {
          // 処理の補足です。
          let bestInsertIndex = samePhaseIndices[samePhaseIndices.length - 1] + 1;
          let minTotalDistance = Infinity;

          // 処理の補足です。

          for (let insertIdx = 0; insertIdx <= samePhaseIndices.length; insertIdx++) {
            let totalDistance = 0;

            // 処理の補足です。

            if (insertIdx > 0) {
              const prevItemId = dayItems[samePhaseIndices[insertIdx - 1]];
              const prevPos = getItemPosition(prevItemId);
              if (prevPos) {
                totalDistance += calcDistance(prevPos, newItemPos);
              }
            }

            // 処理の補足です。

            if (insertIdx < samePhaseIndices.length) {
              const nextItemId = dayItems[samePhaseIndices[insertIdx]];
              const nextPos = getItemPosition(nextItemId);
              if (nextPos) {
                totalDistance += calcDistance(newItemPos, nextPos);
              }

              // 処理の補足です。

              if (insertIdx > 0) {
                const prevItemId = dayItems[samePhaseIndices[insertIdx - 1]];
                const prevPos = getItemPosition(prevItemId);
                if (prevPos && nextPos) {
                  totalDistance -= calcDistance(prevPos, nextPos);
                }
              }
            }

            if (totalDistance < minTotalDistance) {
              minTotalDistance = totalDistance;
              // 処理の補足です。
              if (insertIdx === 0) {
                bestInsertIndex = samePhaseIndices[0];
              } else if (insertIdx === samePhaseIndices.length) {
                bestInsertIndex = samePhaseIndices[samePhaseIndices.length - 1] + 1;
              } else {
                bestInsertIndex = samePhaseIndices[insertIdx];
              }
            }
          }

          dayItems.splice(bestInsertIndex, 0, item.id);
        }

        return {
          ...prev,
          [activeEventName]: {
            ...eventItems,
            [dayName]: dayItems,
          },
        };
      });
    },
    [activeEventName, eventLists, mapData, hallDefinitions, hallRouteSettings, getMapTabForDate],
  );

  // 処理の補足です。

  const handleMoveToFirstFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

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
    [activeEventName, activeTab, isMapTab],
  );

  // 処理の補足です。

  const handleMoveToLastFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

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
    [activeEventName, activeTab, isMapTab],
  );

  // 処理の補足です。

  const currentMapExecuteItemIds = useMemo(() => {
    if (!activeEventName || !isMapTab) return [];

    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    return executeModeItems[activeEventName]?.[dayName] || [];
  }, [activeEventName, activeTab, isMapTab, executeModeItems]);

  // 処理の補足です。

  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter((item) => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

  // 処理の補足です。

  const [mapTabMenuOpen, setMapTabMenuOpen] = useState<string | null>(null);
  const [mapTabMenuPosition, setMapTabMenuPosition] = useState<{ left: number; top: number }>({
    left: 0,
    top: 0,
  });
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

  // 処理の補足です。

  const [mapSelectedHallId, setMapSelectedHallId] = useState<string>('all');
  const [mapIsRouteVisible, setMapIsRouteVisible] = useState(true);
  const [mapIsHallOrderOpen, setMapIsHallOrderOpen] = useState(false);
  const [mapHallSelectorOpen, setMapHallSelectorOpen] = useState(false);
  const [mapSmartInsertEnabled, setMapSmartInsertEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertEnabled');
      return saved !== null ? saved === 'true' : true; // 処理の補足です。
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
  const smartInsertLongPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const smartInsertLongPressTriggeredRef = React.useRef(false);

  // 処理の補足です。

  React.useEffect(() => {
    try {
      localStorage.setItem('mapSmartInsertEnabled', String(mapSmartInsertEnabled));
    } catch {}
  }, [mapSmartInsertEnabled]);

  React.useEffect(() => {
    try {
      localStorage.setItem('mapSmartInsertMode', mapSmartInsertMode);
    } catch {}
  }, [mapSmartInsertMode]);

  // 処理の補足です。

  React.useEffect(() => {
    if (smartInsertToast) {
      const timer = setTimeout(() => setSmartInsertToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [smartInsertToast]);

  // 処理の補足です。

  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
    clickedCells: { row: number; col: number }[];
    editingBlockData?: unknown;
  } | null>(null);

  // 処理の補足です。

  const [pendingCellSelection, setPendingCellSelection] = useState<{
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // 処理の補足です。

  const openVisitListPanel = useCallback(
    (mapTab: string) => {
      if (!activeEventName) return;

      // 処理の補足です。

      const dayMatch = mapTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      // 処理の補足です。

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      // 処理の補足です。

      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(mapTab);
      setVisitListHasUnsavedChanges(false);
      setVisitListPanelOpen(true);
    },
    [activeEventName, executeModeItems],
  );

  // 処理の補足です。

  React.useEffect(() => {
    if (!visitListPanelOpen || !isMapTab || !activeEventName) return;
    // 処理の補足です。
    if (visitListPanelMapTab !== activeTab) {
      // 処理の補足です。
      if (visitListHasUnsavedChanges) {
        setVisitListHasUnsavedChanges(false);
      }
      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];
      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(activeTab);
      setVisitListHasUnsavedChanges(false);
    }
  }, [
    activeTab,
    isMapTab,
    activeEventName,
    visitListPanelOpen,
    visitListPanelMapTab,
    visitListHasUnsavedChanges,
    executeModeItems,
  ]);

  // 処理の補足です。

  const handleVisitListOrderUpdate = useCallback(
    (newOrderItems: ShoppingItem[]) => {
      if (!visitListPanelMapTab || !activeEventName) return;

      const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      // 処理の補足です。

      const newIds = newOrderItems.map((item) => item.id);

      // executeModeItems繧呈峩譁ｰ

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

  // 処理の補足です。

  const handleVisitListConfirm = useCallback(() => {
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, []);

  // 処理の補足です。

  const handleVisitListCancel = useCallback(() => {
    if (!visitListPanelMapTab || !activeEventName) return;

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];

    // 処理の補足です。

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

  // 処理の補足です。

  const handleVisitListClose = useCallback(() => {
    setVisitListPanelOpen(false);
    // 処理の補足です。
  }, []);

  // 処理の補足です。

  const handleHighlightMapCell = useCallback((row: number, col: number) => {
    setHighlightedMapCell({ row, col });
  }, []);

  const handleClearMapCellHighlight = useCallback(() => {
    setHighlightedMapCell(null);
  }, []);

  // 処理の補足です。

  const visitListItems = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    const dayItems = items.filter((item) => item.eventDate === dayName);
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

    // 処理の補足です。

    return executeIds
      .filter((id: string) => dayItems.some((item) => item.id === id))
      .map((id: string) => dayItems.find((item) => item.id === id)!)
      .filter(Boolean);
  }, [visitListPanelMapTab, activeEventName, items, executeModeItems]);

  // 処理の補足です。

  const visitListHallOrder = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const routeSettings = hallRouteSettings[activeEventName]?.[visitListPanelMapTab];

    if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
      return routeSettings.hallOrder;
    }

    // 処理の補足です。

    return halls.map((h) => h.id);
  }, [visitListPanelMapTab, activeEventName, hallDefinitions, hallRouteSettings]);

  // 処理の補足です。

  const handleUpdateItemPriority = useCallback(
    (itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
      if (!activeEventName || !visitListPanelMapTab) return;

      // 処理の補足です。

      setEventLists((prev) => ({
        ...prev,
        [activeEventName]: (prev[activeEventName] || []).map((item) =>
          item.id === itemId ? { ...item, priorityLevel } : item,
        ),
      }));

      // 処理の補足です。

      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
      const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];

      // 処理の補足です。

      let itemHallId: string | null = null;
      if (mapDataForTab) {
        const block = mapDataForTab.blocks.find((b) => b.name === item.block);
        if (block) {
          const numMatch = item.number?.match(/\d+/);
          if (numMatch) {
            const num = parseInt(numMatch[0], 10);
            const cell = block.numberCells.find((nc) => nc.value === num);
            if (cell) {
              for (const hall of halls) {
                // 処理の補足です。
                const isPointInPolygon = (
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

                if (isPointInPolygon(cell.row, cell.col, hall.vertices)) {
                  itemHallId = hall.id;
                  break;
                }
                // 処理の補足です。
                for (const vertex of hall.vertices) {
                  if (vertex.row === cell.row && vertex.col === cell.col) {
                    itemHallId = hall.id;
                    break;
                  }
                }
                if (itemHallId) break;
              }
            }
          }
        }
      }

      // 処理の補足です。

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

      // hallOrder繧呈峩譁ｰ

      setHallRouteSettings((prev) => {
        const currentSettings = prev[activeEventName]?.[visitListPanelMapTab] || {
          hallOrder: [],
          hallVisitLists: [],
        };
        let newHallOrder = [...currentSettings.hallOrder];

        // 処理の補足です。

        if (!newHallOrder.includes(baseGroupId)) {
          newHallOrder.push(baseGroupId);
        }

        // 処理の補足です。

        if (priorityLevel !== 'none' && !newHallOrder.includes(newGroupId)) {
          // 処理の補足です。
          const priorityGroupId = buildGroupId(itemHallId, 'priority');

          // 処理の補足です。

          let insertIndex = newHallOrder.length;

          if (priorityLevel === 'highest') {
            // 処理の補足です。
            const priorityIndex = newHallOrder.indexOf(priorityGroupId);
            const baseIndex = newHallOrder.indexOf(baseGroupId);

            if (priorityIndex !== -1) {
              insertIndex = priorityIndex;
            } else if (baseIndex !== -1) {
              insertIndex = baseIndex;
            }
          } else if (priorityLevel === 'priority') {
            // 処理の補足です。
            const baseIndex = newHallOrder.indexOf(baseGroupId);
            if (baseIndex !== -1) {
              insertIndex = baseIndex;
            }
          }

          newHallOrder.splice(insertIndex, 0, newGroupId);
        }

        // 処理の補足です。
        // 処理の補足です。
        if (oldPriority !== 'none' && oldGroupId !== newGroupId) {
          // 処理の補足です。
          const otherItemsInOldGroup = items.filter((i) => {
            if (i.id === itemId) return false;
            if ((i.priorityLevel || 'none') !== oldPriority) return false;

            // 処理の補足です。

            if (!mapDataForTab) return false;
            const iBlock = mapDataForTab.blocks.find((b) => b.name === i.block);
            if (!iBlock) return false;
            const iNumMatch = i.number?.match(/\d+/);
            if (!iNumMatch) return false;
            const iNum = parseInt(iNumMatch[0], 10);
            const iCell = iBlock.numberCells.find((nc) => nc.value === iNum);
            if (!iCell) return false;

            // 処理の補足です。

            let iHallId: string | null = null;
            for (const h of halls) {
              const inPoly = (() => {
                if (h.vertices.length < 3) return false;
                let inside = false;
                for (let ii = 0, j = h.vertices.length - 1; ii < h.vertices.length; j = ii++) {
                  const xi = h.vertices[ii].col,
                    yi = h.vertices[ii].row;
                  const xj = h.vertices[j].col,
                    yj = h.vertices[j].row;
                  if (
                    yi > iCell.row !== yj > iCell.row &&
                    iCell.col < ((xj - xi) * (iCell.row - yi)) / (yj - yi) + xi
                  ) {
                    inside = !inside;
                  }
                }
                return inside;
              })();

              if (inPoly) {
                iHallId = h.id;
                break;
              }
              for (const vertex of h.vertices) {
                if (vertex.row === iCell.row && vertex.col === iCell.col) {
                  iHallId = h.id;
                  break;
                }
              }
              if (iHallId) break;
            }

            return iHallId === itemHallId;
          });

          if (otherItemsInOldGroup.length === 0) {
            newHallOrder = newHallOrder.filter((id) => id !== oldGroupId);
          }
        }

        return {
          ...prev,
          [activeEventName]: {
            ...prev[activeEventName],
            [visitListPanelMapTab]: {
              ...currentSettings,
              hallOrder: newHallOrder,
            },
          },
        };
      });
    },
    [activeEventName, visitListPanelMapTab, items, hallDefinitions, mapData],
  );

  // 処理の補足です。
  const handleTabChangeWithVisitListCheck = (newTab: string): boolean => {
    if (visitListPanelOpen && visitListHasUnsavedChanges) {
      setPendingTabChange(newTab);
      setShowVisitListConfirmDialog(true);
      return false;
    }
    return true;
  };

  // 処理の補足です。

  const handleVisitListDialogConfirm = useCallback(() => {
    handleVisitListConfirm();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListConfirm, pendingTabChange]);

  // 処理の補足です。

  const handleVisitListDialogCancel = useCallback(() => {
    handleVisitListCancel();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListCancel, pendingTabChange]);

  // 処理の補足です。

  const handleUpdateBlocks = useCallback(
    (blocks: BlockDefinition[]) => {
      if (!activeEventName || !isMapTab || !currentMapData) return;

      setMapData((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [activeTab]: {
            ...currentMapData,
            blocks,
          },
        },
      }));
    },
    [activeEventName, isMapTab, activeTab, currentMapData],
  );

  // 処理の補足です。

  const handleUpdateHalls = useCallback(
    (halls: HallDefinition[]) => {
      if (!activeEventName || !isMapTab) return;

      setHallDefinitions((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [activeTab]: halls,
        },
      }));

      // 処理の補足です。

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
          [activeTab]: {
            ...currentHallRouteSettings,
            hallOrder: updatedOrder,
          },
        },
      }));
    },
    [activeEventName, isMapTab, activeTab, currentHallRouteSettings],
  );

  // 処理の補足です。

  const handleUpdateHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName || !isMapTab) return;

      setHallRouteSettings((prev) => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [activeTab]: settings,
        },
      }));
    },
    [activeEventName, isMapTab, activeTab],
  );

  // 処理の補足です。

  const handleReorderExecuteListByHallOrder = useCallback(
    (hallOrder: string[]) => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      const currentMapData = mapData[activeEventName]?.[activeTab];
      const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
      const currentHallRouteSettings = hallRouteSettings[activeEventName]?.[activeTab] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      if (!currentMapData || halls.length === 0) return;

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];

        if (dayItems.length === 0) return prev;

        // 処理の補足です。

        const itemsMap = new Map(items.map((i) => [i.id, i]));
        const getHallIdForItem = (itemId: string): string | null => {
          const item = itemsMap.get(itemId);
          if (!item || !currentMapData) return null;

          const blockName = item.block?.trim() || '';
          // 処理の補足です。
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

        // 処理の補足です。

        const itemsByHall = new Map<string | null, Set<string>>();
        dayItems.forEach((itemId) => {
          const hallId = getHallIdForItem(itemId);
          if (!itemsByHall.has(hallId)) {
            itemsByHall.set(hallId, new Set());
          }
          itemsByHall.get(hallId)!.add(itemId);
        });

        // 処理の補足です。

        const visitOrderMap = new Map<string, number>();
        currentHallRouteSettings.hallVisitLists.forEach((list) => {
          list.itemIds.forEach((itemId, index) => {
            visitOrderMap.set(itemId, index);
          });
        });

        // 処理の補足です。

        const sortItemsInHall = (itemIds: Set<string>): string[] => {
          const itemsArray = Array.from(itemIds);
          return itemsArray.sort((a, b) => {
            const orderA = visitOrderMap.get(a);
            const orderB = visitOrderMap.get(b);

            // 処理の補足です。

            if (orderA !== undefined && orderB !== undefined) {
              return orderA - orderB;
            }
            // 処理の補足です。
            if (orderA !== undefined) return -1;
            if (orderB !== undefined) return 1;
            // 処理の補足です。
            return dayItems.indexOf(a) - dayItems.indexOf(b);
          });
        };

        // 処理の補足です。

        const reorderedItems: string[] = [];

        // 処理の補足です。
        hallOrder.forEach((hallId) => {
          const hallItems = itemsByHall.get(hallId);
          if (hallItems && hallItems.size > 0) {
            reorderedItems.push(...sortItemsInHall(hallItems));
            itemsByHall.delete(hallId);
          }
        });

        // 処理の補足です。
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
    [activeEventName, isMapTab, activeTab, mapData, hallDefinitions, hallRouteSettings, items],
  );

  // 処理の補足です。

  const [hallDefinitionMode, setHallDefinitionMode] = useState(false);

  // 処理の補足です。

  const [vertexSelectionMode, setVertexSelectionMode] = useState<{
    clickedVertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // 処理の補足です。

  const [pendingVertexSelection, setPendingVertexSelection] = useState<{
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // 処理の補足です。

  const handleStartVertexSelection = useCallback((editingData?: unknown) => {
    setVertexSelectionMode({ clickedVertices: [], editingData });
    setHallDefinitionMode(false);
  }, []);

  // 処理の補足です。

  const sortVerticesNonCrossing = useCallback(
    (vertices: { row: number; col: number }[]): { row: number; col: number }[] => {
      if (vertices.length <= 2) return vertices;

      // 処理の補足です。

      const centroidRow = vertices.reduce((sum, v) => sum + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((sum, v) => sum + v.col, 0) / vertices.length;

      // 処理の補足です。

      const sorted = [...vertices].sort((a, b) => {
        const angleA = Math.atan2(a.row - centroidRow, a.col - centroidCol);
        const angleB = Math.atan2(b.row - centroidRow, b.col - centroidCol);
        return angleA - angleB;
      });

      return sorted;
    },
    [],
  );

  // 処理の補足です。

  const handleConfirmVertexSelection = useCallback(() => {
    if (vertexSelectionMode) {
      // 処理の補足です。
      const sorted = sortVerticesNonCrossing(vertexSelectionMode.clickedVertices);
      setPendingVertexSelection({
        vertices: sorted,
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [sortVerticesNonCrossing, vertexSelectionMode]);

  // 処理の補足です。

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

  // 処理の補足です。

  useEffect(() => {
    const handleMapCellClickForVertex = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!vertexSelectionMode) return;

      const { row, col } = e.detail;

      setVertexSelectionMode((prev) => {
        if (!prev) return prev;

        // 処理の補足です。

        const existingIndex = prev.clickedVertices.findIndex((v) => v.row === row && v.col === col);
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter((_, i) => i !== existingIndex),
          };
        }

        // 処理の補足です。

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

  // 処理の補足です。

  const handleStartCellSelection = useCallback(
    (type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual', editingData?: unknown) => {
      setCellSelectionMode({ type, clickedCells: [], editingBlockData: editingData });
      setBlockDefinitionMode(false); // ブロック定義パネルの表示状態を更新します。
    },
    [],
  );

  // 処理の補足です。

  const handleConfirmCellSelection = useCallback(() => {
    if (cellSelectionMode) {
      // 処理の補足です。
      setPendingCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // ブロック定義パネルの表示状態を更新します。
  }, [cellSelectionMode]);

  // 処理の補足です。

  const handleCancelCellSelection = useCallback(() => {
    // 処理の補足です。
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: 'cancelled', // 処理の補足です。
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // ブロック定義パネルの表示状態を更新します。
  }, [cellSelectionMode]);

  // 処理の補足です。

  useEffect(() => {
    const handleMapCellClick = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!cellSelectionMode) return;

      const { row, col } = e.detail;

      setCellSelectionMode((prev) => {
        if (!prev) return prev;

        // 処理の補足です。

        const existingIndex = prev.clickedCells.findIndex((c) => c.row === row && c.col === col);
        if (existingIndex >= 0) {
          return {
            ...prev,
            clickedCells: prev.clickedCells.filter((_, i) => i !== existingIndex),
          };
        }

        // 驕ｸ謚槭ｒ霑ｽ蜉

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
    isMapTab?: boolean;
  }> = ({ tab, label, count, onClick, isMapTab: isMapTabProp }) => {
    const longPressTimeout = React.useRef<number | null>(null);
    const menuRef = React.useRef<HTMLDivElement>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);

    const handlePointerDown = (e: React.PointerEvent) => {
      if (!activeEventName) return;

      // 処理の補足です。

      const target = e.currentTarget as HTMLButtonElement;
      const rect = target.getBoundingClientRect();
      const menuLeft = rect.left + rect.width / 2;
      const menuTop = rect.bottom + 4;

      longPressTimeout.current = window.setTimeout(() => {
        if (isMapTabProp) {
          // 処理の補足です。
          setMapTabMenuPosition({ left: menuLeft, top: menuTop });
          setMapTabMenuOpen(tab);
        } else if (eventDates.includes(tab)) {
          // 処理の補足です。
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
      // 処理の補足です。
      if (mapTabMenuOpen) {
        // 処理の補足です。
        if (mapTabMenuOpen === tab) {
          setMapTabMenuOpen(null);
          return;
        }
        // 処理の補足です。
        setMapTabMenuOpen(null);
      }
      if (onClick) {
        onClick();
      } else {
        setItemToEdit(null);
        setSelectedItemIds(new Set());
        setSelectedBlockFilters(new Set());
        setCandidateNumberSortDirection(null);
        setActiveTab(tab);
      }
    };

    // 処理の補足です。

    React.useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (
          menuRef.current &&
          !menuRef.current.contains(e.target as Node) &&
          buttonRef.current &&
          !buttonRef.current.contains(e.target as Node)
        ) {
          setMapTabMenuOpen(null);
        }
      };
      if (mapTabMenuOpen === tab) {
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }
    }, [tab]);

    // 処理の補足です。

    const handleMenuItemClick = (action: 'visitList' | 'blockDefinition' | 'hallDefinition') => {
      // 処理の補足です。
      setMapTabMenuOpen(null);

      // 処理の補足です。

      setItemToEdit(null);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());
      setCandidateNumberSortDirection(null);
      setActiveTab(tab);

      // 処理の補足です。

      setTimeout(() => {
        switch (action) {
          case 'visitList':
            openVisitListPanel(tab);
            break;
          case 'blockDefinition':
            setBlockDefinitionMode(true);
            break;
          case 'hallDefinition':
            setHallDefinitionMode(true);
            break;
        }
      }, 0);
    };

    return (
      <div className="relative">
        <button
          ref={buttonRef}
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

        {/* 表示処理の補足 */}
        {mapTabMenuOpen === tab && isMapTabProp && (
          <div
            ref={menuRef}
            className="fixed bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 min-w-[180px]"
            style={{
              left: `${mapTabMenuPosition.left}px`,
              top: `${mapTabMenuPosition.top}px`,
              transform: 'translateX(-50%)',
              zIndex: 9999,
            }}
          >
            {/* 表示処理の補足 */}
            <div className="absolute left-1/2 -translate-x-1/2 -top-2">
              <div className="w-3 h-3 bg-white dark:bg-slate-800 border-l border-t border-slate-200 dark:border-slate-700 transform rotate-45" />
            </div>
            <div className="py-1">
              <button
                onClick={() => handleMenuItemClick('visitList')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-t-lg flex items-center gap-2"
              >
                <span>📍</span> 訪問リスト
              </button>
              <button
                onClick={() => handleMenuItemClick('blockDefinition')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <span>🔲</span> ブロック定義
              </button>
              <button
                onClick={() => handleMenuItemClick('hallDefinition')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-b-lg flex items-center gap-2"
              >
                <span>🏛️</span> ホール定義
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const executeColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
    const itemsMap = new Map(items.map((item) => [item.id, item]));
    return executeIds.map((id) => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
  }, [activeEventName, activeTab, executeModeItems, items, eventDates]);

  const visibleItems = useMemo(() => {
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const itemsForTab = currentTabItems;

    if (!activeEventName) return itemsForTab;

    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'execute') {
      // 処理の補足です。
      if (sortState === 'Manual') {
        return executeColumnItems;
      }
      // 処理の補足です。
      const filterStatus = sortState as Exclude<SortState, 'Manual'>;
      return executeColumnItems.filter(
        (item) => item.purchaseStatus === filterStatus || recentlyChangedItemIds.has(item.id),
      );
    }

    // 処理の補足です。

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

  // 処理の補足です。

  const searchMatches = useMemo(() => {
    if (!searchKeyword.trim() || !activeEventName || !eventDates.includes(activeTab)) {
      return [];
    }

    const keyword = searchKeyword.trim().toLowerCase();
    const matches: string[] = [];

    // 処理の補足です。
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

  // 処理の補足です。

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

  // 処理の補足です。

  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab]);

  // 処理の補足です。

  const duplicateCircleItemIds = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return new Set<string>();
    const itemsForTab = currentTabItems;
    const circleCountMap = new Map<string, number>();
    const circleItemIdsMap = new Map<string, string[]>();

    // 処理の補足です。
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

    // 処理の補足です。

    const duplicateIds = new Set<string>();
    circleCountMap.forEach((count, circle) => {
      if (count > 1) {
        const itemIds = circleItemIdsMap.get(circle) || [];
        itemIds.forEach((id) => duplicateIds.add(id));
      }
    });

    return duplicateIds;
  }, [activeEventName, activeTab, currentTabItems, eventDates]);

  // 処理の補足です。

  const availableBlocks = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
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
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    let filtered = currentTabItems.filter((item) => !executeIds.has(item.id));

    // 処理の補足です。

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

  // 処理の補足です。

  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];

    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const mode = dayModes[activeEventName || '']?.[currentEventDate] || 'edit';

    let visibleItemIds: Set<string>;

    if (mode === 'execute') {
      // 処理の補足です。
      visibleItemIds = new Set(visibleItems.map((item) => item.id));
    } else {
      // 処理の補足です。
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

  // 処理の補足です。

  const handleSearchNext = useCallback(() => {
    if (!searchKeyword.trim() || visibleSearchMatches.length === 0) {
      if (searchMatches.length > 0 && visibleSearchMatches.length === 0) {
        alert('現在の絞り込み条件では一致する項目がありません。');
      }
      return;
    }

    // 処理の補足です。

    const startIndex = currentSearchIndex === -1 ? -1 : currentSearchIndex;
    const nextIndex = (startIndex + 1) % visibleSearchMatches.length;
    setCurrentSearchIndex(nextIndex);

    const nextItemId = visibleSearchMatches[nextIndex];
    setHighlightedItemId(nextItemId);

    // 処理の補足です。

    setTimeout(() => {
      const element = document.querySelector(`[data-item-id="${nextItemId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);

  // 処理の補足です。

  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
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

  // 処理の補足です。

  const hasCandidateSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
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

  // 処理の補足です。

  const hasExecuteSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
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

  // 処理の補足です。

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
            <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                    即売会購入巡回表
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
                </div>
                <div className="flex items-center gap-2 mt-1">
                  {activeEventName && (
                    <h2 className="text-sm text-blue-600 dark:text-blue-400 font-semibold">
                      {activeEventName}
                    </h2>
                  )}
                  {/* 表示処理の補足 */}
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
                    style={{
                      WebkitTapHighlightColor: 'transparent',
                      minWidth: '44px',
                      minHeight: '44px',
                    }}
                    type="button"
                  >
                    {themeMode === 'system' ? (
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
                          d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                      </svg>
                    ) : themeMode === 'light' ? (
                      <svg
                        className="w-5 h-5 text-amber-500 pointer-events-none"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                        />
                      </svg>
                    ) : (
                      <svg
                        className="w-5 h-5 text-indigo-400 pointer-events-none"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                        />
                      </svg>
                    )}
                  </button>

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

                          {/* 表示処理の補足 */}
                          <button
                            onClick={() => {
                              setUiVisibilitySettings(DEFAULT_UI_VISIBILITY);
                              setUiVisibilityOverride(false);
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
                  {activeEventName && mainContentVisible && (
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
                  {activeEventName && isMapTab && currentMapData && currentHalls.length > 0 && (
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
                            setSmartInsertToast(
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
                </div>
              </div>
              <div className="flex items-center gap-4">
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  selectedItemIds.size > 0 && (
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
                      const mapTabName = getMapTabForDate(eventDate);
                      const hasMapData = mapTabs.includes(mapTabName);
                      return (
                        <React.Fragment key={eventDate}>
                          <TabButton tab={eventDate} label={eventDate} count={count} />
                          {hasMapData && (
                            <TabButton tab={mapTabName} label={mapTabName} isMapTab={true} />
                          )}
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
          <ImportScreen
            onBulkAdd={handleBulkAdd}
            activeEventName={activeEventName}
            itemToEdit={itemToEdit}
            onUpdateItem={handleUpdateItem}
            onDoneEditing={handleDoneEditing}
            newItemDefaults={newItemDefaults}
            onClearNewItemDefaults={() => setNewItemDefaults(null)}
          />
        )}
        {/* 表示処理の補足 */}
        {activeEventName && isMapTab && currentMapData && (
          <MapView
            mapData={currentMapData}
            mapName={activeTab}
            items={items}
            executeModeItemIds={currentMapExecuteItemIds}
            onAddToExecuteList={handleAddToExecuteListFromMap}
            onAddToExecuteListAtPosition={handleAddToExecuteListFromMapAtPosition}
            onRemoveFromExecuteList={handleRemoveFromExecuteListFromMap}
            onMoveToFirst={handleMoveToFirstFromMap}
            onMoveToLast={handleMoveToLastFromMap}
            onUpdateItem={handleUpdateItem}
            onDeleteItem={(itemId) => {
              const item = items.find((i) => i.id === itemId);
              if (item) handleDeleteRequest(item);
            }}
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
          />
        )}
        {activeEventName && mainContentVisible && (
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
                    <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">
                      実行リストアイテム
                    </h3>
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">
                      実行対象として選択中のアイテムを管理します。
                    </p>
                  </div>
                  <ShoppingList
                    items={executeColumnItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={(
                      dragId: string,
                      hoverId: string,
                      targetColumn?: 'execute' | 'candidate',
                      sourceColumn?: 'execute' | 'candidate',
                    ) => handleMoveItem(dragId, hoverId, targetColumn, sourceColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    columnType="execute"
                    currentDay={eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''}
                    onMoveItemUp={handleMoveItemUp}
                    onMoveItemDown={handleMoveItemDown}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onToggleRangeSelection={handleToggleRangeSelection}
                    duplicateCircleItemIds={duplicateCircleItemIds}
                    highlightedItemId={highlightedItemId}
                    layoutMode={layoutMode}
                    showHallGroups={true}
                    hallDefinitions={getHallsForDate(
                      eventDates.includes(activeTab) ? activeTab : eventDates[0] || '',
                    )}
                    hallOrder={getHallOrderForDate(
                      eventDates.includes(activeTab) ? activeTab : eventDates[0] || '',
                    )}
                    mapData={getMapDataForDate(
                      eventDates.includes(activeTab) ? activeTab : eventDates[0] || '',
                    )}
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
                    onMoveItem={(
                      dragId: string,
                      hoverId: string,
                      targetColumn?: 'execute' | 'candidate',
                      sourceColumn?: 'execute' | 'candidate',
                    ) => handleMoveItem(dragId, hoverId, targetColumn, sourceColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    columnType="candidate"
                    currentDay={eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''}
                    onMoveItemUp={handleMoveItemUp}
                    onMoveItemDown={handleMoveItemDown}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onToggleRangeSelection={handleToggleRangeSelection}
                    duplicateCircleItemIds={duplicateCircleItemIds}
                    highlightedItemId={highlightedItemId}
                    layoutMode={layoutMode}
                  />
                </div>
              </div>
            ) : currentMode === 'focus' ? (
              <FocusModeContainer
                key={currentFocusSessionKey || 'focus-mode'}
                activeEventName={activeEventName}
                activeTab={activeTab}
                eventDates={eventDates}
                items={items}
                executeModeItems={executeModeItems}
                mapData={mapData}
                hallDefinitions={hallDefinitions}
                onUpdateItem={handleUpdateItem}
                onModeChange={(mode, lastItemId) => handleSetViewMode(mode, lastItemId)}
                layoutMode={layoutMode}
                onLayoutModeChange={setLayoutMode}
                onMapVisibilityChange={setFocusModeMapVisible}
                onAddItem={handleAddItemFromFocusMode}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                appZoomLevel={zoomLevel}
                resumeState={currentFocusResumeState}
                onSessionStateChange={handleFocusSessionStateChange}
              />
            ) : (
              <ShoppingList
                items={visibleItems}
                onUpdateItem={handleUpdateItem}
                onMoveItem={(
                  dragId: string,
                  hoverId: string,
                  targetColumn?: 'execute' | 'candidate',
                ) => handleMoveItem(dragId, hoverId, targetColumn)}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds}
                onSelectItem={handleSelectItem}
                columnType="execute"
                currentDay={eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''}
                onMoveItemUp={handleMoveItemUp}
                onMoveItemDown={handleMoveItemDown}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                onToggleRangeSelection={handleToggleRangeSelection}
                duplicateCircleItemIds={duplicateCircleItemIds}
                highlightedItemId={highlightedItemId}
                layoutMode={layoutMode}
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
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              ホールの頂点をクリック ({vertexSelectionMode.clickedVertices.length}
              /4)
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
              layoutMode={layoutMode}
              onLayoutModeChange={setLayoutMode}
              filterLabel={!showHeaderBar ? sortLabels[sortState] : undefined}
              onFilterToggle={!showHeaderBar ? handleSortToggle : undefined}
            />
          )}
        </>
      )}
      {activeEventName && items.length > 0 && mainContentVisible && (
        <ZoomControl zoomLevel={zoomLevel} onZoomChange={handleZoomChange} />
      )}

      {/* 表示処理の補足 */}
      {smartInsertToast && (
        <div className="fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] bg-green-600 text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-pulse">
          {smartInsertToast}
        </div>
      )}
    </div>
  );
};

export default App;
