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

export const isEventScreenState = (
  state: ScreenState,
): state is Extract<ScreenState, { kind: "event" }> => state.kind === "event";
