// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventLifecycleCommandPorts } from "./useEventLifecycleCommands";
import { useEventLifecycleCommands } from "./useEventLifecycleCommands";

const eventItem = {
  id: "item-1",
  circle: "A",
  eventDate: "1日目",
  block: "A",
  number: "01",
  title: "",
  price: null,
  purchaseStatus: "None" as const,
  quantity: 1,
  remarks: "",
};

const createPorts = (
  overrides: Partial<EventLifecycleCommandPorts> = {},
): EventLifecycleCommandPorts => ({
  persistenceCommands: {
    deleteEventAtomically: vi.fn(async () => undefined),
    renameEventAtomically: vi.fn(async () => undefined),
  },
  flushPendingSave: vi.fn(async () => undefined),
  activeEventName: "イベントA",
  eventToRename: "イベントA",
  eventLists: { イベントA: [eventItem] },
  eventMetadata: {
    イベントA: {
      spreadsheetUrl: "",
      spreadsheetSheetName: "",
      lastImportDate: "2026-08-09T00:00:00.000Z",
    },
  },
  executeModeItems: { イベントA: {} },
  dayModes: { イベントA: {} },
  mapData: { イベントA: {} },
  mapRotationSettings: { イベントA: {} },
  routeSettings: { イベントA: {} },
  hallDefinitions: { イベントA: {} },
  hallRouteSettings: { イベントA: {} },
  mapViewportSettings: { イベントA: {} },
  navigation: {
    showEventList: vi.fn(),
    showImport: vi.fn(),
    openEvent: vi.fn(),
    changeDay: vi.fn(),
    showEventSurface: vi.fn(),
    toggleEventSurface: vi.fn(),
    renameActiveEvent: vi.fn(),
    removeEvent: vi.fn(),
  },
  notify: vi.fn(),
  clearSelection: vi.fn(),
  setSelectedBlockFilters: vi.fn(),
  closeEventUpdateForEvent: vi.fn(),
  setEventLists: vi.fn(),
  setEventMetadata: vi.fn(),
  updateExecuteModeItems: vi.fn((update) => update({})),
  setDayModes: vi.fn(),
  setMapData: vi.fn(),
  setMapRotationSettings: vi.fn(),
  setRouteSettings: vi.fn(),
  setHallDefinitions: vi.fn(),
  setHallRouteSettings: vi.fn(),
  setMapViewportSettings: vi.fn(),
  setFocusModeSessions: vi.fn(),
  openRename: vi.fn(),
  confirmEventOverlay: vi.fn(),
  ...overrides,
});

describe("useEventLifecycleCommands", () => {
  it("opens the first valid day and resets list selection", () => {
    const ports = createPorts();
    const { result } = renderHook(() => useEventLifecycleCommands(ports));

    act(() => result.current.selectEvent("イベントA"));

    expect(ports.navigation.openEvent).toHaveBeenCalledWith(
      "イベントA",
      "1日目",
    );
    expect(ports.clearSelection).toHaveBeenCalledOnce();
    expect(ports.setSelectedBlockFilters).toHaveBeenCalledWith(new Set());
  });

  it("commits delete atomically before updating every state section", async () => {
    const ports = createPorts();
    const { result } = renderHook(() => useEventLifecycleCommands(ports));

    await act(() => result.current.deleteEvent("イベントA"));

    expect(ports.setEventLists).toHaveBeenCalledOnce();
    expect(ports.setMapData).toHaveBeenCalledOnce();
    expect(ports.setMapViewportSettings).toHaveBeenCalledOnce();
    expect(
      ports.persistenceCommands.deleteEventAtomically,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ eventLists: ports.eventLists }),
      "イベントA",
    );
    expect(ports.navigation.removeEvent).toHaveBeenCalledWith("イベントA");
  });

  it("commits rename atomically before updating state and the active screen", async () => {
    const ports = createPorts();
    const { result } = renderHook(() => useEventLifecycleCommands(ports));

    await act(() => result.current.confirmRename("イベントB"));

    expect(ports.setEventLists).toHaveBeenCalledOnce();
    expect(ports.setHallDefinitions).toHaveBeenCalledOnce();
    expect(
      ports.persistenceCommands.renameEventAtomically,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ eventLists: ports.eventLists }),
      "イベントA",
      "イベントB",
    );
    expect(ports.navigation.renameActiveEvent).toHaveBeenCalledWith(
      "イベントA",
      "イベントB",
    );
    expect(ports.confirmEventOverlay).toHaveBeenCalledOnce();
  });

  it("routes rename and matching event-update closure through overlay commands", async () => {
    const ports = createPorts();
    const { result } = renderHook(() => useEventLifecycleCommands(ports));

    await act(async () => {
      result.current.requestRename("イベントA");
      await result.current.deleteEvent("イベントA");
    });

    expect(ports.openRename).toHaveBeenCalledWith("イベントA");
    expect(ports.closeEventUpdateForEvent).toHaveBeenCalledWith("イベントA");
  });

  it.each(["delete", "rename"] as const)(
    "leaves every UI state unchanged when atomic %s fails",
    async (operation) => {
      const failure = vi.fn(async () => {
        throw new Error("transaction aborted");
      });
      const ports = createPorts({
        persistenceCommands: {
          deleteEventAtomically:
            operation === "delete" ? failure : vi.fn(async () => undefined),
          renameEventAtomically:
            operation === "rename" ? failure : vi.fn(async () => undefined),
        },
      });
      const { result } = renderHook(() => useEventLifecycleCommands(ports));

      await act(async () => {
        if (operation === "delete") {
          await result.current.deleteEvent("イベントA");
        } else {
          await result.current.confirmRename("イベントB");
        }
      });

      expect(ports.setEventLists).not.toHaveBeenCalled();
      expect(ports.setEventMetadata).not.toHaveBeenCalled();
      expect(ports.updateExecuteModeItems).not.toHaveBeenCalled();
      expect(ports.setMapData).not.toHaveBeenCalled();
      expect(ports.setMapViewportSettings).not.toHaveBeenCalled();
      expect(ports.setFocusModeSessions).not.toHaveBeenCalled();
      expect(ports.navigation.removeEvent).not.toHaveBeenCalled();
      expect(ports.navigation.renameActiveEvent).not.toHaveBeenCalled();
      expect(ports.notify).toHaveBeenCalledOnce();
    },
  );
});
