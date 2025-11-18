import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ViewMode, DayModeState, ExecuteModeItems } from './types';
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
import SortAscendingIcon from './components/icons/SortAscendingIcon';
import SortDescendingIcon from './components/icons/SortDescendingIcon';
import { getItemKey, getItemKeyWithoutTitle, insertItemSorted } from './utils/itemComparison';

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
    Postpone: '単品後回し',
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

  useEffect(() => {
    try {
      const storedLists = localStorage.getItem('eventShoppingLists');
      const storedMetadata = localStorage.getItem('eventMetadata');
      const storedExecuteItems = localStorage.getItem('executeModeItems');
      const storedDayModes = localStorage.getItem('dayModes');
      
      if (storedLists) {
        setEventLists(JSON.parse(storedLists));
      }
      if (storedMetadata) {
        setEventMetadata(JSON.parse(storedMetadata));
      }
      if (storedExecuteItems) {
        setExecuteModeItems(JSON.parse(storedExecuteItems));
      }
      if (storedDayModes) {
        setDayModes(JSON.parse(storedDayModes));
      }
    } catch (error) {
      console.error("Failed to load data from localStorage", error);
    }
    setIsInitialized(true);
  }, []);

  useEffect(() => {
    if (isInitialized) {
      try {
        localStorage.setItem('eventShoppingLists', JSON.stringify(eventLists));
        localStorage.setItem('eventMetadata', JSON.stringify(eventMetadata));
        localStorage.setItem('executeModeItems', JSON.stringify(executeModeItems));
        localStorage.setItem('dayModes', JSON.stringify(dayModes));
      } catch (error) {
        console.error("Failed to save data to localStorage", error);
      }
    }
  }, [eventLists, eventMetadata, executeModeItems, dayModes, isInitialized]);

  const items = useMemo(() => activeEventName ? eventLists[activeEventName] || [] : [], [activeEventName, eventLists]);
  
  // 現在のイベントの参加日リストを取得
  const eventDates = useMemo(() => extractEventDates(items), [items]);
  
  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    // activeTabが参加日（'1日目', '2日目'など）の場合
    if (eventDates.includes(activeTab)) {
      return modes[activeTab] || 'edit';
    }
    return 'edit';
  }, [activeEventName, dayModes, activeTab, eventDates]);

  const handleBulkAdd = useCallback((eventName: string, newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[], metadata?: { url?: string; sheetName?: string, layoutInfo?: Array<{ itemKey: string, eventDate: string, columnType: 'execute' | 'candidate', order: number }> }) => {
    const newItems: ShoppingItem[] = newItemsData.map(itemData => ({
        id: crypto.randomUUID(),
        ...itemData,
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

  const handleMoveItem = useCallback((dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    
    // activeTabが参加日（'1日目', '2日目'など）の場合
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'edit' && targetColumn === 'execute') {
      // 編集モード: 実行列内での並び替え
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[currentEventDate] || [])];
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
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
          const hoverIndex = dayItems.findIndex(id => id === hoverId);
          
          if (dragIndex === -1 || hoverIndex === -1) return prev;
          
          const [draggedItem] = dayItems.splice(dragIndex, 1);
          dayItems.splice(hoverIndex, 0, draggedItem);
          
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
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          const targetItem = candidateItems.find(item => item.id === hoverId);
          const targetIndex = listWithoutSelection.findIndex(item => item.id === hoverId);
          
          if (targetIndex === -1 || !targetItem) return prev;
          
          listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
          
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
        } else {
          // 単一アイテム
          const dragIndex = candidateItems.findIndex(item => item.id === dragId);
          const hoverIndex = candidateItems.findIndex(item => item.id === hoverId);
          
          if (dragIndex === -1 || hoverIndex === -1) return prev;
          
          const [draggedItem] = candidateItems.splice(dragIndex, 1);
          candidateItems.splice(hoverIndex, 0, draggedItem);
          
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
        const dragIndex = newItems.findIndex(item => item.id === dragId);
        const hoverIndex = newItems.findIndex(item => item.id === hoverId);
        
        if (dragIndex === -1 || hoverIndex === -1) return prev;
        if (selectedItemIds.has(dragId)) {
          const selectedBlock = newItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = newItems.filter(item => !selectedItemIds.has(item.id));
          const targetIndex = listWithoutSelection.findIndex(item => item.id === hoverId);
          
          if (targetIndex === -1) return prev;
          listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
          
          return { ...prev, [activeEventName]: listWithoutSelection };
        } else {
          const [draggedItem] = newItems.splice(dragIndex, 1);
          newItems.splice(hoverIndex, 0, draggedItem);
          return { ...prev, [activeEventName]: newItems };
        }
      });
    }
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates]);

  const handleMoveToExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const currentDayItems = new Set(eventItems[currentEventDate] || []);
      
      // 追加（重複は無視）
      itemIds.forEach(id => currentDayItems.add(id));
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [currentEventDate]: Array.from(currentDayItems)
        }
      };
    });
    
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab, eventDates]);

  const handleRemoveFromExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
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
  }, [activeEventName, activeTab, eventDates]);

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

  const handleSelectItem = useCallback((itemId: string) => {
    setSortState('Manual');
    setBlockSortDirection(null);
    setSelectedItemIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(itemId)) {
            newSet.delete(itemId);
        } else {
            newSet.add(itemId);
        }
        return newSet;
    });
  }, []);

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
  }, []);

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

  const handleExportEvent = useCallback((eventName: string) => {
    const itemsToExport = eventLists[eventName];
    if (!itemsToExport || itemsToExport.length === 0) {
      alert('エクスポートするアイテムがありません。');
      return;
    }

    const statusLabels: Record<PurchaseStatus, string> = {
      None: '未購入',
      Purchased: '購入済',
      SoldOut: '売切',
      Absent: '欠席',
      Postpone: '後回し',
      Late: '遅参',
    };

    const escapeCsvCell = (cellData: string | number) => {
      const stringData = String(cellData);
      if (stringData.includes(',') || stringData.includes('"') || stringData.includes('\n')) {
        return `"${stringData.replace(/"/g, '""')}"`;
      }
      return stringData;
    };

    const csvRows: string[] = [];

    // ヘッダー行を最初に出力
    const headers = ['サークル名', '参加日', 'ブロック', 'ナンバー', 'タイトル', '頒布価格', '購入状態', '備考', '列の種類', '列内順番'];
    csvRows.push(headers.join(','));

    // メタデータ行: スプレッドシートURL（コメント行として最後に出力）
    const metadata = eventMetadata[eventName];
    if (metadata?.spreadsheetUrl) {
      csvRows.push(`#METADATA,spreadsheetUrl,${escapeCsvCell(metadata.spreadsheetUrl)}`);
    }

    // 各参加日ごとに配置情報を保持してエクスポート
    const eventDatesForExport = extractEventDates(itemsToExport);
    const itemsMap = new Map(itemsToExport.map(item => [item.id, item]));
    
    eventDatesForExport.forEach(eventDate => {
      const executeIds = executeModeItems[eventName]?.[eventDate] || [];
      const executeIdsSet = new Set(executeIds);
      
      // その参加日のアイテムを取得
      const dayItems = itemsToExport.filter(item => item.eventDate === eventDate);
      
      // 実行列のアイテム（順序を保持）
      const executeItems: ShoppingItem[] = [];
      executeIds.forEach(id => {
        const item = itemsMap.get(id);
        if (item) executeItems.push(item);
      });
      
      // 候補リストのアイテム（元の順序を保持）
      const candidateItems = dayItems.filter(item => !executeIdsSet.has(item.id));
      
      // 実行列のアイテムをエクスポート
      executeItems.forEach((item, index) => {
        const row = [
          escapeCsvCell(item.circle),
          escapeCsvCell(item.eventDate),
          escapeCsvCell(item.block),
          escapeCsvCell(item.number),
          escapeCsvCell(item.title),
          escapeCsvCell(item.price === null ? '' : item.price),
          escapeCsvCell(statusLabels[item.purchaseStatus] || item.purchaseStatus),
          escapeCsvCell(item.remarks),
          escapeCsvCell('実行列'),
          escapeCsvCell(index + 1),
        ];
        csvRows.push(row.join(','));
      });
      
      // 候補リストのアイテムをエクスポート
      candidateItems.forEach((item, index) => {
        const row = [
          escapeCsvCell(item.circle),
          escapeCsvCell(item.eventDate),
          escapeCsvCell(item.block),
          escapeCsvCell(item.number),
          escapeCsvCell(item.title),
          escapeCsvCell(item.price === null ? '' : item.price),
          escapeCsvCell(statusLabels[item.purchaseStatus] || item.purchaseStatus),
          escapeCsvCell(item.remarks),
          escapeCsvCell('候補リスト'),
          escapeCsvCell(index + 1),
        ];
        csvRows.push(row.join(','));
      });
    });

    const csvString = csvRows.join('\n');
    const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
    const blob = new Blob([bom, csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `${eventName}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [eventLists, executeModeItems, eventMetadata]);

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

        const item: Omit<ShoppingItem, 'id' | 'purchaseStatus'> = {
          circle,
          eventDate,
          block,
          number,
          title,
          price,
          remarks
        };
        sheetItems.push(item);
      }

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
          // 完全一致した場合、価格や備考が変わっていれば更新
          if (
            existingWithAll.price !== sheetItem.price ||
            existingWithAll.remarks !== sheetItem.remarks
          ) {
            itemsToUpdate.push({
              ...existingWithAll,
              price: sheetItem.price,
              remarks: sheetItem.remarks
            });
          }
          return;
        }
        
        // タイトルなしで既存アイテムを検索（タイトルが変更された場合）
        const existingWithoutTitle = currentItemsMapWithoutTitle.get(keyWithoutTitle);
        if (existingWithoutTitle) {
          // タイトルや価格、備考が変わっていれば更新
          itemsToUpdate.push({
            ...existingWithoutTitle,
            title: sheetItem.title,
            price: sheetItem.price,
            remarks: sheetItem.remarks
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
  
  // 現在のタブの参加日に該当するアイテムを取得
  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter(item => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

  const TabButton: React.FC<{tab: ActiveTab, label: string, count?: number, onClick?: () => void}> = ({ tab, label, count, onClick }) => {
    const longPressTimeout = React.useRef<number | null>(null);

    const handlePointerDown = () => {
      if (!eventDates.includes(tab)) return;
      if (!activeEventName) return;
      
      longPressTimeout.current = window.setTimeout(() => {
        // 長押しでモード切り替え
        handleToggleMode();
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

    return (
      <div className="relative">
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
          {label} {typeof count !== 'undefined' && <span className="text-xs bg-slate-200 dark:text-slate-700 rounded-full px-2 py-0.5 ml-1">{count}</span>}
        </button>
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
                          return (
                            <TabButton 
                              key={eventDate} 
                              tab={eventDate} 
                              label={eventDate} 
                              count={count} 
                            />
                          );
                        })}
                        <TabButton tab="import" label={itemToEdit ? "アイテム編集" : "アイテム追加"} />
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
            />
        )}
        {activeTab === 'import' && (
           <ImportScreen
             onBulkAdd={handleBulkAdd}
             activeEventName={activeEventName}
             itemToEdit={itemToEdit}
             onUpdateItem={handleUpdateItem}
             onDoneEditing={handleDoneEditing}
             availableEventDates={eventDates}
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
                    onMoveItem={(dragId, hoverId, targetColumn) => handleMoveItem(dragId, hoverId, targetColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    columnType="execute"
                    currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
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
                    onMoveItem={(dragId, hoverId, targetColumn) => handleMoveItem(dragId, hoverId, targetColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    columnType="candidate"
                    currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
                  />
                </div>
              </div>
            ) : (
              <ShoppingList
                items={visibleItems}
                onUpdateItem={handleUpdateItem}
                onMoveItem={(dragId, hoverId, targetColumn) => handleMoveItem(dragId, hoverId, targetColumn)}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds}
                onSelectItem={handleSelectItem}
                columnType="execute"
                currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
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
