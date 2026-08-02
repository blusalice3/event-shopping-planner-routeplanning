import { ItemSources, ProtectionLevels, PurchaseStatuses } from "../types/item";
import type { BlockDetectionSettingsStore } from "../types/map";
import type { AppData } from "./indexedDB";
import { validateLimitedPurchaseQuantities } from "./purchaseQuantity";

export const APP_BACKUP_KIND = "event-shopping-planner-backup" as const;
export const APP_BACKUP_VERSION = 1 as const;

export const APP_BACKUP_SECTION_KEYS = [
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

export interface AppBackupV1 {
  kind: typeof APP_BACKUP_KIND;
  version: typeof APP_BACKUP_VERSION;
  exportedAt: string;
  eventSettings: AppBackupEventSettings;
  data: AppData;
}

export interface AppBackupEventSettings {
  blockDetectionSettings: BlockDetectionSettingsStore;
}

export type AppBackupParseResult =
  | {
      ok: true;
      backup: AppBackupV1;
      data: AppData;
      errors: [];
    }
  | {
      ok: false;
      data: null;
      errors: string[];
    };

type UnknownRecord = Record<string, unknown>;
type SectionKey = (typeof APP_BACKUP_SECTION_KEYS)[number];
type MapBounds = {
  maxRow: number;
  maxCol: number;
};

type ValidatedItem = {
  path: string;
  id?: string;
  eventDate?: string;
  manualHallId?: string;
};

const PURCHASE_STATUS_SET = new Set<string>(PurchaseStatuses);
const PRIORITY_LEVEL_SET = new Set(["none", "priority", "highest"]);
const PROTECTION_LEVEL_SET = new Set<string>(ProtectionLevels);
const ITEM_SOURCE_SET = new Set<string>(ItemSources);
const VIEW_MODE_SET = new Set(["edit", "execute", "focus"]);
const BORDER_STYLE_SET = new Set(["thin", "medium", "thick", "double", "none"]);
const CELL_GROUP_TYPE_SET = new Set(["range", "individual"]);
const MAPLESS_HALL_KEY = "__mapless__";

const REQUIRED_ITEM_STRING_FIELDS = [
  "id",
  "circle",
  "eventDate",
  "block",
  "number",
  "title",
  "remarks",
] as const;

const hasOwn = (value: UnknownRecord, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const isCanonicalIsoDate = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
};

const addError = (errors: string[], path: string, message: string): void => {
  errors.push(`${path}: ${message}`);
};

const requireRecord = (
  value: unknown,
  path: string,
  errors: string[],
): UnknownRecord | null => {
  if (!isRecord(value)) {
    addError(errors, path, "オブジェクトである必要があります");
    return null;
  }
  return value;
};

const requireArray = (
  value: unknown,
  path: string,
  errors: string[],
): unknown[] | null => {
  if (!Array.isArray(value)) {
    addError(errors, path, "配列である必要があります");
    return null;
  }
  return value;
};

const validateRequiredString = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  nonEmpty = false,
): string | undefined => {
  const fieldPath = `${path}.${key}`;
  if (!hasOwn(value, key)) {
    addError(errors, fieldPath, "必須項目がありません");
    return undefined;
  }
  if (typeof value[key] !== "string") {
    addError(errors, fieldPath, "文字列である必要があります");
    return undefined;
  }
  const stringValue = value[key] as string;
  if (nonEmpty && stringValue.length === 0) {
    addError(errors, fieldPath, "空文字列にはできません");
    return undefined;
  }
  return stringValue;
};

const validateRequiredFiniteNumber = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): number | undefined => {
  const fieldPath = `${path}.${key}`;
  if (!hasOwn(value, key)) {
    addError(errors, fieldPath, "必須項目がありません");
    return undefined;
  }
  if (!isFiniteNumber(value[key])) {
    addError(errors, fieldPath, "有限の数値である必要があります");
    return undefined;
  }
  return value[key];
};

const validateRequiredInteger = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  minimum: number,
): number | undefined => {
  const numberValue = validateRequiredFiniteNumber(value, key, path, errors);
  if (numberValue === undefined) return undefined;
  if (!Number.isInteger(numberValue) || numberValue < minimum) {
    addError(
      errors,
      `${path}.${key}`,
      `${minimum}以上の整数である必要があります`,
    );
    return undefined;
  }
  return numberValue;
};

const validateRequiredBoolean = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): boolean | undefined => {
  const fieldPath = `${path}.${key}`;
  if (!hasOwn(value, key)) {
    addError(errors, fieldPath, "必須項目がありません");
    return undefined;
  }
  if (typeof value[key] !== "boolean") {
    addError(errors, fieldPath, "真偽値である必要があります");
    return undefined;
  }
  return value[key];
};

const validateOptionalString = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  nonEmpty = false,
): string | undefined => {
  if (!hasOwn(value, key)) return undefined;
  const fieldPath = `${path}.${key}`;
  if (typeof value[key] !== "string") {
    addError(errors, fieldPath, "文字列である必要があります");
    return undefined;
  }
  const stringValue = value[key] as string;
  if (nonEmpty && stringValue.length === 0) {
    addError(errors, fieldPath, "空文字列にはできません");
    return undefined;
  }
  return stringValue;
};

const validateOptionalFiniteNumber = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  nullable = false,
): number | null | undefined => {
  if (!hasOwn(value, key)) return undefined;
  const fieldPath = `${path}.${key}`;
  if (nullable && value[key] === null) return null;
  if (!isFiniteNumber(value[key])) {
    addError(
      errors,
      fieldPath,
      nullable
        ? "有限の数値またはnullである必要があります"
        : "有限の数値である必要があります",
    );
    return undefined;
  }
  return value[key];
};

