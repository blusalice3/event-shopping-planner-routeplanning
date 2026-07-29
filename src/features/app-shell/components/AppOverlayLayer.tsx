import React from "react";
import DeleteConfirmationModal from "../../../components/DeleteConfirmationModal";
import { ItemEditDialog } from "../../../components/ItemEditDialog";
import UpdateConfirmationModal from "../../../components/UpdateConfirmationModal";
import UrlUpdateDialog from "../../../components/UrlUpdateDialog";
import EventRenameDialog from "../../../components/EventRenameDialog";
import ExportOptionsDialog from "../../../components/ExportOptionsDialog";
import BulkActionControls from "../../../components/BulkActionControls";
import SummaryBar from "../../../components/SummaryBar";
import VisitListPanel from "../../../components/VisitListPanel";
import {
  BlockDefinitionPanel,
  HallDefinitionPanel,
  HallOrderPanel,
  SimpleHallDefinitionPanel,
  MapImportDialog,
  loadBlockDetectionSettings,
} from "../../../components/map";
import type { EventUpdateDiff } from "../../../features/events/updateDiff";
import type {
  ActiveTab,
  BulkSortDirection,
  CellSelectionMode,
  LayoutMode,
  PendingCellSelection,
  PendingVertexSelection,
  SortState,
  VertexGuideOptions,
  VertexSelectionMode,
} from "../types";
import type {
  EventMetadata,
  ShoppingItem,
  ViewMode,
} from "../../../types/item";
import type {
  HallDefinition,
  HallRouteSettings,
  MapDataStore,
} from "../../../types/map";

type PriorityLevel = "none" | "priority" | "highest";
type DeleteConfirmationModalProps = React.ComponentProps<
  typeof DeleteConfirmationModal
>;
type UpdateConfirmationModalProps = React.ComponentProps<
  typeof UpdateConfirmationModal
>;
type UrlUpdateDialogProps = React.ComponentProps<typeof UrlUpdateDialog>;
type EventRenameDialogProps = React.ComponentProps<typeof EventRenameDialog>;
type ExportOptionsDialogProps = React.ComponentProps<
  typeof ExportOptionsDialog
>;
type BlockDefinitionPanelProps = React.ComponentProps<
  typeof BlockDefinitionPanel
>;
type HallDefinitionPanelProps = React.ComponentProps<
  typeof HallDefinitionPanel
>;
type SimpleHallDefinitionPanelProps = React.ComponentProps<
  typeof SimpleHallDefinitionPanel
>;
type HallOrderPanelProps = React.ComponentProps<typeof HallOrderPanel>;
type VisitListPanelProps = React.ComponentProps<typeof VisitListPanel>;
type MapImportDialogProps = React.ComponentProps<typeof MapImportDialog>;

