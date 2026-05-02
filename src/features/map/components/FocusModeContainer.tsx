import React, { useEffect, useMemo, useRef } from 'react';
import FocusMode from '../../../components/FocusMode';
import { buildMergedHallRouteSettings } from '../../../utils/mergedHallRouteSettings';
import { buildItemRoutingSignature } from '../../../utils/hallGrouping';
import { buildDayMapVisitLookupSignature } from '../../../utils/mapRoutingSignature';
import {
  buildActiveHallDefinitionsStore,
  buildActiveHallRouteSettingsStore,
  buildHallDefinitionsStoreRoutingSignature,
  buildHallRouteSettingsStoreRoutingSignature,
} from '../../../utils/hallRoutingSignature';
import type { ExecuteModeItems, PurchaseStatus, ShoppingItem } from '../../../types/item';
import type { FocusModeSessionState } from '../../../types/focus';
import type {
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  NumberCellOutlineStyle,
  HallRouteSettings,
} from '../../../types/map';
import { getMaplessKey } from '../../../types/map';

type FocusModeContainerProps = {
  activeEventName: string | null;
  activeTab: string;
  eventDates: string[];
  items: ShoppingItem[];
  executeModeItems: Record<string, ExecuteModeItems>;
  mapData: MapDataStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  onUpdateItem: (item: ShoppingItem) => void;
  onModeChange: (mode: 'edit' | 'execute', lastItemId?: string) => void;
  layoutMode: 'pc' | 'smartphone';
  onLayoutModeChange: (mode: 'pc' | 'smartphone') => void;
  onMapVisibilityChange?: (isMapVisible: boolean) => void;
  onAddItem?: (item: Omit<ShoppingItem, 'id'> & { purchaseStatus?: PurchaseStatus }) => void;
  onEditRequest?: (item: ShoppingItem) => void;
  onDeleteRequest?: (item: ShoppingItem) => void;
  appZoomLevel?: number;
  resumeState?: FocusModeSessionState | null;
  onSessionStateChange?: (state: FocusModeSessionState) => void;
  mapRotationAngle?: number;
  mapInitialRotationAngle?: number;
  onMapRotationAngleChange?: (angle: number) => void;
  numberCellOutlineStyle?: NumberCellOutlineStyle;
  disablePriceUndefinedCheck?: boolean;
};

