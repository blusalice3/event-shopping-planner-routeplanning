import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import type { ExportOptions } from "../../types/export";
import type {
  BlockDetectionSettingsStore,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from "../../types/map";
import { exportToXlsx } from "../../utils/exportImport";

type ExportStores = {
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  mapRotationSettings: MapRotationSettingsStore;
  mapViewportSettings: MapViewportSettingsStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  blockDetectionSettings: BlockDetectionSettingsStore;
};

export function hasExportableItems(
  items: ShoppingItem[] | undefined,
): items is ShoppingItem[] {
  return !!items && items.length > 0;
}

function buildExportFilename(
  eventName: string,
  format: ExportOptions["format"],
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const suffix = format === "full" ? "full" : "simple";
  return `${eventName}_${timestamp}_${suffix}.xlsx`;
}

export async function buildEventExportFile(
  eventName: string,
  items: ShoppingItem[],
  options: ExportOptions,
  metadata: EventMetadata | undefined,
  stores: ExportStores,
): Promise<{ blob: Blob; filename: string }> {
  const blob = await exportToXlsx(eventName, items, options, {
    metadata,
    executeModeItems: stores.executeModeItems,
    dayModes: stores.dayModes,
    mapData: stores.mapData,
    mapRotationSettings: stores.mapRotationSettings,
    mapViewportSettings: stores.mapViewportSettings,
    routeSettings: stores.routeSettings,
    hallDefinitions: stores.hallDefinitions,
    hallRouteSettings: stores.hallRouteSettings,
    blockDetectionSettings: stores.blockDetectionSettings,
  });

  return {
    blob,
    filename: buildExportFilename(eventName, options.format),
  };
}
