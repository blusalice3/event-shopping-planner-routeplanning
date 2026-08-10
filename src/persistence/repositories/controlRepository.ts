import {
  createPersistenceCheckpointKey,
  createPersistenceMetadataKey,
} from "../../utils/persistenceResilience";
import { STORES, type StoreName } from "../db/constants";

export interface PersistenceControlRecordRequests {
  readonly metadataRequest: IDBRequest<unknown>;
  readonly checkpointRequest: IDBRequest<unknown>;
}

export function requestPersistenceControlRecords(
  transaction: IDBTransaction,
  storeName: StoreName,
  key: string,
): PersistenceControlRecordRequests {
  const controlStore = transaction.objectStore(STORES.SYNC_QUEUE);
  return {
    metadataRequest: controlStore.get(
      createPersistenceMetadataKey(storeName, key),
    ),
    checkpointRequest: controlStore.get(
      createPersistenceCheckpointKey(storeName, key),
    ),
  };
}
