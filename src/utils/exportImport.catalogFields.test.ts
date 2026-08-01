import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../types/item";
import { exportToXlsx, importFromXlsx } from "./exportImport";

const legacyHeaders = [
  "ID",
  "サークル名",
  "参加日",
  "ブロック",
  "ナンバー",
  "タイトル",
  "価格",
  "数量",
  "ステータス",
  "備考",
  "URL",
  "優先度",
  "保護レベル",
  "追加元",
  "手動ホール",
  "限数実購入数",
];

const currentHeaders = [...legacyHeaders, "カタログ価格", "シート備考"];

const item = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `サークル-${id}`,
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: `タイトル-${id}`,
  price: 900,
  quantity: 1,
  purchaseStatus: "None",
  remarks: `アプリ備考-${id}`,
  ...overrides,
});

const rowValues = ({
  id,
  source = "spreadsheet",
  price = 900,
  remarks = `アプリ備考-${id}`,
  status = "None",
  quantity = 1,
  limited = null,
  catalogPrice = null,
  sheetRemarks = "",
}: {
  id: string;
  source?: string;
  price?: ExcelJS.CellValue;
  remarks?: ExcelJS.CellValue;
  status?: string;
  quantity?: ExcelJS.CellValue;
  limited?: ExcelJS.CellValue;
  catalogPrice?: ExcelJS.CellValue;
  sheetRemarks?: ExcelJS.CellValue;
}): ExcelJS.CellValue[] => [
  id,
  `サークル-${id}`,
  "1日目",
  "東A",
  "01a",
  `タイトル-${id}`,
  price,
  quantity,
  status,
  remarks,
  "",
  "",
  "",
  source,
  "",
  limited,
  catalogPrice,
  sheetRemarks,
];

const workbookFile = async (
  workbook: ExcelJS.Workbook,
  name = "catalog-fields.xlsx",
): Promise<File> => {
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
};

const importRows = async ({
  headers,
  rows,
  version,
}: {
  headers: string[];
  rows: ExcelJS.CellValue[][];
  version?: string;
}) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("アイテムデータ");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row.slice(0, headers.length)));

  if (version) {
    const metaSheet = workbook.addWorksheet("メタデータ");
    metaSheet.addRow(["キー", "値"]);
    metaSheet.addRow(["version", version]);
    metaSheet.addRow(["eventName", "取込イベント"]);
  }

  return importFromXlsx(await workbookFile(workbook));
};

