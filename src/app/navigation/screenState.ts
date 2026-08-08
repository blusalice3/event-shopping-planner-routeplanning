export const EVENT_LIST_TAB = "eventList" as const;
export const IMPORT_TAB = "import" as const;

export type EventScreenSurface = "list" | "map";

export type ScreenState =
  | {
      kind: "event-list";
    }
  | {
      kind: "import";
      eventName: string | null;
    }
  | {
      kind: "event";
      eventName: string;
      day: string;
      surface: EventScreenSurface;
    };

export interface LegacyScreenState {
  activeEventName: string | null;
  activeTab: string;
  mapViewActive: boolean;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const screenStateFromLegacy = ({
  activeEventName,
  activeTab,
  mapViewActive,
}: LegacyScreenState): ScreenState => {
  if (activeTab === IMPORT_TAB) {
    return {
      kind: "import",
      eventName: isNonEmptyString(activeEventName) ? activeEventName : null,
    };
  }

  if (
    isNonEmptyString(activeEventName) &&
    isNonEmptyString(activeTab) &&
    activeTab !== EVENT_LIST_TAB
  ) {
    return {
      kind: "event",
      eventName: activeEventName,
      day: activeTab,
      surface: mapViewActive ? "map" : "list",
    };
  }

  return { kind: "event-list" };
};

export const screenStateToLegacy = (state: ScreenState): LegacyScreenState => {
  switch (state.kind) {
    case "event-list":
      return {
        activeEventName: null,
        activeTab: EVENT_LIST_TAB,
        mapViewActive: false,
      };
    case "import":
      return {
        activeEventName: state.eventName,
        activeTab: IMPORT_TAB,
        mapViewActive: false,
      };
    case "event":
      return {
        activeEventName: state.eventName,
        activeTab: state.day,
        mapViewActive: state.surface === "map",
      };
  }
};

export const isEventScreenState = (
  state: ScreenState,
): state is Extract<ScreenState, { kind: "event" }> => state.kind === "event";
