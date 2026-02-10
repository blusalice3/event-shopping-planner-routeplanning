import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ViewMode, DayModeState, ExecuteModeItems, MapDataStore, RouteSettingsStore, ExportOptions, BlockDefinition, HallDefinition, HallRouteSettings, HallDefinitionsStore, HallRouteSettingsStore, BlockDetectionSettings } from './types';
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
import { MapView, BlockDefinitionPanel, HallDefinitionPanel, MapImportDialog, loadBlockDetectionSettings, saveBlockDetectionSettings } from './components/map';
import VisitListPanel from './components/VisitListPanel';
import FocusMode from './components/FocusMode';
import { getItemKey } from './utils/itemComparison';
import { useTheme } from './hooks/useTheme';
import { useUIVisibility, DEFAULT_UI_VISIBILITY } from './hooks/useUIVisibility';
import { usePersistence } from './hooks/usePersistence';
import { useSearch } from './hooks/useSearch';
import { useVisitList } from './hooks/useVisitList';
import { useMapControls } from './hooks/useMapControls';
import { useItemSelection } from './hooks/useItemSelection';
import { useSorting, sortCycle } from './hooks/useSorting';
import type { SortState } from './hooks/useSorting';
import { useExportImport } from './hooks/useExportImport';
import { useItemMovement } from './hooks/useItemMovement';
import { useHallUtils } from './hooks/useHallUtils';
import { useViewMode } from './hooks/useViewMode';
import { useColumnItems } from './hooks/useColumnItems';
import { useUpdateWorkflow } from './hooks/useUpdateWorkflow';
import { useMapItemOps } from './hooks/useMapItemOps';

