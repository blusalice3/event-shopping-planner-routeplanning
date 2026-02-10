import { useState, useCallback } from 'react';
import { ShoppingItem, ExecuteModeItems, DayModeState, ViewMode } from '../types';
import { BulkSortDirection } from '../App';

type SortState = 'Manual' | 'Postpone' | 'Late' | 'Absent' | 'SoldOut' | 'None' | 'Purchased';

const sortCycle: SortState[] = ['Manual', 'Postpone', 'Late', 'Absent', 'SoldOut', 'None', 'Purchased'];

interface SortingDeps {
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  items: ShoppingItem[];
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  selectedItemIds: Set<string>;
  selectedBlockFilters: Set<string>;
  setEventLists: React.Dispatch<React.SetStateAction<Record<string, ShoppingItem[]>>>;
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>;
  resetSelection: () => void;
  resetRecentlyChanged: () => void;
}

export { sortCycle };
export type { SortState };

export function useSorting(deps: SortingDeps) {
  const {
    activeEventName, activeTab, eventDates, items, executeModeItems, dayModes,
    selectedItemIds, selectedBlockFilters,
    setEventLists, setExecuteModeItems, resetSelection, resetRecentlyChanged,
  } = deps;

  const [sortState, setSortState] = useState<SortState>('Manual');
  const [blockSortDirection, setBlockSortDirection] = useState<'asc' | 'desc' | null>(null);
  const [candidateNumberSortDirection, setCandidateNumberSortDirection] = useState<'asc' | 'desc' | null>(null);

  const handleSortToggle = useCallback(() => {
    resetSelection();
    setBlockSortDirection(null);
    resetRecentlyChanged();
    const currentIndex = sortCycle.indexOf(sortState);
    const nextIndex = (currentIndex + 1) % sortCycle.length;
    setSortState(sortCycle[nextIndex]);
  }, [sortState, resetSelection, resetRecentlyChanged]);

  const handleBlockSortToggle = useCallback(() => {
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
    resetSelection();
  }, [activeEventName, activeTab, eventDates, blockSortDirection, setEventLists, resetSelection]);

  const handleBlockSortToggleCandidate = useCallback(() => {
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
    resetSelection();
  }, [activeEventName, activeTab, eventDates, executeModeItems, blockSortDirection, setEventLists, resetSelection]);

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
    resetSelection();
  }, [activeEventName, activeTab, executeModeItems, selectedBlockFilters, candidateNumberSortDirection, eventDates, setEventLists, resetSelection]);

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
          const selectedSortItems = dayItems
            .filter(id => selectedItemIds.has(id))
            .map(id => itemsMap.get(id)!)
            .filter(Boolean);
          
          const otherItems = dayItems.filter(id => !selectedItemIds.has(id));
          selectedSortItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'asc' ? comparison : -comparison;
          });
          
          const firstSelectedIndex = dayItems.findIndex(id => selectedItemIds.has(id));
          if (firstSelectedIndex === -1) return prev;
          const newDayItems = [...otherItems];
          newDayItems.splice(firstSelectedIndex, 0, ...selectedSortItems.map(item => item.id));
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
        const selectedSortItems = currentItems.filter(item => selectedItemIds.has(item.id));
        const otherItems = currentItems.filter(item => !selectedItemIds.has(item.id));

        selectedSortItems.sort((a, b) => {
            const comparison = a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' });
            return direction === 'asc' ? comparison : -comparison;
        });
        
        const firstSelectedIndex = currentItems.findIndex(item => selectedItemIds.has(item.id));
        if (firstSelectedIndex === -1) return prev;

        const newItems = [...otherItems];
        newItems.splice(firstSelectedIndex, 0, ...selectedSortItems);

        return { ...prev, [activeEventName]: newItems };
      });
    }
  }, [activeEventName, selectedItemIds, items, activeTab, dayModes, executeModeItems, eventDates, setEventLists, setExecuteModeItems]);

  // Reset sort state (called by other hooks)
  const resetSort = useCallback(() => {
    setSortState('Manual');
    setBlockSortDirection(null);
  }, []);

  return {
    sortState,
    setSortState,
    blockSortDirection,
    setBlockSortDirection,
    candidateNumberSortDirection,
    setCandidateNumberSortDirection,
    handleSortToggle,
    handleBlockSortToggle,
    handleBlockSortToggleCandidate,
    handleCandidateNumberSort,
    handleBulkSort,
    resetSort,
  };
}
