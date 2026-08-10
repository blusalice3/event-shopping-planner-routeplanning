import {
  INTERNAL_RECORD_PREFIX,
  STORES,
  type StoreName,
} from "../db/constants";
import { openDatabase, resetDatabaseConnection } from "../db/openDatabase";
import {
  openCoordinatedTransaction,
  requestResult,
  transactionFinished,
} from "../db/transactionCoordinator";
import { requestPersistenceControlRecords } from "./controlRepository";

export interface RawPersistenceSnapshot {
  readonly payload: unknown;
  readonly metadata: unknown;
  readonly checkpoint: unknown;
}

export async function readPersistenceSnapshotOnce(
  storeName: StoreName,
  key: string,
): Promise<RawPersistenceSnapshot> {
  const database = await openDatabase();
  const transactionStores =
    storeName === STORES.SYNC_QUEUE
      ? [STORES.SYNC_QUEUE]
      : [storeName, STORES.SYNC_QUEUE];
  const transaction = openCoordinatedTransaction(
    database,
    transactionStores,
    "readonly",
  );
  const finished = transactionFinished(transaction);
  const payloadRequest = transaction.objectStore(storeName).get(key);
  const { metadataRequest, checkpointRequest } =
    requestPersistenceControlRecords(transaction, storeName, key);
  const [payload, metadata, checkpoint] = await Promise.all([
    requestResult(payloadRequest),
    requestResult(metadataRequest),
    requestResult(checkpointRequest),
  ]);
  await finished;
  return { payload, metadata, checkpoint };
}

export async function deleteApplicationDataRecord(
  storeName: StoreName,
  key: string,
): Promise<void> {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = openCoordinatedTransaction(
      database,
      [storeName],
      "readwrite",
    );
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);

    request.onerror = () => {
      console.error(`Failed to delete from ${storeName}.`);
      reject(request.error);
    };
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error || request.error);
    };
  });
}

const isInternalRecordKey = (key: IDBValidKey): boolean =>
  typeof key === "string" && key.startsWith(INTERNAL_RECORD_PREFIX);

export async function getAllApplicationDataKeys(
  storeName: StoreName,
): Promise<string[]> {
  const loadOnce = async (): Promise<string[]> => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = openCoordinatedTransaction(
        database,
        storeName,
        "readonly",
      );
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();

      request.onerror = () => {
        console.error(`Failed to get keys from ${storeName}.`);
        reject(request.error);
      };
      request.onsuccess = () => {
        resolve(
          request.result
            .filter(
              (key) =>
                storeName !== STORES.SYNC_QUEUE || !isInternalRecordKey(key),
            )
            .map((key) => String(key)),
        );
      };
    });
  };

  try {
    return await loadOnce();
  } catch (firstError) {
    resetDatabaseConnection();
    try {
      return await loadOnce();
    } catch (retryError) {
      resetDatabaseConnection();
      throw retryError ?? firstError;
    }
  }
}

export async function getAllApplicationData<T>(
  storeName: StoreName,
): Promise<Record<string, T>> {
  const loadOnce = async (): Promise<Record<string, T>> => {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = openCoordinatedTransaction(
        database,
        storeName,
        "readonly",
      );
      const store = transaction.objectStore(storeName);
      const result: Record<string, T> = {};
      const cursorRequest = store.openCursor();

      cursorRequest.onerror = () => {
        console.error(`Failed to get all data from ${storeName}.`);
        reject(cursorRequest.error);
      };
      cursorRequest.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          if (
            storeName !== STORES.SYNC_QUEUE ||
            !isInternalRecordKey(cursor.key)
          ) {
            result[String(cursor.key)] = cursor.value;
          }
          cursor.continue();
        } else {
          resolve(result);
        }
      };
      transaction.onabort = () => {
        reject(transaction.error || cursorRequest.error);
      };
    });
  };

  try {
    return await loadOnce();
  } catch (firstError) {
    resetDatabaseConnection();
    try {
      return await loadOnce();
    } catch (retryError) {
      resetDatabaseConnection();
      throw retryError ?? firstError;
    }
  }
}
