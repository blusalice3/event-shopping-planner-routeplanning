import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../types/item";
import { createAppBackup, parseAppBackup } from "../../utils/appBackup";
import { exportToXlsx, importFromXlsx } from "../../utils/exportImport";
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

describe("simple XLSX event restore", () => {
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
});
