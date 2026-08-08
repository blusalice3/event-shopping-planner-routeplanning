import {
  LIST_RENDERER_PREFERENCE_STORAGE_KEY,
  type ListRendererPreference,
  type ListRendererPreferencePort,
  type ListRendererPreferenceReadResult,
} from "./ListRendererPreferencePort";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredListRendererPreferenceV1 {
  readonly version: 1;
  readonly value: ListRendererPreference;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const parseStoredPreference = (
  rawValue: string,
): ListRendererPreferenceReadResult => {
  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (!isPlainRecord(parsed)) return { status: "invalid" };
    if (
      Object.keys(parsed).sort().join(",") !== "value,version" ||
      parsed.version !== 1 ||
      (parsed.value !== "auto" && parsed.value !== "full")
    ) {
      return { status: "invalid" };
    }
    return { status: "ok", value: parsed.value };
  } catch {
    return { status: "invalid" };
  }
};

const resolveBrowserStorage = (): PreferenceStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const createLocalStorageListRendererPreferenceAdapter = (
  suppliedStorage?: PreferenceStorage | null,
): ListRendererPreferencePort => ({
  read(): ListRendererPreferenceReadResult {
    const storage =
      suppliedStorage === undefined ? resolveBrowserStorage() : suppliedStorage;
    if (!storage) return { status: "unavailable" };
    try {
      const rawValue = storage.getItem(LIST_RENDERER_PREFERENCE_STORAGE_KEY);
      return rawValue === null
        ? { status: "missing" }
        : parseStoredPreference(rawValue);
    } catch {
      return { status: "unavailable" };
    }
  },

  write(value: ListRendererPreference): boolean {
    const storage =
      suppliedStorage === undefined ? resolveBrowserStorage() : suppliedStorage;
    if (!storage) return false;
    const storedValue: StoredListRendererPreferenceV1 = {
      version: 1,
      value,
    };
    try {
      storage.setItem(
        LIST_RENDERER_PREFERENCE_STORAGE_KEY,
        JSON.stringify(storedValue),
      );
      return true;
    } catch {
      return false;
    }
  },
});
