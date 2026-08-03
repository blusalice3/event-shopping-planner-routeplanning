import type {
  CellBorders,
  CellData,
  DayMapData,
  MapDataStore,
} from "../types/map";

type PersistedCellData = Pick<CellData, "row" | "col"> &
  Partial<Omit<CellData, "row" | "col">>;

type PersistedDayMapData = Omit<DayMapData, "cells"> & {
  cells: PersistedCellData[];
};

export class InvalidMapPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMapPayload";
  }
}

const EMPTY_BORDERS: CellBorders = {
  top: null,
  right: null,
  bottom: null,
  left: null,
};

function isPlainMapDataRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainMapDataRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (!isPlainMapDataRecord(value)) {
    throw new InvalidMapPayloadError(message);
  }
}

type PersistedValueValidator = (value: unknown, path: string) => void;

const BORDER_STYLE_VALUES = new Set([
  "thin",
  "medium",
  "thick",
  "double",
  "none",
]);
const BORDER_SIDE_KEYS = new Set(["top", "right", "bottom", "left"]);
const BORDER_STYLE_KEYS = new Set(["style", "color"]);
const COORDINATE_KEYS = new Set(["row", "col"]);
const CELL_KEYS = new Set([
  "row",
  "col",
  "value",
  "backgroundColor",
  "fontColor",
  "borders",
  "isMerged",
  "mergeParent",
  "isVerticalText",
]);
const MERGED_CELL_KEYS = new Set([
  "startRow",
  "startCol",
  "endRow",
  "endCol",
  "value",
]);
const NUMBER_CELL_KEYS = new Set(["row", "col", "value"]);
const CELL_GROUP_KEYS = new Set([
  "type",
  "startRow",
  "startCol",
  "endRow",
  "endCol",
  "cells",
]);
const BLOCK_KEYS = new Set([
  "name",
  "startRow",
  "startCol",
  "endRow",
  "endCol",
  "numberCells",
  "nameCells",
  "color",
  "id",
  "isAutoDetected",
  "isWallBlock",
  "cellGroups",
]);
const DAY_MAP_KEYS = new Set([
  "sheetName",
  "rows",
  "cols",
  "maxRow",
  "maxCol",
  "cells",
  "mergedCells",
  "blocks",
]);

function invalidPersistedValue(path: string, expectation: string): never {
  throw new InvalidMapPayloadError(`Persisted mapData ${path} ${expectation}.`);
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  path: string,
): void {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    invalidPersistedValue(path, "must have readable keys");
  }
  const unknownKey = keys.find(
    (key) => typeof key !== "string" || !allowedKeys.has(key),
  );
  if (unknownKey !== undefined) {
    invalidPersistedValue(`${path}.${String(unknownKey)}`, "is not recognized");
  }
  const unreadableKey = keys.find((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    );
  });
  if (unreadableKey !== undefined) {
    invalidPersistedValue(
      `${path}.${String(unreadableKey)}`,
      "must be an enumerable data property",
    );
  }
}

function assertStringKeyedDataRecord(
  value: Record<string, unknown>,
  path: string,
): void {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    invalidPersistedValue(path, "must have readable keys");
  }
  const invalidKey = keys.find((key) => {
    if (typeof key !== "string") return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    );
  });
  if (invalidKey !== undefined) {
    invalidPersistedValue(
      `${path}.${String(invalidKey)}`,
      "must be an enumerable string-keyed data property",
    );
  }
}

function assertRequiredField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  validate: PersistedValueValidator,
): void {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    invalidPersistedValue(`${path}.${key}`, "is required");
  }
  validate(value[key], `${path}.${key}`);
}

function assertOptionalField(
  value: Record<string, unknown>,
  key: string,
  path: string,
  validate: PersistedValueValidator,
): void {
  const fieldValue = value[key];
  if (fieldValue !== undefined) {
    validate(fieldValue, `${path}.${key}`);
  }
}

function assertString(value: unknown, path: string): void {
  if (typeof value !== "string") {
    invalidPersistedValue(path, "must be a string");
  }
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") {
    invalidPersistedValue(path, "must be a boolean");
  }
}

function assertFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidPersistedValue(path, "must be a finite number");
  }
}

function assertIntegerAtLeast(
  value: unknown,
  path: string,
  minimum: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    invalidPersistedValue(
      path,
      `must be a safe integer greater than or equal to ${minimum}`,
    );
  }
}

function assertCoordinate(value: unknown, path: string): void {
  assertIntegerAtLeast(value, path, 1);
}