describe("event XLSX catalog fields", () => {
  it("exports version 2.2 with the two new columns at the end", async () => {
    const blob = await exportToXlsx(
      "形式確認",
      [item("format", { source: "spreadsheet" })],
      {
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: false,
        includeRouteInfo: false,
        format: "full",
      },
      {},
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await blob.arrayBuffer());
    const itemsSheet = workbook.getWorksheet("アイテムデータ");
    const metaSheet = workbook.getWorksheet("メタデータ");

    expect(itemsSheet?.getCell(1, 17).value).toBe("カタログ価格");
    expect(itemsSheet?.getCell(1, 18).value).toBe("シート備考");
    expect(metaSheet?.getCell(2, 1).value).toBe("version");
    expect(metaSheet?.getCell(2, 2).value).toBe("2.2");
  });

  it.each(["simple", "full"] as const)(
    "round-trips distinct sheet fields in the %s export",
    async (format) => {
      const items = [
        item("distinct", {
          source: "spreadsheet",
          price: 900,
          catalogPrice: 1200,
          remarks: "利用者メモ",
          sheetRemarks: "シートの原文",
        }),
        item("zero", {
          source: "spreadsheet",
          price: 500,
          catalogPrice: 0,
          remarks: "現在の備考",
          sheetRemarks: "",
        }),
        item("null", {
          source: "spreadsheet",
          catalogPrice: null,
          sheetRemarks: "",
        }),
        item("spreadsheet-fallback", {
          source: "spreadsheet",
          catalogPrice: undefined,
          sheetRemarks: undefined,
        }),
        item("app", {
          source: "app",
          catalogPrice: undefined,
          sheetRemarks: undefined,
        }),
        item("unknown", {
          source: undefined,
          catalogPrice: undefined,
          sheetRemarks: undefined,
        }),
      ];
      const blob = await exportToXlsx(
        "往復イベント",
        items,
        {
          includeItems: true,
          includeLayoutInfo: false,
          includeMapData: false,
          includeRouteInfo: false,
          format,
        },
        {},
      );
      const file = new File([await blob.arrayBuffer()], `${format}.xlsx`);

      const result = await importFromXlsx(file);

      expect(result.success).toBe(true);
      expect(result.items.find(({ id }) => id === "distinct")).toMatchObject({
        price: 900,
        catalogPrice: 1200,
        remarks: "利用者メモ",
        sheetRemarks: "シートの原文",
      });
      expect(result.items.find(({ id }) => id === "zero")).toMatchObject({
        catalogPrice: 0,
        sheetRemarks: "",
      });
      expect(result.items.find(({ id }) => id === "null")).toMatchObject({
        catalogPrice: null,
        sheetRemarks: "",
      });
      expect(
        result.items.find(({ id }) => id === "spreadsheet-fallback"),
      ).toMatchObject({
        catalogPrice: 900,
        sheetRemarks: "アプリ備考-spreadsheet-fallback",
      });
      for (const id of ["app", "unknown"]) {
        const imported = result.items.find((candidate) => candidate.id === id);
        expect(imported?.catalogPrice).toBeUndefined();
        expect(imported?.sheetRemarks).toBeUndefined();
      }
      expect(result.legacySheetFieldFallbacks).toBeUndefined();
    },
  );

  it("detects the two new columns by header name", async () => {
    const result = await importRows({
      headers: [...legacyHeaders, "シート備考", "カタログ価格"],
      rows: [
        rowValues({
          id: "swapped",
          catalogPrice: "シート原文",
          sheetRemarks: 1234,
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({
      catalogPrice: 1234,
      sheetRemarks: "シート原文",
    });
  });

  it("does not use current values as fallback when new headers are present", async () => {
    const result = await importRows({
      headers: currentHeaders,
      rows: [
        rowValues({
          id: "explicit-empty",
          price: 1500,
          remarks: "現在の備考",
          catalogPrice: null,
          sheetRemarks: null,
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({
      price: 1500,
      catalogPrice: null,
      remarks: "現在の備考",
      sheetRemarks: "",
    });
    expect(result.legacySheetFieldFallbacks).toBeUndefined();
  });

  it.each([15, 16])(
    "migrates only spreadsheet rows from a legacy %s-column file",
    async (columnCount) => {
      const spreadsheetRow = rowValues({
        id: `spreadsheet-${columnCount}`,
        price: 700,
        remarks: "旧シート備考",
        status: columnCount === 16 ? "LimitedPurchase" : "None",
        quantity: columnCount === 16 ? 3 : 1,
        limited: columnCount === 16 ? 1 : null,
      });
      const result = await importRows({
        headers: legacyHeaders.slice(0, columnCount),
        rows: [
          spreadsheetRow,
          rowValues({ id: `app-${columnCount}`, source: "app" }),
          rowValues({ id: `unknown-${columnCount}`, source: "" }),
        ],
      });

      expect(result.success).toBe(true);
      expect(result.items[0]).toMatchObject({
        catalogPrice: 700,
        sheetRemarks: "旧シート備考",
      });
      if (columnCount === 16) {
        expect(result.items[0].limitedPurchasedQuantity).toBe(1);
        expect(result.items[0].catalogPrice).toBe(700);
      }
      expect(result.items[1].catalogPrice).toBeUndefined();
      expect(result.items[1].sheetRemarks).toBeUndefined();
      expect(result.items[2].catalogPrice).toBeUndefined();
      expect(result.items[2].sheetRemarks).toBeUndefined();
      expect(result.legacySheetFieldFallbacks).toEqual([
        {
          itemId: `spreadsheet-${columnCount}`,
          rowNumber: 2,
        },
      ]);
      expect(result.itemFallbackWarnings).toBeUndefined();
    },
  );

  it("rejects a file that has only one of the new columns", async () => {
    const result = await importRows({
      headers: [...legacyHeaders, "カタログ価格"],
      rows: [rowValues({ id: "broken" })],
    });

    expect(result.success).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "「カタログ価格」と「シート備考」は両方の列が必要",
    );
  });

  it("rejects a full 2.2 file when both new headers are missing", async () => {
    const result = await importRows({
      headers: legacyHeaders,
      rows: [rowValues({ id: "broken-full" })],
      version: "2.2",
    });

    expect(result.success).toBe(false);
    expect(result.errors.join("\n")).toContain("バージョン2.2の完全版");
  });

  it("accepts a full 2.1 file as a legacy format", async () => {
    const result = await importRows({
      headers: legacyHeaders,
      rows: [rowValues({ id: "legacy-full" })],
      version: "2.1",
    });

    expect(result.success).toBe(true);
    expect(result.items[0]).toMatchObject({
      catalogPrice: 900,
      sheetRemarks: "アプリ備考-legacy-full",
    });
  });

  it("validates catalog price cell types without losing zero", async () => {
    const result = await importRows({
      headers: currentHeaders,
      rows: [
        rowValues({ id: "zero", catalogPrice: 0 }),
        rowValues({
          id: "formula-result",
          catalogPrice: { formula: "500+500", result: 1000 },
        }),
        rowValues({ id: "invalid", catalogPrice: "千円" }),
        rowValues({
          id: "formula-missing",
          catalogPrice: { formula: "500+500" },
        }),
        rowValues({
          id: "rich-text",
          catalogPrice: { richText: [{ text: "1000" }] },
        }),
      ],
    });

    expect(result.success).toBe(true);
    expect(result.items.find(({ id }) => id === "zero")?.catalogPrice).toBe(0);
    expect(
      result.items.find(({ id }) => id === "formula-result")?.catalogPrice,
    ).toBe(1000);
    for (const id of ["invalid", "formula-missing", "rich-text"]) {
      expect(
        result.items.find((candidate) => candidate.id === id)?.catalogPrice,
      ).toBeNull();
    }
    expect(result.itemFallbackWarnings?.map(({ itemId }) => itemId)).toEqual([
      "invalid",
      "formula-missing",
      "rich-text",
    ]);
    expect(
      result.itemFallbackWarnings?.find(
        ({ itemId }) => itemId === "formula-missing",
      )?.reasons[0],
    ).toContain("数式結果なし");
    expect(
      result.itemFallbackWarnings?.find(({ itemId }) => itemId === "rich-text")
        ?.reasons[0],
    ).toContain("非対応セル形式");
  });
});
