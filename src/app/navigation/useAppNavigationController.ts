import { useCallback, useMemo, useReducer } from "react";
import {
  navigationCommand,
  type NavigationController,
} from "./navigationCommand";
import { navigationReducer } from "./navigationReducer";
import type { EventScreenSurface, ScreenState } from "./screenState";

export interface AppNavigationCommands {
  showEventList(): void;
  showImport(eventName: string | null): void;
  openEvent(eventName: string, day: string, surface?: EventScreenSurface): void;
  changeDay(day: string): void;
  showEventSurface(surface: EventScreenSurface): void;
  toggleEventSurface(): void;
  renameActiveEvent(previousName: string, nextName: string): void;
  removeEvent(eventName: string): void;
}

export interface AppNavigationController extends NavigationController {
  readonly commands: AppNavigationCommands;
}

const INITIAL_SCREEN_STATE: ScreenState = { kind: "event-list" };

export const useAppNavigationController = (
  initialState: ScreenState = INITIAL_SCREEN_STATE,
): AppNavigationController => {
  const [state, dispatch] = useReducer(navigationReducer, initialState);

  const showEventList = useCallback(() => {
    dispatch(navigationCommand.showEventList());
  }, []);
  const showImport = useCallback((eventName: string | null) => {
    dispatch(navigationCommand.showImport(eventName));
  }, []);
  const openEvent = useCallback(
    (eventName: string, day: string, surface: EventScreenSurface = "list") => {
      dispatch(navigationCommand.openEvent(eventName, day, surface));
    },
    [],
  );
  const changeDay = useCallback((day: string) => {
    dispatch(navigationCommand.changeDay(day));
  }, []);
  const showEventSurface = useCallback((surface: EventScreenSurface) => {
    dispatch(navigationCommand.showEventSurface(surface));
  }, []);
  const toggleEventSurface = useCallback(() => {
    dispatch(navigationCommand.toggleEventSurface());
  }, []);
  const renameActiveEvent = useCallback(
    (previousName: string, nextName: string) => {
      dispatch(navigationCommand.renameActiveEvent(previousName, nextName));
    },
    [],
  );
  const removeEvent = useCallback((eventName: string) => {
    dispatch(navigationCommand.removeEvent(eventName));
  }, []);

  const commands = useMemo<AppNavigationCommands>(
    () => ({
      showEventList,
      showImport,
      openEvent,
      changeDay,
      showEventSurface,
      toggleEventSurface,
      renameActiveEvent,
      removeEvent,
    }),
    [
      changeDay,
      openEvent,
      removeEvent,
      renameActiveEvent,
      showEventList,
      showEventSurface,
      showImport,
      toggleEventSurface,
    ],
  );

  return useMemo(
    () => ({
      state,
      dispatch,
      commands,
    }),
    [commands, state],
  );
};
