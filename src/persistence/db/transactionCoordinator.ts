import type { StoreName } from "./constants";
import { ensureStoreExists } from "./openDatabase";

export function openCoordinatedTransaction(
  database: IDBDatabase,
  storeNames: StoreName | readonly StoreName[],
  mode: IDBTransactionMode,
): IDBTransaction {
  const requiredStoreNames =
    typeof storeNames === "string" ? [storeNames] : storeNames;
  requiredStoreNames.forEach((storeName) => {
    ensureStoreExists(database, storeName);
  });
  return database.transaction(
    typeof storeNames === "string" ? storeNames : [...storeNames],
    mode,
  );
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

export function transactionFinished(
  transaction: IDBTransaction,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("IndexedDB transaction was aborted."),
      );
    transaction.onerror = () => {
      // onabort supplies the final transaction failure.
    };
  });
}
