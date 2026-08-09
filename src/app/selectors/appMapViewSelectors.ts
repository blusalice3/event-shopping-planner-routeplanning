import type { FocusModeSessionState } from "../../types/focus";
import type { DayModeState, ShoppingItem, ViewMode } from "../../types/item";
import type {
  DayMapData,
  DayMapRotationState,
  HallDefinition,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  MapViewportState,
} from "../../types/map";
import type { LayoutMode } from "../../features/app-shell/types";
import type { UIVisibilitySettings } from "../../hooks/useUIVisibilitySettings";
import { extractEventDates } from "../../utils/eventDates";
import {
  resolveHallByBlockName,
  resolveManualHallId,
} from "../../utils/hallFallback";
import { isPointInPolygonInclusive } from "../../utils/mapRoutePolygon";
import { getSpaceKey } from "../../utils/spaceGrouping";

export type AppDayModeStore = Readonly<Record<string, DayModeState>>;
export type FocusModeSessionStore = Readonly<
  Record<string, FocusModeSessionState>
>;

export interface HallCountSelectorInput {
  readonly hallId: string;
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly isMapTab: boolean;
  readonly currentMapData: DayMapData | null;
  readonly currentHalls: readonly HallDefinition[];
  readonly items: readonly ShoppingItem[];
  readonly executeModeItems: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
}

const isItemInsideHall = (
  item: ShoppingItem,
  hallId: string,
  mapData: DayMapData,
  halls: readonly HallDefinition[],
): boolean => {
  const block = mapData.blocks.find(
    (candidate) => candidate.name === item.block,
  );
  if (!block) return false;

  const centerRow = (block.startRow + block.endRow) / 2;
  const centerCol = (block.startCol + block.endCol) / 2;

  return halls.some(
    (hall) =>
      hall.id === hallId &&
      hall.vertices.length >= 4 &&
      isPointInPolygonInclusive(centerRow, centerCol, hall.vertices),
  );
};

export const selectHallExecuteCount = (
  input: HallCountSelectorInput,
): number => {
  if (
    !input.activeEventName ||
    !input.isMapTab ||
    !input.currentMapData ||
    !input.activeEventDate
  ) {
    return 0;
  }

  const executeIds =
    input.executeModeItems[input.activeEventName]?.[input.activeEventDate] ??
    [];

  return executeIds.filter((itemId) => {
    const item = input.items.find((candidate) => candidate.id === itemId);
    return (
      item != null &&
      isItemInsideHall(
        item,
        input.hallId,
        input.currentMapData!,
        input.currentHalls,
      )
    );
  }).length;
};

export const selectHallTotalItemCount = (
  input: HallCountSelectorInput,
): number => {
  if (
    !input.activeEventName ||
    !input.isMapTab ||
    !input.currentMapData ||
    !input.activeEventDate
  ) {
    return 0;
  }

  return input.items.filter(
    (item) =>
      item.eventDate === input.activeEventDate &&
      isItemInsideHall(
        item,
        input.hallId,
        input.currentMapData!,
        input.currentHalls,
      ),
  ).length;
};

export interface ItemHallSelectorInput {
  readonly item: ShoppingItem;
  readonly halls: readonly HallDefinition[];
  readonly mapData: DayMapData | null;
}

export const selectItemHallId = (
  input: ItemHallSelectorInput,
): string | null => {
  const halls = [...input.halls];
  if (halls.length === 0) return null;

  const manualHallId = resolveManualHallId(input.item.manualHallId, halls);
  if (manualHallId) return manualHallId;

  if (input.mapData) {
    const block = input.mapData.blocks.find(
      (candidate) => candidate.name === input.item.block,
    );
    if (block) {
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;
      for (const hall of halls) {
        if (
          hall.vertices.length >= 4 &&
          isPointInPolygonInclusive(centerRow, centerCol, hall.vertices)
        ) {
          return hall.id;
        }
      }
    }
  }

  return resolveHallByBlockName(input.item.block, halls);
};

export interface HallRelationshipSelectorInput {
  readonly firstItemId: string;
  readonly secondItemId: string;
  readonly items: readonly ShoppingItem[];
  readonly halls: readonly HallDefinition[];
  readonly mapData: DayMapData | null;
}

