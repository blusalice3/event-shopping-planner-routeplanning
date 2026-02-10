import { useState, useCallback } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ViewMode, DayModeState, ExecuteModeItems, MapDataStore, RouteSettingsStore, HallDefinitionsStore, HallRouteSettingsStore } from '../types';
import { getItemKey } from '../utils/itemComparison';

// データから参加日を抽出する関数
export const extractEventDates = (items: ShoppingItem[]): string[] => {
  const eventDates = new Set<string>();
  items.forEach(item => {
    if (item.eventDate && item.eventDate.trim()) {
      eventDates.add(item.eventDate.trim());
    }
  });
  // 参加日をソート（数値部分でソート）
  return Array.from(eventDates).sort((a, b) => {
    const numA = parseInt(a.match(/\\d+/)?.[0] || '0', 10);
    const numB = parseInt(b.match(/\\d+/)?.[0] || '0', 10);
    if (numA !== numB) return numA - numB;
    return a.localeCompare(b, 'ja');
  });
};

interface UseEventManagementParams {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  activeEventName: string | null;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setEventMetadata: React.Dispatch<React.SetStateAction<Record<string, EventMetadata>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setDayModes: React.Dispatch<React.SetStateAction<Record<string, DayModeState>>>;
  setMapData: React.Dispatch<React.SetStateAction<MapDataStore>>;
  setRouteSettings: React.Dispatch<React.SetStateAction<RouteSettingsStore>>;
  setHallDefinitions: React.Dispatch<React.SetStateAction<HallDefinitionsStore>>;
  setHallRouteSettings: React.Dispatch<React.SetStateAction<HallRouteSettingsStore>>;
  setActiveEventName: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveTab: React.Dispatch<React.SetStateAction<string>>;
  setSelectedItemIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSelectedBlockFilters: React.Dispatch<React.SetStateAction<Set<string>>>;
  setItemToEdit: React.Dispatch<React.SetStateAction<ShoppingItem | null>>;
}

export function useEventManagement({
  eventLists, eventMetadata, activeEventName,
  setEventLists, setEventMetadata, setExecuteModeItems, setDayModes,
  setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings,
  setActiveEventName, setActiveTab, setSelectedItemIds, setSelectedBlockFilters,
  setItemToEdit,
}: UseEventManagementParams) {
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [eventToRename, setEventToRename] = useState<string | null>(null);

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

    setMapData(prev => {
      const newData = { ...prev };
      if (newData[eventToRename]) {
        newData[newName] = newData[eventToRename];
        delete newData[eventToRename];
      }
      return newData;
    });

    setRouteSettings(prev => {
      const newSettings = { ...prev };
      if (newSettings[eventToRename]) {
        newSettings[newName] = newSettings[eventToRename];
        delete newSettings[eventToRename];
      }
      return newSettings;
    });

    setHallDefinitions(prev => {
      const newDefs = { ...prev };
      if (newDefs[eventToRename]) {
        newDefs[newName] = newDefs[eventToRename];
        delete newDefs[eventToRename];
      }
      return newDefs;
    });

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
      const itemsMap = new Map<string, ShoppingItem>();
      newItems.forEach(item => {
        const key = getItemKey(item);
        itemsMap.set(key, item);
      });

      const eventDatesForLayout = extractEventDates(newItems);
      const newExecuteModeItems: ExecuteModeItems = {};
      const sortedItemsByDate: ShoppingItem[] = [];
      
      const layoutItemKeys = new Set(metadata.layoutInfo!.map(layout => layout.itemKey));
      const otherItems = newItems.filter(item => !layoutItemKeys.has(getItemKey(item)));
      
      const otherItemsByDate: Record<string, ShoppingItem[]> = {};
      otherItems.forEach(item => {
        if (!otherItemsByDate[item.eventDate]) {
          otherItemsByDate[item.eventDate] = [];
        }
        otherItemsByDate[item.eventDate].push(item);
      });
      
      eventDatesForLayout.forEach(eventDate => {
        const executeItemsForDate = metadata.layoutInfo!
          .filter(layout => layout.eventDate === eventDate && layout.columnType === 'execute')
          .sort((a, b) => a.order - b.order)
          .map(layout => itemsMap.get(layout.itemKey))
          .filter(Boolean) as ShoppingItem[];
        
        const candidateItemsForDate = metadata.layoutInfo!
          .filter(layout => layout.eventDate === eventDate && layout.columnType === 'candidate')
          .sort((a, b) => a.order - b.order)
          .map(layout => itemsMap.get(layout.itemKey))
          .filter(Boolean) as ShoppingItem[];
        
        newExecuteModeItems[eventDate] = executeItemsForDate.map(item => item.id);
        
        sortedItemsByDate.push(...executeItemsForDate, ...candidateItemsForDate, ...(otherItemsByDate[eventDate] || []));
      });
      
      const otherItemsWithoutDate = otherItems.filter(item => !eventDatesForLayout.includes(item.eventDate));
      sortedItemsByDate.push(...otherItemsWithoutDate);
      
      setEventLists(prevLists => {
        return {
          ...prevLists,
          [eventName]: sortedItemsByDate as ShoppingItem[]
        };
      });
      
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
      const newEventDates = extractEventDates(newItems);
      if (newEventDates.length > 0) {
        setActiveTab(newEventDates[0]);
      } else {
        const currentEventDates = extractEventDates(eventLists[eventName] || []);
        if (currentEventDates.length > 0) {
          setActiveTab(currentEventDates[0]);
        }
      }
    }
  }, [eventLists]);

  return {
    showRenameDialog, setShowRenameDialog,
    eventToRename, setEventToRename,
    handleSelectEvent,
    handleDeleteEvent,
    handleRenameEvent,
    handleConfirmRename,
    handleBulkAdd,
  };
}
