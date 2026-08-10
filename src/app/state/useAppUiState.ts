import { useMemo, type Dispatch, type SetStateAction } from "react";
import type { FocusModeSessionState } from "../../types/focus";
import type { ShoppingItem } from "../../types/item";
import type {
  BlockSortDirection,
  LayoutMode,
  SortState,
} from "../../features/app-shell/types";
import { useTypedStateGroup } from "./useTypedStateGroup";

export type NewItemDefaults = {
  eventDate: string;
  block: string;
  number: string;
};

export interface AppUiState {
  sortState: SortState;
  blockSortDirection: BlockSortDirection | null;
  itemToEdit: ShoppingItem | null;
  zoomLevel: number;
  recentlyChangedItemIds: Set<string>;
  newItemDefaults: NewItemDefaults | null;
  searchKeyword: string;
  currentSearchIndex: number;
  highlightedItemId: string | null;
  layoutMode: LayoutMode;
  uiVisibilityOverride: boolean;
  focusModeMapVisible: boolean;
  focusModeSessions: Record<string, FocusModeSessionState>;
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
  zoomLevel: 100,
  recentlyChangedItemIds: new Set(),
  newItemDefaults: null,
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
      setZoomLevel: (value) => setField("zoomLevel", value),
      setRecentlyChangedItemIds: (value) =>
        setField("recentlyChangedItemIds", value),
      setNewItemDefaults: (value) => setField("newItemDefaults", value),
      setSearchKeyword: (value) => setField("searchKeyword", value),
      setCurrentSearchIndex: (value) => setField("currentSearchIndex", value),
      setHighlightedItemId: (value) => setField("highlightedItemId", value),
      setLayoutMode: (value) => setField("layoutMode", value),
      setUiVisibilityOverride: (value) =>
        setField("uiVisibilityOverride", value),
      setFocusModeMapVisible: (value) => setField("focusModeMapVisible", value),
      setFocusModeSessions: (value) => setField("focusModeSessions", value),
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
