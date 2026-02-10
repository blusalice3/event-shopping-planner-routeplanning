import { useCallback } from 'react';
import { ShoppingItem, ExecuteModeItems, DayModeState, ViewMode } from '../types';

interface ItemMovementDeps {
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  dayModes: Record<string, DayModeState>;
  executeModeItems: Record<string, ExecuteModeItems>;
  items: ShoppingItem[];
  selectedItemIds: Set<string>;
  selectedBlockFilters: Set<string>;
  rangeStart: { itemId: string; columnType: 'execute' | 'candidate' } | null;
  rangeEnd: { itemId: string; columnType: 'execute' | 'candidate' } | null;
  areItemsInSameHall: (itemId1: string, itemId2: string, eventDate: string) => boolean;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setSelectedItemIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setRangeStart: React.Dispatch<React.SetStateAction<{ itemId: string; columnType: 'execute' | 'candidate' } | null>>;
  setRangeEnd: React.Dispatch<React.SetStateAction<{ itemId: string; columnType: 'execute' | 'candidate' } | null>>;
  resetSort: () => void;
}

export function useItemMovement(deps: ItemMovementDeps) {
  const {
    activeEventName, activeTab, eventDates, dayModes, executeModeItems, items,
    selectedItemIds, selectedBlockFilters, rangeStart, rangeEnd,
    areItemsInSameHall,
    setEventLists, setExecuteModeItems, setSelectedItemIds, setRangeStart, setRangeEnd,
    resetSort,
  } = deps;

  const handleMoveItem = useCallback((dragId: string, hoverId: string, targetColumn?: 'execute' | 'candidate', sourceColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    resetSort();
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    // リスト末尾への追加判定
    const isAppendToEnd = hoverId === '__END_OF_LIST__';

    // 列間移動の処理（編集モードのみ）
    if (mode === 'edit' && sourceColumn && targetColumn && sourceColumn !== targetColumn) {
      const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      
      if (sourceColumn === 'candidate' && targetColumn === 'execute') {
        // 候補リスト → 実行列への移動
        const currentTabItemsForMove = items.filter(item => item.eventDate === activeTab);
        let candidateItems = currentTabItemsForMove.filter(item => !executeIdsSet.has(item.id));
        
        if (selectedBlockFilters.size > 0) {
          candidateItems = candidateItems.filter(item => selectedBlockFilters.has(item.block));
        }
        
        let itemsToMove: ShoppingItem[] = [];
        if (selectedItemIds.has(dragId)) {
          itemsToMove = candidateItems.filter(item => selectedItemIds.has(item.id));
        } else {
          const item = candidateItems.find(item => item.id === dragId);
          if (item) itemsToMove = [item];
        }
        
        if (itemsToMove.length === 0) return;
        
        const itemIdsToMove = itemsToMove.map(item => item.id);
        
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
          
          let moveItems: ShoppingItem[] = [];
          if (selectedItemIds.has(dragId)) {
            moveItems = executeItems.filter(item => selectedItemIds.has(item.id));
          } else {
            const item = executeItems.find(item => item.id === dragId);
            if (item) moveItems = [item];
          }
          
          if (moveItems.length === 0) return prev;
          
          const itemIdsToMove = moveItems.map(item => item.id);
          
          setExecuteModeItems(prevExecute => {
            const eventItems = prevExecute[activeEventName] || {};
            const dayItems = (eventItems[currentEventDate] || []).filter(id => !itemIdsToMove.includes(id));
            return {
              ...prevExecute,
              [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
            };
          });
          
          let newCandidateList: ShoppingItem[] = [];
          if (isAppendToEnd) {
            newCandidateList = [...candidateItems, ...moveItems];
          } else {
            const hoverIndex = candidateItems.findIndex(item => item.id === hoverId);
            if (hoverIndex === -1) {
              newCandidateList = [...candidateItems, ...moveItems];
            } else {
              const listWithoutMoved = candidateItems.filter(item => !itemIdsToMove.includes(item.id));
              listWithoutMoved.splice(hoverIndex, 0, ...moveItems);
              newCandidateList = listWithoutMoved;
            }
          }
          
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
          const dragIndex = dayItems.findIndex(id => id === dragId);
          if (dragIndex === -1) return prev;

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
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, selectedBlockFilters, items, resetSort, setEventLists, setExecuteModeItems]);

  const handleMoveItemUp = useCallback((itemId: string, targetColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    resetSort();
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'edit' && targetColumn === 'execute') {
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[currentEventDate] || [])];
        const currentIndex = dayItems.findIndex(id => id === itemId);
        
        if (currentIndex <= 0) return prev;

        const targetId = dayItems[currentIndex - 1];
        if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
          return prev;
        }
        
        if (selectedItemIds.has(itemId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          const firstSelectedIndex = dayItems.findIndex(id => selectedItemIds.has(id));
          if (firstSelectedIndex > 0) {
            const targetIdForGroup = dayItems[firstSelectedIndex - 1];
            if (!areItemsInSameHall(selectedIds[0], targetIdForGroup, currentEventDate)) {
              return prev;
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
          [dayItems[currentIndex - 1], dayItems[currentIndex]] = [dayItems[currentIndex], dayItems[currentIndex - 1]];
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
          };
        }
      });
    } else if (mode === 'edit' && targetColumn === 'candidate') {
      setEventLists(prev => {
        const allItems = [...(prev[activeEventName] || [])];
        const currentTabKey = currentEventDate;
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        
        const candidateItems = allItems.filter(item => 
          item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id)
        );
        
        const currentIndex = candidateItems.findIndex(item => item.id === itemId);
        if (currentIndex <= 0) return prev;
        
        if (selectedItemIds.has(itemId)) {
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          const firstSelectedIndex = candidateItems.findIndex(item => selectedItemIds.has(item.id));
          
          if (firstSelectedIndex > 0) {
            const newTargetIndex = firstSelectedIndex - 1;
            listWithoutSelection.splice(newTargetIndex, 0, ...selectedBlock);
            
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
          [candidateItems[currentIndex - 1], candidateItems[currentIndex]] = [candidateItems[currentIndex], candidateItems[currentIndex - 1]];
          
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
      setEventLists(prev => {
        const newItems = [...(prev[activeEventName] || [])];
        const currentIndex = newItems.findIndex(item => item.id === itemId);
        
        if (currentIndex <= 0) return prev;
        
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
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, areItemsInSameHall, resetSort, setEventLists, setExecuteModeItems]);

  const handleMoveItemDown = useCallback((itemId: string, targetColumn?: 'execute' | 'candidate') => {
    if (!activeEventName) return;
    resetSort();
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName]?.[currentEventDate] || 'edit';

    if (mode === 'edit' && targetColumn === 'execute') {
      setExecuteModeItems(prev => {
        const eventItems = prev[activeEventName] || {};
        const dayItems = [...(eventItems[currentEventDate] || [])];
        const currentIndex = dayItems.findIndex(id => id === itemId);
        
        if (currentIndex < 0 || currentIndex >= dayItems.length - 1) return prev;
        
        const targetId = dayItems[currentIndex + 1];
        if (!areItemsInSameHall(itemId, targetId, currentEventDate)) {
          return prev;
        }
        
        if (selectedItemIds.has(itemId)) {
          const selectedIds = dayItems.filter(id => selectedItemIds.has(id));
          const listWithoutSelection = dayItems.filter(id => !selectedItemIds.has(id));
          
          let lastSelectedIndex = -1;
          dayItems.forEach((id, index) => {
              if (selectedItemIds.has(id)) lastSelectedIndex = index;
          });
          
          if (lastSelectedIndex >= 0 && lastSelectedIndex < dayItems.length - 1) {
            const jumpOverItemId = dayItems[lastSelectedIndex + 1];
            
            if (!areItemsInSameHall(selectedIds[selectedIds.length - 1], jumpOverItemId, currentEventDate)) {
              return prev;
            }
            
            const targetIndexInListWithout = listWithoutSelection.findIndex(id => id === jumpOverItemId);
            
            if (targetIndexInListWithout !== -1) {
              listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedIds);
              return {
                ...prev,
                [activeEventName]: { ...eventItems, [currentEventDate]: listWithoutSelection }
              };
            }
          }
          return prev;
        } else {
          [dayItems[currentIndex], dayItems[currentIndex + 1]] = [dayItems[currentIndex + 1], dayItems[currentIndex]];
          return {
            ...prev,
            [activeEventName]: { ...eventItems, [currentEventDate]: dayItems }
          };
        }
      });
    } else if (mode === 'edit' && targetColumn === 'candidate') {
      setEventLists(prev => {
        const allItems = [...(prev[activeEventName] || [])];
        const currentTabKey = currentEventDate;
        const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        
        const candidateItems = allItems.filter(item => 
          item.eventDate.includes(currentTabKey) && !executeIdsSet.has(item.id)
        );
        
        const currentIndex = candidateItems.findIndex(item => item.id === itemId);
        if (currentIndex < 0 || currentIndex >= candidateItems.length - 1) return prev;
        
        if (selectedItemIds.has(itemId)) {
          const selectedBlock = candidateItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = candidateItems.filter(item => !selectedItemIds.has(item.id));
          
          let lastSelectedIndex = -1;
          candidateItems.forEach((item, index) => {
              if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
          });
          
          if (lastSelectedIndex >= 0 && lastSelectedIndex < candidateItems.length - 1) {
            const jumpOverItemId = candidateItems[lastSelectedIndex + 1].id;
            const targetIndexInListWithout = listWithoutSelection.findIndex(item => item.id === jumpOverItemId);
            
            if (targetIndexInListWithout !== -1) {
              listWithoutSelection.splice(targetIndexInListWithout + 1, 0, ...selectedBlock);
              
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
          [candidateItems[currentIndex], candidateItems[currentIndex + 1]] = [candidateItems[currentIndex + 1], candidateItems[currentIndex]];
          
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
      setEventLists(prev => {
        const newItems = [...(prev[activeEventName] || [])];
        const currentIndex = newItems.findIndex(item => item.id === itemId);
        
        if (currentIndex < 0 || currentIndex >= newItems.length - 1) return prev;
        
        if (selectedItemIds.has(itemId)) {
          const selectedBlock = newItems.filter(item => selectedItemIds.has(item.id));
          const listWithoutSelection = newItems.filter(item => !selectedItemIds.has(item.id));
          
          let lastSelectedIndex = -1;
          newItems.forEach((item, index) => {
             if (selectedItemIds.has(item.id)) lastSelectedIndex = index;
          });
          
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
  }, [activeEventName, selectedItemIds, activeTab, dayModes, executeModeItems, eventDates, areItemsInSameHall, resetSort, setEventLists, setExecuteModeItems]);

  const handleMoveToExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIdsSet = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    
    if (rangeStart && itemIds.includes(rangeStart.itemId) && rangeStart.columnType === 'candidate') {
      setRangeStart(null);
      setRangeEnd(null);
    } else if (rangeEnd && itemIds.includes(rangeEnd.itemId) && rangeEnd.columnType === 'candidate') {
      setRangeEnd(null);
    }
    
    const currentTabItemsForMove = items.filter(item => item.eventDate === currentEventDate);
    let candidateItems = currentTabItemsForMove.filter(item => !executeIdsSet.has(item.id));
    
    if (selectedBlockFilters.size > 0) {
      candidateItems = candidateItems.filter(item => selectedBlockFilters.has(item.block));
    }
    
    const itemIdsSet = new Set(itemIds);
    const itemsToMove = candidateItems.filter(item => itemIdsSet.has(item.id));
    const orderedItemIds = itemsToMove.map(item => item.id);
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const currentDayItems = [...(eventItems[currentEventDate] || [])];
      
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
  }, [activeEventName, activeTab, eventDates, rangeStart, rangeEnd, items, executeModeItems, selectedBlockFilters, setExecuteModeItems, setSelectedItemIds, setRangeStart, setRangeEnd]);

  const handleRemoveFromExecuteColumn = useCallback((itemIds: string[]) => {
    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
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
  }, [activeEventName, activeTab, eventDates, rangeStart, rangeEnd, setExecuteModeItems, setSelectedItemIds, setRangeStart, setRangeEnd]);

  return {
    handleMoveItem,
    handleMoveItemUp,
    handleMoveItemDown,
    handleMoveToExecuteColumn,
    handleRemoveFromExecuteColumn,
  };
}
