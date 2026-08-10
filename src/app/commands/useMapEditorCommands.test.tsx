// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  CellSelectionMode,
  PendingCellSelection,
  PendingVertexSelection,
  VertexSelectionMode,
} from "../../features/app-shell/types";
import type {
  BlockDefinition,
  DayMapData,
  HallDefinition,
  HallDefinitionsStore,
  HallRouteSettingsStore,
  MapDataStore,
} from "../../types/map";
import { getMaplessKey } from "../../types/map";
import type {
  ExecuteModeItems,
  PurchaseStatus,
  ShoppingItem,
} from "../../types/item";
import type { NewItemDefaults } from "../state/useAppUiState";
import {
  sortMapEditorVerticesNonCrossing,
  useMapEditorCommands,
  type MapEditorActionPort,
  type MapEditorCommandPorts,
  type MapEditorStatePort,
} from "./useMapEditorCommands";

const EVENT = "イベントA";
const DAY = "1日目";
const MAP = "配置図";

const block = (name: string): BlockDefinition => ({
  name,
  startRow: 1,
  startCol: 1,
  endRow: 2,
  endCol: 2,
  numberCells: [],
});

const mapData = (blocks: BlockDefinition[] = [block("A")]): DayMapData => ({
  maxRow: 10,
  maxCol: 10,
  cells: [],
  mergedCells: [],
  blocks,
});

const polygonHall = (
  id: string,
  overrides: Partial<HallDefinition> = {},
): HallDefinition => ({
  id,
  name: `会場-${id}`,
  vertices: [
    { row: 0, col: 0 },
    { row: 0, col: 2 },
    { row: 2, col: 2 },
    { row: 2, col: 0 },
  ],
  ...overrides,
});

const maplessHall = (id: string): HallDefinition => ({
  id,
  name: `手動-${id}`,
  vertices: [],
  blockNames: ["A"],
});

const shoppingItem = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `サークル-${id}`,
  eventDate: DAY,
  block: "A",
  number: "01",
  title: `頒布物-${id}`,
  price: 1000,
  quantity: 1,
  purchaseStatus: "None",
  remarks: "",
  priorityLevel: "priority",
  ...overrides,
});

const applyStateAction = <T,>(current: T, action: SetStateAction<T>): T =>
  typeof action === "function"
    ? (action as (previous: T) => T)(current)
    : action;

interface HarnessStores {
  eventLists: Record<string, ShoppingItem[]>;
  executeModeItems: Record<string, ExecuteModeItems>;
  mapData: MapDataStore;
  hallDefinitions: HallDefinitionsStore;
  hallRouteSettings: HallRouteSettingsStore;
  blockDefinitionMode: boolean;
  hallDefinitionMode: boolean;
  cellSelectionMode: CellSelectionMode;
  pendingCellSelection: PendingCellSelection;
  vertexSelectionMode: VertexSelectionMode;
  pendingVertexSelection: PendingVertexSelection;
  newItemDefaults: NewItemDefaults | null;
  itemToEdit: ShoppingItem | null;
}

interface HarnessOptions extends Partial<
  Pick<
    MapEditorStatePort,
    | "activeEventName"
    | "activeEventDate"
    | "isMapTab"
    | "currentMapTabName"
    | "currentMapData"
  >
> {
  hallDefinitions?: HallDefinitionsStore;
  hallRouteSettings?: HallRouteSettingsStore;
  eventLists?: Record<string, ShoppingItem[]>;
  executeModeItems?: Record<string, ExecuteModeItems>;
  cellSelectionMode?: CellSelectionMode;
  vertexSelectionMode?: VertexSelectionMode;
  getMapTabForDate?: (eventDate: string) => string | null;
  getItemHallId?: (item: ShoppingItem, eventDate: string) => string | null;
  areItemsInSameHallGroup?: (
    firstItemId: string,
    secondItemId: string,
    eventDate: string,
  ) => boolean;
}

