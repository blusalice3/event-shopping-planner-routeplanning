import {
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  CellPosition,
  MapTabMenuPosition,
  SmartInsertMode,
  VertexGuideOptions,
} from "../../features/app-shell/types";
import { normalizeSmartInsertMode } from "../../utils/smartInsertMode";
import type { PreferencePersistencePort } from "../ports/PersistenceCommandPort";
import { useTypedStateGroup } from "./useTypedStateGroup";

export interface MapWorkspaceState {
  mapTabMenuOpen: string | null;
  mapTabMenuPosition: MapTabMenuPosition;
  highlightedMapCell: CellPosition | null;
  mapSelectedHallId: string;
  mapIsRouteVisible: boolean;
  mapIsHallOrderOpen: boolean;
  mapHallSelectorOpen: boolean;
  mapSmartInsertEnabled: boolean;
  mapSmartInsertMode: SmartInsertMode;
  vertexGuideOptions: VertexGuideOptions;
}

export type MapWorkspaceStateSetters = {
  [K in keyof MapWorkspaceState as `set${Capitalize<string & K>}`]: Dispatch<
    SetStateAction<MapWorkspaceState[K]>
  >;
};

type PreferenceReader = Pick<Storage, "getItem">;
export const createInitialMapWorkspaceState = (
  storage: PreferenceReader | null,
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
    highlightedMapCell: null,
    mapSelectedHallId: "all",
    mapIsRouteVisible: true,
    mapIsHallOrderOpen: false,
    mapHallSelectorOpen: false,
    mapSmartInsertEnabled,
    mapSmartInsertMode,
    vertexGuideOptions: { showGrid: true, showRuler: true },
  };
};

export const useMapWorkspaceState = (
  preferenceCommands: PreferencePersistencePort,
  showSmartInsertToast: (message: string, type?: "success" | "error") => void,
): MapWorkspaceState & MapWorkspaceStateSetters => {
  const { state, setField } = useTypedStateGroup(() =>
    createInitialMapWorkspaceState({
      getItem: (key: string) => preferenceCommands.loadPreference(key),
    }),
  );
  const smartInsertNotificationRef = useRef(showSmartInsertToast);
  smartInsertNotificationRef.current = showSmartInsertToast;
  const setters = useMemo<MapWorkspaceStateSetters>(
    () => ({
      setMapTabMenuOpen: (value) => setField("mapTabMenuOpen", value),
      setMapTabMenuPosition: (value) => setField("mapTabMenuPosition", value),
      setHighlightedMapCell: (value) => setField("highlightedMapCell", value),
      setMapSelectedHallId: (value) => setField("mapSelectedHallId", value),
      setMapIsRouteVisible: (value) => setField("mapIsRouteVisible", value),
      setMapIsHallOrderOpen: (value) => setField("mapIsHallOrderOpen", value),
      setMapHallSelectorOpen: (value) => setField("mapHallSelectorOpen", value),
      setMapSmartInsertEnabled: (value) =>
        setField("mapSmartInsertEnabled", value),
      setMapSmartInsertMode: (value) => setField("mapSmartInsertMode", value),
      setVertexGuideOptions: (value) => setField("vertexGuideOptions", value),
    }),
    [setField],
  );
  useEffect(() => {
    try {
      preferenceCommands.savePreference(
        "mapSmartInsertEnabled",
        String(state.mapSmartInsertEnabled),
      );
    } catch {
      console.error(
        "Smart insert preference save failed (preference-save-failed).",
      );
      smartInsertNotificationRef.current(
        "スマート挿入設定の保存に失敗しました。",
        "error",
      );
    }
  }, [preferenceCommands, state.mapSmartInsertEnabled]);

  useEffect(() => {
    try {
      preferenceCommands.savePreference(
        "mapSmartInsertMode",
        state.mapSmartInsertMode,
      );
    } catch {
      console.error("Smart insert mode save failed (preference-save-failed).");
      smartInsertNotificationRef.current(
        "スマート挿入モードの保存に失敗しました。",
        "error",
      );
    }
  }, [preferenceCommands, state.mapSmartInsertMode]);

  return useMemo(() => ({ ...state, ...setters }), [setters, state]);
};
