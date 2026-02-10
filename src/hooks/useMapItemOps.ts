import { useCallback, useMemo } from 'react';
import { ShoppingItem, PurchaseStatus, ExecuteModeItems, MapDataStore, BlockDefinition, HallDefinition, HallRouteSettings, HallDefinitionsStore, HallRouteSettingsStore, DayMapData } from '../types';
import { isPointInPolygon } from '../components/map';

interface UseMapItemOpsParams {
  activeEventName: string | null;
  activeTab: string;
  isMapTab: boolean;
  items: ShoppingItem[];
  eventLists: Record<string, ShoppingItem[]>;
  executeModeItems: Record<string, ExecuteModeItems>;
  mapData: MapDataStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  currentMapData: DayMapData | null;
  currentHalls: HallDefinition[];
  currentHallRouteSettings: HallRouteSettings;
  visitListPanelMapTab: string | null;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  setMapData: React.Dispatch<React.SetStateAction<MapDataStore>>;
  setHallDefinitions: React.Dispatch<React.SetStateAction<HallDefinitionsStore>>;
  setHallRouteSettings: React.Dispatch<React.SetStateAction<HallRouteSettingsStore>>;
  setItemToEdit: React.Dispatch<React.SetStateAction<ShoppingItem | null>>;
  setNewItemDefaults: React.Dispatch<React.SetStateAction<{ eventDate: string; block: string; number: string } | null>>;
  setActiveTab: React.Dispatch<React.SetStateAction<string>>;
}