function assertMapSize(value: unknown, path: string): void {
  assertIntegerAtLeast(value, path, 0);
}

function assertCellValue(value: unknown, path: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    invalidPersistedValue(path, "must be a string, finite number, or null");
  }
}

function assertNullableString(value: unknown, path: string): void {
  if (value !== null && typeof value !== "string") {
    invalidPersistedValue(path, "must be a string or null");
  }
}

function assertDenseArray(
  value: unknown,
  path: string,
  validateItem: PersistedValueValidator,
): void {
  if (!Array.isArray(value)) {
    invalidPersistedValue(path, "must be an array");
  }
  const keys = Reflect.ownKeys(value);
  const hasOnlyDenseIndexes =
    keys.length === value.length + 1 &&
    keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" &&
          /^(0|[1-9]\d*)$/.test(key) &&
          Number(key) < value.length &&
          Object.prototype.hasOwnProperty.call(value, key)),
    );
  if (!hasOnlyDenseIndexes) {
    invalidPersistedValue(path, "must be a dense array without extra keys");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      invalidPersistedValue(
        `${path}[${index}]`,
        "must be an enumerable data item",
      );
    }
    validateItem(value[index], `${path}[${index}]`);
  }
}

function assertCoordinateRecord(value: unknown, path: string): void {
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, COORDINATE_KEYS, path);
  assertRequiredField(value, "row", path, assertCoordinate);
  assertRequiredField(value, "col", path, assertCoordinate);
}

function assertBorderStyle(value: unknown, path: string): void {
  if (value === null) return;
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, BORDER_STYLE_KEYS, path);
  assertRequiredField(value, "style", path, (style, stylePath) => {
    if (typeof style !== "string" || !BORDER_STYLE_VALUES.has(style)) {
      invalidPersistedValue(stylePath, "has an unsupported border style");
    }
  });
  assertRequiredField(value, "color", path, assertString);
}

function assertCellBorders(value: unknown, path: string): void {
  if (value === null) return;
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, BORDER_SIDE_KEYS, path);
  BORDER_SIDE_KEYS.forEach((side) => {
    assertOptionalField(value, side, path, assertBorderStyle);
  });
}

function assertPersistedCell(value: unknown, path: string): void {
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, CELL_KEYS, path);
  assertRequiredField(value, "row", path, assertCoordinate);
  assertRequiredField(value, "col", path, assertCoordinate);
  assertOptionalField(value, "value", path, assertCellValue);
  assertOptionalField(value, "backgroundColor", path, assertNullableString);
  assertOptionalField(value, "fontColor", path, assertNullableString);
  assertOptionalField(value, "borders", path, assertCellBorders);
  assertOptionalField(value, "isMerged", path, assertBoolean);
  assertOptionalField(value, "mergeParent", path, assertCoordinateRecord);
  assertOptionalField(value, "isVerticalText", path, assertBoolean);
}

function assertMergedCell(value: unknown, path: string): void {
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, MERGED_CELL_KEYS, path);
  assertRequiredField(value, "startRow", path, assertCoordinate);
  assertRequiredField(value, "startCol", path, assertCoordinate);
  assertRequiredField(value, "endRow", path, assertCoordinate);
  assertRequiredField(value, "endCol", path, assertCoordinate);
  assertRequiredField(value, "value", path, assertCellValue);
}

function assertNumberCell(value: unknown, path: string): void {
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, NUMBER_CELL_KEYS, path);
  assertRequiredField(value, "row", path, assertCoordinate);
  assertRequiredField(value, "col", path, assertCoordinate);
  assertRequiredField(value, "value", path, assertFiniteNumber);
}

function assertCellGroup(value: unknown, path: string): void {
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, CELL_GROUP_KEYS, path);
  assertRequiredField(value, "type", path, (type, typePath) => {
    if (type !== "range" && type !== "individual") {
      invalidPersistedValue(typePath, "must be range or individual");
    }
  });
  ["startRow", "startCol", "endRow", "endCol"].forEach((key) => {
    assertOptionalField(value, key, path, assertCoordinate);
  });
  assertOptionalField(value, "cells", path, (cells, cellsPath) => {
    assertDenseArray(cells, cellsPath, assertCoordinateRecord);
  });
}

