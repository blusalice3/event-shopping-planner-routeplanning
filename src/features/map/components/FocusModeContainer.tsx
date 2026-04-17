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
  mapRotationAngle = 0,
  mapInitialRotationAngle = 0,
  onMapRotationAngleChange,
  numberCellOutlineStyle,
  disablePriceUndefinedCheck,
}) => {
  const currentDay = useMemo(
    () => (eventDates.includes(activeTab) ? activeTab : eventDates[0] || ''),
    [activeTab, eventDates],
  );

  const mapTabName = `${currentDay}マップ`;
  const hasMapTab = !!(activeEventName && hallDefinitions[activeEventName]?.[mapTabName]);
  const executeModeItemIds = useMemo(
    () => (activeEventName ? executeModeItems[activeEventName]?.[currentDay] || [] : []),
    [activeEventName, executeModeItems, currentDay],
  );

  // App.tsx の globalHallOrderRouteSettings と同じ実装で hallOrder を構築する
  // (map+mapless ホール統合 + 未定義系優先度キーの動的注入)。
  // これにより HallOrderPanel で並べ替えた順序が集中モードでも一致する。
  //
  // buildMergedHallRouteSettings は items を Map 化し、executeIds ごとに
  // findItemHallId(block / manualHallId 経由) と priorityLevel を参照して hallOrder を構築する。
  // status/quantity/price/remarks 編集では結果が変わらないため、items 参照ではなく
  // 結果に影響するフィールドのみを連結した構造キーを useMemo の dep として使う。
  const structuralItemsKey = useMemo(() => {
    let key = '';
    for (const it of items) {
      key += `${it.id}|${it.block}|${it.manualHallId ?? ''}|${it.priorityLevel ?? ''}|${it.eventDate ?? ''};`;
    }
    return key;
  }, [items]);

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
    // items は構造キー経由で比較するため直接 deps に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      activeEventName,
      currentDay,
      mapTabName,
      hasMapTab,
      hallDefinitions,
      hallRouteSettings,
      executeModeItemIds,
      structuralItemsKey,
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
      disablePriceUndefinedCheck={disablePriceUndefinedCheck}
    />
  );
};

export default FocusModeContainer;
