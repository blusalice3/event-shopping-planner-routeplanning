import { useCallback, useMemo } from 'react';
import type {
  DayMapData,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettings,
  HallRouteSettingsStore,
  MapDataStore,
} from '../../../types';

type UseMapSelectorsParams = {
  activeEventName: string | null;
  activeTab: string;
  mapData: MapDataStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
};

const toHalfWidthDigits = (value: string): string =>
  value.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));

const normalizeMapDayToken = (value: string): string =>
  toHalfWidthDigits(value)
    .replace(/[ \u3000]/g, '')
    .replace(/マップ$/, '');

type UseMapSelectorsResult = {
  mapTabs: string[];
  isMapTab: boolean;
  currentMapData: DayMapData | null;
  currentHalls: HallDefinition[];
  currentHallRouteSettings: HallRouteSettings;
  getMapTabForDate: (eventDate: string) => string;
  getHallsForDate: (eventDate: string) => HallDefinition[];
  getMapDataForDate: (eventDate: string) => DayMapData | null;
  getHallOrderForDate: (eventDate: string) => string[];
};

export function useMapSelectors({
  activeEventName,
  activeTab,
  mapData,
  hallDefinitions,
  hallRouteSettings,
}: UseMapSelectorsParams): UseMapSelectorsResult {
  const mapTabs = useMemo(() => {
    if (!activeEventName || !mapData[activeEventName]) return [];
    return Object.keys(mapData[activeEventName]).sort((a, b) => {
      const numA = parseInt(toHalfWidthDigits(a).match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(toHalfWidthDigits(b).match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    });
  }, [activeEventName, mapData]);

  const isMapTab = useMemo(() => activeTab.endsWith('マップ'), [activeTab]);

  const currentMapData = useMemo(() => {
    if (!activeEventName || !isMapTab) return null;
    return mapData[activeEventName]?.[activeTab] || null;
  }, [activeEventName, activeTab, isMapTab, mapData]);

  const currentHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName || !isMapTab) return [];
    return hallDefinitions[activeEventName]?.[activeTab] || [];
  }, [activeEventName, activeTab, isMapTab, hallDefinitions]);

  const currentHallRouteSettings = useMemo((): HallRouteSettings => {
    if (!activeEventName || !isMapTab) {
      return { hallOrder: [], hallVisitLists: [] };
    }
    return (
      hallRouteSettings[activeEventName]?.[activeTab] || {
        hallOrder: currentHalls.map((h) => h.id),
        hallVisitLists: [],
      }
    );
  }, [activeEventName, activeTab, isMapTab, hallRouteSettings, currentHalls]);

  const getMapTabForDate = useCallback(
    (eventDate: string): string => {
      const normalizedEventDate = normalizeMapDayToken(eventDate);
      const matchedMapTab = mapTabs.find(
        (tab) => normalizeMapDayToken(tab) === normalizedEventDate,
      );
      return matchedMapTab ?? `${eventDate}マップ`;
    },
    [mapTabs],
  );

  const getHallsForDate = useCallback(
    (eventDate: string): HallDefinition[] => {
      if (!activeEventName) return [];
      const mapTab = getMapTabForDate(eventDate);
      return hallDefinitions[activeEventName]?.[mapTab] || [];
    },
    [activeEventName, hallDefinitions, getMapTabForDate],
  );

  const getMapDataForDate = useCallback(
    (eventDate: string): DayMapData | null => {
      if (!activeEventName) return null;
      const mapTab = getMapTabForDate(eventDate);
      return mapData[activeEventName]?.[mapTab] || null;
    },
    [activeEventName, mapData, getMapTabForDate],
  );

  const getHallOrderForDate = useCallback(
    (eventDate: string): string[] => {
      if (!activeEventName) return [];
      const mapTab = getMapTabForDate(eventDate);
      const halls = hallDefinitions[activeEventName]?.[mapTab] || [];
      const routeSettings = hallRouteSettings[activeEventName]?.[mapTab];

      if (routeSettings?.hallOrder && routeSettings.hallOrder.length > 0) {
        return routeSettings.hallOrder;
      }

      return halls.map((h) => h.id);
    },
    [activeEventName, hallDefinitions, hallRouteSettings, getMapTabForDate],
  );

  return {
    mapTabs,
    isMapTab,
    currentMapData,
    currentHalls,
    currentHallRouteSettings,
    getMapTabForDate,
    getHallsForDate,
    getMapDataForDate,
    getHallOrderForDate,
  };
}
