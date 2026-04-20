import React, { useEffect, useMemo } from 'react';
import FocusMode from '../../../components/FocusMode';
import { buildMergedHallRouteSettings } from '../../../utils/mergedHallRouteSettings';
import type {
  ExecuteModeItems,
  FocusModeSessionState,
  HallDefinitionsStore,
  HallRouteSettingsStore,
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

  // マップ定義 + mapless ホール定義を統合した情報
  const {
    mergedHalls: focusMergedHalls,
    mergedSettings: focusMergedSettings,
  } = useMemo(
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
      hasMapTab,
      mapTabName,
      hallDefinitions,
      hallRouteSettings,
      executeModeItemIds,
      items,
      mapData,
    ],
  );

  // FocusMode に渡す mapData（イベント別の分岐を吸収）
  const focusMapData = useMemo(() => {
    if (!activeEventName) return undefined;
    return mapData[activeEventName] || undefined;
  }, [activeEventName, mapData]);

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
      hallDefinitions={focusMergedHalls}
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
