import React, { Suspense } from "react";
import EventListScreen from "../../../components/EventListScreen";
import ShoppingList from "../../../components/ShoppingList";
import SortAscendingIcon from "../../../components/icons/SortAscendingIcon";
import SortDescendingIcon from "../../../components/icons/SortDescendingIcon";
import { MapView } from "../../../components/map";
import { getSpaceKey } from "../../../utils/spaceGrouping";
import type { BulkAddMetadata } from "../../../features/events/bulkAdd";
import type {
  DayMapData,
  DayMapRotationState,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettings,
  HallRouteSettingsStore,
  MapDataStore,
  MapViewportState,
  NumberCellOutlineStyle,
} from "../../../types/map";
import type {
  ExecuteModeItems,
  PurchaseStatusControlMode,
  ShoppingItem,
  ViewMode,
} from "../../../types/item";
import type { FocusModeSessionState } from "../../../types/focus";
import type {
  ActiveTab,
  CellSelectionMode,
  LayoutMode,
  RangeSelectionState,
  SmartInsertMode,
  VertexGuideOptions,
  VertexSelectionMode,
} from "../types";

const ImportScreen = React.lazy(
  () => import("../../../components/ImportScreen"),
);
const FocusModeContainer = React.lazy(
  () => import("../../../features/map/components/FocusModeContainer"),
);

type EventListScreenProps = React.ComponentProps<typeof EventListScreen>;
type ShoppingListProps = React.ComponentProps<typeof ShoppingList>;
type MapViewProps = React.ComponentProps<typeof MapView>;

