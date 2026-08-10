import {
  DATABASE_OPEN_BLOCKED_TIMEOUT_MS,
  DB_NAME,
  DB_VERSION,
  MAX_FORWARD_COMPATIBLE_DB_VERSION,
  STORES,
  type StoreName,
} from "./constants";

export class IndexedDBOpenBlockedError extends Error {
  constructor(timeoutMs: number) {
    super(
      `IndexedDB open request remained blocked for ${timeoutMs} milliseconds.`,
    );
    this.name = "IndexedDBOpenBlocked";
  }
}

let databaseInstance: IDBDatabase | null = null;
let databaseOpenPromise: Promise<IDBDatabase> | null = null;

export function resetDatabaseConnection(): void {
  databaseOpenPromise = null;
  if (!databaseInstance) return;
  try {
    databaseInstance.close();
  } catch {
    // The next operation still gets a fresh open attempt.
  }
  databaseInstance = null;
}

export function ensureStoreExists(
  database: IDBDatabase,
  storeName: StoreName,
): void {
  if (!database.objectStoreNames.contains(storeName)) {
    throw new Error(`IndexedDB object store is missing: ${storeName}`);
  }
}

const isVersionError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name?: unknown }).name === "VersionError";

const createMissingStores = (database: IDBDatabase): void => {
  Object.values(STORES).forEach((storeName) => {
    if (!database.objectStoreNames.contains(storeName)) {
      database.createObjectStore(storeName);
    }
  });
};

const getMissingStores = (database: IDBDatabase): StoreName[] =>
  Object.values(STORES).filter(
    (storeName) => !database.objectStoreNames.contains(storeName),
  );

const createDatabaseCompatibilityError = (
  name: "InvalidStateError" | "VersionError",
  message: string,
): Error => {
  const error = new Error(message);
  error.name = name;
  return error;
};

const assertRequiredStoresCompatible = (database: IDBDatabase): void => {
  const missingStores = getMissingStores(database);
  if (missingStores.length > 0) {
    throw createDatabaseCompatibilityError(
      "InvalidStateError",
      `IndexedDB version ${database.version} is missing required object stores: ${missingStores.join(", ")}.`,
    );
  }

  const transaction = database.transaction(Object.values(STORES), "readonly");
  const incompatibleStores = Object.values(STORES).filter((storeName) => {
    const store = transaction.objectStore(storeName);
    return store.keyPath !== null || store.autoIncrement;
  });
  if (incompatibleStores.length > 0) {
    throw createDatabaseCompatibilityError(
      "InvalidStateError",
      `IndexedDB version ${database.version} has incompatible object stores: ${incompatibleStores.join(", ")}.`,
    );
  }
};

const requestDatabaseOpen = (
  version: number | undefined,
  allowUpgrade: boolean,
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? indexedDB.open(DB_NAME)
        : indexedDB.open(DB_NAME, version);
    let settled = false;
    let blockedTimeout: ReturnType<typeof setTimeout> | null = null;

    const clearBlockedTimeout = (): void => {
      if (blockedTimeout === null) return;
      clearTimeout(blockedTimeout);
      blockedTimeout = null;
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearBlockedTimeout();
      reject(error);
    };

    request.onerror = () => {
      rejectOnce(request.error ?? new Error("Failed to open IndexedDB."));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearBlockedTimeout();
      resolve(request.result);
    };
    request.onblocked = () => {
      console.warn("IndexedDB open request is blocked by another tab.");
      if (settled || blockedTimeout !== null) return;
      blockedTimeout = setTimeout(() => {
        rejectOnce(
          new IndexedDBOpenBlockedError(DATABASE_OPEN_BLOCKED_TIMEOUT_MS),
        );
      }, DATABASE_OPEN_BLOCKED_TIMEOUT_MS);
    };
    request.onupgradeneeded = () => {
      if (settled || !allowUpgrade) {
        request.transaction?.abort();
        return;
      }
      createMissingStores(request.result);
    };
  });

const openForwardCompatibleDatabase = async (): Promise<IDBDatabase> => {
  const currentDatabase = await requestDatabaseOpen(undefined, false);
  try {
    if (
      currentDatabase.version <= DB_VERSION ||
      currentDatabase.version > MAX_FORWARD_COMPATIBLE_DB_VERSION
    ) {
      throw createDatabaseCompatibilityError(
        "VersionError",
        `IndexedDB version ${currentDatabase.version} is outside the supported range ${DB_VERSION}-${MAX_FORWARD_COMPATIBLE_DB_VERSION}.`,
      );
    }
    assertRequiredStoresCompatible(currentDatabase);
    return currentDatabase;
  } catch (error) {
    currentDatabase.close();
    throw error;
  }
};

const registerDatabase = (database: IDBDatabase): IDBDatabase => {
  databaseInstance = database;
  database.onversionchange = () => {
    if (databaseInstance === database) {
      resetDatabaseConnection();
      return;
    }
    database.close();
  };
  database.onclose = () => {
    if (databaseInstance === database) {
      databaseInstance = null;
    }
  };
  return database;
};

export function openDatabase(): Promise<IDBDatabase> {
  if (databaseInstance) return Promise.resolve(databaseInstance);
  if (databaseOpenPromise) return databaseOpenPromise;

  const pendingOpen = (async () => {
    try {
      const database = await requestDatabaseOpen(DB_VERSION, true);
      try {
        assertRequiredStoresCompatible(database);
        return registerDatabase(database);
      } catch (error) {
        database.close();
        throw error;
      }
    } catch (error) {
      if (!isVersionError(error)) throw error;
      return registerDatabase(await openForwardCompatibleDatabase());
    }
  })().catch((error) => {
    console.error("IndexedDB open failed.");
    throw error;
  });

  databaseOpenPromise = pendingOpen;
  pendingOpen.then(
    () => {
      if (databaseOpenPromise === pendingOpen) databaseOpenPromise = null;
    },
    () => {
      if (databaseOpenPromise === pendingOpen) databaseOpenPromise = null;
    },
  );
  return pendingOpen;
}