function assertPersistedBlock(value: unknown, path: string): void {
  assertPlainMapDataRecord(
    value,
    `Persisted mapData ${path} must be an object.`,
  );
  assertAllowedKeys(value, BLOCK_KEYS, path);
  assertRequiredField(value, "name", path, assertString);
  ["startRow", "startCol", "endRow", "endCol"].forEach((key) => {
    assertRequiredField(value, key, path, assertCoordinate);
  });
  assertOptionalField(value, "numberCells", path, (cells, cellsPath) => {
    assertDenseArray(cells, cellsPath, assertNumberCell);
  });
  assertOptionalField(value, "nameCells", path, (cells, cellsPath) => {
    assertDenseArray(cells, cellsPath, assertCoordinateRecord);
  });
  assertOptionalField(value, "color", path, assertString);
  assertOptionalField(value, "id", path, assertString);
  assertOptionalField(value, "isAutoDetected", path, assertBoolean);
  assertOptionalField(value, "isWallBlock", path, assertBoolean);
  assertOptionalField(value, "cellGroups", path, (groups, groupsPath) => {
    assertDenseArray(groups, groupsPath, assertCellGroup);
  });
}

function assertPersistedDayMap(
  dayMapData: Record<string, unknown>,
  path: string,
): void {
  assertAllowedKeys(dayMapData, DAY_MAP_KEYS, path);
  assertOptionalField(dayMapData, "sheetName", path, assertString);
  assertOptionalField(dayMapData, "rows", path, assertMapSize);
  assertOptionalField(dayMapData, "cols", path, assertMapSize);
  assertOptionalField(dayMapData, "maxRow", path, assertMapSize);
  assertOptionalField(dayMapData, "maxCol", path, assertMapSize);
  assertOptionalField(dayMapData, "cells", path, (cells, cellsPath) => {
    assertDenseArray(cells, cellsPath, assertPersistedCell);
  });
  assertOptionalField(
    dayMapData,
    "mergedCells",
    path,
    (mergedCells, mergedCellsPath) => {
      assertDenseArray(mergedCells, mergedCellsPath, assertMergedCell);
    },
  );
  assertOptionalField(dayMapData, "blocks", path, (blocks, blocksPath) => {
    assertDenseArray(blocks, blocksPath, assertPersistedBlock);
  });
}

