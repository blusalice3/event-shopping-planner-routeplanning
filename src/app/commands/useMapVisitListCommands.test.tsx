// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActiveTab } from "../../features/app-shell/types";
import type { ShoppingItem } from "../../types/item";
import type { PersistenceSnapshot } from "../ports/PersistenceCommandPort";
import {
  useMapVisitListCommands,
  type MapVisitListActionPort,
  type MapVisitListCommandPorts,
  type MapVisitListStatePort,
  type MapVisitListTransitionResult,
} from "./useMapVisitListCommands";

const EVENT = "イベントA";
const OTHER_EVENT = "イベントB";
const DAY_ONE = "1日目";
const DAY_TWO = "2日目";
const MAP_ONE = `${DAY_ONE}マップ`;
const MAP_TWO = `${DAY_TWO}マップ`;

const item = (id: string, eventDate = DAY_ONE): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate,
  block: "A",
  number: "1",
  title: `商品${id}`,
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

const executeModeItems = (): PersistenceSnapshot["executeModeItems"] => ({
  [EVENT]: {
    [DAY_ONE]: ["one", "two"],
    [DAY_TWO]: ["three"],
  },
  [OTHER_EVENT]: { [DAY_ONE]: ["other"] },
});

const baseState = (): MapVisitListStatePort => ({
  activeEventName: EVENT,
  activeEventDate: DAY_ONE,
  isMapTab: true,
  currentMapTabName: MAP_ONE,
  executeModeItems: executeModeItems(),
  panelOpen: false,
  panelMapTab: null,
  hasUnsavedChanges: false,
  originalOrder: [],
  confirmDialogOpen: false,
  pendingTabChange: null,
});

const createHarness = (overrides: Partial<MapVisitListStatePort> = {}) => {
  const state = { ...baseState(), ...overrides };
  const stores = {
    executeModeItems: state.executeModeItems,
    panelOpen: state.panelOpen,
    panelMapTab: state.panelMapTab,
    hasUnsavedChanges: state.hasUnsavedChanges,
    originalOrder: [...state.originalOrder],
    confirmDialogOpen: state.confirmDialogOpen,
    pendingTabChange: state.pendingTabChange,
  };
  const updateExecuteModeItems: MapVisitListActionPort["updateExecuteModeItems"] =
    vi.fn((updater) => {
      stores.executeModeItems = updater(stores.executeModeItems);
    });
  const openPanel: MapVisitListActionPort["openPanel"] = vi.fn(
    (mapTab, originalOrder) => {
      stores.panelOpen = true;
      stores.panelMapTab = mapTab;
      stores.hasUnsavedChanges = false;
      stores.originalOrder = [...originalOrder];
      stores.confirmDialogOpen = false;
      stores.pendingTabChange = null;
    },
  );
  const setUnsaved: MapVisitListActionPort["setUnsaved"] = vi.fn((value) => {
    stores.hasUnsavedChanges = value;
  });
  const requestConfirmClose: MapVisitListActionPort["requestConfirmClose"] =
    vi.fn((pendingTabChange) => {
      stores.confirmDialogOpen = true;
      stores.pendingTabChange = pendingTabChange;
    });
  const resetPanel = () => {
    stores.panelOpen = false;
    stores.panelMapTab = null;
    stores.hasUnsavedChanges = false;
    stores.originalOrder = [];
    stores.confirmDialogOpen = false;
    stores.pendingTabChange = null;
  };
  const closePanel: MapVisitListActionPort["closePanel"] = vi.fn(resetPanel);
  const confirmClose: MapVisitListActionPort["confirmClose"] =
    vi.fn(resetPanel);
  const discardClose: MapVisitListActionPort["discardClose"] =
    vi.fn(resetPanel);
  const navigateToTab = vi.fn();
  const actions: MapVisitListActionPort = {
    updateExecuteModeItems,
    openPanel,
    setUnsaved,
    requestConfirmClose,
    closePanel,
    confirmClose,
    discardClose,
  };
  const ports: MapVisitListCommandPorts = {
    state,
    actions,
    navigation: { navigateToTab },
  };

  return {
    ports,
    stores,
    spies: {
      updateExecuteModeItems,
      openPanel,
      setUnsaved,
      requestConfirmClose,
      closePanel,
      confirmClose,
      discardClose,
      navigateToTab,
    },
  };
};

