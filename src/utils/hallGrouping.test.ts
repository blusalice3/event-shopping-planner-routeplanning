import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../types/item";
import type { DayMapData, HallDefinition } from "../types/map";
import { findItemHallIdByCell } from "../features/events/itemOps/geometry";
import { buildMergedHallRouteSettings } from "./mergedHallRouteSettings";
import {
  buildItemRoutingSignature,
  getHallIdForItem,
  sortItemsByHallOrder,
} from "./hallGrouping";

const makeItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "item-1",
  circle: "Circle",
  eventDate: "Day1",
  block: "A",
  number: "01a",
  title: "Title",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "remarks",
  url: "",
  priorityLevel: "none",
  ...overrides,
});

const halls: HallDefinition[] = [
  {
    id: "hall-selected",
    name: "Selected",
    vertices: [
      { row: 1, col: 1 },
      { row: 1, col: 3 },
      { row: 3, col: 3 },
      { row: 3, col: 1 },
    ],
    blockNames: ["A"],
  },
  {
    id: "hall-non-selected",
    name: "Non selected",
    vertices: [
      { row: 9, col: 9 },
      { row: 9, col: 11 },
      { row: 11, col: 11 },
      { row: 11, col: 9 },
    ],
    blockNames: ["B"],
  },
];

const makeMap = (
  numberCells = [
    { row: 10, col: 10, value: 1 },
    { row: 2, col: 2, value: 1 },
  ],
): DayMapData => ({
  sheetName: "Sheet",
  rows: 12,
  cols: 12,
  maxRow: 12,
  maxCol: 12,
  cells: [],
  mergedCells: [],
  blocks: [
    {
      name: "A",
      startRow: 1,
      startCol: 1,
      endRow: 10,
      endCol: 10,
      numberCells,
    },
    {
      name: "B",
      startRow: 9,
      startCol: 9,
      endRow: 11,
      endCol: 11,
      numberCells: [{ row: 10, col: 10, value: 2 }],
    },
  ],
});

describe("buildItemRoutingSignature", () => {
  it("does not change when price quantity remarks or purchaseStatus change", () => {
    const base = makeItem();
    const signature = buildItemRoutingSignature([base], [base.id]);

    expect(
      buildItemRoutingSignature(
        [
          {
            ...base,
            price: 2000,
            quantity: 9,
            remarks: "after",
            purchaseStatus: "Purchased",
          },
        ],
        [base.id],
      ),
    ).toBe(signature);
  });

  it("changes when eventDate block number priorityLevel or manualHallId changes", () => {
    const base = makeItem();
    const signature = buildItemRoutingSignature([base], [base.id]);

    for (const changed of [
      { eventDate: "Day2" },
      { block: "B" },
      { number: "02a" },
      { priorityLevel: "priority" as const },
      { manualHallId: "hall-selected" },
    ]) {
      expect(
        buildItemRoutingSignature([{ ...base, ...changed }], [base.id]),
      ).not.toBe(signature);
    }
  });

  it("preserves executeModeItemIds order and missing ids", () => {
    const item1 = makeItem({ id: "item-1" });
    const item2 = makeItem({ id: "item-2", number: "02a" });

    expect(
      buildItemRoutingSignature([item1, item2], ["item-1", "item-2"]),
    ).not.toBe(buildItemRoutingSignature([item1, item2], ["item-2", "item-1"]));
    expect(buildItemRoutingSignature([item1], ["missing", "item-1"])).not.toBe(
      buildItemRoutingSignature([item1], ["item-1", "missing"]),
    );
  });

  it("does not collide when fields contain delimiter-like characters", () => {
    const item = makeItem({
      eventDate: "Day\u001e1",
      block: "A\u001fB",
      number: "01|02",
    });

    expect(buildItemRoutingSignature([item], [item.id])).not.toBe(
      buildItemRoutingSignature(
        [{ ...item, block: "A", number: "\u001fB01|02" }],
        [item.id],
      ),
    );
  });
});

describe("deterministic duplicate number cell hall grouping", () => {
  it("resolves duplicate number cells deterministically in getHallIdForItem", () => {
    const item = makeItem();

    expect(getHallIdForItem(item, makeMap(), halls)).toBe("hall-selected");
    expect(
      getHallIdForItem(
        item,
        makeMap([...makeMap().blocks[0].numberCells].reverse()),
        halls,
      ),
    ).toBe("hall-selected");
  });

  it("resolves duplicate number cells deterministically in findItemHallIdByCell", () => {
    const item = makeItem();

    expect(findItemHallIdByCell(item, halls, makeMap())).toBe("hall-selected");
    expect(
      findItemHallIdByCell(
        item,
        halls,
        makeMap([...makeMap().blocks[0].numberCells].reverse()),
      ),
    ).toBe("hall-selected");
  });

  it("keeps sortItemsByHallOrder stable when duplicate numberCells are reordered", () => {
    const itemA = makeItem({ id: "a", block: "A", number: "01a" });
    const itemB = makeItem({ id: "b", block: "B", number: "02a" });

    expect(
      sortItemsByHallOrder([itemB, itemA], makeMap(), halls, [
        "hall-selected",
        "hall-non-selected",
      ]).map((item) => item.id),
    ).toEqual(["a", "b"]);
    expect(
      sortItemsByHallOrder(
        [itemB, itemA],
        makeMap([...makeMap().blocks[0].numberCells].reverse()),
        halls,
        ["hall-selected", "hall-non-selected"],
      ).map((item) => item.id),
    ).toEqual(["a", "b"]);
  });

  it("keeps buildMergedHallRouteSettings stable when duplicate numberCells are reordered", () => {
    const item = makeItem();
    const baseParams = {
      eventName: "Event",
      dayName: "Day1",
      mapTabName: "Day1マップ",
      hallDefinitionsStore: { Event: { Day1マップ: halls } },
      hallRouteSettingsStore: {
        Event: {
          Day1マップ: {
            hallOrder: ["hall-selected", "hall-non-selected"],
            hallVisitLists: [],
          },
        },
      },
      executeIds: [item.id],
      items: [item],
    };

    expect(
      buildMergedHallRouteSettings({
        ...baseParams,
        mapDataStore: { Event: { Day1マップ: makeMap() } },
      }).mergedSettings,
    ).toEqual(
      buildMergedHallRouteSettings({
        ...baseParams,
        mapDataStore: {
          Event: {
            Day1マップ: makeMap([...makeMap().blocks[0].numberCells].reverse()),
          },
        },
      }).mergedSettings,
    );
  });
});
