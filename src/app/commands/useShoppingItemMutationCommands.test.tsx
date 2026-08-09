// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import { getItemKey } from "../../utils/itemComparison";
import type { PendingDuplicateEventImport } from "../state/appOverlayTypes";
import {
  useShoppingItemMutationCommands,
  type BulkAddItemInput,
  type ShoppingItemMutationActionPort,
  type ShoppingItemMutationCommandPorts,
  type ShoppingItemMutationStatePort,
} from "./useShoppingItemMutationCommands";

const EVENT = "event-a";
const DAY = "day-1";

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

const bulkItem = (
  circle: string,
  overrides: Partial<BulkAddItemInput> = {},
): BulkAddItemInput => ({
  circle,
  eventDate: DAY,
  block: "A",
  number: "1",
  title: `title-${circle}`,
  price: null,
  quantity: 1,
  remarks: "",
  ...overrides,
});

interface HarnessStores {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  dayModes: Record<string, DayModeState>;
  executeModeItems: Record<string, ExecuteModeItems>;
  recentlyChangedItemIds: Set<string>;
  pendingDuplicateEvent: PendingDuplicateEventImport | null;
  blockSortDirection: "asc" | "desc" | null;
  candidateNumberSortDirection: "asc" | "desc" | null;
}

interface HarnessOptions extends Partial<
  Pick<
    ShoppingItemMutationStatePort,
    | "activeEventName"
    | "activeEventDate"
    | "eventLists"
    | "eventMetadata"
    | "dayModes"
    | "items"
    | "selectedItemIds"
    | "selectedBlockFilters"
    | "blockSortDirection"
    | "candidateNumberSortDirection"
    | "itemToDelete"
  >
