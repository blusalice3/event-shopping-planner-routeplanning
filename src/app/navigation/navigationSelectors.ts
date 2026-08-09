import { EVENT_LIST_TAB, IMPORT_TAB, type ScreenState } from "./screenState";

export type NavigationReadModel =
  | {
      readonly kind: "event-list";
      readonly activeEventName: null;
      readonly activeTab: typeof EVENT_LIST_TAB;
      readonly mapViewActive: false;
    }
  | {
      readonly kind: "import";
      readonly activeEventName: string | null;
      readonly activeTab: typeof IMPORT_TAB;
      readonly mapViewActive: false;
    }
  | {
      readonly kind: "event";
      readonly activeEventName: string;
      readonly activeTab: string;
      readonly mapViewActive: boolean;
    };

export const selectNavigationReadModel = (
  state: ScreenState,
): NavigationReadModel => {
  switch (state.kind) {
    case "event-list":
      return {
        kind: state.kind,
        activeEventName: null,
        activeTab: EVENT_LIST_TAB,
        mapViewActive: false,
      };
    case "import":
      return {
        kind: state.kind,
        activeEventName: state.eventName,
        activeTab: IMPORT_TAB,
        mapViewActive: false,
      };
    case "event":
      return {
        kind: state.kind,
        activeEventName: state.eventName,
        activeTab: state.day,
        mapViewActive: state.surface === "map",
      };
  }
};