const validateOptionalInteger = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  minimum?: number,
): number | undefined => {
  if (!hasOwn(value, key)) return undefined;
  const fieldPath = `${path}.${key}`;
  const rawValue = value[key];
  if (
    !isFiniteNumber(rawValue) ||
    !Number.isInteger(rawValue) ||
    (minimum !== undefined && rawValue < minimum)
  ) {
    addError(
      errors,
      fieldPath,
      minimum === undefined
        ? "整数である必要があります"
        : `${minimum}以上の整数である必要があります`,
    );
    return undefined;
  }
  return rawValue;
};

const validateOptionalBoolean = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): boolean | undefined => {
  if (!hasOwn(value, key)) return undefined;
  if (typeof value[key] !== "boolean") {
    addError(errors, `${path}.${key}`, "真偽値である必要があります");
    return undefined;
  }
  return value[key];
};

const validateOptionalEnum = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  allowedValues: ReadonlySet<string>,
): string | undefined => {
  if (!hasOwn(value, key)) return undefined;
  const fieldPath = `${path}.${key}`;
  const rawValue = value[key];
  if (typeof rawValue !== "string" || !allowedValues.has(rawValue)) {
    addError(errors, fieldPath, "既知の値である必要があります");
    return undefined;
  }
  return rawValue;
};

const validateRequiredEnum = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  allowedValues: ReadonlySet<string>,
): string | undefined => {
  const stringValue = validateRequiredString(value, key, path, errors);
  if (stringValue === undefined) return undefined;
  if (!allowedValues.has(stringValue)) {
    addError(errors, `${path}.${key}`, "既知の値である必要があります");
    return undefined;
  }
  return stringValue;
};

const validateRequiredIntegerInRange = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  minimum: number,
  maximum: number,
): number | undefined => {
  const integer = validateRequiredInteger(value, key, path, errors, minimum);
  if (integer !== undefined && integer > maximum) {
    addError(
      errors,
      `${path}.${key}`,
      `${maximum}以下の整数である必要があります`,
    );
    return undefined;
  }
  return integer;
};

const validateBlockDetectionSettings = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  const settings = requireRecord(value, path, errors);
  if (!settings) return;

  validateRequiredIntegerInRange(
    settings,
    "maxBlockNameLength",
    path,
    errors,
    1,
    10,
  );
  validateRequiredBoolean(settings, "allowDigitSymbolOnly", path, errors);
  validateRequiredIntegerInRange(
    settings,
    "minNumberCellsPerBlock",
    path,
    errors,
    1,
    20,
  );
  validateRequiredIntegerInRange(
    settings,
    "minMergedCellCount",
    path,
    errors,
    1,
    12,
  );
  const numberCellMin = validateRequiredIntegerInRange(
    settings,
    "numberCellMin",
    path,
    errors,
    0,
    9999,
  );
  const numberCellMax = validateRequiredIntegerInRange(
    settings,
    "numberCellMax",
    path,
    errors,
    0,
    9999,
  );
  if (
    numberCellMin !== undefined &&
    numberCellMax !== undefined &&
    numberCellMin > numberCellMax
  ) {
    addError(
      errors,
      `${path}.numberCellMax`,
      "numberCellMin以上である必要があります",
    );
  }
  validateRequiredIntegerInRange(
    settings,
    "maxRegionSize",
    path,
    errors,
    500,
    10000,
  );
  validateRequiredIntegerInRange(
    settings,
    "polygonThreshold",
    path,
    errors,
    50,
    100,
  );

  const allowedCharTypes = requireRecord(
    settings.allowedCharTypes,
    `${path}.allowedCharTypes`,
    errors,
  );
  if (!allowedCharTypes) return;
  (
    ["katakana", "hiragana", "alphabet", "kanji", "digit", "symbol"] as const
  ).forEach((key) => {
    validateRequiredBoolean(
      allowedCharTypes,
      key,
      `${path}.allowedCharTypes`,
      errors,
    );
  });
};

const validateEventSettings = (
  value: unknown,
  knownEvents: ReadonlySet<string>,
  errors: string[],
): void => {
  const eventSettings = requireRecord(value, "eventSettings", errors);
  if (!eventSettings) return;
  const blockDetectionSettings = requireRecord(
    eventSettings.blockDetectionSettings,
    "eventSettings.blockDetectionSettings",
    errors,
  );
  if (!blockDetectionSettings) return;

  Object.entries(blockDetectionSettings).forEach(([eventName, rawSettings]) => {
    const path = `eventSettings.blockDetectionSettings.${eventName}`;
    if (!knownEvents.has(eventName)) {
      addError(errors, path, "eventListsに存在しないイベントの設定です");
    }
    validateBlockDetectionSettings(rawSettings, path, errors);
  });
};

const validateStringArray = (
  value: unknown,
  path: string,
  errors: string[],
  onString?: (entry: string, entryPath: string) => void,
): void => {
  const entries = requireArray(value, path, errors);
  if (!entries) return;

  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "string") {
      addError(errors, entryPath, "文字列である必要があります");
      return;
    }
    onString?.(entry, entryPath);
  });
};

