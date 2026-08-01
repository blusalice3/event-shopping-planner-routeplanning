import { describe, expect, it } from "vitest";
import type { HallDefinition, HallRouteSettings } from "../types/map";
import {
  buildActiveHallDefinitionsStore,
  buildActiveHallRouteSettingsStore,
  buildHallDefinitionsRoutingSignature,
  buildHallDefinitionsStoreRoutingSignature,
  buildHallRouteSettingsRoutingSignature,
  buildHallRouteSettingsStoreRoutingSignature,
} from "./hallRoutingSignature";

const hall = (overrides: Partial<HallDefinition> = {}): HallDefinition => ({
  id: "hall-1",
  name: "Hall",
  color: "#fff",
  vertices: [
    { row: 1, col: 1 },
    { row: 1, col: 3 },
    { row: 3, col: 3 },
  ],
  blockNames: ["B", "A"],
  ...overrides,
});

const settings = (
  overrides: Partial<HallRouteSettings> = {},
): HallRouteSettings => ({
  hallOrder: ["hall-1", "hall-2"],
  hallVisitLists: [{ hallId: "hall-1", itemIds: ["item-1", "item-2"] }],
  ...overrides,
});

describe("hall routing signatures", () => {
  it("changes hall routing signature for id vertices blockNames and array order", () => {
    const base = [hall()];

    expect(
      buildHallDefinitionsRoutingSignature([hall({ id: "hall-2" })]),
    ).not.toBe(buildHallDefinitionsRoutingSignature(base));
    expect(
      buildHallDefinitionsRoutingSignature([
        hall({ vertices: [{ row: 9, col: 9 }] }),
      ]),
    ).not.toBe(buildHallDefinitionsRoutingSignature(base));
    expect(
      buildHallDefinitionsRoutingSignature([hall({ blockNames: ["C"] })]),
    ).not.toBe(buildHallDefinitionsRoutingSignature(base));
    expect(
      buildHallDefinitionsRoutingSignature([hall({ id: "hall-2" }), hall()]),
    ).not.toBe(
      buildHallDefinitionsRoutingSignature([hall(), hall({ id: "hall-2" })]),
    );
  });

  it("keeps hall routing signature stable for name color and blockNames order", () => {
    expect(
      buildHallDefinitionsRoutingSignature([
        hall({ name: "Renamed", color: "#000" }),
      ]),
    ).toBe(buildHallDefinitionsRoutingSignature([hall()]));
    expect(
      buildHallDefinitionsRoutingSignature([hall({ blockNames: ["A", "B"] })]),
    ).toBe(
      buildHallDefinitionsRoutingSignature([hall({ blockNames: ["B", "A"] })]),
    );
  });

  it("uses tuple signatures for hall route settings without object insertion order sensitivity", () => {
    const reorderedObject = {
      hallVisitLists: [{ itemIds: ["item-1", "item-2"], hallId: "hall-1" }],
      hallOrder: ["hall-1", "hall-2"],
    } as HallRouteSettings;

    expect(buildHallRouteSettingsRoutingSignature(reorderedObject)).toBe(
      buildHallRouteSettingsRoutingSignature(settings()),
    );
    expect(
      buildHallRouteSettingsRoutingSignature(
        settings({ hallOrder: ["hall-2"] }),
      ),
    ).not.toBe(buildHallRouteSettingsRoutingSignature(settings()));
  });

  it("changes hall route settings signature when hallVisitLists changes", () => {
    expect(
      buildHallRouteSettingsRoutingSignature(
        settings({
          hallVisitLists: [{ hallId: "hall-1", itemIds: ["item-2", "item-1"] }],
        }),
      ),
    ).not.toBe(buildHallRouteSettingsRoutingSignature(settings()));

    expect(
      buildHallRouteSettingsRoutingSignature(
        settings({
          hallVisitLists: [{ hallId: "hall-2", itemIds: ["item-1", "item-2"] }],
        }),
      ),
    ).not.toBe(buildHallRouteSettingsRoutingSignature(settings()));
  });

  it("does not collide when ids or blockNames contain delimiter-like characters", () => {
    expect(
      buildHallDefinitionsRoutingSignature([
        hall({ id: "hall\u001f1", blockNames: ["A\u001eB"] }),
      ]),
    ).not.toBe(
      buildHallDefinitionsRoutingSignature([
        hall({ id: "hall", blockNames: ["1", "A", "B"] }),
      ]),
    );
  });

  it("builds active hall definition stores from only active map and mapless halls", () => {
    const mapHalls = [hall({ id: "map" })];
    const maplessHalls = [hall({ id: "mapless" })];

    expect(
      buildActiveHallDefinitionsStore({
        activeEventName: "Event",
        activeMapTabName: "Day1マップ",
        maplessKey: "__mapless__:Day1",
        activeMapHalls: mapHalls,
        activeMaplessHalls: maplessHalls,
      }),
    ).toEqual({
      Event: {
        Day1マップ: mapHalls,
        "__mapless__:Day1": maplessHalls,
      },
    });
  });

  it("keeps store routing signatures stable for display-only hall changes", () => {
    const signature = buildHallDefinitionsStoreRoutingSignature({
      activeEventName: "Event",
      activeMapTabName: "Day1マップ",
      maplessKey: "__mapless__:Day1",
      activeMapHalls: [hall()],
      activeMaplessHalls: [],
    });

    expect(
      buildHallDefinitionsStoreRoutingSignature({
        activeEventName: "Event",
        activeMapTabName: "Day1マップ",
        maplessKey: "__mapless__:Day1",
        activeMapHalls: [hall({ name: "Renamed", color: "#000" })],
        activeMaplessHalls: [],
      }),
    ).toBe(signature);
  });

  it("builds active hall route settings stores and ignores missing settings", () => {
    const activeSettings = settings();

    expect(
      buildActiveHallRouteSettingsStore({
        activeEventName: "Event",
        activeMapTabName: "Day1マップ",
        maplessKey: "__mapless__:Day1",
        activeMapSettings: activeSettings,
        activeMaplessSettings: undefined,
      }),
    ).toEqual({ Event: { Day1マップ: activeSettings } });
  });

  it("keeps hall route settings store signature stable for object property insertion order", () => {
    const activeMapSettings = {
      hallVisitLists: [{ itemIds: ["item-1", "item-2"], hallId: "hall-1" }],
      hallOrder: ["hall-1", "hall-2"],
    } as HallRouteSettings;

    expect(
      buildHallRouteSettingsStoreRoutingSignature({
        activeEventName: "Event",
        activeMapTabName: "Day1マップ",
        maplessKey: null,
        activeMapSettings,
        activeMaplessSettings: undefined,
      }),
    ).toBe(
      buildHallRouteSettingsStoreRoutingSignature({
        activeEventName: "Event",
        activeMapTabName: "Day1マップ",
        maplessKey: null,
        activeMapSettings: settings(),
        activeMaplessSettings: undefined,
      }),
    );
  });
});
