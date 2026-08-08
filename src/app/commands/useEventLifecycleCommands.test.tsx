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
  activeEventName: "イベントA",
  eventToRename: "イベントA",
  eventLists: { イベントA: [eventItem] },
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
  setPendingEventUpdate: vi.fn(),
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
  setEventToRename: vi.fn(),
  setShowRenameDialog: vi.fn(),
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

  it("fans delete out to every persisted section and typed navigation", () => {
    const ports = createPorts();
    const { result } = renderHook(() => useEventLifecycleCommands(ports));

    act(() => result.current.deleteEvent("イベントA"));

    expect(ports.setEventLists).toHaveBeenCalledOnce();
    expect(ports.setMapData).toHaveBeenCalledOnce();
    expect(ports.setMapViewportSettings).toHaveBeenCalledOnce();
    expect(ports.navigation.removeEvent).toHaveBeenCalledWith("イベントA");
  });

  it("renames persisted sections and the active typed screen together", () => {
    const ports = createPorts();
    const { result } = renderHook(() => useEventLifecycleCommands(ports));

    act(() => result.current.confirmRename("イベントB"));

    expect(ports.setEventLists).toHaveBeenCalledOnce();
    expect(ports.setHallDefinitions).toHaveBeenCalledOnce();
    expect(ports.navigation.renameActiveEvent).toHaveBeenCalledWith(
      "イベントA",
      "イベントB",
    );
    expect(ports.setShowRenameDialog).toHaveBeenLastCalledWith(false);
    expect(ports.setEventToRename).toHaveBeenLastCalledWith(null);
  });
});
