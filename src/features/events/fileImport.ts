import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  RouteSettingsStore,
  ShoppingItem,
} from '../../types';
import type { ImportResult } from '../../utils/exportImport';

export type ImportedEventData = {
  eventName: string;
  items: ShoppingItem[];
  metadata: EventMetadata | null;
  executeModeItems: ExecuteModeItems | null;
  dayModes: DayModeState | null;
  mapData: MapDataStore[string] | null;
  routeSettings: RouteSettingsStore[string] | null;
  hallDefinitions: HallDefinitionsStore[string] | null;
  hallRouteSettings: HallRouteSettingsStore[string] | null;
  errors: string[];
};

function hasEntries(record?: Record<string, unknown>): boolean {
  return !!record && Object.keys(record).length > 0;
}

export function toImportedEventData(result: ImportResult): ImportedEventData {
  return {
    eventName: result.eventName,
    items: result.items,
    metadata: result.metadata ?? null,
    executeModeItems: hasEntries(result.layoutInfo?.executeModeItems)
      ? result.layoutInfo!.executeModeItems
      : null,
    dayModes: hasEntries(result.layoutInfo?.dayModes)
      ? (result.layoutInfo!.dayModes as unknown as DayModeState)
      : null,
    mapData: hasEntries(result.mapData) ? (result.mapData as MapDataStore[string]) : null,
    routeSettings: hasEntries(result.routeSettings)
      ? (result.routeSettings as RouteSettingsStore[string])
      : null,
    hallDefinitions: hasEntries(result.hallDefinitions)
      ? (result.hallDefinitions as HallDefinitionsStore[string])
      : null,
    hallRouteSettings: hasEntries(result.hallRouteSettings)
      ? (result.hallRouteSettings as HallRouteSettingsStore[string])
      : null,
    errors: result.errors,
  };
}