function setOwnMapEntry<T>(
  target: Record<string, T>,
  key: string,
  value: T,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isEmptyBorders(borders: CellBorders | null | undefined): boolean {
  return (
    !borders ||
    (!borders.top && !borders.right && !borders.bottom && !borders.left)
  );
}

function normalizeBorders(
  borders: Partial<CellBorders> | null | undefined,
): CellBorders {
  return {
    top: borders?.top ?? null,
    right: borders?.right ?? null,
    bottom: borders?.bottom ?? null,
    left: borders?.left ?? null,
  };
}

function isDefaultWhiteColor(color: string | null | undefined): boolean {
  return color?.trim().toUpperCase() === "#FFFFFF";
}

function getImportantCellKeys(dayMapData: DayMapData): Set<string> {
  const keys = new Set<string>();

  dayMapData.blocks.forEach((block) => {
    block.numberCells.forEach((cell) => {
      keys.add(`${cell.row}-${cell.col}`);
    });
    block.nameCells?.forEach((cell) => {
      keys.add(`${cell.row}-${cell.col}`);
    });
  });

  dayMapData.mergedCells.forEach((merge) => {
    keys.add(`${merge.startRow}-${merge.startCol}`);
  });

  return keys;
}

function hasPersistableCellContent(
  cell: CellData,
  importantCellKeys: Set<string>,
): boolean {
  if (importantCellKeys.has(`${cell.row}-${cell.col}`)) return true;
  if (cell.value !== null && cell.value !== undefined) return true;
  if (cell.backgroundColor && !isDefaultWhiteColor(cell.backgroundColor))
    return true;
  if (cell.fontColor) return true;
  if (!isEmptyBorders(cell.borders)) return true;
  if (cell.isVerticalText) return true;
  return false;
}

function compactCellForStorage(cell: CellData): PersistedCellData {
  const compacted: PersistedCellData = {
    row: cell.row,
    col: cell.col,
  };

  if (cell.value !== null && cell.value !== undefined) {
    compacted.value = cell.value;
  }
  if (cell.backgroundColor && !isDefaultWhiteColor(cell.backgroundColor)) {
    compacted.backgroundColor = cell.backgroundColor;
  }
  if (cell.fontColor) {
    compacted.fontColor = cell.fontColor;
  }
  if (!isEmptyBorders(cell.borders)) {
    compacted.borders = cell.borders;
  }
  if (cell.isMerged) {
    compacted.isMerged = cell.isMerged;
  }
  if (cell.mergeParent) {
    compacted.mergeParent = cell.mergeParent;
  }
  if (cell.isVerticalText) {
    compacted.isVerticalText = cell.isVerticalText;
  }

  return compacted;
}

function expandCellFromStorage(cell: PersistedCellData): CellData {
  return {
    row: cell.row,
    col: cell.col,
    value: cell.value ?? null,
    backgroundColor: cell.backgroundColor ?? null,
    fontColor: cell.fontColor ?? null,
    borders: normalizeBorders(cell.borders ?? EMPTY_BORDERS),
    isMerged: cell.isMerged ?? false,
    ...(cell.mergeParent !== undefined
      ? { mergeParent: cell.mergeParent }
      : {}),
    isVerticalText: cell.isVerticalText ?? false,
  };
}

export function compactDayMapForStorage(
  dayMapData: DayMapData,
): PersistedDayMapData {
  const normalizedDayMapData = expandDayMapFromStorage(dayMapData);
  const importantCellKeys = getImportantCellKeys(normalizedDayMapData);

  return {
    ...normalizedDayMapData,
    cells: normalizedDayMapData.cells
      .filter((cell) => hasPersistableCellContent(cell, importantCellKeys))
      .map(compactCellForStorage),
  };
}

export function expandDayMapFromStorage(value: unknown): DayMapData {
  assertPlainMapDataRecord(
    value,
    "A persisted mapData day must be a plain object.",
  );
  assertPersistedDayMap(value, "day");
  const dayMapData = value as Partial<PersistedDayMapData>;
  const blocks = Array.isArray(dayMapData.blocks)
    ? dayMapData.blocks.map((block) => ({
        ...block,
        numberCells: Array.isArray(block.numberCells) ? block.numberCells : [],
        ...(block.nameCells !== undefined
          ? { nameCells: Array.isArray(block.nameCells) ? block.nameCells : [] }
          : {}),
      }))
    : [];

  return {
    ...dayMapData,
    maxRow: dayMapData.maxRow ?? dayMapData.rows ?? 0,
    maxCol: dayMapData.maxCol ?? dayMapData.cols ?? 0,
    cells: (Array.isArray(dayMapData.cells) ? dayMapData.cells : []).map(
      expandCellFromStorage,
    ),
    mergedCells: Array.isArray(dayMapData.mergedCells)
      ? dayMapData.mergedCells
      : [],
    blocks,
  };
}

export function expandEventMapDataFromStorage(
  value: unknown,
): MapDataStore[string] {
  assertPlainMapDataRecord(
    value,
    "A persisted mapData event must be a plain object.",
  );
  assertStringKeyedDataRecord(value, "event");
  const expanded: MapDataStore[string] = {};

  Object.entries(value).forEach(([dayMapName, dayMapData]) => {
    setOwnMapEntry(expanded, dayMapName, expandDayMapFromStorage(dayMapData));
  });

  return expanded;
}

export function compactMapDataForStorage(
  data: MapDataStore,
): Record<string, Record<string, unknown>> {
  assertPlainMapDataRecord(
    data,
    "The mapData payload root must be a plain object.",
  );
  assertStringKeyedDataRecord(data, "root");
  const compacted: Record<string, Record<string, unknown>> = {};

  Object.entries(data).forEach(([eventName, eventMapData]) => {
    assertPlainMapDataRecord(
      eventMapData,
      "A mapData payload event must be a plain object.",
    );
    assertStringKeyedDataRecord(eventMapData, `root.${eventName}`);
    const compactedEventMap: Record<string, unknown> = {};
    Object.entries(eventMapData).forEach(([dayMapName, dayMapData]) => {
      setOwnMapEntry(
        compactedEventMap,
        dayMapName,
        compactDayMapForStorage(dayMapData),
      );
    });
    if (Object.keys(compactedEventMap).length > 0) {
      setOwnMapEntry(compacted, eventName, compactedEventMap);
    }
  });

  return compacted;
}

export function expandMapDataFromStorage(value: unknown): MapDataStore {
  assertPlainMapDataRecord(
    value,
    "The persisted mapData root must be a plain object.",
  );
  assertStringKeyedDataRecord(value, "root");
  const expanded: MapDataStore = {};

  Object.entries(value).forEach(([eventName, eventMapData]) => {
    const expandedEventMap = expandEventMapDataFromStorage(eventMapData);
    if (Object.keys(expandedEventMap).length > 0) {
      setOwnMapEntry(expanded, eventName, expandedEventMap);
    }
  });

  return expanded;
}

export function normalizeMapDataForPersistence(
  data: MapDataStore,
): MapDataStore {
  return expandMapDataFromStorage(compactMapDataForStorage(data));
}