> {
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
  const defaultItems = [item("one")];
  const initialEventLists =
    options.eventLists ??
    (activeEventName ? { [activeEventName]: defaultItems } : {});
  const stores: HarnessStores = {
    eventLists: initialEventLists,
    eventMetadata: options.eventMetadata ?? {},
    dayModes:
      options.dayModes ??
      (activeEventName ? { [activeEventName]: { [DAY]: "edit" } } : {}),
    executeModeItems: options.executeModeItems ?? {},
    recentlyChangedItemIds: new Set(),
    pendingDuplicateEvent: null,
    blockSortDirection: options.blockSortDirection ?? null,
    candidateNumberSortDirection: options.candidateNumberSortDirection ?? null,
  };
  const executeModeItemsRef = { current: stores.executeModeItems };
  const spaceGroupDragItemIdsRef = {
    current: options.spaceGroupDragItemIds ?? null,
  };
  const eventUpdatePreviewEpochRef = { current: 0 };

  const setEventLists = vi.fn(
    (
      updater: (
        current: Record<string, ShoppingItem[]>,
      ) => Record<string, ShoppingItem[]>,
    ) => {
      stores.eventLists = updater(stores.eventLists);
    },
  );
  const setEventMetadata = vi.fn(
    (
      updater: (
        current: Record<string, EventMetadata>,
      ) => Record<string, EventMetadata>,
    ) => {
      stores.eventMetadata = updater(stores.eventMetadata);
    },
  );
  const setDayModes = vi.fn(
    (
      updater: (
        current: Record<string, DayModeState>,
      ) => Record<string, DayModeState>,
    ) => {
      stores.dayModes = updater(stores.dayModes);
    },
  );
  const updateExecuteModeItems = vi.fn(
    (
      updater: (
        current: Record<string, ExecuteModeItems>,
      ) => Record<string, ExecuteModeItems>,
    ) => {
      stores.executeModeItems = updater(stores.executeModeItems);
      executeModeItemsRef.current = stores.executeModeItems;
    },
  );
  const setRecentlyChangedItemIds = vi.fn(
    (updater: (current: Set<string>) => Set<string>) => {
      stores.recentlyChangedItemIds = updater(stores.recentlyChangedItemIds);
    },
  );
  const openDuplicateEvent = vi.fn((value: PendingDuplicateEventImport) => {
    stores.pendingDuplicateEvent = value;
  });
  const openEvent = vi.fn();
  const showImport = vi.fn();
  const clearRangeSelection = vi.fn();
  const clearSelection = vi.fn();
  const setSortState = vi.fn();
  const setBlockSortDirection = vi.fn((value: "asc" | "desc" | null) => {
    stores.blockSortDirection = value;
  });
  const setCandidateNumberSortDirection = vi.fn(
    (value: "asc" | "desc" | null) => {
      stores.candidateNumberSortDirection = value;
    },
  );
  const confirmItemDelete = vi.fn();
  const notify = vi.fn();
  const areItemsInSameHall = vi.fn(() => true);
  const areItemsInSameHallGroup = vi.fn(() => true);

  const actions: ShoppingItemMutationActionPort = {
    setEventLists,
    setEventMetadata,
    setDayModes,
    updateExecuteModeItems,
    setRecentlyChangedItemIds,
    openDuplicateEvent,
    clearRangeSelection,
    clearSelection,
    setSortState,
    setBlockSortDirection,
    setCandidateNumberSortDirection,
    confirmItemDelete,
    navigation: { openEvent, showImport },
  };
  const state: ShoppingItemMutationStatePort = {
    activeEventName,
    activeEventDate: options.activeEventDate ?? DAY,
    eventLists: initialEventLists,
    eventMetadata: stores.eventMetadata,
    dayModes: stores.dayModes,
    items:
      options.items ??
      (activeEventName ? initialEventLists[activeEventName] || [] : []),
    selectedItemIds: options.selectedItemIds ?? new Set(),
    selectedBlockFilters: options.selectedBlockFilters ?? new Set(),
    blockSortDirection: options.blockSortDirection ?? null,
    candidateNumberSortDirection: options.candidateNumberSortDirection ?? null,
    itemToDelete: options.itemToDelete ?? null,
    executeModeItemsRef,
    spaceGroupDragItemIdsRef,
    eventUpdatePreviewEpochRef,
  };
  const ports: ShoppingItemMutationCommandPorts = {
    state,
    actions,
    selectors: { areItemsInSameHall, areItemsInSameHallGroup },
    alerts: { notify },
    persistence: {
      commitApplicationSnapshotPatch: vi.fn(async () => undefined),
    },
  };

  return {
    ports,
    stores,
    refs: {
      executeModeItemsRef,
      spaceGroupDragItemIdsRef,
      eventUpdatePreviewEpochRef,
    },
    spies: {
      setEventLists,
      setEventMetadata,
      setDayModes,
      updateExecuteModeItems,
      setRecentlyChangedItemIds,
      openDuplicateEvent,
      openEvent,
      showImport,
      clearRangeSelection,
      clearSelection,
      setSortState,
      setBlockSortDirection,
      setCandidateNumberSortDirection,
      confirmItemDelete,
      notify,
      areItemsInSameHall,
      areItemsInSameHallGroup,
    },
  };
};

