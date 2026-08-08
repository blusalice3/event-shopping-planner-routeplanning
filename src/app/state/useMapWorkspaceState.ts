import {
  useCallback,
  useEffect,
  useMemo,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  CellPosition,
  CellSelectionMode,
  MapTabMenuPosition,
  PendingCellSelection,
  PendingVertexSelection,
  SmartInsertMode,
  VertexGuideOptions,
  VertexSelectionMode,
} from "../../features/app-shell/types";
import { normalizeSmartInsertMode } from "../../utils/smartInsertMode";
import { useTypedStateGroup } from "./useTypedStateGroup";

export interface MapWorkspaceState {
  mapTabMenuOpen: string | null;
  mapTabMenuPosition: MapTabMenuPosition;
  visitListPanelOpen: boolean;
  visitListPanelMapTab: string | null;
  visitListHasUnsavedChanges: boolean;
  visitListOriginalOrder: string[];
  highlightedMapCell: CellPosition | null;
  showVisitListConfirmDialog: boolean;
  pendingTabChange: string | null;
  blockDefinitionMode: boolean;
  mapSelectedHallId: string;
  mapIsRouteVisible: boolean;
  mapIsHallOrderOpen: boolean;
  mapHallSelectorOpen: boolean;
  mapSmartInsertEnabled: boolean;
  mapSmartInsertMode: SmartInsertMode;
  smartInsertToast: string | null;
  smartInsertToastType: "success" | "error";
  cellSelectionMode: CellSelectionMode;
  pendingCellSelection: PendingCellSelection;
  hallDefinitionMode: boolean;
  vertexSelectionMode: VertexSelectionMode;
  pendingVertexSelection: PendingVertexSelection;
  vertexGuideOptions: VertexGuideOptions;
}

export type MapWorkspaceStateSetters = {
  [K in keyof MapWorkspaceState as `set${Capitalize<string & K>}`]: Dispatch<
    SetStateAction<MapWorkspaceState[K]>
  >;
};

export interface MapWorkspaceCommands {
  showSmartInsertToast(message: string, type?: "success" | "error"): void;
}

type PreferenceReader = Pick<Storage, "getItem">;

const readPreferenceStorage = (): PreferenceReader | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const createInitialMapWorkspaceState = (
  storage: PreferenceReader | null = readPreferenceStorage(),
): MapWorkspaceState => {
  let mapSmartInsertEnabled = true;
  let mapSmartInsertMode: SmartInsertMode = "map";
  try {
    const saved = storage?.getItem("mapSmartInsertEnabled") ?? null;
    mapSmartInsertEnabled = saved !== null ? saved === "true" : true;
  } catch {
    mapSmartInsertEnabled = true;
  }
  try {
    mapSmartInsertMode = normalizeSmartInsertMode(
      storage?.getItem("mapSmartInsertMode") ?? null,
    );
  } catch {
    mapSmartInsertMode = "map";
  }

  return {
    mapTabMenuOpen: null,
    mapTabMenuPosition: { left: 0, top: 0 },
    visitListPanelOpen: false,
    visitListPanelMapTab: null,
    visitListHasUnsavedChanges: false,
    visitListOriginalOrder: [],
    highlightedMapCell: null,
    showVisitListConfirmDialog: false,
    pendingTabChange: null,
    blockDefinitionMode: false,
    mapSelectedHallId: "all",
    mapIsRouteVisible: true,
    mapIsHallOrderOpen: false,
    mapHallSelectorOpen: false,
    mapSmartInsertEnabled,
    mapSmartInsertMode,
    smartInsertToast: null,
    smartInsertToastType: "success",
    cellSelectionMode: null,
    pendingCellSelection: null,
    hallDefinitionMode: false,
    vertexSelectionMode: null,
    pendingVertexSelection: null,
    vertexGuideOptions: { showGrid: true, showRuler: true },
  };
};

export const useMapWorkspaceState = (): MapWorkspaceState &
  MapWorkspaceStateSetters &
  MapWorkspaceCommands => {
  const { state, setField } = useTypedStateGroup(
    createInitialMapWorkspaceState,
  );
  const setters = useMemo<MapWorkspaceStateSetters>(
    () => ({
      setMapTabMenuOpen: (value) => setField("mapTabMenuOpen", value),
      setMapTabMenuPosition: (value) => setField("mapTabMenuPosition", value),
      setVisitListPanelOpen: (value) => setField("visitListPanelOpen", value),
      setVisitListPanelMapTab: (value) =>
        setField("visitListPanelMapTab", value),
      setVisitListHasUnsavedChanges: (value) =>
        setField("visitListHasUnsavedChanges", value),
      setVisitListOriginalOrder: (value) =>
        setField("visitListOriginalOrder", value),
      setHighlightedMapCell: (value) => setField("highlightedMapCell", value),
      setShowVisitListConfirmDialog: (value) =>
        setField("showVisitListConfirmDialog", value),
      setPendingTabChange: (value) => setField("pendingTabChange", value),
      setBlockDefinitionMode: (value) => setField("blockDefinitionMode", value),
      setMapSelectedHallId: (value) => setField("mapSelectedHallId", value),
      setMapIsRouteVisible: (value) => setField("mapIsRouteVisible", value),
      setMapIsHallOrderOpen: (value) => setField("mapIsHallOrderOpen", value),
      setMapHallSelectorOpen: (value) => setField("mapHallSelectorOpen", value),
      setMapSmartInsertEnabled: (value) =>
        setField("mapSmartInsertEnabled", value),
      setMapSmartInsertMode: (value) => setField("mapSmartInsertMode", value),
      setSmartInsertToast: (value) => setField("smartInsertToast", value),
      setSmartInsertToastType: (value) =>
        setField("smartInsertToastType", value),
      setCellSelectionMode: (value) => setField("cellSelectionMode", value),
      setPendingCellSelection: (value) =>
        setField("pendingCellSelection", value),
      setHallDefinitionMode: (value) => setField("hallDefinitionMode", value),
      setVertexSelectionMode: (value) => setField("vertexSelectionMode", value),
      setPendingVertexSelection: (value) =>
        setField("pendingVertexSelection", value),
      setVertexGuideOptions: (value) => setField("vertexGuideOptions", value),
    }),
    [setField],
  );
  const showSmartInsertToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      setters.setSmartInsertToastType(type);
      setters.setSmartInsertToast(message);
    },
    [setters],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "mapSmartInsertEnabled",
        String(state.mapSmartInsertEnabled),
      );
    } catch {
      console.error(
        "Smart insert preference save failed (preference-save-failed).",
      );
      showSmartInsertToast("スマート挿入設定の保存に失敗しました。", "error");
    }
  }, [showSmartInsertToast, state.mapSmartInsertEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        "mapSmartInsertMode",
        state.mapSmartInsertMode,
      );
    } catch {
      console.error("Smart insert mode save failed (preference-save-failed).");
      showSmartInsertToast("スマート挿入モードの保存に失敗しました。", "error");
    }
  }, [showSmartInsertToast, state.mapSmartInsertMode]);

  useEffect(() => {
    if (!state.smartInsertToast) return;
    const timer = window.setTimeout(
      () => setters.setSmartInsertToast(null),
      2000,
    );
    return () => window.clearTimeout(timer);
  }, [setters, state.smartInsertToast]);

  return useMemo(
    () => ({ ...state, ...setters, showSmartInsertToast }),
    [setters, showSmartInsertToast, state],
  );
};
