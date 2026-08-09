import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../../types/map";
import type { EventWorkbookExportSnapshot } from "../domain/eventWorkbook";
import type { XlsxImportResult } from "../domain/types";
import semanticGoldenSource from "../fixtures/event-workbook-semantic-golden.v1.json";
import { xlsxWorkerExecutor } from "./workerExecutor";

type JsonRecord = Record<string, unknown>;

type EventWorkbookSemanticGolden = Readonly<{
  schemaVersion: 1;
  fixtureId: "event-workbook-worker-roundtrip-v1";
  goldenVersion: 1;
  payloadSha256: string;
  input: EventWorkbookExportSnapshot;
  expectedImport: Extract<XlsxImportResult, { kind: "event-import" }>;
}>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys: (
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
) => asserts value is JsonRecord = (value, expectedKeys, path) => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  expect(Object.keys(value).sort(), `${path} keys`).toEqual(
    [...expectedKeys].sort(),
  );
};

const assertStringArrayRecord = (value: unknown, path: string): void => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const [key, entries] of Object.entries(value)) {
    expect(key.length, `${path} key`).toBeGreaterThan(0);
    expect(entries, `${path}.${key}`).toSatisfy(
      (candidate: unknown) =>
        Array.isArray(candidate) &&
        candidate.every((entry) => typeof entry === "string"),
    );
  }
};

const ITEM_REQUIRED_KEYS = [
  "id",
  "circle",
  "eventDate",
  "block",
  "number",
  "title",
  "price",
  "purchaseStatus",
  "quantity",
  "remarks",
] as const;

const ITEM_OPTIONAL_KEYS = [
  "catalogPrice",
  "limitedPurchasedQuantity",
  "sheetRemarks",
  "url",
  "priorityLevel",
  "protectionLevel",
  "source",
  "manualHallId",
] as const;

const assertClosedItems = (value: unknown, path: string): void => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  expect(value.length, path).toBeGreaterThan(0);
  value.forEach((candidate, index) => {
    if (!isRecord(candidate))
      throw new Error(`${path}[${index}] must be an object`);
    const keys = Object.keys(candidate);
    expect(keys, `${path}[${index}] unknown keys`).toEqual(
      expect.arrayContaining([...ITEM_REQUIRED_KEYS]),
    );
    expect(
      keys.every((key) =>
        [...ITEM_REQUIRED_KEYS, ...ITEM_OPTIONAL_KEYS].includes(
          key as (typeof ITEM_REQUIRED_KEYS)[number],
        ),
      ),
      `${path}[${index}] contains an unknown key`,
    ).toBe(true);
  });
};

const assertSemanticGolden: (
  value: unknown,
) => asserts value is EventWorkbookSemanticGolden = (value) => {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "fixtureId",
      "goldenVersion",
      "payloadSha256",
      "input",
      "expectedImport",
    ],
    "golden",
  );
  expect(value.schemaVersion).toBe(1);
  expect(value.fixtureId).toBe("event-workbook-worker-roundtrip-v1");
  expect(value.goldenVersion).toBe(1);
  expect(value.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

  assertExactKeys(
    value.input,
    ["schemaVersion", "eventName", "items", "options", "additionalData"],
    "golden.input",
  );
  expect(value.input.schemaVersion).toBe(1);
  expect(typeof value.input.eventName).toBe("string");
  assertClosedItems(value.input.items, "golden.input.items");
  assertExactKeys(
    value.input.options,
    [
      "includeItems",
      "includeLayoutInfo",
      "includeMapData",
      "includeRouteInfo",
      "format",
    ],
    "golden.input.options",
  );
  assertExactKeys(
    value.input.additionalData,
    ["metadata", "executeModeItems", "dayModes"],
    "golden.input.additionalData",
  );
  assertExactKeys(
    value.input.additionalData.metadata,
    ["spreadsheetUrl", "spreadsheetSheetName", "lastImportDate"],
    "golden.input.additionalData.metadata",
  );
  if (!isRecord(value.input.additionalData.executeModeItems)) {
    throw new Error(
      "golden.input.additionalData.executeModeItems must be an object",
    );
  }
  for (const [eventName, days] of Object.entries(
    value.input.additionalData.executeModeItems,
  )) {
    assertStringArrayRecord(
      days,
      `golden.input.additionalData.executeModeItems.${eventName}`,
    );
  }
  if (!isRecord(value.input.additionalData.dayModes)) {
    throw new Error("golden.input.additionalData.dayModes must be an object");
  }
  for (const [eventName, days] of Object.entries(
    value.input.additionalData.dayModes,
  )) {
    if (!isRecord(days)) {
      throw new Error(
        `golden.input.additionalData.dayModes.${eventName} must be an object`,
      );
    }
    expect(Object.values(days).every((mode) => typeof mode === "string")).toBe(
      true,
    );
  }

  assertExactKeys(
    value.expectedImport,
    ["kind", "value"],
    "golden.expectedImport",
  );
  expect(value.expectedImport.kind).toBe("event-import");
  assertExactKeys(
    value.expectedImport.value,
    ["success", "eventName", "items", "metadata", "layoutInfo", "errors"],
    "golden.expectedImport.value",
  );
  assertClosedItems(
    value.expectedImport.value.items,
    "golden.expectedImport.value.items",
  );
  assertExactKeys(
    value.expectedImport.value.metadata,
    ["spreadsheetUrl", "spreadsheetSheetName", "lastImportDate"],
    "golden.expectedImport.value.metadata",
  );
  assertExactKeys(
    value.expectedImport.value.layoutInfo,
    ["executeModeItems", "dayModes"],
    "golden.expectedImport.value.layoutInfo",
  );
  assertStringArrayRecord(
    value.expectedImport.value.layoutInfo.executeModeItems,
    "golden.expectedImport.value.layoutInfo.executeModeItems",
  );
  if (!isRecord(value.expectedImport.value.layoutInfo.dayModes)) {
    throw new Error(
      "golden.expectedImport.value.layoutInfo.dayModes must be an object",
    );
  }
  expect(
    Object.values(value.expectedImport.value.layoutInfo.dayModes).every(
      (mode) => typeof mode === "string",
    ),
  ).toBe(true);
  expect(value.expectedImport.value.errors).toEqual([]);
};

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const semanticGoldenPayload = (
  golden: EventWorkbookSemanticGolden,
): unknown => ({
  schemaVersion: golden.schemaVersion,
  fixtureId: golden.fixtureId,
  goldenVersion: golden.goldenVersion,
  input: golden.input,
  expectedImport: golden.expectedImport,
});

