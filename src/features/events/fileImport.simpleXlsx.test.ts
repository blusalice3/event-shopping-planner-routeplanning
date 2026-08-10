import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../types/item";
import { createAppBackup, parseAppBackup } from "../../utils/appBackup";
import {
  exportToXlsx,
  importFromXlsx,
} from "../../xlsx/engine/eventWorkbookEngine";
import { buildXlsxEventRestoreSource, toImportedEventData } from "./fileImport";

const EVENT_NAME = "簡易復元イベント";
const OPTIONAL_ITEM_FIELDS = [
  "manualHallId",
  "priorityLevel",
  "protectionLevel",
  "source",
] as const;

const item: ShoppingItem = {
  id: "item-1",
  circle: "サークル",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

describe("XLSX event restore", () => {
  it("round-trips omitted item fields into a valid restore backup", async () => {
    const blob = await exportToXlsx(
      EVENT_NAME,
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
    const file = new File(
      [await blob.arrayBuffer()],
      `${EVENT_NAME}_2026-08-02T1230_simple.xlsx`,
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );

    const result = await importFromXlsx(file);

    expect(result.success).toBe(true);
    expect(result.eventName).toBe(EVENT_NAME);
    for (const field of OPTIONAL_ITEM_FIELDS) {
      expect(result.items[0]).not.toHaveProperty(field);
    }

    const importedData = toImportedEventData(result);
    const restoreSource = buildXlsxEventRestoreSource(importedData);
    const validation = parseAppBackup(
      createAppBackup(
        restoreSource.data,
        new Date("2026-08-02T00:00:00.000Z"),
        {
          blockDetectionSettings: restoreSource.blockDetectionSettings,
        },
      ),
    );

    expect(validation.ok).toBe(true);
  });

  it("round-trips full map cells without an optional merge parent", async () => {
    const blob = await exportToXlsx(
      EVENT_NAME,
      [item],
      {
        includeItems: true,
        includeLayoutInfo: false,
        includeMapData: true,
        includeRouteInfo: false,
        format: "full",
      },
      {
        mapData: {
          [EVENT_NAME]: {
            "1日目マップ": {
              maxRow: 1,
              maxCol: 1,
              cells: [
                {
                  row: 1,
                  col: 1,
                  value: "A",
                  backgroundColor: null,
                  fontColor: null,
                  borders: {
                    top: null,
                    right: null,
                    bottom: null,
                    left: null,
                  },
                  isMerged: false,
                  isVerticalText: false,
                },
              ],
              mergedCells: [],
              blocks: [],
            },
          },
        },
      },
    );
    const file = new File([await blob.arrayBuffer()], "full-map.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const result = await importFromXlsx(file);
    const importedData = toImportedEventData(result);
    const importedCell = importedData.mapData?.["1日目マップ"].cells[0] ?? null;
    const restoreSource = buildXlsxEventRestoreSource(importedData);
    const validation = parseAppBackup(
      createAppBackup(
        restoreSource.data,
        new Date("2026-08-02T00:00:00.000Z"),
        {
          blockDetectionSettings: restoreSource.blockDetectionSettings,
        },
      ),
    );

    expect(result.success).toBe(true);
    expect(importedCell).not.toHaveProperty("mergeParent");
    expect(validation.ok).toBe(true);
  });
});