const validateItem = (
  value: unknown,
  path: string,
  errors: string[],
): ValidatedItem | null => {
  const item = requireRecord(value, path, errors);
  if (!item) return null;

  const requiredStrings = new Map<string, string>();
  REQUIRED_ITEM_STRING_FIELDS.forEach((key) => {
    const field = validateRequiredString(item, key, path, errors, key === "id");
    if (field !== undefined) requiredStrings.set(key, field);
  });

  if (!hasOwn(item, "price")) {
    addError(errors, `${path}.price`, "必須項目がありません");
  } else if (item.price !== null && !isFiniteNumber(item.price)) {
    addError(
      errors,
      `${path}.price`,
      "有限の数値またはnullである必要があります",
    );
  }

  let purchaseStatus: string | undefined;
  if (!hasOwn(item, "purchaseStatus")) {
    addError(errors, `${path}.purchaseStatus`, "必須項目がありません");
  } else if (
    typeof item.purchaseStatus !== "string" ||
    !PURCHASE_STATUS_SET.has(item.purchaseStatus)
  ) {
    addError(
      errors,
      `${path}.purchaseStatus`,
      "既知の購入状態である必要があります",
    );
  } else {
    purchaseStatus = item.purchaseStatus;
  }

  let quantity: number | undefined;
  if (!hasOwn(item, "quantity")) {
    addError(errors, `${path}.quantity`, "必須項目がありません");
  } else if (!isPositiveInteger(item.quantity)) {
    addError(errors, `${path}.quantity`, "正の整数である必要があります");
  } else {
    quantity = item.quantity;
  }

  let manualHallId: string | undefined;
  if (hasOwn(item, "manualHallId")) {
    if (typeof item.manualHallId !== "string") {
      addError(errors, `${path}.manualHallId`, "文字列である必要があります");
    } else if (item.manualHallId.length === 0) {
      addError(errors, `${path}.manualHallId`, "空文字列にはできません");
    } else {
      manualHallId = item.manualHallId;
    }
  }

  validateOptionalFiniteNumber(item, "catalogPrice", path, errors, true);
  const limitedPurchasedQuantity = validateOptionalInteger(
    item,
    "limitedPurchasedQuantity",
    path,
    errors,
  );
  if (
    purchaseStatus !== undefined &&
    purchaseStatus !== "LimitedPurchase" &&
    hasOwn(item, "limitedPurchasedQuantity")
  ) {
    addError(
      errors,
      `${path}.limitedPurchasedQuantity`,
      "限数購入以外の購入状態には実購入数を保存できません",
    );
  } else if (
    purchaseStatus === "LimitedPurchase" &&
    hasOwn(item, "limitedPurchasedQuantity")
  ) {
    const validation = validateLimitedPurchaseQuantities(
      limitedPurchasedQuantity,
      quantity,
    );
    if (!validation.ok) {
      addError(
        errors,
        `${path}.limitedPurchasedQuantity`,
        "1以上かつ購入予定量未満の整数である必要があります",
      );
    }
  }
  validateOptionalString(item, "sheetRemarks", path, errors);
  validateOptionalString(item, "url", path, errors);
  validateOptionalEnum(item, "priorityLevel", path, errors, PRIORITY_LEVEL_SET);
  validateOptionalEnum(
    item,
    "protectionLevel",
    path,
    errors,
    PROTECTION_LEVEL_SET,
  );
  validateOptionalEnum(item, "source", path, errors, ITEM_SOURCE_SET);
  validateOptionalString(item, "assignedTo", path, errors);
  validateOptionalString(item, "lastSyncedAt", path, errors);
  validateOptionalFiniteNumber(item, "orderIndex", path, errors);
  validateOptionalBoolean(item, "postponed", path, errors);

  // 未知の任意フィールドは、将来の後方互換性のため検証・削除しない。
  return {
    path,
    id: requiredStrings.get("id"),
    eventDate: requiredStrings.get("eventDate"),
    manualHallId,
  };
};

const validateKnownEvent = (
  sectionName: Exclude<SectionKey, "eventLists">,
  eventName: string,
  knownEvents: Set<string>,
  errors: string[],
): void => {
  if (!knownEvents.has(eventName)) {
    addError(
      errors,
      `data.${sectionName}.${eventName}`,
      "eventListsに存在しないイベントを参照しています",
    );
  }
};

const validateKnownMap = (
  sectionName: "routeSettings" | "hallDefinitions",
  eventName: string,
  mapName: string,
  mapNamesByEvent: Map<string, Set<string>>,
  errors: string[],
): void => {
  if (!mapNamesByEvent.get(eventName)?.has(mapName)) {
    addError(
      errors,
      `data.${sectionName}.${eventName}.${mapName}`,
      "mapDataに存在しないマップを参照しています",
    );
  }
};

const validateItemReference = (
  eventName: string,
  itemId: string,
  path: string,
  itemIdsByEvent: Map<string, Set<string>>,
  errors: string[],
): void => {
  const itemIds = itemIdsByEvent.get(eventName);
  if (itemIds && !itemIds.has(itemId)) {
    addError(errors, path, `存在しない品目ID「${itemId}」を参照しています`);
  }
};

const getSections = (
  data: UnknownRecord,
  errors: string[],
): Partial<Record<SectionKey, UnknownRecord>> => {
  const sections: Partial<Record<SectionKey, UnknownRecord>> = {};
  APP_BACKUP_SECTION_KEYS.forEach((key) => {
    const path = `data.${key}`;
    if (!hasOwn(data, key)) {
      addError(errors, path, "必須セクションがありません");
      return;
    }
    const section = requireRecord(data[key], path, errors);
    if (section) sections[key] = section;
  });
  return sections;
};

const validateCoordinate = (
  value: unknown,
  path: string,
  errors: string[],
  minimum = 1,
  bounds: MapBounds | null = null,
): { row?: number; col?: number } | null => {
  const coordinate = requireRecord(value, path, errors);
  if (!coordinate) return null;
  const row = validateRequiredInteger(coordinate, "row", path, errors, minimum);
  const col = validateRequiredInteger(coordinate, "col", path, errors, minimum);
  if (bounds && row !== undefined && row > bounds.maxRow) {
    addError(
      errors,
      `${path}.row`,
      `マップの最大行${bounds.maxRow}以内である必要があります`,
    );
  }
  if (bounds && col !== undefined && col > bounds.maxCol) {
    addError(
      errors,
      `${path}.col`,
      `マップの最大列${bounds.maxCol}以内である必要があります`,
    );
  }
  return { row, col };
};

