import { describe, expect, it } from "vitest";
import { selectNavigationReadModel } from "./navigationSelectors";
import type { ScreenState } from "./screenState";

describe("selectNavigationReadModel", () => {
  it.each<{
    state: ScreenState;
    expected: ReturnType<typeof selectNavigationReadModel>;
  }>([
    {
      state: { kind: "event-list" },
      expected: {
        kind: "event-list",
        activeEventName: null,
        activeTab: "eventList",
        mapViewActive: false,
      },
    },
    {
      state: { kind: "import", eventName: "イベントA" },
      expected: {
        kind: "import",
        activeEventName: "イベントA",
        activeTab: "import",
        mapViewActive: false,
      },
    },
    {
      state: {
        kind: "event",
        eventName: "イベントA",
        day: "2日目",
        surface: "map",
      },
      expected: {
        kind: "event",
        activeEventName: "イベントA",
        activeTab: "2日目",
        mapViewActive: true,
      },
    },
  ])("derives the closed $state.kind read model", ({ state, expected }) => {
    expect(selectNavigationReadModel(state)).toEqual(expected);
  });

  it("preserves a nullable event selection on the import screen", () => {
    expect(
      selectNavigationReadModel({ kind: "import", eventName: null }),
    ).toEqual({
      kind: "import",
      activeEventName: null,
      activeTab: "import",
      mapViewActive: false,
    });
  });
});