const selectHallRelationship = (
  input: HallRelationshipSelectorInput,
  includeSpace: boolean,
): boolean => {
  const firstItem = input.items.find((item) => item.id === input.firstItemId);
  const secondItem = input.items.find((item) => item.id === input.secondItemId);
  if (!firstItem || !secondItem || input.halls.length === 0) return true;

  const firstHallId = selectItemHallId({
    item: firstItem,
    halls: input.halls,
    mapData: input.mapData,
  });
  const secondHallId = selectItemHallId({
    item: secondItem,
    halls: input.halls,
    mapData: input.mapData,
  });
  if (firstHallId === null || secondHallId === null) return true;

  const firstPriority = firstItem.priorityLevel ?? "none";
  const secondPriority = secondItem.priorityLevel ?? "none";
  if (firstHallId !== secondHallId || firstPriority !== secondPriority) {
    return false;
  }

  return (
    !includeSpace ||
    getSpaceKey(firstItem.block, firstItem.number) ===
      getSpaceKey(secondItem.block, secondItem.number)
  );
};

export const selectItemsInSameHallVisit = (
  input: HallRelationshipSelectorInput,
): boolean => selectHallRelationship(input, true);

export const selectItemsInSameHallGroup = (
  input: HallRelationshipSelectorInput,
): boolean => selectHallRelationship(input, false);

export interface CurrentModeSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly dayModes: AppDayModeStore;
}

export const selectCurrentMode = (
  input: CurrentModeSelectorInput,
): ViewMode => {
  if (!input.activeEventName) return "execute";
  const modes = input.dayModes[input.activeEventName];
  if (!modes || !input.activeEventDate) return "edit";
  return modes[input.activeEventDate] ?? "edit";
};

export const buildFocusSessionKey = (
  eventName: string,
  eventDate: string,
): string => `${eventName}::${eventDate}`;

export interface CurrentFocusSessionSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly focusModeSessions: FocusModeSessionStore;
}

export interface CurrentFocusSessionSelection {
  readonly sessionKey: string | null;
  readonly resumeState: FocusModeSessionState | null;
  readonly mapName: string;
}

export const selectCurrentFocusSession = (
  input: CurrentFocusSessionSelectorInput,
): CurrentFocusSessionSelection => {
  const sessionKey =
    input.activeEventName && input.activeEventDate
      ? buildFocusSessionKey(input.activeEventName, input.activeEventDate)
      : null;
  return {
    sessionKey,
    resumeState: sessionKey
      ? (input.focusModeSessions[sessionKey] ?? null)
      : null,
    mapName: input.activeEventDate ? `${input.activeEventDate}マップ` : "",
  };
};

export interface ValidFocusSessionKeysSelectorInput {
  readonly eventLists: Readonly<Record<string, ShoppingItem[]>>;
}

export const selectValidFocusSessionKeys = (
  input: ValidFocusSessionKeysSelectorInput,
): ReadonlySet<string> => {
  const keys = new Set<string>();
  Object.entries(input.eventLists).forEach(([eventName, eventItems]) => {
    extractEventDates(eventItems).forEach((eventDate) => {
      keys.add(buildFocusSessionKey(eventName, eventDate));
    });
  });
  return keys;
};

const areStringArraysEqual = (
  first: readonly string[],
  second: readonly string[],
): boolean =>
  first.length === second.length &&
  first.every((value, index) => value === second[index]);

export const areFocusModeSessionStatesEqual = (
  first: FocusModeSessionState | undefined,
  second: FocusModeSessionState,
): boolean => {
  if (!first) return false;
  if (
    first.phase !== second.phase ||
    first.phaseIndex !== second.phaseIndex ||
    first.isCompleted !== second.isCompleted ||
    first.savedPhaseIndices.normal !== second.savedPhaseIndices.normal ||
    first.savedPhaseIndices.postponed !== second.savedPhaseIndices.postponed ||
    first.savedPhaseIndices.late !== second.savedPhaseIndices.late ||
    !areStringArraysEqual(first.postponedItemIds, second.postponedItemIds) ||
    !areStringArraysEqual(first.lateItemIds, second.lateItemIds)
  ) {
    return false;
  }

  const firstChange = first.lastPurchaseChangeAt ?? null;
  const secondChange = second.lastPurchaseChangeAt ?? null;
  if ((firstChange === null) !== (secondChange === null)) return false;
  return !(
    firstChange &&
    secondChange &&
    (firstChange.phase !== secondChange.phase ||
      firstChange.phaseIndex !== secondChange.phaseIndex ||
      firstChange.visitKey !== secondChange.visitKey)
  );
};