const validateRangeBounds = (
  range: {
    startRow?: number;
    startCol?: number;
    endRow?: number;
    endCol?: number;
  },
  path: string,
  errors: string[],
  bounds: MapBounds | null,
): void => {
  if (
    range.startRow !== undefined &&
    range.endRow !== undefined &&
    range.startRow > range.endRow
  ) {
    addError(errors, `${path}.endRow`, "startRow以上である必要があります");
  }
  if (
    range.startCol !== undefined &&
    range.endCol !== undefined &&
    range.startCol > range.endCol
  ) {
    addError(errors, `${path}.endCol`, "startCol以上である必要があります");
  }
  if (!bounds) return;

  (
    [
      ["startRow", range.startRow, bounds.maxRow],
      ["endRow", range.endRow, bounds.maxRow],
      ["startCol", range.startCol, bounds.maxCol],
      ["endCol", range.endCol, bounds.maxCol],
    ] as const
  ).forEach(([key, coordinate, maximum]) => {
    if (coordinate !== undefined && coordinate > maximum) {
      addError(
        errors,
        `${path}.${key}`,
        `マップの最大${key.endsWith("Row") ? "行" : "列"}${maximum}以内である必要があります`,
      );
    }
  });
};

const validateCellValue = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
): void => {
  const fieldPath = `${path}.${key}`;
  if (!hasOwn(value, key)) {
    addError(errors, fieldPath, "必須項目がありません");
    return;
  }
  const rawValue = value[key];
  if (
    rawValue !== null &&
    typeof rawValue !== "string" &&
    !isFiniteNumber(rawValue)
  ) {
    addError(
      errors,
      fieldPath,
      "文字列、有限の数値、またはnullである必要があります",
    );
  }
};

const validateNullableString = (
  value: UnknownRecord,
  key: string,
  path: string,
  errors: string[],
  required: boolean,
): void => {
  const fieldPath = `${path}.${key}`;
  if (!hasOwn(value, key)) {
    if (required) addError(errors, fieldPath, "必須項目がありません");
    return;
  }
  const rawValue = value[key];
  if (rawValue !== null && typeof rawValue !== "string") {
    addError(errors, fieldPath, "文字列またはnullである必要があります");
  }
};

const validateBorderStyle = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  if (value === null) return;
  const border = requireRecord(value, path, errors);
  if (!border) return;
  validateRequiredEnum(border, "style", path, errors, BORDER_STYLE_SET);
  validateRequiredString(border, "color", path, errors);
};

const validateCellBorders = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  const borders = requireRecord(value, path, errors);
  if (!borders) return;
  (["top", "right", "bottom", "left"] as const).forEach((side) => {
    const sidePath = `${path}.${side}`;
    if (!hasOwn(borders, side)) {
      addError(errors, sidePath, "必須項目がありません");
      return;
    }
    validateBorderStyle(borders[side], sidePath, errors);
  });
};

const validateCellData = (
  value: unknown,
  path: string,
  errors: string[],
  bounds: MapBounds | null,
): void => {
  const cell = requireRecord(value, path, errors);
  if (!cell) return;
  validateCoordinate(cell, path, errors, 1, bounds);
  validateCellValue(cell, "value", path, errors);
  validateNullableString(cell, "backgroundColor", path, errors, true);
  validateNullableString(cell, "fontColor", path, errors, false);

  if (!hasOwn(cell, "borders")) {
    addError(errors, `${path}.borders`, "必須項目がありません");
  } else {
    validateCellBorders(cell.borders, `${path}.borders`, errors);
  }

  validateOptionalBoolean(cell, "isMerged", path, errors);
  validateOptionalBoolean(cell, "isVerticalText", path, errors);
  if (hasOwn(cell, "mergeParent")) {
    validateCoordinate(
      cell.mergeParent,
      `${path}.mergeParent`,
      errors,
      1,
      bounds,
    );
  }
};

const validateMergedCell = (
  value: unknown,
  path: string,
  errors: string[],
  bounds: MapBounds | null,
): void => {
  const mergedCell = requireRecord(value, path, errors);
  if (!mergedCell) return;
  const range = {
    startRow: validateRequiredInteger(mergedCell, "startRow", path, errors, 1),
    startCol: validateRequiredInteger(mergedCell, "startCol", path, errors, 1),
    endRow: validateRequiredInteger(mergedCell, "endRow", path, errors, 1),
    endCol: validateRequiredInteger(mergedCell, "endCol", path, errors, 1),
  };
  validateRangeBounds(range, path, errors, bounds);
  validateCellValue(mergedCell, "value", path, errors);
};

const validateNumberCell = (
  value: unknown,
  path: string,
  errors: string[],
  bounds: MapBounds | null,
): void => {
  const numberCell = requireRecord(value, path, errors);
  if (!numberCell) return;
  validateCoordinate(numberCell, path, errors, 1, bounds);
  validateRequiredFiniteNumber(numberCell, "value", path, errors);
};

const validateCoordinateArray = (
  value: unknown,
  path: string,
  errors: string[],
  minimum = 1,
  bounds: MapBounds | null = null,
): void => {
  const coordinates = requireArray(value, path, errors);
  coordinates?.forEach((coordinate, index) => {
    validateCoordinate(
      coordinate,
      `${path}[${index}]`,
      errors,
      minimum,
      bounds,
    );
  });
};

const validateCellGroup = (
  value: unknown,
  path: string,
  errors: string[],
  bounds: MapBounds | null,
): void => {
  const cellGroup = requireRecord(value, path, errors);
  if (!cellGroup) return;
  validateRequiredEnum(cellGroup, "type", path, errors, CELL_GROUP_TYPE_SET);
  const range = {
    startRow: validateOptionalInteger(cellGroup, "startRow", path, errors, 1),
    startCol: validateOptionalInteger(cellGroup, "startCol", path, errors, 1),
    endRow: validateOptionalInteger(cellGroup, "endRow", path, errors, 1),
    endCol: validateOptionalInteger(cellGroup, "endCol", path, errors, 1),
  };
  validateRangeBounds(range, path, errors, bounds);
  if (hasOwn(cellGroup, "cells")) {
    validateCoordinateArray(
      cellGroup.cells,
      `${path}.cells`,
      errors,
      1,
      bounds,
    );
  }
};

