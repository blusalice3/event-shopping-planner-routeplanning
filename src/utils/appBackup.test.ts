import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../types/map";
import type { AppData } from "./indexedDB";
import {
  APP_BACKUP_SECTION_KEYS,
  createAppBackup,
  parseAppBackup,
  serializeAppBackup,
} from "./appBackup";

const makeAppData = (): AppData => ({
  eventLists: {
    テストイベント: [
      {
        id: "item-1",
        circle: "サークルA",
        eventDate: "1日目",
        block: "東A",
        number: "01a",
        title: "新刊",
        price: 1000,
        catalogPrice: 1200,
        purchaseStatus: "None",
        quantity: 1,
        remarks: "ユーザー登録",
        sheetRemarks: "シート備考",
        url: "https://example.com/item-1",
        priorityLevel: "priority",
        protectionLevel: "deletable",
        source: "spreadsheet",
        assignedTo: "担当A",
        lastSyncedAt: "2026-08-01T00:00:00.000Z",
        orderIndex: 0,
        postponed: false,
        manualHallId: "hall-1",
        futureOptionalField: { preserved: true },
      },
    ],
  },
  eventMetadata: {
    テストイベント: {
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/test",
      spreadsheetSheetName: "一覧",
      lastImportDate: "2026-08-01T00:00:00.000Z",
    },
  },
  executeModeItems: {
    テストイベント: {
      "1日目": ["item-1"],
    },
  },
  dayModes: {
    テストイベント: {
      "1日目": "edit",
    },
  },
  mapData: {
    テストイベント: {
      "1日目マップ": {
        sheetName: "1日目",
        rows: 2,
        cols: 2,
        maxRow: 2,
        maxCol: 2,
        cells: [
          {
            row: 1,
            col: 1,
            value: "東A",
            backgroundColor: null,
            fontColor: null,
            borders: {
              top: { style: "thin", color: "#000000" },
              right: null,
              bottom: null,
              left: null,
            },
            isMerged: false,
            mergeParent: { row: 1, col: 1 },
            isVerticalText: false,
          },
        ],
        mergedCells: [
          {
            startRow: 1,
            startCol: 1,
            endRow: 1,
            endCol: 1,
            value: "東A",
          },
        ],
        blocks: [
          {
            name: "東A",
            startRow: 1,
            startCol: 1,
            endRow: 2,
            endCol: 2,
            numberCells: [{ row: 1, col: 1, value: 1 }],
            nameCells: [{ row: 1, col: 1 }],
            color: "#ffffff",
            id: "block-1",
            isAutoDetected: true,
            isWallBlock: false,
            cellGroups: [
              {
                type: "range",
                startRow: 1,
                startCol: 1,
                endRow: 2,
                endCol: 2,
                cells: [{ row: 1, col: 1 }],
              },
            ],
          },
        ],
      },
    },
  },
  mapRotationSettings: {
    テストイベント: {
      "1日目マップ": {
        initialAngle: 0,
        mapTabAngle: 0,
        focusModeAngle: 0,
      },
    },
  },
  routeSettings: {
    テストイベント: {
      "1日目マップ": {
        isRouteVisible: true,
        visitOrder: [
          {
            row: 1,
            col: 1,
            blockName: "東A",
            number: 1,
            order: 0,
            itemIds: ["item-1"],
          },
        ],
      },
    },
  },
  hallDefinitions: {
    テストイベント: {
      "1日目マップ": [
        {
          id: "hall-1",
          name: "東ホール",
          vertices: [
            { row: 1, col: 1 },
            { row: 1, col: 2 },
            { row: 2, col: 2 },
            { row: 2, col: 1 },
          ],
        },
      ],
    },
  },
  hallRouteSettings: {
    テストイベント: {
      "1日目マップ": {
        hallOrder: ["hall-1"],
        hallVisitLists: [{ hallId: "hall-1", itemIds: ["item-1"] }],
      },
    },
  },
  mapViewportSettings: {
    テストイベント: {
      "1日目マップ": {
        zoomLevel: 100,
        offsetX: 0,
        offsetY: 0,
      },
    },
  },
});

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const EVENT_NAME = "テストイベント";
const EVENT_DATE = "1日目";
const MAP_NAME = "1日目マップ";

