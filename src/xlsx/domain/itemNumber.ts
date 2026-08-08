import type { ShoppingItem } from "../../types/item";
import {
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  type BlockDefinition,
  type BlockDetectionSettings,
  type CellData,
  type DayMapData,
  type NumberCellInfo,
} from "../../types/map";

/**
 * アイテム番号の先頭にある数値部分を返す。
 * 例: "26a" -> "26", "26b1" -> "26"
 */
export const extractNumberFromItemNumber = (
  itemNumber: string,
): string | null => {
  const match = itemNumber.match(/^(\d+)/);
  return match ? match[1] : null;
};

/**
 * アイテム番号の「数字+アルファベット」部分を返し、末尾数字は無視する。
 */
export const extractNumberAlphaPrefix = (itemNumber: string): string | null => {
  const match = itemNumber.match(/^(\d+[a-zA-Z]+)/);
  return match ? match[1].toLowerCase() : null;
};

export const matchItemToCell = (
  item: ShoppingItem,
  mapData: DayMapData,
  dayName: string,
): { row: number; col: number } | null => {
  if (item.eventDate !== dayName) return null;

  const itemBlockName = item.block?.trim() || "";
  let block = mapData.blocks.find(
    (candidate) => candidate.name === itemBlockName,
  );
  if (!block) {
    const candidates = mapData.blocks.filter(
      (candidate) =>
        candidate.name.toLowerCase() === itemBlockName.toLowerCase(),
    );
    if (candidates.length === 1) block = candidates[0];
  }
  if (!block) return null;

  const number = extractNumberFromItemNumber(item.number);
  if (!number) return null;
  const numberCell = block.numberCells.find(
    (cell) => cell.value === Number.parseInt(number, 10),
  );
  return numberCell ? { row: numberCell.row, col: numberCell.col } : null;
};

export const createBlockDefinition = (
  name: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  cellsMap: Map<string, CellData>,
  settings: BlockDetectionSettings = DEFAULT_BLOCK_DETECTION_SETTINGS,
): BlockDefinition => {
  const numberCells: NumberCellInfo[] = [];
  const nameCells: { row: number; col: number }[] = [];

  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startCol; column <= endCol; column += 1) {
      const cell = cellsMap.get(`${row}-${column}`);
      if (!cell || cell.value === null) continue;

      if (String(cell.value).trim() === name) {
        nameCells.push({ row, col: column });
      }
      if (cell.isMerged) continue;

      const numericValue =
        typeof cell.value === "number"
          ? cell.value
          : Number(String(cell.value).trim());
      if (
        Number.isInteger(numericValue) &&
        numericValue >= settings.numberCellMin &&
        numericValue <= settings.numberCellMax
      ) {
        numberCells.push({ row, col: column, value: numericValue });
      }
    }
  }

  const definition: BlockDefinition = {
    name,
    startRow,
    startCol,
    endRow,
    endCol,
    numberCells: numberCells.sort((left, right) => left.value - right.value),
    color: "#E3F2FD",
  };
  if (nameCells.length > 0) definition.nameCells = nameCells;
  return definition;
};
