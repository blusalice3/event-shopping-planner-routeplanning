import { describe, expect, it } from "vitest";
import {
  SPREADSHEET_PASTE_COLUMN_GUIDE,
  SPREADSHEET_PASTE_COLUMN_LABELS,
  normalizeImportedUrl,
  parseSpreadsheetPaste,
} from "./pasteColumns";

describe("parseSpreadsheetPaste", () => {
  it("7列目を備考として取り込み、URL列を生成しない", () => {
    const result = parseSpreadsheetPaste(
      "サークルA\t1日目\t東A\t01a\t新刊\t1000\thttps://example.com は備考",
    );

    expect(result).toEqual({
      ok: true,
      columns: {
        circles: "サークルA",
        eventDates: "1日目",
        blocks: "東A",
        numbers: "01a",
        titles: "新刊",
        prices: "1000",
        remarks: "https://example.com は備考",
      },
    });
    if (result.ok) {
      expect("urls" in result.columns).toBe(false);
    }
  });

  it("6列または8列の行があれば部分結果を返さず原子的に拒否する", () => {
    const result = parseSpreadsheetPaste(
      [
        "正常\t1日目\t東A\t01a\t新刊\t1000\t備考",
        "不足\t1日目\t東A\t02a\t既刊\t500",
        "超過\t2日目\t西B\t03b\t新刊\t800\t備考\t余分",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: false,
      invalidRows: [
        { lineNumber: 2, actualColumnCount: 6, problem: "不足" },
        { lineNumber: 3, actualColumnCount: 8, problem: "超過" },
      ],
    });
    expect("columns" in result).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("2行目（6列・不足）");
      expect(result.message).toContain("3行目（8列・超過）");
      expect(result.message).toContain("7列");
    }
  });

  it("複数行の空セルを保持して列ごとの改行データへ変換する", () => {
    const result = parseSpreadsheetPaste(
      [
        "サークルA\t1日目\t東A\t01a\t\t1000\t取り置き",
        "サークルB\t2日目\t西B\t02b\t既刊\t\t",
      ].join("\n"),
    );

    expect(result).toEqual({
      ok: true,
      columns: {
        circles: "サークルA\nサークルB",
        eventDates: "1日目\n2日目",
        blocks: "東A\n西B",
        numbers: "01a\n02b",
        titles: "\n既刊",
        prices: "1000\n",
        remarks: "取り置き\n",
      },
    });
  });

  it("CRLFと末尾改行を余分な行として扱わない", () => {
    const result = parseSpreadsheetPaste(
      "サークルA\t1日目\t東A\t01a\t新刊\t1000\t備考\r\n" +
        "サークルB\t2日目\t西B\t02b\t既刊\t500\t\r\n",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.columns.circles).toBe("サークルA\nサークルB");
      expect(result.columns.remarks).toBe("備考\n");
    }
  });

  it("画面用の列表示を解析と同じ定義から提供する", () => {
    expect(SPREADSHEET_PASTE_COLUMN_GUIDE).toBe(
      "M列 サークル名 / N列 参加日 / O列 ブロック / P列 番号 / Q列 タイトル / R列 価格 / W列 備考",
    );
    expect(SPREADSHEET_PASTE_COLUMN_LABELS.remarks).toBe("W列 備考");
  });

  it("URL列はHTTP(S)の妥当なURLだけを採用する", () => {
    expect(normalizeImportedUrl(" https://example.com/item?id=1 ")).toBe(
      "https://example.com/item?id=1",
    );
    expect(normalizeImportedUrl("http://example.com")).toBe(
      "http://example.com",
    );
    expect(normalizeImportedUrl("備考です")).toBeUndefined();
    expect(normalizeImportedUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeImportedUrl("")).toBeUndefined();
  });
});