const createHarness = (options: HarnessOptions = {}) => {
  const activeEventName = Object.prototype.hasOwnProperty.call(
    options,
    "activeEventName",
  )
    ? (options.activeEventName ?? null)
    : EVENT;
  const currentMapTabName = Object.prototype.hasOwnProperty.call(
    options,
    "currentMapTabName",
  )
    ? (options.currentMapTabName ?? null)
    : MAP;
  const initialItems = options.eventLists?.[EVENT] ?? [
    shoppingItem("a1"),
    shoppingItem("a2"),
    shoppingItem("b1", {
      block: "B",
      number: "02",
      priorityLevel: "none",
    }),
  ];
  const stores: HarnessStores = {
    eventLists: options.eventLists ?? { [EVENT]: initialItems },
    executeModeItems:
      options.executeModeItems ??
      ({ [EVENT]: { [DAY]: [] } } as Record<string, ExecuteModeItems>),
    mapData: {
      [EVENT]: {
        [MAP]: mapData(),
        別マップ: mapData([block("別")]),
      },
    },
    hallDefinitions:
      options.hallDefinitions ??
      ({
        [EVENT]: {
          [MAP]: [polygonHall("polygon", { blockNames: ["A", "B"] })],
          [getMaplessKey(DAY)]: [maplessHall("manual")],
        },
      } satisfies HallDefinitionsStore),
    hallRouteSettings:
      options.hallRouteSettings ??
      ({
        [EVENT]: {
          [MAP]: {
            hallOrder: ["polygon", "removed"],
            hallVisitLists: [],
          },
          [getMaplessKey(DAY)]: {
            hallOrder: ["manual", "removed"],
            hallVisitLists: [],
          },
        },
      } satisfies HallRouteSettingsStore),
    blockDefinitionMode: true,
    hallDefinitionMode: true,
    cellSelectionMode: options.cellSelectionMode ?? null,
    pendingCellSelection: null,
    vertexSelectionMode: options.vertexSelectionMode ?? null,
    pendingVertexSelection: null,
    newItemDefaults: null,
    itemToEdit: null,
  };
  const selectionEventTarget = new EventTarget();
  const executeModeItemsRef = { current: stores.executeModeItems };

  const setMapData = vi.fn((action: SetStateAction<MapDataStore>) => {
    stores.mapData = applyStateAction(stores.mapData, action);
  });
  const setHallDefinitions = vi.fn(
    (action: SetStateAction<HallDefinitionsStore>) => {
      stores.hallDefinitions = applyStateAction(stores.hallDefinitions, action);
    },
  );
  const setHallRouteSettings = vi.fn(
    (action: SetStateAction<HallRouteSettingsStore>) => {
      stores.hallRouteSettings = applyStateAction(
        stores.hallRouteSettings,
        action,
      );
    },
  );
  const setEventLists = vi.fn(
    (action: SetStateAction<Record<string, ShoppingItem[]>>) => {
      stores.eventLists = applyStateAction(stores.eventLists, action);
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
  const commitExecuteModeItemsForEvent = vi.fn(
    (eventName: string, next: ExecuteModeItems) => {
      stores.executeModeItems = {
        ...stores.executeModeItems,
        [eventName]: next,
      };
      executeModeItemsRef.current = stores.executeModeItems;
    },
  );
  const setNewItemDefaults = vi.fn(
    (action: SetStateAction<NewItemDefaults | null>) => {
      stores.newItemDefaults = applyStateAction(stores.newItemDefaults, action);
    },
  );
  const setItemToEdit = vi.fn((action: SetStateAction<ShoppingItem | null>) => {
    stores.itemToEdit = applyStateAction(stores.itemToEdit, action);
  });
  const showImport = vi.fn();
  const startCellSelection = vi.fn(
    (selection: NonNullable<CellSelectionMode>) => {
      stores.cellSelectionMode = selection;
      stores.blockDefinitionMode = false;
    },
  );
  const toggleCellSelection = vi.fn(
    ({ row, col }: { row: number; col: number }) => {
      const current = stores.cellSelectionMode;
      if (!current) return;
      const existingIndex = current.clickedCells.findIndex(
        (cell) => cell.row === row && cell.col === col,
      );
      stores.cellSelectionMode = {
        ...current,
        clickedCells:
          existingIndex >= 0
            ? current.clickedCells.filter(
                (_cell, index) => index !== existingIndex,
              )
            : [...current.clickedCells, { row, col }],
      };
    },
  );
  const finishCellSelection = vi.fn((pending: PendingCellSelection) => {
    stores.pendingCellSelection = pending;
    stores.cellSelectionMode = null;
    stores.blockDefinitionMode = true;
  });
  const startVertexSelection = vi.fn(
    (selection: NonNullable<VertexSelectionMode>) => {
      stores.vertexSelectionMode = selection;
      stores.hallDefinitionMode = false;
    },
  );
  const toggleVertexSelection = vi.fn(
    ({ row, col }: { row: number; col: number }) => {
      const current = stores.vertexSelectionMode;
      if (!current) return;
      const existingIndex = current.clickedVertices.findIndex(
        (vertex) => vertex.row === row && vertex.col === col,
      );
      if (existingIndex >= 0) {
        stores.vertexSelectionMode = {
          ...current,
          clickedVertices: current.clickedVertices.filter(
            (_vertex, index) => index !== existingIndex,
          ),
        };
        return;
      }
      if (current.clickedVertices.length >= 6) return;
      stores.vertexSelectionMode = {
        ...current,
        clickedVertices: [...current.clickedVertices, { row, col }],
      };
    },
  );
  const finishVertexSelection = vi.fn((pending: PendingVertexSelection) => {
    stores.pendingVertexSelection = pending;
    stores.vertexSelectionMode = null;
    stores.hallDefinitionMode = true;
  });
  const actions: MapEditorActionPort = {
    setMapData,
    setHallDefinitions,
    setHallRouteSettings,
    setEventLists,
    updateExecuteModeItems,
    commitExecuteModeItemsForEvent,
    setNewItemDefaults,
    setItemToEdit,
    navigation: { showImport },
    startCellSelection,
    toggleCellSelection,
    finishCellSelection,
    startVertexSelection,
    toggleVertexSelection,
    finishVertexSelection,
  };
  const getMapTabForDate =
    options.getMapTabForDate ??
    ((eventDate: string): string | null =>
      eventDate === DAY ? MAP : `${eventDate}-map`);
  const getItemHallId =
    options.getItemHallId ??
    ((_item: ShoppingItem): string | null => "polygon");
  const areItemsInSameHallGroup =
    options.areItemsInSameHallGroup ?? (() => true);

  const createPorts = (): MapEditorCommandPorts => ({
    state: {
      activeEventName,
      activeEventDate: options.activeEventDate ?? DAY,
      isMapTab: options.isMapTab ?? true,
      currentMapTabName,
      currentMapData: Object.prototype.hasOwnProperty.call(
        options,
        "currentMapData",
      )
        ? options.currentMapData
        : currentMapTabName
          ? stores.mapData[EVENT]?.[currentMapTabName]
          : undefined,
      eventLists: stores.eventLists,
      items: stores.eventLists[EVENT] ?? [],
      executeModeItemsRef,
      mapData: stores.mapData,
      hallDefinitions: stores.hallDefinitions,
      hallRouteSettings: stores.hallRouteSettings,
      visitListPanelMapTab: currentMapTabName,
      cellSelectionMode: stores.cellSelectionMode,
      vertexSelectionMode: stores.vertexSelectionMode,
    },
    actions,
    selectors: {
      getMapTabForDate,
      getItemHallId,
      areItemsInSameHallGroup,
    },
    effects: { selectionEventTarget },
    persistence: {
      commitApplicationSnapshotPatch: vi.fn(async () => undefined),
    },
  });

  return {
    stores,
    createPorts,
    selectionEventTarget,
    spies: {
      setMapData,
      setHallDefinitions,
      setHallRouteSettings,
      setEventLists,
      updateExecuteModeItems,
      commitExecuteModeItemsForEvent,
      setNewItemDefaults,
      setItemToEdit,
      showImport,
      startCellSelection,
      toggleCellSelection,
      finishCellSelection,
      startVertexSelection,
      toggleVertexSelection,
      finishVertexSelection,
      getMapTabForDate: vi.fn(getMapTabForDate),
    },
  };
};

const renderHarness = (harness: ReturnType<typeof createHarness>) =>
  renderHook(
    ({ ports }: { ports: MapEditorCommandPorts }) =>
      useMapEditorCommands(ports),
    { initialProps: { ports: harness.createPorts() } },
  );

const clickCell = (target: EventTarget, row: number, col: number): void => {
  target.dispatchEvent(
    new CustomEvent("mapCellClick", { detail: { row, col } }),
  );
};

describe("useMapEditorCommands", () => {
  it("adds map execute items sequentially and commits expanded adjacency once per command", () => {
    const harness = createHarness();
    const { result, rerender } = renderHarness(harness);

    let inserted: string[] = [];
    act(() => {
      inserted = result.current.handleAddToExecuteListFromMap("a1");
    });
    expect(inserted).toEqual(["a1", "a2"]);
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual(["a1", "a2"]);

    rerender({ ports: harness.createPorts() });
    act(() => {
      inserted = result.current.handleBatchAddToExecuteListFromMap([
        "b1",
        "missing",
      ]);
    });
    expect(inserted).toEqual(["b1"]);
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    expect(harness.spies.commitExecuteModeItemsForEvent).toHaveBeenCalledTimes(
      2,
    );

    const guarded = createHarness({ isMapTab: false });
    const guardedResult = renderHarness(guarded).result;
    expect(guardedResult.current.handleAddToExecuteListFromMap("a1")).toEqual(
      [],
    );
    expect(guarded.spies.commitExecuteModeItemsForEvent).not.toHaveBeenCalled();
  });

  it("fails closed on a rejected positioned insert and removes an entire adjacency group", () => {
    const rejected = createHarness({
      executeModeItems: { [EVENT]: { [DAY]: ["b1"] } },
      areItemsInSameHallGroup: () => false,
    });
    const rejectedResult = renderHarness(rejected).result;

    expect(
      rejectedResult.current.handleBatchAddToExecuteListFromMapAtPosition(
        ["a1"],
        "b1",
        "after",
      ),
    ).toEqual([]);
    expect(
      rejected.spies.commitExecuteModeItemsForEvent,
    ).not.toHaveBeenCalled();
    expect(rejected.stores.executeModeItems[EVENT][DAY]).toEqual(["b1"]);

    const removable = createHarness({
      executeModeItems: {
        [EVENT]: { [DAY]: ["a1", "a2", "b1"] },
      },
    });
    const removableResult = renderHarness(removable).result;
    expect(
      removableResult.current.handleRemoveFromExecuteListFromMap("a1"),
    ).toEqual(["a1", "a2"]);
    expect(removable.stores.executeModeItems[EVENT][DAY]).toEqual(["b1"]);
  });

  it("moves execute entries from the latest functional state without duplicates", () => {
    const harness = createHarness({
      executeModeItems: {
        [EVENT]: { [DAY]: ["a1", "b1", "a2"] },
      },
    });
    const { result } = renderHarness(harness);

    act(() => result.current.handleMoveToFirstFromMap("b1"));
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "b1",
      "a1",
      "a2",
    ]);
    act(() => result.current.handleMoveToLastFromMap("b1"));
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "a1",
      "a2",
      "b1",
    ]);
    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledTimes(2);
  });

  it("coordinates map-created and focus-created items through typed UI/state ports", () => {
    const harness = createHarness();
    const { result } = renderHarness(harness);

    act(() => result.current.handleAddNewItemFromMap(DAY, "C", "03"));
    expect(harness.stores.newItemDefaults).toEqual({
      eventDate: DAY,
      block: "C",
      number: "03",
    });
    expect(harness.stores.itemToEdit).toBeNull();
    expect(harness.spies.showImport).toHaveBeenCalledWith(EVENT);

    const focusItem: Omit<ShoppingItem, "id"> & {
      purchaseStatus?: PurchaseStatus;
    } = {
      circle: "フォーカス追加",
      eventDate: DAY,
      block: "D",
      number: "04",
      title: "追加品",
      price: 400,
      quantity: 1,
      purchaseStatus: "Postpone",
      remarks: "",
    };
    act(() => result.current.handleAddItemFromFocusMode(focusItem));
    const added = harness.stores.eventLists[EVENT].find(
      (candidate) => candidate.circle === "フォーカス追加",
    );
    expect(added).toBeDefined();
    expect(harness.stores.executeModeItems[EVENT][DAY]).toContain(added?.id);
    expect(harness.spies.setEventLists).toHaveBeenCalledTimes(1);
    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledTimes(1);
  });

  it("updates priority stores together and keeps changed execute groups adjacent", async () => {
    const items = [
      shoppingItem("x1", { block: "X", number: "09", priorityLevel: "none" }),
      shoppingItem("a1", { priorityLevel: "priority" }),
      shoppingItem("a2", { priorityLevel: "highest" }),
    ];
    const harness = createHarness({
      eventLists: { [EVENT]: items },
      executeModeItems: {
        [EVENT]: { [DAY]: ["a1", "x1", "a2"] },
      },
    });
    const { result, rerender } = renderHarness(harness);

    await act(() => result.current.handleUpdateItemPriority("a1", "highest"));
    expect(
      harness.stores.eventLists[EVENT].find(({ id }) => id === "a1")
        ?.priorityLevel,
    ).toBe("highest");
    expect(harness.spies.setHallRouteSettings).toHaveBeenCalledTimes(1);
    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledTimes(1);

    rerender({ ports: harness.createPorts() });
    harness.spies.setEventLists.mockClear();
    act(() =>
      result.current.handleUpdateHallOrderForPriorityChangeFromEdit(
        "a1",
        "highest",
        "priority",
      ),
    );
    expect(harness.spies.setEventLists).not.toHaveBeenCalled();
    expect(harness.stores.executeModeItems[EVENT][DAY]).toEqual([
      "x1",
      "a2",
      "a1",
    ]);
  });

  it("keeps priority and hall state unchanged when the atomic commit fails", async () => {
    const harness = createHarness();
    const beforeItems = structuredClone(harness.stores.eventLists);
    const beforeDefinitions = structuredClone(harness.stores.hallDefinitions);
    const ports = harness.createPorts();
    ports.persistence.commitApplicationSnapshotPatch = vi.fn(async () => {
      throw new Error("transaction aborted");
    });
    const { result } = renderHook(() => useMapEditorCommands(ports));

    await act(() => result.current.handleUpdateItemPriority("a1", "highest"));
    await act(() =>
      result.current.handleUpdateHalls([polygonHall("replacement")]),
    );

    expect(harness.stores.eventLists).toEqual(beforeItems);
    expect(harness.stores.hallDefinitions).toEqual(beforeDefinitions);
    expect(harness.spies.setEventLists).not.toHaveBeenCalled();
    expect(harness.spies.setHallDefinitions).not.toHaveBeenCalled();
  });

  it("routes edit-origin priority changes to the mapless inventory when no polygon owns the item", async () => {
    const harness = createHarness({ getItemHallId: () => null });
    const { result } = renderHarness(harness);

    await act(() =>
      result.current.handleUpdateItemPriorityFromEdit("a1", "highest"),
    );

    expect(
      harness.stores.eventLists[EVENT].find(({ id }) => id === "a1")
        ?.priorityLevel,
    ).toBe("highest");
    expect(
      harness.stores.hallRouteSettings[EVENT][getMaplessKey(DAY)],
    ).toBeDefined();
    expect(harness.spies.updateExecuteModeItems).toHaveBeenCalledTimes(1);
  });

  it("updates only the active map block collection and rejects incomplete context", () => {
    const harness = createHarness();
    const { result } = renderHarness(harness);
    const replacement = [block("更新")];

    act(() => result.current.handleUpdateBlocks(replacement));

    expect(harness.stores.mapData[EVENT][MAP].blocks).toBe(replacement);
    expect(harness.stores.mapData[EVENT][MAP].maxRow).toBe(10);
    expect(harness.stores.mapData[EVENT]["別マップ"].blocks[0].name).toBe("別");

    const guarded = createHarness({ currentMapData: undefined });
    const guardedResult = renderHarness(guarded).result;
    act(() => guardedResult.current.handleUpdateBlocks([block("拒否")]));
    expect(guarded.spies.setMapData).not.toHaveBeenCalled();
  });

  it("splits polygon and mapless halls while committing both route inventories", async () => {
    const harness = createHarness();
    const { result } = renderHarness(harness);
    const polygon = polygonHall("polygon", { blockNames: ["ignored"] });
    const manual = maplessHall("manual");

    await act(() => result.current.handleUpdateHalls([polygon, manual]));

    expect(harness.spies.setHallDefinitions).toHaveBeenCalledTimes(1);
    expect(harness.spies.setHallRouteSettings).toHaveBeenCalledTimes(1);
    expect(harness.stores.hallDefinitions[EVENT][MAP]).toEqual([
      expect.not.objectContaining({ blockNames: expect.anything() }),
    ]);
    expect(harness.stores.hallDefinitions[EVENT][getMaplessKey(DAY)]).toEqual([
      manual,
    ]);
    expect(harness.stores.hallRouteSettings[EVENT][MAP].hallOrder).toEqual([
      "polygon",
    ]);
    expect(
      harness.stores.hallRouteSettings[EVENT][getMaplessKey(DAY)].hallOrder,
    ).toEqual(["manual"]);
  });

  it("updates mapless halls as one paired definition/route command and fails closed without a date", async () => {
    const harness = createHarness();
    const { result } = renderHarness(harness);
    const halls = [maplessHall("manual-next")];

    await act(() => result.current.handleUpdateMaplessHalls(halls));
    expect(harness.stores.hallDefinitions[EVENT][getMaplessKey(DAY)]).toBe(
      halls,
    );
    expect(
      harness.stores.hallRouteSettings[EVENT][getMaplessKey(DAY)].hallOrder,
    ).toEqual(["manual-next"]);

    const guarded = createHarness({ activeEventDate: "" });
    const guardedResult = renderHarness(guarded).result;
    await act(() => guardedResult.current.handleUpdateMaplessHalls(halls));
    expect(guarded.spies.setHallDefinitions).not.toHaveBeenCalled();
    expect(guarded.spies.setHallRouteSettings).not.toHaveBeenCalled();
  });

  it("clones and remaps mapless and polygon hall inventories for valid target dates", async () => {
    const harness = createHarness({
      getMapTabForDate: (date) =>
        date === "2日目" ? "map-2" : date === "3日目" ? "map-3" : null,
    });
    const { result, rerender } = renderHarness(harness);

    await act(() =>
      result.current.handleSyncMaplessHallsToOtherDates(["2日目"]),
    );
    const maplessClone =
      harness.stores.hallDefinitions[EVENT][getMaplessKey("2日目")][0];
    expect(maplessClone.id).not.toBe("manual");
    expect(
      harness.stores.hallRouteSettings[EVENT][getMaplessKey("2日目")].hallOrder,
    ).toEqual([maplessClone.id]);

    rerender({ ports: harness.createPorts() });
    await act(() =>
      result.current.handleSyncPolygonHallsToOtherDates(["3日目", "対象外"]),
    );
    const polygonClone = harness.stores.hallDefinitions[EVENT]["map-3"][0];
    expect(polygonClone.id).not.toBe("polygon");
    expect(harness.stores.hallRouteSettings[EVENT]["map-3"].hallOrder).toEqual([
      polygonClone.id,
    ]);
  });

  it("bounds vertex selection, toggles duplicates, and commits sorted vertices", () => {
    const editingData = { hallId: "editing" };
    const harness = createHarness();
    const { result, rerender } = renderHarness(harness);

    act(() => result.current.handleStartVertexSelection(editingData));
    expect(harness.stores.hallDefinitionMode).toBe(false);
    rerender({ ports: harness.createPorts() });
    act(() => {
      [
        [1, 1],
        [0, 0],
        [1, 0],
        [0, 1],
        [2, 2],
        [2, 1],
        [9, 9],
      ].forEach(([row, col]) =>
        clickCell(harness.selectionEventTarget, row, col),
      );
    });
    expect(harness.stores.vertexSelectionMode?.clickedVertices).toHaveLength(6);
    act(() => clickCell(harness.selectionEventTarget, 2, 2));
    expect(harness.stores.vertexSelectionMode?.clickedVertices).toHaveLength(5);

    rerender({ ports: harness.createPorts() });
    act(() => result.current.handleConfirmVertexSelection());
    expect(harness.stores.pendingVertexSelection).toEqual({
      vertices: sortMapEditorVerticesNonCrossing([
        { row: 1, col: 1 },
        { row: 0, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: 1 },
        { row: 2, col: 1 },
      ]),
      editingData,
    });
    expect(harness.stores.vertexSelectionMode).toBeNull();
    expect(harness.stores.hallDefinitionMode).toBe(true);
  });

  it("emits explicit rollback payloads when editing selections are cancelled", () => {
    const vertexEditingData = { hallId: "existing" };
    const cellEditingData = { blockId: "existing" };
    const harness = createHarness({
      vertexSelectionMode: {
        clickedVertices: [{ row: 1, col: 1 }],
        editingData: vertexEditingData,
      },
      cellSelectionMode: {
        type: "individual",
        clickedCells: [{ row: 2, col: 2 }],
        editingBlockData: cellEditingData,
      },
    });
    const { result } = renderHarness(harness);

    act(() => {
      result.current.handleCancelVertexSelection();
      result.current.handleCancelCellSelection();
    });

    expect(harness.stores.pendingVertexSelection).toEqual({
      vertices: [],
      editingData: vertexEditingData,
    });
    expect(harness.stores.pendingCellSelection).toEqual({
      type: "cancelled",
      cells: [],
      editingData: cellEditingData,
    });
    expect(harness.stores.vertexSelectionMode).toBeNull();
    expect(harness.stores.cellSelectionMode).toBeNull();
    expect(harness.stores.hallDefinitionMode).toBe(true);
    expect(harness.stores.blockDefinitionMode).toBe(true);
  });

  it("commits cell selections and removes both event listeners on unmount", () => {
    const editingData = { blockId: "block" };
    const harness = createHarness();
    const { result, rerender, unmount } = renderHarness(harness);

    act(() =>
      result.current.handleStartCellSelection("individual", editingData),
    );
    rerender({ ports: harness.createPorts() });
    act(() => {
      clickCell(harness.selectionEventTarget, 3, 4);
      clickCell(harness.selectionEventTarget, 5, 6);
      clickCell(harness.selectionEventTarget, 3, 4);
    });
    expect(harness.stores.cellSelectionMode?.clickedCells).toEqual([
      { row: 5, col: 6 },
    ]);

    rerender({ ports: harness.createPorts() });
    act(() => result.current.handleConfirmCellSelection());
    expect(harness.stores.pendingCellSelection).toEqual({
      type: "individual",
      cells: [{ row: 5, col: 6 }],
      editingData,
    });

    const cellCallsBeforeUnmount =
      harness.spies.toggleCellSelection.mock.calls.length;
    const vertexCallsBeforeUnmount =
      harness.spies.toggleVertexSelection.mock.calls.length;
    unmount();
    act(() => clickCell(harness.selectionEventTarget, 8, 8));
    expect(harness.spies.toggleCellSelection).toHaveBeenCalledTimes(
      cellCallsBeforeUnmount,
    );
    expect(harness.spies.toggleVertexSelection).toHaveBeenCalledTimes(
      vertexCallsBeforeUnmount,
    );
  });
});
