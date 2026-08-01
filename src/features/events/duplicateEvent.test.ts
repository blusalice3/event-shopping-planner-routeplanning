import { describe, expect, it } from "vitest";
import type { EventMetadata, ShoppingItem } from "../../types/item";
import {
  analyzeDuplicateEventImport,
  buildDifferentSourceResolution,
  compareSpreadsheetSourceIdentities,
  createUniqueAliasEventName,
  excludeExactDuplicateItems,
  extractGoogleSheetsSourceIdentity,
  normalizeSheetName,
  validateAliasEventName,
  type DuplicateEventSource,
  type ImportedShoppingItem,
} from "./duplicateEvent";

const source = (url: string, sheetName = "品目表"): DuplicateEventSource => ({
  url,
  sheetName,
});

const item = (
  overrides: Partial<ImportedShoppingItem> = {},
): ImportedShoppingItem => ({
  circle: "サークルA",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊",
  price: 1000,
  quantity: 1,
  remarks: "メモ",
  ...overrides,
});

const storedItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "stored-1",
  purchaseStatus: "None",
  ...item(),
  ...overrides,
});

const metadata = (
  spreadsheetUrl: string,
  spreadsheetSheetName = "品目表",
): EventMetadata => ({
  spreadsheetUrl,
  spreadsheetSheetName,
  lastImportDate: "2026-01-01T00:00:00.000Z",
});

describe("Google Sheets source identity", () => {
  it("URLの表記揺れに左右されずdocument IDとgidを抽出する", () => {
    const editUrl = extractGoogleSheetsSourceIdentity(
      source(
        "https://docs.google.com/spreadsheets/d/doc-AbC_123/edit?usp=sharing#gid=0042",
      ),
    );
    const viewUrl = extractGoogleSheetsSourceIdentity(
      source("https://docs.google.com/spreadsheets/d/doc-AbC_123/view?gid=42"),
    );

    expect(editUrl).toEqual({
      documentId: "doc-AbC_123",
      normalizedSheetName: "品目表",
      gid: "42",
    });
    expect(viewUrl).toEqual(editUrl);
  });

  it("シート名の全角半角・空白・大文字小文字を正規化する", () => {
    expect(normalizeSheetName("  Ｉｔｅｍｓ　 LIST  ")).toBe("items list");
    expect(normalizeSheetName("ITEMS list")).toBe("items list");
  });

  it("gidが片方だけなら主判定を使い、両方ある場合は補助結果を返す", () => {
    const withoutGid = extractGoogleSheetsSourceIdentity(
      source("https://docs.google.com/spreadsheets/d/doc-id/edit", " Items "),
    );
    const gidOne = extractGoogleSheetsSourceIdentity(
      source(
        "https://docs.google.com/spreadsheets/d/doc-id/edit#gid=1",
        "ITEMS",
      ),
    );
    const gidTwo = extractGoogleSheetsSourceIdentity(
      source(
        "https://docs.google.com/spreadsheets/d/doc-id/edit#gid=2",
        "items",
      ),
    );

    expect(compareSpreadsheetSourceIdentities(withoutGid, gidOne)).toEqual({
      primaryMatch: true,
      gidComparison: "not-comparable",
      isSameSource: true,
    });
    expect(compareSpreadsheetSourceIdentities(gidOne, gidTwo)).toEqual({
      primaryMatch: true,
      gidComparison: "different",
      isSameSource: true,
    });
  });

  it("document IDまたは正規化後のシート名が異なれば別更新元にする", () => {
    const current = extractGoogleSheetsSourceIdentity(
      source("https://docs.google.com/spreadsheets/d/doc-one/edit", "品目表"),
    );
    const otherDocument = extractGoogleSheetsSourceIdentity(
      source("https://docs.google.com/spreadsheets/d/doc-two/edit", "品目表"),
    );
    const otherSheet = extractGoogleSheetsSourceIdentity(
      source("https://docs.google.com/spreadsheets/d/doc-one/edit", "別シート"),
    );

    expect(
      compareSpreadsheetSourceIdentities(current, otherDocument).isSameSource,
    ).toBe(false);
    expect(
      compareSpreadsheetSourceIdentities(current, otherSheet).isSameSource,
    ).toBe(false);
  });
});

