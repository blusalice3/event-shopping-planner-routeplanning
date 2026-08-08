import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { AppBackupV1 } from "../../utils/appBackup";
import type { FocusModeSessionState } from "../../types/focus";
import type { ShoppingItem } from "../../types/item";
import type { BulkAddMetadata } from "../../features/events/bulkAdd";
import type {
  DifferentSourceEventAnalysis,
  SameSourceEventAnalysis,
} from "../../features/events/duplicateEvent";
import type { PendingEventUpdate } from "../../features/events/updateFlow";
import type { PreparedMapImport } from "../../features/map/domain/mapImportFlow";
import type {
  BlockSortDirection,
  LayoutMode,
  SortState,
} from "../../features/app-shell/types";
import { useTypedStateGroup } from "./useTypedStateGroup";

export type PendingDuplicateEventImport = {
  analysis: SameSourceEventAnalysis | DifferentSourceEventAnalysis;
  metadata?: BulkAddMetadata;
};

export type PendingXlsxRestoreCompletion = {
  errors: string[];
  itemCount: number;
};

export type NewItemDefaults = {
  eventDate: string;
  block: string;
  number: string;
};

export interface AppUiState {
  sortState: SortState;
  blockSortDirection: BlockSortDirection | null;
  itemToEdit: ShoppingItem | null;
  editDialogItem: ShoppingItem | null;
  itemToDelete: ShoppingItem | null;
  zoomLevel: number;
  recentlyChangedItemIds: Set<string>;
  newItemDefaults: NewItemDefaults | null;
  pendingEventUpdate: PendingEventUpdate | null;
  showUrlUpdateDialog: boolean;
  pendingUpdateEventName: string | null;
  showRenameDialog: boolean;
  eventToRename: string | null;
  pendingDuplicateEvent: PendingDuplicateEventImport | null;
  searchKeyword: string;
  currentSearchIndex: number;
  highlightedItemId: string | null;
  layoutMode: LayoutMode;
  uiVisibilityOverride: boolean;
  focusModeMapVisible: boolean;
  focusModeSessions: Record<string, FocusModeSessionState>;
  simpleHallDefinitionMode: boolean;
  globalHallOrderPanelOpen: boolean;
  showExportOptions: boolean;
  exportEventName: string | null;
  pendingBackup: AppBackupV1 | null;
  pendingXlsxRestoreCompletion: PendingXlsxRestoreCompletion | null;
  mapImportDialogOpen: boolean;
  mapImportPendingFile: File | null;
  mapImportPendingEventName: string;
  pendingMapReimport: PreparedMapImport | null;
  showPostponeFilterButton: boolean;
  showLateFilterButton: boolean;
  candidateNumberSortDirection: "asc" | "desc" | null;
}

export type AppUiStateSetters = {
  [K in keyof AppUiState as `set${Capitalize<string & K>}`]: Dispatch<
    SetStateAction<AppUiState[K]>
  >;
};

const createInitialAppUiState = (): AppUiState => ({
  sortState: "Manual",
  blockSortDirection: null,
  itemToEdit: null,
  editDialogItem: null,
  itemToDelete: null,
  zoomLevel: 100,
  recentlyChangedItemIds: new Set(),
  newItemDefaults: null,
  pendingEventUpdate: null,
  showUrlUpdateDialog: false,
  pendingUpdateEventName: null,
  showRenameDialog: false,
  eventToRename: null,
  pendingDuplicateEvent: null,
  searchKeyword: "",
  currentSearchIndex: -1,
  highlightedItemId: null,
  layoutMode:
    typeof window !== "undefined" && window.innerWidth < 768
      ? "smartphone"
      : "pc",
  uiVisibilityOverride: false,
  focusModeMapVisible: false,
  focusModeSessions: {},
  simpleHallDefinitionMode: false,
  globalHallOrderPanelOpen: false,
  showExportOptions: false,
  exportEventName: null,
  pendingBackup: null,
  pendingXlsxRestoreCompletion: null,
  mapImportDialogOpen: false,
  mapImportPendingFile: null,
  mapImportPendingEventName: "",
  pendingMapReimport: null,
  showPostponeFilterButton: false,
  showLateFilterButton: false,
  candidateNumberSortDirection: null,
});

export const useAppUiState = (): AppUiState & AppUiStateSetters => {
  const { state, setField } = useTypedStateGroup(createInitialAppUiState);
  const setters = useMemo<AppUiStateSetters>(
    () => ({
      setSortState: (value) => setField("sortState", value),
      setBlockSortDirection: (value) => setField("blockSortDirection", value),
      setItemToEdit: (value) => setField("itemToEdit", value),
      setEditDialogItem: (value) => setField("editDialogItem", value),
      setItemToDelete: (value) => setField("itemToDelete", value),
      setZoomLevel: (value) => setField("zoomLevel", value),
      setRecentlyChangedItemIds: (value) =>
        setField("recentlyChangedItemIds", value),
      setNewItemDefaults: (value) => setField("newItemDefaults", value),
      setPendingEventUpdate: (value) => setField("pendingEventUpdate", value),
      setShowUrlUpdateDialog: (value) => setField("showUrlUpdateDialog", value),
      setPendingUpdateEventName: (value) =>
        setField("pendingUpdateEventName", value),
      setShowRenameDialog: (value) => setField("showRenameDialog", value),
      setEventToRename: (value) => setField("eventToRename", value),
      setPendingDuplicateEvent: (value) =>
        setField("pendingDuplicateEvent", value),
      setSearchKeyword: (value) => setField("searchKeyword", value),
      setCurrentSearchIndex: (value) => setField("currentSearchIndex", value),
      setHighlightedItemId: (value) => setField("highlightedItemId", value),
      setLayoutMode: (value) => setField("layoutMode", value),
      setUiVisibilityOverride: (value) =>
        setField("uiVisibilityOverride", value),
      setFocusModeMapVisible: (value) => setField("focusModeMapVisible", value),
      setFocusModeSessions: (value) => setField("focusModeSessions", value),
      setSimpleHallDefinitionMode: (value) =>
        setField("simpleHallDefinitionMode", value),
      setGlobalHallOrderPanelOpen: (value) =>
        setField("globalHallOrderPanelOpen", value),
      setShowExportOptions: (value) => setField("showExportOptions", value),
      setExportEventName: (value) => setField("exportEventName", value),
      setPendingBackup: (value) => setField("pendingBackup", value),
      setPendingXlsxRestoreCompletion: (value) =>
        setField("pendingXlsxRestoreCompletion", value),
      setMapImportDialogOpen: (value) => setField("mapImportDialogOpen", value),
      setMapImportPendingFile: (value) =>
        setField("mapImportPendingFile", value),
      setMapImportPendingEventName: (value) =>
        setField("mapImportPendingEventName", value),
      setPendingMapReimport: (value) => setField("pendingMapReimport", value),
      setShowPostponeFilterButton: (value) =>
        setField("showPostponeFilterButton", value),
      setShowLateFilterButton: (value) =>
        setField("showLateFilterButton", value),
      setCandidateNumberSortDirection: (value) =>
        setField("candidateNumberSortDirection", value),
    }),
    [setField],
  );

  return useMemo(() => ({ ...state, ...setters }), [setters, state]);
};