const asRecord = (value: unknown): Record<string, unknown> =>
  value as Record<string, unknown>;

const asArray = (value: unknown): unknown[] => value as unknown[];

describe("appBackup", () => {
  it("creates, serializes, and parses a complete versioned backup", () => {
    const data = makeAppData();
    const eventSettings = {
      blockDetectionSettings: {
        テストイベント: {
          ...DEFAULT_BLOCK_DETECTION_SETTINGS,
          allowedCharTypes: {
            ...DEFAULT_BLOCK_DETECTION_SETTINGS.allowedCharTypes,
          },
        },
      },
    };
    const backup = createAppBackup(
      data,
      new Date("2026-08-01T12:34:56.789Z"),
      eventSettings,
    );

    const result = parseAppBackup(serializeAppBackup(backup));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.backup).toEqual(backup);
    expect(result.data).toEqual(data);
    expect(result.backup.eventSettings).toEqual(eventSettings);
    expect(
      (result.data.eventLists["テストイベント"][0] as Record<string, unknown>)
        .futureOptionalField,
    ).toEqual({ preserved: true });
  });

  it.each(APP_BACKUP_SECTION_KEYS)(
    "rejects a backup missing the %s section",
    (sectionName) => {
      const backup = clone(createAppBackup(makeAppData()));
      delete (backup.data as unknown as Record<string, unknown>)[sectionName];

      const result = parseAppBackup(backup);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("invalid backup was accepted");
      expect(result.errors.join("\n")).toContain(`data.${sectionName}`);
    },
  );

  it("rejects an unknown backup version", () => {
    const backup = {
      ...createAppBackup(makeAppData()),
      version: 999,
    };

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    expect(result.errors.join("\n")).toContain("version");
  });

  it("rejects an unknown backup kind", () => {
    const backup = {
      ...createAppBackup(makeAppData()),
      kind: "some-other-backup",
    };

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    expect(result.errors.join("\n")).toContain("kind");
  });

  it("requires the event-settings and block-detection-settings sections", () => {
    const missingEventSettings = clone(createAppBackup(makeAppData()));
    delete asRecord(missingEventSettings).eventSettings;

    const missingBlockSettings = clone(createAppBackup(makeAppData()));
    delete asRecord(missingBlockSettings.eventSettings).blockDetectionSettings;

    const firstResult = parseAppBackup(missingEventSettings);
    const secondResult = parseAppBackup(missingBlockSettings);

    expect(firstResult.ok).toBe(false);
    expect(secondResult.ok).toBe(false);
    if (firstResult.ok || secondResult.ok) {
      throw new Error("invalid backup was accepted");
    }
    expect(firstResult.errors.join("\n")).toContain("eventSettings");
    expect(secondResult.errors.join("\n")).toContain(
      "eventSettings.blockDetectionSettings",
    );
  });

  it("rejects malformed block-detection settings and unknown events", () => {
    const backup = clone(
      createAppBackup(makeAppData(), new Date(), {
        blockDetectionSettings: {
          [EVENT_NAME]: {
            ...DEFAULT_BLOCK_DETECTION_SETTINGS,
            allowedCharTypes: {
              ...DEFAULT_BLOCK_DETECTION_SETTINGS.allowedCharTypes,
            },
          },
          存在しないイベント: {
            ...DEFAULT_BLOCK_DETECTION_SETTINGS,
            allowedCharTypes: {
              ...DEFAULT_BLOCK_DETECTION_SETTINGS.allowedCharTypes,
            },
          },
        },
      }),
    );
    asRecord(
      backup.eventSettings.blockDetectionSettings[EVENT_NAME],
    ).polygonThreshold = 101;
    asRecord(
      asRecord(backup.eventSettings.blockDetectionSettings[EVENT_NAME])
        .allowedCharTypes,
    ).kanji = "true";

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    expect(errors).toContain(
      `eventSettings.blockDetectionSettings.${EVENT_NAME}.polygonThreshold`,
    );
    expect(errors).toContain(
      `eventSettings.blockDetectionSettings.${EVENT_NAME}.allowedCharTypes.kanji`,
    );
    expect(errors).toContain(
      "eventSettings.blockDetectionSettings.存在しないイベント",
    );
  });

  it("rejects a reversed block-detection number range", () => {
    const backup = clone(
      createAppBackup(makeAppData(), new Date(), {
        blockDetectionSettings: {
          [EVENT_NAME]: {
            ...DEFAULT_BLOCK_DETECTION_SETTINGS,
            numberCellMin: 100,
            numberCellMax: 10,
            allowedCharTypes: {
              ...DEFAULT_BLOCK_DETECTION_SETTINGS.allowedCharTypes,
            },
          },
        },
      }),
    );

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    expect(result.errors.join("\n")).toContain(
      `eventSettings.blockDetectionSettings.${EVENT_NAME}.numberCellMax`,
    );
  });

  it.each([
    {
      section: "eventLists",
      expectedPath: `data.eventLists.${EVENT_NAME}[0].catalogPrice`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        asRecord(backup.data.eventLists[EVENT_NAME][0]).catalogPrice = "1200";
      },
    },
    {
      section: "eventMetadata",
      expectedPath: `data.eventMetadata.${EVENT_NAME}.spreadsheetUrl`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        asRecord(backup.data.eventMetadata[EVENT_NAME]).spreadsheetUrl = 123;
      },
    },
    {
      section: "executeModeItems",
      expectedPath: `data.executeModeItems.${EVENT_NAME}.${EVENT_DATE}[0]`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        asRecord(backup.data.executeModeItems[EVENT_NAME])[EVENT_DATE] = [123];
      },
    },
    {
      section: "dayModes",
      expectedPath: `data.dayModes.${EVENT_NAME}.${EVENT_DATE}`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        asRecord(backup.data.dayModes[EVENT_NAME])[EVENT_DATE] = "preview";
      },
    },
    {
      section: "mapData",
      expectedPath: `data.mapData.${EVENT_NAME}.${MAP_NAME}.cells[0].borders.top.style`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        const dayMap = asRecord(backup.data.mapData[EVENT_NAME][MAP_NAME]);
        const cell = asRecord(asArray(dayMap.cells)[0]);
        const borders = asRecord(cell.borders);
        asRecord(borders.top).style = "glowing";
      },
    },
    {
      section: "mapRotationSettings",
      expectedPath: `data.mapRotationSettings.${EVENT_NAME}.${MAP_NAME}.initialAngle`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        asRecord(
          backup.data.mapRotationSettings[EVENT_NAME][MAP_NAME],
        ).initialAngle = "0";
      },
    },
    {
      section: "routeSettings",
      expectedPath: `data.routeSettings.${EVENT_NAME}.${MAP_NAME}.visitOrder[0].row`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        const settings = asRecord(
          backup.data.routeSettings[EVENT_NAME][MAP_NAME],
        );
        asRecord(asArray(settings.visitOrder)[0]).row = "1";
      },
    },
    {
      section: "hallDefinitions",
      expectedPath: `data.hallDefinitions.${EVENT_NAME}.${MAP_NAME}[0].vertices[0].row`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        const hall = asRecord(
          backup.data.hallDefinitions[EVENT_NAME][MAP_NAME][0],
        );
        asRecord(asArray(hall.vertices)[0]).row = "1";
      },
    },
    {
      section: "hallRouteSettings",
      expectedPath: `data.hallRouteSettings.${EVENT_NAME}.${MAP_NAME}.hallVisitLists[0].itemIds[0]`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        const settings = asRecord(
          backup.data.hallRouteSettings[EVENT_NAME][MAP_NAME],
        );
        const visitList = asRecord(asArray(settings.hallVisitLists)[0]);
        visitList.itemIds = [123];
      },
    },
    {
      section: "mapViewportSettings",
      expectedPath: `data.mapViewportSettings.${EVENT_NAME}.${MAP_NAME}.zoomLevel`,
      corrupt: (backup: ReturnType<typeof createAppBackup>) => {
        asRecord(
          backup.data.mapViewportSettings[EVENT_NAME][MAP_NAME],
        ).zoomLevel = "100";
      },
    },
  ])(
    "rejects a malformed known field inside $section",
    ({ expectedPath, corrupt }) => {
      const backup = clone(createAppBackup(makeAppData()));
      corrupt(backup);

      const result = parseAppBackup(backup);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("invalid backup was accepted");
      expect(result.errors.join("\n")).toContain(expectedPath);
    },
  );

  it.each([
    ["catalogPrice", "1000"],
    ["limitedPurchasedQuantity", 0],
    ["sheetRemarks", 123],
    ["url", false],
    ["priorityLevel", "urgent"],
    ["protectionLevel", "locked"],
    ["source", "manual"],
    ["assignedTo", []],
    ["lastSyncedAt", 123],
    ["orderIndex", "0"],
    ["postponed", "false"],
    ["manualHallId", 123],
  ] as const)(
    "rejects an invalid known optional item field: %s",
    (key, value) => {
      const backup = clone(createAppBackup(makeAppData()));
      asRecord(backup.data.eventLists[EVENT_NAME][0])[key] = value;

      const result = parseAppBackup(backup);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("invalid backup was accepted");
      expect(result.errors.join("\n")).toContain(
        `data.eventLists.${EVENT_NAME}[0].${key}`,
      );
    },
  );

  it("accepts legacy items with every known optional field omitted", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const item = asRecord(backup.data.eventLists[EVENT_NAME][0]);
    [
      "catalogPrice",
      "limitedPurchasedQuantity",
      "sheetRemarks",
      "url",
      "priorityLevel",
      "protectionLevel",
      "source",
      "assignedTo",
      "lastSyncedAt",
      "orderIndex",
      "postponed",
      "manualHallId",
    ].forEach((key) => {
      delete item[key];
    });

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(true);
  });

  it("accepts a valid limited-purchase actual quantity", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const item = asRecord(backup.data.eventLists[EVENT_NAME][0]);
    item.purchaseStatus = "LimitedPurchase";
    item.quantity = 3;
    item.limitedPurchasedQuantity = 2;

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(true);
  });

  it("accepts a limited-purchase item whose actual quantity is still awaiting input", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const item = asRecord(backup.data.eventLists[EVENT_NAME][0]);
    item.purchaseStatus = "LimitedPurchase";
    item.quantity = 3;
    delete item.limitedPurchasedQuantity;

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(true);
  });

  it("rejects an actual limited quantity on a non-limited purchase status", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const item = asRecord(backup.data.eventLists[EVENT_NAME][0]);
    item.purchaseStatus = "Purchased";
    item.quantity = 3;
    item.limitedPurchasedQuantity = 1;

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    expect(result.errors.join("\n")).toContain(
      `data.eventLists.${EVENT_NAME}[0].limitedPurchasedQuantity`,
    );
  });

  it.each([
    ["zero", 0, 3],
    ["negative", -1, 3],
    ["equal to planned", 3, 3],
    ["greater than planned", 4, 3],
  ])(
    "rejects a limited-purchase actual quantity that is %s",
    (_label, actual, planned) => {
      const backup = clone(createAppBackup(makeAppData()));
      const item = asRecord(backup.data.eventLists[EVENT_NAME][0]);
      item.purchaseStatus = "LimitedPurchase";
      item.quantity = planned;
      item.limitedPurchasedQuantity = actual;

      const result = parseAppBackup(backup);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("invalid backup was accepted");
      expect(result.errors.join("\n")).toContain(
        `data.eventLists.${EVENT_NAME}[0].limitedPurchasedQuantity`,
      );
    },
  );

  it("rejects route and hall-route item references from another event date", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const otherDayItem = clone(backup.data.eventLists[EVENT_NAME][0]);
    asRecord(otherDayItem).id = "item-other-day";
    asRecord(otherDayItem).eventDate = "2日目";
    delete asRecord(otherDayItem).manualHallId;
    backup.data.eventLists[EVENT_NAME].push(otherDayItem);

    const routeSettings = asRecord(
      backup.data.routeSettings[EVENT_NAME][MAP_NAME],
    );
    asRecord(asArray(routeSettings.visitOrder)[0]).itemIds = ["item-other-day"];

    const hallRouteSettings = asRecord(
      backup.data.hallRouteSettings[EVENT_NAME][MAP_NAME],
    );
    asRecord(asArray(hallRouteSettings.hallVisitLists)[0]).itemIds = [
      "item-other-day",
    ];
    const maplessName = "__mapless__:1日目";
    backup.data.hallDefinitions[EVENT_NAME][maplessName] = [
      {
        id: "hall-mapless",
        name: "マップなし会場",
        vertices: [],
      },
    ];
    backup.data.hallRouteSettings[EVENT_NAME][maplessName] = {
      hallOrder: ["hall-mapless"],
      hallVisitLists: [{ hallId: "hall-mapless", itemIds: ["item-other-day"] }],
    };

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    expect(errors).toContain(
      `data.routeSettings.${EVENT_NAME}.${MAP_NAME}.visitOrder[0].itemIds[0]`,
    );
    expect(errors).toContain(
      `data.hallRouteSettings.${EVENT_NAME}.${MAP_NAME}.hallVisitLists[0].itemIds[0]`,
    );
    expect(errors).toContain(
      `data.hallRouteSettings.${EVENT_NAME}.${maplessName}.hallVisitLists[0].itemIds[0]`,
    );
    expect(errors).toContain("対象マップの日付「1日目」と一致しません");
  });

  it("rejects malformed nested map cells, merged cells, blocks, and groups", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const dayMap = asRecord(backup.data.mapData[EVENT_NAME][MAP_NAME]);
    const cell = asRecord(asArray(dayMap.cells)[0]);
    const mergedCell = asRecord(asArray(dayMap.mergedCells)[0]);
    const block = asRecord(asArray(dayMap.blocks)[0]);
    const numberCell = asRecord(asArray(block.numberCells)[0]);
    const cellGroup = asRecord(asArray(block.cellGroups)[0]);
    const groupedCell = asRecord(asArray(cellGroup.cells)[0]);

    asRecord(cell.mergeParent).row = "1";
    mergedCell.value = true;
    numberCell.value = "1";
    groupedCell.col = 0;

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    expect(errors).toContain(`${MAP_NAME}.cells[0].mergeParent.row`);
    expect(errors).toContain(`${MAP_NAME}.mergedCells[0].value`);
    expect(errors).toContain(`${MAP_NAME}.blocks[0].numberCells[0].value`);
    expect(errors).toContain(
      `${MAP_NAME}.blocks[0].cellGroups[0].cells[0].col`,
    );
  });

  it("rejects out-of-map coordinates and reversed map ranges", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const dayMap = asRecord(backup.data.mapData[EVENT_NAME][MAP_NAME]);
    const cell = asRecord(asArray(dayMap.cells)[0]);
    const mergedCell = asRecord(asArray(dayMap.mergedCells)[0]);
    const block = asRecord(asArray(dayMap.blocks)[0]);
    const numberCell = asRecord(asArray(block.numberCells)[0]);
    const nameCell = asRecord(asArray(block.nameCells)[0]);
    const cellGroup = asRecord(asArray(block.cellGroups)[0]);
    const groupedCell = asRecord(asArray(cellGroup.cells)[0]);
    const routeSettings = asRecord(
      backup.data.routeSettings[EVENT_NAME][MAP_NAME],
    );
    const visitPoint = asRecord(asArray(routeSettings.visitOrder)[0]);

    cell.row = 3;
    asRecord(cell.mergeParent).col = 3;
    mergedCell.startRow = 2;
    mergedCell.endRow = 1;
    mergedCell.endCol = 3;
    block.startCol = 2;
    block.endCol = 1;
    numberCell.row = 3;
    nameCell.col = 3;
    cellGroup.startRow = 2;
    cellGroup.endRow = 1;
    groupedCell.row = 3;
    visitPoint.col = 3;

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    [
      `${MAP_NAME}.cells[0].row`,
      `${MAP_NAME}.cells[0].mergeParent.col`,
      `${MAP_NAME}.mergedCells[0].endRow`,
      `${MAP_NAME}.mergedCells[0].endCol`,
      `${MAP_NAME}.blocks[0].endCol`,
      `${MAP_NAME}.blocks[0].numberCells[0].row`,
      `${MAP_NAME}.blocks[0].nameCells[0].col`,
      `${MAP_NAME}.blocks[0].cellGroups[0].endRow`,
      `${MAP_NAME}.blocks[0].cellGroups[0].cells[0].row`,
      `${MAP_NAME}.visitOrder[0].col`,
    ].forEach((expectedPath) => {
      expect(errors).toContain(expectedPath);
    });
  });

  it("rejects map-scoped settings that point to missing related data", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const missingMapName = "存在しないマップ";
    backup.data.mapRotationSettings[EVENT_NAME][missingMapName] = clone(
      backup.data.mapRotationSettings[EVENT_NAME][MAP_NAME],
    );
    backup.data.routeSettings[EVENT_NAME][missingMapName] = clone(
      backup.data.routeSettings[EVENT_NAME][MAP_NAME],
    );
    backup.data.mapViewportSettings[EVENT_NAME][missingMapName] = clone(
      backup.data.mapViewportSettings[EVENT_NAME][MAP_NAME],
    );
    backup.data.hallDefinitions[EVENT_NAME][missingMapName] = clone(
      backup.data.hallDefinitions[EVENT_NAME][MAP_NAME],
    );
    backup.data.hallRouteSettings[EVENT_NAME]["会場定義なし"] = {
      hallOrder: [],
      hallVisitLists: [],
    };

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    expect(errors).toContain(
      `data.mapRotationSettings.${EVENT_NAME}.${missingMapName}`,
    );
    expect(errors).toContain(
      `data.routeSettings.${EVENT_NAME}.${missingMapName}`,
    );
    expect(errors).toContain(
      `data.mapViewportSettings.${EVENT_NAME}.${missingMapName}`,
    );
    expect(errors).toContain(
      `data.hallDefinitions.${EVENT_NAME}.${missingMapName}`,
    );
    expect(errors).toContain(
      `data.hallRouteSettings.${EVENT_NAME}.会場定義なし`,
    );
  });

  it("reports all invalid required item fields and constraints", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const item = backup.data.eventLists["テストイベント"][0] as Record<
      string,
      unknown
    >;
    item.id = 123;
    item.title = null;
    item.purchaseStatus = "Unknown";
    item.quantity = 0;

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    expect(errors).toContain("eventLists.テストイベント[0].id");
    expect(errors).toContain("eventLists.テストイベント[0].title");
    expect(errors).toContain("purchaseStatus");
    expect(errors).toContain("quantity");
  });

  it("rejects duplicate item IDs within the same event", () => {
    const backup = clone(createAppBackup(makeAppData()));
    backup.data.eventLists["テストイベント"].push(
      clone(backup.data.eventLists["テストイベント"][0]),
    );

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    expect(result.errors.join("\n")).toContain("品目ID「item-1」が重複");
  });

  it("collects unknown-event, item-ID, manual-hall, and hall-ID references", () => {
    const backup = clone(createAppBackup(makeAppData()));
    const eventName = "テストイベント";
    (
      backup.data.eventLists[eventName][0] as Record<string, unknown>
    ).manualHallId = "missing-manual-hall";
    backup.data.executeModeItems[eventName]["1日目"] = ["missing-execute-item"];
    (
      backup.data.routeSettings[eventName]["1日目マップ"] as {
        visitOrder: { itemIds: string[] }[];
      }
    ).visitOrder[0].itemIds = ["missing-route-item"];
    (
      backup.data.hallRouteSettings[eventName]["1日目マップ"] as {
        hallOrder: string[];
        hallVisitLists: { hallId: string; itemIds: string[] }[];
      }
    ).hallOrder = ["missing-order-hall"];
    (
      backup.data.hallRouteSettings[eventName]["1日目マップ"] as {
        hallVisitLists: { hallId: string; itemIds: string[] }[];
      }
    ).hallVisitLists = [
      {
        hallId: "missing-visit-hall",
        itemIds: ["missing-hall-route-item"],
      },
    ];
    backup.data.eventMetadata["ghost-event"] = {
      spreadsheetUrl: "",
      spreadsheetSheetName: "",
      lastImportDate: "",
    };
    backup.data.hallDefinitions[eventName]["1日目マップ"].push(
      clone(backup.data.hallDefinitions[eventName]["1日目マップ"][0]),
    );

    const result = parseAppBackup(backup);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid backup was accepted");
    const errors = result.errors.join("\n");
    expect(errors).toContain("ghost-event");
    expect(errors).toContain("missing-execute-item");
    expect(errors).toContain("missing-route-item");
    expect(errors).toContain("missing-hall-route-item");
    expect(errors).toContain("missing-manual-hall");
    expect(errors).toContain("missing-order-hall");
    expect(errors).toContain("missing-visit-hall");
    expect(errors).toContain("会場ID「hall-1」が重複");
  });
});
