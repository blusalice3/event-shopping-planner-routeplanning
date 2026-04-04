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

  if (!activeEventName) return null;

  const executeModeItemIds = executeModeItems[activeEventName]?.[currentDay] || [];
  const eventMapData = mapData[activeEventName];
  const mapTabName = `${currentDay}マップ`;
  const focusHallDefinitions: HallDefinition[] | undefined =
    hallDefinitions[activeEventName]?.[mapTabName];
  const routeSettings = hallRouteSettings[activeEventName]?.[mapTabName];
  const focusHallOrder: string[] = routeSettings?.hallOrder && routeSettings.hallOrder.length > 0
    ? routeSettings.hallOrder
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
