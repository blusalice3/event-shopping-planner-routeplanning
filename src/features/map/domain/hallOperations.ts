import type {
  DayMapData,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettings,
  HallRouteSettingsStore,
} from "../../../types/map";
import type { ShoppingItem } from "../../../types/item";
import { getMaplessKey } from "../../../types/map";
import {
  resolveHallByBlockName,
  resolveManualHallId,
} from "../../../utils/hallFallback";

type PriorityLevel = "none" | "priority" | "highest";

export const emptyHallRouteSettings = (): HallRouteSettings => ({
  hallOrder: [],
  hallVisitLists: [],
});

export const extractHallIdFromGroupId = (groupId: string): string => {
  if (groupId.endsWith(":highest")) return groupId.replace(":highest", "");
  if (groupId.endsWith(":priority")) return groupId.replace(":priority", "");
  return groupId;
};

export const buildHallGroupId = (
  hallId: string | null,
  priority: PriorityLevel,
): string => {
  if (hallId === null) {
    if (priority === "highest") return "undefined:highest";
    if (priority === "priority") return "undefined:priority";
    return "undefined";
  }
  if (priority === "highest") return `${hallId}:highest`;
  if (priority === "priority") return `${hallId}:priority`;
  return hallId;
};

export const splitHallsForStorage = (
  halls: HallDefinition[],
): { polygonHalls: HallDefinition[]; maplessHalls: HallDefinition[] } => {
  const polygonHalls = halls
    .filter((hall) => hall.vertices && hall.vertices.length >= 4)
    .map(({ blockNames: _ignored, ...rest }) => rest as HallDefinition);
  const maplessHalls = halls.filter(
    (hall) =>
      (!hall.vertices || hall.vertices.length < 4) && !!hall.blockNames?.length,
  );

  return { polygonHalls, maplessHalls };
};

export const mergeHallOrder = (
  existingOrder: string[],
  hallIds: string[],
): string[] => [
  ...existingOrder.filter((id) =>
    hallIds.includes(extractHallIdFromGroupId(id)),
  ),
  ...hallIds.filter(
    (id) => !existingOrder.some((existingId) => existingId === id),
  ),
];

export const updateHallDefinitionsForHalls = ({
  previous,
  eventName,
  mapTabName,
  maplessKey,
  polygonHalls,
  maplessHalls,
}: {
  previous: HallDefinitionsStore;
  eventName: string;
  mapTabName: string;
  maplessKey: string | null;
  polygonHalls: HallDefinition[];
  maplessHalls: HallDefinition[];
}): HallDefinitionsStore => {
  const updated: HallDefinitionsStore = {
    ...previous,
    [eventName]: {
      ...(previous[eventName] || {}),
      [mapTabName]: polygonHalls,
    },
  };
  if (maplessKey) {
    updated[eventName][maplessKey] = maplessHalls;
  }
  return updated;
};

export const updateHallRouteSettingsForHalls = ({
  previous,
  eventName,
  mapTabName,
  maplessKey,
  polygonHalls,
  maplessHalls,
}: {
  previous: HallRouteSettingsStore;
  eventName: string;
  mapTabName: string;
  maplessKey: string | null;
  polygonHalls: HallDefinition[];
  maplessHalls: HallDefinition[];
}): HallRouteSettingsStore => {
  const previousEvent = previous[eventName] || {};
  const previousMapTab = previousEvent[mapTabName] || emptyHallRouteSettings();
  const polygonIds = polygonHalls.map((hall) => hall.id);
  const maplessIds = maplessHalls.map((hall) => hall.id);

  const updated: HallRouteSettingsStore = {
    ...previous,
    [eventName]: {
      ...previousEvent,
      [mapTabName]: {
        ...previousMapTab,
        hallOrder: mergeHallOrder(previousMapTab.hallOrder, polygonIds),
      },
    },
  };

  if (maplessKey) {
    const previousMapless =
      previousEvent[maplessKey] || emptyHallRouteSettings();
    updated[eventName][maplessKey] = {
      ...previousMapless,
      hallOrder: mergeHallOrder(previousMapless.hallOrder, maplessIds),
    };
  }

  return updated;
};

export const updateMaplessHallDefinitions = ({
  previous,
  eventName,
  maplessKey,
  halls,
}: {
  previous: HallDefinitionsStore;
  eventName: string;
  maplessKey: string;
  halls: HallDefinition[];
}): HallDefinitionsStore => ({
  ...previous,
  [eventName]: {
    ...(previous[eventName] || {}),
    [maplessKey]: halls,
  },
});

