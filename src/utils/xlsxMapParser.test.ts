import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { DayMapData } from "../types/map";
import { findZeroBlockMapSheets, parseMapFile } from "./xlsxMapParser";

const createMap = (sheetName: string, blockCount: number): DayMapData => ({
  sheetName,
  maxRow: 1,
  maxCol: 1,
  cells: [],
  mergedCells: [],
  blocks: Array.from({ length: blockCount }, (_, index) => ({
    name: `B${index + 1}`,
    startRow: 1,
    startCol: 1,
    endRow: 1,
    endCol: 1,
    numberCells: [{ row: 1, col: 1, value: index + 1 }],
  })),
});

const toFileLike = async (workbook: ExcelJS.Workbook): Promise<File> => {
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return {
    arrayBuffer: async () => arrayBuffer,
  } as File;
};

describe("findZeroBlockMapSheets", () => {
  it("returns every invalid sheet while leaving normal sheets out", () => {
    const parsed = {
      "1日目マップ": createMap("1日目", 2),
      "2日目マップ": createMap("2日目", 0),
      "3日目マップ": createMap("3日目", 0),
    };

    expect(findZeroBlockMapSheets(parsed)).toEqual(["2日目", "3日目"]);
    expect(parsed["1日目マップ"].blocks).toHaveLength(2);
  });

  it("uses the map key when an older map has no sheetName", () => {
    const map = createMap("", 0);
    delete map.sheetName;

    expect(findZeroBlockMapSheets({ "4日目マップ": map })).toEqual(["4日目"]);
  });
});

describe("parseMapFile zero-block validation", () => {
  it("rejects the whole workbook and names every zero-block day sheet", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("案内").getCell("A1").value = "対象外";
    workbook.addWorksheet("1日目").getCell("A1").value = "案内だけ";
    workbook.addWorksheet("2日目").getCell("A1").value = "ブロックなし";

    const result = await parseMapFile(await toFileLike(workbook));

    expect(result.data).toBeNull();
    expect(result.error).toContain("シート「1日目」");
    expect(result.error).toContain("シート「2日目」");
    expect(result.error).toContain("有効なブロックが0件");
    expect(result.error).not.toContain("案内");
  });
});
