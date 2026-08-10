import type { EventScreenSurface, ScreenState } from "./screenState";

export type NavigationCommand =
  | {
      type: "show-event-list";
    }
  | {
      type: "show-import";
      eventName: string | null;
    }
  | {
      type: "open-event";
      eventName: string;
      day: string;
      surface?: EventScreenSurface;
    }
  | {
      type: "change-day";
      day: string;
    }
  | {
      type: "show-event-surface";
      surface: EventScreenSurface;
    }
  | {
      type: "toggle-event-surface";
    }
  | {
      type: "rename-active-event";
      previousName: string;
      nextName: string;
    }
  | {
      type: "remove-event";
      eventName: string;
    };

export const navigationCommand = {
  showEventList(): NavigationCommand {
    return { type: "show-event-list" };
  },

  showImport(eventName: string | null): NavigationCommand {
    return { type: "show-import", eventName };
  },

  openEvent(
    eventName: string,
    day: string,
    surface: EventScreenSurface = "list",
  ): NavigationCommand {
    return { type: "open-event", eventName, day, surface };
  },

  changeDay(day: string): NavigationCommand {
    return { type: "change-day", day };
  },

  showEventSurface(surface: EventScreenSurface): NavigationCommand {
    return { type: "show-event-surface", surface };
  },

  toggleEventSurface(): NavigationCommand {
    return { type: "toggle-event-surface" };
  },

  renameActiveEvent(previousName: string, nextName: string): NavigationCommand {
    return { type: "rename-active-event", previousName, nextName };
  },

  removeEvent(eventName: string): NavigationCommand {
    return { type: "remove-event", eventName };
  },
} as const;

export interface NavigationDispatch {
  (command: NavigationCommand): void;
}

export interface NavigationController {
  readonly state: ScreenState;
  readonly dispatch: NavigationDispatch;
}
