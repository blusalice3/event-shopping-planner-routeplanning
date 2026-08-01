import type {
  DayMapData,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from "../../../types/map";
import type { ExecuteModeItems, ShoppingItem } from "../../../types/item";
import { getMaplessKey } from "../../../types/map";
import { normalizeRotationAngle } from "../canvas/useCanvasViewport";

export interface MapReimportState {
  eventLists: Record<string, ShoppingItem[]>;
  executeModeItems: Record<string, ExecuteModeItems>;
  mapData: MapDataStore;
  mapRotationSettings: MapRotationSettingsStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  mapViewportSettings: MapViewportSettingsStore;
}

export interface MapReimportTarget {
  eventDate: string;
  mapTabName: string;
  mapData: DayMapData;
  initialAngle: number;
}

export interface MapReimportImpact {
  targetDayCount: number;
  visitPointCount: number;
  mapHallDefinitionCount: number;
  manualAssignmentCount: number;
  hallRouteDayCount: number;
  viewportDayCount: number;
  rotationDayCount: number;
  maplessHallDefinitionCount: number;
  maplessManualAssignmentCount: number;
  maplessHallRouteDayCount: number;
}

interface PlannedMapReimportTarget extends MapReimportTarget {
  maplessKey: string;
  oldMapHallIds: string[];
  oldMaplessHallIds: string[];
}

export interface MapReimportPlan {
  eventName: string;
  targets: PlannedMapReimportTarget[];
  impact: MapReimportImpact;
}

export interface MapReimportOptions {
  preserveMaplessHalls: boolean;
}

const clonePlainValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePlainValue(entry)) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
      clone[key] = clonePlainValue(entry);
    });
    return clone as T;
  }
  return value;
};

const unique = (values: readonly string[]): string[] =>
  Array.from(new Set(values));

const countManualAssignments = ({
  items,
  eventDate,
  retainedHallIds,
}: {
  items: readonly ShoppingItem[];
  eventDate: string;
  retainedHallIds?: ReadonlySet<string>;
}): number => {
  return items.filter(
    (item) =>
      item.eventDate.trim() === eventDate &&
      !!item.manualHallId &&
      !retainedHallIds?.has(item.manualHallId),
  ).length;
};

const validateTargets = (
  eventName: string,
  targets: readonly MapReimportTarget[],
): void => {
  if (!eventName.trim()) {
    throw new Error("取り込み先のイベント名が指定されていません。");
  }
  if (targets.length === 0) {
    throw new Error("取り込めるマップがありません。");
  }

  const mapTabs = new Set<string>();
  const eventDates = new Set<string>();
  targets.forEach((target) => {
    const eventDate = target.eventDate.trim();
    const mapTabName = target.mapTabName.trim();
    if (!eventDate || !mapTabName) {
      throw new Error("取り込み先の日付またはマップ名が空です。");
    }
    if (mapTabs.has(mapTabName) || eventDates.has(eventDate)) {
      throw new Error(
        `「${eventDate}」の取り込み先が重複しています。マップは1日につき1件にしてください。`,
      );
    }
    if (
      !Array.isArray(target.mapData.blocks) ||
      target.mapData.blocks.length === 0
    ) {
      throw new Error(
        `「${mapTabName}」には有効なブロックがないため取り込めません。`,
      );
    }
    if (!Number.isFinite(target.initialAngle)) {
      throw new Error(`「${mapTabName}」の回転角度が不正です。`);
    }
    mapTabs.add(mapTabName);
    eventDates.add(eventDate);
  });
};

export const buildMapReimportPlan = ({
  state,
  eventName,
  targets,
}: {
  state: MapReimportState;
  eventName: string;
  targets: readonly MapReimportTarget[];
}): MapReimportPlan => {
  validateTargets(eventName, targets);
  if (!Object.prototype.hasOwnProperty.call(state.eventLists, eventName)) {
    throw new Error(`取り込み先のイベント「${eventName}」が見つかりません。`);
  }

  const eventItems = state.eventLists[eventName];
  const plannedTargets = targets.map((target): PlannedMapReimportTarget => {
    const eventDate = target.eventDate.trim();
    const mapTabName = target.mapTabName.trim();
    const maplessKey = getMaplessKey(eventDate);
    return {
      eventDate,
      mapTabName,
      mapData: clonePlainValue(target.mapData),
      initialAngle: normalizeRotationAngle(target.initialAngle),
      maplessKey,
      oldMapHallIds: unique(
        (state.hallDefinitions[eventName]?.[mapTabName] || []).map(
          (hall) => hall.id,
        ),
      ),
      oldMaplessHallIds: unique(
        (state.hallDefinitions[eventName]?.[maplessKey] || []).map(
          (hall) => hall.id,
        ),
      ),
    };
  });

  const impact = plannedTargets.reduce<MapReimportImpact>(
    (summary, target) => {
      const maplessHallIds = new Set(target.oldMaplessHallIds);
      const baseManualCount = countManualAssignments({
        items: eventItems,
        eventDate: target.eventDate,
        retainedHallIds: maplessHallIds,
      });
      const allManualCount = countManualAssignments({
        items: eventItems,
        eventDate: target.eventDate,
      });
      const currentRoute = state.routeSettings[eventName]?.[target.mapTabName];

      summary.targetDayCount += 1;
      summary.visitPointCount += currentRoute?.visitOrder?.length || 0;
      summary.mapHallDefinitionCount += target.oldMapHallIds.length;
      summary.manualAssignmentCount += baseManualCount;
      summary.hallRouteDayCount += state.hallRouteSettings[eventName]?.[
        target.mapTabName
      ]
        ? 1
        : 0;
      summary.viewportDayCount += state.mapViewportSettings[eventName]?.[
        target.mapTabName
      ]
        ? 1
        : 0;
      summary.rotationDayCount += 1;
      summary.maplessHallDefinitionCount += target.oldMaplessHallIds.length;
      summary.maplessManualAssignmentCount += allManualCount - baseManualCount;
      summary.maplessHallRouteDayCount += state.hallRouteSettings[eventName]?.[
        target.maplessKey
      ]
        ? 1
        : 0;
      return summary;
    },
    {
      targetDayCount: 0,
      visitPointCount: 0,
      mapHallDefinitionCount: 0,
      manualAssignmentCount: 0,
      hallRouteDayCount: 0,
      viewportDayCount: 0,
      rotationDayCount: 0,
      maplessHallDefinitionCount: 0,
      maplessManualAssignmentCount: 0,
      maplessHallRouteDayCount: 0,
    },
  );

  return {
    eventName,
    targets: plannedTargets,
    impact,
  };
};

