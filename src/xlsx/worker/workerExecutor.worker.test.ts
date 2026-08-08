import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../types/item";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../../types/map";
import { buildEventWorkbookExportSnapshot } from "../domain/eventWorkbook";
import { xlsxWorkerExecutor } from "./workerExecutor";

const item: ShoppingItem = {
  id: "worker-item-1",
  circle: "Workerサークル",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "Worker新刊",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const snapshot = buildEventWorkbookExportSnapshot(
  "Worker往復イベント",
  [item],
  {
    includeItems: true,
    includeLayoutInfo: false,
    includeMapData: false,
    includeRouteInfo: false,
    format: "simple",
  },
  {},
);

describe("bound XLSX Worker engine", () => {
  it("round-trips a semantic event workbook after output and input preflight", async () => {
    const progress: string[] = [];
    const exportController = new AbortController();
    const bytes = await xlsxWorkerExecutor.exportWorkbook(
      snapshot,
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
        fileName: "Worker往復イベント_2026-08-02T1230_simple.xlsx",
      },
      new AbortController().signal,
      () => undefined,
    );

    expect(result).toMatchObject({
      kind: "event-import",
      value: {
        success: true,
        eventName: "Worker往復イベント",
        items: [
          {
            id: item.id,
            circle: item.circle,
            title: item.title,
          },
        ],
      },
    });
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
