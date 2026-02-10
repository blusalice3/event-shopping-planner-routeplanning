import React from 'react';
import { ShoppingItem, EventMetadata, DayMapData, HallDefinition } from '../types';
import DeleteConfirmationModal from './DeleteConfirmationModal';
import UpdateConfirmationModal from './UpdateConfirmationModal';
import UrlUpdateDialog from './UrlUpdateDialog';
import EventRenameDialog from './EventRenameDialog';
import ExportOptionsDialog from './ExportOptionsDialog';
import { BlockDefinitionPanel, HallDefinitionPanel, MapImportDialog, loadBlockDetectionSettings } from './map';
import VisitListPanel from './VisitListPanel';
import VisitListConfirmDialog from './VisitListConfirmDialog';
import CellSelectionOverlay from './CellSelectionOverlay';
import VertexSelectionOverlay from './VertexSelectionOverlay';

interface ModalLayerProps {
  // Delete confirmation
  itemToDelete: ShoppingItem | null;
  handleConfirmDelete: () => void;
  setItemToDelete: (item: ShoppingItem | null) => void;

  // Update confirmation
  showUpdateConfirmation: boolean;
  updateData: any;
  handleConfirmUpdate: () => void;
  setShowUpdateConfirmation: (show: boolean) => void;
  setUpdateData: (data: any) => void;
  setUpdateEventName: (name: string | null) => void;

  // URL update dialog
  showUrlUpdateDialog: boolean;
  pendingUpdateEventName: string | null;
  eventMetadata: Record<string, EventMetadata>;
  handleUrlUpdate: (...args: any[]) => void;
  setShowUrlUpdateDialog: (show: boolean) => void;
  setPendingUpdateEventName: (name: string | null) => void;

  // Rename dialog
  showRenameDialog: boolean;
  eventToRename: string | null;
  handleConfirmRename: (newName: string) => void;
  setShowRenameDialog: (show: boolean) => void;
  setEventToRename: (name: string | null) => void;

  // Export options
  showExportOptions: boolean;
  exportEventName: string | null;
  mapData: Record<string, Record<string, DayMapData>>;
  handleConfirmExport: (...args: any[]) => void;
  setShowExportOptions: (show: boolean) => void;
  setExportEventName: (name: string | null) => void;

  // Block definition
  blockDefinitionMode: boolean;
  setBlockDefinitionMode: (mode: boolean) => void;
  currentMapData: DayMapData | null;
  handleUpdateBlocks: (...args: any[]) => void;
  handleStartCellSelection: (...args: any[]) => void;
  pendingCellSelection: any;
  setPendingCellSelection: (selection: any) => void;

  // Cell selection overlay
  cellSelectionMode: any;
  handleConfirmCellSelection: () => void;
  handleCancelCellSelection: () => void;

  // Hall definition
  hallDefinitionMode: boolean;
  setHallDefinitionMode: (mode: boolean) => void;
  currentHalls: HallDefinition[] | undefined;
  handleUpdateHalls: (...args: any[]) => void;
  handleStartVertexSelection: () => void;
  pendingVertexSelection: any;
  setPendingVertexSelection: (selection: any) => void;

  // Vertex selection overlay
  vertexSelectionMode: any;
  handleConfirmVertexSelection: () => void;
  handleCancelVertexSelection: () => void;

  // Visit list
  visitListPanelOpen: boolean;
  handleVisitListClose: () => void;
  visitListItems: ShoppingItem[];
  handleVisitListOrderUpdate: (...args: any[]) => void;
  visitListHallOrder: string[] | undefined;
  layoutMode: 'pc' | 'smartphone';
  handleHighlightMapCell: (...args: any[]) => void;
  handleClearMapCellHighlight: () => void;
  visitListHasUnsavedChanges: boolean;
  handleVisitListConfirm: () => void;
  handleVisitListCancel: () => void;
  handleUpdateItemPriority: (...args: any[]) => void;

  // Visit list confirm dialog
  showVisitListConfirmDialog: boolean;
  handleVisitListDialogConfirm: () => void;
  handleVisitListDialogCancel: () => void;

  // Map import
  mapImportDialogOpen: boolean;
  mapImportPendingFile: File | null;
  mapImportPendingEventName: string | null;
  handleMapImportConfirm: (...args: any[]) => void;
  handleMapImportClose: () => void;

  // File inputs
  mapFileInputRef: React.RefObject<HTMLInputElement | null>;
  handleMapFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  exportFileInputRef: React.RefObject<HTMLInputElement | null>;
  handleExportFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;

  // Smart insert toast
  smartInsertToast: string | null;
}

