import React, { useMemo } from 'react';
import FocusMode from '../../../components/FocusMode';
import type {
  ExecuteModeItems,
  HallDefinition,
  HallDefinitionsStore,
  FocusModeSessionState,
  MapDataStore,
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
};

const FocusModeContainer: React.FC<FocusModeContainerProps> = ({
  activeEventName,
  activeTab,
  eventDates,
  items,
  executeModeItems,
  mapData,
  hallDefinitions,
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
}) => {
  const currentDay = useMemo(
    () => (eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''),
    [activeTab, eventDates],
  );

  if (!activeEventName) return null;

  const executeModeItemIds = executeModeItems[activeEventName]?.[currentDay] || [];
  const eventMapData = mapData[activeEventName];
  const focusHallDefinitions: HallDefinition[] | undefined =
    hallDefinitions[activeEventName]?.[`${currentDay}マップ`];

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
      onMapVisibilityChange={onMapVisibilityChange}
      onAddItem={onAddItem}
      onEditRequest={onEditRequest}
      onDeleteRequest={onDeleteRequest}
      appZoomLevel={appZoomLevel}
      resumeState={resumeState}
      onSessionStateChange={onSessionStateChange}
    />
  );
};

export default FocusModeContainer;
