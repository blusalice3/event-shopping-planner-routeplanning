import type { BlockDefinition, DayMapData, NumberCellInfo } from "../types/map";

const compareStringStable = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

const encodeCellValueForRouteSignature = (
  value: string | number | null | undefined,
): [string, string | number | null] => {
  if (value === undefined) return ["undefined", null];
  if (value === null) return ["null", null];
  return [typeof value, value];
};

const compareNumberCellEntry = (
  a: [number, NumberCellInfo],
  b: [number, NumberCellInfo],
): number => a[0] - b[0] || a[1].row - b[1].row || a[1].col - b[1].col;

const hasDuplicateBlockNames = (blocks: BlockDefinition[]): boolean => {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.name)) return true;
    seen.add(block.name);
  }
  return false;
};

const isPreferredRouteLookupCell = (
  candidate: NumberCellInfo,
  selected: NumberCellInfo | undefined,
): boolean =>
  !selected ||
  candidate.row < selected.row ||
  (candidate.row === selected.row && candidate.col < selected.col);

function selectRouteLookupNumberCellsByValue(
  block: BlockDefinition,
): Map<number, NumberCellInfo> {
  const selectedByValue = new Map<number, NumberCellInfo>();

  for (const cell of block.numberCells) {
    const selected = selectedByValue.get(cell.value);
    if (isPreferredRouteLookupCell(cell, selected)) {
      selectedByValue.set(cell.value, cell);
    }
  }

  return selectedByValue;
}

export function getRouteLookupNumberCellEntries(
  block: BlockDefinition,
): [number, NumberCellInfo][] {
  return [...selectRouteLookupNumberCellsByValue(block).entries()].sort(
    compareNumberCellEntry,
  );
}

export function findRouteLookupNumberCell(
  block: BlockDefinition,
  value: number,
): NumberCellInfo | undefined {
  let selected: NumberCellInfo | undefined;

  for (const cell of block.numberCells) {
    if (cell.value !== value) continue;
    if (isPreferredRouteLookupCell(cell, selected)) {
      selected = cell;
    }
  }

  return selected;
}

export function buildDayMapVisitLookupSignature(
  dayMapData: DayMapData | null | undefined,
): string {
  if (!dayMapData) return JSON.stringify(null);

  const blocks = hasDuplicateBlockNames(dayMapData.blocks)
    ? dayMapData.blocks
    : [...dayMapData.blocks].sort((a, b) =>
        compareStringStable(a.name, b.name),
      );

  return JSON.stringify(
    blocks.map((block) => [
      block.name,
      getRouteLookupNumberCellEntries(block).map(([value, cell]) => [
        value,
        cell.row,
        cell.col,
      ]),
    ]),
  );
}

export function buildDayMapPathfindingSignature(
  dayMapData: DayMapData | null | undefined,
): string {
  if (!dayMapData) return JSON.stringify(null);

  return JSON.stringify([
    dayMapData.maxRow,
    dayMapData.maxCol,
    [...dayMapData.cells]
      .sort((a, b) => a.row - b.row || a.col - b.col)
      .map((cell) => [
        cell.row,
        cell.col,
        encodeCellValueForRouteSignature(cell.value),
        cell.backgroundColor ?? null,
      ]),
  ]);
}