export const updateMaplessHallRouteSettings = ({
  previous,
  eventName,
  maplessKey,
  halls,
}: {
  previous: HallRouteSettingsStore;
  eventName: string;
  maplessKey: string;
  halls: HallDefinition[];
}): HallRouteSettingsStore => {
  const previousEvent = previous[eventName] || {};
  const previousSettings =
    previousEvent[maplessKey] || emptyHallRouteSettings();
  const hallIds = halls.map((hall) => hall.id);

  return {
    ...previous,
    [eventName]: {
      ...previousEvent,
      [maplessKey]: {
        ...previousSettings,
        hallOrder: mergeHallOrder(previousSettings.hallOrder, hallIds),
      },
    },
  };
};

export const cloneHallsForDates = (
  sourceHalls: HallDefinition[],
  targetDates: string[],
): Map<string, { halls: HallDefinition[]; idMap: Map<string, string> }> => {
  const clonedByDate = new Map<
    string,
    { halls: HallDefinition[]; idMap: Map<string, string> }
  >();
  for (const date of targetDates) {
    const idMap = new Map<string, string>();
    const halls = sourceHalls.map((hall) => {
      const newId = `hall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      idMap.set(hall.id, newId);
      return { ...hall, id: newId };
    });
    clonedByDate.set(date, { halls, idMap });
  }
  return clonedByDate;
};

const remapHallGroupId = (
  groupId: string,
  idMap: Map<string, string>,
): string | null => {
  const hallId = extractHallIdFromGroupId(groupId);
  const nextHallId = idMap.get(hallId);
  if (!nextHallId) return null;
  if (groupId.endsWith(":highest"))
    return buildHallGroupId(nextHallId, "highest");
  if (groupId.endsWith(":priority"))
    return buildHallGroupId(nextHallId, "priority");
  return buildHallGroupId(nextHallId, "none");
};

export const remapHallRouteSettings = (
  sourceSettings: HallRouteSettings,
  idMap: Map<string, string>,
): HallRouteSettings => ({
  ...sourceSettings,
  hallOrder: sourceSettings.hallOrder
    .map((id) => remapHallGroupId(id, idMap))
    .filter((id): id is string => !!id),
  hallVisitLists: (sourceSettings.hallVisitLists || [])
    .map((visitList) => {
      const hallId = remapHallGroupId(visitList.hallId, idMap);
      return hallId ? { ...visitList, hallId } : null;
    })
    .filter(
      (visitList): visitList is NonNullable<typeof visitList> => !!visitList,
    ),
});

export const splitGlobalHallRouteSettings = ({
  settings,
  mapHallIds,
  maplessHallIds,
  hasMapTab,
}: {
  settings: HallRouteSettings;
  mapHallIds: Set<string>;
  maplessHallIds: Set<string>;
  hasMapTab: boolean;
}): { mapSettings: HallRouteSettings; maplessSettings: HallRouteSettings } => {
  const mapOrder: string[] = [];
  const maplessOrder: string[] = [];

  settings.hallOrder.forEach((groupId) => {
    const hallId = extractHallIdFromGroupId(groupId);
    if (mapHallIds.has(hallId)) {
      mapOrder.push(groupId);
    } else if (maplessHallIds.has(hallId)) {
      maplessOrder.push(groupId);
    } else if (hasMapTab) {
      mapOrder.push(groupId);
    } else {
      maplessOrder.push(groupId);
    }
  });

  const mapVisitLists = settings.hallVisitLists.filter((visitList) =>
    mapHallIds.has(extractHallIdFromGroupId(visitList.hallId)),
  );
  const maplessVisitLists = settings.hallVisitLists.filter((visitList) =>
    maplessHallIds.has(extractHallIdFromGroupId(visitList.hallId)),
  );

  return {
    mapSettings: { hallOrder: mapOrder, hallVisitLists: mapVisitLists },
    maplessSettings: {
      hallOrder: maplessOrder,
      hallVisitLists: maplessVisitLists,
    },
  };
};

export const getGlobalHallItemCount = ({
  groupId,
  executeIds,
  items,
  getItemHallId,
}: {
  groupId: string;
  executeIds: string[];
  items: ShoppingItem[];
  getItemHallId: (item: ShoppingItem, eventDate: string) => string | null;
}): number => {
  if (executeIds.length === 0) return 0;

  let targetHallId: string | null;
  let targetPriority: PriorityLevel;
  if (groupId === "undefined" || groupId === "undefined:none") {
    targetHallId = null;
    targetPriority = "none";
  } else if (groupId === "undefined:highest") {
    targetHallId = null;
    targetPriority = "highest";
  } else if (groupId === "undefined:priority") {
    targetHallId = null;
    targetPriority = "priority";
  } else if (groupId.endsWith(":highest")) {
    targetHallId = groupId.replace(":highest", "");
    targetPriority = "highest";
  } else if (groupId.endsWith(":priority")) {
    targetHallId = groupId.replace(":priority", "");
    targetPriority = "priority";
  } else {
    targetHallId = groupId;
    targetPriority = "none";
  }

  const itemsById = new Map<string, ShoppingItem>();
  items.forEach((item) => {
    if (!itemsById.has(item.id)) itemsById.set(item.id, item);
  });

  return executeIds.filter((itemId) => {
    const item = itemsById.get(itemId);
    if (!item) return false;
    if ((item.priorityLevel || "none") !== targetPriority) return false;
    return getItemHallId(item, item.eventDate) === targetHallId;
  }).length;
};

const isPointInPolygon = (
  row: number,
  col: number,
  vertices: { row: number; col: number }[],
): boolean => {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].col;
    const yi = vertices[i].row;
    const xj = vertices[j].col;
    const yj = vertices[j].row;
    if (
      yi > row !== yj > row &&
      col < ((xj - xi) * (row - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
};

export const resolveItemHallGroupId = ({
  item,
  halls,
  mapData,
}: {
  item: ShoppingItem | undefined;
  halls: HallDefinition[];
  mapData: DayMapData | undefined;
}): string => {
  if (!item) return "undefined";

  let hallId: string | null = null;
  const manual = resolveManualHallId(item.manualHallId, halls);
  if (manual) {
    hallId = manual;
  } else if (mapData) {
    const blockName = item.block?.trim() || "";
    let block = mapData.blocks.find(
      (candidate) => candidate.name === blockName,
    );
    if (!block) {
      const candidates = mapData.blocks.filter(
        (candidate) => candidate.name.toLowerCase() === blockName.toLowerCase(),
      );
      if (candidates.length === 1) {
        block = candidates[0];
      }
    }
    if (block) {
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;
      for (const hall of halls) {
        if (
          hall.vertices.length >= 4 &&
          isPointInPolygon(centerRow, centerCol, hall.vertices)
        ) {
          hallId = hall.id;
          break;
        }
      }
    }
  }

  if (hallId === null) {
    hallId = resolveHallByBlockName(item.block, halls);
  }

  return buildHallGroupId(
    hallId,
    (item.priorityLevel || "none") as PriorityLevel,
  );
};

export const reorderExecuteIdsByHallOrder = ({
  hallOrder,
  dayItems,
  items,
  halls,
  mapData,
  hallRouteSettings,
}: {
  hallOrder: string[];
  dayItems: string[];
  items: ShoppingItem[];
  halls: HallDefinition[];
  mapData: DayMapData | undefined;
  hallRouteSettings: HallRouteSettings;
}): string[] => {
  const itemsMap = new Map(items.map((item) => [item.id, item]));
  const itemsByGroup = new Map<string, Set<string>>();

  dayItems.forEach((itemId) => {
    const groupId = resolveItemHallGroupId({
      item: itemsMap.get(itemId),
      halls,
      mapData,
    });
    if (!itemsByGroup.has(groupId)) {
      itemsByGroup.set(groupId, new Set());
    }
    itemsByGroup.get(groupId)!.add(itemId);
  });

  const visitOrderMap = new Map<string, number>();
  hallRouteSettings.hallVisitLists.forEach((list) => {
    list.itemIds.forEach((itemId, index) => {
      visitOrderMap.set(itemId, index);
    });
  });

  const sortItemsInGroup = (itemIds: Set<string>): string[] =>
    Array.from(itemIds).sort((a, b) => {
      const orderA = visitOrderMap.get(a);
      const orderB = visitOrderMap.get(b);
      if (orderA !== undefined && orderB !== undefined) return orderA - orderB;
      if (orderA !== undefined) return -1;
      if (orderB !== undefined) return 1;
      return dayItems.indexOf(a) - dayItems.indexOf(b);
    });

  const reorderedItems: string[] = [];
  hallOrder.forEach((groupId) => {
    const groupItems = itemsByGroup.get(groupId);
    if (groupItems && groupItems.size > 0) {
      reorderedItems.push(...sortItemsInGroup(groupItems));
      itemsByGroup.delete(groupId);
    }
  });

  itemsByGroup.forEach((groupItems) => {
    if (groupItems.size > 0) {
      reorderedItems.push(...sortItemsInGroup(groupItems));
    }
  });

  return reorderedItems;
};

export const getCombinedHallRouteSettingsForDate = ({
  eventName,
  dayName,
  mapTabName,
  hallRouteSettings,
}: {
  eventName: string;
  dayName: string;
  mapTabName: string | null;
  hallRouteSettings: HallRouteSettingsStore;
}): HallRouteSettings => {
  const maplessKey = getMaplessKey(dayName);
  const mapSettings = mapTabName
    ? hallRouteSettings[eventName]?.[mapTabName]
    : undefined;
  const maplessSettings = hallRouteSettings[eventName]?.[maplessKey];

  return {
    hallOrder: [
      ...(mapSettings?.hallOrder || []),
      ...(maplessSettings?.hallOrder || []),
    ],
    hallVisitLists: [
      ...(mapSettings?.hallVisitLists || []),
      ...(maplessSettings?.hallVisitLists || []),
    ],
  };
};
