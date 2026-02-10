import { useState, useCallback } from 'react';
import { ShoppingItem, ExecuteModeItems, HallDefinition } from '../types';

interface ItemSelectionDeps {
  items: ShoppingItem[];
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  executeModeItems: Record<string, ExecuteModeItems>;
  getHallsForDate: (eventDate: string) => HallDefinition[];
  getMapDataForDate: (eventDate: string) => any;
}

export function useItemSelection(deps: ItemSelectionDeps) {
  const { items, activeEventName, activeTab, eventDates, executeModeItems, getHallsForDate, getMapDataForDate } = deps;

  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectedBlockFilters, setSelectedBlockFilters] = useState<Set<string>>(new Set());
  const [recentlyChangedItemIds, setRecentlyChangedItemIds] = useState<Set<string>>(new Set());
  const [rangeStart, setRangeStart] = useState<{ itemId: string; columnType: 'execute' | 'candidate' } | null>(null);
  const [rangeEnd, setRangeEnd] = useState<{ itemId: string; columnType: 'execute' | 'candidate' } | null>(null);

  const handleSelectItem = useCallback((itemId: string, columnType?: 'execute' | 'candidate') => {
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const currentColumnType = columnType || (activeEventName ? 
      (executeModeItems[activeEventName]?.[currentEventDate]?.includes(itemId) ? 'execute' : 'candidate') : 
      'execute');
    
    // 現在の列のアイテムを直接計算
    let currentItems: ShoppingItem[] = [];
    if (activeEventName) {
      if (currentColumnType === 'execute') {
        const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
        const itemsMap = new Map(items.map(item => [item.id, item]));
        currentItems = executeIds.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
      } else {
        const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
        let filtered = items.filter(item => 
          item.eventDate === currentEventDate && !executeIds.has(item.id)
        );
        // ブロックフィルタを適用
        if (selectedBlockFilters.size > 0) {
          filtered = filtered.filter(item => selectedBlockFilters.has(item.block));
        }
        currentItems = filtered;
      }
    }
    
    setSelectedItemIds(prev => {
        const newSet = new Set(prev);
        const wasSelected = newSet.has(itemId);
        
        if (wasSelected) {
            newSet.delete(itemId);
            // 選択解除時は起点・終点をリセット
            if (rangeStart?.itemId === itemId && rangeStart.columnType === currentColumnType) {
                setRangeStart(null);
                setRangeEnd(null);
            } else if (rangeEnd?.itemId === itemId && rangeEnd.columnType === currentColumnType) {
                setRangeEnd(null);
            }
        } else {
            newSet.add(itemId);
            
            // 起点が未設定の場合、または異なる列の場合は起点を設定
            if (!rangeStart || rangeStart.columnType !== currentColumnType) {
                setRangeStart({ itemId, columnType: currentColumnType });
                setRangeEnd(null);
            } else {
                // 起点が設定済みで、同じ列の場合
                // 起点の直上または直下のアイテムかチェック
                const startIndex = currentItems.findIndex(item => item.id === rangeStart.itemId);
                const currentIndex = currentItems.findIndex(item => item.id === itemId);
                
                // 起点の直上または直下でない場合のみ終点として設定
                if (startIndex !== -1 && currentIndex !== -1) {
                    const isAdjacent = Math.abs(startIndex - currentIndex) === 1;
                    if (!isAdjacent) {
                        setRangeEnd({ itemId, columnType: currentColumnType });
                    } else {
                        // 直上または直下の場合は終点をリセット
                        setRangeEnd(null);
                    }
                }
            }
        }
        
        return newSet;
    });

    // Return true to signal that sort state should be reset
    return true;
  }, [activeTab, activeEventName, executeModeItems, eventDates, rangeStart, rangeEnd, items, selectedBlockFilters]);

  const handleToggleBlockFilter = useCallback((block: string) => {
    setSelectedBlockFilters(prev => {
      const newSet = new Set(prev);
      if (newSet.has(block)) {
        newSet.delete(block);
      } else {
        newSet.add(block);
      }
      return newSet;
    });
  }, []);

  const handleClearBlockFilters = useCallback(() => {
    setSelectedBlockFilters(new Set());
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
    setRangeStart(null);
    setRangeEnd(null);
  }, []);

  // 範囲内のアイテムを一括でチェック/チェック解除する関数
  const handleToggleRangeSelection = useCallback((columnType: 'execute' | 'candidate') => {
    if (!rangeStart || rangeStart.columnType !== columnType || !rangeEnd || rangeEnd.columnType !== columnType) {
      return;
    }

    if (!activeEventName) return;
    
    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    
    // 現在の列のアイテムを直接計算
    let currentItems: ShoppingItem[] = [];
    if (columnType === 'execute') {
      const executeIds = executeModeItems[activeEventName]?.[currentEventDate] || [];
      const itemsMap = new Map(items.map(item => [item.id, item]));
      currentItems = executeIds.map(id => itemsMap.get(id)).filter(Boolean) as ShoppingItem[];
    } else {
      const executeIds = new Set(executeModeItems[activeEventName]?.[currentEventDate] || []);
      let filtered = items.filter(item => 
        item.eventDate === currentEventDate && !executeIds.has(item.id)
      );
      // ブロックフィルタを適用
      if (selectedBlockFilters.size > 0) {
        filtered = filtered.filter(item => selectedBlockFilters.has(item.block));
      }
      currentItems = filtered;
    }
    
    // ホール定義とマップデータを取得してグループ化
    const halls = getHallsForDate(currentEventDate);
    const currentMapDataForDate = getMapDataForDate(currentEventDate);
    
    // グループ化が有効な場合、同一グループ内のアイテムのみを対象にする
    if (halls.length > 0 && currentMapDataForDate) {
      // アイテムのホールIDを取得するヘルパー
      const getHallIdForItem = (item: ShoppingItem): string | null => {
        const block = currentMapDataForDate.blocks.find((b: any) => b.name === item.block);
        if (!block) return null;
        
        const numMatch = item.number?.match(/\d+/);
        if (!numMatch) return null;
        const num = parseInt(numMatch[0], 10);
        
        const cell = block.numberCells.find((nc: { row: number; col: number; value: number }) => nc.value === num);
        if (!cell) return null;
        
        // 多角形内判定
        const isPointInPoly = (row: number, col: number, vertices: { row: number; col: number }[]): boolean => {
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
        
        for (const hall of halls) {
          for (const vertex of hall.vertices) {
            if (vertex.row === cell.row && vertex.col === cell.col) {
              return hall.id;
            }
          }
          if (isPointInPoly(cell.row, cell.col, hall.vertices)) {
            return hall.id;
          }
        }
        return null;
      };
      
      // グループIDを生成するヘルパー
      const buildGroupId = (hallId: string | null, priority: 'none' | 'priority' | 'highest'): string | null => {
        if (hallId === null) {
          if (priority === 'highest') return 'undefined:highest';
          if (priority === 'priority') return 'undefined:priority';
          return null;
        }
        if (priority === 'highest') return `${hallId}:highest`;
        if (priority === 'priority') return `${hallId}:priority`;
        return hallId;
      };
      
      const getItemGroupId = (item: ShoppingItem): string | null => {
        const hallId = getHallIdForItem(item);
        const priority = item.priorityLevel || 'none';
        return buildGroupId(hallId, priority);
      };
      
      // rangeStartとrangeEndのグループIDを確認
      const startItem = currentItems.find(item => item.id === rangeStart.itemId);
      const endItem = currentItems.find(item => item.id === rangeEnd.itemId);
      
      if (!startItem || !endItem) return;
      
      const startGroupId = getItemGroupId(startItem);
      const endGroupId = getItemGroupId(endItem);
      
      // 異なるグループの場合は何もしない
      if (startGroupId !== endGroupId) {
        return;
      }
      
      // 同じグループ内のアイテムのみを対象にする
      const groupItems = currentItems.filter(item => getItemGroupId(item) === startGroupId);
      
      const startIndex = groupItems.findIndex(item => item.id === rangeStart.itemId);
      const endIndex = groupItems.findIndex(item => item.id === rangeEnd.itemId);
      
      if (startIndex === -1 || endIndex === -1) return;
      
      const minIndex = Math.min(startIndex, endIndex);
      const maxIndex = Math.max(startIndex, endIndex);
      const rangeItems = groupItems.slice(minIndex, maxIndex + 1);
      
      // 範囲内のアイテムが全てチェック済みかチェック
      setSelectedItemIds(prev => {
        const allSelected = rangeItems.every(item => prev.has(item.id));
        const newSet = new Set(prev);
        if (allSelected) {
          rangeItems.forEach(item => newSet.delete(item.id));
          setRangeStart(null);
          setRangeEnd(null);
        } else {
          rangeItems.forEach(item => newSet.add(item.id));
        }
        return newSet;
      });
      return;
    }
    
    // グループ化が無効な場合は従来のロジック
    const startIndex = currentItems.findIndex(item => item.id === rangeStart.itemId);
    const endIndex = currentItems.findIndex(item => item.id === rangeEnd.itemId);
    
    if (startIndex === -1 || endIndex === -1) return;
    
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);
    const rangeItems = currentItems.slice(minIndex, maxIndex + 1);
    
    // 範囲内のアイテムが全てチェック済みかチェック
    setSelectedItemIds(prev => {
      const allSelected = rangeItems.every(item => prev.has(item.id));
      const newSet = new Set(prev);
      if (allSelected) {
        // 全てチェック済みの場合はチェックを外す
        rangeItems.forEach(item => newSet.delete(item.id));
        setRangeStart(null);
        setRangeEnd(null);
      } else {
        // 未チェックのアイテムがある場合は全てチェックを入れる
        rangeItems.forEach(item => newSet.add(item.id));
      }
      return newSet;
    });
  }, [rangeStart, rangeEnd, activeTab, activeEventName, eventDates, executeModeItems, items, selectedBlockFilters, getHallsForDate, getMapDataForDate]);

  return {
    selectedItemIds,
    setSelectedItemIds,
    selectedBlockFilters,
    setSelectedBlockFilters,
    recentlyChangedItemIds,
    setRecentlyChangedItemIds,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    handleSelectItem,
    handleToggleBlockFilter,
    handleClearBlockFilters,
    handleClearSelection,
    handleToggleRangeSelection,
  };
}
