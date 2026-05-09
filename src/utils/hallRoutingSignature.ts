import type {
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettings,
  HallRouteSettingsStore,
} from '../types/map';

export function buildHallDefinitionsRoutingSignature(
  hallDefinitions: HallDefinition[] | null | undefined,
): string {
  return JSON.stringify(
    (hallDefinitions || []).map((hall) => [
      hall.id,
      (hall.vertices || []).map((vertex) => [vertex.row, vertex.col]),
      [...(hall.blockNames || [])].sort(),
    ]),
  );
}

export function buildHallRouteSettingsRoutingSignature(
  settings: HallRouteSettings | null | undefined,
): string {
  if (!settings) return JSON.stringify(null);

  return JSON.stringify([
    settings.hallOrder || [],
    (settings.hallVisitLists || []).map((visitList) => [
      visitList.hallId,
      visitList.itemIds || [],
    ]),
  ]);
}

export function buildHallDefinitionsStoreRoutingSignature(params: {
  activeEventName: string | null;
  activeMapTabName: string | null;
  maplessKey: string | null;
  activeMapHalls: HallDefinition[];
  activeMaplessHalls: HallDefinition[];
}): string {
  const {
    activeEventName,
    activeMapTabName,
    maplessKey,
    activeMapHalls,
    activeMaplessHalls,
  } = params;

  return JSON.stringify([
    activeEventName || '',
    activeMapTabName || '',
    maplessKey || '',
    buildHallDefinitionsRoutingSignature(activeMapHalls),
    buildHallDefinitionsRoutingSignature(activeMaplessHalls),
  ]);
}

export function buildHallRouteSettingsStoreRoutingSignature(params: {
  activeEventName: string | null;
  activeMapTabName: string | null;
  maplessKey: string | null;
  activeMapSettings: HallRouteSettings | undefined;
  activeMaplessSettings: HallRouteSettings | undefined;
}): string {
  const {
    activeEventName,
    activeMapTabName,
    maplessKey,
    activeMapSettings,
    activeMaplessSettings,
  } = params;

  return JSON.stringify([
    activeEventName || '',
    activeMapTabName || '',
    maplessKey || '',
    buildHallRouteSettingsRoutingSignature(activeMapSettings),
    buildHallRouteSettingsRoutingSignature(activeMaplessSettings),
  ]);
}

export function buildActiveHallDefinitionsStore(params: {
  activeEventName: string | null;
  activeMapTabName: string | null;
  maplessKey: string | null;
  activeMapHalls: HallDefinition[];
  activeMaplessHalls: HallDefinition[];
}): HallDefinitionsStore {
  const {
    activeEventName,
    activeMapTabName,
    maplessKey,
    activeMapHalls,
    activeMaplessHalls,
  } = params;

  return activeEventName
    ? {
        [activeEventName]: {
          ...(activeMapTabName ? { [activeMapTabName]: activeMapHalls } : {}),
          ...(maplessKey ? { [maplessKey]: activeMaplessHalls } : {}),
        },
      }
    : {};
}

export function buildActiveHallRouteSettingsStore(params: {
  activeEventName: string | null;
  activeMapTabName: string | null;
  maplessKey: string | null;
  activeMapSettings: HallRouteSettings | undefined;
  activeMaplessSettings: HallRouteSettings | undefined;
}): HallRouteSettingsStore {
  const {
    activeEventName,
    activeMapTabName,
    maplessKey,
    activeMapSettings,
    activeMaplessSettings,
  } = params;

  return activeEventName
    ? {
        [activeEventName]: {
          ...(activeMapTabName && activeMapSettings
            ? { [activeMapTabName]: activeMapSettings }
            : {}),
          ...(maplessKey && activeMaplessSettings
            ? { [maplessKey]: activeMaplessSettings }
            : {}),
        },
      }
    : {};
}
