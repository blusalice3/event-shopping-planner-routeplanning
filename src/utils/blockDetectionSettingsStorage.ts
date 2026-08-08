import type {
  BlockDetectionSettings,
  BlockDetectionSettingsStore,
} from "../types/map";
import { isBlockDetectionSettings } from "../types/map";

export const BLOCK_DETECTION_SETTINGS_STORAGE_KEY =
  "blockDetectionSettings" as const;

export class BlockDetectionSettingsRollbackError extends Error {
  readonly originalError: unknown;
  readonly rollbackError: unknown;

  constructor(originalError: unknown, rollbackError: unknown) {
    super("ブロック検出設定を復元前の状態へ戻せませんでした。");
    this.name = "BlockDetectionSettingsRollbackError";
    this.originalError = originalError;
    this.rollbackError = rollbackError;
  }
}

type UnknownRecord = Record<string, unknown>;

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export { isBlockDetectionSettings };

const cloneSettings = (
  settings: BlockDetectionSettings,
): BlockDetectionSettings => ({
  ...settings,
  allowedCharTypes: { ...settings.allowedCharTypes },
});

const parseStoredSettings = (
  stored: string | null,
  includedEventNames?: ReadonlySet<string>,
): BlockDetectionSettingsStore => {
  if (stored === null) return {};

  const parsed = JSON.parse(stored) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("保存済みのブロック検出設定が不正です。");
  }

  const settingsStore: BlockDetectionSettingsStore = {};
  for (const [eventName, settings] of Object.entries(parsed)) {
    if (includedEventNames && !includedEventNames.has(eventName)) continue;
    if (!isBlockDetectionSettings(settings)) {
      throw new Error(`イベント「${eventName}」のブロック検出設定が不正です。`);
    }
    settingsStore[eventName] = cloneSettings(settings);
  }
  return settingsStore;
};

export function loadBlockDetectionSettings(
  eventName: string,
): BlockDetectionSettings | null {
  try {
    const all = parseStoredSettings(
      localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY),
      new Set([eventName]),
    );
    return all[eventName] ? cloneSettings(all[eventName]) : null;
  } catch {
    console.warn(
      "Block detection settings load failed (settings-load-failed).",
    );
    return null;
  }
}

export function loadBlockDetectionSettingsStore(
  eventNames?: readonly string[],
): BlockDetectionSettingsStore {
  try {
    const includedEventNames = eventNames ? new Set(eventNames) : undefined;
    const all = parseStoredSettings(
      localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY),
      includedEventNames,
    );
    const names = eventNames ?? Object.keys(all);
    return Object.fromEntries(
      names
        .filter((eventName) => hasOwn(all, eventName))
        .map((eventName) => [eventName, cloneSettings(all[eventName])]),
    );
  } catch {
    console.warn(
      "Block detection settings load failed (settings-load-failed).",
    );
    return {};
  }
}

export function readBlockDetectionSettingsStoreForBackup(
  eventNames: readonly string[],
): BlockDetectionSettingsStore {
  return parseStoredSettings(
    localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY),
    new Set(eventNames),
  );
}

export function saveBlockDetectionSettings(
  eventName: string,
  settings: BlockDetectionSettings,
): void {
  try {
    const all = parseStoredSettings(
      localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY),
    );
    all[eventName] = cloneSettings(settings);
    localStorage.setItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify(all),
    );
  } catch {
    console.error(
      "Block detection settings save failed (settings-save-failed).",
    );
  }
}

export function removeBlockDetectionSettingsForEvent(eventName: string): void {
  try {
    const all = parseStoredSettings(
      localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY),
    );
    if (!hasOwn(all, eventName)) return;
    delete all[eventName];
    localStorage.setItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify(all),
    );
  } catch {
    console.error(
      "Block detection settings removal failed (settings-remove-failed).",
    );
  }
}

export function renameBlockDetectionSettingsForEvent(
  oldEventName: string,
  newEventName: string,
): void {
  try {
    const all = parseStoredSettings(
      localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY),
    );
    const oldSettings = all[oldEventName];
    delete all[oldEventName];
    delete all[newEventName];
    if (oldSettings) {
      all[newEventName] = cloneSettings(oldSettings);
    }
    localStorage.setItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify(all),
    );
  } catch {
    console.error(
      "Block detection settings rename failed (settings-rename-failed).",
    );
  }
}

export function replaceBlockDetectionSettingsForEvent(
  eventName: string,
  settings: BlockDetectionSettings | null,
): () => void {
  const previousStoredValue = localStorage.getItem(
    BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
  );
  const all = parseStoredSettings(previousStoredValue);

  if (settings === null) {
    delete all[eventName];
  } else {
    all[eventName] = cloneSettings(settings);
  }

  localStorage.setItem(
    BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
    JSON.stringify(all),
  );

  return () => {
    if (previousStoredValue === null) {
      localStorage.removeItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY);
    } else {
      localStorage.setItem(
        BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
        previousStoredValue,
      );
    }
  };
}

export async function runWithBlockDetectionSettingsRestore<T>(
  eventName: string,
  settings: BlockDetectionSettings | null,
  commit: () => Promise<T>,
): Promise<T> {
  const rollback = replaceBlockDetectionSettingsForEvent(eventName, settings);
  try {
    return await commit();
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      console.error(
        "Block detection settings rollback failed (settings-rollback-failed).",
      );
      throw new BlockDetectionSettingsRollbackError(error, rollbackError);
    }
    throw error;
  }
}
