import { useMemo } from 'react';
import { ShoppingItem, ExecuteModeItems, DayModeState } from '../types';
import type { SortState } from './useSorting';

interface UseColumnItemsParams {
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  items: ShoppingItem[];
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  sortState: SortState;
  selectedBlockFilters: Set<string>;
  selectedItemIds: Set<string>;
  recentlyChangedItemIds: Set<string>;
  currentMode: string;
}

export function useColumnItems({
  activeEventName, activeTab, eventDates, items,
  executeModeItems, dayModes, sortState,
  selectedBlockFilters, selectedItemIds, recentlyChangedItemIds,
  currentMode,
}: UseColumnItemsParams) {

  const currentTabItems = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return [];
    return items.filter(item => item.eventDate === activeTab);
  }, [items, activeTab, activeEventName, eventDates]);

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
      if (sortState === 'Manual') {
        return executeColumnItems;
      }
      const filterStatus = sortState as Exclude<SortState, 'Manual'>;
      return executeColumnItems.filter(item => 
        item.purchaseStatus === filterStatus || recentlyChangedItemIds.has(item.id)
      );
    }
    
    return itemsForTab;
  }, [activeTab, currentTabItems, sortState, activeEventName, dayModes, executeColumnItems, eventDates, recentlyChangedItemIds]);

  const duplicateCircleItemIds = useMemo(() => {
    if (!activeEventName || !eventDates.includes(activeTab)) return new Set<string>();
    const itemsForTab = currentTabItems;
    const circleCountMap = new Map<string, number>();
    const circleItemIdsMap = new Map<string, string[]>();
    
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
    
    const duplicateIds = new Set<string>();
    circleCountMap.forEach((count, circle) => {
      if (count > 1) {
        const itemIds = circleItemIdsMap.get(circle) || [];
        itemIds.forEach(id => duplicateIds.add(id));
      }
    });
    
    return duplicateIds;
  }, [activeEventName, activeTab, currentTabItems, eventDates]);

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
    
    if (selectedBlockFilters.size > 0) {
      filtered = filtered.filter(item => selectedBlockFilters.has(item.block));
    }
    
    return filtered;
  }, [activeEventName, activeTab, executeModeItems, currentTabItems, selectedBlockFilters, eventDates]);

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

  const hasCandidateSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter(item => selectedItemIds.has(item.id));
    return selectedItems.some(item => currentTabItems.includes(item) && !executeIds.has(item.id));
  }, [activeEventName, activeTab, currentMode, selectedItemIds, items, executeModeItems, currentTabItems, eventDates]);

  const hasExecuteSelection = useMemo(() => {
    if (!activeEventName || currentMode !== 'edit' || selectedItemIds.size === 0) return false;
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
    const selectedItems = items.filter(item => selectedItemIds.has(item.id));
    return selectedItems.some(item => currentTabItems.includes(item) && executeIds.has(item.id));
  }, [activeEventName, activeTab, currentMode, selectedItemIds, items, executeModeItems, currentTabItems, eventDates]);

  const showMoveButtons = (hasCandidateSelection && !hasExecuteSelection) || (hasExecuteSelection && !hasCandidateSelection);

  return {
    currentTabItems,
    executeColumnItems,
    visibleItems,
    duplicateCircleItemIds,
    availableBlocks,
    candidateColumnItems,
    blocksWithPriorityRemarks,
    hasCandidateSelection,
    hasExecuteSelection,
    showMoveButtons,
  };
}