const FocusModeContainer: React.FC<FocusModeContainerProps> = ({
  activeEventName,
  activeTab,
  eventDates,
  items,
  executeModeItems,
  mapData,
  hallDefinitions,
  hallRouteSettings,
  onUpdateItem,
  onModeChange,
  layoutMode,
  onLayoutModeChange,
  onMapVisibilityChange,
  onAddItem,
  onEditRequest,
  onDeleteRequest,
  appZoomLevel,
  resumeState,
  onSessionStateChange,
  mapRotationAngle,
  mapInitialRotationAngle,
  onMapRotationAngleChange,
  numberCellOutlineStyle,
  disablePriceUndefinedCheck,
}) => {
  // 現在表示中の日付（タブ名が日付と一致すればそれ、そうでなければ先頭日）
  const currentDay = useMemo(
    () => (eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''),
    [activeTab, eventDates],
  );

  // 実行列に含まれるアイテムID
  const executeModeItemIds = useMemo(() => {
    if (!activeEventName) return [];
    return executeModeItems[activeEventName]?.[currentDay] || [];
  }, [executeModeItems, activeEventName, currentDay]);

  const executeModeItemIdsSignature = useMemo(() => {
    return JSON.stringify(executeModeItemIds);
  }, [executeModeItemIds]);

  const stableExecuteModeItemIdsRef = useRef<{
    signature: string;
    ids: string[];
  } | null>(null);

  const stableExecuteModeItemIds = useMemo(() => {
    if (stableExecuteModeItemIdsRef.current?.signature === executeModeItemIdsSignature) {
      return stableExecuteModeItemIdsRef.current.ids;
    }

    stableExecuteModeItemIdsRef.current = {
      signature: executeModeItemIdsSignature,
      ids: executeModeItemIds,
    };

    return executeModeItemIds;
  }, [executeModeItemIds, executeModeItemIdsSignature]);

  const focusRouteItemsSignature = useMemo(() => {
    return buildItemRoutingSignature(items, stableExecuteModeItemIds);
  }, [items, stableExecuteModeItemIds]);

  const focusRouteRelevantItemsRef = useRef<{
    signature: string;
    items: ShoppingItem[];
  } | null>(null);

  const focusRouteRelevantItems = useMemo(() => {
    if (focusRouteRelevantItemsRef.current?.signature === focusRouteItemsSignature) {
      return focusRouteRelevantItemsRef.current.items;
    }

    const itemsById = new Map(items.map((item) => [item.id, item]));
    const relevantItems = stableExecuteModeItemIds
      .map((id) => itemsById.get(id))
      .filter((item): item is ShoppingItem => item !== undefined);

    focusRouteRelevantItemsRef.current = {
      signature: focusRouteItemsSignature,
      items: relevantItems,
    };

    return relevantItems;
  }, [focusRouteItemsSignature, items, stableExecuteModeItemIds]);

  // マップタブ名（イベント日付 + "マップ"）
  const mapTabName = useMemo(
    () => (currentDay ? `${currentDay}マップ` : null),
    [currentDay],
  );

  // 当該マップが存在するか
  const hasMapTab = useMemo(() => {
    if (!activeEventName || !mapTabName) return false;
    return !!mapData[activeEventName]?.[mapTabName];
  }, [activeEventName, mapTabName, mapData]);

  const activeEventMapData = useMemo(() => {
    if (!activeEventName) return undefined;
    return mapData[activeEventName] || undefined;
  }, [activeEventName, mapData]);

  const activeDayMapData = useMemo(() => {
    if (!activeEventMapData || !mapTabName || !hasMapTab) return null;
    return activeEventMapData[mapTabName] || null;
  }, [activeEventMapData, mapTabName, hasMapTab]);

  const activeDayMapVisitLookupSignature = useMemo(() => {
    return buildDayMapVisitLookupSignature(activeDayMapData);
  }, [activeDayMapData]);

  const focusMapDataStoreRef = useRef<{
    signature: string;
    store: MapDataStore;
  } | null>(null);

  const focusMapDataStore = useMemo(() => {
    const activeMapTabName = hasMapTab ? mapTabName : null;
    const signature = JSON.stringify([
      activeEventName || '',
      activeMapTabName || '',
      activeDayMapVisitLookupSignature,
    ]);

    if (focusMapDataStoreRef.current?.signature === signature) {
      return focusMapDataStoreRef.current.store;
    }

    const store: MapDataStore =
      activeEventName && activeMapTabName && activeDayMapData
        ? { [activeEventName]: { [activeMapTabName]: activeDayMapData } }
        : activeEventName
          ? { [activeEventName]: {} }
          : {};

    focusMapDataStoreRef.current = { signature, store };
    return store;
  }, [
    activeEventName,
    hasMapTab,
    mapTabName,
    activeDayMapData,
    activeDayMapVisitLookupSignature,
  ]);

  const maplessKey = useMemo(() => {
    return currentDay ? getMaplessKey(currentDay) : null;
  }, [currentDay]);

  // マップ定義 + mapless ホール定義を統合した情報
  const activeHallDefinitionsStoreRef = useRef<{
    signature: string;
    store: HallDefinitionsStore;
  } | null>(null);

  const activeHallDefinitionsStore = useMemo(() => {
    const activeMapTabName = hasMapTab ? mapTabName : null;
    const activeMapHalls: HallDefinition[] =
      activeEventName && activeMapTabName
        ? hallDefinitions[activeEventName]?.[activeMapTabName] || []
        : [];
    const activeMaplessHalls: HallDefinition[] =
      activeEventName && maplessKey ? hallDefinitions[activeEventName]?.[maplessKey] || [] : [];

    const signature = buildHallDefinitionsStoreRoutingSignature({
      activeEventName,
      activeMapTabName,
      maplessKey,
      activeMapHalls,
      activeMaplessHalls,
    });

    if (activeHallDefinitionsStoreRef.current?.signature === signature) {
      return activeHallDefinitionsStoreRef.current.store;
    }

    const store = buildActiveHallDefinitionsStore({
      activeEventName,
      activeMapTabName,
      maplessKey,
      activeMapHalls,
      activeMaplessHalls,
    });

    activeHallDefinitionsStoreRef.current = { signature, store };
    return store;
  }, [activeEventName, hasMapTab, mapTabName, maplessKey, hallDefinitions]);

  const activeHallRouteSettingsStoreRef = useRef<{
    signature: string;
    store: HallRouteSettingsStore;
  } | null>(null);

  const activeHallRouteSettingsStore = useMemo(() => {
    const activeMapTabName = hasMapTab ? mapTabName : null;
    const activeMapSettings: HallRouteSettings | undefined =
      activeEventName && activeMapTabName
        ? hallRouteSettings[activeEventName]?.[activeMapTabName]
        : undefined;
    const activeMaplessSettings: HallRouteSettings | undefined =
      activeEventName && maplessKey ? hallRouteSettings[activeEventName]?.[maplessKey] : undefined;

    const signature = buildHallRouteSettingsStoreRoutingSignature({
      activeEventName,
      activeMapTabName,
      maplessKey,
      activeMapSettings,
      activeMaplessSettings,
    });

    if (activeHallRouteSettingsStoreRef.current?.signature === signature) {
      return activeHallRouteSettingsStoreRef.current.store;
    }

    const store = buildActiveHallRouteSettingsStore({
      activeEventName,
      activeMapTabName,
      maplessKey,
      activeMapSettings,
      activeMaplessSettings,
    });

    activeHallRouteSettingsStoreRef.current = { signature, store };
    return store;
  }, [activeEventName, hasMapTab, mapTabName, maplessKey, hallRouteSettings]);

  const focusDisplayMergedHalls = useMemo(() => {
    if (!activeEventName) return [];

    const activeMapTabName = hasMapTab ? mapTabName : null;
    const activeMapHalls =
      activeMapTabName ? hallDefinitions[activeEventName]?.[activeMapTabName] || [] : [];
    const activeMaplessHalls =
      maplessKey ? hallDefinitions[activeEventName]?.[maplessKey] || [] : [];

    return [...activeMapHalls, ...activeMaplessHalls];
  }, [activeEventName, hasMapTab, mapTabName, maplessKey, hallDefinitions]);

  const { mergedSettings: focusMergedSettings } = useMemo(
    () =>
      buildMergedHallRouteSettings({
        eventName: activeEventName,
        dayName: currentDay,
        mapTabName: hasMapTab ? mapTabName : null,
        hallDefinitionsStore: activeHallDefinitionsStore,
        hallRouteSettingsStore: activeHallRouteSettingsStore,
        executeIds: stableExecuteModeItemIds,
        items: focusRouteRelevantItems,
        mapDataStore: focusMapDataStore,
      }),
    [
      activeEventName,
      currentDay,
      hasMapTab,
      mapTabName,
      activeHallDefinitionsStore,
      activeHallRouteSettingsStore,
      stableExecuteModeItemIds,
      focusRouteRelevantItems,
      focusMapDataStore,
    ],
  );

  // FocusMode に渡す mapData（イベント別の分岐を吸収）
  const focusMapData = useMemo(() => {
    return activeEventMapData;
  }, [activeEventMapData]);

  useEffect(() => {
    onMapVisibilityChange?.(false);
  }, [onMapVisibilityChange]);

  if (!activeEventName) return null;

  return (
    <FocusMode
      items={items}
      executeModeItemIds={executeModeItemIds}
      onUpdateItem={onUpdateItem}
      onModeChange={onModeChange}
      layoutMode={layoutMode}
      onLayoutModeChange={onLayoutModeChange}
      mapData={focusMapData}
      hallDefinitions={focusDisplayMergedHalls}
      hallOrder={focusMergedSettings.hallOrder}
      onMapVisibilityChange={onMapVisibilityChange}
      onAddItem={onAddItem}
      onEditRequest={onEditRequest}
      onDeleteRequest={onDeleteRequest}
      appZoomLevel={appZoomLevel}
      resumeState={resumeState}
      onSessionStateChange={onSessionStateChange}
      mapRotationAngle={mapRotationAngle}
      mapInitialRotationAngle={mapInitialRotationAngle}
      onMapRotationAngleChange={onMapRotationAngleChange}
      numberCellOutlineStyle={numberCellOutlineStyle}
      disablePriceUndefinedCheck={disablePriceUndefinedCheck}
    />
  );
};

export default FocusModeContainer;
