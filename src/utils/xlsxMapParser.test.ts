import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  type DayMapData,
} from "../types/map";
import {
  findZeroBlockMapSheets,
  parseMapFile,
} from "../xlsx/engine/mapWorkbookEngine";

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

const toArrayBuffer = async (
  workbook: ExcelJS.Workbook,
): Promise<ArrayBuffer> => {
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
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

  it("uses the transferred workbook buffer without rereading the File", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("1日目").getCell("A1").value = "ブロックなし";
    const input = await toArrayBuffer(workbook);
    const file = {
      arrayBuffer: async () => {
        throw new Error("The transferred workbook was read twice.");
      },
    } as unknown as File;

    const result = await parseMapFile(
      file,
      DEFAULT_BLOCK_DETECTION_SETTINGS,
      input,
    );

    expect(result.data).toBeNull();
    expect(result.error).toContain("有効なブロックが0件");
  });

  it("preserves colored-border expansion, relaxed ranges, deduplication, and ordering", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("1日目");
    const red = {
      style: "medium" as const,
      color: { argb: "FFFF0000" },
    };
    const blue = {
      style: "medium" as const,
      color: { argb: "FF0000FF" },
    };

    sheet.getCell("A1").value = "A";
    sheet.getCell("A1").border = { top: red, bottom: red, left: red };
    sheet.getCell("B1").value = 1;
    sheet.getCell("B1").border = { top: red, right: red, bottom: red };
    sheet.getCell("C1").value = 4;
    sheet.getCell("C1").border = { left: red };
    sheet.getCell("D1").value = -1;
    sheet.getCell("D1").border = { top: red };
    sheet.getCell("E1").value = 2;
    sheet.getCell("E1").border = { top: blue };
    sheet.getCell("G1").value = "B";
    sheet.getCell("G1").border = {
      top: blue,
      bottom: blue,
      left: blue,
    };
    sheet.getCell("H1").value = 2;
    sheet.getCell("H1").border = {
      top: blue,
      right: blue,
      bottom: blue,
    };

    const result = await parseMapFile(await toFileLike(workbook), {
      ...DEFAULT_BLOCK_DETECTION_SETTINGS,
      numberCellMax: 3,
    });

    expect(result.error).toBeNull();
    const blocks = result.data?.["1日目マップ"].blocks;
    expect(blocks?.map(({ name }) => name)).toEqual(["A", "B"]);
    expect(blocks?.[0].numberCells).toEqual([
      { row: 26, col: 27, value: 1 },
      { row: 26, col: 28, value: 4 },
    ]);
    expect(blocks?.[1].numberCells).toEqual([
      { row: 26, col: 33, value: 2 },
      { row: 26, col: 30, value: 2 },
    ]);
  });
});
