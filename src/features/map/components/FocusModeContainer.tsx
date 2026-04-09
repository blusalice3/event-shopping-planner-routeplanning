import React, { useMemo } from 'react';
import FocusMode from '../../../components/FocusMode';
import type {
  ExecuteModeItems,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  FocusModeSessionState,
  MapDataStore,
  NumberCellOutlineStyle,
  PurchaseStatus,
  ShoppingItem,
} from '../../../types';
import { buildMergedHallRouteSettings } from '../../../utils/mergedHallRouteSettings';

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
  mapRotationAngle = 0,
  mapInitialRotationAngle = 0,
  onMapRotationAngleChange,
  numberCellOutlineStyle,
}) => {
  const currentDay = useMemo(
    () => (eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''),
    [activeTab, eventDates],
  );

  const mapTabName = `${currentDay}マップ`;
  const hasMapTab = !!(activeEventName && hallDefinitions[activeEventName]?.[mapTabName]);
  const executeModeItemIds = activeEventName
    ? executeModeItems[activeEventName]?.[currentDay] || []
    : [];

  // App.tsx の globalHallOrderRouteSettings と同じ実装で hallOrder を構築する
  // (map+mapless ホール統合 + 未定義系優先度キーの動的注入)。
  // これにより HallOrderPanel で並べ替えた順序が集中モードでも一致する。
  const { mergedHalls: focusMergedHalls, mergedSettings: focusMergedSettings } = useMemo(
    () =>
      buildMergedHallRouteSettings({
        eventName: activeEventName,
        dayName: currentDay,
        mapTabName: hasMapTab ? mapTabName : null,
        hallDefinitionsStore: hallDefinitions,
        hallRouteSettingsStore: hallRouteSettings,
        executeIds: executeModeItemIds,
        items,
        mapDataStore: mapData,
      }),
    [
      activeEventName,
      currentDay,
      mapTabName,
      hasMapTab,
      hallDefinitions,
      hallRouteSettings,
      executeModeItemIds,
      items,
      mapData,
    ],
  );

  if (!activeEventName) return null;

  const eventMapData = mapData[activeEventName];
  const focusHallDefinitions: HallDefinition[] | undefined =
    focusMergedHalls.length > 0 ? focusMergedHalls : undefined;
  const focusHallOrder: string[] =
    focusMergedSettings.hallOrder.length > 0
      ? focusMergedSettings.hallOrder
      : (focusHallDefinitions || []).map((h) => h.id);

  return (
    <FocusMode
      items={items}
      executeModeItemIds={executeModeItemIds}
      onUpdateItem={onUpdateItem}
      onModeChange={onModeChange}
      layoutMode={layoutMode}
      onLayoutModeChange={onLayoutModeChange}
      mapData={eventMapData}
      hallDefinitions={focusHallDefinitions}
      hallOrder={focusHallOrder}
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
    />
  );
};

export default FocusModeContainer;
