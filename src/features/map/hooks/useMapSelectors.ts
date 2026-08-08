import { useCallback, useMemo } from "react";
import type {
  DayMapData,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettings,
  HallRouteSettingsStore,
  MapDataStore,
} from "../../../types/map";
import { getMaplessKey } from "../../../types/map";

type UseMapSelectorsParams = {
  activeEventName: string | null;
  activeTab: string;
  activeEventDate: string | null;
  mapViewActive: boolean;
  mapData: MapDataStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
};

const toHalfWidthDigits = (value: string): string =>
  value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );

const normalizeMapDayToken = (value: string): string =>
  toHalfWidthDigits(value)
    .replace(/[ \u3000]/g, "")
    .replace(/マップ$/, "");

type UseMapSelectorsResult = {
  mapTabs: string[];
  isMapTab: boolean;
  currentMapTabName: string | null;
  currentMapData: DayMapData | null;
  currentHalls: HallDefinition[];
  currentHallRouteSettings: HallRouteSettings;
  getMapTabForDate: (eventDate: string) => string | null;
  getHallsForDate: (eventDate: string) => HallDefinition[];
  getMapDataForDate: (eventDate: string) => DayMapData | null;
  getHallOrderForDate: (eventDate: string) => string[];
};

export function useMapSelectors({
  activeEventName,
  activeEventDate,
  mapViewActive,
  mapData,
  hallDefinitions,
  hallRouteSettings,
}: UseMapSelectorsParams): UseMapSelectorsResult {
  const mapTabs = useMemo(() => {
    if (!activeEventName || !mapData[activeEventName]) return [];
    return Object.keys(mapData[activeEventName]).sort((a, b) => {
      const numA = parseInt(toHalfWidthDigits(a).match(/\d+/)?.[0] || "0", 10);
      const numB = parseInt(toHalfWidthDigits(b).match(/\d+/)?.[0] || "0", 10);
      return numA - numB;
    });
  }, [activeEventName, mapData]);

  const getMapTabForDate = useCallback(
    (eventDate: string): string | null => {
      const normalizedEventDate = normalizeMapDayToken(eventDate);
      const matchedMapTab = mapTabs.find(
        (tab) => normalizeMapDayToken(tab) === normalizedEventDate,
      );
      return matchedMapTab ?? null;
    },
    [mapTabs],
  );

  // マップビューがアクティブな場合、現在の日付タブに対応するマップタブ名を導出
  const currentMapTabName = useMemo(() => {
    if (!mapViewActive || !activeEventDate) return null;
    return getMapTabForDate(activeEventDate);
  }, [mapViewActive, activeEventDate, getMapTabForDate]);

  const isMapTab = currentMapTabName != null;

  const currentMapData = useMemo(() => {
    if (!activeEventName || !currentMapTabName) return null;
    return mapData[activeEventName]?.[currentMapTabName] || null;
  }, [activeEventName, currentMapTabName, mapData]);

  const currentHalls = useMemo((): HallDefinition[] => {
    if (!activeEventName || !activeEventDate) return [];
    const mapHalls = currentMapTabName
      ? hallDefinitions[activeEventName]?.[currentMapTabName] || []
      : [];
    const maplessHalls =
      hallDefinitions[activeEventName]?.[getMaplessKey(activeEventDate)] || [];
    return [...mapHalls, ...maplessHalls];
  }, [activeEventName, activeEventDate, currentMapTabName, hallDefinitions]);

  const currentHallRouteSettings = useMemo((): HallRouteSettings => {
    if (!activeEventName || !currentMapTabName) {
      return { hallOrder: [], hallVisitLists: [] };
    }
    return (
      hallRouteSettings[activeEventName]?.[currentMapTabName] || {
        hallOrder: currentHalls.map((h) => h.id),
        hallVisitLists: [],
      }
    );
  }, [activeEventName, currentMapTabName, hallRouteSettings, currentHalls]);

  const getHallsForDate = useCallback(
    (eventDate: string): HallDefinition[] => {
      if (!activeEventName) return [];
      const mapTab = getMapTabForDate(eventDate);
      const mapHalls = mapTab
        ? hallDefinitions[activeEventName]?.[mapTab] || []
        : [];
      const maplessHalls =
        hallDefinitions[activeEventName]?.[getMaplessKey(eventDate)] || [];
      return [...mapHalls, ...maplessHalls];
    },
    [activeEventName, hallDefinitions, getMapTabForDate],
  );

  const getMapDataForDate = useCallback(
    (eventDate: string): DayMapData | null => {
      if (!activeEventName) return null;
      const mapTab = getMapTabForDate(eventDate);
      if (!mapTab) return null;
      return mapData[activeEventName]?.[mapTab] || null;
    },
    [activeEventName, mapData, getMapTabForDate],
  );

  const getHallOrderForDate = useCallback(
    (eventDate: string): string[] => {
      if (!activeEventName) return [];
      const mapTab = getMapTabForDate(eventDate);
      const mapHalls = mapTab
        ? hallDefinitions[activeEventName]?.[mapTab] || []
        : [];
      const maplessHalls =
        hallDefinitions[activeEventName]?.[getMaplessKey(eventDate)] || [];
      const mapRouteSettings = mapTab
        ? hallRouteSettings[activeEventName]?.[mapTab]
        : undefined;
      const maplessRouteSettings =
        hallRouteSettings[activeEventName]?.[getMaplessKey(eventDate)];

      const mapOrder =
        mapRouteSettings?.hallOrder && mapRouteSettings.hallOrder.length > 0
          ? mapRouteSettings.hallOrder
          : mapHalls.map((h) => h.id);
      const maplessOrder =
        maplessRouteSettings?.hallOrder &&
        maplessRouteSettings.hallOrder.length > 0
          ? maplessRouteSettings.hallOrder
          : maplessHalls.map((h) => h.id);

      return [...mapOrder, ...maplessOrder];
    },
    [activeEventName, hallDefinitions, hallRouteSettings, getMapTabForDate],
  );

  return {
    mapTabs,
    isMapTab,
    currentMapTabName,
    currentMapData,
    currentHalls,
    currentHallRouteSettings,
    getMapTabForDate,
    getHallsForDate,
    getMapDataForDate,
    getHallOrderForDate,
  };
}
