import { useCallback, useMemo } from "react";
import type { ExecuteModeItems, ShoppingItem } from "../../types/item";
import {
  getMaplessKey,
  type DayMapRotationState,
  type HallDefinitionsStore,
  type HallRouteSettings,
  type HallRouteSettingsStore,
  type MapDataStore,
  type MapRotationSettingsStore,
  type MapViewportSettingsStore,
  type MapViewportState,
} from "../../types/map";
import {
  normalizeRotationAngle,
  resolveDayMapRotationState,
  selectCurrentMapRotations,
  selectCurrentMapViewport,
} from "../selectors/appMapViewSelectors";
import {
  getCombinedHallRouteSettingsForDate,
  reorderExecuteIdsByHallOrder,
  splitGlobalHallRouteSettings,
} from "../../features/map/domain/hallOperations";
import { buildMergedHallRouteSettings } from "../../utils/mergedHallRouteSettings";

type StateUpdater<T> = (current: T) => T;
type ExecuteModeItemsStore = Record<string, ExecuteModeItems>;

export interface MapRouteStatePort {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly isMapTab: boolean;
  readonly currentMapTabName: string | null;
  readonly currentFocusMapName: string;
  readonly routeVisible: boolean;
  readonly mapRotationSettings: MapRotationSettingsStore;
  readonly mapViewportSettings: MapViewportSettingsStore;
  readonly mapData: MapDataStore;
  readonly hallDefinitions: HallDefinitionsStore;
  readonly hallRouteSettings: HallRouteSettingsStore;
  readonly executeModeItems: ExecuteModeItemsStore;
  readonly items: ShoppingItem[];
}

export interface MapRouteActionPort {
  setRouteVisible(value: boolean): void;
  setMapRotationSettings(updater: StateUpdater<MapRotationSettingsStore>): void;
  setMapViewportSettings(updater: StateUpdater<MapViewportSettingsStore>): void;
  setHallRouteSettings(updater: StateUpdater<HallRouteSettingsStore>): void;
  updateExecuteModeItems(updater: StateUpdater<ExecuteModeItemsStore>): void;
}

export interface MapRouteSelectorPort {
  getMapTabForDate(eventDate: string): string | null;
}

export interface MapRouteCommandPorts {
  readonly state: MapRouteStatePort;
  readonly actions: MapRouteActionPort;
  readonly selectors: MapRouteSelectorPort;
}

export interface MapRouteSelection {
  readonly currentMapTabRotation: DayMapRotationState;
  readonly currentFocusMapRotation: DayMapRotationState;
  readonly currentMapTabViewport: MapViewportState | undefined;
  readonly globalMapTabName: string | null;
  readonly globalHallRouteSettings: HallRouteSettings;
}

export interface MapRouteCommands {
  setRouteVisibility(visible: boolean): void;
  toggleRouteVisibility(): void;
  updateMapTabRotation(angle: number): void;
  updateFocusMapRotation(angle: number): void;
  updateMapViewport(viewport: MapViewportState): void;
  updateCurrentHallRouteSettings(settings: HallRouteSettings): void;
  updateGlobalHallRouteSettings(settings: HallRouteSettings): void;
  reorderExecuteListByHallOrder(hallOrder: string[]): void;
}

export interface MapRouteController
  extends MapRouteSelection, MapRouteCommands {}

