// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import type {
  DayMapData,
  HallDefinition,
  HallRouteSettings,
} from "../../../types/map";

const mocks = vi.hoisted(() => ({
  buildMergedHallRouteSettings: vi.fn(),
  focusModeProps: [] as Record<string, unknown>[],
}));

vi.mock("../../../utils/mergedHallRouteSettings", () => ({
  buildMergedHallRouteSettings: mocks.buildMergedHallRouteSettings,
}));

vi.mock("../../../components/FocusMode", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.focusModeProps.push(props);
    return <div data-testid="focus-mode" />;
  },
}));

import FocusModeContainer from "./FocusModeContainer";

const item = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
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

const mapData = (overrides: Partial<DayMapData> = {}): DayMapData => ({
  maxRow: 5,
  maxCol: 5,
  cells: [
    {
      row: 1,
      col: 1,
      value: 1,
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
      numberCells: [{ row: 1, col: 1, value: 1 }],
    },
  ],
  ...overrides,
});

const hall = (overrides: Partial<HallDefinition> = {}): HallDefinition => ({
  id: "hall-1",
  name: "Hall 1",
  color: "#fff",
  vertices: [
    { row: 0, col: 0 },
    { row: 0, col: 2 },
    { row: 2, col: 2 },
    { row: 2, col: 0 },
  ],
  blockNames: ["A"],
  ...overrides,
});

const settings = (
  overrides: Partial<HallRouteSettings> = {},
): HallRouteSettings => ({
  hallOrder: ["hall-1"],
  hallVisitLists: [],
  ...overrides,
});

const baseProps = {
  activeEventName: "Event",
  activeTab: "Day1",
  eventDates: ["Day1"],
  items: [item()],
  executeModeItems: { Event: { Day1: ["item-1"] } },
  mapData: { Event: { Day1マップ: mapData() } },
  hallDefinitions: { Event: { Day1マップ: [hall()] } },
  hallRouteSettings: { Event: { Day1マップ: settings() } },
  onUpdateItem: vi.fn(),
  onModeChange: vi.fn(),
  layoutMode: "pc" as const,
  onLayoutModeChange: vi.fn(),
};

describe("FocusModeContainer route merge cache", () => {
  beforeEach(() => {
    mocks.focusModeProps.length = 0;
    mocks.buildMergedHallRouteSettings.mockReset();
    mocks.buildMergedHallRouteSettings.mockReturnValue({
      mergedHalls: [hall({ id: "stale-merged", name: "Stale merged" })],
      mergedSettings: { hallOrder: ["hall-1"], hallVisitLists: [] },
      dayMapData: mapData({ blocks: [] }),
    });
  });

  it("does not rebuild merged hall route settings when executeModeItemIds identity changes but ids stay the same", () => {
    const { rerender } = render(<FocusModeContainer {...baseProps} />);
    const callsBefore = mocks.buildMergedHallRouteSettings.mock.calls.length;

    rerender(
      <FocusModeContainer
        {...baseProps}
        executeModeItems={{ Event: { Day1: ["item-1"] } }}
      />,
    );

    expect(mocks.buildMergedHallRouteSettings.mock.calls.length).toBe(
      callsBefore,
    );
  });

  it("rebuilds merged hall route settings when executeModeItemIds order changes", () => {
    const props = {
      ...baseProps,
      items: [item({ id: "item-1" }), item({ id: "item-2", number: "02a" })],
      executeModeItems: { Event: { Day1: ["item-1", "item-2"] } },
    };
    const { rerender } = render(<FocusModeContainer {...props} />);
    const callsBefore = mocks.buildMergedHallRouteSettings.mock.calls.length;

    rerender(
      <FocusModeContainer
        {...props}
        executeModeItems={{ Event: { Day1: ["item-2", "item-1"] } }}
      />,
    );

    expect(
      mocks.buildMergedHallRouteSettings.mock.calls.length,
    ).toBeGreaterThan(callsBefore);
  });

  it("does not rebuild merged hall route settings when item remarks or active map cells change", () => {
    const { rerender } = render(<FocusModeContainer {...baseProps} />);
    const callsBefore = mocks.buildMergedHallRouteSettings.mock.calls.length;

    rerender(
      <FocusModeContainer
        {...baseProps}
        items={[item({ remarks: "after" })]}
        mapData={{
          Event: {
            Day1マップ: mapData({
              cells: [{ ...mapData().cells[0], value: "wall" }],
            }),
          },
        }}
      />,
    );

    expect(mocks.buildMergedHallRouteSettings.mock.calls.length).toBe(
      callsBefore,
    );
  });

  it("keeps FocusMode hallDefinitions fresh without consuming mergedHalls", () => {
    const { rerender } = render(<FocusModeContainer {...baseProps} />);
    const callsBefore = mocks.buildMergedHallRouteSettings.mock.calls.length;
    const renamedHall = hall({ name: "Renamed fresh hall", color: "#000" });

    rerender(
      <FocusModeContainer
        {...baseProps}
        hallDefinitions={{ Event: { Day1マップ: [renamedHall] } }}
      />,
    );

    expect(mocks.buildMergedHallRouteSettings.mock.calls.length).toBe(
      callsBefore,
    );
    expect(mocks.focusModeProps.at(-1)?.hallDefinitions).toEqual([renamedHall]);
    expect(mocks.focusModeProps.at(-1)?.hallDefinitions).not.toEqual([
      hall({ id: "stale-merged", name: "Stale merged" }),
    ]);
  });

  it("passes purchase status control mode to FocusMode", () => {
    render(
      <FocusModeContainer
        {...baseProps}
        purchaseStatusControlMode="radial"
      />,
    );

    expect(mocks.focusModeProps.at(-1)?.purchaseStatusControlMode).toBe("radial");
  });
});
