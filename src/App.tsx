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

type ActiveTab = 'eventList' | 'day1' | 'day2' | 'import';
type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'Purchased';
export type BulkSortDirection = 'asc' | 'desc';
type BlockSortDirection = 'asc' | 'desc';

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
  
  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    return activeTab === 'day1' ? modes.day1 : modes.day2;
  }, [activeEventName, dayModes, activeTab]);

  const handleBulkAdd = useCallback((eventName: string, newItemsData: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[], metadata?: { url?: string; sheetName?: string }) => {
    const newItems: ShoppingItem[] = newItemsData.map(itemData => ({
        id: crypto.randomUUID(),
        ...itemData,
        purchaseStatus: 'None' as PurchaseStatus,
    }));

    const isNewEvent = !eventLists[eventName];

    setEventLists(prevLists => {
        const currentItems: ShoppingItem[] = prevLists[eventName] || [];
        return {
            ...prevLists,
            [eventName]: [...currentItems, ...newItems] as ShoppingItem[]
        };
    });

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
      setDayModes(prev => ({
        ...prev,
        [eventName]: { day1: 'edit' as ViewMode, day2: 'edit' as ViewMode }
      }));
      setExecuteModeItems(prev => ({
        ...prev,
        [eventName]: { day1: [], day2: [] }
      }));
    }

    alert(`${newItems.length}件のアイテムが${isNewEvent ? 'リストにインポートされました。' : '追加されました。'}`);
    
    if (isNewEvent) {
        setActiveEventName(eventName);
    }
    
    if (newItems.length > 0) {
        if (newItems.some(item => item.eventDate.includes('1日目'))) {
            setActiveTab('day1');
        } else if (newItems.some(item => item.eventDate.includes('2日目'))) {
            setActiveTab('day2');
        } else {
            setActiveTab('day1');
        }
    }
  }, [eventLists]);

  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    if (!activeEventName) return;
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: prev[activeEventName].map(item => (item.id === updatedItem.id ? updatedItem : item))
    }));
  }, [activeEventName]);

  const handleMoveItem = useCallback((dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const mode = dayModes[activeEventName]?.[currentDay] || 'edit';

    if (mode === 'edit' && targetColumn === 'execute') {
      // 編集モード: 実行列内での並び替え
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || { day1: [], day2: [] };
        const dayItems = [...eventItems[currentDay]];
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          const targetIndex = listWithoutSelection.findIndex(id => id === hoverId);
          
          if (targetIndex === -1) return prev;
          listWithoutSelection.splice(targetIndex, 0, ...selectedBlock);
          
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentDay]: listWithoutSelection }
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
            [activeEventName]: { ...eventItems, [currentDay]: dayItems }
          };
        }
      });
    } else if (mode === 'edit' && targetColumn === 'candidate') {
      // 編集モード: 候補リスト内での並び替え
      setEventLists(prev => {
        const allItems = [...(prev[activeEventName] || [])];
        const currentTabKey = activeTab === 'day1' ? '1日目' : '2日目';
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
        
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
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems]);

  const handleMoveToExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || { day1: [], day2: [] };
      const currentDayItems = new Set(eventItems[currentDay]);
      
      // 追加（重複は無視）
      itemIds.forEach(id => currentDayItems.add(id));
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [currentDay]: Array.from(currentDayItems)
        }
      };
    });
    
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab]);

  const handleRemoveFromExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || { day1: [], day2: [] };
      const currentDayItems = eventItems[currentDay].filter(id => !itemIds.includes(id));
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [currentDay]: currentDayItems
        }
      };
    });
    
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab]);

  const handleToggleMode = useCallback(() => {
    if (!activeEventName) return;
    
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const currentModeValue = dayModes[activeEventName]?.[currentDay] || 'edit';
    const newMode: ViewMode = currentModeValue === 'edit' ? 'execute' : 'edit';
    
    setDayModes(prev => ({
      ...prev,
      [activeEventName]: {
        ...(prev[activeEventName] || { day1: 'edit' as ViewMode, day2: 'edit' as ViewMode }),
        [currentDay]: newMode
      }
    }));
    
    setSelectedItemIds(new Set());
  }, [activeEventName, activeTab, dayModes]);
  
  const handleSelectEvent = useCallback((eventName: string) => {
    setActiveEventName(eventName);
    setSelectedItemIds(new Set());
    const eventItems = eventLists[eventName] || [];
    if (eventItems.some(item => item.eventDate.includes('1日目'))){
        setActiveTab('day1');
    } else if (eventItems.some(item => item.eventDate.includes('2日目'))) {
        setActiveTab('day2');
    } else {
        setActiveTab('day1');
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
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  };

  const handleBlockSortToggle = () => {
    if (!activeEventName) return;

    const nextDirection = blockSortDirection === 'asc' ? 'desc' : 'asc';

    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = activeTab === 'day1' ? '1日目' : '2日目';

      const itemsForTab = allItems.filter(item => item.eventDate.includes(currentTabKey));
      
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
          if (item.eventDate.includes(currentTabKey)) {
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

    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const currentTabKey = activeTab === 'day1' ? '1日目' : '2日目';
      const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentDay] || []);

      // 候補リストのアイテムのみを取得
      const candidateItems = allItems.filter(item => 
        item.eventDate.includes(currentTabKey) && !executeIds.has(item.id)
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
        item.eventDate.includes(currentTabKey) && executeIds.has(item.id)
      );
      
      // 実行モード列と候補リストを結合（実行モード列が先）
      const newItems = allItems.map(item => {
        if (!item.eventDate.includes(currentTabKey)) {
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
      
      return {
        ...prev,
        [activeEventName]: {
          day1: eventItems.day1.filter(id => id !== deletedId),
          day2: eventItems.day2.filter(id => id !== deletedId)
        }
      };
    });
    
    setItemToDelete(null);
  };

  const handleDoneEditing = () => {
    const originalDay = itemToEdit?.eventDate.includes('1日目') ? 'day1' : 'day2';
    setItemToEdit(null);
    setActiveTab(originalDay);
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

  const handleClearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
  }, []);

  const handleBulkSort = useCallback((direction: BulkSortDirection) => {
    if (!activeEventName || selectedItemIds.size === 0) return;
    setSortState('Manual');
    setBlockSortDirection(null);
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const mode = dayModes[activeEventName]?.[currentDay] || 'edit';

    if (mode === 'edit') {
      // 編集モード: 選択されたアイテムが実行モード列か候補リストかを判定
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
      const selectedItems = items.filter(item => selectedItemIds.has(item.id));
      const isInExecuteColumn = selectedItems.some(item => executeIds.has(item.id));
      const isInCandidateColumn = selectedItems.some(item => !executeIds.has(item.id));
      
      if (isInExecuteColumn && !isInCandidateColumn) {
        // 実行モード列のみ
        setExecuteModeItems(prev => {
          const eventItems = prev[activeEventName] || { day1: [], day2: [] };
          const dayItems = [...eventItems[currentDay]];
          
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
            [activeEventName]: { ...eventItems, [currentDay]: newDayItems }
          };
        });
      } else if (isInCandidateColumn && !isInExecuteColumn) {
        // 候補リストのみ
        setEventLists(prev => {
          const allItems = [...(prev[activeEventName] || [])];
          const currentTabKey = activeTab === 'day1' ? '1日目' : '2日目';
          const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
          
          const candidateItems = allItems.filter(item => 
            item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id)
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
            item.eventDate.includes(currentTabKey) && executeIdsSet.has(item.id)
          );
          
          const newItems = allItems.map(item => {
            if (!item.eventDate.includes(currentTabKey)) {
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
  }, [activeEventName, selectedItemIds, items, activeTab, dayModes, executeModeItems]);

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

    const headers = ['サークル名', '参加日', 'ブロック', 'ナンバー', 'タイトル', '頒布価格', '購入状態', '備考'];
    const csvRows = [headers.join(',')];

    // 実行列の並び順で各参加日別に並べ替え
    const executeIdsDay1 = executeModeItems[eventName]?.day1 || [];
    const executeIdsDay2 = executeModeItems[eventName]?.day2 || [];
    const itemsMap = new Map(itemsToExport.map(item => [item.id, item]));
    
    // 1日目の実行列の順序でアイテムを取得
    const day1Items = executeIdsDay1.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
    // 2日目の実行列の順序でアイテムを取得
    const day2Items = executeIdsDay2.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
    
    // 実行列に含まれていないアイテムを取得
    const executeIdsSet = new Set([...executeIdsDay1, ...executeIdsDay2]);
    const otherItems = itemsToExport.filter(item => !executeIdsSet.has(item.id));
    
    // 1日目、2日目、その他の順で結合
    const sortedItems = [...day1Items, ...day2Items, ...otherItems];

    sortedItems.forEach(item => {
      const row = [
        escapeCsvCell(item.circle),
        escapeCsvCell(item.eventDate),
        escapeCsvCell(item.block),
        escapeCsvCell(item.number),
        escapeCsvCell(item.title),
        escapeCsvCell(item.price),
        escapeCsvCell(statusLabels[item.purchaseStatus] || item.purchaseStatus),
        escapeCsvCell(item.remarks),
      ];
      csvRows.push(row.join(','));
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
  }, [eventLists, executeModeItems]);

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
        const price = parseInt((cells[17] || '0').replace(/[^0-9]/g, ''), 10) || 0; // R列 (0-indexed: 17)
        const remarks = cells[22]?.trim() || ''; // W列 (0-indexed: 22)

        sheetItems.push({
          circle,
          eventDate,
          block,
          number,
          title,
          price,
          remarks
        });
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
      
      return {
        ...prev,
        [eventName]: {
          day1: eventItems.day1.filter(id => !deleteIds.has(id)),
          day2: eventItems.day2.filter(id => !deleteIds.has(id))
        }
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
  
  const day1Items = useMemo(() => items.filter(item => item.eventDate.includes('1日目')), [items]);
  const day2Items = useMemo(() => items.filter(item => item.eventDate.includes('2日目')), [items]);

  const TabButton: React.FC<{tab: ActiveTab, label: string, count?: number, onClick?: () => void}> = ({ tab, label, count, onClick }) => {
    const longPressTimeout = React.useRef<number | null>(null);

    const handlePointerDown = () => {
      if (tab !== 'day1' && tab !== 'day2') return;
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

  const visibleItems = useMemo(() => {
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const itemsForTab = activeTab === 'day1' ? day1Items : day2Items;
    
    if (!activeEventName) return itemsForTab;
    
    const mode = dayModes[activeEventName]?.[currentDay] || 'edit';
    
    if (mode === 'execute') {
      // 実行モード: 実行列のアイテムのみ表示
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
      const filtered = itemsForTab.filter(item => executeIds.has(item.id));
      
      if (sortState === 'Manual') {
        return filtered;
      }
      return filtered.filter(item => item.purchaseStatus === sortState as Exclude<SortState, 'Manual'>);
    }
    
    // 編集モード: すべてのアイテムを表示（列分けはコンポーネント側で処理）
    return itemsForTab;
  }, [activeTab, day1Items, day2Items, sortState, activeEventName, dayModes, executeModeItems]);

  const executeColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const executeIds = executeModeItems[activeEventName]?.[currentDay] || [];
    const itemsMap = new Map(items.map(item => [item.id, item]));
    return executeIds.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
  }, [activeEventName, activeTab, executeModeItems, items]);

  const candidateColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
    const itemsForTab = activeTab === 'day1' ? day1Items : day2Items;
    return itemsForTab.filter(item => !executeIds.has(item.id));
  }, [activeEventName, activeTab, executeModeItems, day1Items, day2Items]);

  // 候補リストのアイテムが選択されているかチェック
  const hasCandidateSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
    const selectedItems = items.filter(item => selectedItemIds.has(item.id));
    const itemsForTab = activeTab === 'day1' ? day1Items : day2Items;
    return selectedItems.some(item => itemsForTab.includes(item) && !executeIds.has(item.id));
  }, [activeEventName, activeTab, currentMode, selectedItemIds, items, executeModeItems, day1Items, day2Items]);

  // 実行モード列のアイテムが選択されているかチェック
  const hasExecuteSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentDay = activeTab === 'day1' ? 'day1' : 'day2';
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentDay] || []);
    const selectedItems = items.filter(item => selectedItemIds.has(item.id));
    const itemsForTab = activeTab === 'day1' ? day1Items : day2Items;
    return selectedItems.some(item => itemsForTab.includes(item) && executeIds.has(item.id));
  }, [activeEventName, activeTab, currentMode, selectedItemIds, items, executeModeItems, day1Items, day2Items]);

  // 左右両列のアイテムが同時に選択されている場合は移動ボタンを表示しない
  const showMoveButtons = (hasCandidateSelection && !hasExecuteSelection) || (hasExecuteSelection && !hasCandidateSelection);
  
  if (!isInitialized) {
    return null;
  }

  const mainContentVisible = activeTab === 'day1' || activeTab === 'day2';
  
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
                <TabButton tab="eventList" label="即売会リスト" onClick={() => { setActiveEventName(null); setItemToEdit(null); setSelectedItemIds(new Set()); setActiveTab('eventList'); }}/>
                {activeEventName ? (
                    <>
                        <TabButton tab="day1" label="1日目" count={day1Items.length} />
                        <TabButton tab="day2" label="2日目" count={day2Items.length} />
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
                    currentDay={activeTab === 'day1' ? 'day1' : 'day2'}
                  />
                </div>
                
                {/* 右列: 候補リスト */}
                <div className="space-y-2">
                  <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">候補リスト</h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-1">アイテムを選択してヘッダーのボタンから移動</p>
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
                    currentDay={activeTab === 'day1' ? 'day1' : 'day2'}
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
                currentDay={activeTab === 'day1' ? 'day1' : 'day2'}
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
