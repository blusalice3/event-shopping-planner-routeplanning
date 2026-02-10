import { useState, useCallback } from 'react';
import { ShoppingItem, PurchaseStatus, EventMetadata, ExecuteModeItems } from '../types';
import { getItemKey, getItemKeyWithoutTitle, insertItemSorted } from '../utils/itemComparison';

interface UseUpdateWorkflowParams {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setEventMetadata: React.Dispatch<React.SetStateAction<Record<string, EventMetadata>>>;
}

export function useUpdateWorkflow({
  eventLists, eventMetadata,
  setEventLists, setExecuteModeItems, setEventMetadata,
}: UseUpdateWorkflowParams) {

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

        const circle = cells[12]?.trim() || '';
        const eventDate = cells[13]?.trim() || '';
        const block = cells[14]?.trim() || '';
        const number = cells[15]?.trim() || '';
        
        if (!circle || !eventDate || !block || !number) {
          continue;
        }

        const title = cells[16]?.trim() || '';
        const priceStr = cells[17]?.trim() || '';
        const price = priceStr === '' ? null : (parseInt(priceStr.replace(/[^0-9]/g, ''), 10) || 0);
        const remarks = cells[22]?.trim() || '';
        const itemUrl = cells[24]?.trim() || '';
        const quantityStr = cells[26]?.trim() || '';
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
          ...(itemUrl ? { url: itemUrl } : {}),
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
      
      eventDateGroups.forEach((groupItems) => {
        const circleGroups = new Map<string, Omit<ShoppingItem, 'id' | 'purchaseStatus'>[]>();
        groupItems.forEach(item => {
          if (!circleGroups.has(item.circle)) {
            circleGroups.set(item.circle, []);
          }
          circleGroups.get(item.circle)!.push(item);
        });
        
        circleGroups.forEach((circleItems) => {
          if (circleItems.length >= 2) {
            const itemWithUrl = circleItems.find(item => item.url && item.url.trim() !== '');
            
            if (itemWithUrl && itemWithUrl.url) {
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
      
      const currentItemsMapWithAll = new Map(currentItems.map(item => [getItemKey(item), item]));
      const sheetItemsMapWithoutTitle = new Map(sheetItems.map(item => [getItemKeyWithoutTitle(item), item]));
      const currentItemsMapWithoutTitle = new Map(currentItems.map(item => [getItemKeyWithoutTitle(item), item]));

      const itemsToDelete: ShoppingItem[] = [];
      const itemsToUpdate: ShoppingItem[] = [];
      const itemsToAdd: Omit<ShoppingItem, 'id' | 'purchaseStatus'>[] = [];
      let protectedFromDelete = 0;
      let protectedFromUpdate = 0;

      const getEffectiveProtectionLevel = (item: ShoppingItem): 'full' | 'deletable' | 'none' => {
        if (item.protectionLevel) return item.protectionLevel;
        return item.source === 'app' ? 'full' : 'none';
      };

      currentItems.forEach(item => {
        const keyWithoutTitle = getItemKeyWithoutTitle(item);
        if (!sheetItemsMapWithoutTitle.has(keyWithoutTitle)) {
          const protectionLevel = getEffectiveProtectionLevel(item);
          if (protectionLevel !== 'full') {
            itemsToDelete.push(item);
          } else {
            protectedFromDelete++;
          }
        }
      });

      sheetItems.forEach(sheetItem => {
        const keyWithAll = getItemKey(sheetItem);
        const keyWithoutTitle = getItemKeyWithoutTitle(sheetItem);
        
        const existingWithAll = currentItemsMapWithAll.get(keyWithAll);
        if (existingWithAll) {
          const protectionLevel = getEffectiveProtectionLevel(existingWithAll);
          if (protectionLevel === 'full' || protectionLevel === 'deletable') {
            if (
              existingWithAll.price !== sheetItem.price ||
              existingWithAll.remarks !== sheetItem.remarks ||
              existingWithAll.url !== sheetItem.url
            ) {
              protectedFromUpdate++;
            }
            return;
          }
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
        
        const existingWithoutTitle = currentItemsMapWithoutTitle.get(keyWithoutTitle);
        if (existingWithoutTitle) {
          const protectionLevel = getEffectiveProtectionLevel(existingWithoutTitle);
          if (protectionLevel === 'full' || protectionLevel === 'deletable') {
            protectedFromUpdate++;
            return;
          }
          itemsToUpdate.push({
            ...existingWithoutTitle,
            title: sheetItem.title,
            price: sheetItem.price,
            remarks: sheetItem.remarks,
            url: sheetItem.url
          });
          return;
        }
        
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

  const handleConfirmUpdate = useCallback(() => {
    if (!updateData || !updateEventName) return;

    const { itemsToDelete, itemsToUpdate, itemsToAdd } = updateData;
    const eventName = updateEventName;
    
    setEventLists(prev => {
      let newItems: ShoppingItem[] = [...(prev[eventName] || [])];
      
      const deleteIds = new Set(itemsToDelete.map(item => item.id));
      newItems = newItems.filter(item => !deleteIds.has(item.id));
      
      const updateMap = new Map(itemsToUpdate.map(item => [item.id, item]));
      newItems = newItems.map(item => updateMap.get(item.id) || item);
      
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
          source: 'spreadsheet' as const,
          protectionLevel: 'none' as const,
          ...(itemData.url ? { url: itemData.url } : {}),
        };
        newItems = insertItemSorted(newItems, newItem);
      });
      
      return { ...prev, [eventName]: newItems };
    });

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
        [eventName]: updatedEventItems,
      };
    });

    setShowUpdateConfirmation(false);
    setUpdateData(null);
    setUpdateEventName(null);
    alert('アイテムを更新しました。');
  }, [updateData, updateEventName, setEventLists, setExecuteModeItems]);

  const handleUrlUpdate = useCallback((newUrl: string, sheetName: string) => {
    setShowUrlUpdateDialog(false);
    if (pendingUpdateEventName) {
      handleUpdateEvent(pendingUpdateEventName, { url: newUrl, sheetName });
      setPendingUpdateEventName(null);
    }
  }, [pendingUpdateEventName, handleUpdateEvent]);

  return {
    showUpdateConfirmation, setShowUpdateConfirmation,
    updateData, setUpdateData,
    updateEventName, setUpdateEventName,
    showUrlUpdateDialog, setShowUrlUpdateDialog,
    pendingUpdateEventName, setPendingUpdateEventName,
    handleUpdateEvent,
    handleConfirmUpdate,
    handleUrlUpdate,
  };
}
