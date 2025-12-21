import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ViewMode, DayModeState, ExecuteModeItems, MapDataStore, RouteSettingsStore, ExportOptions, BlockDefinition, HallDefinition, HallRouteSettings, HallDefinitionsStore, HallRouteSettingsStore } from './types';
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
import { MapView, BlockDefinitionPanel, HallDefinitionPanel, isPointInPolygon } from './components/map';
import { getItemKey, getItemKeyWithoutTitle, insertItemSorted } from './utils/itemComparison';
import { parseMapFile } from './utils/xlsxMapParser';
import { db } from './utils/indexedDB';
import { exportToXlsx, importFromXlsx, downloadBlob } from './utils/exportImport';

type ActiveTab = 'eventList' | 'import' | string; // string部分は動的な参加日（例: '1日目', '2日目', '3日目'など）
type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'Purchased';
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

const sortCycle: SortState[] = ['Postpone', 'Late', 'Absent', 'SoldOut', 'Purchased', 'Manual'];
const sortLabels: Record<SortState, string> = {
    Manual: '巡回順',
    Postpone: '後回し',
    Late: '遅参',
    Absent: '欠席',
    SoldOut: '売切',
    Purchased: '購入済',
};

const App: React.FC = () => {
  const [eventLists, setEventLists] = useState<Record<string, ShoppingItem[]>>({});
  const [eventMetadata, setEventMetadata] = useState<Record<string, EventMetadata>>({});
  const [executeModeItems, setExecuteModeItems] = useState<Record<string, ExecuteModeItems>>({});
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});
  
  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
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

  // 更新機能用の状態
  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [updateData, setUpdateData] = useState<{
    itemsToDelete: ShoppingItem[];
    itemsToUpdate: ShoppingItem[];
    itemsToAdd: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[];
  } | null>(null);
  const [updateEventName, setUpdateEventName] = useState<string | null>(null);
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);
  
  // 検索機能の状態
  const [searchKeyword, setSearchKeyword] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // マップ機能の状態
  const [mapData, setMapData] = useState<MapDataStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});
  const [showExportOptions, setShowExportOptions] = useState(false);
  const [exportEventName, setExportEventName] = useState<string | null>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const exportFileInputRef = useRef<HTMLInputElement>(null);
  
  // 保存フラグ（データ変更時のみ保存）
  const isSavingRef = useRef(false);

  // IndexedDBからデータを読み込み
  useEffect(() => {
    const loadData = async () => {
      try {
        // localStorageからの移行を試みる
        await db.migrateFromLocalStorage();
        
        // IndexedDBからデータを読み込み
        const [
          loadedEventLists,
          loadedMetadata,
          loadedExecuteItems,
          loadedDayModes,
          loadedMapData,
          loadedRouteSettings,
          loadedHallDefinitions,
          loadedHallRouteSettings,
        ] = await Promise.all([
          db.loadEventLists(),
          db.loadEventMetadata(),
          db.loadExecuteModeItems(),
          db.loadDayModes(),
          db.loadMapData(),
          db.loadRouteSettings(),
          db.loadHallDefinitions(),
          db.loadHallRouteSettings(),
        ]);
        
        // 既存データの互換性: quantityフィールドがない場合は1を設定
        const migratedLists: Record<string, ShoppingItem[]> = {};
        Object.keys(loadedEventLists).forEach(eventName => {
          migratedLists[eventName] = (loadedEventLists[eventName] as ShoppingItem[]).map((item: ShoppingItem) => ({
            ...item,
            quantity: item.quantity ?? 1,
          }));
        });
        
        setEventLists(migratedLists);
        setEventMetadata(loadedMetadata as Record<string, EventMetadata>);
        setExecuteModeItems(loadedExecuteItems);
        setDayModes(loadedDayModes as Record<string, DayModeState>);
        setMapData(loadedMapData as MapDataStore);
        setRouteSettings(loadedRouteSettings as RouteSettingsStore);
        setHallDefinitions(loadedHallDefinitions as HallDefinitionsStore);
        setHallRouteSettings(loadedHallRouteSettings as HallRouteSettingsStore);
        
        console.log('Data loaded from IndexedDB');
      } catch (error) {
        console.error('Failed to load data from IndexedDB:', error);
      }
      setIsInitialized(true);
    };
    
    loadData();
  }, []);

  // IndexedDBへデータを保存（デバウンス付き）
  useEffect(() => {
    if (!isInitialized || isSavingRef.current) return;
    
    const saveData = async () => {
      isSavingRef.current = true;
      try {
        await Promise.all([
          db.saveEventLists(eventLists),
          db.saveEventMetadata(eventMetadata),
          db.saveExecuteModeItems(executeModeItems),
          db.saveDayModes(dayModes),
          db.saveMapData(mapData),
          db.saveRouteSettings(routeSettings),
          db.saveHallDefinitions(hallDefinitions),
          db.saveHallRouteSettings(hallRouteSettings),
        ]);
        console.log('Data saved to IndexedDB');
      } catch (error) {
        console.error('Failed to save data to IndexedDB:', error);
        alert('データの保存に失敗しました。ストレージ容量を確認してください。');
      } finally {
        isSavingRef.current = false;
      }
    };
    
    // デバウンス: 500ms後に保存
    const timeoutId = setTimeout(saveData, 500);
    return () => clearTimeout(timeoutId);
  }, [eventLists, eventMetadata, executeModeItems, dayModes, mapData, routeSettings, hallDefinitions, hallRouteSettings, isInitialized]);

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

  const handleBulkAdd = useCallback((eventName: string, newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[], metadata?: { url?: string; sheetName?: string; layoutInfo?: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }> }) => {
    const newItems: ShoppingItem[] = newItemsData.map(itemData => ({
        id: crypto.randomUUID(),
        ...itemData,
        quantity: itemData.quantity ?? 1,
        purchaseStatus: 'None' as PurchaseStatus,
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
      
      // 購入状態が変更された場合、最近変更されたアイテムとして記録
      if (purchaseStatusChanged) {
        setRecentlyChangedItemIds(prevIds => new Set(prevIds).add(updatedItem.id));
      }
      
      return {
        ...prev,
        [activeEventName]: prev[activeEventName].map(item => (item.id === updatedItem.id ? updatedItem : item))
      };
    });
  }, [activeEventName]);

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
  }, [rangeStart, rangeEnd, activeTab, activeEventName, eventDates, executeModeItems, items, selectedBlockFilters]);

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
      
      // イベント名の重複チェック
      let eventName = result.eventName;
      if (eventLists[eventName]) {
        const overwrite = confirm(`「${eventName}」は既に存在します。上書きしますか？\n\nキャンセルを押すと新しい名前で保存します。`);
        if (!overwrite) {
          const newName = prompt('新しいイベント名を入力してください:', `${eventName}_imported`);
          if (!newName) return;
          eventName = newName;
        }
      }
      
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
      } else {
        alert(`「${eventName}」をインポートしました。\n${result.items.length}件のアイテム`);
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

      // 削除対象: スプレッドシートにないアイテム（サークル名・参加日・ブロック・ナンバーで照合）
      currentItems.forEach(item => {
        const keyWithoutTitle = getItemKeyWithoutTitle(item);
        if (!sheetItemsMapWithoutTitle.has(keyWithoutTitle)) {
          itemsToDelete.push(item);
        }
      });

      // 更新・追加対象の処理
      sheetItems.forEach(sheetItem => {
        const keyWithAll = getItemKey(sheetItem);
        const keyWithoutTitle = getItemKeyWithoutTitle(sheetItem);
        
        // 完全一致（サークル名・参加日・ブロック・ナンバー・タイトル）で既存アイテムを検索
        const existingWithAll = currentItemsMapWithAll.get(keyWithAll);
        if (existingWithAll) {
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

      setUpdateData({ itemsToDelete, itemsToUpdate, itemsToAdd });
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
          purchaseStatus: 'None' as PurchaseStatus
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
    
    try {
      const parsedMapData = await parseMapFile(file);
      if (!parsedMapData) {
        alert('マップデータの解析に失敗しました。');
        return;
      }
      
      setMapData(prev => ({
        ...prev,
        [eventName]: {
          ...(prev[eventName] || {}),
          ...parsedMapData,
        },
      }));
      
      const mapCount = Object.keys(parsedMapData).length;
      alert(`${mapCount}件のマップデータを取り込みました。`);
      
      // 最初のマップタブに切り替え
      const firstMapName = Object.keys(parsedMapData)[0];
      if (firstMapName) {
        setActiveTab(firstMapName);
      }
    } catch (error) {
      console.error('Map import error:', error);
      alert(`マップデータの取り込みに失敗しました: ${error instanceof Error ? error.message : '不明なエラー'}`);
    }
    
    // ファイル入力をリセット
    e.target.value = '';
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

  // マップタブメニューの状態
  const [mapTabMenuOpen, setMapTabMenuOpen] = useState<string | null>(null);
  const [visitListPanelOpen, setVisitListPanelOpen] = useState(false);
  const [blockDefinitionMode, setBlockDefinitionMode] = useState(false);
  
  // セル選択モードの状態（ブロック定義用）
  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
    clickedCells: { row: number; col: number }[];
    editingBlockData?: unknown;
  } | null>(null);
  
  // セル選択完了時にBlockDefinitionPanelに渡すデータ
  const [pendingCellSelection, setPendingCellSelection] = useState<{
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);
  
  // 将来機能用に保持
  void visitListPanelOpen;
  
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

  // ホール定義モードの状態
  const [hallDefinitionMode, setHallDefinitionMode] = useState(false);

  // ホール頂点選択モードの状態
  const [vertexSelectionMode, setVertexSelectionMode] = useState<{
    clickedVertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // ホール頂点選択完了時にHallDefinitionPanelに渡すデータ
  const [pendingVertexSelection, setPendingVertexSelection] = useState<{
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // ホール頂点選択モードを開始
  const handleStartVertexSelection = useCallback((editingData?: unknown) => {
    setVertexSelectionMode({ clickedVertices: [], editingData });
    setHallDefinitionMode(false);
  }, []);

  // ホール頂点選択を確定
  const handleConfirmVertexSelection = useCallback(() => {
    if (vertexSelectionMode) {
      setPendingVertexSelection({
        vertices: vertexSelectionMode.clickedVertices,
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [vertexSelectionMode]);

  // ホール頂点選択をキャンセル
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

  // マップセルクリック時にホール頂点選択に追加/削除
  useEffect(() => {
    const handleMapCellClickForVertex = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!vertexSelectionMode) return;
      
      const { row, col } = e.detail;
      
      setVertexSelectionMode(prev => {
        if (!prev) return prev;
        
        // 既存の頂点をクリックした場合は削除
        const existingIndex = prev.clickedVertices.findIndex(v => v.row === row && v.col === col);
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter((_, i) => i !== existingIndex),
          };
        }
        
        // 最大6頂点まで
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
  
  // セル選択モードを開始（BlockDefinitionPanelから呼ばれる）
  const handleStartCellSelection = useCallback((
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual',
    editingData?: unknown
  ) => {
    setCellSelectionMode({ type, clickedCells: [], editingBlockData: editingData });
    setBlockDefinitionMode(false); // パネルを一時的に非表示
  }, []);
  
  // 範囲を反映してパネルを再表示
  const handleConfirmCellSelection = useCallback(() => {
    if (cellSelectionMode) {
      // pendingCellSelectionをセットしてBlockDefinitionPanelに渡す
      setPendingCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // パネルを再表示
  }, [cellSelectionMode]);
  
  // セル選択をキャンセル（編集画面に戻る）
  const handleCancelCellSelection = useCallback(() => {
    // 編集データを保持したままパネルを再表示
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: 'cancelled', // キャンセル用の特殊タイプ
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true); // パネルを再表示
  }, [cellSelectionMode]);
  
  // マップセルクリックをリッスンしてセル選択に追加
  useEffect(() => {
    const handleMapCellClick = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!cellSelectionMode) return;
      
      const { row, col } = e.detail;
      
      setCellSelectionMode(prev => {
        if (!prev) return prev;
        
        // 既に選択されている場合は削除（個別モードのみ）
        if (prev.type === 'individual') {
          const existingIndex = prev.clickedCells.findIndex(c => c.row === row && c.col === col);
          if (existingIndex >= 0) {
            return {
              ...prev,
              clickedCells: prev.clickedCells.filter((_, i) => i !== existingIndex),
            };
          }
        }
        
        // 選択を追加
        return {
          ...prev,
          clickedCells: [...prev.clickedCells, { row, col }],
        };
      });
    };
    
    window.addEventListener('mapCellClick', handleMapCellClick as EventListener);
    return () => window.removeEventListener('mapCellClick', handleMapCellClick as EventListener);
  }, [cellSelectionMode]);

  const TabButton: React.FC<{tab: ActiveTab, label: string, count?: number, onClick?: () => void, isMapTab?: boolean}> = ({ tab, label, count, onClick, isMapTab: isMapTabProp }) => {
    const longPressTimeout = React.useRef<number | null>(null);
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const menuRef = React.useRef<HTMLDivElement>(null);
    const [menuPosition, setMenuPosition] = React.useState({ x: 0, y: 0 });

    const handlePointerDown = () => {
      if (!activeEventName) return;
      
      longPressTimeout.current = window.setTimeout(() => {
        if (isMapTabProp) {
          // マップタブの長押しメニュー - ボタン位置を取得
          if (buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setMenuPosition({
              x: rect.left + rect.width / 2,
              y: rect.top,
            });
          }
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
      if (mapTabMenuOpen) {
        setMapTabMenuOpen(null);
        return;
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
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setMapTabMenuOpen(null);
        }
      };
      if (mapTabMenuOpen === tab) {
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }
    }, [tab]);

    return (
      <>
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
        </div>
        
        {/* マップタブ長押しメニュー - fixedオーバーレイ */}
        {mapTabMenuOpen === tab && isMapTabProp && (
          <div 
            ref={menuRef}
            className="fixed bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 min-w-[180px]"
            style={{
              left: menuPosition.x,
              top: menuPosition.y - 8,
              transform: 'translate(-50%, -100%)',
              zIndex: 9999,
            }}
          >
            {/* 矢印 */}
            <div 
              className="absolute left-1/2 -translate-x-1/2"
              style={{ top: '100%', marginTop: '-1px' }}
            >
              <div className="w-3 h-3 bg-white dark:bg-slate-800 border-r border-b border-slate-200 dark:border-slate-700 transform rotate-45" />
            </div>
            <div className="py-1">
              <button
                onClick={() => {
                  setVisitListPanelOpen(true);
                  setMapTabMenuOpen(null);
                }}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-t-lg flex items-center gap-2"
              >
                <span>📍</span> 訪問先リスト
              </button>
              <button
                onClick={() => {
                  setBlockDefinitionMode(true);
                  setMapTabMenuOpen(null);
                }}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
              >
                <span>🔲</span> ブロック定義
              </button>
              <button
                onClick={() => {
                  setHallDefinitionMode(true);
                  setMapTabMenuOpen(null);
                }}
                className="w-full px-4 py-3 text-left text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-b-lg flex items-center gap-2"
              >
                <span>🏛️</span> ホール定義
              </button>
            </div>
          </div>
        )}
      </>
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
  const searchMatches = useMemo(() => {
    if (!searchKeyword.trim() || !activeEventName || !eventDates.includes(activeTab)) {
      return [];
    }
    
    const keyword = searchKeyword.trim().toLowerCase();
    const matches: string[] = [];
    
    // 現在のタブのアイテムを検索
    currentTabItems.forEach(item => {
      const circleMatch = item.circle.toLowerCase().includes(keyword);
      const titleMatch = item.title.toLowerCase().includes(keyword);
      const remarksMatch = item.remarks.toLowerCase().includes(keyword);
      
      if (circleMatch || titleMatch || remarksMatch) {
        matches.push(item.id);
      }
    });
    
    return matches;
  }, [searchKeyword, activeEventName, activeTab, currentTabItems, eventDates]);

  // 検索キーワードが変更されたときに検索結果をリセット
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

  // タブが切り替わったときに検索結果をリセット
  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab]);

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

  // 表示されているアイテムのみを検索対象とする
  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName || '']?.[currentEventDate] || 'edit';
    
    let visibleItemIds: Set<string>;
    
    if (mode === 'execute') {
      // 実行モード: executeColumnItemsまたはvisibleItems
      visibleItemIds = new Set(visibleItems.map(item => item.id));
    } else {
      // 編集モード: executeColumnItems + candidateColumnItems
      const allVisibleIds = new Set([
        ...executeColumnItems.map(item => item.id),
        ...candidateColumnItems.map(item => item.id)
      ]);
      visibleItemIds = allVisibleIds;
    }
    
    return searchMatches.filter(id => visibleItemIds.has(id));
  }, [searchMatches, activeEventName, activeTab, eventDates, dayModes, visibleItems, executeColumnItems, candidateColumnItems]);

  // 「次を検索」ボタンのハンドラ
  const handleSearchNext = useCallback(() => {
    if (!searchKeyword.trim() || visibleSearchMatches.length === 0) {
      if (searchMatches.length > 0 && visibleSearchMatches.length === 0) {
        alert('フィルタされています');
      }
      return;
    }
    
    // 次のインデックスを計算（ループ）
    // currentSearchIndexが-1の場合は0から始める
    const startIndex = currentSearchIndex === -1 ? -1 : currentSearchIndex;
    const nextIndex = (startIndex + 1) % visibleSearchMatches.length;
    setCurrentSearchIndex(nextIndex);
    
    const nextItemId = visibleSearchMatches[nextIndex];
    setHighlightedItemId(nextItemId);
    
    // スクロール処理
    setTimeout(() => {
      const element = document.querySelector(`[data-item-id="${nextItemId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);

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
      <header className="bg-white dark:bg-slate-800 shadow-sm sticky top-0 z-10">
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
            {activeEventName && <h2 className="text-sm text-blue-600 dark:text-blue-400 font-semibold mt-1">{activeEventName}</h2>}
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
      </header>

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
            onRemoveFromExecuteList={handleRemoveFromExecuteListFromMap}
            onMoveToFirst={handleMoveToFirstFromMap}
            onMoveToLast={handleMoveToLastFromMap}
            onUpdateItem={handleUpdateItem}
            onDeleteItem={(itemId) => {
              const item = items.find(i => i.id === itemId);
              if (item) handleDeleteRequest(item);
            }}
            halls={currentHalls}
            hallRouteSettings={currentHallRouteSettings}
            onUpdateHallRouteSettings={handleUpdateHallRouteSettings}
            onReorderExecuteList={handleReorderExecuteListByHallOrder}
            vertexSelectionMode={vertexSelectionMode}
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
                  />
                </div>
              </div>
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
          {currentMode === 'execute' && <SummaryBar items={visibleItems} />}
        </>
      )}
      {activeEventName && items.length > 0 && mainContentVisible && (
        <ZoomControl zoomLevel={zoomLevel} onZoomChange={handleZoomChange} />
      )}
    </div>
  );
};

export default App;
