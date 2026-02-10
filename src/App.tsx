import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ViewMode, DayModeState, ExecuteModeItems, MapDataStore, RouteSettingsStore, ExportOptions, BlockDefinition, HallDefinition, HallRouteSettings, HallDefinitionsStore, HallRouteSettingsStore, DayMapData, BlockDetectionSettings } from './types';
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
import { MapView, BlockDefinitionPanel, HallDefinitionPanel, isPointInPolygon, MapImportDialog, loadBlockDetectionSettings, saveBlockDetectionSettings } from './components/map';
import VisitListPanel from './components/VisitListPanel';
import FocusMode from './components/FocusMode';
import { getItemKey, getItemKeyWithoutTitle, insertItemSorted } from './utils/itemComparison';
import { exportToXlsx, importFromXlsx, downloadBlob } from './utils/exportImport';
import { useTheme } from './hooks/useTheme';
import { useUIVisibility, DEFAULT_UI_VISIBILITY } from './hooks/useUIVisibility';
import { usePersistence } from './hooks/usePersistence';
import { useSearch } from './hooks/useSearch';
import { useVisitList } from './hooks/useVisitList';
import { useMapControls } from './hooks/useMapControls';

type ActiveTab = 'eventList' | 'import' | string; // string部分は動的な参加日（例: '1日目', '2日目', '3日目'など）
type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'None' | 'Purchased';
export type BulkSortDirection = 'asc' | 'desc';
type BlockSortDirection = 'asc' | 'desc';

// データから参加日を抽出する関数
const extractEventDates = (items: ShoppingItem[]): string[] => {
  const eventDates = new Set<string>();
  items.forEach(item => {
    if (item.eventDate && item.eventDate.trim()) {
      eventDates.add(item.eventDate.trim());
    }
  });
  // 参加日をソート（数値部分でソート）
  return Array.from(eventDates).sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, 'ja');
  });
};

