import { describe, expect, it, vi } from "vitest";
import { buildBulkAddItems } from "./bulkAdd";

describe("buildBulkAddItems source-owned fields", () => {
  it("スプレッドシート新規品目は同期用と利用者用の初期値を分けて保持する", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "00000000-0000-4000-8000-000000000001",
    );

    const [item] = buildBulkAddItems(
      [
        {
          circle: "サークルA",
          eventDate: "1日目",
          block: "東A",
          number: "01a",
          title: "新刊",
          price: 1200,
          quantity: 2,
          remarks: "シート備考",
        },
      ],
      {
        url: "https://docs.google.com/spreadsheets/d/example/edit",
        sheetName: "品目表",
      },
    );

    expect(item).toMatchObject({
      price: 1200,
      catalogPrice: 1200,
      remarks: "シート備考",
      sheetRemarks: "シート備考",
      source: "spreadsheet",
      protectionLevel: "none",
    });
  });

  it("手入力品目には同期元フィールドを作らない", () => {
    const [item] = buildBulkAddItems(
      [
        {
          circle: "手入力",
          eventDate: "1日目",
          block: "A",
          number: "1",
          title: "",
          price: 500,
          quantity: 1,
          remarks: "利用者メモ",
        },
      ],
      { source: "app" },
    );

    expect(item.catalogPrice).toBeUndefined();
    expect(item.sheetRemarks).toBeUndefined();
    expect(item.source).toBe("app");
  });
});
