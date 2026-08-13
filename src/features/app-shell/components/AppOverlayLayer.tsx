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
} from "../../../components/map";
import type { AppOverlayCommands } from "../../../app/state/useAppOverlayController";
import type { AppOverlayReadModel } from "../../../app/state/appOverlayState";
import {
  formatMovePlanCount,
  type MovePlan,
} from "../../lists/domain/movePlan";
import type {
  BulkSortDirection,
  LayoutMode,
  VertexGuideOptions,
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

type AppOverlayLayerFields = {
  items: ShoppingItem[];
  getHallsForDate: (eventDate: string) => HallDefinition[];
  handleUpdateItem: (item: ShoppingItem) => void;
  handleUpdateHallOrderForPriorityChangeFromEdit: (
    itemId: string,
    newPriorityLevel: PriorityLevel,
    oldPriorityLevel: PriorityLevel,
  ) => void;
  handleConfirmDelete: DeleteConfirmationModalProps["onConfirm"];
  handleConfirmUpdate: UpdateConfirmationModalProps["onConfirm"];
  handleCancelUpdate: UpdateConfirmationModalProps["onCancel"];
  eventMetadata: Record<string, EventMetadata>;
  handleUrlUpdate: UrlUpdateDialogProps["onConfirm"];
  onShowEventList: () => void;
  handleConfirmRename: EventRenameDialogProps["onConfirm"];
  handleConfirmExport: ExportOptionsDialogProps["onExport"];
  mapData: MapDataStore;
  currentMapData: BlockDefinitionPanelProps["mapData"] | null;
  handleUpdateBlocks: BlockDefinitionPanelProps["onUpdateBlocks"];
  handleStartCellSelection: BlockDefinitionPanelProps["onStartCellSelection"];
  handleConfirmCellSelection: () => void;
  handleCancelCellSelection: () => void;
  currentMaplessHalls: HallDefinition[];
  handleUpdateMaplessHalls: SimpleHallDefinitionPanelProps["onUpdateHalls"];
  allBlocksForHallDefinition: string[];
  eventDates: string[];
  activeEventDate: string;
  handleSyncMaplessHallsToOtherDates: NonNullable<
    SimpleHallDefinitionPanelProps["onSyncToOtherDates"]
  >;
  globalHallOrderHalls: HallDefinition[];
  globalHallOrderRouteSettings: HallRouteSettings;
  handleUpdateGlobalHallRouteSettings: HallOrderPanelProps["onUpdateHallRouteSettings"];
  getGlobalHallItemCount: HallOrderPanelProps["getItemCountInHall"];
  handleReorderExecuteListByHallOrder: NonNullable<
    HallOrderPanelProps["onReorderExecuteList"]
  >;
  currentHalls: HallDefinition[];
  handleUpdateHalls: HallDefinitionPanelProps["onUpdateHalls"];
  handleStartVertexSelection: HallDefinitionPanelProps["onStartVertexSelection"];
  mapTabDates: string[];
  handleSyncPolygonHallsToOtherDates: NonNullable<
    HallDefinitionPanelProps["onSyncToOtherDates"]
  >;
  handleVisitListClose: VisitListPanelProps["onClose"];
  visitListItems: ShoppingItem[];
  handleVisitListOrderUpdate: VisitListPanelProps["onUpdateOrder"];
  visitListHallOrder: string[];
  layoutMode: LayoutMode;
  handleHighlightMapCell: VisitListPanelProps["onHighlightCell"];
  handleClearMapCellHighlight: VisitListPanelProps["onClearHighlight"];
  handleVisitListConfirm: VisitListPanelProps["onConfirm"];
  handleVisitListCancel: VisitListPanelProps["onCancel"];
  handleUpdateItemPriority: NonNullable<
    VisitListPanelProps["onUpdateItemPriority"]
  >;
  handleVisitListDialogCancel: () => void;
  handleVisitListDialogConfirm: () => void;
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
  mapImportSavedSettings: MapImportDialogProps["savedSettings"];
  handleMapImportConfirm: MapImportDialogProps["onImport"];
  handleMapImportClose: MapImportDialogProps["onClose"];
  xlsxExecutionPort: MapImportDialogProps["xlsxExecutionPort"];
  exportFileInputRef: React.RefObject<HTMLInputElement>;
  handleExportFileImport: (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => void | Promise<void>;
  activeEventName: string | null;
  mainContentVisible: boolean;
  currentMode: ViewMode;
  visibleItems: ShoppingItem[];
  showHeaderBar: boolean;
  sortDisplayLabel: string;
  handleSortToggle: () => void;
  selectedItemIds: Set<string>;
  handleBulkSort: (direction: BulkSortDirection) => void;
  handleClearSelection: () => void;
  showMoveButtons: boolean;
  hasCandidateSelection: boolean;
  candidateMovePlan: MovePlan;
  handleMoveToExecuteColumn: (itemIds: string[]) => void;
  hasExecuteSelection: boolean;
  executeMovePlan: MovePlan;
  handleRemoveFromExecuteColumn: (itemIds: string[]) => void;
};

export type AppOverlayLayerModel = {
  readonly item: Pick<AppOverlayLayerFields, "items">;
  readonly event: Pick<
    AppOverlayLayerFields,
    "activeEventDate" | "activeEventName" | "eventDates" | "eventMetadata"
  >;
  readonly mapEditor: Pick<
    AppOverlayLayerFields,
    | "allBlocksForHallDefinition"
    | "currentHalls"
    | "currentMapData"
    | "currentMaplessHalls"
    | "getGlobalHallItemCount"
    | "getHallsForDate"
    | "globalHallOrderHalls"
    | "globalHallOrderRouteSettings"
    | "mapData"
    | "mapTabDates"
    | "vertexGuideOptions"
  >;
  readonly visitList: Pick<
    AppOverlayLayerFields,
    "layoutMode" | "visitListHallOrder" | "visitListItems"
  >;
  readonly imports: Pick<
    AppOverlayLayerFields,
    "exportFileInputRef" | "mapFileInputRef" | "mapImportSavedSettings"
  >;
  readonly list: Pick<
    AppOverlayLayerFields,
    | "candidateMovePlan"
    | "currentMode"
    | "executeMovePlan"
    | "hasCandidateSelection"
    | "hasExecuteSelection"
    | "mainContentVisible"
    | "selectedItemIds"
    | "showHeaderBar"
    | "showMoveButtons"
    | "sortDisplayLabel"
    | "visibleItems"
  >;
};

export type AppOverlayLayerActions = {
  readonly item: Pick<
    AppOverlayLayerFields,
    | "handleCancelUpdate"
    | "handleConfirmDelete"
    | "handleConfirmUpdate"
    | "handleUpdateHallOrderForPriorityChangeFromEdit"
    | "handleUpdateItem"
  >;
  readonly event: Pick<
    AppOverlayLayerFields,
    | "handleConfirmExport"
    | "handleConfirmRename"
    | "handleUrlUpdate"
    | "onShowEventList"
  >;
  readonly mapEditor: Pick<
    AppOverlayLayerFields,
    | "handleCancelCellSelection"
    | "handleCancelVertexSelection"
    | "handleConfirmCellSelection"
    | "handleConfirmVertexSelection"
    | "handleReorderExecuteListByHallOrder"
    | "handleStartCellSelection"
    | "handleStartVertexSelection"
    | "handleSyncMaplessHallsToOtherDates"
    | "handleSyncPolygonHallsToOtherDates"
    | "handleUpdateBlocks"
    | "handleUpdateGlobalHallRouteSettings"
    | "handleUpdateHalls"
    | "handleUpdateMaplessHalls"
    | "setVertexGuideOptions"
  >;
  readonly visitList: Pick<
    AppOverlayLayerFields,
    | "handleClearMapCellHighlight"
    | "handleHighlightMapCell"
    | "handleUpdateItemPriority"
    | "handleVisitListCancel"
    | "handleVisitListClose"
    | "handleVisitListConfirm"
    | "handleVisitListDialogCancel"
    | "handleVisitListDialogConfirm"
    | "handleVisitListOrderUpdate"
  >;
  readonly imports: Pick<
    AppOverlayLayerFields,
    | "handleExportFileImport"
    | "handleMapFileChange"
    | "handleMapImportClose"
    | "handleMapImportConfirm"
    | "xlsxExecutionPort"
  >;
  readonly list: Pick<
    AppOverlayLayerFields,
    | "handleBulkSort"
    | "handleClearSelection"
    | "handleMoveToExecuteColumn"
    | "handleRemoveFromExecuteColumn"
    | "handleSortToggle"
  >;
};

export type AppOverlayLayerProps = {
  readonly overlay: AppOverlayReadModel;
  readonly overlayCommands: AppOverlayCommands;
  readonly model: AppOverlayLayerModel;
  readonly actions: AppOverlayLayerActions;
};

const AppOverlayLayer: React.FC<AppOverlayLayerProps> = ({
  overlay,
  overlayCommands,
  model,
  actions,
}) => {
  const {
    item: { items },
    event: { activeEventDate, activeEventName, eventDates, eventMetadata },
    mapEditor: {
      allBlocksForHallDefinition,
      currentHalls,
      currentMapData,
      currentMaplessHalls,
      getGlobalHallItemCount,
      getHallsForDate,
      globalHallOrderHalls,
      globalHallOrderRouteSettings,
      mapData,
      mapTabDates,
      vertexGuideOptions,
    },
    visitList: { layoutMode, visitListHallOrder, visitListItems },
    imports: { exportFileInputRef, mapFileInputRef, mapImportSavedSettings },
    list: {
      candidateMovePlan,
      currentMode,
      executeMovePlan,
      hasCandidateSelection,
      hasExecuteSelection,
      mainContentVisible,
      selectedItemIds,
      showHeaderBar,
      showMoveButtons,
      sortDisplayLabel,
      visibleItems,
    },
  } = model;
  const {
    item: {
      handleCancelUpdate,
      handleConfirmDelete,
      handleConfirmUpdate,
      handleUpdateHallOrderForPriorityChangeFromEdit,
      handleUpdateItem,
    },
    event: {
      handleConfirmExport,
      handleConfirmRename,
      handleUrlUpdate,
      onShowEventList,
    },
    mapEditor: {
      handleCancelCellSelection,
      handleCancelVertexSelection,
      handleConfirmCellSelection,
      handleConfirmVertexSelection,
      handleReorderExecuteListByHallOrder,
      handleStartCellSelection,
      handleStartVertexSelection,
      handleSyncMaplessHallsToOtherDates,
      handleSyncPolygonHallsToOtherDates,
      handleUpdateBlocks,
      handleUpdateGlobalHallRouteSettings,
      handleUpdateHalls,
      handleUpdateMaplessHalls,
      setVertexGuideOptions,
    },
    visitList: {
      handleClearMapCellHighlight,
      handleHighlightMapCell,
      handleUpdateItemPriority,
      handleVisitListCancel,
      handleVisitListClose,
      handleVisitListConfirm,
      handleVisitListDialogCancel,
      handleVisitListDialogConfirm,
      handleVisitListOrderUpdate,
    },
    imports: {
      handleExportFileImport,
      handleMapFileChange,
      handleMapImportClose,
      handleMapImportConfirm,
      xlsxExecutionPort,
    },
    list: {
      handleBulkSort,
      handleClearSelection,
      handleMoveToExecuteColumn,
      handleRemoveFromExecuteColumn,
      handleSortToggle,
    },
  } = actions;
  const {
    editDialogItem,
    itemToDelete,
    pendingEventUpdate,
    showUrlUpdateDialog,
    pendingUpdateEventName,
    showRenameDialog,
    eventToRename,
    showExportOptions,
    exportEventName,
    blockDefinitionMode,
    pendingCellSelection,
    cellSelectionMode,
    simpleHallDefinitionMode,
    globalHallOrderPanelOpen,
    hallDefinitionMode,
    pendingVertexSelection,
    visitListPanelOpen,
    visitListHasUnsavedChanges,
    showVisitListConfirmDialog,
    vertexSelectionMode,
    mapImportDialogOpen,
    mapImportPendingFile,
    mapImportPendingEventName,
    smartInsertToast,
    smartInsertToastType,
  } = overlay;
  const {
    item: itemOverlayCommands,
    event: eventOverlayCommands,
    mapEditor: mapEditorOverlayCommands,
  } = overlayCommands;

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
            itemOverlayCommands.confirm();
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
          onClose={itemOverlayCommands.close}
        />
      )}

      {itemToDelete && (
        <DeleteConfirmationModal
          item={itemToDelete}
          onConfirm={handleConfirmDelete}
          onCancel={itemOverlayCommands.close}
        />
      )}

      {pendingEventUpdate && (
        <UpdateConfirmationModal
          itemsToDelete={pendingEventUpdate.diff.itemsToDelete}
          itemsToUpdate={pendingEventUpdate.diff.itemsToUpdate}
          itemsToAdd={pendingEventUpdate.diff.itemsToAdd}
          appFieldSyncCandidates={
            pendingEventUpdate.diff.appFieldSyncCandidates
          }
          protectedFromDelete={pendingEventUpdate.diff.protectedFromDelete}
          protectedFromUpdate={pendingEventUpdate.diff.protectedFromUpdate}
          quantityWarnings={pendingEventUpdate.diff.quantityWarnings}
          pendingPurchasedQuantityChanges={
            pendingEventUpdate.diff.pendingPurchasedQuantityChanges
          }
          limitedPurchaseQuantityConflicts={
            pendingEventUpdate.diff.limitedPurchaseQuantityConflicts
          }
          nextSource={
            pendingEventUpdate.kind === "source-switch"
              ? pendingEventUpdate.nextSource
              : undefined
          }
          onConfirm={handleConfirmUpdate}
          onCancel={handleCancelUpdate}
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
            eventOverlayCommands.close();
            onShowEventList();
          }}
        />
      )}

      {showRenameDialog && eventToRename && (
        <EventRenameDialog
          currentName={eventToRename}
          onConfirm={handleConfirmRename}
          onCancel={eventOverlayCommands.close}
        />
      )}

      {showExportOptions && exportEventName && (
        <ExportOptionsDialog
          isOpen={showExportOptions}
          onClose={eventOverlayCommands.close}
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
          onClose={mapEditorOverlayCommands.close}
          mapData={currentMapData}
          onUpdateBlocks={handleUpdateBlocks}
          onStartCellSelection={handleStartCellSelection}
          pendingCellSelection={pendingCellSelection}
          onClearPendingCellSelection={
            mapEditorOverlayCommands.clearPendingCellSelection
          }
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
          onClose={mapEditorOverlayCommands.close}
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
          onClose={mapEditorOverlayCommands.close}
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
          onClose={mapEditorOverlayCommands.close}
          mapData={currentMapData}
          halls={currentHalls}
          onUpdateHalls={handleUpdateHalls}
          onStartVertexSelection={handleStartVertexSelection}
          pendingVertexSelection={pendingVertexSelection}
          onClearPendingVertexSelection={
            mapEditorOverlayCommands.clearPendingVertexSelection
          }
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
        className="hidden"
      />

      <MapImportDialog
        isOpen={mapImportDialogOpen}
        file={mapImportPendingFile}
        eventName={mapImportPendingEventName}
        savedSettings={mapImportSavedSettings}
        onImport={handleMapImportConfirm}
        onClose={handleMapImportClose}
        xlsxExecutionPort={xlsxExecutionPort}
      />

      <input
        type="file"
        ref={exportFileInputRef}
        accept=".xlsx"
        onChange={handleExportFileImport}
        className="hidden"
        aria-label="Excelファイルを選択"
      />

      {activeEventName && items.length > 0 && mainContentVisible && (
        <>
          {currentMode === "execute" && (
            <SummaryBar
              items={visibleItems}
              layoutMode={layoutMode}
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
                      handleMoveToExecuteColumn(candidateMovePlan.requested)
                    }
                    className="px-3 py-2 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ⇦実行列へ ({formatMovePlanCount(candidateMovePlan)})
                  </button>
                )}
                {showMoveButtons && hasExecuteSelection && (
                  <button
                    onClick={() =>
                      handleRemoveFromExecuteColumn(executeMovePlan.requested)
                    }
                    className="px-3 py-2 text-xs font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 active:bg-blue-800 transition-colors"
                  >
                    ⇨候補へ ({formatMovePlanCount(executeMovePlan)})
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      {smartInsertToast && (
        <div
          className={`fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-attention-outline ${
            smartInsertToastType === "error"
              ? "bg-red-600 attention-outline-red"
              : "bg-green-700 attention-outline-green"
          }`}
        >
          {smartInsertToast}
        </div>
      )}
    </>
  );
};

export default AppOverlayLayer;