type AppMainContentProps = {
  activeEventDate: string;
  activeEventName: string | null;
  activeTab: ActiveTab;
  availableBlocks: string[];
  blocksWithPriorityRemarks: Set<string>;
  candidateColumnItems: ShoppingItem[];
  candidateNumberSortDirection: "asc" | "desc" | null;
  cellSelectionMode: CellSelectionMode;
  collapsedSpaces: Set<string>;
  currentFocusMapRotationState: DayMapRotationState;
  currentFocusResumeState: FocusModeSessionState | null;
  currentFocusSessionKey: string | null;
  currentHallRouteSettings: HallRouteSettings;
  currentHalls: HallDefinition[];
  currentMapData: DayMapData | null;
  currentMapExecuteItemIds: string[];
  currentMapTabName: string | null;
  currentMapTabRotationState: DayMapRotationState;
  currentMapTabViewport: MapViewportState | undefined;
  currentMode: ViewMode;
  disablePriceUndefinedCheck: boolean;
  disableLimitedPurchaseQuantityCheck: boolean;
  skipLimitedPurchaseForSingleQuantity: boolean;
  postEventDistributionCheckEnabled: boolean;
  duplicateCircleItemIds: Set<string>;
  eventDates: string[];
  eventLists: Record<string, ShoppingItem[]>;
  executeCollapsedSpaces: Set<string>;
  executeColumnItems: ShoppingItem[];
  executeModeItems: Record<string, ExecuteModeItems>;
  executeSpaceGroupingEnabled: boolean;
  exportFileInputRef: React.RefObject<HTMLInputElement | null>;
  getHallOrderForDate: (eventDate: string) => string[];
  getHallsForDate: (eventDate: string) => HallDefinition[];
  getMapDataForDate: (eventDate: string) => DayMapData | null;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  handleActivateLateFilter: () => void;
  handleActivatePostponeFilter: () => void;
  handleAddItemFromFocusMode: NonNullable<ShoppingListProps["onAddItem"]>;
  handleAddNewItemFromMap: NonNullable<MapViewProps["onAddNewItem"]>;
  handleAddToExecuteListFromMap: MapViewProps["onAddToExecuteList"];
  handleAddToExecuteListFromMapAtPosition: NonNullable<
    MapViewProps["onAddToExecuteListAtPosition"]
  >;
  handleBatchAddToExecuteListFromMap: NonNullable<
    MapViewProps["onBatchAddToExecuteList"]
  >;
  handleBatchAddToExecuteListFromMapAtPosition: NonNullable<
    MapViewProps["onBatchAddToExecuteListAtPosition"]
  >;
  handleBatchRemoveFromExecuteListFromMap: NonNullable<
    MapViewProps["onBatchRemoveFromExecuteList"]
  >;
  handleBulkAdd: (
    eventName: string,
    items: Omit<ShoppingItem, "id" | "purchaseStatus">[],
    metadata?: BulkAddMetadata,
  ) => void;
  handleBulkStatusChange: NonNullable<ShoppingListProps["onBulkStatusChange"]>;
  handleCandidateNumberSort: () => void;
  handleClearBlockFilters: () => void;
  handleClearNewItemDefaults: () => void;
  handleClearRangeSelection: () => void;
  handleCollapseAndOpenNext: NonNullable<
    ShoppingListProps["onCollapseAndOpenNext"]
  >;
  handleDeleteEvent: EventListScreenProps["onDelete"];
  handleDeleteItemFromMap: NonNullable<MapViewProps["onDeleteItem"]>;
  handleDeleteRequest: ShoppingListProps["onDeleteRequest"];
  handleDoneEditing: () => void;
  handleEditRequest: ShoppingListProps["onEditRequest"];
  handleExecuteItemUpdate: ShoppingListProps["onUpdateItem"];
  handleExecuteSpaceGroupOrderChange: NonNullable<
    ShoppingListProps["onSpaceGroupOrderChange"]
  >;
  handleExecuteToggleAllSpaceCollapse: NonNullable<
    ShoppingListProps["onToggleAllSpaceCollapse"]
  >;
  handleExecuteToggleSpaceCollapse: NonNullable<
    ShoppingListProps["onToggleSpaceCollapse"]
  >;
  handleExportEvent: EventListScreenProps["onExport"];
  handleFocusMapRotationAngleChange: (angle: number) => void;
  handleFocusSessionStateChange: (state: FocusModeSessionState) => void;
  handleImportMapData: NonNullable<EventListScreenProps["onImportMap"]>;
  handleMapTabRotationAngleChange: (angle: number) => void;
  handleMapViewportChange: (viewport: MapViewportState) => void;
  handleModeChangeFromFocus: (
    mode: "edit" | "execute",
    lastItemId?: string,
  ) => void;
  handleMoveItem: ShoppingListProps["onMoveItem"];
  handleMoveItemDown: NonNullable<ShoppingListProps["onMoveItemDown"]>;
  handleMoveItemUp: NonNullable<ShoppingListProps["onMoveItemUp"]>;
  handleMoveToExecuteColumn: NonNullable<ShoppingListProps["onMoveToColumn"]>;
  handleMoveToFirstFromMap: MapViewProps["onMoveToFirst"];
  handleMoveToLastFromMap: MapViewProps["onMoveToLast"];
  handleRemoveFromExecuteColumn: NonNullable<
    ShoppingListProps["onRemoveFromColumn"]
  >;
  handleRemoveFromExecuteListFromMap: MapViewProps["onRemoveFromExecuteList"];
  handleRenameEvent: NonNullable<EventListScreenProps["onRename"]>;
  handleReorderExecuteListByHallOrder: NonNullable<
    MapViewProps["onReorderExecuteList"]
  >;
  handleSelectEvent: EventListScreenProps["onSelect"];
  handleSelectItem: ShoppingListProps["onSelectItem"];
  handleSelectSpaceGroupForRange: NonNullable<
    ShoppingListProps["onSelectSpaceGroupForRange"]
  >;
  handleSetSpaceGroupDragItemIds: NonNullable<
    ShoppingListProps["onSetSpaceGroupDragItemIds"]
  >;
  handleToggleAllSpaceCollapse: NonNullable<
    ShoppingListProps["onToggleAllSpaceCollapse"]
  >;
  handleToggleBlockFilter: (block: string) => void;
  handleToggleRangeSelection: NonNullable<
    ShoppingListProps["onToggleRangeSelection"]
  >;
  handleToggleSpaceCollapse: NonNullable<
    ShoppingListProps["onToggleSpaceCollapse"]
  >;
  handleUpdateEvent: NonNullable<EventListScreenProps["onUpdate"]>;
  handleUpdateHallRouteSettings: MapViewProps["onUpdateHallRouteSettings"];
  handleUpdateItem: ShoppingListProps["onUpdateItem"];
  handleUpdateItemPriorityFromEdit: NonNullable<
    MapViewProps["onUpdateItemPriority"]
  >;
  highlightedItemId: string | null;
  highlightedMapCell: { row: number; col: number } | null;
  isMapTab: boolean;
  items: ShoppingItem[];
  itemToEdit: ShoppingItem | null;
  layoutMode: LayoutMode;
  mainContentVisible: boolean;
  mapData: MapDataStore;
  mapIsHallOrderOpen: boolean;
  mapIsRouteVisible: boolean;
  mapSelectedHallId: string;
  mapSmartInsertEnabled: boolean;
  mapSmartInsertMode: SmartInsertMode;
  newItemDefaults: { eventDate: string; block: string; number: string } | null;
  numberCellOutlineStyle: NumberCellOutlineStyle;
  purchaseStatusControlMode: PurchaseStatusControlMode;
  rangeEnd: RangeSelectionState;
  rangeStart: RangeSelectionState;
  selectedBlockFilters: Set<string>;
  selectedItemIds: Set<string>;
  setCollapsedSpaces: React.Dispatch<React.SetStateAction<Set<string>>>;
  setFocusModeMapVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setLayoutMode: React.Dispatch<React.SetStateAction<LayoutMode>>;
  setMapIsHallOrderOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMapIsRouteVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setMapSelectedHallId: React.Dispatch<React.SetStateAction<string>>;
  setSpaceGroupingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  showLateFilterButton: boolean;
  showPostponeFilterButton: boolean;
  spaceGroupingEnabled: boolean;
  vertexGuideOptions: VertexGuideOptions;
  vertexSelectionMode: VertexSelectionMode;
  visibleItems: ShoppingItem[];
  visitListPanelOpen: boolean;
  zoomLevel: number;
};