const validateBlockDefinition = (
  value: unknown,
  path: string,
  errors: string[],
  bounds: MapBounds | null,
): void => {
  const block = requireRecord(value, path, errors);
  if (!block) return;
  validateRequiredString(block, "name", path, errors);
  const range = {
    startRow: validateRequiredInteger(block, "startRow", path, errors, 1),
    startCol: validateRequiredInteger(block, "startCol", path, errors, 1),
    endRow: validateRequiredInteger(block, "endRow", path, errors, 1),
    endCol: validateRequiredInteger(block, "endCol", path, errors, 1),
  };
  validateRangeBounds(range, path, errors, bounds);

  const numberCells = requireArray(
    block.numberCells,
    `${path}.numberCells`,
    errors,
  );
  numberCells?.forEach((numberCell, index) => {
    validateNumberCell(
      numberCell,
      `${path}.numberCells[${index}]`,
      errors,
      bounds,
    );
  });

  if (hasOwn(block, "nameCells")) {
    validateCoordinateArray(
      block.nameCells,
      `${path}.nameCells`,
      errors,
      1,
      bounds,
    );
  }
  validateOptionalString(block, "color", path, errors);
  validateOptionalString(block, "id", path, errors);
  validateOptionalBoolean(block, "isAutoDetected", path, errors);
  validateOptionalBoolean(block, "isWallBlock", path, errors);

  if (hasOwn(block, "cellGroups")) {
    const groups = requireArray(block.cellGroups, `${path}.cellGroups`, errors);
    groups?.forEach((group, index) => {
      validateCellGroup(group, `${path}.cellGroups[${index}]`, errors, bounds);
    });
  }
};

const validateDayMapData = (
  value: unknown,
  path: string,
  errors: string[],
): MapBounds | null => {
  const dayMap = requireRecord(value, path, errors);
  if (!dayMap) return null;

  validateOptionalString(dayMap, "sheetName", path, errors);
  validateOptionalInteger(dayMap, "rows", path, errors, 0);
  validateOptionalInteger(dayMap, "cols", path, errors, 0);
  const maxRow = validateRequiredInteger(dayMap, "maxRow", path, errors, 0);
  const maxCol = validateRequiredInteger(dayMap, "maxCol", path, errors, 0);
  const bounds =
    maxRow !== undefined && maxCol !== undefined ? { maxRow, maxCol } : null;

  const cells = requireArray(dayMap.cells, `${path}.cells`, errors);
  cells?.forEach((cell, index) => {
    validateCellData(cell, `${path}.cells[${index}]`, errors, bounds);
  });

  const mergedCells = requireArray(
    dayMap.mergedCells,
    `${path}.mergedCells`,
    errors,
  );
  mergedCells?.forEach((mergedCell, index) => {
    validateMergedCell(
      mergedCell,
      `${path}.mergedCells[${index}]`,
      errors,
      bounds,
    );
  });

  const blocks = requireArray(dayMap.blocks, `${path}.blocks`, errors);
  blocks?.forEach((block, index) => {
    validateBlockDefinition(block, `${path}.blocks[${index}]`, errors, bounds);
  });
  return bounds;
};

const validateMapRotationState = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  const rotation = requireRecord(value, path, errors);
  if (!rotation) return;
  (["initialAngle", "mapTabAngle", "focusModeAngle"] as const).forEach(
    (key) => {
      validateRequiredFiniteNumber(rotation, key, path, errors);
    },
  );
};

const validateMapViewportState = (
  value: unknown,
  path: string,
  errors: string[],
): void => {
  const viewport = requireRecord(value, path, errors);
  if (!viewport) return;
  (["zoomLevel", "offsetX", "offsetY"] as const).forEach((key) => {
    validateRequiredFiniteNumber(viewport, key, path, errors);
  });
};

const normalizeMapDayToken = (value: string): string =>
  value
    .replace(/[０-９]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0),
    )
    .replace(/[ \u3000]/g, "")
    .replace(/マップ$/, "");

const getMapEventDate = (mapName: string): string | null => {
  if (mapName === MAPLESS_HALL_KEY) return null;
  if (mapName.startsWith(`${MAPLESS_HALL_KEY}:`)) {
    const eventDate = mapName.slice(MAPLESS_HALL_KEY.length + 1);
    return eventDate.length > 0 ? eventDate : null;
  }
  return normalizeMapDayToken(mapName);
};

const validateItemMapDateReference = (
  eventName: string,
  mapName: string,
  itemId: string,
  path: string,
  itemDatesByEvent: Map<string, Map<string, string>>,
  errors: string[],
): void => {
  const mapEventDate = getMapEventDate(mapName);
  if (mapEventDate === null) return;
  const itemEventDate = itemDatesByEvent.get(eventName)?.get(itemId);
  if (
    itemEventDate !== undefined &&
    normalizeMapDayToken(itemEventDate) !== normalizeMapDayToken(mapEventDate)
  ) {
    addError(
      errors,
      path,
      `品目ID「${itemId}」の日付「${itemEventDate}」は対象マップの日付「${mapEventDate}」と一致しません`,
    );
  }
};

const parseHallGroupId = (groupId: string): string | null => {
  if (
    groupId === "undefined" ||
    groupId === "undefined:priority" ||
    groupId === "undefined:highest"
  ) {
    return null;
  }
  if (groupId.endsWith(":priority")) return groupId.slice(0, -9);
  if (groupId.endsWith(":highest")) return groupId.slice(0, -8);
  return groupId;
};