export const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

export const resolveDayMapRotationState = (
  state:
    | {
        readonly initialAngle?: number;
        readonly mapTabAngle?: number;
        readonly focusModeAngle?: number;
      }
    | undefined,
): DayMapRotationState => {
  const initialAngle = normalizeRotationAngle(state?.initialAngle ?? 0);
  return {
    initialAngle,
    mapTabAngle: normalizeRotationAngle(state?.mapTabAngle ?? initialAngle),
    focusModeAngle: normalizeRotationAngle(
      state?.focusModeAngle ?? initialAngle,
    ),
  };
};

export interface MapRotationSelectorInput {
  readonly activeEventName: string | null;
  readonly isMapTab: boolean;
  readonly currentMapTabName: string | null;
  readonly currentFocusMapName: string;
  readonly mapRotationSettings: MapRotationSettingsStore;
}

export interface MapRotationSelection {
  readonly mapTab: DayMapRotationState;
  readonly focus: DayMapRotationState;
}

export const selectCurrentMapRotations = (
  input: MapRotationSelectorInput,
): MapRotationSelection => {
  const mapTab =
    input.activeEventName && input.isMapTab && input.currentMapTabName
      ? input.mapRotationSettings[input.activeEventName]?.[
          input.currentMapTabName
        ]
      : undefined;
  const focus =
    input.activeEventName && input.currentFocusMapName
      ? input.mapRotationSettings[input.activeEventName]?.[
          input.currentFocusMapName
        ]
      : undefined;
  return {
    mapTab: resolveDayMapRotationState(mapTab),
    focus: resolveDayMapRotationState(focus),
  };
};

export interface MapViewportSelectorInput {
  readonly activeEventName: string | null;
  readonly isMapTab: boolean;
  readonly currentMapTabName: string | null;
  readonly mapViewportSettings: MapViewportSettingsStore;
}

export const selectCurrentMapViewport = (
  input: MapViewportSelectorInput,
): MapViewportState | undefined => {
  if (!input.activeEventName || !input.isMapTab || !input.currentMapTabName) {
    return undefined;
  }
  return input.mapViewportSettings[input.activeEventName]?.[
    input.currentMapTabName
  ];
};

export interface AppChromeVisibilitySelectorInput {
  readonly activeEventName: string | null;
  readonly currentMode: ViewMode;
  readonly layoutMode: LayoutMode;
  readonly focusModeMapVisible: boolean;
  readonly uiVisibilitySettings: UIVisibilitySettings;
  readonly uiVisibilityOverride: boolean;
  readonly uiSettingsPanelOpen: boolean;
}

export interface AppChromeVisibilitySelection {
  readonly showHeaderBar: boolean;
  readonly showTabBar: boolean;
  readonly rawHideSomething: boolean;
}

export const selectAppChromeVisibility = (
  input: AppChromeVisibilitySelectorInput,
): AppChromeVisibilitySelection => {
  if (!input.activeEventName) {
    return { showHeaderBar: true, showTabBar: true, rawHideSomething: false };
  }

  const layout = input.layoutMode === "smartphone" ? "sp" : "pc";
  let rawHeader = true;
  let rawTabBar = true;

  if (input.currentMode === "focus") {
    const key = `focus_${layout}_${
      input.focusModeMapVisible ? "mapOn" : "mapOff"
    }` as const;
    const config = input.uiVisibilitySettings[key];
    rawHeader = config.header;
    rawTabBar = config.tabBar;
  } else if (input.currentMode === "execute") {
    const config = input.uiVisibilitySettings[`execute_${layout}`];
    rawHeader = config.header;
    rawTabBar = config.tabBar;
  }

  const rawHideSomething = !rawHeader || !rawTabBar;
  if (input.uiVisibilityOverride || input.uiSettingsPanelOpen) {
    return { showHeaderBar: true, showTabBar: true, rawHideSomething };
  }
  return {
    showHeaderBar: rawHeader,
    showTabBar: rawTabBar,
    rawHideSomething,
  };
};