const AppMainContent: React.FC<AppMainContentProps> = (props) => {
  const {
    activeEventDate,
    activeEventName,
    activeTab,
    availableBlocks,
    blocksWithPriorityRemarks,
    candidateColumnItems,
    candidateNumberSortDirection,
    cellSelectionMode,
    collapsedSpaces,
    currentFocusMapRotationState,
    currentFocusResumeState,
    currentFocusSessionKey,
    currentHallRouteSettings,
    currentHalls,
    currentMapData,
    currentMapExecuteItemIds,
    currentMapTabName,
    currentMapTabRotationState,
    currentMapTabViewport,
    currentMode,
    disablePriceUndefinedCheck,
    disableLimitedPurchaseQuantityCheck,
    skipLimitedPurchaseForSingleQuantity,
    postEventDistributionCheckEnabled,
    duplicateCircleItemIds,
    eventDates,
    eventLists,
    executeCollapsedSpaces,
    executeColumnItems,
    executeModeItems,
    executeSpaceGroupingEnabled,
    exportFileInputRef,
    getHallOrderForDate,
    getHallsForDate,
    getMapDataForDate,
    hallDefinitions,
    hallRouteSettings,
    handleActivateLateFilter,
    handleActivatePostponeFilter,
    handleAddItemFromFocusMode,
    handleAddNewItemFromMap,
    handleAddToExecuteListFromMap,
    handleAddToExecuteListFromMapAtPosition,
    handleBatchAddToExecuteListFromMap,
    handleBatchAddToExecuteListFromMapAtPosition,
    handleBatchRemoveFromExecuteListFromMap,
    handleBulkAdd,
    handleBulkStatusChange,
    handleCandidateNumberSort,
    handleClearBlockFilters,
    handleClearNewItemDefaults,
    handleClearRangeSelection,
    handleCollapseAndOpenNext,
    handleDeleteEvent,
    handleDeleteItemFromMap,
    handleDeleteRequest,
    handleDoneEditing,
    handleEditRequest,
    handleExecuteItemUpdate,
    handleExecuteSpaceGroupOrderChange,
    handleExecuteToggleAllSpaceCollapse,
    handleExecuteToggleSpaceCollapse,
    handleExportEvent,
    handleFocusMapRotationAngleChange,
    handleFocusSessionStateChange,
    handleImportMapData,
    handleMapTabRotationAngleChange,
    handleMapViewportChange,
    handleModeChangeFromFocus,
    handleMoveItem,
    handleMoveItemDown,
    handleMoveItemUp,
    handleMoveToExecuteColumn,
    handleMoveToFirstFromMap,
    handleMoveToLastFromMap,
    handleRemoveFromExecuteColumn,
    handleRemoveFromExecuteListFromMap,
    handleRenameEvent,
    handleReorderExecuteListByHallOrder,
    handleSelectEvent,
    handleSelectItem,
    handleSelectSpaceGroupForRange,
    handleSetSpaceGroupDragItemIds,
    handleToggleAllSpaceCollapse,
    handleToggleBlockFilter,
    handleToggleRangeSelection,
    handleToggleSpaceCollapse,
    handleUpdateEvent,
    handleUpdateHallRouteSettings,
    handleUpdateItem,
    handleUpdateItemPriorityFromEdit,
    highlightedItemId,
    highlightedMapCell,
    isMapTab,
    items,
    itemToEdit,
    layoutMode,
    mainContentVisible,
    mapData,
    mapIsHallOrderOpen,
    mapIsRouteVisible,
    mapSelectedHallId,
    mapSmartInsertEnabled,
    mapSmartInsertMode,
    newItemDefaults,
    numberCellOutlineStyle,
    purchaseStatusControlMode,
    rangeEnd,
    rangeStart,
    selectedBlockFilters,
    selectedItemIds,
    setCollapsedSpaces,
    setFocusModeMapVisible,
    setLayoutMode,
    setMapIsHallOrderOpen,
    setMapIsRouteVisible,
    setMapSelectedHallId,
    setSpaceGroupingEnabled,
    showLateFilterButton,
    showPostponeFilterButton,
    spaceGroupingEnabled,
    vertexGuideOptions,
    vertexSelectionMode,
    visibleItems,
    visitListPanelOpen,
    zoomLevel,
  } = props;

  const currentMapRouteHallOrder = React.useMemo(
    () => (activeEventDate ? getHallOrderForDate(activeEventDate) : []),
    [activeEventDate, getHallOrderForDate],
  );

  const editSpaceGroupKeys = React.useMemo(() => {
    const groupKeys = new Set<string>();
    items
      .filter((item) => item.eventDate === activeEventDate)
      .forEach((item) => {
        const spaceKey = getSpaceKey(item.block, item.number);
        const priority = item.priorityLevel || "none";
        groupKeys.add(
          priority !== "none" ? `${spaceKey}:${priority}` : spaceKey,
        );
      });
    return Array.from(groupKeys);
  }, [activeEventDate, items]);

  const allEditSpaceGroupsCollapsed =
    editSpaceGroupKeys.length > 0 &&
    editSpaceGroupKeys.every((groupKey) => collapsedSpaces.has(groupKey));

  return (
    <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
      {activeTab === "eventList" && (
        <EventListScreen
          eventNames={Object.keys(eventLists).sort()}
          onSelect={handleSelectEvent}
          onDelete={handleDeleteEvent}
          onExport={handleExportEvent}
          onUpdate={handleUpdateEvent}
          onRename={(oldName) => handleRenameEvent(oldName)}
          onImportMap={handleImportMapData}
          onImportExportFile={() => exportFileInputRef.current?.click()}
        />
      )}
      {activeTab === "import" && (
        <Suspense
          fallback={
            <div className="flex justify-center p-8">
              <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
            </div>
          }
        >
          <ImportScreen
            onBulkAdd={handleBulkAdd}
            activeEventName={activeEventName}
            itemToEdit={itemToEdit}
            onUpdateItem={handleUpdateItem}
            onDoneEditing={handleDoneEditing}
            newItemDefaults={newItemDefaults}
            onClearNewItemDefaults={handleClearNewItemDefaults}
          />
        </Suspense>
      )}
      {/* 表示処理の補足 */}
      {activeEventName && isMapTab && currentMapData && currentMapTabName && (
        <MapView
          mapData={currentMapData}
          mapName={currentMapTabName}
          items={items}
          executeModeItemIds={currentMapExecuteItemIds}
          routeHallOrder={currentMapRouteHallOrder}
          onAddToExecuteList={handleAddToExecuteListFromMap}
          onAddToExecuteListAtPosition={handleAddToExecuteListFromMapAtPosition}
          onRemoveFromExecuteList={handleRemoveFromExecuteListFromMap}
          onBatchAddToExecuteList={handleBatchAddToExecuteListFromMap}
          onBatchAddToExecuteListAtPosition={
            handleBatchAddToExecuteListFromMapAtPosition
          }
          onBatchRemoveFromExecuteList={handleBatchRemoveFromExecuteListFromMap}
          onMoveToFirst={handleMoveToFirstFromMap}
          onMoveToLast={handleMoveToLastFromMap}
          onUpdateItem={handleUpdateItem}
          onUpdateItemPriority={handleUpdateItemPriorityFromEdit}
          onDeleteItem={handleDeleteItemFromMap}
          onEditRequest={handleEditRequest}
          onAddNewItem={handleAddNewItemFromMap}
          onAddItem={handleAddItemFromFocusMode}
          halls={currentHalls}
          hallRouteSettings={currentHallRouteSettings}
          onUpdateHallRouteSettings={handleUpdateHallRouteSettings}
          onReorderExecuteList={handleReorderExecuteListByHallOrder}
          vertexSelectionMode={vertexSelectionMode}
          cellSelectionMode={cellSelectionMode}
          highlightedCell={visitListPanelOpen ? highlightedMapCell : null}
          externalSelectedHallId={mapSelectedHallId}
          onSelectedHallIdChange={setMapSelectedHallId}
          externalIsRouteVisible={mapIsRouteVisible}
          onRouteVisibleChange={setMapIsRouteVisible}
          externalIsHallOrderOpen={mapIsHallOrderOpen}
          onHallOrderOpenChange={setMapIsHallOrderOpen}
          hideInternalControls={true}
          smartInsertEnabled={mapSmartInsertEnabled}
          smartInsertMode={mapSmartInsertMode}
          rotationAngle={currentMapTabRotationState.mapTabAngle}
          onRotationAngleChange={handleMapTabRotationAngleChange}
          selectionGuideOptions={vertexGuideOptions}
          initialViewport={currentMapTabViewport}
          onViewportChange={handleMapViewportChange}
          numberCellOutlineStyle={numberCellOutlineStyle}
        />
      )}
      {activeEventName && mainContentVisible && !isMapTab && (
        <div
          style={{
            transform: `scale(${zoomLevel / 100})`,
            transformOrigin: "top left",
            width: `${100 * (100 / zoomLevel)}%`,
          }}
        >
          {currentMode === "edit" ? (
            <div className="grid grid-cols-2 gap-4">
              {/* 表示処理の補足 */}
              <div className="space-y-2">
                <div className="bg-blue-50 dark:bg-blue-900/20 border-2 border-blue-300 dark:border-blue-700 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-blue-900 dark:text-blue-100">
                      実行リストアイテム
                    </h3>
                    <div className="flex flex-col items-end gap-2">
                      <button
                        onClick={() => {
                          setSpaceGroupingEnabled((prev: boolean) => !prev);
                          setCollapsedSpaces(new Set());
                          handleClearRangeSelection();
                        }}
                        className={`px-2 py-0.5 text-xs font-medium rounded transition-colors ${
                          spaceGroupingEnabled
                            ? "bg-blue-600 text-white dark:bg-blue-500"
                            : "bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600"
                        }`}
                      >
                        スペース別
                      </button>
                      {spaceGroupingEnabled && (
                        <button
                          onClick={() =>
                            handleToggleAllSpaceCollapse(
                              !allEditSpaceGroupsCollapsed,
                            )
                          }
                          className="text-xs px-2 py-1 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
                        >
                          {allEditSpaceGroupsCollapsed
                            ? "全て展開"
                            : "全て折りたたむ"}
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-blue-700 dark:text-blue-300 mb-3">
                    実行対象として選択中のアイテムを管理します。
                  </p>
                </div>
                <ShoppingList
                  items={executeColumnItems}
                  onUpdateItem={handleUpdateItem}
                  onMoveItem={handleMoveItem}
                  onEditRequest={handleEditRequest}
                  onDeleteRequest={handleDeleteRequest}
                  selectedItemIds={selectedItemIds}
                  onSelectItem={handleSelectItem}
                  onRemoveFromColumn={handleRemoveFromExecuteColumn}
                  onMoveToColumn={handleMoveToExecuteColumn}
                  columnType="execute"
                  currentDay={activeEventDate}
                  rangeScopeId={activeEventName ?? ""}
                  onMoveItemUp={handleMoveItemUp}
                  onMoveItemDown={handleMoveItemDown}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  onToggleRangeSelection={handleToggleRangeSelection}
                  duplicateCircleItemIds={duplicateCircleItemIds}
                  highlightedItemId={highlightedItemId}
                  layoutMode={layoutMode}
                  viewMode="edit"
                  showHallGroups={!spaceGroupingEnabled}
                  hallDefinitions={getHallsForDate(activeEventDate)}
                  hallOrder={getHallOrderForDate(activeEventDate)}
                  mapData={getMapDataForDate(activeEventDate)}
                  showSpaceGroups={spaceGroupingEnabled}
                  collapsedSpaces={collapsedSpaces}
                  onToggleSpaceCollapse={handleToggleSpaceCollapse}
                  onSetSpaceGroupDragItemIds={handleSetSpaceGroupDragItemIds}
                  onSelectSpaceGroupForRange={handleSelectSpaceGroupForRange}
                  onAddItem={handleAddItemFromFocusMode}
                  purchaseStatusControlMode={purchaseStatusControlMode}
                  skipLimitedPurchaseForSingleQuantity={
                    skipLimitedPurchaseForSingleQuantity
                  }
                />
              </div>

              {/* 表示処理の補足 */}
              <div className="space-y-2">
                <div className="bg-slate-100 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-700 rounded-lg p-3">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-2">
                    候補アイテム
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                    このリストから選択したアイテムを実行リストへ移動します。
                  </p>
                  {availableBlocks.length > 0 && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                          ブロックでフィルタ:
                        </span>
                        <div className="flex items-center gap-2">
                          {selectedBlockFilters.size > 0 && (
                            <>
                              <button
                                onClick={handleCandidateNumberSort}
                                className={`p-1.5 rounded-md transition-colors ${
                                  candidateNumberSortDirection
                                    ? "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300"
                                    : "bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400 border border-slate-300 dark:border-slate-600"
                                }`}
                                title={
                                  candidateNumberSortDirection === "desc"
                                    ? "番号を降順で並べ替え"
                                    : candidateNumberSortDirection === "asc"
                                      ? "番号を昇順で並べ替え"
                                      : "番号で並べ替え"
                                }
                              >
                                {candidateNumberSortDirection === "desc" ? (
                                  <SortDescendingIcon className="w-4 h-4" />
                                ) : (
                                  <SortAscendingIcon className="w-4 h-4" />
                                )}
                              </button>
                              <button
                                onClick={handleClearBlockFilters}
                                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 underline"
                              >
                                すべて解除
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {availableBlocks.map((block: string) => (
                          <button
                            key={block}
                            onClick={() => handleToggleBlockFilter(block)}
                            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                              selectedBlockFilters.has(block)
                                ? "bg-blue-600 text-white dark:bg-blue-500"
                                : blocksWithPriorityRemarks.has(block)
                                  ? "bg-yellow-300 dark:bg-yellow-600 text-slate-700 dark:text-slate-300 hover:bg-yellow-400 dark:hover:bg-yellow-500 border border-slate-300 dark:border-slate-600"
                                  : "bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600"
                            }`}
                          >
                            {block}
                          </button>
                        ))}
                      </div>
                      {selectedBlockFilters.size > 0 && (
                        <p className="text-xs text-slate-600 dark:text-slate-400 mt-2">
                          選択中: {selectedBlockFilters.size}件のブロック
                        </p>
                      )}
                    </div>
                  )}
                </div>
                <ShoppingList
                  items={candidateColumnItems}
                  onUpdateItem={handleUpdateItem}
                  onMoveItem={handleMoveItem}
                  onEditRequest={handleEditRequest}
                  onDeleteRequest={handleDeleteRequest}
                  selectedItemIds={selectedItemIds}
                  onSelectItem={handleSelectItem}
                  onMoveToColumn={handleMoveToExecuteColumn}
                  onRemoveFromColumn={handleRemoveFromExecuteColumn}
                  columnType="candidate"
                  currentDay={activeEventDate}
                  rangeScopeId={activeEventName ?? ""}
                  onMoveItemUp={handleMoveItemUp}
                  onMoveItemDown={handleMoveItemDown}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  onToggleRangeSelection={handleToggleRangeSelection}
                  duplicateCircleItemIds={duplicateCircleItemIds}
                  highlightedItemId={highlightedItemId}
                  layoutMode={layoutMode}
                  viewMode="edit"
                  showSpaceGroups={spaceGroupingEnabled}
                  collapsedSpaces={collapsedSpaces}
                  onToggleSpaceCollapse={handleToggleSpaceCollapse}
                  onSetSpaceGroupDragItemIds={handleSetSpaceGroupDragItemIds}
                  onSelectSpaceGroupForRange={handleSelectSpaceGroupForRange}
                  onAddItem={handleAddItemFromFocusMode}
                  purchaseStatusControlMode={purchaseStatusControlMode}
                  skipLimitedPurchaseForSingleQuantity={
                    skipLimitedPurchaseForSingleQuantity
                  }
                />
              </div>
            </div>
          ) : currentMode === "focus" ? (
            <Suspense
              fallback={
                <div className="flex justify-center p-8">
                  <div className="animate-spin h-8 w-8 border-4 border-blue-500 border-t-transparent rounded-full" />
                </div>
              }
            >
              <FocusModeContainer
                key={currentFocusSessionKey || "focus-mode"}
                activeEventName={activeEventName}
                activeTab={activeTab}
                eventDates={eventDates}
                items={items}
                executeModeItems={executeModeItems}
                mapData={mapData}
                hallDefinitions={hallDefinitions}
                hallRouteSettings={hallRouteSettings}
                onUpdateItem={handleUpdateItem}
                onModeChange={handleModeChangeFromFocus}
                layoutMode={layoutMode}
                onLayoutModeChange={setLayoutMode}
                onMapVisibilityChange={setFocusModeMapVisible}
                onAddItem={handleAddItemFromFocusMode}
                onEditRequest={handleEditRequest}
                onDeleteRequest={handleDeleteRequest}
                appZoomLevel={zoomLevel}
                resumeState={currentFocusResumeState}
                onSessionStateChange={handleFocusSessionStateChange}
                mapRotationAngle={currentFocusMapRotationState.focusModeAngle}
                mapInitialRotationAngle={
                  currentFocusMapRotationState.initialAngle
                }
                onMapRotationAngleChange={handleFocusMapRotationAngleChange}
                numberCellOutlineStyle={numberCellOutlineStyle}
                disablePriceUndefinedCheck={disablePriceUndefinedCheck}
                disableLimitedPurchaseQuantityCheck={
                  disableLimitedPurchaseQuantityCheck
                }
                skipLimitedPurchaseForSingleQuantity={
                  skipLimitedPurchaseForSingleQuantity
                }
                postEventDistributionCheckEnabled={
                  postEventDistributionCheckEnabled
                }
                purchaseStatusControlMode={purchaseStatusControlMode}
              />
            </Suspense>
          ) : (
            <ShoppingList
              items={visibleItems}
              onUpdateItem={handleExecuteItemUpdate}
              onMoveItem={handleMoveItem}
              onEditRequest={handleEditRequest}
              onDeleteRequest={handleDeleteRequest}
              selectedItemIds={selectedItemIds}
              onSelectItem={handleSelectItem}
              columnType="execute"
              currentDay={activeEventDate}
              rangeScopeId={activeEventName ?? ""}
              onMoveItemUp={handleMoveItemUp}
              onMoveItemDown={handleMoveItemDown}
              rangeStart={rangeStart}
              rangeEnd={rangeEnd}
              onToggleRangeSelection={handleToggleRangeSelection}
              duplicateCircleItemIds={duplicateCircleItemIds}
              highlightedItemId={highlightedItemId}
              layoutMode={layoutMode}
              viewMode="execute"
              showSpaceGroups={executeSpaceGroupingEnabled}
              showHallGroups={!executeSpaceGroupingEnabled}
              collapsedSpaces={executeCollapsedSpaces}
              onToggleSpaceCollapse={handleExecuteToggleSpaceCollapse}
              onToggleAllSpaceCollapse={handleExecuteToggleAllSpaceCollapse}
              onAddItem={handleAddItemFromFocusMode}
              onBulkStatusChange={handleBulkStatusChange}
              onSpaceGroupOrderChange={handleExecuteSpaceGroupOrderChange}
              onCollapseAndOpenNext={handleCollapseAndOpenNext}
              disablePriceUndefinedCheck={disablePriceUndefinedCheck}
              disableLimitedPurchaseQuantityCheck={
                disableLimitedPurchaseQuantityCheck
              }
              skipLimitedPurchaseForSingleQuantity={
                skipLimitedPurchaseForSingleQuantity
              }
              postEventDistributionCheckEnabled={
                postEventDistributionCheckEnabled
              }
              showPostponeFilterButton={showPostponeFilterButton}
              onActivatePostponeFilter={handleActivatePostponeFilter}
              showLateFilterButton={showLateFilterButton}
              onActivateLateFilter={handleActivateLateFilter}
              hallDefinitions={getHallsForDate(activeEventDate)}
              hallOrder={getHallOrderForDate(activeEventDate)}
              mapData={getMapDataForDate(activeEventDate)}
              purchaseStatusControlMode={purchaseStatusControlMode}
            />
          )}
        </div>
      )}
    </main>
  );
};

export default AppMainContent;
