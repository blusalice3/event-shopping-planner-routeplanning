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
import SortAscendingIcon from './components/icons/SortAscendingIcon';
import SortDescendingIcon from './components/icons/SortDescendingIcon';
import { getItemKey, insertItemSorted } from './utils/itemComparison';

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
  const [showUrlUpdateDialog, setShowUrlUpdateDialog] = useState(false);
  const [pendingUpdateEventName, setPendingUpdateEventName] = useState<string | null>(null);

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
        purchaseStatus: 'None',
    }));

    const isNewEvent = !eventLists[eventName];

    setEventLists(prevLists => {
        const currentItems = prevLists[eventName] || [];
        return {
            ...prevLists,
            [eventName]: [...currentItems, ...newItems]
        };
    });

    // メタデータの保存
    if (metadata?.url) {
      setEventMetadata(prev => ({
        ...prev,
        [eventName]: {
          spreadsheetUrl: metadata.url,
          spreadsheetSheetName: metadata.sheetName || '',
          lastImportDate: new Date().toISOString()
        }
      }));
    }

    // 初期モードを編集モードに設定
    if (isNewEvent) {
      setDayModes(prev => ({
        ...prev,
        [eventName]: { day1: 'edit', day2: 'edit' }
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

  const handleMoveItem = useCallback((dragId: string, hoverId: string, targetColumn: 'execute' | 'candidate') => {
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
  }, [activeEventName, selectedItemIds, activeTab, dayModes]);

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
        ...(prev[activeEventName] || { day1: 'edit', day2: 'edit' }),
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
    setSortState('Manual');
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
      // 編集モード: 実行列のみソート
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
  }, [activeEventName, selectedItemIds, items, activeTab, dayModes]);

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

    itemsToExport.forEach(item => {
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

        const block = cells[2]?.trim() || '';
        const number = cells[3]?.trim() || '';
        if (!block || !number) continue;

        sheetItems.push({
          circle: cells[0]?.trim() || '',
          eventDate: cells[1]?.trim() || '1日目',
          block,
          number,
          title: cells[4]?.trim() || '',
          price: parseInt((cells[5] || '0').replace(/[^0-9]/g, ''), 10) || 0,
          remarks: cells[7]?.trim() || ''
        });
      }

      const currentItems = eventLists[eventName] || [];
      const sheetItemsMap = new Map(sheetItems.map(item => [getItemKey(item), item]));
      const currentItemsMap = new Map(currentItems.map(item => [getItemKey(item), item]));

      const itemsToDelete: ShoppingItem[] = [];
      const itemsToUpdate: ShoppingItem[] = [];
      const itemsToAdd: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];

      // 削除対象
      currentItems.forEach(item => {
        const key = getItemKey(item);
        if (!sheetItemsMap.has(key)) {
          itemsToDelete.push(item);
        }
      });

      // 更新対象
      sheetItems.forEach(sheetItem => {
        const key = getItemKey(sheetItem);
        const existing = currentItemsMap.get(key);

        if (existing) {
          if (
            existing.title !== sheetItem.title ||
            existing.price !== sheetItem.price ||
            existing.remarks !== sheetItem.remarks
          ) {
            itemsToUpdate.push({
              ...existing,
              title: sheetItem.title,
              price: sheetItem.price,
              remarks: sheetItem.remarks
            });
          }
        } else {
          itemsToAdd.push(sheetItem);
        }
      });

      setUpdateData({ itemsToDelete, itemsToUpdate, itemsToAdd });
      setShowUpdateConfirmation(true);

    } catch (error) {
      console.error('Update error:', error);
      setPendingUpdateEventName(eventName);
      setShowUrlUpdateDialog(true);
    }
  }, [eventLists, eventMetadata]);

  const handleConfirmUpdate = useCallback(() => {
    if (!updateData || !activeEventName) return;

    const { itemsToDelete, itemsToUpdate, itemsToAdd } = updateData;
    
    setEventLists(prev => {
      let newItems = [...(prev[activeEventName] || [])];
      
      // 削除
      const deleteIds = new Set(itemsToDelete.map(item => item.id));
      newItems = newItems.filter(item => !deleteIds.has(item.id));
      
      // 更新
      const updateMap = new Map(itemsToUpdate.map(item => [item.id, item]));
      newItems = newItems.map(item => updateMap.get(item.id) || item);
      
      // 追加（ソート挿入）
      itemsToAdd.forEach(itemData => {
        const newItem: ShoppingItem = {
          id: crypto.randomUUID(),
          ...itemData,
          purchaseStatus: 'None'
        };
        newItems = insertItemSorted(newItems, newItem);
      });
      
      return { ...prev, [activeEventName]: newItems };
    });

    // 削除されたアイテムを実行モードアイテムからも削除
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName];
      if (!eventItems) return prev;
      
      const deleteIds = new Set(itemsToDelete.map(item => item.id));
      
      return {
        ...prev,
        [activeEventName]: {
          day1: eventItems.day1.filter(id => !deleteIds.has(id)),
          day2: eventItems.day2.filter(id => !deleteIds.has(id))
        }
      };
    });

    setShowUpdateConfirmation(false);
    setUpdateData(null);
    alert('アイテムを更新しました。');
  }, [updateData, activeEventName]);

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
    const [showModeMenu, setShowModeMenu] = useState(false);
    const longPressTimeout = React.useRef<number | null>(null);

    const handlePointerDown = () => {
      if (tab !== 'day1' && tab !== 'day2') return;
      if (!activeEventName) return;
      
      longPressTimeout.current = window.setTimeout(() => {
        setShowModeMenu(true);
      }, 500);
    };

    const handlePointerUp = () => {
      if (longPressTimeout.current) {
        clearTimeout(longPressTimeout.current);
        longPressTimeout.current = null;
      }
    };

    const handleClick = () => {
      if (showModeMenu) {
        setShowModeMenu(false);
      } else if (onClick) {
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
          {label} {typeof count !== 'undefined' && <span className="text-xs bg-slate-200 dark:bg-slate-700 rounded-full px-2 py-0.5 ml-1">{count}</span>}
        </button>
        {showModeMenu && activeEventName && (tab === 'day1' || tab === 'day2') && (
          <div className="absolute top-full left-0 mt-1 z-20 bg-white dark:bg-slate-800 rounded-md shadow-lg border border-slate-200 dark:border-slate-700 py-1">
            <button
              onClick={() => {
                handleToggleMode();
                setShowModeMenu(false);
              }}
              className="block w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 whitespace-nowrap"
            >
              {currentMode === 'edit' ? '📋 実行モード' : '✏️ 編集モード'}
            </button>
          </div>
        )}
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
  
  if (!isInitialized) {
    return null;
  }

  const mainContentVisible = activeTab === 'day1' || activeTab === 'day2';
  
  const handleZoomChange = (newZoom: number) => {
    setZoomLevel(Math.max(50, Math.min(150, newZoom)));
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
            </div>
            {activeEventName && <h2 className="text-sm text-blue-600 dark:text-blue-400 font-semibold mt-1">{activeEventName}</h2>}
          </div>
          {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'execute' && (
                <div className="flex items-center gap-4">
                    {selectedItemIds.size > 0 && (
                        <BulkActionControls
                            onSort={handleBulkSort}
                            onClear={handleClearSelection}
                        />
                    )}
                    <button
                        onClick={handleSortToggle}
                        className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-200 text-blue-600 bg-blue-100 hover:bg-blue-200 dark:text-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-900 flex-shrink-0"
                    >
                        {sortLabels[sortState]}
                    </button>
                </div>
            )}
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
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">右の候補リストからドラッグ&ドロップでアイテムを追加</p>
                  </div>
                  <ShoppingList
                    items={executeColumnItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={(dragId, hoverId) => handleMoveItem(dragId, hoverId, 'execute')}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onRemoveFromColumn={handleRemoveFromExecuteColumn}
                    columnType="execute"
                  />
                </div>
                
                {/* 右列: 候補リスト */}
                <div className="space-y-2">
                  <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">候補リスト</h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mb-1">左列にドラッグして配置</p>
                    {selectedItemIds.size > 0 && (
                      <button
                        onClick={() => handleMoveToExecuteColumn(Array.from(selectedItemIds))}
                        className="mt-2 w-full px-3 py-1.5 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                      >
                        選択したアイテムを左列に移動 ({selectedItemIds.size}件)
                      </button>
                    )}
                  </div>
                  <ShoppingList
                    items={candidateColumnItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={(dragId, hoverId) => handleMoveItem(dragId, hoverId, 'candidate')}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    onMoveToColumn={handleMoveToExecuteColumn}
                    columnType="candidate"
                  />
                </div>
              </div>
            ) : (
              <ShoppingList
                items={visibleItems}
                onUpdateItem={handleUpdateItem}
                onMoveItem={(dragId, hoverId) => handleMoveItem(dragId, hoverId, 'execute')}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds}
                onSelectItem={handleSelectItem}
                columnType="execute"
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

      {activeEventName && items.length > 0 && mainContentVisible && currentMode === 'execute' && (
        <>
          <SummaryBar items={visibleItems} />
          <ZoomControl zoomLevel={zoomLevel} onZoomChange={handleZoomChange} />
        </>
      )}
    </div>
  );
};

export default App;
