// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RangePresentation } from "../../features/lists/domain/rangeSelection";
import type {
  DayModeState,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import {
  useShoppingSelectionExecutionCommands,
  type ShoppingSelectionExecutionActionPort,
  type ShoppingSelectionExecutionCommandPorts,
  type ShoppingSelectionExecutionStatePort,
} from "./useShoppingSelectionExecutionCommands";

const EVENT = "event-a";
const DAY = "day-1";
const presentation: RangePresentation = {
  scopeKey: `${EVENT}:${DAY}:execute`,
  grouping: "flat",
  groups: [],
  itemIds: ["one", "two"],
};

const item = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `circle-${id}`,
  eventDate: DAY,
  block: "A",
  number: "1",
  title: `title-${id}`,
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

interface HarnessOptions extends Partial<
  Omit<
    ShoppingSelectionExecutionStatePort,
    "executeModeItemsRef" | "spaceGroupDragItemIdsRef"
  >
> {
  eventLists?: Record<string, ShoppingItem[]>;
  executeModeItems?: Record<string, ExecuteModeItems>;
  spaceGroupDragItemIds?: readonly string[] | null;
}

const createHarness = (options: HarnessOptions = {}) => {
  const activeEventName = Object.prototype.hasOwnProperty.call(
    options,
    "activeEventName",
  )
    ? (options.activeEventName ?? null)
    : EVENT;
  const executeColumnItems = options.executeColumnItems ?? [item("one")];
  const stores = {
    dayModes:
      options.dayModes ??
      (activeEventName ? { [activeEventName]: { [DAY]: "edit" } } : {}),
    eventLists:
      options.eventLists ??
      (activeEventName ? { [activeEventName]: [...executeColumnItems] } : {}),
    recentlyChangedItemIds: new Set(options.recentlyChangedItemIds ?? []),
    candidateNumberSortDirection: "asc" as "asc" | "desc" | null,
    focusModeMapVisible: true,
    showPostponeFilterButton: true,
    showLateFilterButton: true,
    sortState: options.sortState ?? ("Manual" as const),
    blockSortDirection: null as "asc" | "desc" | null,
    executeModeItems: options.executeModeItems ?? {},
    executeCollapsedSpaces: new Set<string>(),
  };
  const spaceGroupDragItemIdsRef = {
    current: options.spaceGroupDragItemIds ?? null,
  };
  const executeModeItemsRef = { current: stores.executeModeItems };

  const setDayModes = vi.fn(
    (
      action:
        | Record<string, DayModeState>
        | ((
            current: Record<string, DayModeState>,
          ) => Record<string, DayModeState>),
    ) => {
      stores.dayModes =
        typeof action === "function" ? action(stores.dayModes) : action;
    },
  );
  const setEventLists = vi.fn(
    (
      action:
        | Record<string, ShoppingItem[]>
        | ((
            current: Record<string, ShoppingItem[]>,
          ) => Record<string, ShoppingItem[]>),
    ) => {
      stores.eventLists =
        typeof action === "function" ? action(stores.eventLists) : action;
    },
  );
  const setRecentlyChangedItemIds = vi.fn(
    (action: Set<string> | ((current: Set<string>) => Set<string>)) => {
      stores.recentlyChangedItemIds =
        typeof action === "function"
          ? action(stores.recentlyChangedItemIds)
          : action;
    },
  );
  const setCandidateNumberSortDirection = vi.fn((value: null) => {
    stores.candidateNumberSortDirection = value;
  });
  const setFocusModeMapVisible = vi.fn((value: false) => {
    stores.focusModeMapVisible = value;
  });
  const closeUiSettingsPanel = vi.fn();
  const setShowPostponeFilterButton = vi.fn((value: boolean) => {
    stores.showPostponeFilterButton = value;
  });
  const setShowLateFilterButton = vi.fn((value: boolean) => {
    stores.showLateFilterButton = value;
  });
  const setSortState = vi.fn(
    (value: ShoppingSelectionExecutionStatePort["sortState"]) => {
      stores.sortState = value;
    },
  );
  const setBlockSortDirection = vi.fn((value: "asc" | "desc" | null) => {
    stores.blockSortDirection = value;
  });
  const setExecuteCollapsedSpaces = vi.fn(
    (action: Set<string> | ((current: Set<string>) => Set<string>)) => {
      stores.executeCollapsedSpaces =
        typeof action === "function"
          ? action(stores.executeCollapsedSpaces)
          : action;
    },
  );
  const updateItem = vi.fn();
  const updateExecuteModeItems = vi.fn(
    (
      action:
        | Record<string, ExecuteModeItems>
        | ((
            current: Record<string, ExecuteModeItems>,
          ) => Record<string, ExecuteModeItems>),
    ) => {
      stores.executeModeItems =
        typeof action === "function" ? action(stores.executeModeItems) : action;
      executeModeItemsRef.current = stores.executeModeItems;
    },
  );
  const clearSelection = vi.fn();
  const clearRangeSelection = vi.fn();
  const selectItemForRange = vi.fn();
  const selectSpaceGroupForRange = vi.fn();
  const toggleRangeItemIdsSelection = vi.fn();
  const notify = vi.fn();
  const scheduleCenteredItemScroll = vi.fn();

  const actions: ShoppingSelectionExecutionActionPort = {
    setDayModes,
    setEventLists,
    setRecentlyChangedItemIds,
    setCandidateNumberSortDirection,
    setFocusModeMapVisible,
    closeUiSettingsPanel,
    setShowPostponeFilterButton,
    setShowLateFilterButton,
    setSortState,
    setBlockSortDirection,
    setExecuteCollapsedSpaces,
    updateExecuteModeItems,
    updateItem,
  };
  const ports: ShoppingSelectionExecutionCommandPorts = {
    state: {
      activeEventName,
      activeEventDate: options.activeEventDate ?? DAY,
      currentMode: options.currentMode ?? "edit",
      dayModes: stores.dayModes,
      sortState: options.sortState ?? "Manual",
      executeColumnItems,
      items: options.items ?? executeColumnItems,
      selectedItemIds: options.selectedItemIds ?? new Set(),
      recentlyChangedItemIds: options.recentlyChangedItemIds ?? new Set(),
      executeModeItemsRef,
      spaceGroupDragItemIdsRef,
    },
    interaction: {
      clearSelection,
      clearRangeSelection,
      selectItemForRange,
      selectSpaceGroupForRange,
      toggleRangeItemIdsSelection,
    },
    actions,
    effects: { notify, scheduleCenteredItemScroll },
  };

  return {
    ports,
    stores,
    refs: { executeModeItemsRef, spaceGroupDragItemIdsRef },
    spies: {
      setDayModes,
      setEventLists,
      setRecentlyChangedItemIds,
      setCandidateNumberSortDirection,
      setFocusModeMapVisible,
      closeUiSettingsPanel,
      setShowPostponeFilterButton,
      setShowLateFilterButton,
      setSortState,
      setBlockSortDirection,
      setExecuteCollapsedSpaces,
      updateExecuteModeItems,
      updateItem,
      clearSelection,
      clearRangeSelection,
      selectItemForRange,
      selectSpaceGroupForRange,
      toggleRangeItemIdsSelection,
      notify,
      scheduleCenteredItemScroll,
    },
  };
};

describe("useShoppingSelectionExecutionCommands", () => {
  it("toggles a valid day mode as one transaction and resets selection sort", () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => result.current.toggleMode());

    expect(harness.stores.dayModes[EVENT][DAY]).toBe("execute");
    expect(harness.spies.clearSelection).toHaveBeenCalledOnce();
    expect(harness.spies.setCandidateNumberSortDirection).toHaveBeenCalledWith(
      null,
    );
    expect(harness.spies.notify).not.toHaveBeenCalled();
  });

  it("rejects mode toggles without a day or configured mode", () => {
    const noDay = createHarness({ activeEventDate: "" });
    const missingMode = createHarness({ dayModes: { [EVENT]: {} } });
    const noEvent = createHarness({ activeEventName: null });
    const noDayHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(noDay.ports),
    );
    const missingModeHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(missingMode.ports),
    );
    const noEventHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(noEvent.ports),
    );

    act(() => {
      noDayHook.result.current.toggleMode();
      missingModeHook.result.current.toggleMode();
      noEventHook.result.current.toggleMode();
    });

    expect(noDay.spies.notify).toHaveBeenCalledWith(
      "参加日タブが選択されていないため、表示モードを切り替えできません。",
    );
    expect(missingMode.spies.notify).toHaveBeenCalledWith(
      "表示モードが未設定のため、表示モードを切り替えできません。",
    );
    expect(noEvent.spies.notify).not.toHaveBeenCalled();
    expect(noDay.spies.setDayModes).not.toHaveBeenCalled();
    expect(missingMode.spies.setDayModes).not.toHaveBeenCalled();
    expect(noEvent.spies.setDayModes).not.toHaveBeenCalled();
  });

  it("sets view mode and delegates shell-only scrolling through the effect port", () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => result.current.setViewMode("focus", "item-2"));

    expect(harness.stores.dayModes[EVENT][DAY]).toBe("focus");
    expect(harness.spies.clearSelection).toHaveBeenCalledOnce();
    expect(harness.spies.closeUiSettingsPanel).toHaveBeenCalledOnce();
    expect(harness.spies.scheduleCenteredItemScroll).toHaveBeenCalledWith(
      "item-2",
    );
    expect(harness.spies.setFocusModeMapVisible).not.toHaveBeenCalled();

    act(() => result.current.setViewMode("edit"));
    expect(harness.spies.setFocusModeMapVisible).toHaveBeenCalledWith(false);
  });

  it("routes item, group, range/all selection and drag ownership to their typed ports", () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => {
      result.current.selectItem("one", "execute", presentation);
      result.current.selectSpaceGroup("space-a", ["one", "two"], presentation);
      result.current.toggleItemsSelection(["one", "two"]);
      result.current.setSpaceGroupDragItemIds(["one", "two"]);
      result.current.clearSelection();
    });

    expect(harness.spies.selectItemForRange).toHaveBeenCalledWith(
      "one",
      presentation,
    );
    expect(harness.spies.selectSpaceGroupForRange).toHaveBeenCalledWith(
      "space-a",
      ["one", "two"],
      presentation,
    );
    expect(harness.spies.toggleRangeItemIdsSelection).toHaveBeenCalledWith([
      "one",
      "two",
    ]);
    expect(harness.refs.spaceGroupDragItemIdsRef.current).toEqual([
      "one",
      "two",
    ]);
    expect(harness.spies.clearSelection).toHaveBeenCalledOnce();
  });

  it("changes a whole execute group while preserving LimitedPurchase items", () => {
    const groupItem = item("group", { block: "B", number: "2" });
    const limitedItem = item("limited", {
      block: "B",
      number: "2",
      purchaseStatus: "LimitedPurchase",
      limitedPurchasedQuantity: 1,
    });
    const completedItem = item("completed", {
      purchaseStatus: "Purchased",
    });
    const harness = createHarness({
      eventLists: { [EVENT]: [completedItem, groupItem, limitedItem] },
      executeColumnItems: [completedItem, groupItem, limitedItem],
      sortState: "Manual",
    });
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );
    harness.spies.setShowPostponeFilterButton.mockClear();

    act(() => {
      result.current.setExecuteSpaceGroupOrder(["A-1", "B-2"]);
      result.current.changeBulkStatus("B-2", "Purchased", [
        groupItem,
        limitedItem,
      ]);
    });

    expect(
      harness.stores.eventLists[EVENT].map((entry) => entry.purchaseStatus),
    ).toEqual(["Purchased", "Purchased", "LimitedPurchase"]);
    expect(harness.stores.recentlyChangedItemIds).toEqual(
      new Set(["group", "limited"]),
    );
    expect(harness.spies.setShowPostponeFilterButton).toHaveBeenCalledWith(
      true,
    );
  });

  it("uses synchronized execute/recent snapshots for manual and postpone progression", () => {
    const completed = item("completed", { purchaseStatus: "Purchased" });
    const target = item("target", { block: "B", number: "2" });
    const manual = createHarness({
      executeColumnItems: [completed, target],
      sortState: "Manual",
    });
    const postponePeer = item("postpone", {
      block: "B",
      number: "2",
      purchaseStatus: "Postpone",
    });
    const postpone = createHarness({
      executeColumnItems: [postponePeer, target],
      recentlyChangedItemIds: new Set(["target"]),
      sortState: "Postpone",
    });
    const manualHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(manual.ports),
    );
    const postponeHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(postpone.ports),
    );
    manual.spies.setShowPostponeFilterButton.mockClear();
    postpone.spies.setShowLateFilterButton.mockClear();

    act(() => {
      manualHook.result.current.setExecuteSpaceGroupOrder(["A-1", "B-2"]);
      manualHook.result.current.updateExecuteItem({
        ...target,
        purchaseStatus: "Purchased",
      });
      postponeHook.result.current.setExecuteSpaceGroupOrder(["B-2"]);
      postponeHook.result.current.updateExecuteItem({
        ...target,
        purchaseStatus: "Purchased",
      });
    });

    expect(manual.spies.updateItem).toHaveBeenCalledWith({
      ...target,
      purchaseStatus: "Purchased",
    });
    expect(manual.spies.setShowPostponeFilterButton).toHaveBeenCalledWith(true);
    expect(postpone.spies.setShowLateFilterButton).toHaveBeenCalledWith(true);
  });

  it("activates progression filters with changed-id reset", () => {
    const harness = createHarness();
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );
    harness.spies.setShowPostponeFilterButton.mockClear();
    harness.spies.setShowLateFilterButton.mockClear();

    act(() => {
      result.current.activatePostponeFilter();
      result.current.activateLateFilter();
    });

    expect(harness.spies.setRecentlyChangedItemIds).toHaveBeenCalledTimes(2);
    expect(harness.stores.recentlyChangedItemIds).toEqual(new Set());
    expect(harness.spies.setSortState).toHaveBeenNthCalledWith(1, "Postpone");
    expect(harness.spies.setSortState).toHaveBeenNthCalledWith(2, "Late");
    expect(harness.spies.setShowPostponeFilterButton).toHaveBeenCalledWith(
      false,
    );
    expect(harness.spies.setShowLateFilterButton).toHaveBeenCalledWith(false);
  });

  it("collapses the current execute group and opens its deterministic successor", () => {
    const harness = createHarness();
    harness.stores.executeCollapsedSpaces = new Set(["group-b"]);
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => {
      result.current.setExecuteSpaceGroupOrder([
        "group-a",
        "group-b",
        "group-c",
      ]);
      result.current.collapseAndOpenNext("group-a");
    });

    expect(harness.stores.executeCollapsedSpaces).toEqual(new Set(["group-a"]));
    expect(harness.spies.clearRangeSelection).toHaveBeenCalledOnce();
  });

  it("sorts selected execute-column ids and preserves item status payloads", () => {
    const selected9 = item("selected-9", {
      number: "9",
      purchaseStatus: "LimitedPurchase",
    });
    const middle = item("middle", { number: "5" });
    const selected2 = item("selected-2", { number: "2" });
    const items = [selected9, middle, selected2];
    const harness = createHarness({
      items,
      executeColumnItems: items,
      selectedItemIds: new Set(["selected-9", "selected-2"]),
      executeModeItems: {
        [EVENT]: { [DAY]: ["selected-9", "middle", "selected-2"] },
      },
    });
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => result.current.sortSelectedItems("asc"));

    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "selected-2",
      "selected-9",
      "middle",
    ]);
    expect(selected9.purchaseStatus).toBe("LimitedPurchase");
    expect(harness.spies.setEventLists).not.toHaveBeenCalled();
    expect(harness.spies.clearRangeSelection).toHaveBeenCalledOnce();
    expect(harness.stores.sortState).toBe("Manual");
    expect(harness.stores.blockSortDirection).toBeNull();
  });

  it("sorts candidate-column slots without moving execute ids", () => {
    const candidate9 = item("candidate-9", { number: "9" });
    const execute = item("execute", { number: "1" });
    const candidate5 = item("candidate-5", { number: "5" });
    const candidate2 = item("candidate-2", {
      number: "2",
      purchaseStatus: "LimitedPurchase",
    });
    const items = [candidate9, execute, candidate5, candidate2];
    const harness = createHarness({
      items,
      eventLists: { [EVENT]: items },
      selectedItemIds: new Set(["candidate-9", "candidate-2"]),
      executeModeItems: { [EVENT]: { [DAY]: ["execute"] } },
    });
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => result.current.sortSelectedItems("asc"));

    expect(harness.stores.eventLists[EVENT].map(({ id }) => id)).toEqual([
      "candidate-2",
      "execute",
      "candidate-9",
      "candidate-5",
    ]);
    expect(harness.stores.eventLists[EVENT][0].purchaseStatus).toBe(
      "LimitedPurchase",
    );
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual(["execute"]);
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
  });

  it("fails closed for mixed columns after resetting only sort presentation", () => {
    const execute = item("execute", { number: "9" });
    const candidate = item("candidate", { number: "2" });
    const items = [execute, candidate];
    const harness = createHarness({
      items,
      eventLists: { [EVENT]: items },
      selectedItemIds: new Set(["execute", "candidate"]),
      executeModeItems: { [EVENT]: { [DAY]: ["execute"] } },
    });
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => result.current.sortSelectedItems("desc"));

    expect(harness.spies.setEventLists).not.toHaveBeenCalled();
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
    expect(harness.spies.clearRangeSelection).toHaveBeenCalledOnce();
    expect(harness.stores.sortState).toBe("Manual");
    expect(harness.stores.blockSortDirection).toBeNull();
  });

  it("sorts the selected event rows outside edit mode without changing payloads", () => {
    const selected10 = item("selected-10", {
      number: "10",
      purchaseStatus: "LimitedPurchase",
    });
    const other = item("other", { number: "5" });
    const selected2 = item("selected-2", { number: "2" });
    const items = [selected10, other, selected2];
    const harness = createHarness({
      currentMode: "execute",
      dayModes: { [EVENT]: { [DAY]: "execute" } },
      items,
      eventLists: { [EVENT]: items },
      selectedItemIds: new Set(["selected-10", "selected-2"]),
    });
    const { result } = renderHook(() =>
      useShoppingSelectionExecutionCommands(harness.ports),
    );

    act(() => result.current.sortSelectedItems("asc"));

    expect(harness.stores.eventLists[EVENT].map(({ id }) => id)).toEqual([
      "selected-2",
      "selected-10",
      "other",
    ]);
    expect(harness.stores.eventLists[EVENT][1].purchaseStatus).toBe(
      "LimitedPurchase",
    );
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
  });

  it("does not reset sorting without an active event or selection", () => {
    const emptySelection = createHarness({ selectedItemIds: new Set() });
    const noActiveEvent = createHarness({
      activeEventName: null,
      selectedItemIds: new Set(["one"]),
    });
    const emptySelectionHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(emptySelection.ports),
    );
    const noActiveEventHook = renderHook(() =>
      useShoppingSelectionExecutionCommands(noActiveEvent.ports),
    );

    act(() => {
      emptySelectionHook.result.current.sortSelectedItems("asc");
      noActiveEventHook.result.current.sortSelectedItems("asc");
    });

    for (const harness of [emptySelection, noActiveEvent]) {
      expect(harness.spies.clearRangeSelection).not.toHaveBeenCalled();
      expect(harness.spies.setSortState).not.toHaveBeenCalled();
      expect(harness.spies.setBlockSortDirection).not.toHaveBeenCalled();
    }
  });
});