type ActiveTab = 'eventList' | 'import' | string; // string部分は動的な参加日（例: '1日目', '2日目', '3日目'など）
export type BulkSortDirection = 'asc' | 'desc';

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

  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);
  const [zoomLevel, setZoomLevel] = useState(100);


  // マップからの新規アイテム追加用の初期値
  const [newItemDefaults, setNewItemDefaults] = useState<{ eventDate: string; block: string; number: string } | null>(null);

  // 更新機能用の状態 - extracted to useUpdateWorkflow hook
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
  
  // ホール関連ユーティリティ - extracted to useHallUtils hook
  const {
    currentMapData, currentHalls, currentHallRouteSettings,
    getHallExecuteCount, getHallTotalItemCount,
    getMapTabForDate, getHallsForDate, getMapDataForDate, getHallOrderForDate,
    getItemHallId, areItemsInSameHall,
  } = useHallUtils({
    activeEventName, activeTab, isMapTab, items,
    executeModeItems, mapData, hallDefinitions, hallRouteSettings,
  });
  
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

  // アイテム選択 - extracted to useItemSelection hook
  const {
    selectedItemIds, setSelectedItemIds,
    selectedBlockFilters, setSelectedBlockFilters,
    recentlyChangedItemIds, setRecentlyChangedItemIds,
    rangeStart, setRangeStart,
    rangeEnd, setRangeEnd,
    handleSelectItem: handleSelectItemRaw,
    handleToggleBlockFilter,
    handleClearBlockFilters,
    handleClearSelection,
    handleToggleRangeSelection,
  } = useItemSelection({
    items, activeEventName, activeTab, eventDates, executeModeItems,
    getHallsForDate, getMapDataForDate,
  });

  // ソート - extracted to useSorting hook
  const {
    sortState, setSortState,
    blockSortDirection, setBlockSortDirection,
    candidateNumberSortDirection, setCandidateNumberSortDirection,
    handleSortToggle,
    handleBlockSortToggle,
    handleBlockSortToggleCandidate,
    handleCandidateNumberSort,
    handleBulkSort,
    resetSort,
  } = useSorting({
    activeEventName, activeTab, eventDates, items, executeModeItems, dayModes,
    selectedItemIds, selectedBlockFilters,
    setEventLists, setExecuteModeItems,
    resetSelection: handleClearSelection,
    resetRecentlyChanged: () => setRecentlyChangedItemIds(new Set()),
  });

  // handleSelectItemをラップしてソートリセットを追加
  const handleSelectItem = useCallback((itemId: string, columnType?: 'execute' | 'candidate') => {
    resetSort();
    handleSelectItemRaw(itemId, columnType);
  }, [resetSort, handleSelectItemRaw]);

  // エクスポート/インポート - extracted to useExportImport hook
  const {
    showExportOptions, setShowExportOptions,
    exportEventName, setExportEventName,
    mapImportDialogOpen,
    mapImportPendingFile,
    mapImportPendingEventName,
    mapFileInputRef,
    exportFileInputRef,
    handleExportEvent,
    handleConfirmExport,
    handleExportFileImport,
    handleImportMapData,
    handleMapFileChange,
    handleMapImportConfirm,
    handleMapImportClose,
  } = useExportImport({
    eventLists, eventMetadata, executeModeItems, dayModes,
    mapData, routeSettings, hallDefinitions, hallRouteSettings,
    setEventLists, setEventMetadata, setExecuteModeItems, setDayModes,
    setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings,
    setActiveEventName, setActiveTab,
  });

  // アイテム移動 - extracted to useItemMovement hook
  const {
    handleMoveItem,
    handleMoveItemUp,
    handleMoveItemDown,
    handleMoveToExecuteColumn,
    handleRemoveFromExecuteColumn,
  } = useItemMovement({
    activeEventName, activeTab, eventDates, dayModes, executeModeItems, items,
    selectedItemIds, selectedBlockFilters, rangeStart, rangeEnd,
    areItemsInSameHall,
    setEventLists, setExecuteModeItems, setSelectedItemIds, setRangeStart, setRangeEnd,
    resetSort,
  });

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


  // モード管理 - extracted to useViewMode hook
  const {
    handleToggleMode,
    handleSetViewMode,
  } = useViewMode({
    activeEventName, activeTab, eventDates, dayModes,
    setDayModes, setSelectedItemIds, setCandidateNumberSortDirection,
    setFocusModeMapVisible, setUiVisibilityOverride, setUiSettingsPanelOpen,
  });
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










  // 更新ワークフロー - extracted to useUpdateWorkflow hook
  const {
    showUpdateConfirmation, setShowUpdateConfirmation,
    updateData, setUpdateData,
    updateEventName, setUpdateEventName,
    showUrlUpdateDialog, setShowUrlUpdateDialog,
    pendingUpdateEventName, setPendingUpdateEventName,
    handleUpdateEvent,
    handleConfirmUpdate,
    handleUrlUpdate,
  } = useUpdateWorkflow({
    eventLists, eventMetadata,
    setEventLists, setExecuteModeItems, setEventMetadata,
  });

  // マップデータ取り込み





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

  // マップアイテム操作 - extracted to useMapItemOps hook
  const {
    handleAddToExecuteListFromMap,
    handleAddToExecuteListFromMapAtPosition,
    handleRemoveFromExecuteListFromMap,
    handleAddNewItemFromMap,
    handleAddItemFromFocusMode,
    handleMoveToFirstFromMap,
    handleMoveToLastFromMap,
    currentMapExecuteItemIds,
    handleUpdateItemPriority,
    handleUpdateBlocks,
    handleUpdateHalls,
    handleUpdateHallRouteSettings,
    handleReorderExecuteListByHallOrder,
  } = useMapItemOps({
    activeEventName, activeTab, isMapTab, items, eventLists,
    executeModeItems, mapData, hallDefinitions, hallRouteSettings,
    currentMapData, currentHalls, currentHallRouteSettings,
    visitListPanelMapTab,
    setEventLists, setExecuteModeItems, setMapData, setHallDefinitions, setHallRouteSettings,
    setItemToEdit, setNewItemDefaults, setActiveTab,
  });




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

  // カラムアイテム計算 - extracted to useColumnItems hook
  const {
    currentTabItems,
    executeColumnItems,
    visibleItems,
    duplicateCircleItemIds,
    availableBlocks,
    candidateColumnItems,
    blocksWithPriorityRemarks,
    hasCandidateSelection,
    hasExecuteSelection,
    showMoveButtons,
  } = useColumnItems({
    activeEventName, activeTab, eventDates, items,
    executeModeItems, dayModes, sortState,
    selectedBlockFilters, selectedItemIds, recentlyChangedItemIds,
    currentMode,
  });

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
