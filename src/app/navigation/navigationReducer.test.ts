import { describe, expect, it } from "vitest";
import { navigationCommand } from "./navigationCommand";
import { navigationReducer } from "./navigationReducer";
import {
  screenStateFromLegacy,
  screenStateToLegacy,
  type ScreenState,
} from "./screenState";

describe("typed screen navigation", () => {
  it("moves through event, map, import, and event-list states by command", () => {
    let state: ScreenState = { kind: "event-list" };

    state = navigationReducer(
      state,
      navigationCommand.openEvent("イベントA", "1日目"),
    );
    expect(state).toEqual({
      kind: "event",
      eventName: "イベントA",
      day: "1日目",
      surface: "list",
    });

    state = navigationReducer(state, navigationCommand.toggleEventSurface());
    expect(state).toMatchObject({ kind: "event", surface: "map" });

    state = navigationReducer(state, navigationCommand.changeDay("2日目"));
    expect(state).toMatchObject({ kind: "event", day: "2日目" });

    state = navigationReducer(state, navigationCommand.showImport("イベントA"));
    expect(state).toEqual({ kind: "import", eventName: "イベントA" });

    state = navigationReducer(state, navigationCommand.showEventList());
    expect(state).toEqual({ kind: "event-list" });
  });

  it("fails closed when an event-only command is used on another screen", () => {
    const state: ScreenState = { kind: "event-list" };

    expect(navigationReducer(state, navigationCommand.changeDay("2日目"))).toBe(
      state,
    );
    expect(
      navigationReducer(state, navigationCommand.showEventSurface("map")),
    ).toBe(state);
    expect(
      navigationReducer(state, navigationCommand.openEvent("", "1日目")),
    ).toBe(state);
    expect(navigationReducer(state, { type: "unknown-command" } as never)).toBe(
      state,
    );
  });

  it("renames and removes only the active matching event", () => {
    const state: ScreenState = {
      kind: "event",
      eventName: "イベントA",
      day: "1日目",
      surface: "list",
    };

    const unchanged = navigationReducer(
      state,
      navigationCommand.renameActiveEvent("イベントB", "イベントC"),
    );
    expect(unchanged).toBe(state);

    const renamed = navigationReducer(
      state,
      navigationCommand.renameActiveEvent("イベントA", "イベントC"),
    );
    expect(renamed).toMatchObject({
      kind: "event",
      eventName: "イベントC",
    });
    expect(
      navigationReducer(renamed, navigationCommand.removeEvent("イベントC")),
    ).toEqual({ kind: "event-list" });
  });
});

describe("legacy screen state adapter", () => {
  it("round-trips every valid typed state", () => {
    const states: ScreenState[] = [
      { kind: "event-list" },
      { kind: "import", eventName: null },
      { kind: "import", eventName: "イベントA" },
      {
        kind: "event",
        eventName: "イベントA",
        day: "1日目",
        surface: "list",
      },
      {
        kind: "event",
        eventName: "イベントA",
        day: "2日目",
        surface: "map",
      },
    ];

    states.forEach((state) => {
      expect(screenStateFromLegacy(screenStateToLegacy(state))).toEqual(state);
    });
  });

  it("normalizes invalid legacy combinations without preserving booleans", () => {
    expect(
      screenStateFromLegacy({
        activeEventName: null,
        activeTab: "1日目",
        mapViewActive: true,
      }),
    ).toEqual({ kind: "event-list" });
    expect(
      screenStateFromLegacy({
        activeEventName: "イベントA",
        activeTab: "eventList",
        mapViewActive: true,
      }),
    ).toEqual({ kind: "event-list" });
    expect(
      screenStateFromLegacy({
        activeEventName: null,
        activeTab: "import",
        mapViewActive: true,
      }),
    ).toEqual({ kind: "import", eventName: null });
  });
});
