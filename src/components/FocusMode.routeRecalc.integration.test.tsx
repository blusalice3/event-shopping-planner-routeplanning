import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import type { DayMapData, HallDefinition } from "../types/map";

vi.mock("../utils/pathfinding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/pathfinding")>();
  return {
    ...actual,
    generateRouteSegments: vi.fn(() => []),
  };
});

import FocusMode from "./FocusMode";
import { generateRouteSegments } from "../utils/pathfinding";
import { minimalProps } from "./FocusMode.fixtures";

const mockedGenerateRouteSegments = vi.mocked(generateRouteSegments);

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

const makeMap = (overrides: Partial<DayMapData> = {}): DayMapData => ({
  sheetName: "Sheet",
  rows: 10,
  cols: 10,
  maxRow: 10,
  maxCol: 10,
  cells: [
    {
      row: 1,
      col: 1,
      value: 1,
      backgroundColor: "#fff",
      borders: { top: null, right: null, bottom: null, left: null },
    },
    {
      row: 2,
      col: 2,
      value: 2,
      backgroundColor: "#fff",
      borders: { top: null, right: null, bottom: null, left: null },
    },
  ],
  mergedCells: [],
  blocks: [
    {
      name: "A",
      startRow: 1,
      startCol: 1,
      endRow: 2,
      endCol: 2,
      numberCells: [
        { row: 1, col: 1, value: 1 },
        { row: 2, col: 2, value: 2 },
        { row: 3, col: 3, value: 3 },
        { row: 9, col: 9, value: 2 },
      ],
    },
    {
      name: "B",
      startRow: 3,
      startCol: 3,
      endRow: 4,
      endCol: 4,
      numberCells: [{ row: 3, col: 3, value: 2 }],
    },
  ],
  ...overrides,
});

const halls: HallDefinition[] = [
  {
    id: "hall-1",
    name: "Hall 1",
    color: "#fff",
    vertices: [
      { row: 0, col: 0 },
      { row: 0, col: 5 },
      { row: 5, col: 5 },
      { row: 5, col: 0 },
    ],
    blockNames: ["A"],
  },
];

const renderFocusMode = (params: {
  items?: ShoppingItem[];
  executeModeItemIds?: string[];
  map?: DayMapData;
  hallDefinitions?: HallDefinition[];
  hallOrder?: string[];
}) => {
  const item1 = makeItem({ id: "item-1", number: "01a" });
  const item2 = makeItem({ id: "item-2", number: "02a" });
  const items = params.items ?? [item1, item2];

  return render(
    <FocusMode
      {...minimalProps({
        items,
        executeModeItemIds:
          params.executeModeItemIds ?? items.map((item) => item.id),
      })}
      mapData={{ Day1マップ: params.map ?? makeMap() }}
      hallDefinitions={params.hallDefinitions ?? halls}
      hallOrder={params.hallOrder ?? ["hall-1"]}
    />,
  );
};

