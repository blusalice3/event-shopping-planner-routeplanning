import type { NavigationCommand } from "./navigationCommand";
import type { ScreenState } from "./screenState";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export const navigationReducer = (
  state: ScreenState,
  command: NavigationCommand,
): ScreenState => {
  switch (command.type) {
    case "show-event-list":
      return { kind: "event-list" };

    case "show-import":
      return {
        kind: "import",
        eventName: isNonEmptyString(command.eventName)
          ? command.eventName
          : null,
      };

    case "open-event":
      if (
        !isNonEmptyString(command.eventName) ||
        !isNonEmptyString(command.day)
      ) {
        return state;
      }
      return {
        kind: "event",
        eventName: command.eventName,
        day: command.day,
        surface: command.surface === "map" ? "map" : "list",
      };

    case "change-day":
      if (state.kind !== "event" || !isNonEmptyString(command.day)) {
        return state;
      }
      return { ...state, day: command.day };

    case "show-event-surface":
      if (state.kind !== "event") return state;
      return { ...state, surface: command.surface };

    case "toggle-event-surface":
      if (state.kind !== "event") return state;
      return {
        ...state,
        surface: state.surface === "map" ? "list" : "map",
      };

    case "rename-active-event":
      if (
        state.kind === "event" &&
        state.eventName === command.previousName &&
        isNonEmptyString(command.nextName)
      ) {
        return { ...state, eventName: command.nextName };
      }
      if (
        state.kind === "import" &&
        state.eventName === command.previousName &&
        isNonEmptyString(command.nextName)
      ) {
        return { ...state, eventName: command.nextName };
      }
      return state;

    case "remove-event":
      if (
        (state.kind === "event" && state.eventName === command.eventName) ||
        (state.kind === "import" && state.eventName === command.eventName)
      ) {
        return { kind: "event-list" };
      }
      return state;

    default:
      return state;
  }
};
