export const DB_NAME = "EventShoppingPlannerDB";
export const DB_VERSION = 5;
export const MAX_FORWARD_COMPATIBLE_DB_VERSION = 7;
export const DATABASE_OPEN_BLOCKED_TIMEOUT_MS = 5_000;
export const DATA_KEY = "data";
export const MAP_DATA_LEGACY_KEY = "data";
export const MAP_DATA_KEY_PREFIX = "mapData:";
export const INTERNAL_RECORD_PREFIX = "__esp_internal__:";
export const LEGACY_MIGRATION_JOURNAL_KEY =
  "__esp_internal__:migration:v1:legacy-local-storage";
export const LEGACY_MIGRATION_SCHEMA_VERSION = 2;
export const LEGACY_MIGRATION_ARCHIVE_SCHEMA_VERSION = 1;
export const LEGACY_MIGRATION_ARCHIVE_KEY_PREFIX =
  "__esp_internal__:migration-archive:v1:";
export const RECOVERY_ADOPTION_ARCHIVE_KEY_PREFIX =
  "__esp_internal__:recovery-adoption:v1:";
export const RECOVERY_ADOPTION_RETENTION_KEY_PREFIX =
  "__esp_internal__:recovery-retain:v1:";
export const LEGACY_MIGRATION_CONFLICT_RESOLUTION_KEY_PREFIX =
  "__esp_internal__:migration-resolution:v1:";
export const LEGACY_MIGRATION_CONFLICT_RESOLUTION_SCHEMA_VERSION = 1;
export const LEGACY_SYNC_QUEUE_LOCAL_STORAGE_KEY = "syncQueue";

export const STORES = {
  EVENT_LISTS: "eventLists",
  EVENT_METADATA: "eventMetadata",
  EXECUTE_MODE_ITEMS: "executeModeItems",
  DAY_MODES: "dayModes",
  MAP_DATA: "mapData",
  MAP_ROTATION_SETTINGS: "mapRotationSettings",
  ROUTE_SETTINGS: "routeSettings",
  HALL_DEFINITIONS: "hallDefinitions",
  HALL_ROUTE_SETTINGS: "hallRouteSettings",
  MAP_VIEWPORT_SETTINGS: "mapViewportSettings",
  SYNC_QUEUE: "syncQueue",
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];