describe("useMapVisitListCommands", () => {
  it("opens a valid map tab with a detached original-order snapshot", () => {
    const harness = createHarness();
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));

    act(() => result.current.openPanel(MAP_ONE));

    expect(harness.stores.originalOrder).toEqual(["one", "two"]);
    expect(harness.stores.originalOrder).not.toBe(
      harness.ports.state.executeModeItems[EVENT][DAY_ONE],
    );
    expect(harness.stores.panelMapTab).toBe(MAP_ONE);
    expect(harness.stores.hasUnsavedChanges).toBe(false);
    expect(harness.stores.panelOpen).toBe(true);
  });

  it("rejects an invalid map tab or an absent active event", () => {
    const invalid = createHarness();
    const inactive = createHarness({ activeEventName: null });
    const invalidHook = renderHook(() =>
      useMapVisitListCommands(invalid.ports),
    );
    const inactiveHook = renderHook(() =>
      useMapVisitListCommands(inactive.ports),
    );

    act(() => {
      invalidHook.result.current.openPanel("1日目");
      inactiveHook.result.current.openPanel(MAP_ONE);
    });

    expect(invalid.spies.openPanel).not.toHaveBeenCalled();
    expect(inactive.spies.openPanel).not.toHaveBeenCalled();
  });

  it("reorders one event day as a single committed-state update", () => {
    const harness = createHarness({ panelOpen: true, panelMapTab: MAP_ONE });
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));

    act(() =>
      result.current.updateOrder([item("two"), item("one"), item("four")]),
    );

    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledOnce();
    expect(harness.stores.executeModeItems[EVENT][DAY_ONE]).toEqual([
      "two",
      "one",
      "four",
    ]);
    expect(harness.stores.executeModeItems[EVENT][DAY_TWO]).toEqual(["three"]);
    expect(harness.stores.executeModeItems[OTHER_EVENT][DAY_ONE]).toEqual([
      "other",
    ]);
    expect(harness.stores.hasUnsavedChanges).toBe(true);
  });

  it("saves optimistic changes without creating a second persistence writer", () => {
    const harness = createHarness({
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
      originalOrder: ["one", "two"],
    });
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));

    act(() => result.current.saveChanges());

    expect(harness.stores.hasUnsavedChanges).toBe(false);
    expect(harness.stores.originalOrder).toEqual(["one", "two"]);
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
  });

  it.each([
    { originalOrder: ["one", "two"], expected: ["one", "two"] },
    { originalOrder: [], expected: [] },
  ])(
    "discards to the exact original order, including an empty snapshot",
    ({ originalOrder, expected }) => {
      const current = executeModeItems();
      current[EVENT][DAY_ONE] = ["changed"];
      const harness = createHarness({
        executeModeItems: current,
        panelOpen: true,
        panelMapTab: MAP_ONE,
        hasUnsavedChanges: true,
        originalOrder,
      });
      const { result } = renderHook(() =>
        useMapVisitListCommands(harness.ports),
      );

      act(() => result.current.discardChanges());

      expect(harness.stores.executeModeItems[EVENT][DAY_ONE]).toEqual(expected);
      expect(harness.stores.hasUnsavedChanges).toBe(false);
      expect(harness.stores.originalOrder).toEqual(originalOrder);
    },
  );

  it("requires an explicit decision before closing a dirty panel", () => {
    const dirty = createHarness({
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
    });
    const clean = createHarness({ panelOpen: true, panelMapTab: MAP_ONE });
    const dirtyHook = renderHook(() => useMapVisitListCommands(dirty.ports));
    const cleanHook = renderHook(() => useMapVisitListCommands(clean.ports));
    let dirtyResult: MapVisitListTransitionResult = "ignored";
    let cleanResult: MapVisitListTransitionResult = "ignored";

    act(() => {
      dirtyResult = dirtyHook.result.current.requestClose();
      cleanResult = cleanHook.result.current.requestClose();
    });

    expect(dirtyResult).toBe("confirmation");
    expect(dirty.stores.confirmDialogOpen).toBe(true);
    expect(dirty.stores.pendingTabChange).toBeNull();
    expect(dirty.spies.closePanel).not.toHaveBeenCalled();
    expect(cleanResult).toBe("navigated");
    expect(clean.stores.panelOpen).toBe(false);
  });

  it("defers dirty tab navigation and performs clean navigation immediately", () => {
    const dirty = createHarness({
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
    });
    const clean = createHarness({ panelOpen: true, panelMapTab: MAP_ONE });
    const dirtyHook = renderHook(() => useMapVisitListCommands(dirty.ports));
    const cleanHook = renderHook(() => useMapVisitListCommands(clean.ports));
    let dirtyResult: MapVisitListTransitionResult = "ignored";
    let cleanResult: MapVisitListTransitionResult = "ignored";

    act(() => {
      dirtyResult = dirtyHook.result.current.requestTabChange(DAY_TWO);
      cleanResult = cleanHook.result.current.requestTabChange(DAY_TWO);
    });

    expect(dirtyResult).toBe("confirmation");
    expect(dirty.stores.pendingTabChange).toBe(DAY_TWO);
    expect(dirty.stores.confirmDialogOpen).toBe(true);
    expect(dirty.spies.navigateToTab).not.toHaveBeenCalled();
    expect(cleanResult).toBe("navigated");
    expect(clean.stores.panelOpen).toBe(false);
    expect(clean.spies.navigateToTab).toHaveBeenCalledWith(DAY_TWO);
  });

  it("saves and completes the exact pending transition once", () => {
    const harness = createHarness({
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
      originalOrder: ["one", "two"],
      confirmDialogOpen: true,
      pendingTabChange: DAY_TWO,
    });
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));

    act(() => result.current.confirmPendingTransition());

    expect(harness.stores.hasUnsavedChanges).toBe(false);
    expect(harness.stores.originalOrder).toEqual([]);
    expect(harness.stores.confirmDialogOpen).toBe(false);
    expect(harness.stores.panelOpen).toBe(false);
    expect(harness.spies.navigateToTab).toHaveBeenCalledOnce();
    expect(harness.spies.navigateToTab).toHaveBeenCalledWith(DAY_TWO);
    expect(harness.stores.pendingTabChange).toBeNull();
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
  });

  it("discards and restores before completing the pending transition", () => {
    const current = executeModeItems();
    current[EVENT][DAY_ONE] = ["two", "one"];
    const harness = createHarness({
      executeModeItems: current,
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
      originalOrder: ["one", "two"],
      confirmDialogOpen: true,
      pendingTabChange: "eventList",
    });
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));

    act(() => result.current.discardPendingTransition());

    expect(harness.stores.executeModeItems[EVENT][DAY_ONE]).toEqual([
      "one",
      "two",
    ]);
    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledOnce();
    expect(harness.spies.navigateToTab).toHaveBeenCalledWith("eventList");
    expect(harness.stores.confirmDialogOpen).toBe(false);
    expect(harness.stores.panelOpen).toBe(false);
    expect(harness.stores.pendingTabChange).toBeNull();
  });

  it("ignores late confirmation callbacks after the dialog has closed", () => {
    const harness = createHarness({
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
      originalOrder: ["one", "two"],
      pendingTabChange: DAY_TWO,
    });
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));

    act(() => {
      result.current.confirmPendingTransition();
      result.current.discardPendingTransition();
    });

    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
    expect(harness.spies.navigateToTab).not.toHaveBeenCalled();
    expect(harness.spies.closePanel).not.toHaveBeenCalled();
  });

  it("synchronizes a clean panel when the active map tab changes", () => {
    const harness = createHarness({
      activeEventDate: DAY_TWO,
      currentMapTabName: MAP_TWO,
      panelOpen: true,
      panelMapTab: MAP_ONE,
    });

    renderHook(() => useMapVisitListCommands(harness.ports));

    expect(harness.stores.originalOrder).toEqual(["three"]);
    expect(harness.stores.panelMapTab).toBe(MAP_TWO);
    expect(harness.stores.hasUnsavedChanges).toBe(false);
    expect(harness.spies.requestConfirmClose).not.toHaveBeenCalled();
  });

  it("fail-closes external tab changes while a dirty panel is active", () => {
    const harness = createHarness({
      activeEventDate: DAY_TWO,
      currentMapTabName: MAP_TWO,
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
      originalOrder: ["one", "two"],
    });

    renderHook(() => useMapVisitListCommands(harness.ports));

    expect(harness.stores.confirmDialogOpen).toBe(true);
    expect(harness.stores.pendingTabChange).toBe(DAY_TWO);
    expect(harness.stores.panelMapTab).toBe(MAP_ONE);
    expect(harness.stores.originalOrder).toEqual(["one", "two"]);
    expect(harness.spies.openPanel).not.toHaveBeenCalled();
  });

  it("rejects a duplicate transition request while confirmation is open", () => {
    const harness = createHarness({
      panelOpen: true,
      panelMapTab: MAP_ONE,
      hasUnsavedChanges: true,
      confirmDialogOpen: true,
      pendingTabChange: DAY_TWO,
    });
    const { result } = renderHook(() => useMapVisitListCommands(harness.ports));
    let outcome: MapVisitListTransitionResult = "navigated";

    act(() => {
      outcome = result.current.requestTabChange("eventList" as ActiveTab);
    });

    expect(outcome).toBe("ignored");
    expect(harness.spies.requestConfirmClose).not.toHaveBeenCalled();
    expect(harness.spies.navigateToTab).not.toHaveBeenCalled();
  });
});