export const useMapRouteCommands = ({
  state,
  actions,
  selectors,
}: MapRouteCommandPorts): MapRouteController => {
  const {
    activeEventName,
    activeEventDate,
    isMapTab,
    currentMapTabName,
    currentFocusMapName,
    routeVisible,
    mapRotationSettings,
    mapViewportSettings,
    mapData,
    hallDefinitions,
    hallRouteSettings,
    executeModeItems,
    items,
  } = state;
  const {
    setRouteVisible,
    setMapRotationSettings,
    setMapViewportSettings,
    setHallRouteSettings,
    updateExecuteModeItems,
  } = actions;
  const { getMapTabForDate } = selectors;

  const rotations = useMemo(
    () =>
      selectCurrentMapRotations({
        activeEventName,
        isMapTab,
        currentMapTabName,
        currentFocusMapName,
        mapRotationSettings,
      }),
    [
      activeEventName,
      currentFocusMapName,
      currentMapTabName,
      isMapTab,
      mapRotationSettings,
    ],
  );
  const currentMapTabViewport = useMemo(
    () =>
      selectCurrentMapViewport({
        activeEventName,
        isMapTab,
        currentMapTabName,
        mapViewportSettings,
      }),
    [activeEventName, currentMapTabName, isMapTab, mapViewportSettings],
  );
  const globalMapTabName = useMemo(
    () => (activeEventDate ? getMapTabForDate(activeEventDate) : null),
    [activeEventDate, getMapTabForDate],
  );
  const globalHallRouteSettings = useMemo(() => {
    const executeIds =
      activeEventName && activeEventDate
        ? executeModeItems[activeEventName]?.[activeEventDate] || []
        : [];
    return buildMergedHallRouteSettings({
      eventName: activeEventName,
      dayName: activeEventDate,
      mapTabName: globalMapTabName,
      hallDefinitionsStore: hallDefinitions,
      hallRouteSettingsStore: hallRouteSettings,
      executeIds,
      items,
      mapDataStore: mapData,
    }).mergedSettings;
  }, [
    activeEventDate,
    activeEventName,
    executeModeItems,
    globalMapTabName,
    hallDefinitions,
    hallRouteSettings,
    items,
    mapData,
  ]);

  const setRouteVisibility = useCallback(
    (visible: boolean) => setRouteVisible(visible),
    [setRouteVisible],
  );
  const toggleRouteVisibility = useCallback(
    () => setRouteVisible(!routeVisible),
    [routeVisible, setRouteVisible],
  );

  const updateRotation = useCallback(
    (
      eventName: string,
      mapName: string,
      screen: "mapTab" | "focusMode",
      angle: number,
    ) => {
      const normalizedAngle = normalizeRotationAngle(angle);
      setMapRotationSettings((current) => {
        const eventSettings = current[eventName] || {};
        const currentState = resolveDayMapRotationState(eventSettings[mapName]);
        const nextState =
          screen === "mapTab"
            ? { ...currentState, mapTabAngle: normalizedAngle }
            : { ...currentState, focusModeAngle: normalizedAngle };
        if (
          currentState.initialAngle === nextState.initialAngle &&
          currentState.mapTabAngle === nextState.mapTabAngle &&
          currentState.focusModeAngle === nextState.focusModeAngle
        ) {
          return current;
        }
        return {
          ...current,
          [eventName]: {
            ...eventSettings,
            [mapName]: nextState,
          },
        };
      });
    },
    [setMapRotationSettings],
  );

  const updateMapTabRotation = useCallback(
    (angle: number) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      updateRotation(activeEventName, currentMapTabName, "mapTab", angle);
    },
    [activeEventName, currentMapTabName, isMapTab, updateRotation],
  );
  const updateFocusMapRotation = useCallback(
    (angle: number) => {
      if (!activeEventName || !currentFocusMapName) return;
      updateRotation(activeEventName, currentFocusMapName, "focusMode", angle);
    },
    [activeEventName, currentFocusMapName, updateRotation],
  );
  const updateMapViewport = useCallback(
    (viewport: MapViewportState) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      setMapViewportSettings((current) => {
        const eventSettings = current[activeEventName] || {};
        const currentViewport = eventSettings[currentMapTabName];
        if (
          currentViewport &&
          currentViewport.zoomLevel === viewport.zoomLevel &&
          currentViewport.offsetX === viewport.offsetX &&
          currentViewport.offsetY === viewport.offsetY
        ) {
          return current;
        }
        return {
          ...current,
          [activeEventName]: {
            ...eventSettings,
            [currentMapTabName]: viewport,
          },
        };
      });
    },
    [activeEventName, currentMapTabName, isMapTab, setMapViewportSettings],
  );

  const updateCurrentHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName || !isMapTab || !currentMapTabName) return;
      setHallRouteSettings((current) => ({
        ...current,
        [activeEventName]: {
          ...current[activeEventName],
          [currentMapTabName]: settings,
        },
      }));
    },
    [activeEventName, currentMapTabName, isMapTab, setHallRouteSettings],
  );

  const updateGlobalHallRouteSettings = useCallback(
    (settings: HallRouteSettings) => {
      if (!activeEventName) return;
      const mapHallIds = new Set(
        globalMapTabName
          ? (hallDefinitions[activeEventName]?.[globalMapTabName] || []).map(
              (hall) => hall.id,
            )
          : [],
      );
      const maplessKey = activeEventDate
        ? getMaplessKey(activeEventDate)
        : null;
      const maplessHallIds = new Set(
        (maplessKey
          ? hallDefinitions[activeEventName]?.[maplessKey] || []
          : []
        ).map((hall) => hall.id),
      );
      const { mapSettings, maplessSettings } = splitGlobalHallRouteSettings({
        settings,
        mapHallIds,
        maplessHallIds,
        hasMapTab: globalMapTabName !== null,
      });

      setHallRouteSettings((current) => {
        const eventSettings = { ...(current[activeEventName] || {}) };
        if (globalMapTabName) eventSettings[globalMapTabName] = mapSettings;
        if (maplessKey) eventSettings[maplessKey] = maplessSettings;
        return { ...current, [activeEventName]: eventSettings };
      });
    },
    [
      activeEventDate,
      activeEventName,
      globalMapTabName,
      hallDefinitions,
      setHallRouteSettings,
    ],
  );

  const reorderExecuteListByHallOrder = useCallback(
    (hallOrder: string[]) => {
      if (!activeEventName || !activeEventDate) return;
      const dayName = activeEventDate;
      const mapTabName = getMapTabForDate(dayName);
      const currentMapData = mapTabName
        ? mapData[activeEventName]?.[mapTabName]
        : undefined;
      const mapHalls = mapTabName
        ? hallDefinitions[activeEventName]?.[mapTabName] || []
        : [];
      const maplessHalls =
        hallDefinitions[activeEventName]?.[getMaplessKey(dayName)] || [];
      const halls = [...mapHalls, ...maplessHalls];
      const currentHallRouteSettings = getCombinedHallRouteSettingsForDate({
        eventName: activeEventName,
        dayName,
        mapTabName,
        hallRouteSettings,
      });

      updateExecuteModeItems((current) => {
        const eventItems = current[activeEventName] || {};
        const dayItems = [...(eventItems[dayName] || [])];
        if (dayItems.length === 0) return current;
        return {
          ...current,
          [activeEventName]: {
            ...eventItems,
            [dayName]: reorderExecuteIdsByHallOrder({
              hallOrder,
              dayItems,
              items,
              halls,
              mapData: currentMapData,
              hallRouteSettings: currentHallRouteSettings,
            }),
          },
        };
      });
    },
    [
      activeEventDate,
      activeEventName,
      getMapTabForDate,
      hallDefinitions,
      hallRouteSettings,
      items,
      mapData,
      updateExecuteModeItems,
    ],
  );

  return {
    currentMapTabRotation: rotations.mapTab,
    currentFocusMapRotation: rotations.focus,
    currentMapTabViewport,
    globalMapTabName,
    globalHallRouteSettings,
    setRouteVisibility,
    toggleRouteVisibility,
    updateMapTabRotation,
    updateFocusMapRotation,
    updateMapViewport,
    updateCurrentHallRouteSettings,
    updateGlobalHallRouteSettings,
    reorderExecuteListByHallOrder,
  };
};
