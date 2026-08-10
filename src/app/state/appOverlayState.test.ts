import { describe, expect, it } from "vitest";
import type { PreparedMapImport } from "../../features/map/domain/mapImportFlow";
import type { ShoppingItem } from "../../types/item";
import {
  AppOverlayInvariantError,
  assertAppOverlayState,
  createInitialAppOverlayState,
  reduceAppOverlayState,
  selectActiveAppOverlayKinds,
  selectAppOverlayReadModel,
  selectConcurrentOverlayStatus,
  selectHasBlockingAppOverlay,
  type AppOverlayAction,
  type AppOverlayReadModel,
} from "./appOverlayState";

const item = (id: string): ShoppingItem => ({
  id,
  circle: `circle-${id}`,
  eventDate: "day-1",
  block: "A",
  number: "1",
  title: `title-${id}`,
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

const file = {
  name: "map.xlsx",
  arrayBuffer: async () => new ArrayBuffer(0),
} as File;

const preparedImport = (eventName = "event-map"): PreparedMapImport =>
  ({
    plan: {
      eventName,
      targets: [],
      impact: {},
      requiresConfirmation: true,
    },
    settings: {},
    skippedDays: [],
  }) as unknown as PreparedMapImport;

const initialReadModel = (
  overrides: Partial<AppOverlayReadModel> = {},
): AppOverlayReadModel => ({
  editDialogItem: null,
  itemToDelete: null,
  pendingEventUpdate: null,
  showUrlUpdateDialog: false,
  pendingUpdateEventName: null,
  showRenameDialog: false,
  eventToRename: null,
  pendingDuplicateEvent: null,
  showExportOptions: false,
  exportEventName: null,
  pendingBackup: null,
  pendingXlsxRestoreCompletion: null,
  mapImportDialogOpen: false,
  mapImportPendingFile: null,
  mapImportPendingEventName: "",
  pendingMapReimport: null,
  blockDefinitionMode: false,
  pendingCellSelection: null,
  cellSelectionMode: null,
  simpleHallDefinitionMode: false,
  globalHallOrderPanelOpen: false,
  hallDefinitionMode: false,
  pendingVertexSelection: null,
  vertexSelectionMode: null,
  visitListPanelOpen: false,
  visitListPanelMapTab: null,
  visitListHasUnsavedChanges: false,
  visitListOriginalOrder: [],
  showVisitListConfirmDialog: false,
  pendingTabChange: null,
  xlsxOperationActivity: null,
  smartInsertToast: null,
  smartInsertToastType: "success",
  ...overrides,
});

const expectInvariant = (callback: () => unknown, code: string): void => {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(AppOverlayInvariantError);
    expect((error as AppOverlayInvariantError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AppOverlayInvariantError(${code}).`);
};

describe("appOverlayState", () => {
  it("starts with independent inactive families and no concurrent status", () => {
    const state = createInitialAppOverlayState();

    expect(selectActiveAppOverlayKinds(state)).toEqual([]);
    expect(selectHasBlockingAppOverlay(state)).toBe(false);
    expect(selectConcurrentOverlayStatus(state)).toEqual({
      xlsxOperation: null,
      smartInsertToast: null,
    });
    expect(selectAppOverlayReadModel(state)).toEqual(initialReadModel());
  });

  it("rejects missing and extra closed-state payload fields", () => {
    const initial = createInitialAppOverlayState();
    const missingItem = {
      ...initial,
      item: { kind: "edit", requestId: "item-1" },
    };
    const contradictoryItem = {
      ...initial,
      item: {
        kind: "inactive",
        requestId: "hidden-request",
      },
    };
    const extraOuterField = { ...initial, hidden: true };

    expectInvariant(() => assertAppOverlayState(missingItem), "overlay.item");
    expectInvariant(
      () => assertAppOverlayState(contradictoryItem),
      "overlay.item",
    );
    expectInvariant(() => assertAppOverlayState(extraOuterField), "overlay");
    expectInvariant(
      () =>
        reduceAppOverlayState(initial, {
          type: "overlay/unknown",
        } as unknown as AppOverlayAction),
      "overlay.action.type",
    );
  });

  it("correlates item actions and rejects stale close or confirm operations", () => {
    const opened = reduceAppOverlayState(createInitialAppOverlayState(), {
      type: "item/open-edit",
      requestId: "item-1",
      item: item("one"),
    });

    expectInvariant(
      () =>
        reduceAppOverlayState(opened, {
          type: "item/confirm",
          requestId: "item-old",
          expectedKind: "edit",
        }),
      "overlay.item.stale-action",
    );
    expectInvariant(
      () =>
        reduceAppOverlayState(opened, {
          type: "item/close",
          requestId: "item-1",
          expectedKind: "delete",
        }),
      "overlay.item.stale-action",
    );

    const closed = reduceAppOverlayState(opened, {
      type: "item/confirm",
      requestId: "item-1",
      expectedKind: "edit",
    });
    expect(closed.item).toEqual({ kind: "inactive" });
    expectInvariant(
      () =>
        reduceAppOverlayState(closed, {
          type: "item/open-delete",
          requestId: "item-2",
        } as AppOverlayAction),
      "overlay.item.item",
    );
  });

  it("keeps status independent from event dialogs and rejects stale status cleanup", () => {
    let state = reduceAppOverlayState(createInitialAppOverlayState(), {
      type: "event/open-url-update",
      requestId: "event-1",
      eventName: "event-url",
    });
    state = reduceAppOverlayState(state, {
      type: "status/set-xlsx-operation",
      requestId: "xlsx-1",
      activity: {
        kind: "export",
        progress: null,
        cancelRequested: false,
      },
    });
    state = reduceAppOverlayState(state, {
      type: "status/update-xlsx-operation",
      requestId: "xlsx-1",
      activity: {
        kind: "export",
        progress: null,
        cancelRequested: true,
      },
    });
    state = reduceAppOverlayState(state, {
      type: "status/show-smart-insert-toast",
      requestId: "toast-1",
      message: "done",
      tone: "success",
    });

    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "event/confirm",
          requestId: "event-old",
          expectedKind: "url-update",
        }),
      "overlay.event.stale-action",
    );
    const closed = reduceAppOverlayState(state, {
      type: "event/confirm",
      requestId: "event-1",
      expectedKind: "url-update",
    });
    expect(closed.event).toEqual({ kind: "inactive" });
    expect(closed.concurrentStatus).toEqual(state.concurrentStatus);
    expect(
      closed.concurrentStatus.xlsxOperation?.activity.cancelRequested,
    ).toBe(true);
    expectInvariant(
      () =>
        reduceAppOverlayState(closed, {
          type: "status/update-xlsx-operation",
          requestId: "xlsx-old",
          activity: {
            kind: "export",
            progress: null,
            cancelRequested: false,
          },
        }),
      "overlay.concurrentStatus.stale-xlsx-action",
    );
    expectInvariant(
      () =>
        reduceAppOverlayState(closed, {
          type: "status/clear-xlsx-operation",
          requestId: "xlsx-old",
        }),
      "overlay.concurrentStatus.stale-xlsx-action",
    );
    expectInvariant(
      () =>
        reduceAppOverlayState(closed, {
          type: "status/clear-smart-insert-toast",
          requestId: "toast-old",
        }),
      "overlay.concurrentStatus.stale-toast-action",
    );
  });

  it("moves map import to reimport atomically and rejects the late dialog close", () => {
    const opened = reduceAppOverlayState(createInitialAppOverlayState(), {
      type: "map-import/open",
      requestId: "map-1",
      file,
      eventName: "event-map",
    });
    const reimport = reduceAppOverlayState(opened, {
      type: "map-import/request-reimport",
      requestId: "map-1",
      preparedImport: preparedImport(),
    });

    expect(reimport.mapImport.kind).toBe("reimport");
    expectInvariant(
      () =>
        reduceAppOverlayState(reimport, {
          type: "map-import/close-dialog",
          requestId: "map-1",
        }),
      "overlay.mapImport.stale-dialog-action",
    );
    expect(
      reduceAppOverlayState(reimport, {
        type: "map-import/confirm-reimport",
        requestId: "map-1",
      }).mapImport,
    ).toEqual({ kind: "inactive" });
  });

  it("preserves map-editor ownership through selection and rejects late panel close", () => {
    let state = reduceAppOverlayState(createInitialAppOverlayState(), {
      type: "map-editor/open-block-definition",
      requestId: "map-editor-1",
      pendingSelection: null,
    });
    state = reduceAppOverlayState(state, {
      type: "map-editor/start-cell-selection",
      requestId: "map-editor-1",
      selection: { type: "rangeStart", clickedCells: [] },
    });
    state = reduceAppOverlayState(state, {
      type: "map-editor/toggle-cell",
      requestId: "map-editor-1",
      cell: { row: 1, col: 2 },
    });
    expect(state.mapEditor).toMatchObject({
      kind: "cell-selection",
      selection: { clickedCells: [{ row: 1, col: 2 }] },
    });

    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "map-editor/close",
          requestId: "map-editor-1",
          expectedKind: "block-definition",
        }),
      "overlay.mapEditor.stale-close",
    );
    const pendingSelection = { type: "range", cells: [{ row: 1, col: 2 }] };
    state = reduceAppOverlayState(state, {
      type: "map-editor/finish-cell-selection",
      requestId: "map-editor-1",
      pendingSelection,
    });
    expect(state.mapEditor).toEqual({
      kind: "block-definition",
      requestId: "map-editor-1",
      pendingSelection,
    });
    expect(selectAppOverlayReadModel(state)).toMatchObject({
      blockDefinitionMode: true,
      pendingCellSelection: pendingSelection,
      cellSelectionMode: null,
    });
    state = reduceAppOverlayState(state, {
      type: "map-editor/clear-pending-cell-selection",
      requestId: "map-editor-1",
    });
    expect(state.mapEditor).toMatchObject({
      kind: "block-definition",
      pendingSelection: null,
    });
    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "map-editor/clear-pending-cell-selection",
          requestId: "map-editor-old",
        }),
      "overlay.mapEditor.stale-block-action",
    );
    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "map-editor/toggle-cell",
          requestId: "map-editor-1",
          cell: { row: 9, col: 9 },
        }),
      "overlay.mapEditor.stale-cell-action",
    );
  });

  it("updates only the current vertex-selection request", () => {
    let state = reduceAppOverlayState(createInitialAppOverlayState(), {
      type: "map-editor/open-hall-definition",
      requestId: "vertex-1",
      pendingSelection: null,
    });
    state = reduceAppOverlayState(state, {
      type: "map-editor/start-vertex-selection",
      requestId: "vertex-1",
      selection: { clickedVertices: [] },
    });
    state = reduceAppOverlayState(state, {
      type: "map-editor/toggle-vertex",
      requestId: "vertex-1",
      vertex: { row: 3, col: 4 },
    });
    expect(state.mapEditor).toMatchObject({
      kind: "vertex-selection",
      selection: { clickedVertices: [{ row: 3, col: 4 }] },
    });

    for (const vertex of [
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
      { row: 3, col: 3 },
    ]) {
      state = reduceAppOverlayState(state, {
        type: "map-editor/toggle-vertex",
        requestId: "vertex-1",
        vertex,
      });
    }
    const atLimit = state;
    state = reduceAppOverlayState(state, {
      type: "map-editor/toggle-vertex",
      requestId: "vertex-1",
      vertex: { row: 9, col: 9 },
    });
    expect(state).toBe(atLimit);
    state = reduceAppOverlayState(state, {
      type: "map-editor/toggle-vertex",
      requestId: "vertex-1",
      vertex: { row: 3, col: 4 },
    });
    expect(
      state.mapEditor.kind === "vertex-selection"
        ? state.mapEditor.selection.clickedVertices
        : [],
    ).toHaveLength(5);

    state = reduceAppOverlayState(state, {
      type: "map-editor/finish-vertex-selection",
      requestId: "vertex-1",
      pendingSelection: { vertices: [{ row: 1, col: 1 }] },
    });
    state = reduceAppOverlayState(state, {
      type: "map-editor/clear-pending-vertex-selection",
      requestId: "vertex-1",
    });
    expect(state.mapEditor).toMatchObject({
      kind: "hall-definition",
      pendingSelection: null,
    });
    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "map-editor/clear-pending-vertex-selection",
          requestId: "vertex-old",
        }),
      "overlay.mapEditor.stale-hall-action",
    );

    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "map-editor/toggle-vertex",
          requestId: "vertex-old",
          vertex: { row: 8, col: 8 },
        }),
      "overlay.mapEditor.stale-vertex-action",
    );
  });

  it("requires dirty visit state and rejects late panel and confirmation actions", () => {
    let state = reduceAppOverlayState(createInitialAppOverlayState(), {
      type: "visit-list/open",
      requestId: "visit-1",
      mapTab: "map-1",
      originalOrder: ["a", "b"],
    });

    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "visit-list/request-confirm-close",
          requestId: "visit-1",
          pendingTabChange: "map-2",
        }),
      "overlay.visitList.no-unsaved-changes",
    );
    state = reduceAppOverlayState(state, {
      type: "visit-list/set-unsaved",
      requestId: "visit-1",
      hasUnsavedChanges: true,
    });
    state = reduceAppOverlayState(state, {
      type: "visit-list/request-confirm-close",
      requestId: "visit-1",
      pendingTabChange: "map-2",
    });

    expect(state.visitList.kind).toBe("confirm-close");
    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "visit-list/close-panel",
          requestId: "visit-1",
        }),
      "overlay.visitList.stale-panel-action",
    );
    expectInvariant(
      () =>
        reduceAppOverlayState(state, {
          type: "visit-list/confirm-close",
          requestId: "visit-old",
        }),
      "overlay.visitList.stale-confirm-action",
    );
    const closed = reduceAppOverlayState(state, {
      type: "visit-list/discard-close",
      requestId: "visit-1",
    });
    expect(closed.visitList).toEqual({ kind: "inactive" });
  });
});
