import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import type { ExportOptions } from "../../types/export";
import type {
  BlockDetectionSettings,
  BlockDetectionSettingsStore,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
  MapRotationSettingsStore,
  MapViewportSettingsStore,
  RouteSettingsStore,
} from "../../types/map";

export interface ItemFallbackWarning {
  itemId: string;
  rowNumber: number;
  reasons: string[];
}

export interface LegacySheetFieldFallback {
  itemId: string;
  rowNumber: number;
}

export interface EventWorkbookImportResult {
  success: boolean;
  eventName: string;
  items: ShoppingItem[];
  metadata?: EventMetadata;
  layoutInfo?: {
    executeModeItems: Record<string, string[]>;
    dayModes: Record<string, string>;
  };
  mapData?: Record<string, unknown>;
  mapRotationSettings?: MapRotationSettingsStore[string];
  mapViewportSettings?: MapViewportSettingsStore[string];
  routeSettings?: Record<string, unknown>;
  hallDefinitions?: Record<string, unknown[]>;
  hallRouteSettings?: Record<string, unknown>;
  blockDetectionSettings?: BlockDetectionSettings;
  errors: string[];
  itemFallbackWarnings?: ItemFallbackWarning[];
  legacySheetFieldFallbacks?: LegacySheetFieldFallback[];
}

export type EventWorkbookAdditionalData = {
  metadata?: EventMetadata;
  executeModeItems?: Record<string, ExecuteModeItems>;
  dayModes?: Record<string, DayModeState>;
  mapData?: MapDataStore;
  mapRotationSettings?: MapRotationSettingsStore;
  mapViewportSettings?: MapViewportSettingsStore;
  routeSettings?: RouteSettingsStore;
  hallDefinitions?: HallDefinitionsStore;
  hallRouteSettings?: HallRouteSettingsStore;
  blockDetectionSettings?: BlockDetectionSettingsStore;
};

export type EventWorkbookExportSnapshot = Readonly<{
  schemaVersion: 1;
  eventName: string;
  items: ShoppingItem[];
  options: ExportOptions;
  additionalData: EventWorkbookAdditionalData;
}>;

export const buildEventWorkbookExportSnapshot = (
  eventName: string,
  items: ShoppingItem[],
  options: ExportOptions,
  additionalData: EventWorkbookAdditionalData,
): EventWorkbookExportSnapshot => ({
  schemaVersion: 1,
  eventName,
  items,
  options,
  additionalData,
});

export const buildEventWorkbookFileName = (
  eventName: string,
  format: ExportOptions["format"],
  now: Date = new Date(),
): string => {
  const timestamp = now.toISOString().replace(/[:.]/g, "").slice(0, 15);
  const suffix = format === "full" ? "full" : "simple";
  return `${eventName}_${timestamp}_${suffix}.xlsx`;
};