const validateAppData = (data: UnknownRecord, errors: string[]): void => {
  const sections = getSections(data, errors);
  const knownEvents = new Set<string>();
  const itemIdsByEvent = new Map<string, Set<string>>();
  const itemDatesByEvent = new Map<string, Map<string, string>>();
  const itemsByEvent = new Map<string, ValidatedItem[]>();
  const mapNamesByEvent = new Map<string, Set<string>>();
  const mapBoundsByEvent = new Map<string, Map<string, MapBounds>>();

  if (sections.eventLists) {
    Object.entries(sections.eventLists).forEach(([eventName, rawItems]) => {
      knownEvents.add(eventName);
      const itemIds = new Set<string>();
      const itemDates = new Map<string, string>();
      const validatedItems: ValidatedItem[] = [];
      itemIdsByEvent.set(eventName, itemIds);
      itemDatesByEvent.set(eventName, itemDates);
      itemsByEvent.set(eventName, validatedItems);

      const path = `data.eventLists.${eventName}`;
      const items = requireArray(rawItems, path, errors);
      items?.forEach((rawItem, index) => {
        const itemPath = `${path}[${index}]`;
        const item = validateItem(rawItem, itemPath, errors);
        if (!item) return;
        validatedItems.push(item);
        if (item.id === undefined) return;
        if (itemIds.has(item.id)) {
          addError(
            errors,
            `${itemPath}.id`,
            `イベント内で品目ID「${item.id}」が重複しています`,
          );
          return;
        }
        itemIds.add(item.id);
        if (item.eventDate !== undefined) {
          itemDates.set(item.id, item.eventDate);
        }
      });
    });
  }

  if (sections.eventMetadata) {
    Object.entries(sections.eventMetadata).forEach(
      ([eventName, rawMetadata]) => {
        validateKnownEvent("eventMetadata", eventName, knownEvents, errors);
        const metadataPath = `data.eventMetadata.${eventName}`;
        const metadata = requireRecord(rawMetadata, metadataPath, errors);
        if (!metadata) return;
        (
          ["spreadsheetUrl", "spreadsheetSheetName", "lastImportDate"] as const
        ).forEach((key) => {
          validateRequiredString(metadata, key, metadataPath, errors);
        });
      },
    );
  }

  if (sections.executeModeItems) {
    Object.entries(sections.executeModeItems).forEach(
      ([eventName, rawItemsByDate]) => {
        validateKnownEvent("executeModeItems", eventName, knownEvents, errors);
        const eventPath = `data.executeModeItems.${eventName}`;
        const itemsByDate = requireRecord(rawItemsByDate, eventPath, errors);
        if (!itemsByDate) return;
        Object.entries(itemsByDate).forEach(([eventDate, rawItemIds]) => {
          validateStringArray(
            rawItemIds,
            `${eventPath}.${eventDate}`,
            errors,
            (itemId, itemPath) => {
              validateItemReference(
                eventName,
                itemId,
                itemPath,
                itemIdsByEvent,
                errors,
              );
              const referencedDate = itemDatesByEvent
                .get(eventName)
                ?.get(itemId);
              if (
                referencedDate !== undefined &&
                referencedDate !== eventDate
              ) {
                addError(
                  errors,
                  itemPath,
                  `品目ID「${itemId}」の日付「${referencedDate}」と一致しません`,
                );
              }
            },
          );
        });
      },
    );
  }

  if (sections.dayModes) {
    Object.entries(sections.dayModes).forEach(([eventName, rawModesByDate]) => {
      validateKnownEvent("dayModes", eventName, knownEvents, errors);
      const eventPath = `data.dayModes.${eventName}`;
      const modesByDate = requireRecord(rawModesByDate, eventPath, errors);
      if (!modesByDate) return;
      Object.entries(modesByDate).forEach(([eventDate, mode]) => {
        if (typeof mode !== "string" || !VIEW_MODE_SET.has(mode)) {
          addError(
            errors,
            `${eventPath}.${eventDate}`,
            "edit、execute、focusのいずれかである必要があります",
          );
        }
      });
    });
  }

  if (sections.mapData) {
    Object.entries(sections.mapData).forEach(([eventName, rawMapsByName]) => {
      validateKnownEvent("mapData", eventName, knownEvents, errors);
      const eventPath = `data.mapData.${eventName}`;
      const mapsByName = requireRecord(rawMapsByName, eventPath, errors);
      if (!mapsByName) return;

      const mapNames = new Set(Object.keys(mapsByName));
      mapNamesByEvent.set(eventName, mapNames);
      const boundsByMap = new Map<string, MapBounds>();
      mapBoundsByEvent.set(eventName, boundsByMap);
      Object.entries(mapsByName).forEach(([mapName, rawDayMap]) => {
        const bounds = validateDayMapData(
          rawDayMap,
          `${eventPath}.${mapName}`,
          errors,
        );
        if (bounds) boundsByMap.set(mapName, bounds);
      });
    });
  }

  if (sections.mapRotationSettings) {
    Object.entries(sections.mapRotationSettings).forEach(
      ([eventName, rawSettingsByMap]) => {
        validateKnownEvent(
          "mapRotationSettings",
          eventName,
          knownEvents,
          errors,
        );
        const eventPath = `data.mapRotationSettings.${eventName}`;
        const settingsByMap = requireRecord(
          rawSettingsByMap,
          eventPath,
          errors,
        );
        if (!settingsByMap) return;
        Object.entries(settingsByMap).forEach(([mapName, rawSettings]) => {
          validateMapRotationState(
            rawSettings,
            `${eventPath}.${mapName}`,
            errors,
          );
        });
      },
    );
  }

  if (sections.mapViewportSettings) {
    Object.entries(sections.mapViewportSettings).forEach(
      ([eventName, rawSettingsByMap]) => {
        validateKnownEvent(
          "mapViewportSettings",
          eventName,
          knownEvents,
          errors,
        );
        const eventPath = `data.mapViewportSettings.${eventName}`;
        const settingsByMap = requireRecord(
          rawSettingsByMap,
          eventPath,
          errors,
        );
        if (!settingsByMap) return;
        Object.entries(settingsByMap).forEach(([mapName, rawSettings]) => {
          validateMapViewportState(
            rawSettings,
            `${eventPath}.${mapName}`,
            errors,
          );
        });
      },
    );
  }

  if (sections.routeSettings) {
    Object.entries(sections.routeSettings).forEach(
      ([eventName, rawSettingsByMap]) => {
        validateKnownEvent("routeSettings", eventName, knownEvents, errors);
        const eventPath = `data.routeSettings.${eventName}`;
        const settingsByMap = requireRecord(
          rawSettingsByMap,
          eventPath,
          errors,
        );
        if (!settingsByMap) return;
        Object.entries(settingsByMap).forEach(([mapName, rawSettings]) => {
          const settingPath = `${eventPath}.${mapName}`;
          validateKnownMap(
            "routeSettings",
            eventName,
            mapName,
            mapNamesByEvent,
            errors,
          );
          const settings = requireRecord(rawSettings, settingPath, errors);
          if (!settings) return;
          const bounds = mapBoundsByEvent.get(eventName)?.get(mapName) ?? null;
          validateRequiredBoolean(
            settings,
            "isRouteVisible",
            settingPath,
            errors,
          );
          const visitOrder = requireArray(
            settings.visitOrder,
            `${settingPath}.visitOrder`,
            errors,
          );
          visitOrder?.forEach((rawPoint, pointIndex) => {
            const pointPath = `${settingPath}.visitOrder[${pointIndex}]`;
            const point = requireRecord(rawPoint, pointPath, errors);
            if (!point) return;
            validateCoordinate(point, pointPath, errors, 1, bounds);
            validateRequiredString(point, "blockName", pointPath, errors);
            validateRequiredFiniteNumber(point, "number", pointPath, errors);
            validateRequiredInteger(point, "order", pointPath, errors, 0);
            validateStringArray(
              point.itemIds,
              `${pointPath}.itemIds`,
              errors,
              (itemId, itemPath) => {
                validateItemReference(
                  eventName,
                  itemId,
                  itemPath,
                  itemIdsByEvent,
                  errors,
                );
                validateItemMapDateReference(
                  eventName,
                  mapName,
                  itemId,
                  itemPath,
                  itemDatesByEvent,
                  errors,
                );
              },
            );
          });
        });
      },
    );
  }

  const hallIdsByEventAndMap = new Map<string, Map<string, Set<string>>>();
  if (sections.hallDefinitions) {
    Object.entries(sections.hallDefinitions).forEach(
      ([eventName, rawDefinitionsByMap]) => {
        validateKnownEvent("hallDefinitions", eventName, knownEvents, errors);
        const eventPath = `data.hallDefinitions.${eventName}`;
        const definitionsByMap = requireRecord(
          rawDefinitionsByMap,
          eventPath,
          errors,
        );
        if (!definitionsByMap) return;

        const hallIdsByMap = new Map<string, Set<string>>();
        hallIdsByEventAndMap.set(eventName, hallIdsByMap);
        Object.entries(definitionsByMap).forEach(
          ([mapName, rawDefinitions]) => {
            const mapPath = `${eventPath}.${mapName}`;
            if (
              mapName !== MAPLESS_HALL_KEY &&
              !mapName.startsWith(`${MAPLESS_HALL_KEY}:`)
            ) {
              validateKnownMap(
                "hallDefinitions",
                eventName,
                mapName,
                mapNamesByEvent,
                errors,
              );
            }
            const definitions = requireArray(rawDefinitions, mapPath, errors);
            if (!definitions) return;

            const hallIds = new Set<string>();
            hallIdsByMap.set(mapName, hallIds);
            definitions.forEach((rawDefinition, index) => {
              const definitionPath = `${mapPath}[${index}]`;
              const definition = requireRecord(
                rawDefinition,
                definitionPath,
                errors,
              );
              if (!definition) return;
              const hallId = validateRequiredString(
                definition,
                "id",
                definitionPath,
                errors,
                true,
              );
              if (hallId === undefined) return;
              if (hallIds.has(hallId)) {
                addError(
                  errors,
                  `${definitionPath}.id`,
                  `マップ内で会場ID「${hallId}」が重複しています`,
                );
              } else {
                hallIds.add(hallId);
              }

              validateRequiredString(
                definition,
                "name",
                definitionPath,
                errors,
              );
              if (!hasOwn(definition, "vertices")) {
                addError(
                  errors,
                  `${definitionPath}.vertices`,
                  "必須項目がありません",
                );
              } else {
                validateCoordinateArray(
                  definition.vertices,
                  `${definitionPath}.vertices`,
                  errors,
                  0,
                );
              }
              validateOptionalString(
                definition,
                "color",
                definitionPath,
                errors,
              );
              if (hasOwn(definition, "blockNames")) {
                validateStringArray(
                  definition.blockNames,
                  `${definitionPath}.blockNames`,
                  errors,
                );
              }
            });
          },
        );
      },
    );
  }

  if (sections.hallRouteSettings) {
    Object.entries(sections.hallRouteSettings).forEach(
      ([eventName, rawSettingsByMap]) => {
        validateKnownEvent("hallRouteSettings", eventName, knownEvents, errors);
        const eventPath = `data.hallRouteSettings.${eventName}`;
        const settingsByMap = requireRecord(
          rawSettingsByMap,
          eventPath,
          errors,
        );
        if (!settingsByMap) return;

        Object.entries(settingsByMap).forEach(([mapName, rawSettings]) => {
          const settingPath = `${eventPath}.${mapName}`;
          const settings = requireRecord(rawSettings, settingPath, errors);
          if (!settings) return;
          const knownHallIds =
            hallIdsByEventAndMap.get(eventName)?.get(mapName) ??
            new Set<string>();

          validateStringArray(
            settings.hallOrder,
            `${settingPath}.hallOrder`,
            errors,
            (groupId, groupPath) => {
              const hallId = parseHallGroupId(groupId);
              if (hallId !== null && !knownHallIds.has(hallId)) {
                addError(
                  errors,
                  groupPath,
                  `存在しない会場ID「${hallId}」を参照しています`,
                );
              }
            },
          );

          const visitLists = requireArray(
            settings.hallVisitLists,
            `${settingPath}.hallVisitLists`,
            errors,
          );
          visitLists?.forEach((rawVisitList, index) => {
            const visitListPath = `${settingPath}.hallVisitLists[${index}]`;
            const visitList = requireRecord(
              rawVisitList,
              visitListPath,
              errors,
            );
            if (!visitList) return;

            const hallId = validateRequiredString(
              visitList,
              "hallId",
              visitListPath,
              errors,
              true,
            );
            if (hallId !== undefined && !knownHallIds.has(hallId)) {
              addError(
                errors,
                `${visitListPath}.hallId`,
                `存在しない会場ID「${hallId}」を参照しています`,
              );
            }

            validateStringArray(
              visitList.itemIds,
              `${visitListPath}.itemIds`,
              errors,
              (itemId, itemPath) => {
                validateItemReference(
                  eventName,
                  itemId,
                  itemPath,
                  itemIdsByEvent,
                  errors,
                );
                validateItemMapDateReference(
                  eventName,
                  mapName,
                  itemId,
                  itemPath,
                  itemDatesByEvent,
                  errors,
                );
              },
            );
          });
        });
      },
    );
  }

  itemsByEvent.forEach((items, eventName) => {
    const hallIdsByMap = hallIdsByEventAndMap.get(eventName);
    items.forEach((item) => {
      if (item.manualHallId === undefined || item.eventDate === undefined) {
        return;
      }
      if (!hallIdsByMap) {
        addError(
          errors,
          `${item.path}.manualHallId`,
          `存在しない会場ID「${item.manualHallId}」を参照しています`,
        );
        return;
      }

      const normalizedDate = normalizeMapDayToken(item.eventDate);
      const availableHallIds = new Set<string>();
      hallIdsByMap.forEach((hallIds, mapName) => {
        if (
          mapName === MAPLESS_HALL_KEY ||
          mapName === `${MAPLESS_HALL_KEY}:${item.eventDate}` ||
          (!mapName.startsWith(`${MAPLESS_HALL_KEY}:`) &&
            normalizeMapDayToken(mapName) === normalizedDate)
        ) {
          hallIds.forEach((hallId) => availableHallIds.add(hallId));
        }
      });
      if (!availableHallIds.has(item.manualHallId)) {
        addError(
          errors,
          `${item.path}.manualHallId`,
          `品目の日付に存在しない会場ID「${item.manualHallId}」を参照しています`,
        );
      }
    });
  });
};

