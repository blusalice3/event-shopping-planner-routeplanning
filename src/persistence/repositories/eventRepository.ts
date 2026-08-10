import type { PersistenceSnapshot } from "../../app/ports/PersistenceCommandPort";
import type {
  LoadResult,
  PersistenceRecordOperations,
} from "../contracts/persistence";
import { DATA_KEY, STORES } from "../db/constants";

export interface EventRepository {
  saveEventLists(data: PersistenceSnapshot["eventLists"]): Promise<void>;
  loadEventLists(): Promise<LoadResult<PersistenceSnapshot["eventLists"]>>;
  saveEventMetadata(data: PersistenceSnapshot["eventMetadata"]): Promise<void>;
  loadEventMetadata(): Promise<
    LoadResult<PersistenceSnapshot["eventMetadata"]>
  >;
  saveExecuteModeItems(
    data: PersistenceSnapshot["executeModeItems"],
  ): Promise<void>;
  loadExecuteModeItems(): Promise<
    LoadResult<PersistenceSnapshot["executeModeItems"]>
  >;
  saveDayModes(data: PersistenceSnapshot["dayModes"]): Promise<void>;
  loadDayModes(): Promise<LoadResult<PersistenceSnapshot["dayModes"]>>;
}

export function createEventRepository(
  operations: PersistenceRecordOperations,
): EventRepository {
  return {
    saveEventLists(data) {
      return operations.save(STORES.EVENT_LISTS, DATA_KEY, data);
    },
    loadEventLists() {
      return operations.load<PersistenceSnapshot["eventLists"]>(
        STORES.EVENT_LISTS,
        DATA_KEY,
      );
    },
    saveEventMetadata(data) {
      return operations.save(STORES.EVENT_METADATA, DATA_KEY, data);
    },
    loadEventMetadata() {
      return operations.load<PersistenceSnapshot["eventMetadata"]>(
        STORES.EVENT_METADATA,
        DATA_KEY,
      );
    },
    saveExecuteModeItems(data) {
      return operations.save(STORES.EXECUTE_MODE_ITEMS, DATA_KEY, data);
    },
    loadExecuteModeItems() {
      return operations.load<PersistenceSnapshot["executeModeItems"]>(
        STORES.EXECUTE_MODE_ITEMS,
        DATA_KEY,
      );
    },
    saveDayModes(data) {
      return operations.save(STORES.DAY_MODES, DATA_KEY, data);
    },
    loadDayModes() {
      return operations.load<PersistenceSnapshot["dayModes"]>(
        STORES.DAY_MODES,
        DATA_KEY,
      );
    },
  };
}