type AppOverlayLayerProps = {
  editDialogItem: ShoppingItem | null;
  items: ShoppingItem[];
  getHallsForDate: (eventDate: string) => HallDefinition[];
  handleUpdateItem: (item: ShoppingItem) => void;
  handleUpdateHallOrderForPriorityChangeFromEdit: (
    itemId: string,
    newPriorityLevel: PriorityLevel,
    oldPriorityLevel: PriorityLevel,
  ) => void;
  setEditDialogItem: React.Dispatch<React.SetStateAction<ShoppingItem | null>>;
  itemToDelete: ShoppingItem | null;
  handleConfirmDelete: DeleteConfirmationModalProps["onConfirm"];
  setItemToDelete: React.Dispatch<React.SetStateAction<ShoppingItem | null>>;
  showUpdateConfirmation: boolean;
  updateData: EventUpdateDiff | null;
  handleConfirmUpdate: UpdateConfirmationModalProps["onConfirm"];
  setShowUpdateConfirmation: React.Dispatch<React.SetStateAction<boolean>>;
  setUpdateData: React.Dispatch<React.SetStateAction<EventUpdateDiff | null>>;
  setUpdateEventName: React.Dispatch<React.SetStateAction<string | null>>;
  showUrlUpdateDialog: boolean;
  pendingUpdateEventName: string | null;
  eventMetadata: Record<string, EventMetadata>;
  handleUrlUpdate: UrlUpdateDialogProps["onConfirm"];
  setShowUrlUpdateDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingUpdateEventName: React.Dispatch<
    React.SetStateAction<string | null>
  >;
  setActiveEventName: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveTab: React.Dispatch<React.SetStateAction<ActiveTab>>;
  showRenameDialog: boolean;
  eventToRename: string | null;
  handleConfirmRename: EventRenameDialogProps["onConfirm"];
  setShowRenameDialog: React.Dispatch<React.SetStateAction<boolean>>;
  setEventToRename: React.Dispatch<React.SetStateAction<string | null>>;
  showExportOptions: boolean;
  exportEventName: string | null;
  setShowExportOptions: React.Dispatch<React.SetStateAction<boolean>>;
  setExportEventName: React.Dispatch<React.SetStateAction<string | null>>;
  handleConfirmExport: ExportOptionsDialogProps["onExport"];
  mapData: MapDataStore;
  blockDefinitionMode: boolean;
  currentMapData: BlockDefinitionPanelProps["mapData"] | null;
  setBlockDefinitionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingCellSelection: React.Dispatch<
    React.SetStateAction<PendingCellSelection>
  >;
  handleUpdateBlocks: BlockDefinitionPanelProps["onUpdateBlocks"];
  handleStartCellSelection: BlockDefinitionPanelProps["onStartCellSelection"];
  pendingCellSelection: PendingCellSelection;
  cellSelectionMode: CellSelectionMode;
  handleConfirmCellSelection: () => void;
  handleCancelCellSelection: () => void;
  simpleHallDefinitionMode: boolean;
  setSimpleHallDefinitionMode: React.Dispatch<React.SetStateAction<boolean>>;
  currentMaplessHalls: HallDefinition[];
  handleUpdateMaplessHalls: SimpleHallDefinitionPanelProps["onUpdateHalls"];
  allBlocksForHallDefinition: string[];
  eventDates: string[];
  activeEventDate: string;
  handleSyncMaplessHallsToOtherDates: NonNullable<
    SimpleHallDefinitionPanelProps["onSyncToOtherDates"]
  >;
  globalHallOrderPanelOpen: boolean;
  setGlobalHallOrderPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  globalHallOrderHalls: HallDefinition[];
  globalHallOrderRouteSettings: HallRouteSettings;
  handleUpdateGlobalHallRouteSettings: HallOrderPanelProps["onUpdateHallRouteSettings"];
  getGlobalHallItemCount: HallOrderPanelProps["getItemCountInHall"];
  handleReorderExecuteListByHallOrder: NonNullable<
    HallOrderPanelProps["onReorderExecuteList"]
  >;
  hallDefinitionMode: boolean;
  setHallDefinitionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setPendingVertexSelection: React.Dispatch<
    React.SetStateAction<PendingVertexSelection>
  >;
  currentHalls: HallDefinition[];
  handleUpdateHalls: HallDefinitionPanelProps["onUpdateHalls"];
  handleStartVertexSelection: HallDefinitionPanelProps["onStartVertexSelection"];
  pendingVertexSelection: PendingVertexSelection;
  mapTabDates: string[];
  handleSyncPolygonHallsToOtherDates: NonNullable<
    HallDefinitionPanelProps["onSyncToOtherDates"]
  >;
  visitListPanelOpen: boolean;
  handleVisitListClose: VisitListPanelProps["onClose"];
  visitListItems: ShoppingItem[];
  handleVisitListOrderUpdate: VisitListPanelProps["onUpdateOrder"];
  visitListHallOrder: string[];
  layoutMode: LayoutMode;
  handleHighlightMapCell: VisitListPanelProps["onHighlightCell"];
  handleClearMapCellHighlight: VisitListPanelProps["onClearHighlight"];
  visitListHasUnsavedChanges: boolean;
  handleVisitListConfirm: VisitListPanelProps["onConfirm"];
  handleVisitListCancel: VisitListPanelProps["onCancel"];
  handleUpdateItemPriority: NonNullable<
    VisitListPanelProps["onUpdateItemPriority"]
  >;
  showVisitListConfirmDialog: boolean;
  handleVisitListDialogCancel: () => void;
  handleVisitListDialogConfirm: () => void;
  vertexSelectionMode: VertexSelectionMode;
  vertexGuideOptions: VertexGuideOptions;
  setVertexGuideOptions: React.Dispatch<
    React.SetStateAction<VertexGuideOptions>
  >;
  handleConfirmVertexSelection: () => void;
  handleCancelVertexSelection: () => void;
  mapFileInputRef: React.RefObject<HTMLInputElement>;
  handleMapFileChange: (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => void | Promise<void>;
  mapImportDialogOpen: boolean;
  mapImportPendingFile: File | null;
  mapImportPendingEventName: string;
  handleMapImportConfirm: MapImportDialogProps["onImport"];
  handleMapImportClose: MapImportDialogProps["onClose"];
  exportFileInputRef: React.RefObject<HTMLInputElement>;
  handleExportFileImport: (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => void | Promise<void>;
  activeEventName: string | null;
  mainContentVisible: boolean;
  currentMode: ViewMode;
  visibleItems: ShoppingItem[];
  showHeaderBar: boolean;
  sortLabels: Record<SortState, string>;
  sortDisplayLabel: string;
  sortState: SortState;
  handleSortToggle: () => void;
  selectedItemIds: Set<string>;
  handleBulkSort: (direction: BulkSortDirection) => void;
  handleClearSelection: () => void;
  showMoveButtons: boolean;
  hasCandidateSelection: boolean;
  handleMoveToExecuteColumn: (itemIds: string[]) => void;
  hasExecuteSelection: boolean;
  handleRemoveFromExecuteColumn: (itemIds: string[]) => void;
  smartInsertToast: string | null;
  smartInsertToastType: "success" | "error";
};

const AppOverlayLayer: React.FC<AppOverlayLayerProps> = ({
  editDialogItem,
  items,
  getHallsForDate,
  handleUpdateItem,
  handleUpdateHallOrderForPriorityChangeFromEdit,
  setEditDialogItem,
  itemToDelete,
  handleConfirmDelete,
  setItemToDelete,
  showUpdateConfirmation,
  updateData,
  handleConfirmUpdate,
  setShowUpdateConfirmation,
  setUpdateData,
  setUpdateEventName,
  showUrlUpdateDialog,
  pendingUpdateEventName,
  eventMetadata,
  handleUrlUpdate,
  setShowUrlUpdateDialog,
  setPendingUpdateEventName,
  setActiveEventName,
  setActiveTab,
  showRenameDialog,
  eventToRename,
  handleConfirmRename,
  setShowRenameDialog,
  setEventToRename,
  showExportOptions,
  exportEventName,
  setShowExportOptions,
  setExportEventName,
  handleConfirmExport,
  mapData,
  blockDefinitionMode,
  currentMapData,
  setBlockDefinitionMode,
  setPendingCellSelection,
  handleUpdateBlocks,
  handleStartCellSelection,
  pendingCellSelection,
  cellSelectionMode,
  handleConfirmCellSelection,
  handleCancelCellSelection,
  simpleHallDefinitionMode,
  setSimpleHallDefinitionMode,
  currentMaplessHalls,
  handleUpdateMaplessHalls,
  allBlocksForHallDefinition,
  eventDates,
  activeEventDate,
  handleSyncMaplessHallsToOtherDates,
  globalHallOrderPanelOpen,
  setGlobalHallOrderPanelOpen,
  globalHallOrderHalls,
  globalHallOrderRouteSettings,
  handleUpdateGlobalHallRouteSettings,
  getGlobalHallItemCount,
  handleReorderExecuteListByHallOrder,
  hallDefinitionMode,
  setHallDefinitionMode,
  setPendingVertexSelection,
  currentHalls,
  handleUpdateHalls,
  handleStartVertexSelection,
  pendingVertexSelection,
  mapTabDates,
  handleSyncPolygonHallsToOtherDates,
  visitListPanelOpen,
  handleVisitListClose,
  visitListItems,
  handleVisitListOrderUpdate,
  visitListHallOrder,
  layoutMode,
  handleHighlightMapCell,
  handleClearMapCellHighlight,
  visitListHasUnsavedChanges,
  handleVisitListConfirm,
  handleVisitListCancel,
  handleUpdateItemPriority,
  showVisitListConfirmDialog,
  handleVisitListDialogCancel,
  handleVisitListDialogConfirm,
  vertexSelectionMode,
  vertexGuideOptions,
  setVertexGuideOptions,
  handleConfirmVertexSelection,
  handleCancelVertexSelection,
  mapFileInputRef,
  handleMapFileChange,
  mapImportDialogOpen,
  mapImportPendingFile,
  mapImportPendingEventName,
  handleMapImportConfirm,
  handleMapImportClose,
  exportFileInputRef,
  handleExportFileImport,
  activeEventName,
  mainContentVisible,
  currentMode,
  visibleItems,
  showHeaderBar,
  sortLabels,
  sortDisplayLabel,
  sortState,
  handleSortToggle,
  selectedItemIds,
  handleBulkSort,
  handleClearSelection,
  showMoveButtons,
  hasCandidateSelection,
  handleMoveToExecuteColumn,
  hasExecuteSelection,
  handleRemoveFromExecuteColumn,
  smartInsertToast,
  smartInsertToastType,
}) => {
  return (
    <>
      {editDialogItem && (
        <ItemEditDialog
          item={editDialogItem}
          allItems={items}
          halls={getHallsForDate(editDialogItem.eventDate)}
          onSave={(updatedItem) => {
            const prevPriority = (editDialogItem.priorityLevel || "none") as
              | "none"
              | "priority"
              | "highest";
            const nextPriority = (updatedItem.priorityLevel || "none") as
              | "none"
              | "priority"
              | "highest";
            handleUpdateItem(updatedItem);
            if (prevPriority !== nextPriority) {
              handleUpdateHallOrderForPriorityChangeFromEdit(
                updatedItem.id,
                nextPriority,
                prevPriority,
              );
            }
            setEditDialogItem(null);
            setTimeout(() => {
              const element = document.querySelector(
                `[data-item-id="${updatedItem.id}"]`,
              );
              if (element) {
                element.scrollIntoView({ behavior: "smooth", block: "center" });
              }
            }, 100);
          }}
          onPriorityChange={() => {
            /* no-op: priority 変更は onSave 内で統合処理済み */
          }}
          onClose={() => setEditDialogItem(null)}
        />
      )}

      {itemToDelete && (
        <DeleteConfirmationModal
          item={itemToDelete}
          onConfirm={handleConfirmDelete}
          onCancel={() => setItemToDelete(null)}
        />
      )}

      {showUpdateConfirmation && updateData && (
        <UpdateConfirmationModal
          itemsToDelete={updateData.itemsToDelete}
          itemsToUpdate={updateData.itemsToUpdate}
          itemsToAdd={updateData.itemsToAdd}
          protectedFromDelete={updateData.protectedFromDelete}
          protectedFromUpdate={updateData.protectedFromUpdate}
          onConfirm={handleConfirmUpdate}
          onCancel={() => {
            setShowUpdateConfirmation(false);
            setUpdateData(null);
            setUpdateEventName(null);
          }}
        />
      )}

      {showUrlUpdateDialog && (
        <UrlUpdateDialog
          currentUrl={
            pendingUpdateEventName
              ? eventMetadata[pendingUpdateEventName]?.spreadsheetUrl || ""
              : ""
          }
          onConfirm={handleUrlUpdate}
          onCancel={() => {
            setShowUrlUpdateDialog(false);
            setPendingUpdateEventName(null);
            setActiveEventName(null);
            setActiveTab("eventList");
          }}
        />
      )}

      {showRenameDialog && eventToRename && (
        <EventRenameDialog
          currentName={eventToRename}
          onConfirm={handleConfirmRename}
          onCancel={() => {
            setShowRenameDialog(false);
            setEventToRename(null);
          }}
        />
      )}

      {showExportOptions && exportEventName && (
        <ExportOptionsDialog
          isOpen={showExportOptions}
          onClose={() => {
            setShowExportOptions(false);
            setExportEventName(null);
          }}
          onExport={handleConfirmExport}
          hasMapData={
            !!(
              exportEventName &&
              mapData[exportEventName] &&
              Object.keys(mapData[exportEventName]).length > 0
            )
          }
        />
      )}

      {blockDefinitionMode && currentMapData && (
        <BlockDefinitionPanel
          isOpen={blockDefinitionMode}
          onClose={() => {
            setBlockDefinitionMode(false);
            setPendingCellSelection(null);
          }}
          mapData={currentMapData}
          onUpdateBlocks={handleUpdateBlocks}
          onStartCellSelection={handleStartCellSelection}
          pendingCellSelection={pendingCellSelection}
          onClearPendingCellSelection={() => setPendingCellSelection(null)}
        />
      )}

      {cellSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
              {(() => {
                const data = cellSelectionMode.editingBlockData as
                  | { block?: { name?: string } }
                  | undefined;
                const name = data?.block?.name?.trim();
                return name
                  ? `「${name}」設定中`
                  : "「名称不明ブロック」設定中";
              })()}
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              {cellSelectionMode.type === "corner" &&
                `セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === "multiCorner" &&
                `セルをクリックして角を選択 (${cellSelectionMode.clickedCells.length}/4)`}
              {cellSelectionMode.type === "rangeStart" &&
                `対角の2セルをクリック (${cellSelectionMode.clickedCells.length}/2)`}
              {cellSelectionMode.type === "individual" &&
                `対象セルをクリック (${cellSelectionMode.clickedCells.length}セル選択中)`}
            </div>
            {cellSelectionMode.clickedCells.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                選択:{" "}
                {cellSelectionMode.clickedCells
                  .map((c) => `(${c.row},${c.col})`)
                  .join(", ")}
              </div>
            )}
            <div className="text-xs text-blue-500 dark:text-blue-400 mt-1">
              マーカーをクリックで選択解除
            </div>
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleConfirmCellSelection}
              disabled={
                ((cellSelectionMode.type === "corner" ||
                  cellSelectionMode.type === "multiCorner") &&
                  cellSelectionMode.clickedCells.length < 4) ||
                (cellSelectionMode.type === "rangeStart" &&
                  cellSelectionMode.clickedCells.length < 2) ||
                (cellSelectionMode.type === "individual" &&
                  cellSelectionMode.clickedCells.length === 0)
              }
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              選択を確定
            </button>
            <button
              onClick={handleCancelCellSelection}
              className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {simpleHallDefinitionMode && (
        <SimpleHallDefinitionPanel
          isOpen={simpleHallDefinitionMode}
          onClose={() => setSimpleHallDefinitionMode(false)}
          halls={currentMaplessHalls}
          onUpdateHalls={handleUpdateMaplessHalls}
          availableBlocks={allBlocksForHallDefinition}
          eventDates={eventDates}
          activeEventDate={activeEventDate}
          onSyncToOtherDates={handleSyncMaplessHallsToOtherDates}
        />
      )}

      {globalHallOrderPanelOpen && (
        <HallOrderPanel
          isOpen={globalHallOrderPanelOpen}
          onClose={() => setGlobalHallOrderPanelOpen(false)}
          halls={globalHallOrderHalls}
          hallRouteSettings={globalHallOrderRouteSettings}
          onUpdateHallRouteSettings={handleUpdateGlobalHallRouteSettings}
          getItemCountInHall={getGlobalHallItemCount}
          onReorderExecuteList={handleReorderExecuteListByHallOrder}
        />
      )}

      {hallDefinitionMode && currentMapData && (
        <HallDefinitionPanel
          isOpen={hallDefinitionMode}
          onClose={() => {
            setHallDefinitionMode(false);
            setPendingVertexSelection(null);
          }}
          mapData={currentMapData}
          halls={currentHalls}
          onUpdateHalls={handleUpdateHalls}
          onStartVertexSelection={handleStartVertexSelection}
          pendingVertexSelection={pendingVertexSelection}
          onClearPendingVertexSelection={() => setPendingVertexSelection(null)}
          eventDates={eventDates}
          activeEventDate={activeEventDate}
          mapTabDates={mapTabDates}
          onSyncToOtherDates={handleSyncPolygonHallsToOtherDates}
        />
      )}

      {visitListPanelOpen && currentMapData && (
        <VisitListPanel
          isOpen={visitListPanelOpen}
          onClose={handleVisitListClose}
          items={visitListItems}
          onUpdateOrder={handleVisitListOrderUpdate}
          mapData={currentMapData}
          hallDefinitions={currentHalls}
          hallOrder={visitListHallOrder}
          layoutMode={layoutMode}
          onHighlightCell={handleHighlightMapCell}
          onClearHighlight={handleClearMapCellHighlight}
          hasUnsavedChanges={visitListHasUnsavedChanges}
          onConfirm={handleVisitListConfirm}
          onCancel={handleVisitListCancel}
          onUpdateItemPriority={handleUpdateItemPriority}
        />
      )}

      {showVisitListConfirmDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-3">
              変更を保存しますか？
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
              訪問リストに未保存の変更があります。保存して確定するか、キャンセルして破棄してください。
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={handleVisitListDialogCancel}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
              >
                キャンセル（破棄）
              </button>
              <button
                onClick={handleVisitListDialogConfirm}
                className="px-4 py-2 text-sm font-semibold rounded-md bg-blue-600 text-white hover:bg-blue-700"
              >
                保存して確定
              </button>
            </div>
          </div>
        </div>
      )}

      {vertexSelectionMode && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 p-4 min-w-80">
          <div className="text-center mb-3">
            <div className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
              {(() => {
                const data = vertexSelectionMode.editingData as
                  | { hall?: { name?: string } }
                  | undefined;
                const name = data?.hall?.name?.trim();
                return name ? `「${name}」設定中` : "「名称不明ホール」設定中";
              })()}
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-white mb-1">
              ホールの頂点をクリック (
              {vertexSelectionMode.clickedVertices.length}
              /6)
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
              クリック順に多角形を作成します。
            </div>
            {vertexSelectionMode.clickedVertices.length > 0 && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                選択:{" "}
                {vertexSelectionMode.clickedVertices
                  .map((v) => `(${v.row},${v.col})`)
                  .join(" → ")}
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-center mb-3">
            <button
              onClick={() =>
                setVertexGuideOptions((prev) => ({
                  ...prev,
                  showGrid: !prev.showGrid,
                }))
              }
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                vertexGuideOptions.showGrid
                  ? "bg-blue-600 text-white"
                  : "bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
              }`}
            >
              補助グリッド {vertexGuideOptions.showGrid ? "ON" : "OFF"}
            </button>
            <button
              onClick={() =>
                setVertexGuideOptions((prev) => ({
                  ...prev,
                  showRuler: !prev.showRuler,
                }))
              }
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                vertexGuideOptions.showRuler
                  ? "bg-blue-600 text-white"
                  : "bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
              }`}
            >
              座標尺 {vertexGuideOptions.showRuler ? "ON" : "OFF"}
            </button>
          </div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={handleConfirmVertexSelection}
              disabled={vertexSelectionMode.clickedVertices.length < 4}
              className="px-4 py-2 text-sm font-medium rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              確定
            </button>
            <button
              onClick={handleCancelVertexSelection}
              className="px-4 py-2 text-sm font-medium rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      <input
        type="file"
        ref={mapFileInputRef}
        accept=".xlsx"
        onChange={handleMapFileChange}
        style={{ display: "none" }}
      />

      <MapImportDialog
        isOpen={mapImportDialogOpen}
        file={mapImportPendingFile}
        eventName={mapImportPendingEventName}
        savedSettings={
          mapImportPendingEventName
            ? loadBlockDetectionSettings(mapImportPendingEventName)
            : null
        }
        onImport={handleMapImportConfirm}
        onClose={handleMapImportClose}
      />

      <input
        type="file"
        ref={exportFileInputRef}
        accept=".xlsx"
        onChange={handleExportFileImport}
        style={{ display: "none" }}
      />

      {activeEventName && items.length > 0 && mainContentVisible && (
        <>
          {currentMode === "execute" && (
            <SummaryBar
              items={visibleItems}
              filterLabel={!showHeaderBar ? sortDisplayLabel : undefined}
              onFilterToggle={!showHeaderBar ? handleSortToggle : undefined}
            />
          )}
        </>
      )}

      {layoutMode === "smartphone" &&
        activeEventName &&
        mainContentVisible &&
        items.length > 0 &&
        selectedItemIds.size > 0 && (
          <div className="fixed bottom-0 left-0 right-0 z-30 bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm border-t border-slate-200 dark:border-slate-700 shadow-lg px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <BulkActionControls
                onSort={handleBulkSort}
                onClear={handleClearSelection}
              />
              <div className="flex items-center gap-2">
                {showMoveButtons && hasCandidateSelection && (
                  <button
                    onClick={() =>
                      handleMoveToExecuteColumn(Array.from(selectedItemIds))
                    }
                    className="px-3 py-2 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ⇦実行列へ ({selectedItemIds.size})
                  </button>
                )}
                {showMoveButtons && hasExecuteSelection && (
                  <button
                    onClick={() =>
                      handleRemoveFromExecuteColumn(Array.from(selectedItemIds))
                    }
                    className="px-3 py-2 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ⇨候補へ ({selectedItemIds.size})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      {smartInsertToast && (
        <div
          className={`fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-pulse ${
            smartInsertToastType === "error" ? "bg-red-600" : "bg-green-600"
          }`}
        >
          {smartInsertToast}
        </div>
      )}
    </>
  );
};

export default AppOverlayLayer;