describe("FocusMode route recalculation cache", () => {
  beforeEach(() => {
    mockedGenerateRouteSegments.mockClear();
  });

  it.each([
    ["remarks", { remarks: "after" }],
    ["price", { price: 2000 }],
    ["quantity", { quantity: 3 }],
  ] as const)(
    "does not regenerate route segments when %s changes",
    (_label, change) => {
      const item1 = makeItem({ id: "item-1", number: "01a" });
      const item2 = makeItem({ id: "item-2", number: "02a" });
      const { rerender } = renderFocusMode({ items: [item1, item2] });
      const callsBefore = mockedGenerateRouteSegments.mock.calls.length;

      rerender(
        <FocusMode
          {...minimalProps({
            items: [{ ...item1, ...change }, item2],
            executeModeItemIds: ["item-1", "item-2"],
          })}
          mapData={{ Day1マップ: makeMap() }}
          hallDefinitions={halls}
          hallOrder={["hall-1"]}
        />,
      );

      expect(mockedGenerateRouteSegments.mock.calls.length).toBe(callsBefore);
    },
  );

  it("regenerates route segments when number changes and visit coords change", () => {
    const item1 = makeItem({ id: "item-1", number: "01a" });
    const item2 = makeItem({ id: "item-2", number: "02a" });
    const { rerender } = renderFocusMode({ items: [item1, item2] });
    const callsBefore = mockedGenerateRouteSegments.mock.calls.length;

    rerender(
      <FocusMode
        {...minimalProps({
          items: [{ ...item1, number: "03a" }, item2],
          executeModeItemIds: ["item-1", "item-2"],
        })}
        mapData={{ Day1マップ: makeMap() }}
        hallDefinitions={halls}
        hallOrder={["hall-1"]}
      />,
    );

    expect(mockedGenerateRouteSegments.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
  });

  it("regenerates route segments when pathfinding map input changes even if visit coords stay the same", () => {
    const { rerender } = renderFocusMode({});
    const callsBefore = mockedGenerateRouteSegments.mock.calls.length;
    const changedMap = makeMap({
      cells: makeMap().cells.map((cell, index) =>
        index === 0 ? { ...cell, value: "wall-b" } : cell,
      ),
    });

    rerender(
      <FocusMode
        {...minimalProps({
          items: [
            makeItem({ id: "item-1", number: "01a" }),
            makeItem({ id: "item-2", number: "02a" }),
          ],
          executeModeItemIds: ["item-1", "item-2"],
        })}
        mapData={{ Day1マップ: changedMap }}
        hallDefinitions={halls}
        hallOrder={["hall-1"]}
      />,
    );

    expect(mockedGenerateRouteSegments.mock.calls.length).toBeGreaterThan(
      callsBefore,
    );
  });

  it("does not regenerate route segments when map display fields change for the active route day", () => {
    const { rerender } = renderFocusMode({});
    const callsBefore = mockedGenerateRouteSegments.mock.calls.length;
    const displayOnlyMap = makeMap({
      sheetName: "Other",
      rows: 99,
      cols: 99,
      cells: makeMap().cells.map((cell) => ({
        ...cell,
        fontColor: "#f00",
        isMerged: true,
        mergeParent: { row: cell.row, col: cell.col },
        isVerticalText: true,
      })),
      mergedCells: [
        { startRow: 1, startCol: 1, endRow: 1, endCol: 1, value: "x" },
      ],
    });

    rerender(
      <FocusMode
        {...minimalProps({
          items: [
            makeItem({ id: "item-1", number: "01a" }),
            makeItem({ id: "item-2", number: "02a" }),
          ],
          executeModeItemIds: ["item-1", "item-2"],
        })}
        mapData={{ Day1マップ: displayOnlyMap }}
        hallDefinitions={halls}
        hallOrder={["hall-1"]}
      />,
    );

    expect(mockedGenerateRouteSegments.mock.calls.length).toBe(callsBefore);
  });

  it("does not regenerate route segments when hall name color or vertices change but coords and pathfinding input stay the same", () => {
    const { rerender } = renderFocusMode({});
    const callsBefore = mockedGenerateRouteSegments.mock.calls.length;

    rerender(
      <FocusMode
        {...minimalProps({
          items: [
            makeItem({ id: "item-1", number: "01a" }),
            makeItem({ id: "item-2", number: "02a" }),
          ],
          executeModeItemIds: ["item-1", "item-2"],
        })}
        mapData={{ Day1マップ: makeMap() }}
        hallDefinitions={[
          {
            ...halls[0],
            name: "Renamed",
            color: "#000",
            vertices: [
              { row: 0, col: 0 },
              { row: 0, col: 6 },
              { row: 6, col: 6 },
              { row: 6, col: 0 },
            ],
          },
        ]}
        hallOrder={["hall-1"]}
      />,
    );

    expect(mockedGenerateRouteSegments.mock.calls.length).toBe(callsBefore);
  });
});
