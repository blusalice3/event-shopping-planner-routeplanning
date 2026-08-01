import type { AppData } from "../../utils/indexedDB";

const APP_DATA_SECTIONS = [
  "eventLists",
  "eventMetadata",
  "executeModeItems",
  "dayModes",
  "mapData",
  "mapRotationSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "mapViewportSettings",
] as const satisfies readonly (keyof AppData)[];

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        deepClone(nestedValue),
      ]),
    ) as T;
  }

  return value;
}

export function buildEventRestoreData(
  current: AppData,
  backup: AppData,
  sourceEventName: string,
  targetEventName: string,
): AppData {
  if (targetEventName.trim().length === 0) {
    throw new Error("復元先のイベント名を入力してください。");
  }

  if (!hasOwn(backup.eventLists, sourceEventName)) {
    throw new Error(
      `バックアップにイベント「${sourceEventName}」が見つかりません。`,
    );
  }

  const restored = deepClone(current);

  for (const sectionName of APP_DATA_SECTIONS) {
    const restoredSection = restored[sectionName] as Record<string, unknown>;
    delete restoredSection[targetEventName];
  }

  for (const sectionName of APP_DATA_SECTIONS) {
    const backupSection = backup[sectionName] as Record<string, unknown>;
    if (!hasOwn(backupSection, sourceEventName)) {
      continue;
    }

    const restoredSection = restored[sectionName] as Record<string, unknown>;
    Object.defineProperty(restoredSection, targetEventName, {
      configurable: true,
      enumerable: true,
      value: deepClone(backupSection[sourceEventName]),
      writable: true,
    });
  }

  return restored;
}
