import { useState, useCallback } from 'react';
import { ShoppingItem, DayModeState, ExecuteModeItems } from '../types';

interface UseItemCrudParams {
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  dayModes: Record<string, DayModeState>;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setRecentlyChangedItemIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function useItemCrud({
  activeEventName, activeTab, eventDates, dayModes,
  setEventLists, setExecuteModeItems, setRecentlyChangedItemIds,
}: UseItemCrudParams) {
  const [itemToEdit, setItemToEdit] = useState<ShoppingItem | null>(null);
  const [itemToDelete, setItemToDelete] = useState<ShoppingItem | null>(null);

  const handleUpdateItem = useCallback((updatedItem: ShoppingItem) => {
    if (!activeEventName) return;
    
    setEventLists(prev => {
      const currentItem = prev[activeEventName]?.find(item => item.id === updatedItem.id);
      const purchaseStatusChanged = currentItem && currentItem.purchaseStatus !== updatedItem.purchaseStatus;
      const priceChanged = currentItem && currentItem.price !== updatedItem.price;
      
      if (purchaseStatusChanged) {
        setRecentlyChangedItemIds(prevIds => new Set(prevIds).add(updatedItem.id));
      }
      
      const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
      const currentMode = dayModes[activeEventName]?.[currentEventDate] || 'edit';
      let finalItem = updatedItem;
      
      if ((currentMode === 'execute' || currentMode === 'focus') && (purchaseStatusChanged || priceChanged)) {
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

  const handleEditRequest = useCallback((item: ShoppingItem) => {
    setItemToEdit(item);
  }, []);

  const handleDeleteRequest = useCallback((item: ShoppingItem) => {
    setItemToDelete(item);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (!itemToDelete || !activeEventName) return;
    
    const deletedId = itemToDelete.id;
    
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: prev[activeEventName].filter(item => item.id !== deletedId)
    }));
    
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
  }, [itemToDelete, activeEventName]);

  const handleDoneEditing = useCallback(() => {
    const editedItem = itemToEdit;
    setItemToEdit(null);
    // Return the eventDate so the caller can navigate
    return editedItem?.eventDate || null;
  }, [itemToEdit]);

  return {
    itemToEdit, setItemToEdit,
    itemToDelete, setItemToDelete,
    handleUpdateItem,
    handleEditRequest,
    handleDeleteRequest,
    handleConfirmDelete,
    handleDoneEditing,
  };
}
