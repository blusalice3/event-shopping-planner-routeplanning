import { useCallback, useMemo } from 'react';
import { ShoppingItem, HallDefinition, HallRouteSettings, HallDefinitionsStore, HallRouteSettingsStore, MapDataStore, ExecuteModeItems, DayMapData } from '../types';
import { isPointInPolygon } from '../components/map';

interface UseHallUtilsParams {
  activeEventName: string | null;
  activeTab: string;
  isMapTab: boolean;
  items: ShoppingItem[];
  executeModeItems: Record<string, ExecuteModeItems>;
  mapData: MapDataStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
}

export function useHallUtils({
  activeEventName, activeTab, isMapTab, items,
  executeModeItems, mapData, hallDefinitions, hallRouteSettings,
}: UseHallUtilsParams) {

  // 現在のマップデータを取得
  const currentMapData = useMemo((): DayMapData | null => {
    if (!activeEventName || !isMapTab) return null;
    return mapData[activeEventName]?.[activeTab] || null;
  }, [activeEventName, activeTab, isMapTab, mapData]);

  // 現在のホール定義を取得
  const currentHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName || !isMapTab) return [];
    return hallDefinitions[activeEventName]?.[activeTab] || [];
  }, [activeEventName, activeTab, isMapTab, hallDefinitions]);

  // 現在のホールルート設定を取得
  const currentHallRouteSettings = useMemo((): HallRouteSettings => {
    if (!activeEventName || !isMapTab) {
      return { hallOrder: [], hallVisitLists: [] };
    }
    return hallRouteSettings[activeEventName]?.[activeTab] || { hallOrder: currentHalls.map(h => h.id), hallVisitLists: [] };
  }, [activeEventName, activeTab, isMapTab, hallRouteSettings, currentHalls]);

  // ホール内の訪問先アイテム数を取得（優先・最優先グループも含む）
  const getHallExecuteCount = useCallback((hallId: string): number => {
    if (!activeEventName || !isMapTab || !currentMapData) return 0;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return 0;
    const dayName = dayMatch[1];
    
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
    
    return executeIds.filter(itemId => {
      const item = items.find(i => i.id === itemId);
      if (!item) return false;
      
      const block = currentMapData.blocks.find(b => b.name === item.block);
      if (!block) return false;
      
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;
      
      for (const hall of currentHalls) {
        if (hall.id === hallId && hall.vertices.length >= 4) {
          if (isPointInPolygon(centerRow, centerCol, hall.vertices)) {
            return true;
          }
        }
      }
      return false;
    }).length;
  }, [activeEventName, isMapTab, activeTab, currentMapData, currentHalls, items, executeModeItems]);

  // ホール内の全アイテム数を取得
  const getHallTotalItemCount = useCallback((hallId: string): number => {
    if (!activeEventName || !isMapTab || !currentMapData) return 0;
    
    const dayMatch = activeTab.match(/^(.+)マップ$/);
    if (!dayMatch) return 0;
    const dayName = dayMatch[1];
    
    const dayItems = items.filter(item => item.eventDate === dayName);
    
    return dayItems.filter(item => {
      const block = currentMapData.blocks.find(b => b.name === item.block);
      if (!block) return false;
      
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;
      
      for (const hall of currentHalls) {
        if (hall.id === hallId && hall.vertices.length >= 4) {
          if (isPointInPolygon(centerRow, centerCol, hall.vertices)) {
            return true;
          }
        }
      }
      return false;
    }).length;
  }, [activeEventName, isMapTab, activeTab, currentMapData, currentHalls, items]);

  // 日付タブに対応するマップタブ名を取得
  const getMapTabForDate = useCallback((eventDate: string): string => {
    return `${eventDate}マップ`;
  }, []);

  // 日付タブに対応するホール定義を取得
  const getHallsForDate = useCallback((eventDate: string): HallDefinition[] => {
    if (!activeEventName) return [];
    const mapTab = getMapTabForDate(eventDate);
    return hallDefinitions[activeEventName]?.[mapTab] || [];
  }, [activeEventName, hallDefinitions, getMapTabForDate]);

  // 日付タブに対応するマップデータを取得
  const getMapDataForDate = useCallback((eventDate: string) => {
    if (!activeEventName) return null;
    const mapTab = getMapTabForDate(eventDate);
    return mapData[activeEventName]?.[mapTab] || null;
  }, [activeEventName, mapData, getMapTabForDate]);

  // 日付タブに対応するホール順序を取得
  const getHallOrderForDate = useCallback((eventDate: string): string[] => {
    if (!activeEventName) return [];
    const mapTab = getMapTabForDate(eventDate);
    const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
    const rs = hallRouteSettings[activeEventName]?.[mapTab];
    
    if (rs?.hallOrder && rs.hallOrder.length > 0) {
      return rs.hallOrder;
    }
    
    return halls.map(h => h.id);
  }, [activeEventName, hallDefinitions, hallRouteSettings, getMapTabForDate]);

  // アイテムがどのホールに属するかを判定
  const getItemHallId = useCallback((item: ShoppingItem, eventDate: string): string | null => {
    const halls = getHallsForDate(eventDate);
    const mapDataForDate = getMapDataForDate(eventDate);
    if (!halls.length || !mapDataForDate) return null;

    const block = mapDataForDate.blocks.find(b => b.name === item.block);
    if (!block) return null;

    const centerRow = (block.startRow + block.endRow) / 2;
    const centerCol = (block.startCol + block.endCol) / 2;

    for (const hall of halls) {
      if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
        return hall.id;
      }
    }
    return null;
  }, [getHallsForDate, getMapDataForDate]);

  // 2つのアイテムが同じホールに属するかを判定
  const areItemsInSameHall = useCallback((itemId1: string, itemId2: string, eventDate: string): boolean => {
    const item1 = items.find(i => i.id === itemId1);
    const item2 = items.find(i => i.id === itemId2);
    if (!item1 || !item2) return true;

    const halls = getHallsForDate(eventDate);
    if (!halls.length) return true;

    const hallId1 = getItemHallId(item1, eventDate);
    const hallId2 = getItemHallId(item2, eventDate);

    if (hallId1 === null || hallId2 === null) return true;

    return hallId1 === hallId2;
  }, [items, getHallsForDate, getItemHallId]);

  return {
    currentMapData,
    currentHalls,
    currentHallRouteSettings,
    getHallExecuteCount,
    getHallTotalItemCount,
    getMapTabForDate,
    getHallsForDate,
    getMapDataForDate,
    getHallOrderForDate,
    getItemHallId,
    areItemsInSameHall,
  };
}