const removeEventKeys = <T>(
  store: Record<string, Record<string, T>>,
  eventName: string,
  keys: ReadonlySet<string>,
): Record<string, Record<string, T>> => {
  const currentEvent = store[eventName];
  if (!currentEvent || !Array.from(keys).some((key) => key in currentEvent)) {
    return store;
  }
  const nextEvent = { ...currentEvent };
  keys.forEach((key) => {
    delete nextEvent[key];
  });
  return {
    ...store,
    [eventName]: nextEvent,
  };
};

export const applyMapReimportPlan = <TState extends MapReimportState>(
  state: TState,
  plan: MapReimportPlan,
  options: MapReimportOptions,
): TState => {
  const mapTabKeys = new Set(plan.targets.map((target) => target.mapTabName));
  const maplessKeys = new Set(plan.targets.map((target) => target.maplessKey));
  const hallKeysToRemove = options.preserveMaplessHalls
    ? mapTabKeys
    : new Set([...mapTabKeys, ...maplessKeys]);

  const nextEventMapData = {
    ...(state.mapData[plan.eventName] || {}),
  };
  plan.targets.forEach((target) => {
    nextEventMapData[target.mapTabName] = clonePlainValue(target.mapData);
  });

  let nextRouteSettings = state.routeSettings;
  const currentEventRoutes = state.routeSettings[plan.eventName];
  if (
    currentEventRoutes &&
    plan.targets.some((target) => currentEventRoutes[target.mapTabName])
  ) {
    const nextEventRoutes = { ...currentEventRoutes };
    plan.targets.forEach((target) => {
      const current = currentEventRoutes[target.mapTabName];
      if (current) {
        nextEventRoutes[target.mapTabName] = {
          ...current,
          isRouteVisible: current.isRouteVisible,
          visitOrder: [],
        };
      }
    });
    nextRouteSettings = {
      ...state.routeSettings,
      [plan.eventName]: nextEventRoutes,
    };
  }

  const currentItems = state.eventLists[plan.eventName] || [];
  let itemsChanged = false;
  const nextItems = currentItems.map((item) => {
    const target = plan.targets.find(
      (candidate) => item.eventDate.trim() === candidate.eventDate,
    );
    if (!target || !item.manualHallId) return item;

    const retainedMaplessIds = new Set(target.oldMaplessHallIds);
    if (
      options.preserveMaplessHalls &&
      retainedMaplessIds.has(item.manualHallId)
    ) {
      return item;
    }

    itemsChanged = true;
    const { manualHallId: _removed, ...itemWithoutManualHall } = item;
    return itemWithoutManualHall;
  });

  const nextRotationForEvent = {
    ...(state.mapRotationSettings[plan.eventName] || {}),
  };
  plan.targets.forEach((target) => {
    nextRotationForEvent[target.mapTabName] = {
      initialAngle: target.initialAngle,
      mapTabAngle: target.initialAngle,
      focusModeAngle: target.initialAngle,
    };
  });

  return {
    ...state,
    eventLists: itemsChanged
      ? {
          ...state.eventLists,
          [plan.eventName]: nextItems,
        }
      : state.eventLists,
    mapData: {
      ...state.mapData,
      [plan.eventName]: nextEventMapData,
    },
    mapRotationSettings: {
      ...state.mapRotationSettings,
      [plan.eventName]: nextRotationForEvent,
    },
    routeSettings: nextRouteSettings,
    hallDefinitions: removeEventKeys(
      state.hallDefinitions,
      plan.eventName,
      hallKeysToRemove,
    ),
    hallRouteSettings: removeEventKeys(
      state.hallRouteSettings,
      plan.eventName,
      hallKeysToRemove,
    ),
    mapViewportSettings: removeEventKeys(
      state.mapViewportSettings,
      plan.eventName,
      mapTabKeys,
    ),
  };
};