type MapScopedSettingsStore<T> = Record<string, Record<string, T>>;

const pruneOrphanedMapSettings = <T>(
  settings: MapScopedSettingsStore<T>,
  mapData: AppData["mapData"],
): MapScopedSettingsStore<T> => {
  let normalized = settings;

  Object.entries(settings).forEach(([eventName, settingsByMap]) => {
    const knownMapNames = new Set(Object.keys(mapData[eventName] ?? {}));
    const retainedEntries = Object.entries(settingsByMap).filter(([mapName]) =>
      knownMapNames.has(mapName),
    );
    if (retainedEntries.length === Object.keys(settingsByMap).length) return;

    if (normalized === settings) normalized = { ...settings };
    normalized[eventName] = Object.fromEntries(retainedEntries);
  });

  return normalized;
};

const normalizeAppDataForBackup = (data: AppData): AppData => {
  const mapRotationSettings = pruneOrphanedMapSettings(
    data.mapRotationSettings,
    data.mapData,
  );
  const mapViewportSettings = pruneOrphanedMapSettings(
    data.mapViewportSettings,
    data.mapData,
  );

  if (
    mapRotationSettings === data.mapRotationSettings &&
    mapViewportSettings === data.mapViewportSettings
  ) {
    return data;
  }

  return {
    ...data,
    mapRotationSettings,
    mapViewportSettings,
  };
};

