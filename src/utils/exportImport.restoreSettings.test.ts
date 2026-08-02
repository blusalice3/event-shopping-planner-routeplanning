import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../types/item";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../types/map";
import { exportToXlsx, importFromXlsx } from "./exportImport";

const EVENT_NAME = "設定復元イベント";

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

const exportOptions = {
  includeItems: true,
  includeLayoutInfo: false,
  includeMapData: true,
  includeRouteInfo: false,
  format: "full" as const,
};

const asFile = async (blob: Blob, filename = "settings.xlsx"): Promise<File> =>
  new File([await blob.arrayBuffer()], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });

describe("event XLSX restore settings", () => {
  it("round-trips rotation, viewport, and block-detection settings", async () => {
    const mapRotationSettings = {
      "1日目マップ": {
        initialAngle: 0,
        mapTabAngle: 90,
        focusModeAngle: 180,
      },
    };
    const mapViewportSettings = {
      "1日目マップ": {
        zoomLevel: 125,
        offsetX: 10,
        offsetY: -20,
      },
    };
    const blob = await exportToXlsx(EVENT_NAME, [item], exportOptions, {
      mapRotationSettings: {
        [EVENT_NAME]: mapRotationSettings,
      },
      mapViewportSettings: {
        [EVENT_NAME]: mapViewportSettings,
      },
      blockDetectionSettings: {
        [EVENT_NAME]: DEFAULT_BLOCK_DETECTION_SETTINGS,
      },
    });

    const result = await importFromXlsx(await asFile(blob));

    expect(result.success).toBe(true);
    expect(result.eventName).toBe(EVENT_NAME);
    expect(result.mapRotationSettings).toEqual(mapRotationSettings);
    expect(result.mapViewportSettings).toEqual(mapViewportSettings);
    expect(result.blockDetectionSettings).toEqual(
      DEFAULT_BLOCK_DETECTION_SETTINGS,
    );
  });

  it("rejects malformed restore settings before any event can be replaced", async () => {
    const blob = await exportToXlsx(EVENT_NAME, [item], exportOptions, {
      blockDetectionSettings: {
        [EVENT_NAME]: DEFAULT_BLOCK_DETECTION_SETTINGS,
      },
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await blob.arrayBuffer());
    const metadata = workbook.getWorksheet("メタデータ");
    metadata?.eachRow((row) => {
      if (row.getCell(1).value === "blockDetectionSettings") {
        row.getCell(2).value = "{broken";
      }
    });
    const brokenFile = new File(
      [await workbook.xlsx.writeBuffer()],
      "broken-settings.xlsx",
    );

    const result = await importFromXlsx(brokenFile);

    expect(result.success).toBe(false);
    expect(result.errors.join("\n")).toContain(
      "ブロック検出設定をJSONとして解析できません",
    );
  });

  it("restores the event name from an app-generated simple XLSX filename", async () => {
    const blob = await exportToXlsx(
      EVENT_NAME,
      [item],
      {
        ...exportOptions,
        includeMapData: false,
        format: "simple",
      },
      {},
    );

    const generatedResult = await importFromXlsx(
      await asFile(blob, `${EVENT_NAME}_2026-08-02T1230_simple.xlsx`),
    );
    const ordinaryResult = await importFromXlsx(
      await asFile(blob, "任意のファイル名.xlsx"),
    );
    const thirdPartyWorkbook = new ExcelJS.Workbook();
    await thirdPartyWorkbook.xlsx.load(await blob.arrayBuffer());
    thirdPartyWorkbook.creator = "Other";
    const thirdPartyResult = await importFromXlsx(
      new File(
        [await thirdPartyWorkbook.xlsx.writeBuffer()],
        `${EVENT_NAME}_2026-08-02T1230_simple.xlsx`,
      ),
    );

    expect(generatedResult.eventName).toBe(EVENT_NAME);
    expect(ordinaryResult.eventName).toBe("任意のファイル名");
    expect(thirdPartyResult.eventName).toBe(
      `${EVENT_NAME}_2026-08-02T1230_simple`,
    );
  });
});