const semanticGolden = semanticGoldenSource as unknown;

describe("bound XLSX Worker engine", () => {
  it("keeps the committed semantic golden closed and digest-bound", () => {
    assertSemanticGolden(semanticGolden);
    const digest = createHash("sha256")
      .update(canonicalize(semanticGoldenPayload(semanticGolden)), "utf8")
      .digest("hex");
    expect(digest).toBe(semanticGolden.payloadSha256);

    const withUnknownTopLevel = structuredClone(semanticGolden) as JsonRecord;
    withUnknownTopLevel.unknown = true;
    expect(() => assertSemanticGolden(withUnknownTopLevel)).toThrow();

    const withUnknownItem = structuredClone(semanticGolden) as unknown as {
      input: { items: JsonRecord[] };
    };
    withUnknownItem.input.items[0].unknown = true;
    expect(() => assertSemanticGolden(withUnknownItem)).toThrow();
  });

  it("matches the committed semantic golden after Worker export and import preflight", async () => {
    assertSemanticGolden(semanticGolden);
    const progress: string[] = [];
    const exportController = new AbortController();
    const bytes = await xlsxWorkerExecutor.exportWorkbook(
      semanticGolden.input,
      exportController.signal,
      ({ phase }) => progress.push(phase),
    );

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(progress).toContain("serialize");
    expect(progress).toContain("preflight");
    expect(progress).toContain("digest");

    const input = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const result = await xlsxWorkerExecutor.importWorkbook(
      {
        kind: "event-import",
        input,
        fileName: "固定ゴールデン即売会_2026-08-08T1230_full.xlsx",
      },
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toEqual(semanticGolden.expectedImport);
  });

  it.each(["map-preview", "map-import"] as const)(
    "binds the %s engine after ZIP/XML preflight",
    async (kind) => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("案内").getCell("A1").value = "対象外";
      workbook.addWorksheet("1日目").getCell("A1").value = "ブロックなし";
      const output = await workbook.xlsx.writeBuffer();
      const bytes = new Uint8Array(output);
      const input = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;

      const result = await xlsxWorkerExecutor.importWorkbook(
        {
          kind,
          input,
          fileName: "map.xlsx",
          settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
        },
        new AbortController().signal,
        () => undefined,
      );

      expect(result.kind).toBe(kind);
      if (result.kind === "event-import") {
        throw new Error("Map Worker returned an event result.");
      }
      expect(result.value.error).toContain("有効なブロックが0件");
      expect(result.value.error).not.toContain("ENGINE_NOT_BOUND");
    },
  );

  it.each([
    {
      name: "invalid ZIP",
      input: new Uint8Array([1, 2, 3, 4]).buffer,
      code: "SECURITY_REJECTED",
    },
    {
      name: "compressed-byte overflow",
      input: new ArrayBuffer(33_554_433),
      code: "RESOURCE_LIMIT",
    },
  ] as const)(
    "rejects $name before ExcelJS parsing",
    async ({ input, code }) => {
      await expect(
        xlsxWorkerExecutor.importWorkbook(
          {
            kind: "map-preview",
            input,
            fileName: "invalid-map.xlsx",
            settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
          },
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it("honors cancellation before engine state can become a result", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      xlsxWorkerExecutor.importWorkbook(
        {
          kind: "event-import",
          input: new ArrayBuffer(1),
          fileName: "aborted-event.xlsx",
        },
        controller.signal,
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
});
