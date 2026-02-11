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
  Manual: 'Manual',
  Postpone: 'Postpone',
  Late: '驕・盾',
  Absent: '谺蟶ｭ',
  SoldOut: 'SoldOut',
  None: '譛ｪ雉ｼ蜈･',
  Purchased: 'Purchased',
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
  // 襍ｷ轤ｹ縺ｨ邨らせ繧堤ｮ｡逅・ｼ亥・繧ｿ繧､繝励→繧｢繧､繝・ΒID縺ｮ繝壹い・・
  const [rangeStart, setRangeStart] = useState<{
    itemId: string;
    columnType: 'execute' | 'candidate';
  } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{
    itemId: string;
    columnType: 'execute' | 'candidate';
  } | null>(null);

  // 繝槭ャ繝励°繧峨・譁ｰ隕上い繧､繝・Β霑ｽ蜉逕ｨ縺ｮ蛻晄悄蛟､

  const [newItemDefaults, setNewItemDefaults] = useState<{
    eventDate: string;
    block: string;
    number: string;
  } | null>(null);

  // 譖ｴ譁ｰ讖溯・逕ｨ縺ｮ迥ｶ諷・

  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [updateData, setUpdateData] = useState<EventUpdateDiff | null>(null);
  const [updateEventName, setUpdateEventName] = useState<string | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);

  // 讀懃ｴ｢讖溯・縺ｮ迥ｶ諷・

  const [searchKeyword, setSearchKeyword] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // 繝ｬ繧､繧｢繧ｦ繝医Δ繝ｼ繝臥憾諷具ｼ医ン繝･繝ｼ繝昴・繝亥ｹ・〒蛻晄悄蛹厄ｼ・

  const [layoutMode, setLayoutMode] = useState<'pc' | 'smartphone'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'smartphone' : 'pc',
  );
  const { uiVisibilitySettings, setUiVisibilitySettings } = useUIVisibilitySettings();
  const [uiVisibilityOverride, setUiVisibilityOverride] = useState(false);
  const [uiSettingsPanelOpen, setUiSettingsPanelOpen] = useState(false);
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);

  const { themeMode, setThemeMode } = useThemeMode();

  // 繝槭ャ繝玲ｩ溯・縺ｮ迥ｶ諷・

  const [mapData, setMapData] = useState<MapDataStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);

  // 繝槭ャ繝怜叙繧願ｾｼ縺ｿ繝繧､繧｢繝ｭ繧ｰ逕ｨ縺ｮ迥ｶ諷・

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

  // 迴ｾ蝨ｨ縺ｮ繧､繝吶Φ繝医・蜿ょ刈譌･繝ｪ繧ｹ繝医ｒ蜿門ｾ・

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

  // 繝帙・繝ｫ蜀・・險ｪ蝠丞・繧｢繧､繝・Β謨ｰ繧貞叙蠕暦ｼ亥━蜈医・譛蜆ｪ蜈医げ繝ｫ繝ｼ繝励ｂ蜷ｫ繧・・

  const getHallExecuteCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
      if (!dayMatch) return 0;
      const dayName = dayMatch[1];

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      return executeIds.filter((itemId) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return false;

        // 繝悶Ο繝・け縺九ｉ繝帙・繝ｫID繧貞愛螳・

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

  // 繝帙・繝ｫ蜀・・蜈ｨ繧｢繧､繝・Β謨ｰ繧貞叙蠕・

  const getHallTotalItemCount = useCallback(
    (hallId: string): number => {
      if (!activeEventName || !isMapTab || !currentMapData) return 0;

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
      if (!dayMatch) return 0;
      const dayName = dayMatch[1];

      const dayItems = items.filter((item) => item.eventDate === dayName);

      return dayItems.filter((item) => {
        // 繝悶Ο繝・け縺九ｉ繝帙・繝ｫID繧貞愛螳・
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

  // 繧｢繧､繝・Β縺後←縺ｮ繝帙・繝ｫ縺ｫ螻槭☆繧九°繧貞愛螳・

  const getItemHallId = useCallback(
    (item: ShoppingItem, eventDate: string): string | null => {
      const halls = getHallsForDate(eventDate);
      const mapDataForDate = getMapDataForDate(eventDate);
      if (!halls.length || !mapDataForDate) return null;

      // 繝悶Ο繝・け縺ｮ荳ｭ蠢・せ繧貞叙蠕・

      const block = mapDataForDate.blocks.find((b) => b.name === item.block);
      if (!block) return null;

      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;

      // 縺ｩ縺ｮ繝帙・繝ｫ縺ｫ螻槭☆繧九°蛻､螳・

      for (const hall of halls) {
        if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
          return hall.id;
        }
      }
      return null;
    },
    [getHallsForDate, getMapDataForDate],
  );

  // 2縺､縺ｮ繧｢繧､繝・Β縺悟酔縺倥・繝ｼ繝ｫ縺ｫ螻槭☆繧九°繧貞愛螳・

  const areItemsInSameHall = useCallback(
    (itemId1: string, itemId2: string, eventDate: string): boolean => {
      const item1 = items.find((i) => i.id === itemId1);
      const item2 = items.find((i) => i.id === itemId2);
      if (!item1 || !item2) return true; // 繧｢繧､繝・Β縺瑚ｦ九▽縺九ｉ縺ｪ縺・ｴ蜷医・蛻ｶ髯舌↑縺・
      const halls = getHallsForDate(eventDate);
      if (!halls.length) return true; // 繝帙・繝ｫ螳夂ｾｩ縺後↑縺・ｴ蜷医・蛻ｶ髯舌↑縺・
      const hallId1 = getItemHallId(item1, eventDate);
      const hallId2 = getItemHallId(item2, eventDate);

      // 縺ｩ縺｡繧峨°縺後・繝ｼ繝ｫ縺ｫ螻槭＠縺ｦ縺・↑縺・ｴ蜷医・蛻ｶ髯舌↑縺・

      if (hallId1 === null || hallId2 === null) return true;

      return hallId1 === hallId2;
    },
    [items, getHallsForDate, getItemHallId],
  );

  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    // 繝槭ャ繝励ち繝悶・蝣ｴ蜷医・邱ｨ髮・Δ繝ｼ繝峨ｒ霑斐☆
    if (isMapTab) return 'edit';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    // activeTab縺悟盾蜉譌･・・1譌･逶ｮ', '2譌･逶ｮ'縺ｪ縺ｩ・峨・蝣ｴ蜷・
    if (eventDates.includes(activeTab)) {
      return modes[activeTab] || 'edit';
    }
    return 'edit';
  }, [activeEventName, dayModes, activeTab, eventDates, isMapTab]);

  // 迴ｾ蝨ｨ縺ｮ譚｡莉ｶ縺ｫ蝓ｺ縺･縺上・繝・ム繝ｼ/繧ｿ繝悶ヰ繝ｼ陦ｨ遉ｺ迥ｶ諷・

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
        // 雉ｼ蜈･迥ｶ諷九′螟画峩縺輔ｌ縺溘°繝√ぉ繝・け
        const currentItem = prev[activeEventName]?.find((item) => item.id === updatedItem.id);
        const purchaseStatusChanged =
          currentItem && currentItem.purchaseStatus !== updatedItem.purchaseStatus;
        const priceChanged = currentItem && currentItem.price !== updatedItem.price;

        // 雉ｼ蜈･迥ｶ諷九′螟画峩縺輔ｌ縺溷ｴ蜷医∵怙霑大､画峩縺輔ｌ縺溘い繧､繝・Β縺ｨ縺励※險倬鹸

        if (purchaseStatusChanged) {
          setRecentlyChangedItemIds((prevIds) => new Set(prevIds).add(updatedItem.id));
        }

        // 螳溯｡後Δ繝ｼ繝峨・髮・ｸｭ繝｢繝ｼ繝峨〒雉ｼ蜈･迥ｶ諷九∪縺溘・萓｡譬ｼ縺悟､画峩縺輔ｌ縺溷ｴ蜷医∽ｿ晁ｭｷ繝ｬ繝吶Ν繧・deletable'縺ｫ閾ｪ蜍募､画峩
        // ・域・遉ｺ逧・↓protectionLevel縺瑚ｨｭ螳壹＆繧後※縺・↑縺・ｴ蜷医・縺ｿ・・
        const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
        const currentMode = dayModes[activeEventName]?.[currentEventDate] || 'edit';
        let finalItem = updatedItem;

        if (
          (currentMode === 'execute' || currentMode === 'focus') &&
          (purchaseStatusChanged || priceChanged)
        ) {
          // 迴ｾ蝨ｨ縺ｮ菫晁ｭｷ繝ｬ繝吶Ν縺系one・井ｿ晁ｭｷ縺ｪ縺暦ｼ峨・蝣ｴ蜷医・縺ｿ縲‥eletable・亥炎髯､縺ｮ縺ｿ險ｱ蜿ｯ・峨↓螟画峩
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

      // 繝ｪ繧ｹ繝域忰蟆ｾ縺ｸ縺ｮ霑ｽ蜉蛻､螳・

      const isAppendToEnd = hoverId === '__END_OF_LIST__';

      // 蛻鈴俣遘ｻ蜍輔・蜃ｦ逅・ｼ育ｷｨ髮・Δ繝ｼ繝峨・縺ｿ・・

      if (mode === 'edit' && sourceColumn && targetColumn && sourceColumn !== targetColumn) {
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

        if (sourceColumn === 'candidate' && targetColumn === 'execute') {
          // 蛟呵｣懊Μ繧ｹ繝・竊・螳溯｡悟・縺ｸ縺ｮ遘ｻ蜍・        // candidateColumnItems縺ｨ蜷後§繝ｭ繧ｸ繝・け縺ｧ蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β繧貞叙蠕暦ｼ磯・ｺ上ｒ邯ｭ謖・ｼ・
          const currentTabItemsForMove = items.filter((item) => item.eventDate === activeTab);
          let candidateItems = currentTabItemsForMove.filter((item) => !executeIdsSet.has(item.id));

          // 繝悶Ο繝・け繝輔ぅ繝ｫ繧ｿ繧帝←逕ｨ・・andidateColumnItems縺ｨ蜷後§・・

          if (selectedBlockFilters.size > 0) {
            candidateItems = candidateItems.filter((item) => selectedBlockFilters.has(item.block));
          }

          // 遘ｻ蜍輔☆繧九い繧､繝・Β繧貞叙蠕暦ｼ亥呵｣懊Μ繧ｹ繝医・鬆・ｺ上ｒ邯ｭ謖・ｼ・

          let itemsToMove: ShoppingItem[] = [];
          if (selectedItemIds.has(dragId)) {
            // 蛟呵｣懊Μ繧ｹ繝医・鬆・ｺ上ｒ邯ｭ謖√＠縺ｪ縺後ｉ驕ｸ謚槭＆繧後◆繧｢繧､繝・Β繧呈歓蜃ｺ
            itemsToMove = candidateItems.filter((item) => selectedItemIds.has(item.id));
          } else {
            const item = candidateItems.find((item) => item.id === dragId);
            if (item) itemsToMove = [item];
          }

          if (itemsToMove.length === 0) return;

          const itemIdsToMove = itemsToMove.map((item) => item.id);

          // executeModeItems縺ｫ霑ｽ蜉

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
          // 螳溯｡悟・ 竊・蛟呵｣懊Μ繧ｹ繝医∈縺ｮ遘ｻ蜍・
          setEventLists((prev) => {
            const allItems = [...(prev[activeEventName] || [])];
            const executeItems = allItems.filter(
              (item) => item.eventDate.includes(currentEventDate) && executeIdsSet.has(item.id),
            );
            const candidateItems = allItems.filter(
              (item) => item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id),
            );

            // 遘ｻ蜍輔☆繧九い繧､繝・Β繧貞叙蠕・

            let itemsToMove: ShoppingItem[] = [];
            if (selectedItemIds.has(dragId)) {
              itemsToMove = executeItems.filter((item) => selectedItemIds.has(item.id));
            } else {
              const item = executeItems.find((item) => item.id === dragId);
              if (item) itemsToMove = [item];
            }

            if (itemsToMove.length === 0) return prev;

            const itemIdsToMove = itemsToMove.map((item) => item.id);

            // executeModeItems縺九ｉ蜑企勁

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

            // 蛟呵｣懊Μ繧ｹ繝医↓謖ｿ蜈･

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

            // 蜀咲ｵ仙粋蜃ｦ逅・

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
        // 邱ｨ髮・Δ繝ｼ繝・ 螳溯｡悟・蜀・〒縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setExecuteModeItems((prev) => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];

          if (selectedItemIds.has(dragId)) {
            // 隍・焚驕ｸ謚樊凾
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
            // 蜊倅ｸ繧｢繧､繝・Β
            const dragIndex = dayItems.findIndex((id) => id === dragId);
            if (dragIndex === -1) return prev; // 隕九▽縺九ｉ縺ｪ縺・ｴ蜷・
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
        // 邱ｨ髮・Δ繝ｼ繝・ 蛟呵｣懊Μ繧ｹ繝亥・縺ｧ縺ｮ荳ｦ縺ｳ譖ｿ縺・
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
            // 隍・焚驕ｸ謚樊凾
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

            // 蜀咲ｵ仙粋蜃ｦ逅・

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
            // 蜊倅ｸ繧｢繧､繝・Β
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
        // 螳溯｡後Δ繝ｼ繝・ 騾壼ｸｸ縺ｮ荳ｦ縺ｳ譖ｿ縺・
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
        // 邱ｨ髮・Δ繝ｼ繝・ 螳溯｡悟・蜀・〒縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setExecuteModeItems((prev) => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];
          const currentIndex = dayItems.findIndex((id) => id === itemId);

          if (currentIndex <= 0) return prev; // 譌｢縺ｫ蜈磯ｭ縺ｾ縺溘・隕九▽縺九ｉ縺ｪ縺・
          // 繝帙・繝ｫ髢鍋ｧｻ蜍募宛髯舌メ繧ｧ繝・け
          const targetId = dayItems[currentIndex - 1];
          if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
            return prev; // 逡ｰ縺ｪ繧九・繝ｼ繝ｫ縺ｪ縺ｮ縺ｧ遘ｻ蜍穂ｸ榊庄
          }

          // 隍・焚驕ｸ謚樊凾縺ｯ驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺吶∋縺ｦ繧堤ｧｻ蜍・

          if (selectedItemIds.has(itemId)) {
            const selectedIds = dayItems.filter((id) => selectedItemIds.has(id));
            const listWithoutSelection = dayItems.filter((id) => !selectedItemIds.has(id));

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺ｮ譛蛻昴・菴咲ｽｮ繧貞渕貅悶↓遘ｻ蜍・

            const firstSelectedIndex = dayItems.findIndex((id) => selectedItemIds.has(id));
            if (firstSelectedIndex > 0) {
              // 繝帙・繝ｫ髢鍋ｧｻ蜍募宛髯舌メ繧ｧ繝・け・磯∈謚槭げ繝ｫ繝ｼ繝怜・菴難ｼ・
              const targetIdForGroup = dayItems[firstSelectedIndex - 1];
              if (!areItemsInSameHall(selectedIds[0], targetIdForGroup, currentEventDate)) {
                return prev; // 逡ｰ縺ｪ繧九・繝ｼ繝ｫ縺ｪ縺ｮ縺ｧ遘ｻ蜍穂ｸ榊庄
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
            // 蜊倅ｸ繧｢繧､繝・Β
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
        // 邱ｨ髮・Δ繝ｼ繝・ 蛟呵｣懊Μ繧ｹ繝亥・縺ｧ縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setEventLists((prev) => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = currentEventDate;
          const executeIdsSet = new Set(
            executeModeItems[activeEventName]?.[currentEventDate] || [],
          );

          // 蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮ縺ｿ繧貞叙蠕・

          const candidateItems = allItems.filter(
            (item) => item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id),
          );

          const currentIndex = candidateItems.findIndex((item) => item.id === itemId);
          if (currentIndex <= 0) return prev; // 譌｢縺ｫ蜈磯ｭ縺ｾ縺溘・隕九▽縺九ｉ縺ｪ縺・
          if (selectedItemIds.has(itemId)) {
            // 隍・焚驕ｸ謚樊凾
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

              // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺ｯ縺昴・縺ｾ縺ｾ縲∝呵｣懊Μ繧ｹ繝医・縺ｿ荳ｦ縺ｳ譖ｿ縺・

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
            // 蜊倅ｸ繧｢繧､繝・Β
            [candidateItems[currentIndex - 1], candidateItems[currentIndex]] = [
              candidateItems[currentIndex],
              candidateItems[currentIndex - 1],
            ];

            // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺ｯ縺昴・縺ｾ縺ｾ縲∝呵｣懊Μ繧ｹ繝医・縺ｿ荳ｦ縺ｳ譖ｿ縺・

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
        // 螳溯｡後Δ繝ｼ繝・ 騾壼ｸｸ縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setEventLists((prev) => {
          const newItems = [...(prev[activeEventName] || [])];
          const currentIndex = newItems.findIndex((item) => item.id === itemId);

          if (currentIndex <= 0) return prev; // 譌｢縺ｫ蜈磯ｭ縺ｾ縺溘・隕九▽縺九ｉ縺ｪ縺・
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
        // 邱ｨ髮・Δ繝ｼ繝・ 螳溯｡悟・蜀・〒縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setExecuteModeItems((prev) => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];
          const currentIndex = dayItems.findIndex((id) => id === itemId);

          if (currentIndex < 0 || currentIndex >= dayItems.length - 1) return prev; // 譌｢縺ｫ譛ｫ蟆ｾ縺ｾ縺溘・隕九▽縺九ｉ縺ｪ縺・
          // 繝帙・繝ｫ髢鍋ｧｻ蜍募宛髯舌メ繧ｧ繝・け
          const targetId = dayItems[currentIndex + 1];
          if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
            return prev; // 逡ｰ縺ｪ繧九・繝ｼ繝ｫ縺ｪ縺ｮ縺ｧ遘ｻ蜍穂ｸ榊庄
          }

          // 隍・焚驕ｸ謚樊凾縺ｯ驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺吶∋縺ｦ繧堤ｧｻ蜍・

          if (selectedItemIds.has(itemId)) {
            const selectedIds = dayItems.filter((id) => selectedItemIds.has(id));
            const listWithoutSelection = dayItems.filter((id) => !selectedItemIds.has(id));

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺ｮ荳ｭ縺ｧ譛繧ょｾ後ｍ縺ｮ菴咲ｽｮ繧定ｦ九▽縺代ｋ

            let lastSelectedIndex = -1;
            dayItems.forEach((id, index) => {
              if (selectedItemIds.has(id)) lastSelectedIndex = index;
            });

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺梧怙蠕後↓縺ｪ縺・ｴ蜷医・縺ｿ遘ｻ蜍・

            if (lastSelectedIndex >= 0 && lastSelectedIndex < dayItems.length - 1) {
              // 鬟帙・雜翫∴繧句ｯｾ雎｡縺ｮ繧｢繧､繝・Β・磯∈謚樒ｯ・峇縺ｮ逶ｴ蠕後・繧｢繧､繝・Β・・
              const jumpOverItemId = dayItems[lastSelectedIndex + 1];

              // 繝帙・繝ｫ髢鍋ｧｻ蜍募宛髯舌メ繧ｧ繝・け・磯∈謚槭げ繝ｫ繝ｼ繝怜・菴難ｼ・

              if (
                !areItemsInSameHall(
                  selectedIds[selectedIds.length - 1],
                  jumpOverItemId,
                  currentEventDate,
                )
              ) {
                return prev; // 逡ｰ縺ｪ繧九・繝ｼ繝ｫ縺ｪ縺ｮ縺ｧ遘ｻ蜍穂ｸ榊庄
              }

              // 髱樣∈謚槭Μ繧ｹ繝亥・縺ｧ縺ｮ縺昴・繧｢繧､繝・Β縺ｮ菴咲ｽｮ

              const targetIndexInListWithout = listWithoutSelection.findIndex(
                (id) => id === jumpOverItemId,
              );

              if (targetIndexInListWithout !== -1) {
                // 縺昴・繧｢繧､繝・Β縺ｮ蠕後ｍ縺ｫ謖ｿ蜈･
                listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedIds);
                return {
                  ...prev,
                  [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection },
                };
              }
            }
            return prev;
          } else {
            // 蜊倅ｸ繧｢繧､繝・Β
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
        // 邱ｨ髮・Δ繝ｼ繝・ 蛟呵｣懊Μ繧ｹ繝亥・縺ｧ縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setEventLists((prev) => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = currentEventDate;
          const executeIdsSet = new Set(
            executeModeItems[activeEventName]?.[currentEventDate] || [],
          );

          // 蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮ縺ｿ繧貞叙蠕・

          const candidateItems = allItems.filter(
            (item) => item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id),
          );

          const currentIndex = candidateItems.findIndex((item) => item.id === itemId);
          if (currentIndex < 0 || currentIndex >= candidateItems.length - 1) return prev; // 譌｢縺ｫ譛ｫ蟆ｾ縺ｾ縺溘・隕九▽縺九ｉ縺ｪ縺・
          if (selectedItemIds.has(itemId)) {
            // 隍・焚驕ｸ謚樊凾
            const selectedBlock = candidateItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = candidateItems.filter(
              (item) => !selectedItemIds.has(item.id),
            );

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺ｮ荳ｭ縺ｧ譛繧ょｾ後ｍ縺ｮ菴咲ｽｮ繧定ｦ九▽縺代ｋ

            let lastSelectedIndex = -1;
            candidateItems.forEach((item, index) => {
              if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
            });

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺梧怙蠕後↓縺ｪ縺・ｴ蜷医・縺ｿ遘ｻ蜍・

            if (lastSelectedIndex >= 0 && lastSelectedIndex < candidateItems.length - 1) {
              const jumpOverItemId = candidateItems[lastSelectedIndex + 1].id;
              const targetIndexInListWithout = listWithoutSelection.findIndex(
                (item) => item.id === jumpOverItemId,
              );

              if (targetIndexInListWithout !== -1) {
                listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);

                // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺ｯ縺昴・縺ｾ縺ｾ縲∝呵｣懊Μ繧ｹ繝医・縺ｿ荳ｦ縺ｳ譖ｿ縺・

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
            // 蜊倅ｸ繧｢繧､繝・Β
            [candidateItems[currentIndex], candidateItems[currentIndex + 1]] = [
              candidateItems[currentIndex + 1],
              candidateItems[currentIndex],
            ];

            // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺ｯ縺昴・縺ｾ縺ｾ縲∝呵｣懊Μ繧ｹ繝医・縺ｿ荳ｦ縺ｳ譖ｿ縺・

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
        // 螳溯｡後Δ繝ｼ繝・ 騾壼ｸｸ縺ｮ荳ｦ縺ｳ譖ｿ縺・
        setEventLists((prev) => {
          const newItems = [...(prev[activeEventName] || [])];
          const currentIndex = newItems.findIndex((item) => item.id === itemId);

          if (currentIndex < 0 || currentIndex >= newItems.length - 1) return prev; // 譌｢縺ｫ譛ｫ蟆ｾ縺ｾ縺溘・隕九▽縺九ｉ縺ｪ縺・
          if (selectedItemIds.has(itemId)) {
            const selectedBlock = newItems.filter((item) => selectedItemIds.has(item.id));
            const listWithoutSelection = newItems.filter((item) => !selectedItemIds.has(item.id));

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺ｮ荳ｭ縺ｧ譛繧ょｾ後ｍ縺ｮ菴咲ｽｮ繧定ｦ九▽縺代ｋ

            let lastSelectedIndex = -1;
            newItems.forEach((item, index) => {
              if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
            });

            // 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺梧怙蠕後↓縺ｪ縺・ｴ蜷医・縺ｿ遘ｻ蜍・

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

      // 菫ｮ豁｣1: 陦ｨ遉ｺ蛛ｴ(View)縺ｨ蜷後§繝ｭ繧ｸ繝・け縺ｧ迴ｾ蝨ｨ縺ｮ蟇ｾ雎｡譌･繧堤音螳壹☆繧・

      const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';

      // 迴ｾ蝨ｨ縺ｮ螳溯｡悟・縺ｫ縺ゅｋID繧ｻ繝・ヨ

      const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

      // 遽・峇驕ｸ謚槭・襍ｷ轤ｹ繝ｻ邨らせ縺檎ｧｻ蜍募ｯｾ雎｡縺ｫ蜷ｫ縺ｾ繧後※縺・ｋ蝣ｴ蜷医∫ｯ・峇驕ｸ謚槭ｒ繝ｪ繧ｻ繝・ヨ

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

      // 菫ｮ豁｣2: activeTab縺ｧ縺ｯ縺ｪ縺上∫音螳壹＠縺歡urrentEventDate繧剃ｽｿ逕ｨ縺励※繧｢繧､繝・Β繧呈歓蜃ｺ・郁｡ｨ遉ｺ蛛ｴ縺ｨ荳閾ｴ縺輔○繧具ｼ・    // 縺薙ｌ縺ｫ繧医ｊ縲∫判髱｢荳翫・荳ｦ縺ｳ鬆・ｼ・tems縺ｮ鬆・ｺ擾ｼ峨′豁｣縺ｧ縺ゅｋ縺ｨ縺・≧蜑肴署縺ｧ豈埼寔蝗｣繧剃ｽ懊ｊ縺ｾ縺・

      const currentTabItemsForMove = items.filter((item) => item.eventDate === currentEventDate);

      // 菫ｮ豁｣3: 陦ｨ遉ｺ縺輔ｌ縺ｦ縺・ｋ縲悟呵｣懊Μ繧ｹ繝医阪→螳悟・縺ｫ蜷後§繝ｭ繧ｸ繝・け縺ｧ繝ｪ繧ｹ繝医ｒ蜀肴ｧ狗ｯ峨☆繧・    // 1. 譌｢縺ｫ蟾ｦ蛻励↓縺ゅｋ繧ゅ・繧帝勁螟・

      let candidateItems = currentTabItemsForMove.filter((item) => !executeIdsSet.has(item.id));

      // 2. 繝悶Ο繝・け繝輔ぅ繝ｫ繧ｿ縺碁←逕ｨ縺輔ｌ縺ｦ縺・ｋ蝣ｴ蜷医・縺昴ｌ繧る←逕ｨ・郁ｦ九∴縺ｦ縺・↑縺・い繧､繝・Β縺ｯ遘ｻ蜍輔＆縺帙↑縺・ｻ墓ｧ倥・蝣ｴ蜷茨ｼ・    // 繧ゅ＠縲瑚ｦ九∴縺ｦ縺・↑縺・′驕ｸ謚槭＆繧後※縺・ｋ繧｢繧､繝・Β縲阪ｂ遘ｻ蜍輔＆縺帙◆縺・ｴ蜷医・縺薙・繝悶Ο繝・け繧貞､悶＠縺ｾ縺吶′縲・    // 騾壼ｸｸ縺ｯ縲瑚ｦ九∴縺ｦ縺・ｋ鬆・ｺ上阪ｒ邯ｭ謖√☆繧九◆繧√√％縺ｮ繝輔ぅ繝ｫ繧ｿ繧ょ性繧√ｋ縺ｮ縺碁←蛻・〒縺吶・

      if (selectedBlockFilters.size > 0) {
        candidateItems = candidateItems.filter((item) => selectedBlockFilters.has(item.block));
      }

      // 菫ｮ豁｣4: 蜀肴ｧ狗ｯ峨＠縺溘檎判髱｢縺ｨ蜷後§鬆・ｺ上・繝ｪ繧ｹ繝・candidateItems)縲阪ｒ蝓ｺ貅悶↓縺励※縲・    // 驕ｸ謚槭＆繧後◆ID縺悟性縺ｾ繧後※縺・ｋ縺九メ繧ｧ繝・け縺励※謚ｽ蜃ｺ縺吶ｋ縲・    // 縺薙ｌ縺ｫ繧医ｊ縲（temIds・亥ｼ墓焚・峨・鬆・ｺ擾ｼ磯∈謚樣・↑縺ｩ・峨↓髢｢菫ゅ↑縺上√Μ繧ｹ繝井ｸ翫・荳翫°繧我ｸ九・鬆・ｺ上〒謚ｽ蜃ｺ縺輔ｌ繧九・

      const itemIdsSet = new Set(itemIds);
      const itemsToMove = candidateItems.filter((item) => itemIdsSet.has(item.id));
      const orderedItemIds = itemsToMove.map((item) => item.id);

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const currentDayItems = [...(eventItems[currentEventDate] || [])];

        // 譌｢蟄倥・繧｢繧､繝・Β繧剃ｿ晄戟縺励∵眠縺励＞繧｢繧､繝・Β繧呈忰蟆ｾ縺ｫ霑ｽ蜉・育判髱｢荳翫・鬆・ｺ上ｒ邯ｭ謖√＠縺殪rderedItemIds繧剃ｽｿ逕ｨ・・

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

      // 遽・峇驕ｸ謚槭・襍ｷ轤ｹ繝ｻ邨らせ縺檎ｧｻ蜍募ｯｾ雎｡縺ｫ蜷ｫ縺ｾ繧後※縺・ｋ蝣ｴ蜷医∫ｯ・峇驕ｸ謚槭ｒ繝ｪ繧ｻ繝・ヨ

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

  // 繝｢繝ｼ繝峨ｒ逶ｴ謗･險ｭ螳壹☆繧矩未謨ｰ

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

      // 髮・ｸｭ繝｢繝ｼ繝我ｻ･螟悶↓蛻・ｊ譖ｿ縺医◆蝣ｴ蜷医√・繝・・陦ｨ遉ｺ迥ｶ諷九ｒ繝ｪ繧ｻ繝・ヨ

      if (mode !== 'focus') {
        setFocusModeMapVisible(false);
      }
      // 繝｢繝ｼ繝牙・譖ｿ譎ゅ↓繧ｪ繝ｼ繝舌・繝ｩ繧､繝峨ｒ繝ｪ繧ｻ繝・ヨ
      setUiVisibilityOverride(false);
      setUiSettingsPanelOpen(false);

      // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ蜈医・繧｢繧､繝・ΒID縺梧欠螳壹＆繧後※縺・ｋ蝣ｴ蜷・

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
        alert('An event with the same name already exists. Please choose another name.');
        return;
      }

      setEventLists((prev) => renameRecordKey(prev, eventToRename, newName));

      setEventMetadata((prev) => renameRecordKey(prev, eventToRename, newName));

      setDayModes((prev) => renameRecordKey(prev, eventToRename, newName));

      setExecuteModeItems((prev) => renameRecordKey(prev, eventToRename, newName));

      // 繝槭ャ繝励ョ繝ｼ繧ｿ縺ｮ蜷榊燕螟画峩

      setMapData((prev) => renameRecordKey(prev, eventToRename, newName));

      // 繝ｫ繝ｼ繝郁ｨｭ螳壹・蜷榊燕螟画峩

      setRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));

      // 繝帙・繝ｫ螳夂ｾｩ縺ｮ蜷榊燕螟画峩

      setHallDefinitions((prev) => renameRecordKey(prev, eventToRename, newName));

      // 繝帙・繝ｫ繝ｫ繝ｼ繝郁ｨｭ螳壹・蜷榊燕螟画峩

      setHallRouteSettings((prev) => renameRecordKey(prev, eventToRename, newName));

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
    // 繝輔ぅ繝ｫ繧ｿ螟画峩譎ゅ↓譛霑大､画峩縺輔ｌ縺溘い繧､繝・Β縺ｮ霑ｽ霍｡繧偵Μ繧ｻ繝・ヨ
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

      // 蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮ縺ｿ繧貞叙蠕・

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

      // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺ｯ縺昴・縺ｾ縺ｾ縲∝呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮ縺ｿ荳ｦ縺ｳ譖ｿ縺・

      const executeItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && executeIds.has(item.id),
      );

      // 螳溯｡後Δ繝ｼ繝牙・縺ｨ蛟呵｣懊Μ繧ｹ繝医ｒ邨仙粋・亥ｮ溯｡後Δ繝ｼ繝牙・縺悟・・・

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

    // 螳溯｡後Δ繝ｼ繝峨い繧､繝・Β縺九ｉ繧ょ炎髯､

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

      // 迴ｾ蝨ｨ縺ｮ蛻励・繧｢繧､繝・Β繧堤峩謗･險育ｮ・

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
          // 繝悶Ο繝・け繝輔ぅ繝ｫ繧ｿ繧帝←逕ｨ
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
          // 驕ｸ謚櫁ｧ｣髯､譎ゅ・襍ｷ轤ｹ繝ｻ邨らせ繧偵Μ繧ｻ繝・ヨ
          if (rangeStart?.itemId === itemId && rangeStart.columnType === currentColumnType) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (rangeEnd?.itemId === itemId && rangeEnd.columnType === currentColumnType) {
            setRangeEnd(null);
          }
        } else {
          newSet.add(itemId);

          // 襍ｷ轤ｹ縺梧悴險ｭ螳壹・蝣ｴ蜷医√∪縺溘・逡ｰ縺ｪ繧句・縺ｮ蝣ｴ蜷医・襍ｷ轤ｹ繧定ｨｭ螳・

          if (!rangeStart || rangeStart.columnType !== currentColumnType) {
            setRangeStart({ itemId, columnType: currentColumnType });
            setRangeEnd(null);
          } else {
            // 襍ｷ轤ｹ縺瑚ｨｭ螳壽ｸ医∩縺ｧ縲∝酔縺伜・縺ｮ蝣ｴ蜷・                // 襍ｷ轤ｹ縺ｮ逶ｴ荳翫∪縺溘・逶ｴ荳九・繧｢繧､繝・Β縺九メ繧ｧ繝・け
            const startIndex = currentItems.findIndex((item) => item.id === rangeStart.itemId);
            const currentIndex = currentItems.findIndex((item) => item.id === itemId);

            // 襍ｷ轤ｹ縺ｮ逶ｴ荳翫∪縺溘・逶ｴ荳九〒縺ｪ縺・ｴ蜷医・縺ｿ邨らせ縺ｨ縺励※險ｭ螳・

            if (startIndex !== -1 && currentIndex !== -1) {
              const isAdjacent = Math.abs(startIndex - currentIndex) === 1;
              if (!isAdjacent) {
                setRangeEnd({ itemId, columnType: currentColumnType });
              } else {
                // 逶ｴ荳翫∪縺溘・逶ｴ荳九・蝣ｴ蜷医・邨らせ繧偵Μ繧ｻ繝・ヨ
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

      // 蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮ縺ｿ繧貞叙蠕・

      const candidateItems = allItems.filter(
        (item) => item.eventDate === currentTabKey && !executeIds.has(item.id),
      );

      // 繝悶Ο繝・け繝輔ぅ繝ｫ繧ｿ繧帝←逕ｨ

      let filteredCandidateItems = candidateItems;
      if (selectedBlockFilters.size > 0) {
        filteredCandidateItems = candidateItems.filter((item) =>
          selectedBlockFilters.has(item.block),
        );
      }

      if (filteredCandidateItems.length === 0) return prev;

      // 繝翫Φ繝舌・縺ｧ繧ｽ繝ｼ繝・

      const sortedCandidateItems = [...filteredCandidateItems].sort((a, b) => {
        const comparison = a.number.localeCompare(b.number, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      // 蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮID縺ｨ鬆・ｺ上ｒ繝槭ャ繝・

      const sortedCandidateMap = new Map(
        sortedCandidateItems.map((item, index) => [item.id, { item, sortIndex: index }]),
      );

      // 蜈・・繝ｪ繧ｹ繝医ｒ邯ｭ謖√＠縺､縺､縲∝呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺ｮ縺ｿ繧偵た繝ｼ繝磯・↓蜀埼・鄂ｮ

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

      // 繧ｽ繝ｼ繝医う繝ｳ繝・ャ繧ｯ繧ｹ縺ｧ繧ｽ繝ｼ繝・
      candidateItemsToSort.sort((a, b) => a.sortIndex - b.sortIndex);

      // 蜈・・鬆・ｺ上ｒ菫晄戟縺励▽縺､縲∝呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β繧偵た繝ｼ繝磯・↓驟咲ｽｮ

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

  // 遽・峇蜀・・繧｢繧､繝・Β繧剃ｸ諡ｬ縺ｧ繝√ぉ繝・け/繝√ぉ繝・け隗｣髯､縺吶ｋ髢｢謨ｰ

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

      // 迴ｾ蝨ｨ縺ｮ蛻励・繧｢繧､繝・Β繧堤峩謗･險育ｮ・

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
        // 繝悶Ο繝・け繝輔ぅ繝ｫ繧ｿ繧帝←逕ｨ
        if (selectedBlockFilters.size > 0) {
          filtered = filtered.filter((item) => selectedBlockFilters.has(item.block));
        }
        currentItems = filtered;
      }

      // 繝帙・繝ｫ螳夂ｾｩ縺ｨ繝槭ャ繝励ョ繝ｼ繧ｿ繧貞叙蠕励＠縺ｦ繧ｰ繝ｫ繝ｼ繝怜喧

      const halls = getHallsForDate(currentEventDate);
      const currentMapData = getMapDataForDate(currentEventDate);

      // 繧ｰ繝ｫ繝ｼ繝怜喧縺梧怏蜉ｹ縺ｪ蝣ｴ蜷医∝酔荳繧ｰ繝ｫ繝ｼ繝怜・縺ｮ繧｢繧､繝・Β縺ｮ縺ｿ繧貞ｯｾ雎｡縺ｫ縺吶ｋ

      if (halls.length > 0 && currentMapData) {
        // 繧｢繧､繝・Β縺ｮ繝帙・繝ｫID繧貞叙蠕励☆繧九・繝ｫ繝代・
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

          // 螟夊ｧ貞ｽ｢蜀・愛螳・

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

        // 繧ｰ繝ｫ繝ｼ繝悠D繧堤函謌舌☆繧九・繝ｫ繝代・

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

        // rangeStart縺ｨrangeEnd縺ｮ繧ｰ繝ｫ繝ｼ繝悠D繧堤｢ｺ隱・

        const startItem = currentItems.find((item) => item.id === rangeStart.itemId);
        const endItem = currentItems.find((item) => item.id === rangeEnd.itemId);

        if (!startItem || !endItem) return;

        const startGroupId = getItemGroupId(startItem);
        const endGroupId = getItemGroupId(endItem);

        // 逡ｰ縺ｪ繧九げ繝ｫ繝ｼ繝励・蝣ｴ蜷医・菴輔ｂ縺励↑縺・

        if (startGroupId !== endGroupId) {
          return;
        }

        // 蜷後§繧ｰ繝ｫ繝ｼ繝怜・縺ｮ繧｢繧､繝・Β縺ｮ縺ｿ繧貞ｯｾ雎｡縺ｫ縺吶ｋ

        const groupItems = currentItems.filter((item) => getItemGroupId(item) === startGroupId);

        const startIndex = groupItems.findIndex((item) => item.id === rangeStart.itemId);
        const endIndex = groupItems.findIndex((item) => item.id === rangeEnd.itemId);

        if (startIndex === -1 || endIndex === -1) return;

        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);
        const rangeItems = groupItems.slice(minIndex, maxIndex + 1);

        // 遽・峇蜀・・繧｢繧､繝・Β縺悟・縺ｦ繝√ぉ繝・け貂医∩縺九メ繧ｧ繝・け

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

      // 繧ｰ繝ｫ繝ｼ繝怜喧縺檎┌蜉ｹ縺ｪ蝣ｴ蜷医・蠕捺擂縺ｮ繝ｭ繧ｸ繝・け

      const startIndex = currentItems.findIndex((item) => item.id === rangeStart.itemId);
      const endIndex = currentItems.findIndex((item) => item.id === rangeEnd.itemId);

      if (startIndex === -1 || endIndex === -1) return;

      const minIndex = Math.min(startIndex, endIndex);
      const maxIndex = Math.max(startIndex, endIndex);
      const rangeItems = currentItems.slice(minIndex, maxIndex + 1);

      // 遽・峇蜀・・繧｢繧､繝・Β縺悟・縺ｦ繝√ぉ繝・け貂医∩縺九メ繧ｧ繝・け

      setSelectedItemIds((prev) => {
        const allSelected = rangeItems.every((item) => prev.has(item.id));
        const newSet = new Set(prev);
        if (allSelected) {
          // 蜈ｨ縺ｦ繝√ぉ繝・け貂医∩縺ｮ蝣ｴ蜷医・繝√ぉ繝・け繧貞､悶☆
          // 繝√ぉ繝・け隗｣髯､譎ゅ・襍ｷ轤ｹ繝ｻ邨らせ繧ゅΜ繧ｻ繝・ヨ・育判髱｢蜿ｳ荳翫・笨悶・繧ｿ繝ｳ縺ｨ蜷梧ｧ倥・蜍穂ｽ懶ｼ・
          rangeItems.forEach((item) => newSet.delete(item.id));
          setRangeStart(null);
          setRangeEnd(null);
        } else {
          // 譛ｪ繝√ぉ繝・け縺ｮ繧｢繧､繝・Β縺後≠繧句ｴ蜷医・蜈ｨ縺ｦ繝√ぉ繝・け繧貞・繧後ｋ
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
        // 邱ｨ髮・Δ繝ｼ繝・ 驕ｸ謚槭＆繧後◆繧｢繧､繝・Β縺悟ｮ溯｡後Δ繝ｼ繝牙・縺句呵｣懊Μ繧ｹ繝医°繧貞愛螳・
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        const selectedItems = items.filter((item) => selectedItemIds.has(item.id));
        const isInExecuteColumn = selectedItems.some((item) => executeIds.has(item.id));
        const isInCandidateColumn = selectedItems.some((item) => !executeIds.has(item.id));

        if (isInExecuteColumn && !isInCandidateColumn) {
          // 螳溯｡後Δ繝ｼ繝牙・縺ｮ縺ｿ
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
          // 蛟呵｣懊Μ繧ｹ繝医・縺ｿ
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

            // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺ｯ縺昴・縺ｾ縺ｾ縲∝呵｣懊Μ繧ｹ繝医・縺ｿ荳ｦ縺ｳ譖ｿ縺・

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
        // 螳溯｡後Δ繝ｼ繝・ 騾壼ｸｸ繧ｽ繝ｼ繝・
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

  // 繧ｨ繧ｯ繧ｹ繝昴・繝医が繝励す繝ｧ繝ｳ繝繧､繧｢繝ｭ繧ｰ繧定｡ｨ遉ｺ

  const handleExportEvent = useCallback(
    (eventName: string) => {
      const itemsToExport = eventLists[eventName];
      if (!hasExportableItems(itemsToExport)) {
        alert('No items available to export.');
        return;
      }
      setExportEventName(eventName);
      setShowExportOptions(true);
    },
    [eventLists],
  );

  // 螳滄圀縺ｮ繧ｨ繧ｯ繧ｹ繝昴・繝亥・逅・ｼ・lsx蠖｢蠑擾ｼ・

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
        alert('Failed to export items.');
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

  // 繧ｨ繧ｯ繧ｹ繝昴・繝医ヵ繧｡繧､繝ｫ縺ｮ繧､繝ｳ繝昴・繝亥・逅・

  const handleExportFileImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      // input 繧偵Μ繧ｻ繝・ヨ
      e.target.value = '';

      try {
        const result = await importFromXlsx(file);

        if (!result.success) {
          alert(`繧､繝ｳ繝昴・繝医↓螟ｱ謨励＠縺ｾ縺励◆:\n${result.errors.join('\n')}`);
          return;
        }

        if (result.items.length === 0) {
          alert('No items found in the imported file.');
          return;
        }

        // 繧､繝吶Φ繝亥錐縺ｮ驥崎､・メ繧ｧ繝・け - 蜷悟錐縺後≠繧句ｴ蜷医・荳頑嶌縺肴峩譁ｰ
        const importedData = toImportedEventData(result);
        const eventName = importedData.eventName;
        const isUpdate = !!eventLists[eventName];

        // 繧｢繧､繝・Β繧剃ｿ晏ｭ・

        setEventLists((prev) => upsertRecordKey(prev, eventName, importedData.items));

        // 繝｡繧ｿ繝・・繧ｿ繧剃ｿ晏ｭ・

        if (importedData.metadata) {
          const metadata = importedData.metadata;
          setEventMetadata((prev) => upsertRecordKey(prev, eventName, metadata));
        }

        // 驟咲ｽｮ諠・ｱ繧剃ｿ晏ｭ・

        if (importedData.executeModeItems) {
          const executeItems = importedData.executeModeItems;
          setExecuteModeItems((prev) => upsertRecordKey(prev, eventName, executeItems));
        }
        if (importedData.dayModes) {
          const importedDayModes = importedData.dayModes;
          setDayModes((prev) => upsertRecordKey(prev, eventName, importedDayModes));
        }

        // 繝槭ャ繝励ョ繝ｼ繧ｿ繧剃ｿ晏ｭ・

        if (importedData.mapData) {
          const importedMapData = importedData.mapData;
          setMapData((prev) => upsertRecordKey(prev, eventName, importedMapData));
        }

        // 繝ｫ繝ｼ繝郁ｨｭ螳壹ｒ菫晏ｭ・

        if (importedData.routeSettings) {
          const importedRouteSettings = importedData.routeSettings;
          setRouteSettings((prev) => upsertRecordKey(prev, eventName, importedRouteSettings));
        }

        // 繝帙・繝ｫ螳夂ｾｩ繧剃ｿ晏ｭ・

        if (importedData.hallDefinitions) {
          const importedHallDefinitions = importedData.hallDefinitions;
          setHallDefinitions((prev) => upsertRecordKey(prev, eventName, importedHallDefinitions));
        }

        // 繝帙・繝ｫ繝ｫ繝ｼ繝郁ｨｭ螳壹ｒ菫晏ｭ・

        if (importedData.hallRouteSettings) {
          const importedHallRouteSettings = importedData.hallRouteSettings;
          setHallRouteSettings((prev) =>
            upsertRecordKey(prev, eventName, importedHallRouteSettings),
          );
        }

        // 繧ｨ繝ｩ繝ｼ縺後≠繧後・陦ｨ遉ｺ

        alert(
          buildImportCompletionMessage({
            errors: importedData.errors,
            eventName,
            isUpdate,
            itemCount: importedData.items.length,
          }),
        );

        // 繧､繝ｳ繝昴・繝医＠縺溘う繝吶Φ繝医ｒ驕ｸ謚・

        setActiveEventName(eventName);
        setActiveTab(resolveEventListTab(importedData.items));
      } catch (error) {
        console.error('Import error:', error);
        alert('Failed to import items. Please check the file format.');
      }
    },
    [eventLists],
  );

  // 繧｢繧､繝・Β譖ｴ譁ｰ讖溯・

  const handleUpdateEvent = useCallback(
    async (eventName: string, urlOverride?: { url: string; sheetName: string }) => {
      const metadata = eventMetadata[eventName];
      const source = resolveSpreadsheetSource(metadata, urlOverride);

      if (!source) {
        alert('Please set a spreadsheet URL first.');
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

    // 蜑企勁縺輔ｌ縺溘い繧､繝・Β繧貞ｮ溯｡後Δ繝ｼ繝峨い繧､繝・Β縺九ｉ繧ょ炎髯､

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
    alert('Items updated.');
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

  // 繝槭ャ繝励ョ繝ｼ繧ｿ蜿悶ｊ霎ｼ縺ｿ

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

    // 繝繧､繧｢繝ｭ繧ｰ繧帝幕縺・

    setMapImportPendingFile(file);
    setMapImportPendingEventName(eventName);
    setMapImportDialogOpen(true);

    // 繝輔ぃ繧､繝ｫ蜈･蜉帙ｒ繝ｪ繧ｻ繝・ヨ
    e.target.value = '';
  }, []);

  // 繝槭ャ繝怜叙繧願ｾｼ縺ｿ繝繧､繧｢繝ｭ繧ｰ縺九ｉ縺ｮ蜿悶ｊ霎ｼ縺ｿ遒ｺ螳・

  const handleMapImportConfirm = useCallback(
    (parsedData: Record<string, DayMapData>, settings: BlockDetectionSettings) => {
      const eventName = mapImportPendingEventName;
      if (!eventName) return;

      // 險ｭ螳壹ｒlocalStorage縺ｫ菫晏ｭ・
      saveBlockDetectionSettings(eventName, settings);

      // 繝槭ャ繝励ョ繝ｼ繧ｿ繧剃ｿ晏ｭ・

      setMapData((prev) => ({
        ...prev,
        [eventName]: {
          ...(prev[eventName] || {}),
          ...parsedData,
        },
      }));

      const mapCount = Object.keys(parsedData).length;

      // 譛蛻昴・繝槭ャ繝励ち繝悶↓蛻・ｊ譖ｿ縺・

      const firstMapName = Object.keys(parsedData)[0];
      if (firstMapName) {
        setActiveTab(firstMapName);
      }

      // 繝繧､繧｢繝ｭ繧ｰ繧帝哩縺倥ｋ

      setMapImportDialogOpen(false);
      setMapImportPendingFile(null);
      setMapImportPendingEventName('');

      alert(`${mapCount} map tabs imported.`);
    },
    [mapImportPendingEventName],
  );

  // 繝槭ャ繝怜叙繧願ｾｼ縺ｿ繝繧､繧｢繝ｭ繧ｰ縺ｮ繧ｭ繝｣繝ｳ繧ｻ繝ｫ

  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
  }, []);

  // 繝槭ャ繝励ン繝･繝ｼ縺ｧ縺ｮ險ｪ蝠丞・霑ｽ蜉

  const handleAddToExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      // 繝槭ャ繝怜錐縺九ｉ蜿ょ刈譌･繧貞叙蠕・

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      // 繧｢繧､繝・Β縺ｮ繝帙・繝ｫID繧貞叙蠕・

      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      // 繝帙・繝ｫ螳夂ｾｩ繧貞叙蠕・

      const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
      const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[activeTab] || {
        hallOrder: [],
        hallVisitLists: [],
      };

      // 繧｢繧､繝・Β縺ｮ繝悶Ο繝・け縺九ｉ繝帙・繝ｫID繧堤音螳・

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

        // 譌｢縺ｫ霑ｽ蜉縺輔ｌ縺ｦ縺・ｋ蝣ｴ蜷医・菴輔ｂ縺励↑縺・

        if (dayItems.includes(itemId)) return prev;

        // 繝帙・繝ｫ縺檎音螳壹〒縺阪↑縺・ｴ蜷医・譛ｫ蟆ｾ縺ｫ霑ｽ蜉

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

        // 繝帙・繝ｫ鬆・ｺ上ｒ蜿門ｾ暦ｼ郁ｨｭ螳壹′縺ｪ縺代ｌ縺ｰ繝帙・繝ｫ縺ｮ螳夂ｾｩ鬆・ｼ・

        const hallOrder =
          hallRouteSettingsForMap.hallOrder.length > 0
            ? hallRouteSettingsForMap.hallOrder
            : halls.map((h) => h.id);

        // 蜷・い繧､繝・Β縺ｮ繝帙・繝ｫID繧偵・繝・・

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

        // 蜷後§繝帙・繝ｫ縺ｮ譛蠕後・菴咲ｽｮ繧呈爾縺・

        let insertIndex = dayItems.length; // 繝・ヵ繧ｩ繝ｫ繝医・譛ｫ蟆ｾ
        const itemHallIndex = hallOrder.indexOf(itemHallId);

        if (itemHallIndex >= 0) {
          // 蜷後§繝帙・繝ｫ縺ｮ譛蠕後・繧｢繧､繝・Β縺ｮ菴咲ｽｮ繧呈爾縺・
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
            // 蜷後§繝帙・繝ｫ縺ｮ繧｢繧､繝・Β縺後≠繧句ｴ蜷医√◎縺ｮ谺｡縺ｫ謖ｿ蜈･
            insertIndex = lastSameHallIndex + 1;
          } else if (firstLaterHallIndex >= 0) {
            // 蜷後§繝帙・繝ｫ縺ｮ繧｢繧､繝・Β縺後↑縺・′縲∝ｾ後・繝帙・繝ｫ縺ｮ繧｢繧､繝・Β縺後≠繧句ｴ蜷医√◎縺ｮ蜑阪↓謖ｿ蜈･
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

  // 繝槭ャ繝励ン繝･繝ｼ縺ｧ縺ｮ險ｪ蝠丞・霑ｽ蜉・井ｽ咲ｽｮ謖・ｮ壹≠繧奇ｼ・

  const handleAddToExecuteListFromMapAtPosition = useCallback(
    (itemId: string, referenceItemId: string, position: 'before' | 'after') => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];

        // 譌｢縺ｫ霑ｽ蜉縺輔ｌ縺ｦ縺・ｋ蝣ｴ蜷医・菴輔ｂ縺励↑縺・

        if (dayItems.includes(itemId)) return prev;

        // 蜿ら・繧｢繧､繝・Β縺ｮ菴咲ｽｮ繧呈爾縺・

        const refIndex = dayItems.indexOf(referenceItemId);
        if (refIndex < 0) {
          // 蜿ら・繧｢繧､繝・Β縺瑚ｦ九▽縺九ｉ縺ｪ縺・ｴ蜷医・譛ｫ蟆ｾ縺ｫ霑ｽ蜉
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

  // 繝槭ャ繝励ン繝･繝ｼ縺ｧ縺ｮ險ｪ蝠丞・蜑企勁

  const handleRemoveFromExecuteListFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      // 繝槭ャ繝怜錐縺九ｉ蜿ょ刈譌･繧貞叙蠕・

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
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

  // 繝槭ャ繝励ン繝･繝ｼ縺九ｉ縺ｮ譁ｰ隕上い繧､繝・Β霑ｽ蜉

  const handleAddNewItemFromMap = useCallback(
    (eventDate: string, block: string, number: string) => {
      // 蛻晄悄蛟､繧定ｨｭ螳壹＠縺ｦ繧｢繧､繝・Β霑ｽ蜉繧ｿ繝悶↓驕ｷ遘ｻ
      setNewItemDefaults({ eventDate, block, number });
      setItemToEdit(null);
      setActiveTab('import');
    },
    [],
  );

  // 髮・ｸｭ繝｢繝ｼ繝峨°繧峨・逶ｴ謗･繧｢繧､繝・Β霑ｽ蜉

  const handleAddItemFromFocusMode = useCallback(
    (newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => {
      if (!activeEventName) return;

      // 雉ｼ蜈･迥ｶ諷九ｒ豎ｺ螳夲ｼ域欠螳壹′縺ｪ縺代ｌ縺ｰ'None'・・

      const purchaseStatus = newItem.purchaseStatus || 'None';

      // 譁ｰ縺励＞繧｢繧､繝・Β繧剃ｽ懈・

      const item: ShoppingItem = {
        ...newItem,
        id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        purchaseStatus,
        source: 'app' as const, // 繧｢繝励Μ縺九ｉ縺ｮ霑ｽ蜉
        protectionLevel: 'full' as const, // 螳悟・菫晁ｭｷ
      };

      // 繧｢繧､繝・Β繧定ｿｽ蜉

      setEventLists((prev) => ({
        ...prev,
        [activeEventName]: [...(prev[activeEventName] || []), item],
      }));

      // 雉ｼ蜈･貂医・蝣ｴ蜷医・蛟呵｣懊Μ繧ｹ繝医・縺ｿ縺ｫ霑ｽ蜉・亥ｮ溯｡悟・縺ｫ縺ｯ霑ｽ蜉縺励↑縺・ｼ・

      if (purchaseStatus === 'Purchased') {
        return;
      }

      // 蠕悟屓縺励・驕・盾縺ｮ蝣ｴ蜷医・螳溯｡悟・縺ｮ驕ｩ蛻・↑繝輔ぉ繝ｼ繧ｺ縺ｫ譛遏ｭ邨瑚ｷｯ菴咲ｽｮ縺ｧ霑ｽ蜉

      const dayName = newItem.eventDate;
      const mapTab = `${dayName}Map`;

      setExecuteModeItems((prev) => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];
        const allItems = eventLists[activeEventName] || [];
        const itemsMap = new Map(allItems.map((i) => [i.id, i]));
        itemsMap.set(item.id, item); // 譁ｰ繧｢繧､繝・Β繧りｿｽ蜉

        // 繝槭ャ繝励ョ繝ｼ繧ｿ縺ｨ繝帙・繝ｫ諠・ｱ繧貞叙蠕・

        const currentMapData = mapData[activeEventName]?.[mapTab];
        const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
        const hallSettings = hallRouteSettings[activeEventName]?.[mapTab];

        // 繝帙・繝ｫ鬆・ｺ上ｒ蜿門ｾ・

        const hallOrder = hallSettings?.hallOrder || halls.map((h) => h.id);

        // 繧｢繧､繝・Β縺ｮ蠎ｧ讓吶ｒ蜿門ｾ励☆繧九・繝ｫ繝代・

        const getItemPosition = (id: string): { row: number; col: number } | null => {
          const targetItem = itemsMap.get(id);
          if (!targetItem || !currentMapData) return null;

          const blockName = targetItem.block?.trim() || '';
          const targetBlock = currentMapData.blocks.find((b) => b.name === blockName);
          if (!targetBlock) return null;

          // 繝翫Φ繝舌・繧ｻ繝ｫ縺ｮ蠎ｧ讓吶ｒ謗｢縺・

          const numberCells = targetBlock.numberCells || [];
          const normalizedNumber = targetItem.number.toLowerCase();

          for (const nc of numberCells) {
            if (String(nc.value).toLowerCase() === normalizedNumber) {
              return { row: nc.row, col: nc.col };
            }
          }

          // 隕九▽縺九ｉ縺ｪ縺・ｴ蜷医・繝悶Ο繝・け縺ｮ荳ｭ蠢・ｒ霑斐☆

          return {
            row: (targetBlock.startRow + targetBlock.endRow) / 2,
            col: (targetBlock.startCol + targetBlock.endCol) / 2,
          };
        };

        // 2轤ｹ髢薙・霍晞屬繧定ｨ育ｮ・

        const calcDistance = (
          pos1: { row: number; col: number },
          pos2: { row: number; col: number },
        ): number => {
          return Math.abs(pos1.row - pos2.row) + Math.abs(pos1.col - pos2.col);
        };

        // 蜷後§繝輔ぉ繝ｼ繧ｺ縺ｮ繧｢繧､繝・Β縺ｮ繧､繝ｳ繝・ャ繧ｯ繧ｹ繧貞庶髮・

        const phaseStatus = purchaseStatus; // 'Postpone' or 'Late'
        const samePhaseIndices: number[] = [];

        for (let i = 0; i < dayItems.length; i++) {
          const existingItem = itemsMap.get(dayItems[i]);
          if (existingItem && existingItem.purchaseStatus === phaseStatus) {
            samePhaseIndices.push(i);
          }
        }

        // 譁ｰ繧｢繧､繝・Β縺ｮ蠎ｧ讓吶ｒ蜿門ｾ・

        const newItemPos = getItemPosition(item.id);

        if (samePhaseIndices.length === 0 || !newItemPos) {
          // 蜷後§繝輔ぉ繝ｼ繧ｺ縺ｮ繧｢繧､繝・Β縺後↑縺・ｴ蜷医・譛ｫ蟆ｾ縺ｫ霑ｽ蜉
          dayItems.push(item.id);
        } else {
          // 蜷後§繝輔ぉ繝ｼ繧ｺ縺ｮ繧｢繧､繝・Β髢薙〒譛遏ｭ邨瑚ｷｯ縺ｫ縺ｪ繧倶ｽ咲ｽｮ繧呈爾縺・
          let bestInsertIndex = samePhaseIndices[samePhaseIndices.length - 1] + 1;
          let minTotalDistance = Infinity;

          // 蜷・諺蜈･菴咲ｽｮ縺ｧ縺ｮ邱剰ｷ晞屬繧定ｨ育ｮ・

          for (let insertIdx = 0; insertIdx <= samePhaseIndices.length; insertIdx++) {
            let totalDistance = 0;

            // 謖ｿ蜈･菴咲ｽｮ縺ｮ蜑阪・繧｢繧､繝・Β

            if (insertIdx > 0) {
              const prevItemId = dayItems[samePhaseIndices[insertIdx - 1]];
              const prevPos = getItemPosition(prevItemId);
              if (prevPos) {
                totalDistance += calcDistance(prevPos, newItemPos);
              }
            }

            // 謖ｿ蜈･菴咲ｽｮ縺ｮ蠕後・繧｢繧､繝・Β

            if (insertIdx < samePhaseIndices.length) {
              const nextItemId = dayItems[samePhaseIndices[insertIdx]];
              const nextPos = getItemPosition(nextItemId);
              if (nextPos) {
                totalDistance += calcDistance(newItemPos, nextPos);
              }

              // 蜈・・・蜑榊ｾ後・霍晞屬繧貞ｼ輔￥・域眠繧｢繧､繝・Β繧呈諺蜈･縺吶ｋ縺薙→縺ｧ荳崎ｦ√↓縺ｪ繧玖ｷ晞屬・・

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
              // 螳滄圀縺ｮ謖ｿ蜈･菴咲ｽｮ繧定ｨ育ｮ・
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
    [activeEventName, eventLists, mapData, hallDefinitions, hallRouteSettings],
  );

  // 繝槭ャ繝励ン繝･繝ｼ縺ｧ縺ｮ蜈磯ｭ遘ｻ蜍・

  const handleMoveToFirstFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
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

  // 繝槭ャ繝励ン繝･繝ｼ縺ｧ縺ｮ譛ｫ蟆ｾ遘ｻ蜍・

  const handleMoveToLastFromMap = useCallback(
    (itemId: string) => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
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

  // 迴ｾ蝨ｨ縺ｮ繝槭ャ繝励↓蟇ｾ蠢懊☆繧句盾蜉譌･縺ｮ螳溯｡悟・繧｢繧､繝・ΒID繧貞叙蠕・

  const currentMapExecuteItemIds = useMemo(() => {
    if (!activeEventName || !isMapTab) return [];

    const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    return executeModeItems[activeEventName]?.[dayName] || [];
  }, [activeEventName, activeTab, isMapTab, executeModeItems]);

  // 迴ｾ蝨ｨ縺ｮ繧ｿ繝悶・蜿ょ刈譌･縺ｫ隧ｲ蠖薙☆繧九い繧､繝・Β繧貞叙蠕・

  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter((item) => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

  // 繝槭ャ繝励ち繝悶Γ繝九Η繝ｼ縺ｮ迥ｶ諷・

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

  // 繝槭ャ繝励ン繝･繝ｼ縺ｮ繧ｳ繝ｳ繝医Ο繝ｼ繝ｫ逕ｨ迥ｶ諷具ｼ医・繝・ム繝ｼ縺九ｉ蛻ｶ蠕｡・・

  const [mapSelectedHallId, setMapSelectedHallId] = useState<string>('all');
  const [mapIsRouteVisible, setMapIsRouteVisible] = useState(true);
  const [mapIsHallOrderOpen, setMapIsHallOrderOpen] = useState(false);
  const [mapHallSelectorOpen, setMapHallSelectorOpen] = useState(false);
  const [mapSmartInsertEnabled, setMapSmartInsertEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertEnabled');
      return saved !== null ? saved === 'true' : true; // 繝・ヵ繧ｩ繝ｫ繝・N
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

  // 繧ｹ繝槭・繝井ｽ咲ｽｮ驕ｸ謚槭・險ｭ螳壹ｒ豌ｸ邯壼喧

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

  // 繝医・繧ｹ繝郁・蜍暮撼陦ｨ遉ｺ

  React.useEffect(() => {
    if (smartInsertToast) {
      const timer = setTimeout(() => setSmartInsertToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [smartInsertToast]);

  // 繧ｻ繝ｫ驕ｸ謚槭Δ繝ｼ繝峨・迥ｶ諷具ｼ医ヶ繝ｭ繝・け螳夂ｾｩ逕ｨ・・

  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
    clickedCells: { row: number; col: number }[];
    editingBlockData?: unknown;
  } | null>(null);

  // 繧ｻ繝ｫ驕ｸ謚槫ｮ御ｺ・凾縺ｫBlockDefinitionPanel縺ｫ貂｡縺吶ョ繝ｼ繧ｿ

  const [pendingCellSelection, setPendingCellSelection] = useState<{
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // 險ｪ蝠丞・繝ｪ繧ｹ繝医ヱ繝阪Ν繧帝幕縺・

  const openVisitListPanel = useCallback(
    (mapTab: string) => {
      if (!activeEventName) return;

      // 蟇ｾ蠢懊☆繧区律莉倥ｒ蜿門ｾ暦ｼ井ｾ具ｼ壹・譌･逶ｮ繝槭ャ繝励坂・縲・譌･逶ｮ縲搾ｼ・

      const dayMatch = mapTab.match(/^(.+)繝槭ャ繝・/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      // 螳溯｡悟・縺ｮ繧｢繧､繝・ΒID繧貞叙蠕・

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

      // 蜈・・鬆・ｺ上ｒ菫晏ｭ・

      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(mapTab);
      setVisitListHasUnsavedChanges(false);
      setVisitListPanelOpen(true);
    },
    [activeEventName, executeModeItems],
  );

  // 險ｪ蝠丞・繝ｪ繧ｹ繝郁｡ｨ遉ｺ荳ｭ縺ｫ繝槭ャ繝励ち繝悶ｒ蛻・ｊ譖ｿ縺医◆蝣ｴ蜷医∵眠縺励＞繝槭ャ繝励・險ｪ蝠丞・繝ｪ繧ｹ繝医↓蛻・ｊ譖ｿ縺・

  React.useEffect(() => {
    if (!visitListPanelOpen || !isMapTab || !activeEventName) return;
    // 迴ｾ蝨ｨ縺ｮ繝代ロ繝ｫ縺悟挨縺ｮ繝槭ャ繝励ち繝悶ｒ謖・＠縺ｦ縺・◆繧牙・繧頑崛縺・
    if (visitListPanelMapTab !== activeTab) {
      // 譛ｪ菫晏ｭ倥・螟画峩縺後≠繧句ｴ蜷医・閾ｪ蜍慕｢ｺ螳・
      if (visitListHasUnsavedChanges) {
        setVisitListHasUnsavedChanges(false);
      }
      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
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

  // 險ｪ蝠丞・繝ｪ繧ｹ繝医・鬆・ｺ上ｒ譖ｴ譁ｰ

  const handleVisitListOrderUpdate = useCallback(
    (newOrderItems: ShoppingItem[]) => {
      if (!visitListPanelMapTab || !activeEventName) return;

      const dayMatch = visitListPanelMapTab.match(/^(.+)繝槭ャ繝・/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];

      // 譁ｰ縺励＞鬆・ｺ上・ID驟榊・

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

  // 險ｪ蝠丞・繝ｪ繧ｹ繝医・遒ｺ螳・

  const handleVisitListConfirm = useCallback(() => {
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, []);

  // 險ｪ蝠丞・繝ｪ繧ｹ繝医・繧ｭ繝｣繝ｳ繧ｻ繝ｫ

  const handleVisitListCancel = useCallback(() => {
    if (!visitListPanelMapTab || !activeEventName) return;

    const dayMatch = visitListPanelMapTab.match(/^(.+)繝槭ャ繝・/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];

    // 蜈・・鬆・ｺ上↓謌ｻ縺・

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

  // 險ｪ蝠丞・繝ｪ繧ｹ繝医ヱ繝阪Ν繧帝哩縺倥ｋ・亥､画峩繧剃ｿ晄戟・・

  const handleVisitListClose = useCallback(() => {
    setVisitListPanelOpen(false);
    // 螻･豁ｴ縺ｨ迥ｶ諷九・菫晄戟・磯哩縺倥◆縺縺代〒縺ｯ遐ｴ譽・＠縺ｪ縺・ｼ・
  }, []);

  // 繝槭ャ繝励そ繝ｫ縺ｮ繝上う繝ｩ繧､繝・

  const handleHighlightMapCell = useCallback((row: number, col: number) => {
    setHighlightedMapCell({ row, col });
  }, []);

  const handleClearMapCellHighlight = useCallback(() => {
    setHighlightedMapCell(null);
  }, []);

  // 險ｪ蝠丞・繝ｪ繧ｹ繝育畑縺ｮ螳溯｡悟・繧｢繧､繝・Β

  const visitListItems = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const dayMatch = visitListPanelMapTab.match(/^(.+)繝槭ャ繝・/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    const dayItems = items.filter((item) => item.eventDate === dayName);
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

    // executeIds縺ｮ鬆・ｺ上〒霑斐☆

    return executeIds
      .filter((id: string) => dayItems.some((item) => item.id === id))
      .map((id: string) => dayItems.find((item) => item.id === id)!)
      .filter(Boolean);
  }, [visitListPanelMapTab, activeEventName, items, executeModeItems]);

  // 險ｪ蝠丞・繝ｪ繧ｹ繝育畑縺ｮ繝帙・繝ｫ鬆・ｺ・

  const visitListHallOrder = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const routeSettings = hallRouteSettings[activeEventName]?.[visitListPanelMapTab];

    if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
      return routeSettings.hallOrder;
    }

    // 繝・ヵ繧ｩ繝ｫ繝医・繝帙・繝ｫ螳夂ｾｩ鬆・

    return halls.map((h) => h.id);
  }, [visitListPanelMapTab, activeEventName, hallDefinitions, hallRouteSettings]);

  // 繧｢繧､繝・Β縺ｮ蜆ｪ蜈亥ｺｦ繧貞､画峩縺吶ｋ繝上Φ繝峨Λ

  const handleUpdateItemPriority = useCallback(
    (itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
      if (!activeEventName || !visitListPanelMapTab) return;

      // 繧｢繧､繝・Β縺ｮ蜆ｪ蜈亥ｺｦ繧呈峩譁ｰ

      setEventLists((prev) => ({
        ...prev,
        [activeEventName]: (prev[activeEventName] || []).map((item) =>
          item.id === itemId ? { ...item, priorityLevel } : item,
        ),
      }));

      // 繧｢繧､繝・Β縺ｮ繝帙・繝ｫID繧貞叙蠕・

      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
      const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];

      // 繧｢繧､繝・Β縺ｮ繝帙・繝ｫID繧堤音螳・

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
                // 螟夊ｧ貞ｽ｢蜀・愛螳・
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
                // 鬆らせ荳翫↓縺ゅｋ縺・
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

      // 繧ｰ繝ｫ繝ｼ繝悠D繧堤函謌・

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

        // 迴ｾ蝨ｨ縺ｮhallOrder縺ｫ繝吶・繧ｹ繝帙・繝ｫ・磯壼ｸｸ繧ｰ繝ｫ繝ｼ繝暦ｼ峨′縺ｪ縺代ｌ縺ｰ霑ｽ蜉

        if (!newHallOrder.includes(baseGroupId)) {
          newHallOrder.push(baseGroupId);
        }

        // 譁ｰ縺励＞繧ｰ繝ｫ繝ｼ繝励′蠢・ｦ√°遒ｺ隱搾ｼ磯壼ｸｸ繧ｰ繝ｫ繝ｼ繝励↓謌ｻ縺吝ｴ蜷医・荳崎ｦ・ｼ・

        if (priorityLevel !== 'none' && !newHallOrder.includes(newGroupId)) {
          // 騾壼ｸｸ繧ｰ繝ｫ繝ｼ繝暦ｼ医∪縺溘・蜆ｪ蜈医げ繝ｫ繝ｼ繝暦ｼ峨・逶ｴ蜑阪↓謖ｿ蜈･
          const priorityGroupId = buildGroupId(itemHallId, 'priority');

          // 謖ｿ蜈･菴咲ｽｮ繧呈ｱｺ螳・

          let insertIndex = newHallOrder.length;

          if (priorityLevel === 'highest') {
            // 譛蜆ｪ蜈医・縲∝━蜈医げ繝ｫ繝ｼ繝励∪縺溘・騾壼ｸｸ繧ｰ繝ｫ繝ｼ繝励・逶ｴ蜑・
            const priorityIndex = newHallOrder.indexOf(priorityGroupId);
            const baseIndex = newHallOrder.indexOf(baseGroupId);

            if (priorityIndex !== -1) {
              insertIndex = priorityIndex;
            } else if (baseIndex !== -1) {
              insertIndex = baseIndex;
            }
          } else if (priorityLevel === 'priority') {
            // 蜆ｪ蜈医・騾壼ｸｸ繧ｰ繝ｫ繝ｼ繝励・逶ｴ蜑・
            const baseIndex = newHallOrder.indexOf(baseGroupId);
            if (baseIndex !== -1) {
              insertIndex = baseIndex;
            }
          }

          newHallOrder.splice(insertIndex, 0, newGroupId);
        }

        // 蜿､縺・げ繝ｫ繝ｼ繝励′遨ｺ縺ｫ縺ｪ繧九°遒ｺ隱搾ｼ亥酔縺倥・繝ｼ繝ｫ繝ｻ蜷後§蜆ｪ蜈亥ｺｦ縺ｮ莉悶・繧｢繧､繝・Β縺後≠繧九°・・      // 豕ｨ諢・ 縺薙・譎らせ縺ｧ縺ｯitem縺ｮ蜆ｪ蜈亥ｺｦ縺ｯ譌｢縺ｫ譖ｴ譁ｰ縺輔ｌ縺ｦ縺・ｋ縺溘ａ縲∵峩譁ｰ蠕後・items繧剃ｽｿ縺・ｿ・ｦ√′縺ゅｋ
        // 縺励°縺励《etEventLists縺ｨsetHallRouteSettings縺ｯ髱槫酔譛溘↑縺ｮ縺ｧ縲∫樟蝨ｨ縺ｮitems繧剃ｽｿ縺・
        if (oldPriority !== 'none' && oldGroupId !== newGroupId) {
          // 蜷後§繝帙・繝ｫ繝ｻ蜷後§蜆ｪ蜈亥ｺｦ縺ｮ莉悶・繧｢繧､繝・Β縺後≠繧九°遒ｺ隱・
          const otherItemsInOldGroup = items.filter((i) => {
            if (i.id === itemId) return false;
            if ((i.priorityLevel || 'none') !== oldPriority) return false;

            // 蜷後§繝帙・繝ｫ縺九←縺・°遒ｺ隱・

            if (!mapDataForTab) return false;
            const iBlock = mapDataForTab.blocks.find((b) => b.name === i.block);
            if (!iBlock) return false;
            const iNumMatch = i.number?.match(/\d+/);
            if (!iNumMatch) return false;
            const iNum = parseInt(iNumMatch[0], 10);
            const iCell = iBlock.numberCells.find((nc) => nc.value === iNum);
            if (!iCell) return false;

            // 縺薙・繧｢繧､繝・Β縺ｮ繝帙・繝ｫID繧堤音螳・

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

  // 繧ｿ繝門､画峩譎ゅ・遒ｺ隱阪ム繧､繧｢繝ｭ繧ｰ蜃ｦ逅・ｼ亥ｰ・擂逧・↓TabButton縺ｧ菴ｿ逕ｨ・・
  const handleTabChangeWithVisitListCheck = (newTab: string): boolean => {
    if (visitListPanelOpen && visitListHasUnsavedChanges) {
      setPendingTabChange(newTab);
      setShowVisitListConfirmDialog(true);
      return false;
    }
    return true;
  };

  // 遒ｺ隱阪ム繧､繧｢繝ｭ繧ｰ縺ｧ遒ｺ螳壹ｒ驕ｸ謚・

  const handleVisitListDialogConfirm = useCallback(() => {
    handleVisitListConfirm();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListConfirm, pendingTabChange]);

  // 遒ｺ隱阪ム繧､繧｢繝ｭ繧ｰ縺ｧ繧ｭ繝｣繝ｳ繧ｻ繝ｫ繧帝∈謚・

  const handleVisitListDialogCancel = useCallback(() => {
    handleVisitListCancel();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setActiveTab(pendingTabChange as ActiveTab);
      setPendingTabChange(null);
    }
  }, [handleVisitListCancel, pendingTabChange]);

  // 繝悶Ο繝・け螳夂ｾｩ繧呈峩譁ｰ

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

  // 繝帙・繝ｫ螳夂ｾｩ繧呈峩譁ｰ

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

      // 繝帙・繝ｫ鬆・ｺ上ｂ譖ｴ譁ｰ・域眠隕上・繝ｼ繝ｫ縺ｯ繝ｪ繧ｹ繝医・譛蠕後↓霑ｽ蜉・・

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

  // 繝帙・繝ｫ繝ｫ繝ｼ繝郁ｨｭ螳壹ｒ譖ｴ譁ｰ

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

  // 螳溯｡悟・繧偵・繝ｼ繝ｫ鬆・ｺ上〒荳ｦ縺ｳ譖ｿ縺・

  const handleReorderExecuteListByHallOrder = useCallback(
    (hallOrder: string[]) => {
      if (!activeEventName || !isMapTab) return;

      const dayMatch = activeTab.match(/^(.+)繝槭ャ繝・/);
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

        // 蜷・い繧､繝・Β縺ｮ繝帙・繝ｫID繧貞叙蠕励☆繧矩未謨ｰ

        const itemsMap = new Map(items.map((i) => [i.id, i]));
        const getHallIdForItem = (itemId: string): string | null => {
          const item = itemsMap.get(itemId);
          if (!item || !currentMapData) return null;

          const blockName = item.block?.trim() || '';
          // 螳悟・荳閾ｴ蜆ｪ蜈医〒繝悶Ο繝・け繧呈､懃ｴ｢
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

        // 繧｢繧､繝・Β繧偵・繝ｼ繝ｫ縺斐→縺ｫ繧ｰ繝ｫ繝ｼ繝怜喧

        const itemsByHall = new Map<string | null, Set<string>>();
        dayItems.forEach((itemId) => {
          const hallId = getHallIdForItem(itemId);
          if (!itemsByHall.has(hallId)) {
            itemsByHall.set(hallId, new Set());
          }
          itemsByHall.get(hallId)!.add(itemId);
        });

        // hallVisitLists縺ｮ鬆・ｺ上・繝・・繧剃ｽ懈・

        const visitOrderMap = new Map<string, number>();
        currentHallRouteSettings.hallVisitLists.forEach((list) => {
          list.itemIds.forEach((itemId, index) => {
            visitOrderMap.set(itemId, index);
          });
        });

        // 繝帙・繝ｫ蜀・・繧｢繧､繝・Β繧定ｨｪ蝠丞・謖・ｮ夐・〒繧ｽ繝ｼ繝・

        const sortItemsInHall = (itemIds: Set<string>): string[] => {
          const itemsArray = Array.from(itemIds);
          return itemsArray.sort((a, b) => {
            const orderA = visitOrderMap.get(a);
            const orderB = visitOrderMap.get(b);

            // 荳｡譁ｹ縺ｨ繧りｨｪ蝠丞・繝ｪ繧ｹ繝医↓縺ゅｋ蝣ｴ蜷医√◎縺ｮ鬆・ｺ上〒荳ｦ縺ｹ繧・

            if (orderA !== undefined && orderB !== undefined) {
              return orderA - orderB;
            }
            // 荳譁ｹ縺ｮ縺ｿ縺後Μ繧ｹ繝医↓縺ゅｋ蝣ｴ蜷医√Μ繧ｹ繝医↓縺ゅｋ譁ｹ繧貞・縺ｫ
            if (orderA !== undefined) return -1;
            if (orderB !== undefined) return 1;
            // 縺ｩ縺｡繧峨ｂ繝ｪ繧ｹ繝医↓縺ｪ縺・ｴ蜷医∝・縺ｮ螳溯｡悟・鬆・ｺ上ｒ邯ｭ謖・
            return dayItems.indexOf(a) - dayItems.indexOf(b);
          });
        };

        // 繝帙・繝ｫ鬆・ｺ上↓蠕薙▲縺ｦ荳ｦ縺ｳ譖ｿ縺・

        const reorderedItems: string[] = [];

        // 縺ｾ縺壹・繝ｼ繝ｫ鬆・ｺ上↓蠕薙▲縺ｦ霑ｽ蜉
        hallOrder.forEach((hallId) => {
          const hallItems = itemsByHall.get(hallId);
          if (hallItems && hallItems.size > 0) {
            reorderedItems.push(...sortItemsInHall(hallItems));
            itemsByHall.delete(hallId);
          }
        });

        // 繝帙・繝ｫ鬆・ｺ上↓蜷ｫ縺ｾ繧後※縺・↑縺・・繝ｼ繝ｫ縺ｮ繧｢繧､繝・Β繧定ｿｽ蜉
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

  // 繝帙・繝ｫ螳夂ｾｩ繝｢繝ｼ繝峨・迥ｶ諷・

  const [hallDefinitionMode, setHallDefinitionMode] = useState(false);

  // 繝帙・繝ｫ鬆らせ驕ｸ謚槭Δ繝ｼ繝峨・迥ｶ諷・

  const [vertexSelectionMode, setVertexSelectionMode] = useState<{
    clickedVertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // 繝帙・繝ｫ鬆らせ驕ｸ謚槫ｮ御ｺ・凾縺ｫHallDefinitionPanel縺ｫ貂｡縺吶ョ繝ｼ繧ｿ

  const [pendingVertexSelection, setPendingVertexSelection] = useState<{
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // 繝帙・繝ｫ鬆らせ驕ｸ謚槭Δ繝ｼ繝峨ｒ髢句ｧ・

  const handleStartVertexSelection = useCallback((editingData?: unknown) => {
    setVertexSelectionMode({ clickedVertices: [], editingData });
    setHallDefinitionMode(false);
  }, []);

  // 鬆らせ繧帝㍾蠢・°繧峨・隗貞ｺｦ縺ｧ繧ｽ繝ｼ繝医＠縲∬ｾｺ縺御ｺ､蟾ｮ縺励↑縺・腰邏泌､夊ｧ貞ｽ｢繧剃ｽ懊ｋ

  const sortVerticesNonCrossing = useCallback(
    (vertices: { row: number; col: number }[]): { row: number; col: number }[] => {
      if (vertices.length <= 2) return vertices;

      // 驥榊ｿ・ｒ險育ｮ・

      const centroidRow = vertices.reduce((sum, v) => sum + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((sum, v) => sum + v.col, 0) / vertices.length;

      // 驥榊ｿ・°繧峨・隗貞ｺｦ縺ｧ繧ｽ繝ｼ繝茨ｼ亥渚譎りｨ亥屓繧奇ｼ・

      const sorted = [...vertices].sort((a, b) => {
        const angleA = Math.atan2(a.row - centroidRow, a.col - centroidCol);
        const angleB = Math.atan2(b.row - centroidRow, b.col - centroidCol);
        return angleA - angleB;
      });

      return sorted;
    },
    [],
  );

  // 繝帙・繝ｫ鬆らせ驕ｸ謚槭ｒ遒ｺ螳・

  const handleConfirmVertexSelection = useCallback(() => {
    if (vertexSelectionMode) {
      // 鬆らせ繧定・蜍穂ｸｦ縺ｹ譖ｿ縺茨ｼ郁ｾｺ縺御ｺ､蟾ｮ縺励↑縺・腰邏泌､夊ｧ貞ｽ｢縺ｫ縺吶ｋ・・
      const sorted = sortVerticesNonCrossing(vertexSelectionMode.clickedVertices);
      setPendingVertexSelection({
        vertices: sorted,
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [sortVerticesNonCrossing, vertexSelectionMode]);

  // 繝帙・繝ｫ鬆らせ驕ｸ謚槭ｒ繧ｭ繝｣繝ｳ繧ｻ繝ｫ

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

  // 繝槭ャ繝励そ繝ｫ繧ｯ繝ｪ繝・け譎ゅ↓繝帙・繝ｫ鬆らせ驕ｸ謚槭↓霑ｽ蜉/蜑企勁

  useEffect(() => {
    const handleMapCellClickForVertex = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!vertexSelectionMode) return;

      const { row, col } = e.detail;

      setVertexSelectionMode((prev) => {
        if (!prev) return prev;

        // 譌｢蟄倥・鬆らせ繧偵け繝ｪ繝・け縺励◆蝣ｴ蜷医・蜑企勁

        const existingIndex = prev.clickedVertices.findIndex((v) => v.row === row && v.col === col);
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter((_, i) => i !== existingIndex),
          };
        }

        // 譛螟ｧ6鬆らせ縺ｾ縺ｧ

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

  // 繧ｻ繝ｫ驕ｸ謚槭Δ繝ｼ繝峨ｒ髢句ｧ具ｼ・lockDefinitionPanel縺九ｉ蜻ｼ縺ｰ繧後ｋ・・

  const handleStartCellSelection = useCallback(
    (type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual', editingData?: unknown) => {
      setCellSelectionMode({ type, clickedCells: [], editingBlockData: editingData });
      setBlockDefinitionMode(false); // 繝代ロ繝ｫ繧剃ｸ譎ら噪縺ｫ髱櫁｡ｨ遉ｺ
    },
    [],
  );

  // 遽・峇繧貞渚譏縺励※繝代ロ繝ｫ繧貞・陦ｨ遉ｺ

  const handleConfirmCellSelection = useCallback(() => {
    if (cellSelectionMode) {
      // pendingCellSelection繧偵そ繝・ヨ縺励※BlockDefinitionPanel縺ｫ貂｡縺・
      setPendingCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // 繝代ロ繝ｫ繧貞・陦ｨ遉ｺ
  }, [cellSelectionMode]);

  // 繧ｻ繝ｫ驕ｸ謚槭ｒ繧ｭ繝｣繝ｳ繧ｻ繝ｫ・育ｷｨ髮・判髱｢縺ｫ謌ｻ繧具ｼ・

  const handleCancelCellSelection = useCallback(() => {
    // 邱ｨ髮・ョ繝ｼ繧ｿ繧剃ｿ晄戟縺励◆縺ｾ縺ｾ繝代ロ繝ｫ繧貞・陦ｨ遉ｺ
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: 'cancelled', // 繧ｭ繝｣繝ｳ繧ｻ繝ｫ逕ｨ縺ｮ迚ｹ谿翫ち繧､繝・
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // 繝代ロ繝ｫ繧貞・陦ｨ遉ｺ
  }, [cellSelectionMode]);

  // 繝槭ャ繝励そ繝ｫ繧ｯ繝ｪ繝・け繧偵Μ繝・せ繝ｳ縺励※繧ｻ繝ｫ驕ｸ謚槭↓霑ｽ蜉

  useEffect(() => {
    const handleMapCellClick = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!cellSelectionMode) return;

      const { row, col } = e.detail;

      setCellSelectionMode((prev) => {
        if (!prev) return prev;

        // 譌｢縺ｫ驕ｸ謚槭＆繧後※縺・ｋ蝣ｴ蜷医・蜑企勁・亥・繝｢繝ｼ繝牙・騾夲ｼ・

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

      // 髟ｷ謚ｼ縺鈴幕蟋区凾縺ｫ繝懊ち繝ｳ縺ｮ菴咲ｽｮ繧定ｨ倬鹸

      const target = e.currentTarget as HTMLButtonElement;
      const rect = target.getBoundingClientRect();
      const menuLeft = rect.left + rect.width / 2;
      const menuTop = rect.bottom + 4;

      longPressTimeout.current = window.setTimeout(() => {
        if (isMapTabProp) {
          // 繝槭ャ繝励ち繝悶・髟ｷ謚ｼ縺励Γ繝九Η繝ｼ - 險倬鹸縺励◆菴咲ｽｮ縺ｧ繝｡繝九Η繝ｼ繧定｡ｨ遉ｺ
          setMapTabMenuPosition({ left: menuLeft, top: menuTop });
          setMapTabMenuOpen(tab);
        } else if (eventDates.includes(tab)) {
          // 騾壼ｸｸ縺ｮ譌･莉倥ち繝悶・髟ｷ謚ｼ縺暦ｼ医Δ繝ｼ繝牙・繧頑崛縺茨ｼ・
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
      // 繝｡繝九Η繝ｼ縺碁幕縺・※縺・ｋ蝣ｴ蜷・
      if (mapTabMenuOpen) {
        // 縺薙・繧ｿ繝悶・繝｡繝九Η繝ｼ縺碁幕縺・※縺・ｋ蝣ｴ蜷医・髢峨§繧九□縺・
        if (mapTabMenuOpen === tab) {
          setMapTabMenuOpen(null);
          return;
        }
        // 莉悶・繧ｿ繝悶・繝｡繝九Η繝ｼ縺碁幕縺・※縺・ｋ蝣ｴ蜷医・髢峨§縺ｦ繧ｿ繝夜・遘ｻ
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

    // 繝｡繝九Η繝ｼ螟悶け繝ｪ繝・け縺ｧ髢峨§繧・

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

    // 繝｡繝九Η繝ｼ鬆・岼繧ｯ繝ｪ繝・け譎ゑｼ壹∪縺壹◎縺ｮ繧ｿ繝悶↓驕ｷ遘ｻ縺励※縺九ｉ讖溯・繧帝幕縺・

    const handleMenuItemClick = (action: 'visitList' | 'blockDefinition' | 'hallDefinition') => {
      // 縺ｾ縺壹Γ繝九Η繝ｼ繧帝哩縺倥ｋ
      setMapTabMenuOpen(null);

      // 髟ｷ謚ｼ縺励＠縺溘ち繝悶↓驕ｷ遘ｻ

      setItemToEdit(null);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());
      setCandidateNumberSortDirection(null);
      setActiveTab(tab);

      // 讖溯・繧帝幕縺擾ｼ医ち繝夜・遘ｻ蠕後↓螳溯｡後＆繧後ｋ繧医≧setTimeout縺ｧ驕・ｻｶ・・

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

        {/* 繝槭ャ繝励ち繝夜聞謚ｼ縺励Γ繝九Η繝ｼ - fixed驟咲ｽｮ縺ｧ繧ｿ繝悶・縺吶＄荳九↓陦ｨ遉ｺ */}
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
            {/* 遏｢蜊ｰ・井ｸ雁髄縺搾ｼ・*/}
            <div className="absolute left-1/2 -translate-x-1/2 -top-2">
              <div className="w-3 h-3 bg-white dark:bg-slate-800 border-l border-t border-slate-200 dark:border-slate-700 transform rotate-45" />
            </div>
            <div className="py-1">
              <button
                onClick={() => handleMenuItemClick('visitList')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-t-lg flex items-center gap-2"
              >
                <span>桃</span> 險ｪ蝠丞・繝ｪ繧ｹ繝・{' '}
              </button>
              <button
                onClick={() => handleMenuItemClick('blockDefinition')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <span>抜</span> 繝悶Ο繝・け螳夂ｾｩ
              </button>
              <button
                onClick={() => handleMenuItemClick('hallDefinition')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-b-lg flex items-center gap-2"
              >
                <span>H</span> Hall Definition
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
      // 螳溯｡後Δ繝ｼ繝・ 螳溯｡悟・縺ｮ繧｢繧､繝・Β縺ｮ縺ｿ陦ｨ遉ｺ・育ｷｨ髮・Δ繝ｼ繝峨〒驟咲ｽｮ縺励◆鬆・ｺ上ｒ菫晄戟・・
      if (sortState === 'Manual') {
        return executeColumnItems;
      }
      // 繝輔ぅ繝ｫ繧ｿ縺ｫ隧ｲ蠖薙☆繧九い繧､繝・Β縲√∪縺溘・譛霑大､画峩縺輔ｌ縺溘い繧､繝・Β繧定｡ｨ遉ｺ
      const filterStatus = sortState as Exclude<SortState, 'Manual'>;
      return executeColumnItems.filter(
        (item) => item.purchaseStatus === filterStatus || recentlyChangedItemIds.has(item.id),
      );
    }

    // 邱ｨ髮・Δ繝ｼ繝・ 縺吶∋縺ｦ縺ｮ繧｢繧､繝・Β繧定｡ｨ遉ｺ・亥・蛻・￠縺ｯ繧ｳ繝ｳ繝昴・繝阪Φ繝亥・縺ｧ蜃ｦ逅・ｼ・

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

  // 讀懃ｴ｢讖溯・: 迴ｾ蝨ｨ縺ｮ繧ｿ繝悶・繧｢繧､繝・Β繧呈､懃ｴ｢

  const searchMatches = useMemo(() => {
    if (!searchKeyword.trim() || !activeEventName || !eventDates.includes(activeTab)) {
      return [];
    }

    const keyword = searchKeyword.trim().toLowerCase();
    const matches: string[] = [];

    // 迴ｾ蝨ｨ縺ｮ繧ｿ繝悶・繧｢繧､繝・Β繧呈､懃ｴ｢
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

  // 讀懃ｴ｢繧ｭ繝ｼ繝ｯ繝ｼ繝峨′螟画峩縺輔ｌ縺溘→縺阪↓讀懃ｴ｢邨先棡繧偵Μ繧ｻ繝・ヨ

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

  // 繧ｿ繝悶′蛻・ｊ譖ｿ繧上▲縺溘→縺阪↓讀懃ｴ｢邨先棡繧偵Μ繧ｻ繝・ヨ

  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab]);

  // 蜷・盾蜉譌･繧ｿ繝紋ｸｭ縺ｮ繧｢繧､繝・Β縺ｧ繧ｵ繝ｼ繧ｯ繝ｫ蜷阪′驥崎､・☆繧九い繧､繝・Β縺ｮID繧ｻ繝・ヨ繧定ｨ育ｮ・

  const duplicateCircleItemIds = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return new Set<string>();
    const itemsForTab = currentTabItems;
    const circleCountMap = new Map<string, number>();
    const circleItemIdsMap = new Map<string, string[]>();

    // 繧ｵ繝ｼ繧ｯ繝ｫ蜷阪＃縺ｨ縺ｫ繧｢繧､繝・Β謨ｰ繧偵き繧ｦ繝ｳ繝・
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

    // 驥崎､・☆繧九し繝ｼ繧ｯ繝ｫ蜷阪・繧｢繧､繝・ΒID繧貞庶髮・

    const duplicateIds = new Set<string>();
    circleCountMap.forEach((count, circle) => {
      if (count > 1) {
        const itemIds = circleItemIdsMap.get(circle) || [];
        itemIds.forEach((id) => duplicateIds.add(id));
      }
    });

    return duplicateIds;
  }, [activeEventName, activeTab, currentTabItems, eventDates]);

  // 蛟呵｣懊Μ繧ｹ繝医°繧牙虚逧・↓繝悶Ο繝・け蛟､繧貞叙蠕・

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

    // 繝悶Ο繝・け繝輔ぅ繝ｫ繧ｿ繧帝←逕ｨ

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

  // 陦ｨ遉ｺ縺輔ｌ縺ｦ縺・ｋ繧｢繧､繝・Β縺ｮ縺ｿ繧呈､懃ｴ｢蟇ｾ雎｡縺ｨ縺吶ｋ

  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];

    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const mode = dayModes[activeEventName || '']?.[currentEventDate] || 'edit';

    let visibleItemIds: Set<string>;

    if (mode === 'execute') {
      // 螳溯｡後Δ繝ｼ繝・ executeColumnItems縺ｾ縺溘・visibleItems
      visibleItemIds = new Set(visibleItems.map((item) => item.id));
    } else {
      // 邱ｨ髮・Δ繝ｼ繝・ executeColumnItems + candidateColumnItems
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

  // 縲梧ｬ｡繧呈､懃ｴ｢縲阪・繧ｿ繝ｳ縺ｮ繝上Φ繝峨Λ

  const handleSearchNext = useCallback(() => {
    if (!searchKeyword.trim() || visibleSearchMatches.length === 0) {
      if (searchMatches.length > 0 && visibleSearchMatches.length === 0) {
        alert('No matches in the current filtered view.');
      }
      return;
    }

    // 谺｡縺ｮ繧､繝ｳ繝・ャ繧ｯ繧ｹ繧定ｨ育ｮ暦ｼ医Ν繝ｼ繝暦ｼ・    // currentSearchIndex縺・1縺ｮ蝣ｴ蜷医・0縺九ｉ蟋九ａ繧・

    const startIndex = currentSearchIndex === -1 ? -1 : currentSearchIndex;
    const nextIndex = (startIndex + 1) % visibleSearchMatches.length;
    setCurrentSearchIndex(nextIndex);

    const nextItemId = visibleSearchMatches[nextIndex];
    setHighlightedItemId(nextItemId);

    // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ蜃ｦ逅・

    setTimeout(() => {
      const element = document.querySelector(`[data-item-id="${nextItemId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);

  // 蜷・ヶ繝ｭ繝・け縺ｮ蛟呵｣懊Μ繧ｹ繝亥・縺ｮ繧｢繧､繝・Β縺ｮ蛯呵・ｬ・↓縲悟━蜈医阪∪縺溘・縲悟ｧ碑ｨ礼┌縲阪′蜷ｫ縺ｾ繧後※縺・ｋ縺九ｒ繝√ぉ繝・け

  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : eventDates[0] || '';
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const candidateItems = currentTabItems.filter((item) => !executeIds.has(item.id));

    const blocksWithPriority = new Set<string>();
    candidateItems.forEach((item) => {
      if (item.remarks && (item.remarks.includes('優先') || item.remarks.includes('最優先'))) {
        blocksWithPriority.add(item.block);
      }
    });

    return blocksWithPriority;
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, eventDates]);

  // 蛟呵｣懊Μ繧ｹ繝医・繧｢繧､繝・Β縺碁∈謚槭＆繧後※縺・ｋ縺九メ繧ｧ繝・け

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

  // 螳溯｡後Δ繝ｼ繝牙・縺ｮ繧｢繧､繝・Β縺碁∈謚槭＆繧後※縺・ｋ縺九メ繧ｧ繝・け

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

  // 蟾ｦ蜿ｳ荳｡蛻励・繧｢繧､繝・Β縺悟酔譎ゅ↓驕ｸ謚槭＆繧後※縺・ｋ蝣ｴ蜷医・遘ｻ蜍輔・繧ｿ繝ｳ繧定｡ｨ遉ｺ縺励↑縺・

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
                    蜊ｳ螢ｲ莨・雉ｼ蜈･蟾｡蝗櫁｡ｨ
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
                            ? 'Sort blocks desc'
                            : blockSortDirection === 'asc'
                              ? 'Sort blocks asc'
                              : 'Sort blocks by number'
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
                            ? 'Sort candidate blocks desc'
                            : blockSortDirection === 'asc'
                              ? 'Sort candidate blocks asc'
                              : 'Sort candidate blocks by number'
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
                  {/* 繝・・繝槫・繧頑崛縺医ヨ繧ｰ繝ｫ */}
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
                        ? '繧ｷ繧ｹ繝・Β險ｭ螳・竊・繝ｩ繧､繝医Δ繝ｼ繝峨∈'
                        : themeMode === 'light'
                          ? '繝ｩ繧､繝医Δ繝ｼ繝・竊・繝繝ｼ繧ｯ繝｢繝ｼ繝峨∈'
                          : '繝繝ｼ繧ｯ繝｢繝ｼ繝・竊・繧ｷ繧ｹ繝・Β險ｭ螳壹∈'
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

                  {/* UI陦ｨ遉ｺ險ｭ螳夲ｼ域ｭｯ霆翫い繧､繧ｳ繝ｳ・・*/}
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
                      title="UI visibility settings"
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

                    {/* UI陦ｨ遉ｺ險ｭ螳壹ヱ繝阪Ν */}
                    {uiSettingsPanelOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={() => setUiSettingsPanelOpen(false)}
                        />
                        <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-4 min-w-[320px] max-h-[70vh] overflow-y-auto">
                          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
                            Header/Tab Visibility Settings
                          </h3>

                          {/* 髮・ｸｭ繝｢繝ｼ繝芽ｨｭ螳・*/}
                          <div className="mb-3">
                            <h4 className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">
                              Focus Mode
                            </h4>
                            <div className="space-y-2">
                              {(
                                [
                                  ['focus_sp_mapOn', 'SP繝ｻ繝槭ャ繝涌N'],
                                  ['focus_sp_mapOff', 'SP繝ｻ繝槭ャ繝涌FF'],
                                  ['focus_pc_mapOn', 'PC繝ｻ繝槭ャ繝涌N'],
                                  ['focus_pc_mapOff', 'PC繝ｻ繝槭ャ繝涌FF'],
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
                                          setUiVisibilitySettings((prev) => ({
                                            ...prev,
                                            [key]: { ...prev[key], header: e.target.checked },
                                          }))
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        繝倥ャ繝繝ｼ
                                      </span>
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={uiVisibilitySettings[key].tabBar}
                                        onChange={(e) =>
                                          setUiVisibilitySettings((prev) => ({
                                            ...prev,
                                            [key]: { ...prev[key], tabBar: e.target.checked },
                                          }))
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        繧ｿ繝悶ヰ繝ｼ
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* 螳溯｡後Δ繝ｼ繝芽ｨｭ螳・*/}
                          <div className="mb-3">
                            <h4 className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2">
                              Execute Mode
                            </h4>
                            <div className="space-y-2">
                              {(
                                [
                                  ['execute_sp', '繧ｹ繝槭・繝医ヵ繧ｩ繝ｳ'],
                                  ['execute_pc', 'PC / 繧ｿ繝悶Ξ繝・ヨ'],
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
                                          setUiVisibilitySettings((prev) => ({
                                            ...prev,
                                            [key]: { ...prev[key], header: e.target.checked },
                                          }))
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        繝倥ャ繝繝ｼ
                                      </span>
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={uiVisibilitySettings[key].tabBar}
                                        onChange={(e) =>
                                          setUiVisibilitySettings((prev) => ({
                                            ...prev,
                                            [key]: { ...prev[key], tabBar: e.target.checked },
                                          }))
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        繧ｿ繝悶ヰ繝ｼ
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* 繝ｪ繧ｻ繝・ヨ繝懊ち繝ｳ */}
                          <button
                            onClick={() => setUiVisibilitySettings(DEFAULT_UI_VISIBILITY)}
                            className="w-full mt-1 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                          >
                            繝・ヵ繧ｩ繝ｫ繝医↓謌ｻ縺・{' '}
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* 繝｢繝ｼ繝牙・譖ｿ繧｢繧､繧ｳ繝ｳ・域律莉倥ち繝冶｡ｨ遉ｺ譎ゅ・縺ｿ・・*/}
                  {activeEventName && mainContentVisible && (
                    <div className="flex items-center gap-1 ml-2 border-l border-slate-300 dark:border-slate-600 pl-2">
                      {/* 邱ｨ髮・Δ繝ｼ繝・*/}
                      <button
                        onClick={() => handleSetViewMode('edit')}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          currentMode === 'edit'
                            ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                        title="Edit mode"
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '40px',
                          minHeight: '40px',
                        }}
                        type="button"
                      >
                        <span className="text-lg">統</span>
                      </button>

                      {/* 螳溯｡後Δ繝ｼ繝・*/}
                      <button
                        onClick={() => handleSetViewMode('execute')}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          currentMode === 'execute'
                            ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                        title="Execute mode"
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '40px',
                          minHeight: '40px',
                        }}
                        type="button"
                      >
                        <span className="text-lg">純</span>
                      </button>

                      {/* 髮・ｸｭ繝｢繝ｼ繝・*/}
                      <button
                        onClick={() => handleSetViewMode('focus')}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          currentMode === 'focus'
                            ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                        }`}
                        title="Focus mode"
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '40px',
                          minHeight: '40px',
                        }}
                        type="button"
                      >
                        <span className="text-lg">剥</span>
                      </button>
                    </div>
                  )}

                  {/* 繝槭ャ繝励さ繝ｳ繝医Ο繝ｼ繝ｫ・医・繝・・繧ｿ繝冶｡ｨ遉ｺ譎ゅ・縺ｿ・・*/}
                  {activeEventName && isMapTab && currentMapData && currentHalls.length > 0 && (
                    <>
                      {/* 繝帙・繝ｫ驕ｸ謚・*/}
                      <div className="relative">
                        <button
                          onClick={() => setMapHallSelectorOpen(!mapHallSelectorOpen)}
                          className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                            mapHallSelectorOpen
                              ? 'bg-slate-200 dark:bg-slate-700'
                              : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                          }`}
                          title={`陦ｨ遉ｺ繝帙・繝ｫ: ${mapSelectedHallId === 'all' ? '蜈ｨ繝帙・繝ｫ' : currentHalls.find((h) => h.id === mapSelectedHallId)?.name || ''}`}
                          style={{
                            WebkitTapHighlightColor: 'transparent',
                            minWidth: '44px',
                            minHeight: '44px',
                          }}
                          type="button"
                        >
                          {/* 繝帙・繝ｫ繧｢繧､繧ｳ繝ｳ・医ン繝・げ繧ｵ繧､繝医す繝ｫ繧ｨ繝・ヨ鬚ｨ・・*/}
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

                        {/* 繝帙・繝ｫ驕ｸ謚槭ラ繝ｭ繝・・繝繧ｦ繝ｳ繝｡繝九Η繝ｼ */}
                        {mapHallSelectorOpen && (
                          <>
                            {/* 閭梧勹繧ｪ繝ｼ繝舌・繝ｬ繧､・医け繝ｪ繝・け縺ｧ髢峨§繧具ｼ・*/}
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
                                蜈ｨ繝帙・繝ｫ
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
                                      ({executeCount}/{totalCount}莉ｶ)
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>

                      {/* 繝帙・繝ｫ鬆・ｺ・*/}
                      <button
                        onClick={() => setMapIsHallOrderOpen(true)}
                        className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
                        title="Edit hall order"
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

                      {/* 繝ｫ繝ｼ繝郁｡ｨ遉ｺON/OFF */}
                      <button
                        onClick={() => setMapIsRouteVisible(!mapIsRouteVisible)}
                        className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                          mapIsRouteVisible
                            ? 'bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-800'
                            : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                        }`}
                        title={mapIsRouteVisible ? '繝ｫ繝ｼ繝郁｡ｨ遉ｺON' : '繝ｫ繝ｼ繝郁｡ｨ遉ｺOFF'}
                        style={{
                          WebkitTapHighlightColor: 'transparent',
                          minWidth: '44px',
                          minHeight: '44px',
                        }}
                        type="button"
                      >
                        {/* 繝ｫ繝ｼ繝医い繧､繧ｳ繝ｳ */}
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

                      {/* 繧ｹ繝槭・繝井ｽ咲ｽｮ驕ｸ謚朧N/OFF (髟ｷ謚ｼ縺励〒繝｢繝ｼ繝牙・譖ｿ) */}
                      <button
                        onPointerDown={() => {
                          smartInsertLongPressTriggeredRef.current = false;
                          smartInsertLongPressRef.current = setTimeout(() => {
                            smartInsertLongPressTriggeredRef.current = true;
                            const newMode = mapSmartInsertMode === 'card' ? 'preview' : 'card';
                            setMapSmartInsertMode(newMode);
                            setSmartInsertToast(
                              newMode === 'preview'
                                ? '繝励Ξ繝薙Η繝ｼ繝｢繝ｼ繝峨↓蛻・崛'
                                : '繧ｫ繝ｼ繝峨Δ繝ｼ繝峨↓蛻・崛',
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
                        title={`Smart insert ${mapSmartInsertEnabled ? 'ON' : 'OFF'} (${mapSmartInsertMode === 'card' ? 'Card' : 'Preview'})`}
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
                        {/* 繝｢繝ｼ繝峨う繝ｳ繧ｸ繧ｱ繝ｼ繧ｿ繝ｼ */}
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
                          驕ｸ謚槭＠縺溘い繧､繝・Β繧貞ｷｦ蛻励↓遘ｻ蜍・({selectedItemIds.size}莉ｶ)
                        </button>
                      )}
                      {showMoveButtons && hasExecuteSelection && (
                        <button
                          onClick={() => handleRemoveFromExecuteColumn(Array.from(selectedItemIds))}
                          className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                        >
                          驕ｸ謚槭＠縺溘い繧､繝・Β繧貞承蛻励↓遘ｻ蜍・({selectedItemIds.size}莉ｶ)
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
                  label="Event List"
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
                      const mapTabName = `${eventDate}Map`;
                      const hasMapData = mapTabs.includes(mapTabName);
                      return (
                        <React.Fragment key={eventDate}>
                          <TabButton tab={eventDate} label={eventDate} count={count} />
                          {hasMapData && (
                            <TabButton tab={mapTabName} label={`${eventDate}Map`} isMapTab={true} />
                          )}
                        </React.Fragment>
                      );
                    })}
                    <TabButton tab="import" label={itemToEdit ? 'Edit Item' : 'Import Items'} />
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
                    譁ｰ隕上Μ繧ｹ繝井ｽ懈・
                  </button>
                )}
              </div>
            </div>
          )}
        </header>
      )}

      {/* 繝輔Ο繝ｼ繝・ぅ繝ｳ繧ｰ蜈ｨ陦ｨ遉ｺ繝懊ち繝ｳ・郁ｨｭ螳壻ｸ贋ｽ輔°縺碁撼陦ｨ遉ｺ縺ｮ蝣ｴ蜷茨ｼ・*/}
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
            title={uiVisibilityOverride ? 'Return to auto visibility' : 'Show all UI'}
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
        {/* 繝槭ャ繝励ン繝･繝ｼ */}
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
                {/* 蟾ｦ蛻・ 螳溯｡後Δ繝ｼ繝芽｡ｨ遉ｺ蛻・*/}
                <div className="space-y-2">
                  <div className="bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">
                      Execute Items
                    </h3>
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">
                      Manage items currently selected for execution.
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

                {/* 蜿ｳ蛻・ 蛟呵｣懊Μ繧ｹ繝・*/}
                <div className="space-y-2">
                  <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
                      Candidate Items
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                      Move selected items from this list into execute items.
                    </p>
                    {availableBlocks.length > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            繝悶Ο繝・け縺ｧ繝輔ぅ繝ｫ繧ｿ:
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
                                      ? 'Sort numbers desc'
                                      : candidateNumberSortDirection === 'asc'
                                        ? 'Sort numbers asc'
                                        : 'Sort numbers'
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
                                  縺吶∋縺ｦ隗｣髯､
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
                            驕ｸ謚樔ｸｭ: {selectedBlockFilters.size}莉ｶ縺ｮ繝悶Ο繝・け
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

      {/* 繧ｨ繧ｯ繧ｹ繝昴・繝医が繝励す繝ｧ繝ｳ繝繧､繧｢繝ｭ繧ｰ */}
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

      {/* 繝悶Ο繝・け螳夂ｾｩ繝代ロ繝ｫ */}
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

      {/* 繧ｻ繝ｫ驕ｸ謚槭Δ繝ｼ繝峨・繝輔Ο繝ｼ繝・ぅ繝ｳ繧ｰUI */}
      {cellSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              {cellSelectionMode.type === 'corner' &&
                `桃 繧ｻ繝ｫ繧偵け繝ｪ繝・け縺励※隗偵ｒ驕ｸ謚・(${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === 'multiCorner' &&
                `桃 繧ｻ繝ｫ繧偵け繝ｪ繝・け縺励※隗偵ｒ驕ｸ謚・(${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === 'rangeStart' &&
                `桃 遽・峇縺ｮ2縺､縺ｮ繧ｻ繝ｫ繧偵け繝ｪ繝・け (${cellSelectionMode.clickedCells.length}/2)`}
              {cellSelectionMode.type === 'individual' &&
                `桃 蛟句挨繧ｻ繝ｫ繧偵け繝ｪ繝・け (${cellSelectionMode.clickedCells.length}蛟矩∈謚樔ｸｭ)`}
            </div>
            {cellSelectionMode.clickedCells.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                驕ｸ謚・{' '}
                {cellSelectionMode.clickedCells.map((c) => `(${c.row},${c.col})`).join(', ')}
              </div>
            )}
            <div className="text-xs text-blue-500 dark:text-blue-400 mt-1">
              庁 繝槭・繧ｫ繝ｼ繧偵け繝ｪ繝・け縺ｧ驕ｸ謚櫁ｧ｣髯､
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
              遽・峇繧貞渚譏
            </button>
            <button
              onClick={handleCancelCellSelection}
              className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              繧ｭ繝｣繝ｳ繧ｻ繝ｫ
            </button>
          </div>
        </div>
      )}

      {/* 繝帙・繝ｫ螳夂ｾｩ繝代ロ繝ｫ */}
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

      {/* 險ｪ蝠丞・繝ｪ繧ｹ繝医ヱ繝阪Ν */}
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

      {/* 險ｪ蝠丞・繝ｪ繧ｹ繝育｢ｺ隱阪ム繧､繧｢繝ｭ繧ｰ */}
      {showVisitListConfirmDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-3">
              螟画峩繧剃ｿ晏ｭ倥＠縺ｾ縺吶°・・{' '}
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              險ｪ蝠丞・繝ｪ繧ｹ繝医↓譛ｪ菫晏ｭ倥・螟画峩縺後≠繧翫∪縺吶ら｢ｺ螳壹＠縺ｦ菫晏ｭ倥☆繧九°縲√く繝｣繝ｳ繧ｻ繝ｫ縺励※遐ｴ譽・＠縺ｦ縺上□縺輔＞縲・{' '}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleVisitListDialogCancel}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
              >
                繧ｭ繝｣繝ｳ繧ｻ繝ｫ・育ｴ譽・ｼ・{' '}
              </button>
              <button
                onClick={handleVisitListDialogConfirm}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                遒ｺ螳夲ｼ井ｿ晏ｭ假ｼ・{' '}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 繝帙・繝ｫ鬆らせ驕ｸ謚槭Δ繝ｼ繝峨・繝輔Ο繝ｼ繝・ぅ繝ｳ繧ｰUI */}
      {vertexSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              桃 繝帙・繝ｫ縺ｮ鬆らせ繧偵け繝ｪ繝・け ({vertexSelectionMode.clickedVertices.length}
              /4縲・)
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
              繧ｯ繝ｪ繝・け鬆・↓螟夊ｧ貞ｽ｢繧剃ｽ懈・縺励∪縺・{' '}
            </div>
            {vertexSelectionMode.clickedVertices.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                驕ｸ謚・{' '}
                {vertexSelectionMode.clickedVertices
                  .map((v) => `(${v.row},${v.col})`)
                  .join(' 竊・')}
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleConfirmVertexSelection}
              disabled={vertexSelectionMode.clickedVertices.length < 4}
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              遒ｺ螳・{' '}
            </button>
            <button
              onClick={handleCancelVertexSelection}
              className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              繧ｭ繝｣繝ｳ繧ｻ繝ｫ
            </button>
          </div>
        </div>
      )}

      {/* 繝槭ャ繝励ヵ繧｡繧､繝ｫ蜈･蜉幢ｼ磯撼陦ｨ遉ｺ・・*/}
      <input
        type="file"
        ref={mapFileInputRef}
        accept=".xlsx"
        onChange={handleMapFileChange}
        style={{ display: 'none' }}
      />

      {/* 繝槭ャ繝怜叙繧願ｾｼ縺ｿ繝繧､繧｢繝ｭ繧ｰ */}
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

      {/* 繧ｨ繧ｯ繧ｹ繝昴・繝医ヵ繧｡繧､繝ｫ繧､繝ｳ繝昴・繝育畑蜈･蜉幢ｼ磯撼陦ｨ遉ｺ・・*/}
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

      {/* 繧ｹ繝槭・繝郁ｿｽ蜉繝｢繝ｼ繝牙・譖ｿ繝医・繧ｹ繝・*/}
      {smartInsertToast && (
        <div className="fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] bg-green-600 text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-pulse">
          {smartInsertToast}
        </div>
      )}
    </div>
  );
};

export default App;
