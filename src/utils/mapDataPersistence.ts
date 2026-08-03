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

const EMPTY_BORDERS: CellBorders = {
  top: null,
  right: null,
  bottom: null,
  left: null,
};

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

export function expandDayMapFromStorage(
  dayMapData: Partial<PersistedDayMapData>,
): DayMapData {
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
  data: Record<string, unknown>,
): MapDataStore[string] {
  const expanded: MapDataStore[string] = {};

  Object.entries(data).forEach(([dayMapName, dayMapData]) => {
    if (
      !dayMapData ||
      typeof dayMapData !== "object" ||
      Array.isArray(dayMapData)
    )
      return;
    expanded[dayMapName] = expandDayMapFromStorage(
      dayMapData as Partial<PersistedDayMapData>,
    );
  });

  return expanded;
}

export function compactMapDataForStorage(
  data: MapDataStore,
): Record<string, Record<string, unknown>> {
  const compacted: Record<string, Record<string, unknown>> = {};

  Object.entries(data).forEach(([eventName, eventMapData]) => {
    const compactedEventMap: Record<string, unknown> = {};
    Object.entries(eventMapData).forEach(([dayMapName, dayMapData]) => {
      compactedEventMap[dayMapName] = compactDayMapForStorage(dayMapData);
    });
    if (Object.keys(compactedEventMap).length > 0) {
      compacted[eventName] = compactedEventMap;
    }
  });

  return compacted;
}

export function expandMapDataFromStorage(
  data: Record<string, Record<string, unknown>>,
): MapDataStore {
  const expanded: MapDataStore = {};

  Object.entries(data).forEach(([eventName, eventMapData]) => {
    const expandedEventMap = expandEventMapDataFromStorage(eventMapData);
    if (Object.keys(expandedEventMap).length > 0) {
      expanded[eventName] = expandedEventMap;
    }
  });

  return expanded;
}

export function normalizeMapDataForPersistence(
  data: MapDataStore,
): MapDataStore {
  return expandMapDataFromStorage(compactMapDataForStorage(data));
}