const sortCycle: SortState[] = ['Manual', 'Postpone', 'Late', 'Absent', 'SoldOut', 'None', 'Purchased'];
const sortLabels: Record<SortState, string> = {
    Manual: '巡回順',
    Postpone: '後回し',
    Late: '遅参',
    Absent: '欠席',
    SoldOut: '売切',
    None: '未購入',
    Purchased: '購入済',
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
  // 起点と終点を管理（列タイプとアイテムIDのペア）
  const [rangeStart, setRangeStart] = useState<{ itemId: string; columnType: 'execute' | 'candidate' } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{ itemId: string; columnType: 'execute' | 'candidate' } | null>(null);

  // マップからの新規アイテム追加用の初期値
  const [newItemDefaults, setNewItemDefaults] = useState<{ eventDate: string; block: string; number: string } | null>(null);

  // 更新機能用の状態
  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [updateData, setUpdateData] = useState<{
    itemsToDelete: ShoppingItem[];
    itemsToUpdate: ShoppingItem[];
    itemsToAdd: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[];
    protectedFromDelete: number;
    protectedFromUpdate: number;
  } | null>(null);
  const [updateEventName, setUpdateEventName] = useState<string | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);
  
  // 検索機能の状態 - will be initialized via useSearch hook (see below)

  // レイアウトモード状態（ビューポート幅で初期化）
  const [layoutMode, setLayoutMode] = useState<'pc' | 'smartphone'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'smartphone' : 'pc'
  );
  
  // UI表示設定 - will be initialized after currentMode is computed
  // (see useUIVisibility hook call below)
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);
  
  // ダークモード状態 - extracted to useTheme hook
  const { themeMode, setThemeMode, cycleTheme } = useTheme();

  // マップ機能の状態
  const [mapData, setMapData] = useState<MapDataStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);
  
  // マップ取り込みダイアログ用の状態
  const [mapImportDialogOpen, setMapImportDialogOpen] = useState(false);
  const [mapImportPendingFile, setMapImportPendingFile] = useState<File | null>(null);
  const [mapImportPendingEventName, setMapImportPendingEventName] = useState<string>('');
  
  // 保存フラグ - handled by usePersistence hook

  // テーマモードの適用 - handled by useTheme hook

  // UI表示設定の永続化 - handled by useUIVisibility hook

  // データ永続化 - extracted to usePersistence hook
  const isInitialized = usePersistence(
    { eventLists, eventMetadata, executeModeItems, dayModes, mapData, routeSettings, hallDefinitions, hallRouteSettings },
    { setEventLists, setEventMetadata, setExecuteModeItems, setDayModes, setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings },
  );

  // IndexedDBへデータを保存 - handled by usePersistence hook

  const items = useMemo(() => activeEventName ? eventLists[activeEventName] || [] : [], [activeEventName, eventLists]);
  
  // 現在のイベントの参加日リストを取得
  const eventDates = useMemo(() => extractEventDates(items), [items]);
  
  // 現在のイベントのマップタブリストを取得
  const mapTabs = useMemo(() => {
    if (!activeEventName || !mapData[activeEventName]) return [];
    return Object.keys(mapData[activeEventName]).sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    });
  }, [activeEventName, mapData]);
  
  // マップタブかどうかを判定
  const isMapTab = useMemo(() => {
    return activeTab.endsWith('マップ');
  }, [activeTab]);
  
  // 現在のマップデータを取得
  const currentMapData = useMemo(() => {
    if (!activeEventName || !isMapTab) return null;
    return mapData[activeEventName]?.[activeTab] || null;
  }, [activeEventName, activeTab, isMapTab, mapData]);

  // 現在のホール定義を取得
  const currentHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName || !isMapTab) return [];
    return hallDefinitions[activeEventName]?.[activeTab] || [];
  }, [activeEventName, activeTab, isMapTab, hallDefinitions]);

  // 現在のホールルート設定を取得
  const currentHallRouteSettings = useMemo((): HallRouteSettings => {
    if (!activeEventName || !isMapTab) {
      return { hallOrder: [], hallVisitLists: [] };
    }
    return hallRouteSettings[activeEventName]?.[activeTab] || { hallOrder: currentHalls.map(h => h.id), hallVisitLists: [] };
  }, [activeEventName, activeTab, isMapTab, hallRouteSettings, currentHalls]);

  // ホール内の訪問先アイテム数を取得（優先・最優先グループも含む）
  const getHallExecuteCount = useCallback((hallId: string): number => {
    if (!activeEventName || !isMapTab || !currentMapData) return 0;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return 0;
    const dayName = dayMatch[1];
    
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
    
    return executeIds.filter(itemId => {
      const item = items.find(i => i.id === itemId);
      if (!item) return false;
      
      // ブロックからホールIDを判定
      const block = currentMapData.blocks.find(b => b.name === item.block);
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
  }, [activeEventName, isMapTab, activeTab, currentMapData, currentHalls, items, executeModeItems]);

  // ホール内の全アイテム数を取得
  const getHallTotalItemCount = useCallback((hallId: string): number => {
    if (!activeEventName || !isMapTab || !currentMapData) return 0;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return 0;
    const dayName = dayMatch[1];
    
    const dayItems = items.filter(item => item.eventDate === dayName);
    
    return dayItems.filter(item => {
      // ブロックからホールIDを判定
      const block = currentMapData.blocks.find(b => b.name === item.block);
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
  }, [activeEventName, isMapTab, activeTab, currentMapData, currentHalls, items]);

  // 日付タブに対応するマップタブ名を取得（例: "1日目" → "1日目マップ"）
  const getMapTabForDate = useCallback((eventDate: string): string => {
    return `${eventDate}マップ`;
  }, []);

  // 日付タブに対応するホール定義を取得
  const getHallsForDate = useCallback((eventDate: string): HallDefinition[] => {
    if (!activeEventName) return [];
    const mapTab = getMapTabForDate(eventDate);
    return hallDefinitions[activeEventName]?.[mapTab] || [];
  }, [activeEventName, hallDefinitions, getMapTabForDate]);

  // 日付タブに対応するマップデータを取得
  const getMapDataForDate = useCallback((eventDate: string) => {
    if (!activeEventName) return null;
    const mapTab = getMapTabForDate(eventDate);
    return mapData[activeEventName]?.[mapTab] || null;
  }, [activeEventName, mapData, getMapTabForDate]);

  // 日付タブに対応するホール順序を取得
  const getHallOrderForDate = useCallback((eventDate: string): string[] => {
    if (!activeEventName) return [];
    const mapTab = getMapTabForDate(eventDate);
    const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
    const routeSettings = hallRouteSettings[activeEventName]?.[mapTab];
    
    if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
      return routeSettings.hallOrder;
    }
    
    // デフォルトはホール定義順
    return halls.map(h => h.id);
  }, [activeEventName, hallDefinitions, hallRouteSettings, getMapTabForDate]);

  // アイテムがどのホールに属するかを判定
  const getItemHallId = useCallback((item: ShoppingItem, eventDate: string): string | null => {
    const halls = getHallsForDate(eventDate);
    const mapDataForDate = getMapDataForDate(eventDate);
    if (!halls.length || !mapDataForDate) return null;

    // ブロックの中心点を取得
    const block = mapDataForDate.blocks.find(b => b.name === item.block);
    if (!block) return null;

    const centerRow = (block.startRow + block.endRow) / 2;
    const centerCol = (block.startCol + block.endCol) / 2;

    // どのホールに属するか判定
    for (const hall of halls) {
      if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
        return hall.id;
      }
    }
    return null;
  }, [getHallsForDate, getMapDataForDate]);

  // 2つのアイテムが同じホールに属するかを判定
  const areItemsInSameHall = useCallback((itemId1: string, itemId2: string, eventDate: string): boolean => {
    const item1 = items.find(i => i.id === itemId1);
    const item2 = items.find(i => i.id === itemId2);
    if (!item1 || !item2) return true; // アイテムが見つからない場合は制限なし

    const halls = getHallsForDate(eventDate);
    if (!halls.length) return true; // ホール定義がない場合は制限なし

    const hallId1 = getItemHallId(item1, eventDate);
    const hallId2 = getItemHallId(item2, eventDate);

    // どちらかがホールに属していない場合は制限なし
    if (hallId1 === null || hallId2 === null) return true;

    return hallId1 === hallId2;
  }, [items, getHallsForDate, getItemHallId]);
  
  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    // マップタブの場合は編集モードを返す
    if (isMapTab) return 'edit';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    // activeTabが参加日（'1日目', '2日目'など）の場合
    if (eventDates.includes(activeTab)) {
      return modes[activeTab] || 'edit';
    }
    return 'edit';
  }, [activeEventName, dayModes, activeTab, eventDates, isMapTab]);

  // 現在の条件に基づくヘッダー/タブバー表示状態 - extracted to useUIVisibility hook
  const {
    uiVisibilitySettings, setUiVisibilitySettings,
    uiVisibilityOverride, setUiVisibilityOverride,
    uiSettingsPanelOpen, setUiSettingsPanelOpen,
    showHeaderBar, showTabBar, rawHideSomething,
  } = useUIVisibility(activeEventName, currentMode, layoutMode, focusModeMapVisible);

  const handleBulkAdd = useCallback((eventName: string, newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[], metadata?: { url?: string; sheetName?: string; layoutInfo?: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }>; source?: 'spreadsheet' | 'app' }) => {
    // sourceを決定: metadataで指定されていればそれを使用、urlがあればspreadsheet、なければapp
    const itemSource = metadata?.source ?? (metadata?.url ? 'spreadsheet' : 'app');
    // デフォルトの保護レベル: appなら完全保護、spreadsheetなら保護なし
    const defaultProtectionLevel = itemSource === 'app' ? 'full' : 'none';
    
    const newItems: ShoppingItem[] = newItemsData.map(itemData => ({
        id: crypto.randomUUID(),
        ...itemData,
        quantity: itemData.quantity ?? 1,
        purchaseStatus: 'None' as PurchaseStatus,
        source: itemSource,
        protectionLevel: defaultProtectionLevel,
    }));

    const isNewEvent = !eventLists[eventName];

    // 配置情報がある場合は、それに基づいてアイテムを配置
    if (metadata?.layoutInfo && metadata.layoutInfo.length > 0 && isNewEvent) {
      // 新規イベントの場合のみ、配置情報を適用
      // アイテムキーでマップを作成（サークル名、参加日、ブロック、ナンバー、タイトルで照合）
      const itemsMap = new Map<string, ShoppingItem>();
      newItems.forEach(item => {
        const key = getItemKey(item);
        itemsMap.set(key, item);
      });

      // 各参加日ごとに配置情報を適用
      const eventDatesForLayout = extractEventDates(newItems);
      const newExecuteModeItems: ExecuteModeItems = {};
      const sortedItemsByDate: ShoppingItem[] = [];
      
      // 配置情報がないアイテムを取得
      const layoutItemKeys = new Set(metadata.layoutInfo!.map(layout => layout.itemKey));
      const otherItems = newItems.filter(item => !layoutItemKeys.has(getItemKey(item)));
      
      // 配置情報がないアイテムを参加日ごとに分類
      const otherItemsByDate: Record<string, ShoppingItem[]> = {};
      otherItems.forEach(item => {
        if (!otherItemsByDate[item.eventDate]) {
          otherItemsByDate[item.eventDate] = [];
        }
        otherItemsByDate[item.eventDate].push(item);
      });
      
      eventDatesForLayout.forEach(eventDate => {
        // 実行列のアイテム
        const executeItemsForDate = metadata.layoutInfo!
          .filter(layout => layout.eventDate === eventDate && layout.columnType === 'execute')
          .sort((a, b) => a.order - b.order)
          .map(layout => itemsMap.get(layout.itemKey))
          .filter(Boolean) as ShoppingItem[];
        
        // 候補リストのアイテム
        const candidateItemsForDate = metadata.layoutInfo!
          .filter(layout => layout.eventDate === eventDate && layout.columnType === 'candidate')
          .sort((a, b) => a.order - b.order)
          .map(layout => itemsMap.get(layout.itemKey))
          .filter(Boolean) as ShoppingItem[];
        
        // 実行列のIDを保存
        newExecuteModeItems[eventDate] = executeItemsForDate.map(item => item.id);
        
        // 実行列、候補リスト、配置情報がないアイテムの順で並べる
        sortedItemsByDate.push(...executeItemsForDate, ...candidateItemsForDate, ...(otherItemsByDate[eventDate] || []));
      });
      
      // 配置情報がないアイテムで、参加日がeventDatesForLayoutに含まれていないものを追加
      const otherItemsWithoutDate = otherItems.filter(item => !eventDatesForLayout.includes(item.eventDate));
      sortedItemsByDate.push(...otherItemsWithoutDate);
      
      setEventLists(prevLists => {
        return {
          ...prevLists,
          [eventName]: sortedItemsByDate as ShoppingItem[]
        };
      });
      
      // 実行モードアイテムを設定
      setExecuteModeItems(prev => ({
        ...prev,
        [eventName]: newExecuteModeItems
      }));
    } else {
      // 配置情報がない場合は従来通り
      setEventLists(prevLists => {
        const currentItems: ShoppingItem[] = prevLists[eventName] || [];
        return {
          ...prevLists,
          [eventName]: [...currentItems, ...newItems] as ShoppingItem[]
        };
      });
    }

    // メタデータの保存
    if (metadata?.url) {
      setEventMetadata(prev => ({
        ...prev,
        [eventName]: {
          spreadsheetUrl: metadata.url!,
          spreadsheetSheetName: metadata.sheetName || '',
          lastImportDate: new Date().toISOString()
        }
      }));
    }

    // 初期モードを編集モードに設定
    if (isNewEvent) {
      const newEventDates = extractEventDates(newItems);
      const initialDayModes: DayModeState = {};
      const initialExecuteItems: ExecuteModeItems = {};
      newEventDates.forEach(date => {
        initialDayModes[date] = 'edit' as ViewMode;
        if (!metadata?.layoutInfo) {
          initialExecuteItems[date] = [];
        }
      });
      
      setDayModes(prev => ({
        ...prev,
        [eventName]: initialDayModes
      }));
      
      if (!metadata?.layoutInfo) {
        setExecuteModeItems(prev => ({
          ...prev,
          [eventName]: initialExecuteItems
        }));
      }
    }

    alert(`${newItems.length}件のアイテムが${isNewEvent ? 'リストにインポートされました。' : '追加されました。'}`);
    
    if (isNewEvent) {
        setActiveEventName(eventName);
    }
    
    if (newItems.length > 0) {
        // 新しいアイテムの参加日を取得
        const newEventDates = extractEventDates(newItems);
        if (newEventDates.length > 0) {
            setActiveTab(newEventDates[0]);
        } else {
            // 既存のイベントの場合、最初の参加日を選択
            const currentEventDates = extractEventDates(eventLists[eventName] || []);
            if (currentEventDates.length > 0) {
                setActiveTab(currentEventDates[0]);
            }
        }
    }
  }, [eventLists]);

  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    if (!activeEventName) return;
    
    setEventLists(prev => {
      // 購入状態が変更されたかチェック
      const currentItem = prev[activeEventName]?.find(item => item.id === updatedItem.id);
      const purchaseStatusChanged = currentItem && currentItem.purchaseStatus !== updatedItem.purchaseStatus;
      const priceChanged = currentItem && currentItem.price !== updatedItem.price;
      
      // 購入状態が変更された場合、最近変更されたアイテムとして記録
      if (purchaseStatusChanged) {
        setRecentlyChangedItemIds(prevIds => new Set(prevIds).add(updatedItem.id));
      }
      
      // 実行モード・集中モードで購入状態または価格が変更された場合、保護レベルを'deletable'に自動変更
      // （明示的にprotectionLevelが設定されていない場合のみ）
      const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
      const currentMode = dayModes[activeEventName]?.[currentEventDate] || 'edit';
      let finalItem = updatedItem;
      
      if ((currentMode === 'execute' || currentMode === 'focus') && (purchaseStatusChanged || priceChanged)) {
        // 現在の保護レベルがnone（保護なし）の場合のみ、deletable（削除のみ許可）に変更
        const currentProtection = currentItem?.protectionLevel ?? (currentItem?.source === 'app' ? 'full' : 'none');
        if (currentProtection === 'none') {
          finalItem = { ...updatedItem, protectionLevel: 'deletable' as const };
        }
      }
      
      return {
        ...prev,
        [activeEventName]: prev[activeEventName].map(item => (item.id === updatedItem.id ? finalItem : item))
      };
    });
  }, [activeEventName, activeTab, eventDates, dayModes]);

  const handleMoveItem = useCallback((dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    // リスト末尾への追加判定
    const isAppendToEnd = hoverId === '__END_OF_LIST__';

    // 列間移動の処理（編集モードのみ）
    if (mode === 'edit' && sourceColumn && targetColumn && sourceColumn !== targetColumn) {
      const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      
      if (sourceColumn === 'candidate' && targetColumn === 'execute') {
        // 候補リスト → 実行列への移動
        // candidateColumnItemsと同じロジックで候補リストのアイテムを取得（順序を維持）
        const currentTabItemsForMove = items.filter(item => item.eventDate === activeTab);
        let candidateItems = currentTabItemsForMove.filter(item => !executeIdsSet.has(item.id));
        
        // ブロックフィルタを適用（candidateColumnItemsと同じ）
        if (selectedBlockFilters.size > 0) {
          candidateItems = candidateItems.filter(item => selectedBlockFilters.has(item.block));
        }
        
        // 移動するアイテムを取得（候補リストの順序を維持）
        let itemsToMove: ShoppingItem[] = [];
        if (selectedItemIds.has(dragId)) {
          // 候補リストの順序を維持しながら選択されたアイテムを抽出
          itemsToMove = candidateItems.filter(item => selectedItemIds.has(item.id));
        } else {
          const item = candidateItems.find(item => item.id === dragId);
          if (item) itemsToMove = [item];
        }
        
        if (itemsToMove.length === 0) return;
        
        const itemIdsToMove = itemsToMove.map(item => item.id);
        
        // executeModeItemsに追加
          setExecuteModeItems(prevExecute => {
            const eventItems = prevExecute[activeEventName] || {};
            const dayItems = [...(eventItems[currentEventDate] || [])];
            
            if (isAppendToEnd) {
              return {
                ...prevExecute,
                [activeEventName]: { ...eventItems, [currentEventDate]: [...dayItems, ...itemIdsToMove] }
              };
            } else {
              const hoverIndex = dayItems.findIndex(id => id === hoverId);
              if (hoverIndex === -1) {
                return { ...prevExecute, [activeEventName]: { ...eventItems, [currentEventDate]: [...dayItems, ...itemIdsToMove] } };
              }
              dayItems.splice(hoverIndex, 0, ...itemIdsToMove);
              return {
                ...prevExecute,
                [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
              };
            }
          });
        return;
      } else if (sourceColumn === 'execute' && targetColumn === 'candidate') {
        // 実行列 → 候補リストへの移動
        setEventLists(prev => {
          const allItems = [...(prev[activeEventName] || [])];
          const executeItems = allItems.filter(item => 
            item.eventDate.includes(currentEventDate) && executeIdsSet.has(item.id)
          );
          const candidateItems = allItems.filter(item => 
            item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id)
          );
          
          // 移動するアイテムを取得
          let itemsToMove: ShoppingItem[] = [];
          if (selectedItemIds.has(dragId)) {
            itemsToMove = executeItems.filter(item => selectedItemIds.has(item.id));
          } else {
            const item = executeItems.find(item => item.id === dragId);
            if (item) itemsToMove = [item];
          }
          
          if (itemsToMove.length === 0) return prev;
          
          const itemIdsToMove = itemsToMove.map(item => item.id);
          
          // executeModeItemsから削除
          setExecuteModeItems(prevExecute => {
            const eventItems = prevExecute[activeEventName] || {};
            const dayItems = (eventItems[currentEventDate] || []).filter(id => !itemIdsToMove.includes(id));
            return {
              ...prevExecute,
              [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
            };
          });
          
          // 候補リストに挿入
          let newCandidateList: ShoppingItem[] = [];
          if (isAppendToEnd) {
            newCandidateList = [...candidateItems, ...itemsToMove];
          } else {
            const hoverIndex = candidateItems.findIndex(item => item.id === hoverId);
            if (hoverIndex === -1) {
              newCandidateList = [...candidateItems, ...itemsToMove];
            } else {
              const listWithoutMoved = candidateItems.filter(item => !itemIdsToMove.includes(item.id));
              listWithoutMoved.splice(hoverIndex, 0, ...itemsToMove);
              newCandidateList = listWithoutMoved;
            }
          }
          
          // 再結合処理
          const remainingExecuteItems = executeItems.filter(item => !itemIdsToMove.includes(item.id));
          
          const newItems = allItems.map(item => {
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
      // 編集モード: 実行列内での並び替え
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[currentEventDate] || [])];
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          if (isAppendToEnd) {
            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: [...listWithoutSelection, ...selectedBlock] }
            };
          }

          const targetIndex = listWithoutSelection.findIndex(id => id === hoverId);
          if (targetIndex === -1) return prev;
          listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
          
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection }
          };
        } else {
          // 単一アイテム
          const dragIndex = dayItems.findIndex(id => id === dragId);
          if (dragIndex === -1) return prev; // 見つからない場合

          const [draggedItem] = dayItems.splice(dragIndex, 1);
          
          if (isAppendToEnd) {
             dayItems.push(draggedItem);
          } else {
             const hoverIndex = dayItems.findIndex(id => id === hoverId);
             if (hoverIndex === -1) return prev;
             dayItems.splice(hoverIndex, 0, draggedItem);
          }
          
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
          };
        }
      });
    } else if (mode === 'edit' && targetColumn === 'candidate') {
      // 編集モード: 候補リスト内での並び替え
      setEventLists(prev => {
        const allItems = [...(prev[activeEventName] || [])];
        const currentTabKey = currentEventDate;
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        
        const candidateItems = allItems.filter(item => 
          item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id)
        );
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          
          let newCandidateList: ShoppingItem[] = [];

          if (isAppendToEnd) {
             newCandidateList = [...listWithoutSelection, ...selectedBlock];
          } else {
             const targetIndex = listWithoutSelection.findIndex(item => item.id === hoverId);
             if (targetIndex === -1) return prev;
             listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
             newCandidateList = listWithoutSelection;
          }
          
          // 再結合処理
          const executeItems = allItems.filter(item => 
            item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
          );
          
          const newItems = allItems.map(item => {
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
          // 単一アイテム
          const dragIndex = candidateItems.findIndex(item => item.id === dragId);
          if (dragIndex === -1) return prev;

          const [draggedItem] = candidateItems.splice(dragIndex, 1);
          
          if (isAppendToEnd) {
              candidateItems.push(draggedItem);
          } else {
              const hoverIndex = candidateItems.findIndex(item => item.id === hoverId);
              if (hoverIndex === -1) return prev;
              candidateItems.splice(hoverIndex, 0, draggedItem);
          }
          
          // 再結合
          const executeItems = allItems.filter(item => 
            item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
          );
          
          const newItems = allItems.map(item => {
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
      // 実行モード: 通常の並び替え
      setEventLists(prev => {
        const newItems = [...(prev[activeEventName] || [])];
        
        if (selectedItemIds.has(dragId)) {
          const selectedBlock = newItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = newItems.filter(item => !selectedItemIds.has(item.id));
          
          if (isAppendToEnd) {
             return { ...prev, [activeEventName]: [...listWithoutSelection, ...selectedBlock] };
          }

          const targetIndex = listWithoutSelection.findIndex(item => item.id === hoverId);
          if (targetIndex === -1) return prev;
          listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
          
          return { ...prev, [activeEventName]: listWithoutSelection };
        } else {
          const dragIndex = newItems.findIndex(item => item.id === dragId);
          if (dragIndex === -1) return prev;

          const [draggedItem] = newItems.splice(dragIndex, 1);
          
          if (isAppendToEnd) {
              newItems.push(draggedItem);
          } else {
              const hoverIndex = newItems.findIndex(item => item.id === hoverId);
              if (hoverIndex === -1) return prev;
              newItems.splice(hoverIndex, 0, draggedItem);
          }
          return { ...prev, [activeEventName]: newItems };
        }
      });
    }
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, selectedBlockFilters, items]);
  const handleMoveItemUp = useCallback((itemId: string, targetColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'edit' && targetColumn === 'execute') {
      // 編集モード: 実行列内での並び替え
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[currentEventDate] || [])];
        const currentIndex = dayItems.findIndex(id => id === itemId);
        
        if (currentIndex <= 0) return prev; // 既に先頭または見つからない

        // ホール間移動制限チェック
        const targetId = dayItems[currentIndex - 1];
        if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
          return prev; // 異なるホールなので移動不可
        }
        
        // 複数選択時は選択されたアイテムすべてを移動
        if (selectedItemIds.has(itemId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          // 選択されたアイテムの最初の位置を基準に移動
          const firstSelectedIndex = dayItems.findIndex(id => selectedItemIds.has(id));
          if (firstSelectedIndex > 0) {
            // ホール間移動制限チェック（選択グループ全体）
            const targetIdForGroup = dayItems[firstSelectedIndex - 1];
            if (!areItemsInSameHall(selectedIds[0], targetIdForGroup, currentEventDate)) {
              return prev; // 異なるホールなので移動不可
            }
            const newTargetIndex = firstSelectedIndex - 1;
            listWithoutSelection.splice(newTargetIndex, 0, ...selectedIds);
            return {
              ...prev,
              [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection }
            };
          }
          return prev;
        } else {
          // 単一アイテム
          [dayItems[currentIndex - 1], dayItems[currentIndex]] = [dayItems[currentIndex], dayItems[currentIndex - 1]];
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
          };
        }
      });
    } else if (mode === 'edit' && targetColumn === 'candidate') {
      // 編集モード: 候補リスト内での並び替え
      setEventLists(prev => {
        const allItems = [...(prev[activeEventName] || [])];
        const currentTabKey = currentEventDate;
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        
        // 候補リストのアイテムのみを取得
        const candidateItems = allItems.filter(item => 
          item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id)
        );
        
        const currentIndex = candidateItems.findIndex(item => item.id === itemId);
        if (currentIndex <= 0) return prev; // 既に先頭または見つからない
        
        if (selectedItemIds.has(itemId)) {
          // 複数選択時
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          const firstSelectedIndex = candidateItems.findIndex(item => selectedItemIds.has(item.id));
          
          if (firstSelectedIndex > 0) {
            const newTargetIndex = firstSelectedIndex - 1;
            listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);
            
            // 実行モード列のアイテムはそのまま、候補リストのみ並び替え
            const executeItems = allItems.filter(item => 
              item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
            );
            
            const newItems = allItems.map(item => {
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
          // 単一アイテム
          [candidateItems[currentIndex - 1], candidateItems[currentIndex]] = [candidateItems[currentIndex], candidateItems[currentIndex - 1]];
          
          // 実行モード列のアイテムはそのまま、候補リストのみ並び替え
          const executeItems = allItems.filter(item => 
            item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
          );
          
          const newItems = allItems.map(item => {
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
      // 実行モード: 通常の並び替え
      setEventLists(prev => {
        const newItems = [...(prev[activeEventName] || [])];
        const currentIndex = newItems.findIndex(item => item.id === itemId);
        
        if (currentIndex <= 0) return prev; // 既に先頭または見つからない
        
        if (selectedItemIds.has(itemId)) {
          const selectedBlock = newItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = newItems.filter(item => !selectedItemIds.has(item.id));
          const firstSelectedIndex = newItems.findIndex(item => selectedItemIds.has(item.id));
          
          if (firstSelectedIndex > 0) {
            const newTargetIndex = firstSelectedIndex - 1;
            listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);
            return { ...prev, [activeEventName]: listWithoutSelection };
          }
          return prev;
        } else {
          [newItems[currentIndex - 1], newItems[currentIndex]] = [newItems[currentIndex], newItems[currentIndex - 1]];
          return { ...prev, [activeEventName]: newItems };
        }
      });
    }
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, areItemsInSameHall]);

const handleMoveItemDown = useCallback((itemId: string, targetColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'edit' && targetColumn === 'execute') {
      // 編集モード: 実行列内での並び替え
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[currentEventDate] || [])];
        const currentIndex = dayItems.findIndex(id => id === itemId);
        
        if (currentIndex < 0 || currentIndex >= dayItems.length - 1) return prev; // 既に末尾または見つからない
        
        // ホール間移動制限チェック
        const targetId = dayItems[currentIndex + 1];
        if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
          return prev; // 異なるホールなので移動不可
        }
        
        // 複数選択時は選択されたアイテムすべてを移動
        if (selectedItemIds.has(itemId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          // 選択されたアイテムの中で最も後ろの位置を見つける
          let lastSelectedIndex = -1;
          dayItems.forEach((id, index) => {
              if (selectedItemIds.has(id)) lastSelectedIndex = index;
          });
          
          // 選択されたアイテムが最後にない場合のみ移動
          if (lastSelectedIndex >= 0 && lastSelectedIndex < dayItems.length - 1) {
            // 飛び越える対象のアイテム（選択範囲の直後のアイテム）
            const jumpOverItemId = dayItems[lastSelectedIndex + 1];
            
            // ホール間移動制限チェック（選択グループ全体）
            if (!areItemsInSameHall(selectedIds[selectedIds.length - 1], jumpOverItemId, currentEventDate)) {
              return prev; // 異なるホールなので移動不可
            }
            
            // 非選択リスト内でのそのアイテムの位置
            const targetIndexInListWithout = listWithoutSelection.findIndex(id => id === jumpOverItemId);
            
            if (targetIndexInListWithout !== -1) {
              // そのアイテムの後ろに挿入
              listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedIds);
              return {
                ...prev,
                [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection }
              };
            }
          }
          return prev;
        } else {
          // 単一アイテム
          [dayItems[currentIndex], dayItems[currentIndex + 1]] = [dayItems[currentIndex + 1], dayItems[currentIndex]];
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
          };
        }
      });
    } else if (mode === 'edit' && targetColumn === 'candidate') {
      // 編集モード: 候補リスト内での並び替え
      setEventLists(prev => {
        const allItems = [...(prev[activeEventName] || [])];
        const currentTabKey = currentEventDate;
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        
        // 候補リストのアイテムのみを取得
        const candidateItems = allItems.filter(item => 
          item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id)
        );
        
        const currentIndex = candidateItems.findIndex(item => item.id === itemId);
        if (currentIndex < 0 || currentIndex >= candidateItems.length - 1) return prev; // 既に末尾または見つからない
        
        if (selectedItemIds.has(itemId)) {
          // 複数選択時
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          
          // 選択されたアイテムの中で最も後ろの位置を見つける
          let lastSelectedIndex = -1;
          candidateItems.forEach((item, index) => {
              if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
          });
          
          // 選択されたアイテムが最後にない場合のみ移動
          if (lastSelectedIndex >= 0 && lastSelectedIndex < candidateItems.length - 1) {
            const jumpOverItemId = candidateItems[lastSelectedIndex + 1].id;
            const targetIndexInListWithout = listWithoutSelection.findIndex(item => item.id === jumpOverItemId);
            
            if (targetIndexInListWithout !== -1) {
              listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);
              
              // 実行モード列のアイテムはそのまま、候補リストのみ並び替え
              const executeItems = allItems.filter(item => 
                item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
              );
              
              const newItems = allItems.map(item => {
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
          // 単一アイテム
          [candidateItems[currentIndex], candidateItems[currentIndex + 1]] = [candidateItems[currentIndex + 1], candidateItems[currentIndex]];
          
          // 実行モード列のアイテムはそのまま、候補リストのみ並び替え
          const executeItems = allItems.filter(item => 
            item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
          );
          
          const newItems = allItems.map(item => {
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
      // 実行モード: 通常の並び替え
      setEventLists(prev => {
        const newItems = [...(prev[activeEventName] || [])];
        const currentIndex = newItems.findIndex(item => item.id === itemId);
        
        if (currentIndex < 0 || currentIndex >= newItems.length - 1) return prev; // 既に末尾または見つからない
        
        if (selectedItemIds.has(itemId)) {
          const selectedBlock = newItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = newItems.filter(item => !selectedItemIds.has(item.id));
          
          // 選択されたアイテムの中で最も後ろの位置を見つける
          let lastSelectedIndex = -1;
          newItems.forEach((item, index) => {
             if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
          });
          
          // 選択されたアイテムが最後にない場合のみ移動
          if (lastSelectedIndex >= 0 && lastSelectedIndex < newItems.length - 1) {
            const jumpOverItemId = newItems[lastSelectedIndex + 1].id;
            const targetIndexInListWithout = listWithoutSelection.findIndex(item => item.id === jumpOverItemId);
            
            if (targetIndexInListWithout !== -1) {
              listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);
              return { ...prev, [activeEventName]: listWithoutSelection };
            }
          }
          return prev;
        } else {
          [newItems[currentIndex], newItems[currentIndex + 1]] = [newItems[currentIndex + 1], newItems[currentIndex]];
          return { ...prev, [activeEventName]: newItems };
        }
      });
    }
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, areItemsInSameHall]);

  const handleMoveToExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    // 修正1: 表示側(View)と同じロジックで現在の対象日を特定する
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    // 現在の実行列にあるIDセット
    const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    
    // 範囲選択の起点・終点が移動対象に含まれている場合、範囲選択をリセット
    if (rangeStart && itemIds.includes(rangeStart.itemId) && rangeStart.columnType === 'candidate') {
      setRangeStart(null);
      setRangeEnd(null);
    } else if (rangeEnd && itemIds.includes(rangeEnd.itemId) && rangeEnd.columnType === 'candidate') {
      setRangeEnd(null);
    }
    
    // 修正2: activeTabではなく、特定したcurrentEventDateを使用してアイテムを抽出（表示側と一致させる）
    // これにより、画面上の並び順（itemsの順序）が正であるという前提で母集団を作ります
    const currentTabItemsForMove = items.filter(item => item.eventDate === currentEventDate);
    
    // 修正3: 表示されている「候補リスト」と完全に同じロジックでリストを再構築する
    // 1. 既に左列にあるものを除外
    let candidateItems = currentTabItemsForMove.filter(item => !executeIdsSet.has(item.id));
    
    // 2. ブロックフィルタが適用されている場合はそれも適用（見えていないアイテムは移動させない仕様の場合）
    // もし「見えていないが選択されているアイテム」も移動させたい場合はこのブロックを外しますが、
    // 通常は「見えている順序」を維持するため、このフィルタも含めるのが適切です。
    if (selectedBlockFilters.size > 0) {
      candidateItems = candidateItems.filter(item => selectedBlockFilters.has(item.block));
    }
    
    // 修正4: 再構築した「画面と同じ順序のリスト(candidateItems)」を基準にして、
    // 選択されたIDが含まれているかチェックして抽出する。
    // これにより、itemIds（引数）の順序（選択順など）に関係なく、リスト上の上から下の順序で抽出される。
    const itemIdsSet = new Set(itemIds);
    const itemsToMove = candidateItems.filter(item => itemIdsSet.has(item.id));
    const orderedItemIds = itemsToMove.map(item => item.id);
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const currentDayItems = [...(eventItems[currentEventDate] || [])];
      
      // 既存のアイテムを保持し、新しいアイテムを末尾に追加（画面上の順序を維持したorderedItemIdsを使用）
      const existingIdsSet = new Set(currentDayItems);
      const newItemIds = orderedItemIds.filter(id => !existingIdsSet.has(id));
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [currentEventDate]: [...currentDayItems, ...newItemIds]
        }
      };
    });
    
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab, eventDates, rangeStart, rangeEnd, items, executeModeItems, selectedBlockFilters]);
  const handleRemoveFromExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    // 範囲選択の起点・終点が移動対象に含まれている場合、範囲選択をリセット
    if (rangeStart && itemIds.includes(rangeStart.itemId) && rangeStart.columnType === 'execute') {
      setRangeStart(null);
      setRangeEnd(null);
    } else if (rangeEnd && itemIds.includes(rangeEnd.itemId) && rangeEnd.columnType === 'execute') {
      setRangeEnd(null);
    }
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const currentDayItems = (eventItems[currentEventDate] || []).filter(id => !itemIds.includes(id));
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [currentEventDate]: currentDayItems
        }
      };
    });
    
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab, eventDates, rangeStart, rangeEnd]);

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const currentModeValue = dayModes[activeEventName]?.[currentEventDate] || 'edit';
    const newMode: ViewMode = currentModeValue === 'edit' ? 'execute' : 'edit';
    
    setDayModes(prev => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: newMode
      }
    }));
    
    setSelectedItemIds(new Set());
    setCandidateNumberSortDirection(null);
  }, [activeEventName, activeTab, dayModes, eventDates]);
  
  // モードを直接設定する関数
  const handleSetViewMode = useCallback((mode: ViewMode, scrollToItemId?: string) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    setDayModes(prev => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || {}),
        [currentEventDate]: mode
      }
    }));
    
    setSelectedItemIds(new Set());
    setCandidateNumberSortDirection(null);
    
    // 集中モード以外に切り替えた場合、マップ表示状態をリセット
    if (mode !== 'focus') {
      setFocusModeMapVisible(false);
    }
    // モード切替時にオーバーライドをリセット
    setUiVisibilityOverride(false);
    setUiSettingsPanelOpen(false);
    
    // スクロール先のアイテムIDが指定されている場合
    if (scrollToItemId) {
      setTimeout(() => {
        const element = document.querySelector(`[data-item-id="${scrollToItemId}"]`);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 100);
    }
  }, [activeEventName, activeTab, eventDates]);
  
  const handleSelectEvent = useCallback((eventName: string) => {
    setActiveEventName(eventName);
    setSelectedItemIds(new Set());
    setSelectedBlockFilters(new Set());
    const eventItems = eventLists[eventName] || [];
    const dates = extractEventDates(eventItems);
    if (dates.length > 0) {
        setActiveTab(dates[0]);
    } else {
        setActiveTab('eventList');
    }
  }, [eventLists]);

  const handleDeleteEvent = useCallback((eventName: string) => {
    setEventLists(prev => {
        const newLists = {...prev};
        delete newLists[eventName];
        return newLists;
    });
    setEventMetadata(prev => {
        const newMetadata = {...prev};
        delete newMetadata[eventName];
        return newMetadata;
    });
    setExecuteModeItems(prev => {
        const newItems = {...prev};
        delete newItems[eventName];
        return newItems;
    });
    setDayModes(prev => {
        const newModes = {...prev};
        delete newModes[eventName];
        return newModes;
    });
    if (activeEventName === eventName) {
        setActiveEventName(null);
        setActiveTab('eventList');
    }
  }, [activeEventName]);

  const handleRenameEvent = useCallback((oldName: string) => {
    setEventToRename(oldName);
    setShowRenameDialog(true);
  }, []);

  const handleConfirmRename = useCallback((newName: string) => {
    if (!eventToRename) return;
    
    if (eventToRename === newName) {
      setShowRenameDialog(false);
      setEventToRename(null);
      return;
    }

    if (eventLists[newName]) {
      alert('その名前の即売会は既に存在します。別の名前を入力してください。');
      return;
    }

    setEventLists(prev => {
      const newLists = { ...prev };
      if (newLists[eventToRename]) {
        newLists[newName] = newLists[eventToRename];
        delete newLists[eventToRename];
      }
      return newLists;
    });

    setEventMetadata(prev => {
      const newMetadata = { ...prev };
      if (newMetadata[eventToRename]) {
        newMetadata[newName] = newMetadata[eventToRename];
        delete newMetadata[eventToRename];
      }
      return newMetadata;
    });

    setDayModes(prev => {
      const newModes = { ...prev };
      if (newModes[eventToRename]) {
        newModes[newName] = newModes[eventToRename];
        delete newModes[eventToRename];
      }
      return newModes;
    });

    setExecuteModeItems(prev => {
      const newItems = { ...prev };
      if (newItems[eventToRename]) {
        newItems[newName] = newItems[eventToRename];
        delete newItems[eventToRename];
      }
      return newItems;
    });

    // マップデータの名前変更
    setMapData(prev => {
      const newData = { ...prev };
      if (newData[eventToRename]) {
        newData[newName] = newData[eventToRename];
        delete newData[eventToRename];
      }
      return newData;
    });

    // ルート設定の名前変更
    setRouteSettings(prev => {
      const newSettings = { ...prev };
      if (newSettings[eventToRename]) {
        newSettings[newName] = newSettings[eventToRename];
        delete newSettings[eventToRename];
      }
      return newSettings;
    });

    // ホール定義の名前変更
    setHallDefinitions(prev => {
      const newDefs = { ...prev };
      if (newDefs[eventToRename]) {
        newDefs[newName] = newDefs[eventToRename];
        delete newDefs[eventToRename];
      }
      return newDefs;
    });

    // ホールルート設定の名前変更
    setHallRouteSettings(prev => {
      const newSettings = { ...prev };
      if (newSettings[eventToRename]) {
        newSettings[newName] = newSettings[eventToRename];
        delete newSettings[eventToRename];
      }
      return newSettings;
    });

    if (activeEventName === eventToRename) {
      setActiveEventName(newName);
    }

    setShowRenameDialog(false);
    setEventToRename(null);
  }, [eventToRename, eventLists, activeEventName]);

  const handleSortToggle = () => {
    setSelectedItemIds(new Set());
    setBlockSortDirection(null);
    // フィルタ変更時に最近変更されたアイテムの追跡をリセット
    setRecentlyChangedItemIds(new Set());
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');

    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;

      const itemsForTab = allItems.filter(item => item.eventDate === currentTabKey);
      
      if (itemsForTab.length === 0) return prev;

      const sortedItemsForTab = [...itemsForTab].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', { numeric: true, sensitivity: 'base' });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      let sortedIndex = 0;
      const newItems = allItems.map(item => {
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
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');

    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

      // 候補リストのアイテムのみを取得
      const candidateItems = allItems.filter(item => 
        item.eventDate === currentTabKey && !executeIds.has(item.id)
      );
      
      if (candidateItems.length === 0) return prev;

      const sortedCandidateItems = [...candidateItems].sort((a, b) => {
        if (!a.block && !b.block) return 0;
        if (!a.block) return 1;
        if (!b.block) return -1;
        const comparison = a.block.localeCompare(b.block, 'ja', { numeric: true, sensitivity: 'base' });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      // 実行モード列のアイテムはそのまま、候補リストのアイテムのみ並び替え
      const executeItems = allItems.filter(item => 
        item.eventDate === currentTabKey && executeIds.has(item.id)
      );
      
      // 実行モード列と候補リストを結合（実行モード列が先）
      const newItems = allItems.map(item => {
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
    
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: prev[activeEventName].filter(item => item.id !== deletedId)
    }));
    
    // 実行モードアイテムからも削除
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName];
      if (!eventItems) return prev;
      
      const updatedEventItems: ExecuteModeItems = {};
      Object.keys(eventItems).forEach(eventDate => {
        updatedEventItems[eventDate] = eventItems[eventDate].filter(id => id !== deletedId);
      });
      
      return {
        ...prev,
        [activeEventName]: updatedEventItems
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

  const handleSelectItem = useCallback((itemId: string, columnType?: 'execute' | 'candidate') => {
    setSortState('Manual');
    setBlockSortDirection(null);
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const currentColumnType = columnType || (activeEventName ? 
      (executeModeItems[activeEventName]?.[currentEventDate]?.includes(itemId) ? 'execute' : 'candidate') : 
      'execute');
    
    // 現在の列のアイテムを直接計算
    let currentItems: ShoppingItem[] = [];
    if (activeEventName) {
      if (currentColumnType === 'execute') {
        const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
        const itemsMap = new Map(items.map(item => [item.id, item]));
        currentItems = executeIds.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
      } else {
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        let filtered = items.filter(item => 
          item.eventDate === currentEventDate && !executeIds.has(item.id)
        );
        // ブロックフィルタを適用
        if (selectedBlockFilters.size > 0) {
          filtered = filtered.filter(item => selectedBlockFilters.has(item.block));
        }
        currentItems = filtered;
      }
    }
    
    setSelectedItemIds(prev => {
        const newSet = new Set(prev);
        const wasSelected = newSet.has(itemId);
        
        if (wasSelected) {
            newSet.delete(itemId);
            // 選択解除時は起点・終点をリセット
            if (rangeStart?.itemId === itemId && rangeStart.columnType === currentColumnType) {
                setRangeStart(null);
                setRangeEnd(null);
            } else if (rangeEnd?.itemId === itemId && rangeEnd.columnType === currentColumnType) {
                setRangeEnd(null);
            }
        } else {
            newSet.add(itemId);
            
            // 起点が未設定の場合、または異なる列の場合は起点を設定
            if (!rangeStart || rangeStart.columnType !== currentColumnType) {
                setRangeStart({ itemId, columnType: currentColumnType });
                setRangeEnd(null);
            } else {
                // 起点が設定済みで、同じ列の場合
                // 起点の直上または直下のアイテムかチェック
                const startIndex = currentItems.findIndex(item => item.id === rangeStart.itemId);
                const currentIndex = currentItems.findIndex(item => item.id === itemId);
                
                // 起点の直上または直下でない場合のみ終点として設定
                if (startIndex !== -1 && currentIndex !== -1) {
                    const isAdjacent = Math.abs(startIndex - currentIndex) === 1;
                    if (!isAdjacent) {
                        setRangeEnd({ itemId, columnType: currentColumnType });
                    } else {
                        // 直上または直下の場合は終点をリセット
                        setRangeEnd(null);
                    }
                }
            }
        }
        
        return newSet;
    });
  }, [activeTab, activeEventName, executeModeItems, eventDates, rangeStart, rangeEnd, items, selectedBlockFilters]);

  const handleToggleBlockFilter = useCallback((block: string) => {
    setSelectedBlockFilters(prev => {
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

  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<'asc' | 'desc' | null>(null);

  const handleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;
    
    const nextDirection = candidateNumberSortDirection === 'asc' ? 'desc' : 'asc';
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = currentEventDate;
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);

      // 候補リストのアイテムのみを取得
      const candidateItems = allItems.filter(item => 
        item.eventDate === currentTabKey && !executeIds.has(item.id)
      );
      
      // ブロックフィルタを適用
      let filteredCandidateItems = candidateItems;
      if (selectedBlockFilters.size > 0) {
        filteredCandidateItems = candidateItems.filter(item => selectedBlockFilters.has(item.block));
      }
      
      if (filteredCandidateItems.length === 0) return prev;

      // ナンバーでソート
      const sortedCandidateItems = [...filteredCandidateItems].sort((a, b) => {
        const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
        return nextDirection === 'asc' ? comparison : -comparison;
      });

      // 候補リストのアイテムのIDと順序をマップ
      const sortedCandidateMap = new Map(sortedCandidateItems.map((item, index) => [item.id, { item, sortIndex: index }]));
      
      // 元のリストを維持しつつ、候補リストのアイテムのみをソート順に再配置
      const otherItems: ShoppingItem[] = [];
      const candidateItemsToSort: { item: ShoppingItem; originalIndex: number; sortIndex: number }[] = [];
      
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
      
      // ソートインデックスでソート
      candidateItemsToSort.sort((a, b) => a.sortIndex - b.sortIndex);
      
      // 元の順序を保持しつつ、候補リストのアイテムをソート順に配置
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
        [activeEventName]: resultItems
      };
    });

    setCandidateNumberSortDirection(nextDirection);
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab, executeModeItems, selectedBlockFilters, candidateNumberSortDirection, eventDates]);

  const handleClearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
    setRangeStart(null);
    setRangeEnd(null);
  }, []);

  // 範囲内のアイテムを一括でチェック/チェック解除する関数
  const handleToggleRangeSelection = useCallback((columnType: 'execute' | 'candidate') => {
    if (!rangeStart || rangeStart.columnType !== columnType || !rangeEnd || rangeEnd.columnType !== columnType) {
      return;
    }

    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    // 現在の列のアイテムを直接計算
    let currentItems: ShoppingItem[] = [];
    if (columnType === 'execute') {
      const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
      const itemsMap = new Map(items.map(item => [item.id, item]));
      currentItems = executeIds.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
    } else {
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      let filtered = items.filter(item => 
        item.eventDate === currentEventDate && !executeIds.has(item.id)
      );
      // ブロックフィルタを適用
      if (selectedBlockFilters.size > 0) {
        filtered = filtered.filter(item => selectedBlockFilters.has(item.block));
      }
      currentItems = filtered;
    }
    
    // ホール定義とマップデータを取得してグループ化
    const halls = getHallsForDate(currentEventDate);
    const currentMapData = getMapDataForDate(currentEventDate);
    
    // グループ化が有効な場合、同一グループ内のアイテムのみを対象にする
    if (halls.length > 0 && currentMapData) {
      // アイテムのホールIDを取得するヘルパー
      const getHallIdForItem = (item: ShoppingItem): string | null => {
        const block = currentMapData.blocks.find(b => b.name === item.block);
        if (!block) return null;
        
        const numMatch = item.number?.match(/\d+/);
        if (!numMatch) return null;
        const num = parseInt(numMatch[0], 10);
        
        const cell = block.numberCells.find((nc: { row: number; col: number; value: number }) => nc.value === num);
        if (!cell) return null;
        
        // 多角形内判定
        const isPointInPoly = (row: number, col: number, vertices: { row: number; col: number }[]): boolean => {
          if (vertices.length < 3) return false;
          let inside = false;
          for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
            const xi = vertices[i].col, yi = vertices[i].row;
            const xj = vertices[j].col, yj = vertices[j].row;
            if (((yi > row) !== (yj > row)) && (col < (xj - xi) * (row - yi) / (yj - yi) + xi)) {
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
      
      // グループIDを生成するヘルパー
      const buildGroupId = (hallId: string | null, priority: 'none' | 'priority' | 'highest'): string | null => {
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
      
      // rangeStartとrangeEndのグループIDを確認
      const startItem = currentItems.find(item => item.id === rangeStart.itemId);
      const endItem = currentItems.find(item => item.id === rangeEnd.itemId);
      
      if (!startItem || !endItem) return;
      
      const startGroupId = getItemGroupId(startItem);
      const endGroupId = getItemGroupId(endItem);
      
      // 異なるグループの場合は何もしない
      if (startGroupId !== endGroupId) {
        return;
      }
      
      // 同じグループ内のアイテムのみを対象にする
      const groupItems = currentItems.filter(item => getItemGroupId(item) === startGroupId);
      
      const startIndex = groupItems.findIndex(item => item.id === rangeStart.itemId);
      const endIndex = groupItems.findIndex(item => item.id === rangeEnd.itemId);
      
      if (startIndex === -1 || endIndex === -1) return;
      
      const minIndex = Math.min(startIndex, endIndex);
      const maxIndex = Math.max(startIndex, endIndex);
      const rangeItems = groupItems.slice(minIndex, maxIndex + 1);
      
      // 範囲内のアイテムが全てチェック済みかチェック
      setSelectedItemIds(prev => {
        const allSelected = rangeItems.every(item => prev.has(item.id));
        const newSet = new Set(prev);
        if (allSelected) {
          rangeItems.forEach(item => newSet.delete(item.id));
          setRangeStart(null);
          setRangeEnd(null);
        } else {
          rangeItems.forEach(item => newSet.add(item.id));
        }
        return newSet;
      });
      return;
    }
    
    // グループ化が無効な場合は従来のロジック
    const startIndex = currentItems.findIndex(item => item.id === rangeStart.itemId);
    const endIndex = currentItems.findIndex(item => item.id === rangeEnd.itemId);
    
    if (startIndex === -1 || endIndex === -1) return;
    
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    const rangeItems = currentItems.slice(minIndex, maxIndex + 1);
    
    // 範囲内のアイテムが全てチェック済みかチェック
    setSelectedItemIds(prev => {
      const allSelected = rangeItems.every(item => prev.has(item.id));
      const newSet = new Set(prev);
      if (allSelected) {
        // 全てチェック済みの場合はチェックを外す
        // チェック解除時は起点・終点もリセット（画面右上の✖ボタンと同様の動作）
        rangeItems.forEach(item => newSet.delete(item.id));
        setRangeStart(null);
        setRangeEnd(null);
      } else {
        // 未チェックのアイテムがある場合は全てチェックを入れる
        rangeItems.forEach(item => newSet.add(item.id));
      }
      return newSet;
    });
  }, [rangeStart, rangeEnd, activeTab, activeEventName, eventDates, executeModeItems, items, selectedBlockFilters, getHallsForDate, getMapDataForDate]);

  const handleBulkSort = useCallback((direction: BulkSortDirection) => {
    if (!activeEventName || selectedItemIds.size === 0) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'edit') {
      // 編集モード: 選択されたアイテムが実行モード列か候補リストかを判定
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      const selectedItems = items.filter(item => selectedItemIds.has(item.id));
      const isInExecuteColumn = selectedItems.some(item => executeIds.has(item.id));
      const isInCandidateColumn = selectedItems.some(item => !executeIds.has(item.id));
      
      if (isInExecuteColumn && !isInCandidateColumn) {
        // 実行モード列のみ
        setExecuteModeItems(prev => {
          const eventItems = prev[activeEventName] || {};
          const dayItems = [...(eventItems[currentEventDate] || [])];
          
          const itemsMap = new Map(items.map(item => [item.id, item]));
          const selectedItems = dayItems
            .filter(id => selectedItemIds.has(id))
            .map(id => itemsMap.get(id)!)
            .filter(Boolean);
          
          const otherItems = dayItems.filter(id => !selectedItemIds.has(id));
          selectedItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'asc' ? comparison : -comparison;
          });
          
          const firstSelectedIndex = dayItems.findIndex(id => selectedItemIds.has(id));
          if (firstSelectedIndex === -1) return prev;
          const newDayItems = [...otherItems];
          newDayItems.splice(firstSelectedIndex, 0, ...selectedItems.map(item => item.id));
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: newDayItems }
          };
        });
      } else if (isInCandidateColumn && !isInExecuteColumn) {
        // 候補リストのみ
        setEventLists(prev => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = currentEventDate;
          const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
          
          const candidateItems = allItems.filter(item => 
            item.eventDate === currentTabKey && !executeIdsSet.has(item.id)
          );
          const selectedCandidateItems = candidateItems.filter(item => selectedItemIds.has(item.id));
          const otherCandidateItems = candidateItems.filter(item => !selectedItemIds.has(item.id));
          
          selectedCandidateItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'asc' ? comparison : -comparison;
          });
          
          const firstSelectedIndex = candidateItems.findIndex(item => selectedItemIds.has(item.id));
          if (firstSelectedIndex === -1) return prev;
          
          const sortedCandidateItems = [...otherCandidateItems];
          sortedCandidateItems.splice(firstSelectedIndex, 0, ...selectedCandidateItems);
          
          // 実行モード列のアイテムはそのまま、候補リストのみ並び替え
          const executeItems = allItems.filter(item => 
            item.eventDate === currentTabKey && executeIdsSet.has(item.id)
          );
          
          const newItems = allItems.map(item => {
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
      // 実行モード: 通常ソート
      setEventLists(prev => {
        const currentItems = [...(prev[activeEventName] || [])];
        const selectedItems = currentItems.filter(item => selectedItemIds.has(item.id));
        const otherItems = currentItems.filter(item => !selectedItemIds.has(item.id));

        selectedItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'asc' ? comparison : -comparison;
        });
        
        const firstSelectedIndex = currentItems.findIndex(item => selectedItemIds.has(item.id));
        if (firstSelectedIndex === -1) return prev;

        const newItems = [...otherItems];
        newItems.splice(firstSelectedIndex, 0, ...selectedItems);

        return { ...prev, [activeEventName]: newItems };
      });
    }
  }, [activeEventName, selectedItemIds, items, activeTab, dayModes, executeModeItems, eventDates]);

  // エクスポートオプションダイアログを表示
  const handleExportEvent = useCallback((eventName: string) => {
    const itemsToExport = eventLists[eventName];
    if (!itemsToExport || itemsToExport.length === 0) {
      alert('エクスポートするアイテムがありません。');
      return;
    }
    setExportEventName(eventName);
    setShowExportOptions(true);
  }, [eventLists]);

  // 実際のエクスポート処理（xlsx形式）
  const handleConfirmExport = useCallback(async (options: ExportOptions) => {
    if (!exportEventName) return;
    
    const itemsToExport = eventLists[exportEventName];
    if (!itemsToExport || itemsToExport.length === 0) {
      return;
    }

    try {
      const blob = await exportToXlsx(
        exportEventName,
        itemsToExport,
        options,
        {
          metadata: eventMetadata[exportEventName],
          executeModeItems,
          dayModes,
          mapData,
          routeSettings,
          hallDefinitions,
          hallRouteSettings,
        }
      );

      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      const suffix = options.format === 'full' ? 'full' : 'simple';
      const filename = `${exportEventName}_${timestamp}_${suffix}.xlsx`;
      
      downloadBlob(blob, filename);
    } catch (error) {
      console.error('Export error:', error);
      alert('エクスポートに失敗しました。');
    }
    
    setExportEventName(null);
  }, [eventLists, executeModeItems, eventMetadata, dayModes, mapData, routeSettings, hallDefinitions, hallRouteSettings, exportEventName]);

  // エクスポートファイルのインポート処理
  const handleExportFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // input をリセット
    e.target.value = '';
    
    try {
      const result = await importFromXlsx(file);
      
      if (!result.success) {
        alert(`インポートに失敗しました:\n${result.errors.join('\n')}`);
        return;
      }
      
      if (result.items.length === 0) {
        alert('インポートするアイテムがありません。');
        return;
      }
      
      // イベント名の重複チェック - 同名がある場合は上書き更新
      let eventName = result.eventName;
      const isUpdate = !!eventLists[eventName];
      
      // アイテムを保存
      setEventLists(prev => ({
        ...prev,
        [eventName]: result.items,
      }));
      
      // メタデータを保存
      if (result.metadata) {
        setEventMetadata(prev => ({
          ...prev,
          [eventName]: result.metadata as EventMetadata,
        }));
      }
      
      // 配置情報を保存
      if (result.layoutInfo) {
        if (Object.keys(result.layoutInfo.executeModeItems).length > 0) {
          setExecuteModeItems(prev => ({
            ...prev,
            [eventName]: result.layoutInfo!.executeModeItems,
          }));
        }
        if (Object.keys(result.layoutInfo.dayModes).length > 0) {
          setDayModes(prev => ({
            ...prev,
            [eventName]: result.layoutInfo!.dayModes as unknown as DayModeState,
          }));
        }
      }
      
      // マップデータを保存
      if (result.mapData && Object.keys(result.mapData).length > 0) {
        setMapData(prev => ({
          ...prev,
          [eventName]: result.mapData as MapDataStore[string],
        }));
      }
      
      // ルート設定を保存
      if (result.routeSettings && Object.keys(result.routeSettings).length > 0) {
        setRouteSettings(prev => ({
          ...prev,
          [eventName]: result.routeSettings as RouteSettingsStore[string],
        }));
      }
      
      // ホール定義を保存
      if (result.hallDefinitions && Object.keys(result.hallDefinitions).length > 0) {
        setHallDefinitions(prev => ({
          ...prev,
          [eventName]: result.hallDefinitions as HallDefinitionsStore[string],
        }));
      }
      
      // ホールルート設定を保存
      if (result.hallRouteSettings && Object.keys(result.hallRouteSettings).length > 0) {
        setHallRouteSettings(prev => ({
          ...prev,
          [eventName]: result.hallRouteSettings as HallRouteSettingsStore[string],
        }));
      }
      
      // エラーがあれば表示
      if (result.errors.length > 0) {
        alert(`インポート完了（一部エラーあり）:\n${result.errors.join('\n')}`);
      } else if (isUpdate) {
        alert(`「${eventName}」を更新しました。\n${result.items.length}件のアイテム`);
      } else {
        alert(`「${eventName}」を作成しました。\n${result.items.length}件のアイテム`);
      }
      
      // インポートしたイベントを選択
      setActiveEventName(eventName);
      const eventDates = extractEventDates(result.items);
      if (eventDates.length > 0) {
        setActiveTab(eventDates[0]);
      }
      
    } catch (error) {
      console.error('Import error:', error);
      alert('インポートに失敗しました。ファイル形式を確認してください。');
    }
  }, [eventLists]);

  // アイテム更新機能
  const handleUpdateEvent = useCallback(async (eventName: string, urlOverride?: { url: string; sheetName: string }) => {
    const metadata = eventMetadata[eventName];
    let url = urlOverride?.url || metadata?.spreadsheetUrl;
    let sheetName = urlOverride?.sheetName || metadata?.spreadsheetSheetName || '';

    if (!url) {
      alert('スプレッドシートのURLが保存されていません。');
      return;
    }

    try {
      const sheetIdMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (!sheetIdMatch) {
        throw new Error('無効なURL');
      }

      const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetIdMatch[1]}/gviz/tq?tqx=out:csv${sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : ''}`;
      
      const response = await fetch(csvUrl);
      if (!response.ok) {
        throw new Error('スプレッドシートの読み込みに失敗しました。');
      }

      const text = await response.text();
      const lines = text.split('\n').filter(line => line.trim() !== '');
      
      const sheetItems: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];
      
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const cells: string[] = [];
        let currentCell = '';
        let insideQuotes = false;

        for (let j = 0; j < line.length; j++) {
          const char = line[j];
          
          if (char === '"') {
            if (insideQuotes && line[j + 1] === '"') {
              currentCell += '"';
              j++;
            } else {
              insideQuotes = !insideQuotes;
            }
          } else if (char === ',' && !insideQuotes) {
            cells.push(currentCell);
            currentCell = '';
          } else {
            currentCell += char;
          }
        }
        cells.push(currentCell);

        // M列(12), N列(13), O列(14), P列(15)が全て入力されている行のみをインポート
        const circle = cells[12]?.trim() || ''; // M列 (0-indexed: 12)
        const eventDate = cells[13]?.trim() || ''; // N列 (0-indexed: 13)
        const block = cells[14]?.trim() || ''; // O列 (0-indexed: 14)
        const number = cells[15]?.trim() || ''; // P列 (0-indexed: 15)
        
        if (!circle || !eventDate || !block || !number) {
          continue;
        }

        const title = cells[16]?.trim() || ''; // Q列 (0-indexed: 16)
        // 空欄の場合はnull、0と入力されている場合は0を設定
        const priceStr = cells[17]?.trim() || '';
        const price = priceStr === '' ? null : (parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0); // R列 (0-indexed: 17)
        const remarks = cells[22]?.trim() || ''; // W列 (0-indexed: 22)
        const url = cells[24]?.trim() || ''; // Y列 (0-indexed: 24)
        // AA列から数量を取得、空欄時は1、それ以外は数値を反映（1-10の範囲に制限）
        const quantityStr = cells[26]?.trim() || ''; // AA列 (0-indexed: 26)
        const quantity = quantityStr === '' ? 1 : Math.max(1, Math.min(10, parseInt(quantityStr.replace(/[^0-9]/g, ''), 10) || 1));

        const item: Omit<ShoppingItem, 'id' | 'purchaseStatus'> = {
          circle,
          eventDate,
          block,
          number,
          title,
          price,
          quantity,
          remarks,
          ...(url ? { url } : {}),
        };
        sheetItems.push(item);
      }
      
      // 各参加日タブ中でサークル名が重複するアイテムのURL転記処理
      const eventDateGroups = new Map<string, Omit<ShoppingItem, 'id' | 'purchaseStatus'>[]>();
      sheetItems.forEach(item => {
        if (!eventDateGroups.has(item.eventDate)) {
          eventDateGroups.set(item.eventDate, []);
        }
        eventDateGroups.get(item.eventDate)!.push(item);
      });
      
      eventDateGroups.forEach((items) => {
        // サークル名でグループ化
        const circleGroups = new Map<string, Omit<ShoppingItem, 'id' | 'purchaseStatus'>[]>();
        items.forEach(item => {
          if (!circleGroups.has(item.circle)) {
            circleGroups.set(item.circle, []);
          }
          circleGroups.get(item.circle)!.push(item);
        });
        
        // サークル名が重複するアイテムが2つ以上ある場合
        circleGroups.forEach((circleItems) => {
          if (circleItems.length >= 2) {
            // URLが入力されているアイテムを探す
            const itemWithUrl = circleItems.find(item => item.url && item.url.trim() !== '');
            
            if (itemWithUrl && itemWithUrl.url) {
              // URLが入力されていないアイテムにURLを転記
              circleItems.forEach(item => {
                if (!item.url || item.url.trim() === '') {
                  item.url = itemWithUrl.url;
                }
              });
            }
          }
        });
      });

      const currentItems = eventLists[eventName] || [];
      
      // サークル名・参加日・ブロック・ナンバー・タイトルで照合するキーでマップを作成
      const currentItemsMapWithAll = new Map(currentItems.map(item => [getItemKey(item), item]));
      
      // サークル名・参加日・ブロック・ナンバーで照合するキーでマップを作成（タイトル変更検出用）
      const sheetItemsMapWithoutTitle = new Map(sheetItems.map(item => [getItemKeyWithoutTitle(item), item]));
      const currentItemsMapWithoutTitle = new Map(currentItems.map(item => [getItemKeyWithoutTitle(item), item]));

      const itemsToDelete: ShoppingItem[] = [];
      const itemsToUpdate: ShoppingItem[] = [];
      const itemsToAdd: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];
      let protectedFromDelete = 0;
      let protectedFromUpdate = 0;

      // 保護レベルを取得するヘルパー関数
      const getEffectiveProtectionLevel = (item: ShoppingItem): 'full' | 'deletable' | 'none' => {
        if (item.protectionLevel) return item.protectionLevel;
        // sourceが'app'の場合はfull（完全保護）、それ以外（spreadsheetまたは未設定）はnone（保護なし）
        return item.source === 'app' ? 'full' : 'none';
      };

      // 削除対象: スプレッドシートにないアイテム（サークル名・参加日・ブロック・ナンバーで照合）
      // ただし、保護レベルが'full'（完全保護）のアイテムは削除しない
      currentItems.forEach(item => {
        const keyWithoutTitle = getItemKeyWithoutTitle(item);
        if (!sheetItemsMapWithoutTitle.has(keyWithoutTitle)) {
          const protectionLevel = getEffectiveProtectionLevel(item);
          // 完全保護（full）のアイテムは削除しない
          if (protectionLevel !== 'full') {
            itemsToDelete.push(item);
          } else {
            protectedFromDelete++;
          }
        }
      });

      // 更新・追加対象の処理
      sheetItems.forEach(sheetItem => {
        const keyWithAll = getItemKey(sheetItem);
        const keyWithoutTitle = getItemKeyWithoutTitle(sheetItem);
        
        // 完全一致（サークル名・参加日・ブロック・ナンバー・タイトル）で既存アイテムを検索
        const existingWithAll = currentItemsMapWithAll.get(keyWithAll);
        if (existingWithAll) {
          // 保護レベルを確認
          const protectionLevel = getEffectiveProtectionLevel(existingWithAll);
          // 完全保護（full）または削除のみ許可（deletable）のアイテムは更新しない
          if (protectionLevel === 'full' || protectionLevel === 'deletable') {
            // 変更があるべきなのに保護されている場合のみカウント
            if (
              existingWithAll.price !== sheetItem.price ||
              existingWithAll.remarks !== sheetItem.remarks ||
              existingWithAll.url !== sheetItem.url
            ) {
              protectedFromUpdate++;
            }
            return;
          }
          // 完全一致した場合、価格や備考、URLが変わっていれば更新
          if (
            existingWithAll.price !== sheetItem.price ||
            existingWithAll.remarks !== sheetItem.remarks ||
            existingWithAll.url !== sheetItem.url
          ) {
            itemsToUpdate.push({
              ...existingWithAll,
              price: sheetItem.price,
              remarks: sheetItem.remarks,
              url: sheetItem.url
            });
          }
          return;
        }
        
        // タイトルなしで既存アイテムを検索（タイトルが変更された場合）
        const existingWithoutTitle = currentItemsMapWithoutTitle.get(keyWithoutTitle);
        if (existingWithoutTitle) {
          // 保護レベルを確認
          const protectionLevel = getEffectiveProtectionLevel(existingWithoutTitle);
          // 完全保護（full）または削除のみ許可（deletable）のアイテムは更新しない
          if (protectionLevel === 'full' || protectionLevel === 'deletable') {
            protectedFromUpdate++;
            return;
          }
          // タイトルや価格、備考、URLが変わっていれば更新
          itemsToUpdate.push({
            ...existingWithoutTitle,
            title: sheetItem.title,
            price: sheetItem.price,
            remarks: sheetItem.remarks,
            url: sheetItem.url
          });
          return;
        }
        
        // 新規追加（候補リストに追加）
        itemsToAdd.push(sheetItem);
      });

      setUpdateData({ itemsToDelete, itemsToUpdate, itemsToAdd, protectedFromDelete, protectedFromUpdate });
      setUpdateEventName(eventName);
      setShowUpdateConfirmation(true);
    } catch (error) {
      console.error('Update error:', error);
      setPendingUpdateEventName(eventName);
      setShowUrlUpdateDialog(true);
    }
  }, [eventLists, eventMetadata]);

  const handleConfirmUpdate = () => {
    if (!updateData || !updateEventName) return;

    const { itemsToDelete, itemsToUpdate, itemsToAdd } = updateData;
    const eventName = updateEventName;
    
    setEventLists(prev => {
      let newItems: ShoppingItem[] = [...(prev[eventName] || [])];
      
      // 削除
      const deleteIds = new Set(itemsToDelete.map(item => item.id));
      newItems = newItems.filter(item => !deleteIds.has(item.id));
      
      // 更新
      const updateMap = new Map(itemsToUpdate.map(item => [item.id, item]));
      newItems = newItems.map(item => updateMap.get(item.id) || item);
      
      // 追加（ソート挿入 - 候補リストに追加）
      itemsToAdd.forEach(itemData => {
        const newItem: ShoppingItem = {
          id: crypto.randomUUID(),
          circle: itemData.circle,
          eventDate: itemData.eventDate,
          block: itemData.block,
          number: itemData.number,
          title: itemData.title,
          price: itemData.price,
          quantity: itemData.quantity ?? 1,
          remarks: itemData.remarks,
          purchaseStatus: 'None' as PurchaseStatus,
          source: 'spreadsheet' as const,  // スプレッドシートからの追加
          protectionLevel: 'none' as const,  // デフォルトは保護なし
          ...(itemData.url ? { url: itemData.url } : {})
        };
        newItems = insertItemSorted(newItems, newItem);
        // 候補リストに追加（実行モード列には追加しない）
      });
      
      return { ...prev, [eventName]: newItems };
    });

    // 削除されたアイテムを実行モードアイテムからも削除
    setExecuteModeItems(prev => {
      const eventItems = prev[eventName];
      if (!eventItems) return prev;
      
      const deleteIds = new Set(itemsToDelete.map(item => item.id));
      const updatedEventItems: ExecuteModeItems = {};
      
      Object.keys(eventItems).forEach(eventDate => {
        updatedEventItems[eventDate] = eventItems[eventDate].filter(id => !deleteIds.has(id));
      });
      
      return {
        ...prev,
        [eventName]: updatedEventItems
      };
    });

    setShowUpdateConfirmation(false);
    setUpdateData(null);
    setUpdateEventName(null);
    alert('アイテムを更新しました。');
  };

  const handleUrlUpdate = useCallback((newUrl: string, sheetName: string) => {
    setShowUrlUpdateDialog(false);
    if (pendingUpdateEventName) {
      handleUpdateEvent(pendingUpdateEventName, { url: newUrl, sheetName });
      setPendingUpdateEventName(null);
    }
  }, [pendingUpdateEventName, handleUpdateEvent]);

  // マップデータ取り込み
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
    
    // ダイアログを開く
    setMapImportPendingFile(file);
    setMapImportPendingEventName(eventName);
    setMapImportDialogOpen(true);
    
    // ファイル入力をリセット
    e.target.value = '';
  }, []);

  // マップ取り込みダイアログからの取り込み確定
  const handleMapImportConfirm = useCallback((parsedData: Record<string, DayMapData>, settings: BlockDetectionSettings) => {
    const eventName = mapImportPendingEventName;
    if (!eventName) return;
    
    // 設定をlocalStorageに保存
    saveBlockDetectionSettings(eventName, settings);
    
    // マップデータを保存
    setMapData(prev => ({
      ...prev,
      [eventName]: {
        ...(prev[eventName] || {}),
        ...parsedData,
      },
    }));
    
    const mapCount = Object.keys(parsedData).length;
    
    // 最初のマップタブに切り替え
    const firstMapName = Object.keys(parsedData)[0];
    if (firstMapName) {
      setActiveTab(firstMapName);
    }
    
    // ダイアログを閉じる
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
    
    alert(`${mapCount}件のマップデータを取り込みました。`);
  }, [mapImportPendingEventName]);

  // マップ取り込みダイアログのキャンセル
  const handleMapImportClose = useCallback(() => {
    setMapImportDialogOpen(false);
    setMapImportPendingFile(null);
    setMapImportPendingEventName('');
  }, []);

  // マップビューでの訪問先追加
  const handleAddToExecuteListFromMap = useCallback((itemId: string) => {
    if (!activeEventName || !isMapTab) return;
    
    // マップ名から参加日を取得
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    // アイテムのホールIDを取得
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    
    // ホール定義を取得
    const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
    const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[activeTab] || { hallOrder: [], hallVisitLists: [] };
    
    // アイテムのブロックからホールIDを特定
    const currentMapData = mapData[activeEventName]?.[activeTab];
    let itemHallId: string | null = null;
    
    if (currentMapData && halls.length > 0) {
      const itemBlockName = item.block?.trim() || '';
      const block = currentMapData.blocks.find(b => b.name === itemBlockName);
      
      if (block) {
        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;
        
        for (const hall of halls) {
          if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
            itemHallId = hall.id;
            break;
          }
        }
      }
    }
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      
      // 既に追加されている場合は何もしない
      if (dayItems.includes(itemId)) return prev;
      
      // ホールが特定できない場合は末尾に追加
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
      
      // ホール順序を取得（設定がなければホールの定義順）
      const hallOrder = hallRouteSettingsForMap.hallOrder.length > 0 
        ? hallRouteSettingsForMap.hallOrder 
        : halls.map(h => h.id);
      
      // 各アイテムのホールIDをマップ
      const itemsMap = new Map(items.map(i => [i.id, i]));
      const getHallIdForItem = (id: string): string | null => {
        const targetItem = itemsMap.get(id);
        if (!targetItem || !currentMapData) return null;
        
        const blockName = targetItem.block?.trim() || '';
        const targetBlock = currentMapData.blocks.find(b => b.name === blockName);
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
      
      // 同じホールの最後の位置を探す
      let insertIndex = dayItems.length; // デフォルトは末尾
      const itemHallIndex = hallOrder.indexOf(itemHallId);
      
      if (itemHallIndex >= 0) {
        // 同じホールの最後のアイテムの位置を探す
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
          // 同じホールのアイテムがある場合、その次に挿入
          insertIndex = lastSameHallIndex + 1;
        } else if (firstLaterHallIndex >= 0) {
          // 同じホールのアイテムがないが、後のホールのアイテムがある場合、その前に挿入
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
  }, [activeEventName, activeTab, isMapTab, items, hallDefinitions, hallRouteSettings, mapData]);

  // マップビューでの訪問先追加（位置指定あり）
  const handleAddToExecuteListFromMapAtPosition = useCallback((itemId: string, referenceItemId: string, position: 'before' | 'after') => {
    if (!activeEventName || !isMapTab) return;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      
      // 既に追加されている場合は何もしない
      if (dayItems.includes(itemId)) return prev;
      
      // 参照アイテムの位置を探す
      const refIndex = dayItems.indexOf(referenceItemId);
      if (refIndex < 0) {
        // 参照アイテムが見つからない場合は末尾に追加
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
  }, [activeEventName, activeTab, isMapTab]);

  // マップビューでの訪問先削除
  const handleRemoveFromExecuteListFromMap = useCallback((itemId: string) => {
    if (!activeEventName || !isMapTab) return;
    
    // マップ名から参加日を取得
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = (eventItems[dayName] || []).filter(id => id !== itemId);
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [dayName]: dayItems,
        },
      };
    });
  }, [activeEventName, activeTab, isMapTab]);

  // マップビューからの新規アイテム追加
  const handleAddNewItemFromMap = useCallback((eventDate: string, block: string, number: string) => {
    // 初期値を設定してアイテム追加タブに遷移
    setNewItemDefaults({ eventDate, block, number });
    setItemToEdit(null);
    setActiveTab('import');
  }, []);

  // 集中モードからの直接アイテム追加
  const handleAddItemFromFocusMode = useCallback((newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => {
    if (!activeEventName) return;
    
    // 購入状態を決定（指定がなければ'None'）
    const purchaseStatus = newItem.purchaseStatus || 'None';
    
    // 新しいアイテムを作成
    const item: ShoppingItem = {
      ...newItem,
      id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      purchaseStatus,
      source: 'app' as const,  // アプリからの追加
      protectionLevel: 'full' as const,  // 完全保護
    };
    
    // アイテムを追加
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: [...(prev[activeEventName] || []), item],
    }));
    
    // 購入済の場合は候補リストのみに追加（実行列には追加しない）
    if (purchaseStatus === 'Purchased') {
      return;
    }
    
    // 後回し・遅参の場合は実行列の適切なフェーズに最短経路位置で追加
    const dayName = newItem.eventDate;
    const mapTab = `${dayName}マップ`;
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      const allItems = eventLists[activeEventName] || [];
      const itemsMap = new Map(allItems.map(i => [i.id, i]));
      itemsMap.set(item.id, item); // 新アイテムも追加
      
      // マップデータとホール情報を取得
      const currentMapData = mapData[activeEventName]?.[mapTab];
      const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
      const hallSettings = hallRouteSettings[activeEventName]?.[mapTab];
      
      // ホール順序を取得
      const hallOrder = hallSettings?.hallOrder || halls.map(h => h.id);
      
      // アイテムの座標を取得するヘルパー
      const getItemPosition = (id: string): { row: number; col: number } | null => {
        const targetItem = itemsMap.get(id);
        if (!targetItem || !currentMapData) return null;
        
        const blockName = targetItem.block?.trim() || '';
        const targetBlock = currentMapData.blocks.find(b => b.name === blockName);
        if (!targetBlock) return null;
        
        // ナンバーセルの座標を探す
        const numberCells = targetBlock.numberCells || [];
        const normalizedNumber = targetItem.number.toLowerCase();
        
        for (const nc of numberCells) {
          if (String(nc.value).toLowerCase() === normalizedNumber) {
            return { row: nc.row, col: nc.col };
          }
        }
        
        // 見つからない場合はブロックの中心を返す
        return {
          row: (targetBlock.startRow + targetBlock.endRow) / 2,
          col: (targetBlock.startCol + targetBlock.endCol) / 2,
        };
      };
      
      // 2点間の距離を計算
      const calcDistance = (pos1: { row: number; col: number }, pos2: { row: number; col: number }): number => {
        return Math.abs(pos1.row - pos2.row) + Math.abs(pos1.col - pos2.col);
      };
      
      // 同じフェーズのアイテムのインデックスを収集
      const phaseStatus = purchaseStatus; // 'Postpone' or 'Late'
      const samePhaseIndices: number[] = [];
      
      for (let i = 0; i < dayItems.length; i++) {
        const existingItem = itemsMap.get(dayItems[i]);
        if (existingItem && existingItem.purchaseStatus === phaseStatus) {
          samePhaseIndices.push(i);
        }
      }
      
      // 新アイテムの座標を取得
      const newItemPos = getItemPosition(item.id);
      
      if (samePhaseIndices.length === 0 || !newItemPos) {
        // 同じフェーズのアイテムがない場合は末尾に追加
        dayItems.push(item.id);
      } else {
        // 同じフェーズのアイテム間で最短経路になる位置を探す
        let bestInsertIndex = samePhaseIndices[samePhaseIndices.length - 1] + 1;
        let minTotalDistance = Infinity;
        
        // 各挿入位置での総距離を計算
        for (let insertIdx = 0; insertIdx <= samePhaseIndices.length; insertIdx++) {
          let totalDistance = 0;
          
          // 挿入位置の前のアイテム
          if (insertIdx > 0) {
            const prevItemId = dayItems[samePhaseIndices[insertIdx - 1]];
            const prevPos = getItemPosition(prevItemId);
            if (prevPos) {
              totalDistance += calcDistance(prevPos, newItemPos);
            }
          }
          
          // 挿入位置の後のアイテム
          if (insertIdx < samePhaseIndices.length) {
            const nextItemId = dayItems[samePhaseIndices[insertIdx]];
            const nextPos = getItemPosition(nextItemId);
            if (nextPos) {
              totalDistance += calcDistance(newItemPos, nextPos);
            }
            
            // 元々の前後の距離を引く（新アイテムを挿入することで不要になる距離）
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
            // 実際の挿入位置を計算
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
  }, [activeEventName, eventLists, mapData, hallDefinitions, hallRouteSettings]);

  // マップビューでの先頭移動
  const handleMoveToFirstFromMap = useCallback((itemId: string) => {
    if (!activeEventName || !isMapTab) return;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = (eventItems[dayName] || []).filter(id => id !== itemId);
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [dayName]: [itemId, ...dayItems],
        },
      };
    });
  }, [activeEventName, activeTab, isMapTab]);

  // マップビューでの末尾移動
  const handleMoveToLastFromMap = useCallback((itemId: string) => {
    if (!activeEventName || !isMapTab) return;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = (eventItems[dayName] || []).filter(id => id !== itemId);
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [dayName]: [...dayItems, itemId],
        },
      };
    });
  }, [activeEventName, activeTab, isMapTab]);

  // 現在のマップに対応する参加日の実行列アイテムIDを取得
  const currentMapExecuteItemIds = useMemo(() => {
    if (!activeEventName || !isMapTab) return [];
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];
    
    return executeModeItems[activeEventName]?.[dayName] || [];
  }, [activeEventName, activeTab, isMapTab, executeModeItems]);
  
  // 現在のタブの参加日に該当するアイテムを取得
  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter(item => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

  // マップコントロール - extracted to useMapControls hook
  const mapControls = useMapControls();
  const {
    mapTabMenuOpen, setMapTabMenuOpen,
    mapTabMenuPosition, setMapTabMenuPosition,
    blockDefinitionMode, setBlockDefinitionMode,
    hallDefinitionMode, setHallDefinitionMode,
    mapSelectedHallId, setMapSelectedHallId,
    mapIsRouteVisible, setMapIsRouteVisible,
    mapIsHallOrderOpen, setMapIsHallOrderOpen,
    mapHallSelectorOpen, setMapHallSelectorOpen,
    mapSmartInsertEnabled, setMapSmartInsertEnabled,
    mapSmartInsertMode, setMapSmartInsertMode,
    smartInsertToast, setSmartInsertToast,
    smartInsertLongPressRef, smartInsertLongPressTriggeredRef,
    cellSelectionMode, setCellSelectionMode,
    pendingCellSelection, setPendingCellSelection,
    handleStartCellSelection,
    handleConfirmCellSelection,
    handleCancelCellSelection,
    vertexSelectionMode, setVertexSelectionMode,
    pendingVertexSelection, setPendingVertexSelection,
    handleStartVertexSelection,
    handleConfirmVertexSelection,
    handleCancelVertexSelection,
  } = mapControls;

  // 訪問先リスト - extracted to useVisitList hook
  const visitList = useVisitList(
    activeEventName, activeTab, isMapTab, items, executeModeItems, setExecuteModeItems,
    hallDefinitions, hallRouteSettings,
  );
  const {
    visitListPanelOpen, setVisitListPanelOpen,
    visitListPanelMapTab,
    visitListHasUnsavedChanges,
    highlightedMapCell,
    showVisitListConfirmDialog, setShowVisitListConfirmDialog,
    pendingTabChange, setPendingTabChange,
    visitListItems,
    visitListHallOrder,
    openVisitListPanel,
    handleVisitListOrderUpdate,
    handleVisitListConfirm,
    handleVisitListCancel,
    handleVisitListClose,
    handleHighlightMapCell,
    handleClearMapCellHighlight,
    handleVisitListDialogConfirm: visitListDialogConfirmRaw,
    handleVisitListDialogCancel: visitListDialogCancelRaw,
  } = visitList;

  // 訪問先リストパネルロジック - extracted to useVisitList hook

  // Wrap dialog handlers to perform tab change
  const handleVisitListDialogConfirm = useCallback(() => {
    const newTab = visitListDialogConfirmRaw();
    if (newTab) setActiveTab(newTab as ActiveTab);
  }, [visitListDialogConfirmRaw]);

  const handleVisitListDialogCancel = useCallback(() => {
    const newTab = visitListDialogCancelRaw();
    if (newTab) setActiveTab(newTab as ActiveTab);
  }, [visitListDialogCancelRaw]);

  // アイテムの優先度を変更するハンドラ
  const handleUpdateItemPriority = useCallback((itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
    if (!activeEventName || !visitListPanelMapTab) return;
    
    // アイテムの優先度を更新
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: (prev[activeEventName] || []).map(item => 
        item.id === itemId ? { ...item, priorityLevel } : item
      )
    }));
    
    // アイテムのホールIDを取得
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    
    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];
    
    // アイテムのホールIDを特定
    let itemHallId: string | null = null;
    if (mapDataForTab) {
      const block = mapDataForTab.blocks.find(b => b.name === item.block);
      if (block) {
        const numMatch = item.number?.match(/\d+/);
        if (numMatch) {
          const num = parseInt(numMatch[0], 10);
          const cell = block.numberCells.find(nc => nc.value === num);
          if (cell) {
            for (const hall of halls) {
              // 多角形内判定
              const isPointInPolygon = (row: number, col: number, vertices: { row: number; col: number }[]): boolean => {
                if (vertices.length < 3) return false;
                let inside = false;
                for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
                  const xi = vertices[i].col, yi = vertices[i].row;
                  const xj = vertices[j].col, yj = vertices[j].row;
                  if (((yi > row) !== (yj > row)) && (col < (xj - xi) * (row - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                  }
                }
                return inside;
              };
              
              if (isPointInPolygon(cell.row, cell.col, hall.vertices)) {
                itemHallId = hall.id;
                break;
              }
              // 頂点上にあるか
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
    
    // グループIDを生成
    const buildGroupId = (hallId: string | null, priority: 'none' | 'priority' | 'highest'): string => {
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
    
    // hallOrderを更新
    setHallRouteSettings(prev => {
      const currentSettings = prev[activeEventName]?.[visitListPanelMapTab] || { hallOrder: [], hallVisitLists: [] };
      let newHallOrder = [...currentSettings.hallOrder];
      
      // 現在のhallOrderにベースホール（通常グループ）がなければ追加
      if (!newHallOrder.includes(baseGroupId)) {
        newHallOrder.push(baseGroupId);
      }
      
      // 新しいグループが必要か確認（通常グループに戻す場合は不要）
      if (priorityLevel !== 'none' && !newHallOrder.includes(newGroupId)) {
        // 通常グループ（または優先グループ）の直前に挿入
        const priorityGroupId = buildGroupId(itemHallId, 'priority');
        
        // 挿入位置を決定
        let insertIndex = newHallOrder.length;
        
        if (priorityLevel === 'highest') {
          // 最優先は、優先グループまたは通常グループの直前
          const priorityIndex = newHallOrder.indexOf(priorityGroupId);
          const baseIndex = newHallOrder.indexOf(baseGroupId);
          
          if (priorityIndex !== -1) {
            insertIndex = priorityIndex;
          } else if (baseIndex !== -1) {
            insertIndex = baseIndex;
          }
        } else if (priorityLevel === 'priority') {
          // 優先は通常グループの直前
          const baseIndex = newHallOrder.indexOf(baseGroupId);
          if (baseIndex !== -1) {
            insertIndex = baseIndex;
          }
        }
        
        newHallOrder.splice(insertIndex, 0, newGroupId);
      }
      
      // 古いグループが空になるか確認（同じホール・同じ優先度の他のアイテムがあるか）
      // 注意: この時点ではitemの優先度は既に更新されているため、更新後のitemsを使う必要がある
      // しかし、setEventListsとsetHallRouteSettingsは非同期なので、現在のitemsを使う
      if (oldPriority !== 'none' && oldGroupId !== newGroupId) {
        // 同じホール・同じ優先度の他のアイテムがあるか確認
        const otherItemsInOldGroup = items.filter(i => {
          if (i.id === itemId) return false;
          if ((i.priorityLevel || 'none') !== oldPriority) return false;
          
          // 同じホールかどうか確認
          if (!mapDataForTab) return false;
          const iBlock = mapDataForTab.blocks.find(b => b.name === i.block);
          if (!iBlock) return false;
          const iNumMatch = i.number?.match(/\d+/);
          if (!iNumMatch) return false;
          const iNum = parseInt(iNumMatch[0], 10);
          const iCell = iBlock.numberCells.find(nc => nc.value === iNum);
          if (!iCell) return false;
          
          // このアイテムのホールIDを特定
          let iHallId: string | null = null;
          for (const h of halls) {
            const inPoly = (() => {
              if (h.vertices.length < 3) return false;
              let inside = false;
              for (let ii = 0, j = h.vertices.length - 1; ii < h.vertices.length; j = ii++) {
                const xi = h.vertices[ii].col, yi = h.vertices[ii].row;
                const xj = h.vertices[j].col, yj = h.vertices[j].row;
                if (((yi > iCell.row) !== (yj > iCell.row)) && (iCell.col < (xj - xi) * (iCell.row - yi) / (yj - yi) + xi)) {
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
          newHallOrder = newHallOrder.filter(id => id !== oldGroupId);
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
  }, [activeEventName, visitListPanelMapTab, items, hallDefinitions, mapData]);

  // ブロック定義を更新
  const handleUpdateBlocks = useCallback((blocks: BlockDefinition[]) => {
    if (!activeEventName || !isMapTab || !currentMapData) return;
    
    setMapData(prev => ({
      ...prev,
      [activeEventName]: {
        ...prev[activeEventName],
        [activeTab]: {
          ...currentMapData,
          blocks,
        },
      },
    }));
  }, [activeEventName, isMapTab, activeTab, currentMapData]);

  // ホール定義を更新
  const handleUpdateHalls = useCallback((halls: HallDefinition[]) => {
    if (!activeEventName || !isMapTab) return;
    
    setHallDefinitions(prev => ({
      ...prev,
      [activeEventName]: {
        ...prev[activeEventName],
        [activeTab]: halls,
      },
    }));
    
    // ホール順序も更新（新規ホールはリストの最後に追加）
    const existingOrder = currentHallRouteSettings.hallOrder;
    const newHallIds = halls.map(h => h.id);
    const updatedOrder = [
      ...existingOrder.filter(id => newHallIds.includes(id)),
      ...newHallIds.filter(id => !existingOrder.includes(id)),
    ];
    
    setHallRouteSettings(prev => ({
      ...prev,
      [activeEventName]: {
        ...prev[activeEventName],
        [activeTab]: {
          ...currentHallRouteSettings,
          hallOrder: updatedOrder,
        },
      },
    }));
  }, [activeEventName, isMapTab, activeTab, currentHallRouteSettings]);

  // ホールルート設定を更新
  const handleUpdateHallRouteSettings = useCallback((settings: HallRouteSettings) => {
    if (!activeEventName || !isMapTab) return;
    
    setHallRouteSettings(prev => ({
      ...prev,
      [activeEventName]: {
        ...prev[activeEventName],
        [activeTab]: settings,
      },
    }));
  }, [activeEventName, isMapTab, activeTab]);

  // 実行列をホール順序で並び替え
  const handleReorderExecuteListByHallOrder = useCallback((hallOrder: string[]) => {
    if (!activeEventName || !isMapTab) return;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    const currentMapData = mapData[activeEventName]?.[activeTab];
    const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
    const currentHallRouteSettings = hallRouteSettings[activeEventName]?.[activeTab] || { hallOrder: [], hallVisitLists: [] };
    
    if (!currentMapData || halls.length === 0) return;
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      
      if (dayItems.length === 0) return prev;
      
      // 各アイテムのホールIDを取得する関数
      const itemsMap = new Map(items.map(i => [i.id, i]));
      const getHallIdForItem = (itemId: string): string | null => {
        const item = itemsMap.get(itemId);
        if (!item || !currentMapData) return null;
        
        const blockName = item.block?.trim() || '';
        // 完全一致優先でブロックを検索
        let block = currentMapData.blocks.find(b => b.name === blockName);
        if (!block) {
          const candidates = currentMapData.blocks.filter(b => 
            b.name.toLowerCase() === blockName.toLowerCase()
          );
          if (candidates.length === 1) {
            block = candidates[0];
          }
        }
        if (!block) return null;
        
        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;
        
        for (const hall of halls) {
          if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
            return hall.id;
          }
        }
        return null;
      };
      
      // アイテムをホールごとにグループ化
      const itemsByHall = new Map<string | null, Set<string>>();
      dayItems.forEach(itemId => {
        const hallId = getHallIdForItem(itemId);
        if (!itemsByHall.has(hallId)) {
          itemsByHall.set(hallId, new Set());
        }
        itemsByHall.get(hallId)!.add(itemId);
      });
      
      // hallVisitListsの順序マップを作成
      const visitOrderMap = new Map<string, number>();
      currentHallRouteSettings.hallVisitLists.forEach(list => {
        list.itemIds.forEach((itemId, index) => {
          visitOrderMap.set(itemId, index);
        });
      });
      
      // ホール内のアイテムを訪問先指定順でソート
      const sortItemsInHall = (itemIds: Set<string>): string[] => {
        const itemsArray = Array.from(itemIds);
        return itemsArray.sort((a, b) => {
          const orderA = visitOrderMap.get(a);
          const orderB = visitOrderMap.get(b);
          
          // 両方とも訪問先リストにある場合、その順序で並べる
          if (orderA !== undefined && orderB !== undefined) {
            return orderA - orderB;
          }
          // 一方のみがリストにある場合、リストにある方を先に
          if (orderA !== undefined) return -1;
          if (orderB !== undefined) return 1;
          // どちらもリストにない場合、元の実行列順序を維持
          return dayItems.indexOf(a) - dayItems.indexOf(b);
        });
      };
      
      // ホール順序に従って並び替え
      const reorderedItems: string[] = [];
      
      // まずホール順序に従って追加
      hallOrder.forEach(hallId => {
        const hallItems = itemsByHall.get(hallId);
        if (hallItems && hallItems.size > 0) {
          reorderedItems.push(...sortItemsInHall(hallItems));
          itemsByHall.delete(hallId);
        }
      });
      
      // ホール順序に含まれていないホールのアイテムを追加
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
  }, [activeEventName, isMapTab, activeTab, mapData, hallDefinitions, hallRouteSettings, items]);

  // ホール/頂点/セル選択ロジック - extracted to useMapControls hook

  const TabButton: React.FC<{tab: ActiveTab, label: string, count?: number, onClick?: () => void, isMapTab?: boolean}> = ({ tab, label, count, onClick, isMapTab: isMapTabProp }) => {
    const longPressTimeout = React.useRef<number | null>(null);
    const menuRef = React.useRef<HTMLDivElement>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);

    const handlePointerDown = (e: React.PointerEvent) => {
      if (!activeEventName) return;
      
      // 長押し開始時にボタンの位置を記録
      const target = e.currentTarget as HTMLButtonElement;
      const rect = target.getBoundingClientRect();
      const menuLeft = rect.left + rect.width / 2;
      const menuTop = rect.bottom + 4;
      
      longPressTimeout.current = window.setTimeout(() => {
        if (isMapTabProp) {
          // マップタブの長押しメニュー - 記録した位置でメニューを表示
          setMapTabMenuPosition({ left: menuLeft, top: menuTop });
          setMapTabMenuOpen(tab);
        } else if (eventDates.includes(tab)) {
          // 通常の日付タブの長押し（モード切り替え）
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
      // メニューが開いている場合
      if (mapTabMenuOpen) {
        // このタブのメニューが開いている場合は閉じるだけ
        if (mapTabMenuOpen === tab) {
          setMapTabMenuOpen(null);
          return;
        }
        // 他のタブのメニューが開いている場合は閉じてタブ遷移
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

    // メニュー外クリックで閉じる
    React.useEffect(() => {
      const handleClickOutside = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
            buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
          setMapTabMenuOpen(null);
        }
      };
      if (mapTabMenuOpen === tab) {
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }
    }, [tab]);

    // メニュー項目クリック時：まずそのタブに遷移してから機能を開く
    const handleMenuItemClick = (action: 'visitList' | 'blockDefinition' | 'hallDefinition') => {
      // まずメニューを閉じる
      setMapTabMenuOpen(null);
      
      // 長押ししたタブに遷移
      setItemToEdit(null);
      setSelectedItemIds(new Set());
      setSelectedBlockFilters(new Set());
      setCandidateNumberSortDirection(null);
      setActiveTab(tab);
      
      // 機能を開く（タブ遷移後に実行されるようsetTimeoutで遅延）
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
          {label} {typeof count !== 'undefined' && <span className="text-xs bg-slate-200 dark:text-slate-700 rounded-full px-2 py-0.5 ml-1">{count}</span>}
        </button>
        
        {/* マップタブ長押しメニュー - fixed配置でタブのすぐ下に表示 */}
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
            {/* 矢印（上向き） */}
            <div className="absolute left-1/2 -translate-x-1/2 -top-2">
              <div className="w-3 h-3 bg-white dark:bg-slate-800 border-l border-t border-slate-200 dark:border-slate-700 transform rotate-45" />
            </div>
            <div className="py-1">
              <button
                onClick={() => handleMenuItemClick('visitList')}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-t-lg flex items-center gap-2"
              >
                <span>📍</span> 訪問先リスト
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
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
    const itemsMap = new Map(items.map(item => [item.id, item]));
    return executeIds.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
  }, [activeEventName, activeTab, executeModeItems, items, eventDates]);

  const visibleItems = useMemo(() => {
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const itemsForTab = currentTabItems;
    
    if (!activeEventName) return itemsForTab;
    
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';
    
    if (mode === 'execute') {
      // 実行モード: 実行列のアイテムのみ表示（編集モードで配置した順序を保持）
      if (sortState === 'Manual') {
        return executeColumnItems;
      }
      // フィルタに該当するアイテム、または最近変更されたアイテムを表示
      const filterStatus = sortState as Exclude<SortState, 'Manual'>;
      return executeColumnItems.filter(item => 
        item.purchaseStatus === filterStatus || recentlyChangedItemIds.has(item.id)
      );
    }
    
    // 編集モード: すべてのアイテムを表示（列分けはコンポーネント側で処理）
    return itemsForTab;
  }, [activeTab, currentTabItems, sortState, activeEventName, dayModes, executeColumnItems, eventDates, recentlyChangedItemIds]);

  // 検索機能: 現在のタブのアイテムを検索
  // 検索機能 - useSearch hook is called after candidateColumnItems is defined (see below)

  // 各参加日タブ中のアイテムでサークル名が重複するアイテムのIDセットを計算
  const duplicateCircleItemIds = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return new Set<string>();
    const itemsForTab = currentTabItems;
    const circleCountMap = new Map<string, number>();
    const circleItemIdsMap = new Map<string, string[]>();
    
    // サークル名ごとにアイテム数をカウント
    itemsForTab.forEach(item => {
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
    
    // 重複するサークル名のアイテムIDを収集
    const duplicateIds = new Set<string>();
    circleCountMap.forEach((count, circle) => {
      if (count > 1) {
        const itemIds = circleItemIdsMap.get(circle) || [];
        itemIds.forEach(id => duplicateIds.add(id));
      }
    });
    
    return duplicateIds;
  }, [activeEventName, activeTab, currentTabItems, eventDates]);

  // 候補リストから動的にブロック値を取得
  const availableBlocks = useMemo(() => {
    if (!activeEventName) return [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const candidateItems = currentTabItems.filter(item => !executeIds.has(item.id));
    const blocks = new Set(candidateItems.map(item => item.block).filter(Boolean));
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
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    let filtered = currentTabItems.filter(item => !executeIds.has(item.id));
    
    // ブロックフィルタを適用
    if (selectedBlockFilters.size > 0) {
      filtered = filtered.filter(item => selectedBlockFilters.has(item.block));
    }
    
    return filtered;
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, selectedBlockFilters, eventDates]);

  // 検索機能 - extracted to useSearch hook
  const {
    searchKeyword, setSearchKeyword,
    currentSearchIndex,
    highlightedItemId,
    visibleSearchMatches,
    handleSearchNext,
  } = useSearch(
    activeEventName, activeTab, eventDates, currentTabItems,
    visibleItems, executeColumnItems, candidateColumnItems, dayModes,
  );

  // 各ブロックの候補リスト内のアイテムの備考欄に「優先」または「委託無」が含まれているかをチェック
  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const candidateItems = currentTabItems.filter(item => !executeIds.has(item.id));
    
    const blocksWithPriority = new Set<string>();
    candidateItems.forEach(item => {
      if (item.remarks && (item.remarks.includes('優先') || item.remarks.includes('委託無'))) {
        blocksWithPriority.add(item.block);
      }
    });
    
    return blocksWithPriority;
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, eventDates]);

  // 候補リストのアイテムが選択されているかチェック
  const hasCandidateSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter(item => selectedItemIds.has(item.id));
    return selectedItems.some(item => currentTabItems.includes(item) && !executeIds.has(item.id));
  }, [activeEventName, activeTab, currentMode, selectedItemIds, items, executeModeItems, currentTabItems, eventDates]);

  // 実行モード列のアイテムが選択されているかチェック
  const hasExecuteSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter(item => selectedItemIds.has(item.id));
    return selectedItems.some(item => currentTabItems.includes(item) && executeIds.has(item.id));
  }, [activeEventName, activeTab, currentMode, selectedItemIds, items, executeModeItems, currentTabItems, eventDates]);

  // 左右両列のアイテムが同時に選択されている場合は移動ボタンを表示しない
  const showMoveButtons = (hasCandidateSelection && !hasExecuteSelection) || (hasExecuteSelection && !hasCandidateSelection);
  
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
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">即売会 購入巡回表</h1>
                {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'execute' && (
                  <button
                    onClick={handleBlockSortToggle}
                    className={`p-2 rounded-md transition-colors duration-200 ${
                      blockSortDirection
                        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                        : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                    }`}
                    title={blockSortDirection === 'desc' ? "ブロック降順 (昇順へ)" : blockSortDirection === 'asc' ? "ブロック昇順 (降順へ)" : "ブロック昇順でソート"}
                  >
                    {blockSortDirection === 'desc' ? <SortDescendingIcon className="w-5 h-5" /> : <SortAscendingIcon className="w-5 h-5" />}
                  </button>
                )}
                {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'edit' && (
                  <button
                    onClick={handleBlockSortToggleCandidate}
                    className={`p-2 rounded-md transition-colors duration-200 ${
                      blockSortDirection
                        ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                        : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                    }`}
                    title={blockSortDirection === 'desc' ? "候補リスト ブロック降順 (昇順へ)" : blockSortDirection === 'asc' ? "候補リスト ブロック昇順 (降順へ)" : "候補リスト ブロック昇順でソート"}
                  >
                    {blockSortDirection === 'desc' ? <SortDescendingIcon className="w-5 h-5" /> : <SortAscendingIcon className="w-5 h-5" />}
                  </button>
                )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              {activeEventName && <h2 className="text-sm text-blue-600 dark:text-blue-400 font-semibold">{activeEventName}</h2>}
              {/* テーマ切り替えトグル */}
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  cycleTheme();
                }}
                className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
                title={themeMode === 'system' ? 'システム設定 → ライトモードへ' : themeMode === 'light' ? 'ライトモード → ダークモードへ' : 'ダークモード → システム設定へ'}
                style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
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
              
              {/* UI表示設定（歯車アイコン） */}
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
                  title="表示設定"
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                  type="button"
                >
                  <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                
                {/* UI表示設定パネル */}
                {uiSettingsPanelOpen && (
                  <>
                    <div 
                      className="fixed inset-0 z-40"
                      onClick={() => setUiSettingsPanelOpen(false)}
                    />
                    <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-4 min-w-[320px] max-h-[70vh] overflow-y-auto">
                      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">ヘッダー/タブバー表示設定</h3>
                      
                      {/* 集中モード設定 */}
                      <div className="mb-3">
                        <h4 className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">🔍 集中モード</h4>
                        <div className="space-y-2">
                          {([
                            ['focus_sp_mapOn', 'SP・マップON'],
                            ['focus_sp_mapOff', 'SP・マップOFF'],
                            ['focus_pc_mapOn', 'PC・マップON'],
                            ['focus_pc_mapOff', 'PC・マップOFF'],
                          ] as [keyof typeof uiVisibilitySettings, string][]).map(([key, label]) => (
                            <div key={key} className="flex items-center justify-between text-xs">
                              <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">{label}</span>
                              <div className="flex items-center gap-3">
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={uiVisibilitySettings[key].header}
                                    onChange={(e) => setUiVisibilitySettings(prev => ({
                                      ...prev,
                                      [key]: { ...prev[key], header: e.target.checked }
                                    }))}
                                    className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-slate-500 dark:text-slate-400">ヘッダー</span>
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={uiVisibilitySettings[key].tabBar}
                                    onChange={(e) => setUiVisibilitySettings(prev => ({
                                      ...prev,
                                      [key]: { ...prev[key], tabBar: e.target.checked }
                                    }))}
                                    className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-slate-500 dark:text-slate-400">タブバー</span>
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* 実行モード設定 */}
                      <div className="mb-3">
                        <h4 className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2">🏃 実行モード</h4>
                        <div className="space-y-2">
                          {([
                            ['execute_sp', 'スマートフォン'],
                            ['execute_pc', 'PC / タブレット'],
                          ] as [keyof typeof uiVisibilitySettings, string][]).map(([key, label]) => (
                            <div key={key} className="flex items-center justify-between text-xs">
                              <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">{label}</span>
                              <div className="flex items-center gap-3">
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={uiVisibilitySettings[key].header}
                                    onChange={(e) => setUiVisibilitySettings(prev => ({
                                      ...prev,
                                      [key]: { ...prev[key], header: e.target.checked }
                                    }))}
                                    className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-slate-500 dark:text-slate-400">ヘッダー</span>
                                </label>
                                <label className="flex items-center gap-1 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={uiVisibilitySettings[key].tabBar}
                                    onChange={(e) => setUiVisibilitySettings(prev => ({
                                      ...prev,
                                      [key]: { ...prev[key], tabBar: e.target.checked }
                                    }))}
                                    className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-slate-500 dark:text-slate-400">タブバー</span>
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* リセットボタン */}
                      <button
                        onClick={() => setUiVisibilitySettings(DEFAULT_UI_VISIBILITY)}
                        className="w-full mt-1 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                      >
                        デフォルトに戻す
                      </button>
                    </div>
                  </>
                )}
              </div>
              
              {/* モード切替アイコン（日付タブ表示時のみ） */}
              {activeEventName && mainContentVisible && (
                <div className="flex items-center gap-1 ml-2 border-l border-slate-300 dark:border-slate-600 pl-2">
                  {/* 編集モード */}
                  <button
                    onClick={() => handleSetViewMode('edit')}
                    className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                      currentMode === 'edit'
                        ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400'
                        : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                    title="編集モード"
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '40px', minHeight: '40px' }}
                    type="button"
                  >
                    <span className="text-lg">📝</span>
                  </button>
                  
                  {/* 実行モード */}
                  <button
                    onClick={() => handleSetViewMode('execute')}
                    className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                      currentMode === 'execute'
                        ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400'
                        : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                    title="実行モード"
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '40px', minHeight: '40px' }}
                    type="button"
                  >
                    <span className="text-lg">🏃</span>
                  </button>
                  
                  {/* 集中モード */}
                  <button
                    onClick={() => handleSetViewMode('focus')}
                    className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                      currentMode === 'focus'
                        ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400'
                        : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                    }`}
                    title="集中モード"
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '40px', minHeight: '40px' }}
                    type="button"
                  >
                    <span className="text-lg">🔍</span>
                  </button>
                </div>
              )}
              
              {/* マップコントロール（マップタブ表示時のみ） */}
              {activeEventName && isMapTab && currentMapData && currentHalls.length > 0 && (
                <>
                  {/* ホール選択 */}
                  <div className="relative">
                    <button
                      onClick={() => setMapHallSelectorOpen(!mapHallSelectorOpen)}
                      className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                        mapHallSelectorOpen 
                          ? 'bg-slate-200 dark:bg-slate-700' 
                          : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                      }`}
                      title={`表示ホール: ${mapSelectedHallId === 'all' ? '全ホール' : currentHalls.find(h => h.id === mapSelectedHallId)?.name || ''}`}
                      style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                      type="button"
                    >
                      {/* ホールアイコン（ビッグサイトシルエット風） */}
                      <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M2 18h3v-4h2v4h2v-6H7l-2-4-2 4H2v6zm5-8h2V8h2V6h2v2h2v2h2v8h-3v-4h-2v4h-3v-8z"/>
                        <path d="M14 10h2v2h-2zM14 14h2v2h-2zM18 10h2v2h-2zM18 14h2v2h-2z"/>
                      </svg>
                    </button>
                    {mapSelectedHallId !== 'all' && (
                      <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full"></span>
                    )}
                    
                    {/* ホール選択ドロップダウンメニュー */}
                    {mapHallSelectorOpen && (
                      <>
                        {/* 背景オーバーレイ（クリックで閉じる） */}
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
                  
                  {/* ホール順序 */}
                  <button
                    onClick={() => setMapIsHallOrderOpen(true)}
                    className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
                    title="ホール順序を編集"
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                    type="button"
                  >
                    <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  
                  {/* ルート表示ON/OFF */}
                  <button
                    onClick={() => setMapIsRouteVisible(!mapIsRouteVisible)}
                    className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                      mapIsRouteVisible 
                        ? 'bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-800' 
                        : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                    }`}
                    title={mapIsRouteVisible ? 'ルート表示ON' : 'ルート表示OFF'}
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                    type="button"
                  >
                    {/* ルートアイコン */}
                    <svg className={`w-5 h-5 pointer-events-none ${mapIsRouteVisible ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <circle cx="6" cy="6" r="2" strokeWidth={2} />
                      <circle cx="18" cy="18" r="2" strokeWidth={2} />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 8v4a4 4 0 004 4h4M14 12l4 4m0 0l-4 4" />
                    </svg>
                  </button>
                  
                  {/* スマート位置選択ON/OFF (長押しでモード切替) */}
                  <button
                    onPointerDown={() => {
                      smartInsertLongPressTriggeredRef.current = false;
                      smartInsertLongPressRef.current = setTimeout(() => {
                        smartInsertLongPressTriggeredRef.current = true;
                        const newMode = mapSmartInsertMode === 'card' ? 'preview' : 'card';
                        setMapSmartInsertMode(newMode);
                        setSmartInsertToast(newMode === 'preview' ? 'プレビューモードに切替' : 'カードモードに切替');
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
                    title={`スマート追加${mapSmartInsertEnabled ? 'ON' : 'OFF'} (${mapSmartInsertMode === 'card' ? 'カード' : 'プレビュー'}) 長押しでモード切替`}
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                    type="button"
                  >
                    <svg className={`w-5 h-5 pointer-events-none ${mapSmartInsertEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-600 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m0-8l-4-4m4 4l4-4" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
                    </svg>
                    {/* モードインジケーター */}
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
              {activeEventName && mainContentVisible && items.length > 0 && selectedItemIds.size > 0 && (
                  <>
                      <BulkActionControls
                          onSort={handleBulkSort}
                          onClear={handleClearSelection}
                      />
                      {showMoveButtons && hasCandidateSelection && (
                          <button
                              onClick={() => handleMoveToExecuteColumn(Array.from(selectedItemIds))}
                              className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                          >
                              選択したアイテムを左列に移動 ({selectedItemIds.size}件)
                          </button>
                      )}
                      {showMoveButtons && hasExecuteSelection && (
                          <button
                              onClick={() => handleRemoveFromExecuteColumn(Array.from(selectedItemIds))}
                              className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                          >
                              選択したアイテムを右列に移動 ({selectedItemIds.size}件)
                          </button>
                      )}
                  </>
              )}
              {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'execute' && (
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
                <TabButton tab="eventList" label="即売会リスト" onClick={() => { setActiveEventName(null); setItemToEdit(null); setSelectedItemIds(new Set()); setSelectedBlockFilters(new Set()); setActiveTab('eventList'); }}/>
                {activeEventName ? (
                    <>
                        {eventDates.map(eventDate => {
                          const count = items.filter(item => item.eventDate === eventDate).length;
                          const mapTabName = `${eventDate}マップ`;
                          const hasMapData = mapTabs.includes(mapTabName);
                          return (
                            <React.Fragment key={eventDate}>
                              <TabButton 
                                tab={eventDate} 
                                label={eventDate} 
                                count={count} 
                              />
                              {hasMapData && (
                                <TabButton 
                                  tab={mapTabName} 
                                  label={`${eventDate}マップ`}
                                  isMapTab={true}
                                />
                              )}
                            </React.Fragment>
                          );
                        })}
                        <TabButton tab="import" label={itemToEdit ? "アイテム編集" : "アイテム追加"} />
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
                        onClick={() => { setItemToEdit(null); setActiveTab('import'); }}
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

      {/* フローティング全表示ボタン（設定上何かが非表示の場合） */}
      {rawHideSomething && activeEventName && (currentMode === 'focus' || currentMode === 'execute') && (
        <button
          onClick={() => {
            setUiVisibilityOverride(prev => !prev);
            setUiSettingsPanelOpen(false);
          }}
          className={`fixed left-3 top-3 z-20 w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-all touch-manipulation select-none ${
            uiVisibilityOverride
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-white/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600 backdrop-blur-sm border border-slate-200 dark:border-slate-600'
          }`}
          title={uiVisibilityOverride ? '設定通りに戻す' : '全表示'}
          style={{ WebkitTapHighlightColor: 'transparent' }}
          type="button"
        >
          {uiVisibilityOverride ? (
            <svg className="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
            </svg>
          ) : (
            <svg className="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
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
        {/* マップビュー */}
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
              const item = items.find(i => i.id === itemId);
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
          <div style={{
              transform: `scale(${zoomLevel / 100})`,
              transformOrigin: 'top left',
              width: `${100 * (100 / zoomLevel)}%`
          }}>
            {currentMode === 'edit' ? (
              <div className="grid grid-cols-2 gap-4">
                {/* 左列: 実行モード表示列 */}
                <div className="space-y-2">
                  <div className="bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100 mb-2">実行モード表示列</h3>
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">右の候補リストからアイテムを選択して移動</p>
                  </div>
                  <ShoppingList
                    items={executeColumnItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={(dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => handleMoveItem(dragId, hoverId, targetColumn, sourceColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    columnType="execute"
                    currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
                    onMoveItemUp={handleMoveItemUp}
                    onMoveItemDown={handleMoveItemDown}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    onToggleRangeSelection={handleToggleRangeSelection}
                    duplicateCircleItemIds={duplicateCircleItemIds}
                    highlightedItemId={highlightedItemId}
                    layoutMode={layoutMode}
                    showHallGroups={true}
                    hallDefinitions={getHallsForDate(eventDates.includes(activeTab) ? activeTab : (eventDates[0] || ''))}
                    hallOrder={getHallOrderForDate(eventDates.includes(activeTab) ? activeTab : (eventDates[0] || ''))}
                    mapData={getMapDataForDate(eventDates.includes(activeTab) ? activeTab : (eventDates[0] || ''))}
                  />
                </div>
                
                {/* 右列: 候補リスト */}
                <div className="space-y-2">
                  <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">候補リスト</h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">アイテムを選択してヘッダーのボタンから移動</p>
                    {availableBlocks.length > 0 && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">ブロックでフィルタ:</span>
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
                                  title={candidateNumberSortDirection === 'desc' ? "ナンバー降順 (昇順へ)" : candidateNumberSortDirection === 'asc' ? "ナンバー昇順 (降順へ)" : "ナンバー昇順でソート"}
                                >
                                  {candidateNumberSortDirection === 'desc' ? <SortDescendingIcon className="w-4 h-4" /> : <SortAscendingIcon className="w-4 h-4" />}
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
                          {availableBlocks.map(block => (
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
                    onMoveItem={(dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => handleMoveItem(dragId, hoverId, targetColumn, sourceColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    columnType="candidate"
                    currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
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
              <FocusMode
                items={items}
                executeModeItemIds={executeModeItems[activeEventName]?.[eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')] || []}
                onUpdateItem={handleUpdateItem}
                onModeChange={(mode, lastItemId) => handleSetViewMode(mode, lastItemId)}
                layoutMode={layoutMode}
                onLayoutModeChange={setLayoutMode}
                mapData={activeEventName ? mapData[activeEventName] : undefined}
                hallDefinitions={activeEventName && activeTab ? hallDefinitions[activeEventName]?.[`${eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}マップ`] : undefined}
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
                onMoveItem={(dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate') => handleMoveItem(dragId, hoverId, targetColumn)}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds}
                onSelectItem={handleSelectItem}
                columnType="execute"
                currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
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
          currentUrl={pendingUpdateEventName ? eventMetadata[pendingUpdateEventName]?.spreadsheetUrl || '' : ''}
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

      {/* エクスポートオプションダイアログ */}
      {showExportOptions && exportEventName && (
        <ExportOptionsDialog
          isOpen={showExportOptions}
          onClose={() => {
            setShowExportOptions(false);
            setExportEventName(null);
          }}
          onExport={handleConfirmExport}
          hasMapData={!!(exportEventName && mapData[exportEventName] && Object.keys(mapData[exportEventName]).length > 0)}
        />
      )}

      {/* ブロック定義パネル */}
      {blockDefinitionMode && currentMapData && (
        <BlockDefinitionPanel
          isOpen={blockDefinitionMode}
          onClose={() => { setBlockDefinitionMode(false); setPendingCellSelection(null); }}
          mapData={currentMapData}
          onUpdateBlocks={handleUpdateBlocks}
          onStartCellSelection={handleStartCellSelection}
          pendingCellSelection={pendingCellSelection}
          onClearPendingCellSelection={() => setPendingCellSelection(null)}
        />
      )}

      {/* セル選択モードのフローティングUI */}
      {cellSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              {cellSelectionMode.type === 'corner' && `📍 セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === 'multiCorner' && `📍 セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === 'rangeStart' && `📍 範囲の2つのセルをクリック (${cellSelectionMode.clickedCells.length}/2)`}
              {cellSelectionMode.type === 'individual' && `📍 個別セルをクリック (${cellSelectionMode.clickedCells.length}個選択中)`}
            </div>
            {cellSelectionMode.clickedCells.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                選択: {cellSelectionMode.clickedCells.map(c => `(${c.row},${c.col})`).join(', ')}
              </div>
            )}
            <div className="text-xs text-blue-500 dark:text-blue-400 mt-1">
              💡 マーカーをクリックで選択解除
            </div>
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleConfirmCellSelection}
              disabled={
                ((cellSelectionMode.type === 'corner' || cellSelectionMode.type === 'multiCorner') && cellSelectionMode.clickedCells.length < 4) ||
                (cellSelectionMode.type === 'rangeStart' && cellSelectionMode.clickedCells.length < 2) ||
                (cellSelectionMode.type === 'individual' && cellSelectionMode.clickedCells.length === 0)
              }
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              範囲を反映
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

      {/* ホール定義パネル */}
      {hallDefinitionMode && currentMapData && (
        <HallDefinitionPanel
          isOpen={hallDefinitionMode}
          onClose={() => { setHallDefinitionMode(false); setPendingVertexSelection(null); }}
          mapData={currentMapData}
          halls={currentHalls}
          onUpdateHalls={handleUpdateHalls}
          onStartVertexSelection={handleStartVertexSelection}
          pendingVertexSelection={pendingVertexSelection}
          onClearPendingVertexSelection={() => setPendingVertexSelection(null)}
        />
      )}

      {/* 訪問先リストパネル */}
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

      {/* 訪問先リスト確認ダイアログ */}
      {showVisitListConfirmDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-3">
              変更を保存しますか？
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              訪問先リストに未保存の変更があります。確定して保存するか、キャンセルして破棄してください。
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
                確定（保存）
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ホール頂点選択モードのフローティングUI */}
      {vertexSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              📍 ホールの頂点をクリック ({vertexSelectionMode.clickedVertices.length}/4〜6)
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
              クリック順に多角形を作成します
            </div>
            {vertexSelectionMode.clickedVertices.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                選択: {vertexSelectionMode.clickedVertices.map(v => `(${v.row},${v.col})`).join(' → ')}
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

      {/* マップファイル入力（非表示） */}
      <input
        type="file"
        ref={mapFileInputRef}
        accept=".xlsx"
        onChange={handleMapFileChange}
        style={{ display: 'none' }}
      />

      {/* マップ取り込みダイアログ */}
      <MapImportDialog
        isOpen={mapImportDialogOpen}
        file={mapImportPendingFile}
        eventName={mapImportPendingEventName}
        savedSettings={mapImportPendingEventName ? loadBlockDetectionSettings(mapImportPendingEventName) : null}
        onImport={handleMapImportConfirm}
        onClose={handleMapImportClose}
      />

      {/* エクスポートファイルインポート用入力（非表示） */}
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

      {/* スマート追加モード切替トースト */}
      {smartInsertToast && (
        <div className="fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] bg-green-600 text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-pulse">
          {smartInsertToast}
        </div>
      )}
    </div>
  );
};

export default App;
