import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "./item";
import type { BlockDefinition, DayMapData, RouteSettings } from "./map";

export interface ExportOptions {
  includeItems: boolean;
  includeLayoutInfo: boolean;
  includeMapData: boolean;
  includeBlockDefinitions: boolean;
  includeRouteInfo: boolean;
  format: "full" | "simple";
}

export interface ExportData {
  version: string;
  exportDate: string;
  eventName: string;
  metadata: EventMetadata;
  items: ShoppingItem[];
  dayModes: DayModeState;
  executeModeItems: ExecuteModeItems;
  mapData?: {
    [dayMapName: string]: DayMapData;
  };
  blockDefinitions?: {
    [dayMapName: string]: BlockDefinition[];
  };
  routeSettings?: {
    [dayMapName: string]: RouteSettings;
  };
}
