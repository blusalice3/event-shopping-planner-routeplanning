import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ExportOptions,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  RouteSettingsStore,
  ShoppingItem,
} from '../../types';

type ExportStores = {
  executeModeItems: Record<string, ExecuteModeItems>;
  dayModes: Record<string, DayModeState>;
  mapData: MapDataStore;
  routeSettings: RouteSettingsStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
};

export function hasExportableItems(items: ShoppingItem[] | undefined): items is ShoppingItem[] {
  return !!items && items.length > 0;
}

function buildExportFilename(eventName: string, format: ExportOptions['format']): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const suffix = format === 'full' ? 'full' : 'simple';
  return `${eventName}_${timestamp}_${suffix}.xlsx`;
}

export async function buildEventExportFile(
  eventName: string,
  items: ShoppingItem[],
  options: ExportOptions,
  metadata: EventMetadata | undefined,
  stores: ExportStores,
): Promise<{ blob: Blob; filename: string }> {
  const { exportToXlsx } = await import('../../utils/exportImport');
  const blob = await exportToXlsx(eventName, items, options, {
    metadata,
    executeModeItems: stores.executeModeItems,
    dayModes: stores.dayModes,
    mapData: stores.mapData,
    routeSettings: stores.routeSettings,
    hallDefinitions: stores.hallDefinitions,
    hallRouteSettings: stores.hallRouteSettings,
  });

  return {
    blob,
    filename: buildExportFilename(eventName, options.format),
  };
}