export function useMapItemOps({
  activeEventName, activeTab, isMapTab, items, eventLists,
  executeModeItems, mapData, hallDefinitions, hallRouteSettings,
  currentMapData, currentHalls, currentHallRouteSettings,
  visitListPanelMapTab,
  setEventLists, setExecuteModeItems, setMapData, setHallDefinitions, setHallRouteSettings,
  setItemToEdit, setNewItemDefaults, setActiveTab,
}: UseMapItemOpsParams) {

  // マップビューでの訪問先追加
  const handleAddToExecuteListFromMap = useCallback((itemId: string) => {
    if (!activeEventName || !isMapTab) return;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    
    const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
    const hallRouteSettingsForMap = hallRouteSettings[activeEventName]?.[activeTab] || { hallOrder: [], hallVisitLists: [] };
    
    const currentMapDataLocal = mapData[activeEventName]?.[activeTab];
    let itemHallId: string | null = null;
    
    if (currentMapDataLocal && halls.length > 0) {
      const itemBlockName = item.block?.trim() || '';
      const block = currentMapDataLocal.blocks.find(b => b.name === itemBlockName);
      
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
      
      if (dayItems.includes(itemId)) return prev;
      
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
      
      const hallOrder = hallRouteSettingsForMap.hallOrder.length > 0 
        ? hallRouteSettingsForMap.hallOrder 
        : halls.map(h => h.id);
      
      const itemsMap = new Map(items.map(i => [i.id, i]));
      const getHallIdForItem = (id: string): string | null => {
        const targetItem = itemsMap.get(id);
        if (!targetItem || !currentMapDataLocal) return null;
        
        const blockName = targetItem.block?.trim() || '';
        const targetBlock = currentMapDataLocal.blocks.find(b => b.name === blockName);
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
      
      let insertIndex = dayItems.length;
      const itemHallIndex = hallOrder.indexOf(itemHallId);
      
      if (itemHallIndex >= 0) {
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
          insertIndex = lastSameHallIndex + 1;
        } else if (firstLaterHallIndex >= 0) {
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

  // マップビューでの訪問先追加（位置指定あり）
  const handleAddToExecuteListFromMapAtPosition = useCallback((itemId: string, referenceItemId: string, position: 'before' | 'after') => {
    if (!activeEventName || !isMapTab) return;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      
      if (dayItems.includes(itemId)) return prev;
      
      const refIndex = dayItems.indexOf(referenceItemId);
      if (refIndex < 0) {
        dayItems.push(itemId);
      } else {
        const insertIdx = position === 'before' ? refIndex : refIndex + 1;
        dayItems.splice(insertIdx, 0, itemId);
      }
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [dayName]: dayItems,
        },
      };
    });
  }, [activeEventName, activeTab, isMapTab]);

  // マップビューでの訪問先削除
  const handleRemoveFromExecuteListFromMap = useCallback((itemId: string) => {
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
          [dayName]: dayItems,
        },
      };
    });
  }, [activeEventName, activeTab, isMapTab]);

  // マップビューからの新規アイテム追加
  const handleAddNewItemFromMap = useCallback((eventDate: string, block: string, number: string) => {
    setNewItemDefaults({ eventDate, block, number });
    setItemToEdit(null);
    setActiveTab('import');
  }, [setNewItemDefaults, setItemToEdit, setActiveTab]);

  // 集中モードからの直接アイテム追加
  const handleAddItemFromFocusMode = useCallback((newItem: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => {
    if (!activeEventName) return;
    
    const purchaseStatus = newItem.purchaseStatus || 'None';
    
    const item: ShoppingItem = {
      ...newItem,
      id: `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      purchaseStatus,
      source: 'app' as const,
      protectionLevel: 'full' as const,
    };
    
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: [...(prev[activeEventName] || []), item],
    }));
    
    if (purchaseStatus === 'Purchased') {
      return;
    }
    
    const dayName = newItem.eventDate;
    const mapTab = `${dayName}マップ`;
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      const allItems = eventLists[activeEventName] || [];
      const itemsMap = new Map(allItems.map(i => [i.id, i]));
      itemsMap.set(item.id, item);
      
      const currentMapDataLocal = mapData[activeEventName]?.[mapTab];
      const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
      const hallSettings = hallRouteSettings[activeEventName]?.[mapTab];
      
      const hallOrder = hallSettings?.hallOrder || halls.map(h => h.id);
      
      const getItemPosition = (id: string): { row: number; col: number } | null => {
        const targetItem = itemsMap.get(id);
        if (!targetItem || !currentMapDataLocal) return null;
        
        const blockName = targetItem.block?.trim() || '';
        const targetBlock = currentMapDataLocal.blocks.find(b => b.name === blockName);
        if (!targetBlock) return null;
        
        const numberCells = targetBlock.numberCells || [];
        const normalizedNumber = targetItem.number.toLowerCase();
        
        for (const nc of numberCells) {
          if (String(nc.value).toLowerCase() === normalizedNumber) {
            return { row: nc.row, col: nc.col };
          }
        }
        
        return {
          row: (targetBlock.startRow + targetBlock.endRow) / 2,
          col: (targetBlock.startCol + targetBlock.endCol) / 2,
        };
      };
      
      const calcDistance = (pos1: { row: number; col: number }, pos2: { row: number; col: number }): number => {
        return Math.abs(pos1.row - pos2.row) + Math.abs(pos1.col - pos2.col);
      };
      
      const phaseStatus = purchaseStatus;
      const samePhaseIndices: number[] = [];
      
      for (let i = 0; i < dayItems.length; i++) {
        const existingItem = itemsMap.get(dayItems[i]);
        if (existingItem && existingItem.purchaseStatus === phaseStatus) {
          samePhaseIndices.push(i);
        }
      }
      
      const newItemPos = getItemPosition(item.id);
      
      if (samePhaseIndices.length === 0 || !newItemPos) {
        dayItems.push(item.id);
      } else {
        let bestInsertIndex = samePhaseIndices[samePhaseIndices.length - 1] + 1;
        let minTotalDistance = Infinity;
        
        for (let insertIdx = 0; insertIdx <= samePhaseIndices.length; insertIdx++) {
          let totalDistance = 0;
          
          if (insertIdx > 0) {
            const prevItemId = dayItems[samePhaseIndices[insertIdx - 1]];
            const prevPos = getItemPosition(prevItemId);
            if (prevPos) {
              totalDistance += calcDistance(prevPos, newItemPos);
            }
          }
          
          if (insertIdx < samePhaseIndices.length) {
            const nextItemId = dayItems[samePhaseIndices[insertIdx]];
            const nextPos = getItemPosition(nextItemId);
            if (nextPos) {
              totalDistance += calcDistance(newItemPos, nextPos);
            }
            
            if (insertIdx > 0) {
              const prevItemId = dayItems[samePhaseIndices[insertIdx - 1]];
              const prevPos = getItemPosition(prevItemId);
              if (prevPos && nextPos) {
                totalDistance -= calcDistance(prevPos, nextPos);
              }
            }
          }
          
          if (totalDistance < minTotalDistance) {
            minTotalDistance = totalDistance;
            if (insertIdx === 0) {
              bestInsertIndex = samePhaseIndices[0];
            } else if (insertIdx === samePhaseIndices.length) {
              bestInsertIndex = samePhaseIndices[samePhaseIndices.length - 1] + 1;
            } else {
              bestInsertIndex = samePhaseIndices[insertIdx];
            }
          }
        }
        
        dayItems.splice(bestInsertIndex, 0, item.id);
      }
      
      return {
        ...prev,
        [activeEventName]: {
          ...eventItems,
          [dayName]: dayItems,
        },
      };
    });
  }, [activeEventName, eventLists, mapData, hallDefinitions, hallRouteSettings]);

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

  // アイテム優先度更新
  const handleUpdateItemPriority = useCallback((itemId: string, priorityLevel: 'none' | 'priority' | 'highest') => {
    if (!activeEventName || !visitListPanelMapTab) return;
    
    setEventLists(prev => ({
      ...prev,
      [activeEventName]: (prev[activeEventName] || []).map(item => 
        item.id === itemId ? { ...item, priorityLevel } : item
      )
    }));
    
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    
    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const mapDataForTab = mapData[activeEventName]?.[visitListPanelMapTab];
    
    let itemHallId: string | null = null;
    if (mapDataForTab) {
      const block = mapDataForTab.blocks.find(b => b.name === item.block);
      if (block) {
        const numMatch = item.number?.match(/\d+/);
        if (numMatch) {
          const num = parseInt(numMatch[0], 10);
          const cell = block.numberCells.find(nc => nc.value === num);
          if (cell) {
            for (const hall of halls) {
              const isInPoly = (row: number, col: number, vertices: { row: number; col: number }[]): boolean => {
                if (vertices.length < 3) return false;
                let inside = false;
                for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
                  const xi = vertices[i].col, yi = vertices[i].row;
                  const xj = vertices[j].col, yj = vertices[j].row;
                  if (((yi > row) !== (yj > row)) && (col < (xj - xi) * (row - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                  }
                }
                return inside;
              };
              
              if (isInPoly(cell.row, cell.col, hall.vertices)) {
                itemHallId = hall.id;
                break;
              }
              for (const vertex of hall.vertices) {
                if (vertex.row === cell.row && vertex.col === cell.col) {
                  itemHallId = hall.id;
                  break;
                }
              }
              if (itemHallId) break;
            }
          }
        }
      }
    }
    
    const buildGroupId = (hallId: string | null, priority: 'none' | 'priority' | 'highest'): string => {
      if (hallId === null) {
        if (priority === 'highest') return 'undefined:highest';
        if (priority === 'priority') return 'undefined:priority';
        return 'undefined';
      }
      if (priority === 'highest') return `${hallId}:highest`;
      if (priority === 'priority') return `${hallId}:priority`;
      return hallId;
    };
    
    const newGroupId = buildGroupId(itemHallId, priorityLevel);
    const oldPriority = item.priorityLevel || 'none';
    const oldGroupId = buildGroupId(itemHallId, oldPriority);
    const baseGroupId = buildGroupId(itemHallId, 'none');
    
    setHallRouteSettings(prev => {
      const currentSettings = prev[activeEventName]?.[visitListPanelMapTab] || { hallOrder: [], hallVisitLists: [] };
      let newHallOrder = [...currentSettings.hallOrder];
      
      if (!newHallOrder.includes(baseGroupId)) {
        newHallOrder.push(baseGroupId);
      }
      
      if (priorityLevel !== 'none' && !newHallOrder.includes(newGroupId)) {
        const priorityGroupId = buildGroupId(itemHallId, 'priority');
        
        let insertIndex = newHallOrder.length;
        
        if (priorityLevel === 'highest') {
          const priorityIndex = newHallOrder.indexOf(priorityGroupId);
          const baseIndex = newHallOrder.indexOf(baseGroupId);
          
          if (priorityIndex !== -1) {
            insertIndex = priorityIndex;
          } else if (baseIndex !== -1) {
            insertIndex = baseIndex;
          }
        } else if (priorityLevel === 'priority') {
          const baseIndex = newHallOrder.indexOf(baseGroupId);
          if (baseIndex !== -1) {
            insertIndex = baseIndex;
          }
        }
        
        newHallOrder.splice(insertIndex, 0, newGroupId);
      }
      
      if (oldPriority !== 'none' && oldGroupId !== newGroupId) {
        const otherItemsInOldGroup = items.filter(i => {
          if (i.id === itemId) return false;
          if ((i.priorityLevel || 'none') !== oldPriority) return false;
          
          if (!mapDataForTab) return false;
          const iBlock = mapDataForTab.blocks.find(b => b.name === i.block);
          if (!iBlock) return false;
          const iNumMatch = i.number?.match(/\d+/);
          if (!iNumMatch) return false;
          const iNum = parseInt(iNumMatch[0], 10);
          const iCell = iBlock.numberCells.find(nc => nc.value === iNum);
          if (!iCell) return false;
          
          let iHallId: string | null = null;
          for (const h of halls) {
            const inPoly = (() => {
              if (h.vertices.length < 3) return false;
              let inside = false;
              for (let ii = 0, j = h.vertices.length - 1; ii < h.vertices.length; j = ii++) {
                const xi = h.vertices[ii].col, yi = h.vertices[ii].row;
                const xj = h.vertices[j].col, yj = h.vertices[j].row;
                if (((yi > iCell.row) !== (yj > iCell.row)) && (iCell.col < (xj - xi) * (iCell.row - yi) / (yj - yi) + xi)) {
                  inside = !inside;
                }
              }
              return inside;
            })();
            
            if (inPoly) {
              iHallId = h.id;
              break;
            }
            for (const vertex of h.vertices) {
              if (vertex.row === iCell.row && vertex.col === iCell.col) {
                iHallId = h.id;
                break;
              }
            }
            if (iHallId) break;
          }
          
          return iHallId === itemHallId;
        });
        
        if (otherItemsInOldGroup.length === 0) {
          newHallOrder = newHallOrder.filter(id => id !== oldGroupId);
        }
      }
      
      return {
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [visitListPanelMapTab]: {
            ...currentSettings,
            hallOrder: newHallOrder,
          },
        },
      };
    });
  }, [activeEventName, visitListPanelMapTab, items, hallDefinitions, mapData]);

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
    
    const localMapData = mapData[activeEventName]?.[activeTab];
    const halls = hallDefinitions[activeEventName]?.[activeTab] || [];
    const localHallRouteSettings = hallRouteSettings[activeEventName]?.[activeTab] || { hallOrder: [], hallVisitLists: [] };
    
    if (!localMapData || halls.length === 0) return;
    
    setExecuteModeItems(prev => {
      const eventItems = prev[activeEventName] || {};
      const dayItems = [...(eventItems[dayName] || [])];
      
      if (dayItems.length === 0) return prev;
      
      const itemsMap = new Map(items.map(i => [i.id, i]));
      const getHallIdForItem = (itemId: string): string | null => {
        const targetItem = itemsMap.get(itemId);
        if (!targetItem || !localMapData) return null;
        
        const blockName = targetItem.block?.trim() || '';
        let block = localMapData.blocks.find(b => b.name === blockName);
        if (!block) {
          const candidates = localMapData.blocks.filter(b => 
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
      
      const itemsByHall = new Map<string | null, Set<string>>();
      dayItems.forEach(itemId => {
        const hallId = getHallIdForItem(itemId);
        if (!itemsByHall.has(hallId)) {
          itemsByHall.set(hallId, new Set());
        }
        itemsByHall.get(hallId)!.add(itemId);
      });
      
      const visitOrderMap = new Map<string, number>();
      localHallRouteSettings.hallVisitLists.forEach(list => {
        list.itemIds.forEach((itemId, index) => {
          visitOrderMap.set(itemId, index);
        });
      });
      
      const sortItemsInHall = (itemIds: Set<string>): string[] => {
        const itemsArray = Array.from(itemIds);
        return itemsArray.sort((a, b) => {
          const orderA = visitOrderMap.get(a);
          const orderB = visitOrderMap.get(b);
          
          if (orderA !== undefined && orderB !== undefined) {
            return orderA - orderB;
          }
          if (orderA !== undefined) return -1;
          if (orderB !== undefined) return 1;
          return dayItems.indexOf(a) - dayItems.indexOf(b);
        });
      };
      
      const reorderedItems: string[] = [];
      
      hallOrder.forEach(hallId => {
        const hallItems = itemsByHall.get(hallId);
        if (hallItems && hallItems.size > 0) {
          reorderedItems.push(...sortItemsInHall(hallItems));
          itemsByHall.delete(hallId);
        }
      });
      
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

  return {
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
  };
}
