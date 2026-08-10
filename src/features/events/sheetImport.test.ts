import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGoogleSheetCsv, parseEventItemsFromCsv } from "./sheetImport";

function csvRow(
  quantity: string,
  url = "https://example.com",
  number = "01a",
): string {
  const cells = Array.from({ length: 27 }, () => "");
  cells[12] = "サークルA";
  cells[13] = "1日目";
  cells[14] = "東A";
  cells[15] = number;
  cells[16] = "新刊";
  cells[17] = "1,200円";
  cells[22] = "シート備考";
  cells[24] = url;
  cells[26] = quantity;
  return cells
    .map((cell) => (cell.includes(",") ? `"${cell}"` : cell))
    .join(",");
}

describe("parseEventItemsFromCsv quantity", () => {
  it("空欄・不正値・正常値を丸めずに差分処理へ渡す", () => {
    const header = Array.from({ length: 27 }, (_, index) => `列${index}`).join(
      ",",
    );
    const parsed = parseEventItemsFromCsv(
      [header, csvRow(""), csvRow("21"), csvRow("5")].join("\n"),
    );

    expect(parsed.map((item) => item.rawQuantity)).toEqual(["", "21", "5"]);
    expect(parsed.every((item) => item.quantity === 1)).toBe(true);
    expect(parsed[0]).toMatchObject({
      price: 1200,
      catalogPrice: 1200,
      remarks: "シート備考",
      sheetRemarks: "シート備考",
      url: "https://example.com",
    });
  });

  it("Y列は妥当なHTTP(S) URLだけを取り込む", () => {
    const header = Array.from({ length: 27 }, (_, index) => `列${index}`).join(
      ",",
    );
    const parsed = parseEventItemsFromCsv(
      [
        header,
        csvRow("1", "https://example.com/item", "01a"),
        csvRow("1", "備考の文字列", "02a"),
        csvRow("1", "javascript:alert(1)", "03a"),
      ].join("\n"),
    );

    expect(parsed[0].url).toBe("https://example.com/item");
    expect(parsed[1].url).toBeUndefined();
    expect(parsed[2].url).toBeUndefined();
  });
});

describe("fetchGoogleSheetCsv", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses only the purpose-fixed same-origin CSV gateway", async () => {
    const fetchMock = vi.fn(async () => new Response("csv-body"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchGoogleSheetCsv(
        "https://docs.google.com/spreadsheets/d/abcdefghij123456/edit",
        "品目表",
      ),
    ).resolves.toBe("csv-body");
    expect(fetchMock).toHaveBeenCalledWith("/api/google-sheets-csv", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "text/csv",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        spreadsheetId: "abcdefghij123456",
        sheetName: "品目表",
      }),
    });
  });
});
