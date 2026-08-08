import { DATA_KEY, STORES } from "../db/constants";

export interface SyncQueueRecordOperations<TLoadResult> {
  write(
    storeName: typeof STORES.SYNC_QUEUE,
    key: typeof DATA_KEY,
    data: unknown[],
  ): Promise<void>;
  read(
    storeName: typeof STORES.SYNC_QUEUE,
    key: typeof DATA_KEY,
  ): Promise<TLoadResult>;
}

export interface SyncQueueRepository<TLoadResult> {
  savePayload(data: unknown[]): Promise<void>;
  loadPayload(): Promise<TLoadResult>;
}

export function createSyncQueueRepository<TLoadResult>(
  operations: SyncQueueRecordOperations<TLoadResult>,
): SyncQueueRepository<TLoadResult> {
  return {
    savePayload(data): Promise<void> {
      return operations.write(STORES.SYNC_QUEUE, DATA_KEY, data);
    },
    loadPayload(): Promise<TLoadResult> {
      return operations.read(STORES.SYNC_QUEUE, DATA_KEY);
    },
  };
}