describe("analyzeDuplicateEventImport", () => {
  it("同名がなければ通常作成にする", () => {
    const result = analyzeDuplicateEventImport({
      eventName: " 新イベント ",
      incomingItems: [item()],
      incomingSource: source(
        "https://docs.google.com/spreadsheets/d/new-doc/edit",
      ),
      eventLists: {},
      eventMetadata: {},
    });

    expect(result.kind).toBe("create");
    expect(result.eventName).toBe("新イベント");
  });

  it("同名かつ同じ主更新元なら自動更新せず更新導線に分ける", () => {
    const result = analyzeDuplicateEventImport({
      eventName: "既存",
      incomingItems: [item()],
      incomingSource: source(
        "https://docs.google.com/spreadsheets/d/same-doc/view#gid=2",
        " ITEMS ",
      ),
      eventLists: { 既存: [storedItem()] },
      eventMetadata: {
        既存: metadata(
          "https://docs.google.com/spreadsheets/d/same-doc/edit#gid=1",
          "items",
        ),
      },
    });

    expect(result.kind).toBe("same-source");
    expect(result.sourceComparison).toMatchObject({
      primaryMatch: true,
      gidComparison: "different",
      isSameSource: true,
    });
  });

  it("同名でもdocument IDが違えば選択が必要な別更新元にする", () => {
    const result = analyzeDuplicateEventImport({
      eventName: "既存",
      incomingItems: [item()],
      incomingSource: source(
        "https://docs.google.com/spreadsheets/d/new-doc/edit",
      ),
      eventLists: { 既存: [storedItem()] },
      eventMetadata: {
        既存: metadata("https://docs.google.com/spreadsheets/d/old-doc/edit"),
      },
    });

    expect(result.kind).toBe("different-source");
  });
});

describe("exact duplicate filtering and resolutions", () => {
  it("完全一致と取り込み内の重複を除外し、値が違う品目は残す", () => {
    const exact = item();
    const changedRemarks = item({ remarks: "別メモ" });
    const result = excludeExactDuplicateItems(
      [exact, changedRemarks, changedRemarks],
      [storedItem()],
    );

    expect(result.items).toEqual([changedRemarks]);
    expect(result.duplicateItemCount).toBe(2);
  });

  it("利用者が購入金額やメモを変えても同期元が同じなら完全一致として除外する", () => {
    const incoming = item({ price: 1000, remarks: "シート備考" });
    const existing = storedItem({
      price: 700,
      catalogPrice: 1000,
      remarks: "利用者が追記したメモ",
      sheetRemarks: "シート備考",
    });

    const result = excludeExactDuplicateItems([incoming], [existing]);

    expect(result.items).toEqual([]);
    expect(result.duplicateItemCount).toBe(1);
  });

  it("固定品目追加では完全一致を除外し、既存状態を変更する命令を返さない", () => {
    const exact = item();
    const newItem = item({ number: "02a" });
    const analysis = analyzeDuplicateEventImport({
      eventName: "既存",
      incomingItems: [exact, newItem],
      incomingSource: source(
        "https://docs.google.com/spreadsheets/d/new-doc/edit",
      ),
      eventLists: { 既存: [storedItem()] },
      eventMetadata: {
        既存: metadata("https://docs.google.com/spreadsheets/d/old-doc/edit"),
      },
    });
    if (analysis.kind !== "different-source") {
      throw new Error("expected different-source");
    }

    const resolution = buildDifferentSourceResolution(
      analysis,
      "append-fixed-items",
      { existingEventNames: ["既存"] },
    );

    expect(resolution).toEqual({
      action: "append-fixed-items",
      eventName: "既存",
      items: [newItem],
      duplicateItemCount: 1,
      itemSource: "app",
    });
  });

  it("更新元切替は新しいsource metadataと差分確認の指示だけを返す", () => {
    const eventLists = { 既存: [storedItem()] };
    const eventMetadata = {
      既存: metadata("https://docs.google.com/spreadsheets/d/old-doc/edit"),
    };
    const before = JSON.stringify({ eventLists, eventMetadata });
    const analysis = analyzeDuplicateEventImport({
      eventName: "既存",
      incomingItems: [item()],
      incomingSource: source(
        "https://docs.google.com/spreadsheets/d/new-doc/edit#gid=99",
      ),
      eventLists,
      eventMetadata,
    });
    if (analysis.kind !== "different-source") {
      throw new Error("expected different-source");
    }

    const resolution = buildDifferentSourceResolution(
      analysis,
      "switch-source",
      { existingEventNames: ["既存"] },
    );

    expect(resolution).toMatchObject({
      action: "switch-source",
      eventName: "既存",
      source: {
        url: "https://docs.google.com/spreadsheets/d/new-doc/edit#gid=99",
        sheetName: "品目表",
      },
      sourceIdentity: {
        documentId: "new-doc",
        normalizedSheetName: "品目表",
        gid: "99",
      },
      nextStep: "review-update-diff",
    });
    expect(JSON.stringify({ eventLists, eventMetadata })).toBe(before);
  });

  it("別名は既存名を拒否し、使用可能な連番名を作る", () => {
    expect(validateAliasEventName(" 既存 ", ["既存"])).toBe(
      "この名前はすでに使用中です。別の名前を入力してください。",
    );
    expect(
      createUniqueAliasEventName("既存", [
        "既存",
        "既存（別名）",
        "既存（別名2）",
      ]),
    ).toBe("既存（別名3）");
  });
});