export function createAppBackup(
  data: AppData,
  exportedAt: Date = new Date(),
  eventSettings: AppBackupEventSettings = {
    blockDetectionSettings: {},
  },
): AppBackupV1 {
  return {
    kind: APP_BACKUP_KIND,
    version: APP_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    eventSettings,
    data: normalizeAppDataForBackup(data),
  };
}

export function serializeAppBackup(backup: AppBackupV1): string {
  return JSON.stringify(backup, null, 2);
}

export function parseAppBackup(source: unknown): AppBackupParseResult {
  let parsed = source;
  if (typeof source === "string") {
    try {
      parsed = JSON.parse(source) as unknown;
    } catch {
      return {
        ok: false,
        data: null,
        errors: ["$: JSONとして読み込めません"],
      };
    }
  }

  const errors: string[] = [];
  const root = requireRecord(parsed, "$", errors);
  if (!root) return { ok: false, data: null, errors };

  if (root.kind !== APP_BACKUP_KIND) {
    addError(errors, "kind", "未知のバックアップ形式です");
  }
  if (root.version !== APP_BACKUP_VERSION) {
    addError(errors, "version", "未対応のバックアップバージョンです");
  }
  if (!isCanonicalIsoDate(root.exportedAt)) {
    addError(errors, "exportedAt", "ISO形式の日時である必要があります");
  }

  const data = requireRecord(root.data, "data", errors);
  if (data) validateAppData(data, errors);
  const eventLists =
    data && isRecord(data.eventLists) ? data.eventLists : ({} as UnknownRecord);
  validateEventSettings(
    root.eventSettings,
    new Set(Object.keys(eventLists)),
    errors,
  );

  if (errors.length > 0) return { ok: false, data: null, errors };

  const rawBackup = root as unknown as AppBackupV1;
  const normalizedData = normalizeAppDataForBackup(rawBackup.data);
  const backup =
    normalizedData === rawBackup.data
      ? rawBackup
      : {
          ...rawBackup,
          data: normalizedData,
        };
  return {
    ok: true,
    backup,
    data: backup.data,
    errors: [],
  };
}
