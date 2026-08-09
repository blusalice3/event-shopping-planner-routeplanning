import type {
  LoadResult,
  PersistenceRecordOperations,
} from "../contracts/persistence";
import { DATA_KEY, STORES } from "../db/constants";

export interface SyncQueueRepository {
  savePayload(data: unknown[]): Promise<void>;
  loadPayload(): Promise<LoadResult<unknown[]>>;
}

export function createSyncQueueRepository(
  operations: PersistenceRecordOperations,
): SyncQueueRepository {
  return {
    savePayload(data): Promise<void> {
      return operations.save(STORES.SYNC_QUEUE, DATA_KEY, data);
    },
    loadPayload(): Promise<LoadResult<unknown[]>> {
      return operations.load<unknown[]>(STORES.SYNC_QUEUE, DATA_KEY);
    },
  };
}
