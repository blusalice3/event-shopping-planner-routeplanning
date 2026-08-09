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
import {
  buildEventWorkbookExportSnapshot,
  buildEventWorkbookFileName,
} from "../../xlsx/domain/eventWorkbook";
import type { XlsxExecutionPort } from "../../xlsx/port/XlsxExecutionPort";
import type { XlsxProgressListener } from "../../xlsx/port/XlsxExecutionPort";

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

export async function buildEventExportFile(
  executionPort: XlsxExecutionPort,
  signal: AbortSignal,
  eventName: string,
  items: ShoppingItem[],
  options: ExportOptions,
  metadata: EventMetadata | undefined,
  stores: ExportStores,
  now: Date = new Date(),
  onProgress?: XlsxProgressListener,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const snapshot = buildEventWorkbookExportSnapshot(eventName, items, options, {
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
  const bytes = await executionPort.exportWorkbook(
    snapshot,
    signal,
    onProgress,
  );

  return {
    bytes,
    filename: buildEventWorkbookFileName(eventName, options.format, now),
  };
}
