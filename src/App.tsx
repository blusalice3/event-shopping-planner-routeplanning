import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ViewMode, DayModeState, ExecuteModeItems } from '../src/types';
import ImportScreen from '../src/components/ImportScreen';
import ShoppingList from './ShoppingList';
import SummaryBar from '../src/components/SummaryBar';
import EventListScreen from '../src/components/EventListScreen';
import DeleteConfirmationModal from '../src/components/DeleteConfirmationModal';
import ZoomControl from '../src/components/ZoomControl';
import BulkActionControls from '../src/components/BulkActionControls';
import UpdateConfirmationModal from '../src/components/UpdateConfirmationModal';
import UrlUpdateDialog from '../src/components/UrlUpdateDialog';
import EventRenameDialog from '../src/components/EventRenameDialog';
import SortAscendingIcon from '../src/components/icons/SortAscendingIcon';
import SortDescendingIcon from '../src/components/icons/SortDescendingIcon';
import { getItemKey, getItemKeyWithoutTitle, insertItemSorted } from '../src/utils/itemComparison';

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
    } finally {
      setIsInitialized(true);
    }
  }, []);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('eventShoppingLists', JSON.stringify(eventLists));
    } catch (error) {
      console.error("Failed to save eventLists to localStorage", error);
    }
  }, [eventLists, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('eventMetadata', JSON.stringify(eventMetadata));
    } catch (error) {
      console.error("Failed to save eventMetadata to localStorage", error);
    }
  }, [eventMetadata, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('executeModeItems', JSON.stringify(executeModeItems));
    } catch (error) {
      console.error("Failed to save executeModeItems to localStorage", error);
    }
  }, [executeModeItems, isInitialized]);

  useEffect(() => {
    if (!isInitialized) return;
    try {
      localStorage.setItem('dayModes', JSON.stringify(dayModes));
    } catch (error) {
      console.error("Failed to save dayModes to localStorage", error);
    }
  }, [dayModes, isInitialized]);

  // イベントリストの更新処理
  const handleUpdateLists = useCallback((newLists: Record<string, ShoppingItem[]>) => {
    setEventLists(newLists);
  }, []);

  const handleUpdateMetadata = useCallback((newMetadata: Record<string, EventMetadata>) => {
    setEventMetadata(newMetadata);
  }, []);

  const handleSelectEvent = useCallback((eventName: string) => {
    setActiveEventName(eventName);
    setActiveTab(extractEventDates(eventLists[eventName] || [])[0] || 'eventList');
    setSelectedItemIds(new Set());
    setSelectedBlockFilters(new Set());
  }, [eventLists]);

  const handleCreateEvent = useCallback((eventName: string, items: ShoppingItem[]) => {
    setEventLists(prev => ({
      ...prev,
      [eventName]: items
    }));
    setEventMetadata(prev => ({
      ...prev,
      [eventName]: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        url: ''
      }
    }));
    setExecuteModeItems(prev => ({
      ...prev,
      [eventName]: {}
    }));
    setDayModes(prev => ({
      ...prev,
      [eventName]: {}
    }));
    setActiveEventName(eventName);
    setActiveTab(extractEventDates(items)[0] || 'eventList');
  }, []);

  const handleDeleteEvent = useCallback((eventName: string) => {
    setEventLists(prev => {
      const newLists = { ...prev };
      delete newLists[eventName];
      return newLists;
    });
    setEventMetadata(prev => {
      const newMetadata = { ...prev };
      delete newMetadata[eventName];
      return newMetadata;
    });
    setExecuteModeItems(prev => {
      const newItems = { ...prev };
      delete newItems[eventName];
      return newItems;
    });
    setDayModes(prev => {
      const newModes = { ...prev };
      delete newModes[eventName];
      return newModes;
    });
    if (activeEventName === eventName) {
      setActiveEventName(null);
      setActiveTab('eventList');
    }
  }, [activeEventName]);

  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    if (!activeEventName) return;
    setEventLists(prev => {
      const updatedLists = { ...prev };
      if (updatedLists[activeEventName]) {
        updatedLists[activeEventName] = updatedLists[activeEventName].map(item =>
          item.id === updatedItem.id ? updatedItem : item
        );
      }
      return updatedLists;
    });
  }, [activeEventName]);

  // 改善されたドラッグアンドドロップ方式: insertIndexを受け取る
  const handleMoveItem = useCallback((dragId: string, insertIndex: number, targetColumn?: 'execute' | 'candidate') => {
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
        const dragIndex = dayItems.findIndex(id => id === dragId);
        
        if (dragIndex === -1) return prev;
        
        // 複数選択時
        if (selectedItemIds.has(dragId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          // insertIndexを考慮して調整（ドラッグ中のアイテムが前方にある場合は1つ減らす）
          let adjustedInsertIndex = insertIndex;
          if (dragIndex < insertIndex) {
            adjustedInsertIndex = insertIndex - selectedIds.length;
          }
          
          // 範囲チェック
          adjustedInsertIndex = Math.max(0, Math.min(adjustedInsertIndex, listWithoutSelection.length));
          listWithoutSelection.splice(adjustedInsertIndex, 0, ...selectedIds);
          
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection }
          };
        } else {
          // 単一アイテム
          const listWithoutDrag = dayItems.filter(id => id !== dragId);
          
          // insertIndexを考慮して調整（ドラッグ中のアイテムが前方にある場合は1つ減らす）
          let adjustedInsertIndex = insertIndex;
          if (dragIndex < insertIndex) {
            adjustedInsertIndex = insertIndex - 1;
          }
          
          // 範囲チェック
          adjustedInsertIndex = Math.max(0, Math.min(adjustedInsertIndex, listWithoutDrag.length));
          listWithoutDrag.splice(adjustedInsertIndex, 0, dragId);
          
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutDrag }
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
        
        const dragIndex = candidateItems.findIndex(item => item.id === dragId);
        if (dragIndex === -1) return prev;
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          
          // insertIndexを考慮して調整
          let adjustedInsertIndex = insertIndex;
          if (dragIndex < insertIndex) {
            adjustedInsertIndex = insertIndex - selectedBlock.length;
          }
          
          // 範囲チェック
          adjustedInsertIndex = Math.max(0, Math.min(adjustedInsertIndex, listWithoutSelection.length));
          listWithoutSelection.splice(adjustedInsertIndex, 0, ...selectedBlock);
          
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
          const listWithoutDrag = candidateItems.filter(item => item.id !== dragId);
          
          // insertIndexを考慮して調整
          let adjustedInsertIndex = insertIndex;
          if (dragIndex < insertIndex) {
            adjustedInsertIndex = insertIndex - 1;
          }
          
          // 範囲チェック
          adjustedInsertIndex = Math.max(0, Math.min(adjustedInsertIndex, listWithoutDrag.length));
          listWithoutDrag.splice(adjustedInsertIndex, 0, candidateItems[dragIndex]);
          
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
              return listWithoutDrag.shift() || item;
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
        
        if (dragIndex === -1) return prev;
        
        if (selectedItemIds.has(dragId)) {
          // 複数選択時
          const selectedBlock = newItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = newItems.filter(item => !selectedItemIds.has(item.id));
          
          // insertIndexを考慮して調整
          let adjustedInsertIndex = insertIndex;
          if (dragIndex < insertIndex) {
            adjustedInsertIndex = insertIndex - selectedBlock.length;
          }
          
          // 範囲チェック
          adjustedInsertIndex = Math.max(0, Math.min(adjustedInsertIndex, listWithoutSelection.length));
          listWithoutSelection.splice(adjustedInsertIndex, 0, ...selectedBlock);
          
          return { ...prev, [activeEventName]: listWithoutSelection };
        } else {
          // 単一アイテム
          const listWithoutDrag = newItems.filter(item => item.id !== dragId);
          
          // insertIndexを考慮して調整
          let adjustedInsertIndex = insertIndex;
          if (dragIndex < insertIndex) {
            adjustedInsertIndex = insertIndex - 1;
          }
          
          // 範囲チェック
          adjustedInsertIndex = Math.max(0, Math.min(adjustedInsertIndex, listWithoutDrag.length));
          listWithoutDrag.splice(adjustedInsertIndex, 0, newItems[dragIndex]);
          
          return { ...prev, [activeEventName]: listWithoutDrag };
        }
      });
    }
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates]);

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
        
        // 複数選択時は選択されたアイテムすべてを移動
        if (selectedItemIds.has(itemId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          // 選択されたアイテムの最初の位置を基準に移動
          const firstSelectedIndex = dayItems.findIndex(id => selectedItemIds.has(id));
          if (firstSelectedIndex > 0) {
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
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates]);

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
        
        // 複数選択時は選択されたアイテムすべてを移動
        if (selectedItemIds.has(itemId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          // 選択されたアイテムの中で最も後ろの位置を見つける
          let lastSelectedIndex = -1;
          for (let i = dayItems.length - 1; i >= 0; i--) {
            if (selectedItemIds.has(dayItems[i])) {
              lastSelectedIndex = i;
              break;
            }
          }
          
          // 選択されたアイテムが最後にない場合のみ移動
          if (lastSelectedIndex >= 0 && lastSelectedIndex < dayItems.length - 1) {
            // listWithoutSelectionでの対応する位置を見つける
            const targetIndexInListWithout = listWithoutSelection.findIndex((id) => {
              const originalIndex = dayItems.findIndex(originalId => originalId === id);
              return originalIndex > lastSelectedIndex;
            });
            
            if (targetIndexInListWithout >= 0) {
              listWithoutSelection.splice(targetIndexInListWithout, 0, ...selectedIds);
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
          for (let i = candidateItems.length - 1; i >= 0; i--) {
            if (selectedItemIds.has(candidateItems[i].id)) {
              lastSelectedIndex = i;
              break;
            }
          }
          
          // 選択されたアイテムが最後にない場合のみ移動
          if (lastSelectedIndex >= 0 && lastSelectedIndex < candidateItems.length - 1) {
            // listWithoutSelectionでの対応する位置を見つける
            const targetIndexInListWithout = listWithoutSelection.findIndex((item) => {
              const originalIndex = candidateItems.findIndex(originalItem => originalItem.id === item.id);
              return originalIndex > lastSelectedIndex;
            });
            
            if (targetIndexInListWithout >= 0) {
              listWithoutSelection.splice(targetIndexInListWithout, 0, ...selectedBlock);
              
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
          for (let i = newItems.length - 1; i >= 0; i--) {
            if (selectedItemIds.has(newItems[i].id)) {
              lastSelectedIndex = i;
              break;
            }
          }
          
          // 選択されたアイテムが最後にない場合のみ移動
          if (lastSelectedIndex >= 0 && lastSelectedIndex < newItems.length - 1) {
            // listWithoutSelectionでの対応する位置を見つける
            const targetIndexInListWithout = listWithoutSelection.findIndex((item) => {
              const originalIndex = newItems.findIndex(originalItem => originalItem.id === item.id);
              return originalIndex > lastSelectedIndex;
            });
            
            if (targetIndexInListWithout >= 0) {
              listWithoutSelection.splice(targetIndexInListWithout, 0, ...selectedBlock);
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
    
    setDayModes(prev => {
      const eventModes = prev[activeEventName] || {};
      const currentMode = eventModes[currentEventDate] || 'edit';
      const newMode = currentMode === 'edit' ? 'execute' : 'edit';
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventModes,
          [currentEventDate]: newMode
        }
      };
    });
  }, [activeEventName, activeTab, eventDates]);

  const handleEditRequest = useCallback((item: ShoppingItem) => {
    setItemToEdit(item);
  }, []);

  const handleDeleteRequest = useCallback((item: ShoppingItem) => {
    setItemToDelete(item);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!itemToDelete || !activeEventName) return;
    
    setEventLists(prev => {
      const updatedLists = { ...prev };
      if (updatedLists[activeEventName]) {
        updatedLists[activeEventName] = updatedLists[activeEventName].filter(item => item.id !== itemToDelete.id);
      }
      return updatedLists;
    });
    
    // 実行モード列からも削除
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const updatedEventItems = { ...eventItems };
      Object.keys(updatedEventItems).forEach(date => {
        updatedEventItems[date] = (updatedEventItems[date] || []).filter(id => id !== itemToDelete.id);
      });
      return {
        ...prev,
        [activeEventName]: updatedEventItems
      };
    });
    
    setItemToDelete(null);
  }, [itemToDelete, activeEventName]);

  const handleSaveItem = useCallback((updatedItem: ShoppingItem) => {
    if (!activeEventName) return;
    
    setEventLists(prev => {
      const updatedLists = { ...prev };
      if (updatedLists[activeEventName]) {
        updatedLists[activeEventName] = updatedLists[activeEventName].map(item =>
          item.id === updatedItem.id ? updatedItem : item
        );
      }
      return updatedLists;
    });
    
    setItemToEdit(null);
  }, [activeEventName]);

  const handleSelectItem = useCallback((itemId: string) => {
    setSelectedItemIds(prevIds => {
      const newIds = new Set(prevIds);
      if (newIds.has(itemId)) {
        newIds.delete(itemId);
      } else {
        newIds.add(itemId);
      }
      return newIds;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';
    
    if (mode === 'edit') {
      const allItems = eventLists[activeEventName] || [];
      const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      
      if (activeTab === 'eventList' || !eventDates.includes(activeTab)) {
        // イベントリスト画面または参加日タブ以外の場合、全アイテムを選択
        setSelectedItemIds(new Set(allItems.map(item => item.id)));
      } else {
        // 参加日タブの場合、その日のアイテムのみ選択
        const dayItems = allItems.filter(item => 
          item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id)
        );
        setSelectedItemIds(new Set(dayItems.map(item => item.id)));
      }
    } else {
      // 実行モードの場合
      const allItems = eventLists[activeEventName] || [];
      if (activeTab === 'eventList' || !eventDates.includes(activeTab)) {
        setSelectedItemIds(new Set(allItems.map(item => item.id)));
      } else {
        const dayItems = allItems.filter(item => item.eventDate.includes(currentEventDate));
        setSelectedItemIds(new Set(dayItems.map(item => item.id)));
      }
    }
  }, [activeEventName, activeTab, eventDates, eventLists, executeModeItems, dayModes]);

  const handleDeselectAll = useCallback(() => {
    setSelectedItemIds(new Set());
  }, []);

  const eventDates = useMemo(() => {
    if (!activeEventName) return [];
    return extractEventDates(eventLists[activeEventName] || []);
  }, [activeEventName, eventLists]);

  const currentMode = useMemo(() => {
    if (!activeEventName) return 'edit';
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    return dayModes[activeEventName]?.[currentEventDate] || 'edit';
  }, [activeEventName, activeTab, eventDates, dayModes]);

  const visibleItems = useMemo(() => {
    if (!activeEventName) return [];
    const allItems = eventLists[activeEventName] || [];
    
    if (activeTab === 'eventList' || !eventDates.includes(activeTab)) {
      return allItems;
    }
    
    return allItems.filter(item => item.eventDate.includes(activeTab));
  }, [activeEventName, activeTab, eventLists, eventDates]);

  const executeColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const allItems = eventLists[activeEventName] || [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
    const executeIdsSet = new Set(executeIds);
    
    return executeIds
      .map(id => allItems.find(item => item.id === id))
      .filter((item): item is ShoppingItem => item !== undefined);
  }, [activeEventName, activeTab, eventLists, executeModeItems, eventDates]);

  const candidateColumnItems = useMemo(() => {
    if (!activeEventName) return [];
    const allItems = eventLists[activeEventName] || [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    
    const candidateItems = allItems.filter(item => 
      item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id)
    );
    
    // ブロックフィルタを適用
    if (selectedBlockFilters.size > 0) {
      return candidateItems.filter(item => selectedBlockFilters.has(item.block));
    }
    
    return candidateItems;
  }, [activeEventName, activeTab, eventLists, executeModeItems, eventDates, selectedBlockFilters]);

  const availableBlocks = useMemo(() => {
    if (!activeEventName) return [];
    const allItems = eventLists[activeEventName] || [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    
    const candidateItems = allItems.filter(item => 
      item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id)
    );
    
    const blocks = new Set<string>();
    candidateItems.forEach(item => {
      blocks.add(item.block);
    });
    
    return Array.from(blocks).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB;
      }
      return a.localeCompare(b);
    });
  }, [activeEventName, activeTab, eventLists, executeModeItems, eventDates]);

  const blocksWithPriorityRemarks = useMemo(() => {
    if (!activeEventName) return new Set<string>();
    const allItems = eventLists[activeEventName] || [];
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    
    const candidateItems = allItems.filter(item => 
      item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id)
    );
    
    const blocks = new Set<string>();
    candidateItems.forEach(item => {
      if (item.remarks && (item.remarks.includes('優先') || item.remarks.includes('委託無'))) {
        blocks.add(item.block);
      }
    });
    
    return blocks;
  }, [activeEventName, activeTab, eventLists, executeModeItems, eventDates]);

  const handleToggleBlockFilter = useCallback((block: string) => {
    setSelectedBlockFilters(prev => {
      const newFilters = new Set(prev);
      if (newFilters.has(block)) {
        newFilters.delete(block);
      } else {
        newFilters.add(block);
      }
      return newFilters;
    });
  }, []);

  const handleClearBlockFilters = useCallback(() => {
    setSelectedBlockFilters(new Set());
  }, []);

  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<'asc' | 'desc' | null>(null);

  const handleCandidateNumberSort = useCallback(() => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    
    setEventLists(prev => {
      const allItems = [...(prev[activeEventName] || [])];
      const candidateItems = allItems.filter(item => 
        item.eventDate.includes(currentEventDate) && !executeIdsSet.has(item.id)
      );
      const executeItems = allItems.filter(item => 
        item.eventDate.includes(currentEventDate) && executeIdsSet.has(item.id)
      );
      
      const newDirection = candidateNumberSortDirection === 'asc' ? 'desc' : 'asc';
      setCandidateNumberSortDirection(newDirection);
      
      const sortedCandidates = [...candidateItems].sort((a, b) => {
        const numA = parseInt(a.number, 10);
        const numB = parseInt(b.number, 10);
        if (isNaN(numA) || isNaN(numB)) {
          return a.number.localeCompare(b.number);
        }
        return newDirection === 'asc' ? numA - numB : numB - numA;
      });
      
      const newItems = allItems.map(item => {
        if (!item.eventDate.includes(currentEventDate)) {
          return item;
        }
        if (executeIdsSet.has(item.id)) {
          return executeItems.shift() || item;
        } else {
          return sortedCandidates.shift() || item;
        }
      });
      
      return { ...prev, [activeEventName]: newItems };
    });
  }, [activeEventName, activeTab, eventDates, executeModeItems, candidateNumberSortDirection]);

  const handleRenameEvent = useCallback((oldName: string, newName: string) => {
    if (oldName === newName) return;
    
    setEventLists(prev => {
      const newLists = { ...prev };
      if (newLists[oldName]) {
        newLists[newName] = newLists[oldName];
        delete newLists[oldName];
      }
      return newLists;
    });
    
    setEventMetadata(prev => {
      const newMetadata = { ...prev };
      if (newMetadata[oldName]) {
        newMetadata[newName] = { ...newMetadata[oldName] };
        delete newMetadata[oldName];
      }
      return newMetadata;
    });
    
    setExecuteModeItems(prev => {
      const newItems = { ...prev };
      if (newItems[oldName]) {
        newItems[newName] = newItems[oldName];
        delete newItems[oldName];
      }
      return newItems;
    });
    
    setDayModes(prev => {
      const newModes = { ...prev };
      if (newModes[oldName]) {
        newModes[newName] = newModes[oldName];
        delete newModes[oldName];
      }
      return newModes;
    });
    
    if (activeEventName === oldName) {
      setActiveEventName(newName);
    }
  }, [activeEventName]);

  const mainContentVisible = activeEventName !== null && activeTab !== 'eventList' && activeTab !== 'import';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="bg-white dark:bg-slate-800 shadow-sm border-b border-slate-200 dark:border-slate-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">イベント買い物リスト</h1>
            <div className="flex items-center gap-4">
              {activeEventName && mainContentVisible && (
                <>
                  <ZoomControl zoomLevel={zoomLevel} onZoomChange={setZoomLevel} />
                  <BulkActionControls
                    selectedItemIds={selectedItemIds}
                    onSelectAll={handleSelectAll}
                    onDeselectAll={handleDeselectAll}
                    onMoveToExecuteColumn={handleMoveToExecuteColumn}
                    onRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
                    currentMode={currentMode}
                    onToggleMode={handleToggleMode}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === 'eventList' ? (
          <EventListScreen
            eventLists={eventLists}
            eventMetadata={eventMetadata}
            onSelectEvent={handleSelectEvent}
            onCreateEvent={handleCreateEvent}
            onDeleteEvent={handleDeleteEvent}
            onUpdateLists={handleUpdateLists}
            onUpdateMetadata={handleUpdateMetadata}
            activeEventName={activeEventName}
            onRenameEvent={handleRenameEvent}
          />
        ) : activeTab === 'import' ? (
          <ImportScreen
            onImport={(items, eventName) => {
              handleCreateEvent(eventName, items);
              setActiveTab(extractEventDates(items)[0] || 'eventList');
            }}
            existingEventNames={Object.keys(eventLists)}
          />
        ) : (
          activeEventName && (
            <>
              <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">{activeEventName}</h2>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setActiveTab('eventList')}
                      className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                      イベント一覧に戻る
                    </button>
                    <button
                      onClick={() => setShowRenameDialog(true)}
                      className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                    >
                      イベント名を変更
                    </button>
                  </div>
                </div>

                <div className="flex space-x-1 border-b border-slate-200 dark:border-slate-700 mb-4 overflow-x-auto">
                  <button
                    onClick={() => setActiveTab('import')}
                    className={`px-4 py-2 text-sm font-medium whitespace-nowrap ${
                      activeTab === 'import'
                        ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    インポート
                  </button>
                  {eventDates.map((date, index) => (
                    <button
                      key={date}
                      onClick={() => setActiveTab(date)}
                      className={`px-4 py-2 text-sm font-medium whitespace-nowrap ${
                        activeTab === date
                          ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      {date} ({visibleItems.filter(item => item.eventDate.includes(date)).length})
                    </button>
                  ))}
                </div>

                {currentMode === 'execute' && (
                  <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border-2 border-yellow-300 dark:border-yellow-700 rounded-lg">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-semibold text-yellow-900 dark:text-yellow-100 mb-1">実行モード</h3>
                        <p className="text-xs text-yellow-700 dark:text-yellow-300">アイテムの順序を変更できます</p>
                      </div>
                      <button
                        onClick={handleToggleMode}
                        className="px-4 py-2 text-sm font-medium text-yellow-900 dark:text-yellow-100 bg-yellow-200 dark:bg-yellow-800 border border-yellow-300 dark:border-yellow-600 rounded-md hover:bg-yellow-300 dark:hover:bg-yellow-700 transition-colors"
                      >
                        編集モードに戻る
                      </button>
                    </div>
                  </div>
                )}

                <SummaryBar
                  items={visibleItems}
                  currentMode={currentMode}
                  onToggleMode={handleToggleMode}
                />
              </div>

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
                        onMoveItem={(dragId: string, insertIndex: number, targetColumn?: 'execute' | 'candidate') => handleMoveItem(dragId, insertIndex, targetColumn)}
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
                        onMoveItem={(dragId: string, insertIndex: number, targetColumn?: 'execute' | 'candidate') => handleMoveItem(dragId, insertIndex, targetColumn)}
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
                      />
                    </div>
                  </div>
                ) : (
                  <ShoppingList
                    items={visibleItems}
                    onUpdateItem={handleUpdateItem}
                    onMoveItem={(dragId: string, insertIndex: number, targetColumn?: 'execute' | 'candidate') => handleMoveItem(dragId, insertIndex, targetColumn)}
                    onEditRequest={handleEditRequest}
                    onDeleteRequest={handleDeleteRequest}
                    selectedItemIds={selectedItemIds}
                    onSelectItem={handleSelectItem}
                    columnType="execute"
                    currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
                    onMoveItemUp={handleMoveItemUp}
                    onMoveItemDown={handleMoveItemDown}
                  />
                )}
              </div>
            </>
          )
        )}
      </main>
      
      {itemToDelete && (
          <DeleteConfirmationModal
              item={itemToDelete}
              onConfirm={handleConfirmDelete}
              onCancel={() => setItemToDelete(null)}
          />
      )}

      {showUpdateConfirmation && updateData &&
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
      }

      {showUrlUpdateDialog && pendingUpdateEventName && (
          <UrlUpdateDialog
              eventName={pendingUpdateEventName}
              currentUrl={eventMetadata[pendingUpdateEventName]?.url || ''}
              onConfirm={(url) => {
                  setEventMetadata(prev => ({
                      ...prev,
                      [pendingUpdateEventName]: {
                          ...prev[pendingUpdateEventName],
                          url: url,
                          updatedAt: new Date().toISOString()
                      }
                  }));
                  setShowUrlUpdateDialog(false);
                  setPendingUpdateEventName(null);
              }}
              onCancel={() => {
                  setShowUrlUpdateDialog(false);
                  setPendingUpdateEventName(null);
              }}
          />
      )}

      {showRenameDialog && activeEventName && (
          <EventRenameDialog
              currentName={activeEventName}
              onConfirm={(newName) => {
                  handleRenameEvent(activeEventName, newName);
                  setShowRenameDialog(false);
              }}
              onCancel={() => setShowRenameDialog(false)}
              existingEventNames={Object.keys(eventLists).filter(name => name !== activeEventName)}
          />
      )}

      {itemToEdit && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
              <div className="bg-white dark:bg-slate-800 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
                  <h2 className="text-xl font-bold mb-4 text-slate-900 dark:text-slate-100">アイテムを編集</h2>
                  <form onSubmit={(e) => {
                      e.preventDefault();
                      handleSaveItem(itemToEdit);
                  }}>
                      <div className="space-y-4">
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">サークル名</label>
                              <input
                                  type="text"
                                  value={itemToEdit.circle}
                                  onChange={(e) => setItemToEdit({ ...itemToEdit, circle: e.target.value })}
                                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                                  required
                              />
                          </div>
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">タイトル</label>
                              <input
                                  type="text"
                                  value={itemToEdit.title}
                                  onChange={(e) => setItemToEdit({ ...itemToEdit, title: e.target.value })}
                                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                              />
                          </div>
                          <div className="grid grid-cols-2 gap-4">
                              <div>
                                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">ブロック</label>
                                  <input
                                      type="text"
                                      value={itemToEdit.block}
                                      onChange={(e) => setItemToEdit({ ...itemToEdit, block: e.target.value })}
                                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                                      required
                                  />
                              </div>
                              <div>
                                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">ナンバー</label>
                                  <input
                                      type="text"
                                      value={itemToEdit.number}
                                      onChange={(e) => setItemToEdit({ ...itemToEdit, number: e.target.value })}
                                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                                      required
                                  />
                              </div>
                          </div>
                          <div>
                              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">参加日</label>
                              <input
                                  type="text"
                                  value={itemToEdit.eventDate}
                                  onChange={(e) => setItemToEdit({ ...itemToEdit, eventDate: e.target.value })}
                                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                                  required
                              />
                          </div>
                      </div>
                      <div className="mt-6 flex justify-end gap-3">
                          <button
                              type="button"
                              onClick={() => setItemToEdit(null)}
                              className="px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded-md hover:bg-slate-50 dark:hover:bg-slate-600 transition-colors"
                          >
                              キャンセル
                          </button>
                          <button
                              type="submit"
                              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
                          >
                              保存
                          </button>
                      </div>
                  </form>
              </div>
          </div>
      )}
    </div>
  );
};

export default App;