describe("useShoppingItemMutationCommands", () => {
  it("commits a new bulk event through all related stores before navigation", async () => {
    const harness = createHarness({
      activeEventName: null,
      eventLists: {},
      eventMetadata: {},
      dayModes: {},
      items: [],
      executeModeItems: {},
    });
    const inputs = [
      bulkItem("circle-a"),
      bulkItem("circle-b", { eventDate: "day-2" }),
    ];
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    await act(() =>
      result.current.applyBulkAdd("new-event", inputs, {
        url: "https://docs.google.com/spreadsheets/d/source/edit",
        sheetName: "Sheet1",
        source: "spreadsheet",
      }),
    );

    expect(harness.stores.eventLists["new-event"]).toHaveLength(2);
    expect(harness.stores.eventLists["new-event"][0]).toMatchObject({
      source: "spreadsheet",
      protectionLevel: "none",
      catalogPrice: null,
      sheetRemarks: "",
    });
    expect(harness.stores.dayModes["new-event"]).toEqual({
      "day-1": "edit",
      "day-2": "edit",
    });
    expect(harness.stores.executeModeItems["new-event"]).toEqual({
      "day-1": [],
      "day-2": [],
    });
    expect(harness.stores.eventMetadata["new-event"]).toMatchObject({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/source/edit",
      spreadsheetSheetName: "Sheet1",
    });
    expect(harness.spies.notify).toHaveBeenCalledWith(
      "2 items imported into a new event.",
    );
    expect(harness.spies.openEvent).toHaveBeenCalledWith("new-event", "day-1");
  });

  it("restores explicit layout and execute order in one new-event transaction", async () => {
    const harness = createHarness({
      activeEventName: null,
      eventLists: {},
      dayModes: {},
      items: [],
      executeModeItems: {},
    });
    const candidate = bulkItem("candidate");
    const execute = bulkItem("execute");
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    await act(() =>
      result.current.applyBulkAdd("layout-event", [candidate, execute], {
        source: "app",
        layoutInfo: [
          {
            itemKey: getItemKey(candidate),
            eventDate: DAY,
            columnType: "candidate",
            order: 0,
          },
          {
            itemKey: getItemKey(execute),
            eventDate: DAY,
            columnType: "execute",
            order: 0,
          },
        ],
      }),
    );

    const storedItems = harness.stores.eventLists["layout-event"];
    expect(storedItems.map((stored) => stored.circle)).toEqual([
      "execute",
      "candidate",
    ]);
    expect(harness.stores.executeModeItems["layout-event"][DAY]).toEqual([
      storedItems[0].id,
    ]);
    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledOnce();
  });

  it("leaves every bulk-add state slice unchanged when the atomic commit fails", async () => {
    const harness = createHarness({
      activeEventName: null,
      eventLists: {},
      eventMetadata: {},
      dayModes: {},
      executeModeItems: {},
    });
    harness.ports.persistence.commitApplicationSnapshotPatch = vi.fn(
      async () => {
        throw new Error("transaction aborted");
      },
    );
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    await act(() =>
      result.current.applyBulkAdd("new-event", [bulkItem("candidate")]),
    );

    expect(harness.stores.eventLists).toEqual({});
    expect(harness.stores.eventMetadata).toEqual({});
    expect(harness.stores.dayModes).toEqual({});
    expect(harness.stores.executeModeItems).toEqual({});
    expect(harness.spies.openEvent).not.toHaveBeenCalled();
  });

  it("invalidates stale preview and defers duplicate event mutation", () => {
    const existing = item("existing");
    const harness = createHarness({
      eventLists: { [EVENT]: [existing] },
      items: [existing],
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    let accepted = true;
    act(() => {
      accepted = result.current.handleBulkAdd(EVENT, [bulkItem("incoming")], {
        source: "spreadsheet",
      });
    });

    expect(accepted).toBe(false);
    expect(harness.refs.eventUpdatePreviewEpochRef.current).toBe(1);
    expect(harness.stores.pendingDuplicateEvent?.analysis.kind).toBe(
      "different-source",
    );
    expect(harness.spies.setEventLists).not.toHaveBeenCalled();
  });

  it("allows explicit app additions to the open event without duplicate review", async () => {
    const existing = item("existing");
    const harness = createHarness({
      eventLists: { [EVENT]: [existing] },
      items: [existing],
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    let accepted = false;
    await act(async () => {
      accepted = result.current.handleBulkAdd(EVENT, [bulkItem("manual")], {
        source: "app",
      });
      await Promise.resolve();
    });

    expect(accepted).toBe(true);
    expect(harness.stores.eventLists[EVENT]).toHaveLength(2);
    expect(harness.stores.eventLists[EVENT][1]).toMatchObject({
      source: "app",
      protectionLevel: "full",
    });
    expect(harness.stores.pendingDuplicateEvent).toBeNull();
  });

  it("updates the current transaction and marks status or quantity changes", () => {
    const original = item("changing", {
      source: "spreadsheet",
      protectionLevel: "none",
    });
    const harness = createHarness({
      eventLists: { [EVENT]: [original] },
      dayModes: { [EVENT]: { [DAY]: "execute" } },
      items: [original],
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );
    harness.stores.eventLists = {
      [EVENT]: [original, item("concurrent")],
    };

    act(() =>
      result.current.updateItem({
        ...original,
        purchaseStatus: "Purchased",
        quantity: 2,
      }),
    );

    expect(harness.stores.eventLists[EVENT][0]).toMatchObject({
      purchaseStatus: "Purchased",
      quantity: 2,
      protectionLevel: "deletable",
    });
    expect(harness.stores.eventLists[EVENT].map(({ id }) => id)).toEqual([
      "changing",
      "concurrent",
    ]);
    expect(harness.stores.recentlyChangedItemIds).toEqual(
      new Set(["changing"]),
    );
  });

  it("uses hall-group adjacency for multi-space drag and consumes its override", () => {
    const items = [
      item("a", { block: "A", number: "1" }),
      item("b", { block: "B", number: "1" }),
      item("c", { block: "C", number: "1" }),
    ];
    const harness = createHarness({
      eventLists: { [EVENT]: items },
      items,
      selectedItemIds: new Set(["b"]),
      executeModeItems: { [EVENT]: { [DAY]: ["a", "b", "c"] } },
      spaceGroupDragItemIds: ["a", "c"],
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.moveItem("a", "b", "execute", "execute"));

    expect(harness.refs.spaceGroupDragItemIdsRef.current).toBeNull();
    expect(harness.spies.areItemsInSameHallGroup).toHaveBeenCalledWith(
      "a",
      "b",
      DAY,
    );
    expect(harness.spies.areItemsInSameHall).not.toHaveBeenCalled();
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(harness.spies.clearRangeSelection).toHaveBeenCalledOnce();
    expect(harness.spies.setSortState).toHaveBeenCalledWith("Manual");
    expect(harness.spies.setBlockSortDirection).toHaveBeenCalledWith(null);
  });

  it("moves an execute space-priority block across the adjacent block", () => {
    const items = [
      item("a", { block: "A", number: "1" }),
      item("b-1", { block: "B", number: "1" }),
      item("b-2", { block: "B", number: "1" }),
      item("c", { block: "C", number: "1" }),
    ];
    const harness = createHarness({
      eventLists: { [EVENT]: items },
      items,
      executeModeItems: {
        [EVENT]: { [DAY]: ["a", "b-1", "b-2", "c"] },
      },
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.moveItemDown("b-1", "execute"));

    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "a",
      "c",
      "b-1",
      "b-2",
    ]);
    expect(harness.spies.areItemsInSameHall).not.toHaveBeenCalled();
    expect(harness.spies.areItemsInSameHallGroup).not.toHaveBeenCalled();
  });

  it("uses the synchronously committed execute order across immediate column commands", () => {
    const items = [
      item("execute", { block: "A", number: "1" }),
      item("candidate-1", { block: "B", number: "2" }),
      item("candidate-2", { block: "B", number: "2" }),
    ];
    const harness = createHarness({
      eventLists: { [EVENT]: items },
      items,
      executeModeItems: { [EVENT]: { [DAY]: ["execute"] } },
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.moveToExecuteColumn(["candidate-1"]));
    expect(harness.refs.executeModeItemsRef.current[EVENT][DAY]).toEqual([
      "execute",
      "candidate-1",
      "candidate-2",
    ]);

    act(() => result.current.removeFromExecuteColumn(["candidate-1"]));
    expect(harness.refs.executeModeItemsRef.current[EVENT][DAY]).toEqual([
      "execute",
    ]);
    expect(harness.spies.clearSelection).toHaveBeenCalledTimes(2);
  });

  it("deletes one item from the event and every execute day before confirming", () => {
    const deleted = item("deleted");
    const kept = item("kept");
    const harness = createHarness({
      eventLists: { [EVENT]: [deleted, kept] },
      items: [deleted, kept],
      itemToDelete: deleted,
      executeModeItems: {
        [EVENT]: { [DAY]: ["kept", "deleted"], "day-2": ["deleted"] },
      },
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.confirmDeleteItem());

    expect(harness.stores.eventLists[EVENT]).toEqual([kept]);
    expect(harness.stores.executeModeItems[EVENT]).toEqual({
      [DAY]: ["kept"],
      "day-2": [],
    });
    expect(harness.spies.confirmItemDelete).toHaveBeenCalledOnce();
  });

  it("sorts only the active date by block and keeps empty blocks last", () => {
    const otherDate = item("other", { eventDate: "day-2", block: "0" });
    const block10 = item("block-10", { block: "A10" });
    const empty = item("empty", { block: "" });
    const block2 = item("block-2", { block: "A2" });
    const harness = createHarness({
      eventLists: { [EVENT]: [block10, otherDate, empty, block2] },
      items: [block10, otherDate, empty, block2],
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.toggleBlockSort());

    expect(harness.stores.eventLists[EVENT].map(({ id }) => id)).toEqual([
      "block-2",
      "other",
      "block-10",
      "empty",
    ]);
    expect(harness.stores.blockSortDirection).toBe("asc");
    expect(harness.spies.clearSelection).toHaveBeenCalledOnce();
  });

  it("sorts candidate blocks without moving execute-column slots", () => {
    const candidateB = item("candidate-b", { block: "B" });
    const execute = item("execute", { block: "Z" });
    const candidateA = item("candidate-a", { block: "A" });
    const harness = createHarness({
      eventLists: { [EVENT]: [candidateB, execute, candidateA] },
      items: [candidateB, execute, candidateA],
      executeModeItems: { [EVENT]: { [DAY]: ["execute"] } },
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.toggleCandidateBlockSort());

    expect(harness.stores.eventLists[EVENT].map(({ id }) => id)).toEqual([
      "candidate-a",
      "execute",
      "candidate-b",
    ]);
    expect(harness.stores.blockSortDirection).toBe("asc");
  });

  it("sorts only candidate numbers inside the selected block filter", () => {
    const a10 = item("a-10", { block: "A", number: "10" });
    const b1 = item("b-1", { block: "B", number: "1" });
    const execute = item("execute", { block: "A", number: "0" });
    const a2 = item("a-2", { block: "A", number: "2" });
    const harness = createHarness({
      eventLists: { [EVENT]: [a10, b1, execute, a2] },
      items: [a10, b1, execute, a2],
      selectedBlockFilters: new Set(["A"]),
      executeModeItems: { [EVENT]: { [DAY]: ["execute"] } },
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => result.current.toggleCandidateNumberSort());

    expect(harness.stores.eventLists[EVENT].map(({ id }) => id)).toEqual([
      "a-2",
      "b-1",
      "execute",
      "a-10",
    ]);
    expect(harness.stores.candidateNumberSortDirection).toBe("asc");
    expect(harness.spies.clearSelection).toHaveBeenCalledOnce();
  });

  it("does not mutate or reset selection when no event is active", () => {
    const harness = createHarness({
      activeEventName: null,
      eventLists: {},
      items: [],
      executeModeItems: {},
    });
    const { result } = renderHook(() =>
      useShoppingItemMutationCommands(harness.ports),
    );

    act(() => {
      result.current.updateItem(item("ignored"));
      result.current.moveItem("a", "b");
      result.current.moveItemUp("a");
      result.current.moveToExecuteColumn(["a"]);
      result.current.removeFromExecuteColumn(["a"]);
      result.current.confirmDeleteItem();
      result.current.toggleBlockSort();
      result.current.toggleCandidateBlockSort();
      result.current.toggleCandidateNumberSort();
    });

    expect(harness.spies.setEventLists).not.toHaveBeenCalled();
    expect(harness.spies.updateExecuteModeItems).not.toHaveBeenCalled();
    expect(harness.spies.clearRangeSelection).not.toHaveBeenCalled();
    expect(harness.spies.clearSelection).not.toHaveBeenCalled();
    expect(harness.spies.confirmItemDelete).not.toHaveBeenCalled();
  });
});