const ModalLayer: React.FC<ModalLayerProps> = ({
  itemToDelete, handleConfirmDelete, setItemToDelete,
  showUpdateConfirmation, updateData, handleConfirmUpdate, setShowUpdateConfirmation, setUpdateData, setUpdateEventName,
  showUrlUpdateDialog, pendingUpdateEventName, eventMetadata, handleUrlUpdate, setShowUrlUpdateDialog, setPendingUpdateEventName,
  showRenameDialog, eventToRename, handleConfirmRename, setShowRenameDialog, setEventToRename,
  showExportOptions, exportEventName, mapData, handleConfirmExport, setShowExportOptions, setExportEventName,
  blockDefinitionMode, setBlockDefinitionMode, currentMapData, handleUpdateBlocks, handleStartCellSelection, pendingCellSelection, setPendingCellSelection,
  cellSelectionMode, handleConfirmCellSelection, handleCancelCellSelection,
  hallDefinitionMode, setHallDefinitionMode, currentHalls, handleUpdateHalls, handleStartVertexSelection, pendingVertexSelection, setPendingVertexSelection,
  vertexSelectionMode, handleConfirmVertexSelection, handleCancelVertexSelection,
  visitListPanelOpen, handleVisitListClose, visitListItems, handleVisitListOrderUpdate, visitListHallOrder, layoutMode,
  handleHighlightMapCell, handleClearMapCellHighlight, visitListHasUnsavedChanges, handleVisitListConfirm, handleVisitListCancel, handleUpdateItemPriority,
  showVisitListConfirmDialog, handleVisitListDialogConfirm, handleVisitListDialogCancel,
  mapImportDialogOpen, mapImportPendingFile, mapImportPendingEventName, handleMapImportConfirm, handleMapImportClose,
  mapFileInputRef, handleMapFileChange, exportFileInputRef, handleExportFileImport,
  smartInsertToast,
}) => (
  <>
    {itemToDelete && <DeleteConfirmationModal item={itemToDelete} onConfirm={handleConfirmDelete} onCancel={() => setItemToDelete(null)} />}

    {showUpdateConfirmation && updateData && (
      <UpdateConfirmationModal
        itemsToDelete={updateData.itemsToDelete} itemsToUpdate={updateData.itemsToUpdate}
        itemsToAdd={updateData.itemsToAdd} protectedFromDelete={updateData.protectedFromDelete}
        protectedFromUpdate={updateData.protectedFromUpdate}
        onConfirm={handleConfirmUpdate}
        onCancel={() => { setShowUpdateConfirmation(false); setUpdateData(null); setUpdateEventName(null); }}
      />
    )}

    {showUrlUpdateDialog && (
      <UrlUpdateDialog
        currentUrl={pendingUpdateEventName ? eventMetadata[pendingUpdateEventName]?.spreadsheetUrl || '' : ''}
        onConfirm={handleUrlUpdate}
        onCancel={() => { setShowUrlUpdateDialog(false); setPendingUpdateEventName(null); }}
      />
    )}

    {showRenameDialog && eventToRename && (
      <EventRenameDialog
        currentName={eventToRename} onConfirm={handleConfirmRename}
        onCancel={() => { setShowRenameDialog(false); setEventToRename(null); }}
      />
    )}

    {showExportOptions && exportEventName && (
      <ExportOptionsDialog
        isOpen={showExportOptions}
        onClose={() => { setShowExportOptions(false); setExportEventName(null); }}
        onExport={handleConfirmExport}
        hasMapData={!!(exportEventName && mapData[exportEventName] && Object.keys(mapData[exportEventName]).length > 0)}
      />
    )}

    {blockDefinitionMode && currentMapData && (
      <BlockDefinitionPanel
        isOpen={blockDefinitionMode} onClose={() => { setBlockDefinitionMode(false); setPendingCellSelection(null); }}
        mapData={currentMapData} onUpdateBlocks={handleUpdateBlocks} onStartCellSelection={handleStartCellSelection}
        pendingCellSelection={pendingCellSelection} onClearPendingCellSelection={() => setPendingCellSelection(null)}
      />
    )}

    {cellSelectionMode && <CellSelectionOverlay cellSelectionMode={cellSelectionMode} onConfirm={handleConfirmCellSelection} onCancel={handleCancelCellSelection} />}

    {hallDefinitionMode && currentMapData && (
      <HallDefinitionPanel
        isOpen={hallDefinitionMode} onClose={() => { setHallDefinitionMode(false); setPendingVertexSelection(null); }}
        mapData={currentMapData} halls={currentHalls as any} onUpdateHalls={handleUpdateHalls}
        onStartVertexSelection={handleStartVertexSelection} pendingVertexSelection={pendingVertexSelection}
        onClearPendingVertexSelection={() => setPendingVertexSelection(null)}
      />
    )}

    {visitListPanelOpen && currentMapData && (
      <VisitListPanel
        isOpen={visitListPanelOpen} onClose={handleVisitListClose} items={visitListItems}
        onUpdateOrder={handleVisitListOrderUpdate} mapData={currentMapData} hallDefinitions={currentHalls as any}
        hallOrder={visitListHallOrder as any} layoutMode={layoutMode}
        onHighlightCell={handleHighlightMapCell} onClearHighlight={handleClearMapCellHighlight}
        hasUnsavedChanges={visitListHasUnsavedChanges} onConfirm={handleVisitListConfirm}
        onCancel={handleVisitListCancel} onUpdateItemPriority={handleUpdateItemPriority}
      />
    )}

    {showVisitListConfirmDialog && (
      <VisitListConfirmDialog onConfirm={handleVisitListDialogConfirm} onCancel={handleVisitListDialogCancel} />
    )}

    {vertexSelectionMode && <VertexSelectionOverlay vertexSelectionMode={vertexSelectionMode} onConfirm={handleConfirmVertexSelection} onCancel={handleCancelVertexSelection} />}

    <input type="file" ref={mapFileInputRef as any} accept=".xlsx" onChange={handleMapFileChange} style={{ display: 'none' }} />
    <MapImportDialog
      isOpen={mapImportDialogOpen} file={mapImportPendingFile} eventName={mapImportPendingEventName || ''}
      savedSettings={mapImportPendingEventName ? loadBlockDetectionSettings(mapImportPendingEventName) : null}
      onImport={handleMapImportConfirm} onClose={handleMapImportClose}
    />
    <input type="file" ref={exportFileInputRef as any} accept=".xlsx" onChange={handleExportFileImport} style={{ display: 'none' }} />

    {smartInsertToast && (
      <div className="fixed top-16 left-1/2 transform -translate-x-1/2 z-[10000] bg-green-600 text-white px-5 py-2.5 rounded-lg shadow-lg text-sm font-medium animate-pulse">
        {smartInsertToast}
      </div>
    )}
  </>
);

export default ModalLayer;
