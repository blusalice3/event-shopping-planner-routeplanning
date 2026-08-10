import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";
import type {
  LoadResult,
  PersistenceRecordOperations,
} from "../contracts/persistence";
import { DATA_KEY, STORES } from "../db/constants";

export interface SettingsRepository {
  saveMapRotationSettings(
    data: PersistenceSnapshot["mapRotationSettings"],
  ): Promise<void>;
  loadMapRotationSettings(): Promise<
    LoadResult<PersistenceSnapshot["mapRotationSettings"]>
  >;
  saveRouteSettings(data: PersistenceSnapshot["routeSettings"]): Promise<void>;
  loadRouteSettings(): Promise<
    LoadResult<PersistenceSnapshot["routeSettings"]>
  >;
  saveHallDefinitions(
    data: PersistenceSnapshot["hallDefinitions"],
  ): Promise<void>;
  loadHallDefinitions(): Promise<
    LoadResult<PersistenceSnapshot["hallDefinitions"]>
  >;
  saveHallRouteSettings(
    data: PersistenceSnapshot["hallRouteSettings"],
  ): Promise<void>;
  loadHallRouteSettings(): Promise<
    LoadResult<PersistenceSnapshot["hallRouteSettings"]>
  >;
  saveMapViewportSettings(
    data: PersistenceSnapshot["mapViewportSettings"],
  ): Promise<void>;
  loadMapViewportSettings(): Promise<
    LoadResult<PersistenceSnapshot["mapViewportSettings"]>
  >;
}

export function createSettingsRepository(
  operations: PersistenceRecordOperations,
): SettingsRepository {
  return {
    saveMapRotationSettings(data) {
      return operations.save(STORES.MAP_ROTATION_SETTINGS, DATA_KEY, data);
    },
    loadMapRotationSettings() {
      return operations.load<PersistenceSnapshot["mapRotationSettings"]>(
        STORES.MAP_ROTATION_SETTINGS,
        DATA_KEY,
      );
    },
    saveRouteSettings(data) {
      return operations.save(STORES.ROUTE_SETTINGS, DATA_KEY, data);
    },
    loadRouteSettings() {
      return operations.load<PersistenceSnapshot["routeSettings"]>(
        STORES.ROUTE_SETTINGS,
        DATA_KEY,
      );
    },
    saveHallDefinitions(data) {
      return operations.save(STORES.HALL_DEFINITIONS, DATA_KEY, data);
    },
    loadHallDefinitions() {
      return operations.load<PersistenceSnapshot["hallDefinitions"]>(
        STORES.HALL_DEFINITIONS,
        DATA_KEY,
      );
    },
    saveHallRouteSettings(data) {
      return operations.save(STORES.HALL_ROUTE_SETTINGS, DATA_KEY, data);
    },
    loadHallRouteSettings() {
      return operations.load<PersistenceSnapshot["hallRouteSettings"]>(
        STORES.HALL_ROUTE_SETTINGS,
        DATA_KEY,
      );
    },
    saveMapViewportSettings(data) {
      return operations.save(STORES.MAP_VIEWPORT_SETTINGS, DATA_KEY, data);
    },
    loadMapViewportSettings() {
      return operations.load<PersistenceSnapshot["mapViewportSettings"]>(
        STORES.MAP_VIEWPORT_SETTINGS,
        DATA_KEY,
      );
    },
  };
}
