import type { ShoppingItem } from "../../../types/item";
import {
  MAPLESS_HALL_KEY,
  getMaplessKey,
  type HallDefinition,
  type HallDefinitionsStore,
  type HallRouteSettingsStore,
} from "../../../types/map";
import { extractEventDates } from "../../../utils/eventDates";

export interface HydratedHallState {
  readonly eventLists: Readonly<Record<string, ShoppingItem[]>>;
  readonly hallDefinitions: HallDefinitionsStore;
  readonly hallRouteSettings: HallRouteSettingsStore;
}

const normalizeHallDefinitions = (
  eventLists: HydratedHallState["eventLists"],
  hallDefinitions: HallDefinitionsStore,
): HallDefinitionsStore => {
  let changed = false;
  const next: HallDefinitionsStore = {};

  for (const eventName of Object.keys(hallDefinitions)) {
    const byTab = { ...hallDefinitions[eventName] };
    const maplessById = new Map<string, HallDefinition>();

    for (const hall of byTab[MAPLESS_HALL_KEY] ?? []) {
      maplessById.set(hall.id, hall);
    }
    for (const tabName of Object.keys(byTab)) {
      if (
        tabName === MAPLESS_HALL_KEY ||
        tabName.startsWith(`${MAPLESS_HALL_KEY}:`)
      ) {
        continue;
      }
      const original = byTab[tabName] ?? [];
      const keep: HallDefinition[] = [];
      for (const hall of original) {
        const isMapless =
          (!hall.vertices || hall.vertices.length < 4) &&
          Boolean(hall.blockNames?.length);
        if (isMapless) {
          if (!maplessById.has(hall.id)) maplessById.set(hall.id, hall);
          changed = true;
        } else {
          keep.push(hall);
        }
      }
      if (keep.length !== original.length) {
        byTab[tabName] = keep;
      }
    }

    const collectedMapless = Array.from(maplessById.values());
    if (collectedMapless.length > 0) {
      const dates = extractEventDates(eventLists[eventName] ?? []);
      for (const date of dates) {
        const dateKey = getMaplessKey(date);
        if (!byTab[dateKey] || byTab[dateKey].length === 0) {
          byTab[dateKey] = collectedMapless.map((hall) => ({ ...hall }));
          changed = true;
        }
      }
    }
    if (byTab[MAPLESS_HALL_KEY] != null) {
      delete byTab[MAPLESS_HALL_KEY];
      changed = true;
    }

    next[eventName] = byTab;
  }

  return changed ? next : hallDefinitions;
};

const normalizeHallRouteSettings = (
  eventLists: HydratedHallState["eventLists"],
  hallRouteSettings: HallRouteSettingsStore,
): HallRouteSettingsStore => {
  let changed = false;
  const next: HallRouteSettingsStore = {};

  for (const eventName of Object.keys(hallRouteSettings)) {
    const byTab = { ...hallRouteSettings[eventName] };
    const oldSettings = byTab[MAPLESS_HALL_KEY];
    if (oldSettings != null) {
      const dates = extractEventDates(eventLists[eventName] ?? []);
      for (const date of dates) {
        const dateKey = getMaplessKey(date);
        if (!byTab[dateKey]) {
          byTab[dateKey] = {
            hallOrder: [...oldSettings.hallOrder],
            hallVisitLists: oldSettings.hallVisitLists.map((visitList) => ({
              hallId: visitList.hallId,
              itemIds: [...visitList.itemIds],
            })),
          };
          changed = true;
        }
      }
      delete byTab[MAPLESS_HALL_KEY];
      changed = true;
    }
    next[eventName] = byTab;
  }

  return changed ? next : hallRouteSettings;
};

export const normalizeHydratedHallState = (
  input: HydratedHallState,
): HydratedHallState => {
  const hallDefinitions = normalizeHallDefinitions(
    input.eventLists,
    input.hallDefinitions,
  );
  const hallRouteSettings = normalizeHallRouteSettings(
    input.eventLists,
    input.hallRouteSettings,
  );

  return hallDefinitions === input.hallDefinitions &&
    hallRouteSettings === input.hallRouteSettings
    ? input
    : {
        eventLists: input.eventLists,
        hallDefinitions,
        hallRouteSettings,
      };
};
