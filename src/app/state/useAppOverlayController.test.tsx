// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PendingEventUpdate } from "../../features/events/updateFlow";
import type { PreparedMapImport } from "../../features/map/domain/mapImportFlow";
import type { ShoppingItem } from "../../types/item";
import { AppOverlayInvariantError } from "./appOverlayState";
import { useAppOverlayController } from "./useAppOverlayController";

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

const pendingUpdate: PendingEventUpdate = {
  kind: "items-only",
  eventName: "event-update",
  diff: {
    itemsToDelete: [],
    itemsToUpdate: [],
    itemsToAdd: [],
    appFieldSyncCandidates: [],
    protectedFromDelete: 0,
    protectedFromUpdate: 0,
    quantityWarnings: [],
    pendingPurchasedQuantityChanges: [],
    limitedPurchaseQuantityConflicts: [],
  },
};

const preparedImport = {
  plan: {
    eventName: "event-map",
    targets: [],
    impact: {},
    requiresConfirmation: true,
  },
  settings: {},
  skippedDays: [],
} as unknown as PreparedMapImport;

const createSequentialRequestIds = () => {
  let sequence = 0;
  return () => `request-${++sequence}`;
};

describe("useAppOverlayController", () => {
  it("starts from one closed reducer state and derives its read model", () => {
    const { result } = renderHook(() => useAppOverlayController());

    expect(result.current.activeKinds).toEqual([]);
    expect(result.current.hasBlockingOverlay).toBe(false);
    expect(result.current.readModel).toMatchObject({
      editDialogItem: null,
      pendingEventUpdate: null,
      mapImportDialogOpen: false,
      visitListPanelOpen: false,
      xlsxOperationActivity: null,
      smartInsertToast: null,
    });
  });

  it("opens independent families with generated identities and closes atomically", () => {
    const createRequestId = createSequentialRequestIds();
    const { result } = renderHook(() =>
      useAppOverlayController({ createRequestId }),
    );

    act(() => {
      expect(result.current.commands.item.openEdit(item("one"))).toBe(
        "request-1",
      );
      expect(result.current.commands.event.openUpdate(pendingUpdate)).toBe(
        "request-2",
      );
    });

    expect(result.current.activeKinds).toEqual(["item:edit", "event:update"]);
    expect(result.current.readModel.editDialogItem?.id).toBe("one");
    expect(result.current.readModel.pendingEventUpdate).toBe(pendingUpdate);

    act(() => {
      result.current.commands.item.confirm();
      result.current.commands.event.close();
    });

    expect(result.current.activeKinds).toEqual([]);
  });

  it("turns callbacks retained by an obsolete render into rejected no-ops", () => {
    const { result } = renderHook(() => useAppOverlayController());

    act(() => result.current.commands.item.openEdit(item("old")));
    const obsoleteCommands = result.current.commands.item;
    act(() => obsoleteCommands.close());
    act(() => result.current.commands.item.openDelete(item("current")));

    act(() => obsoleteCommands.close());

    expect(result.current.state.item).toMatchObject({
      kind: "delete",
      item: { id: "current" },
    });
  });

  it("moves map import review through one request identity", () => {
    const file = new File(["xlsx"], "map.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const { result } = renderHook(() => useAppOverlayController());

    act(() => result.current.commands.mapImport.open(file, "event-map"));
    const dialogCommands = result.current.commands.mapImport;
    const requestId =
      result.current.state.mapImport.kind === "import"
        ? result.current.state.mapImport.requestId
        : null;

    act(() =>
      result.current.commands.mapImport.requestReimport(preparedImport),
    );
    expect(result.current.state.mapImport).toMatchObject({
      kind: "reimport",
      requestId,
      preparedImport,
    });

    act(() => dialogCommands.closeDialog());
    expect(result.current.state.mapImport.kind).toBe("reimport");

    act(() => result.current.commands.mapImport.confirmReimport());
    expect(result.current.state.mapImport.kind).toBe("inactive");
  });

  it("owns the visit-list dirty confirmation as an atomic family", () => {
    const { result } = renderHook(() => useAppOverlayController());

    act(() => result.current.commands.visitList.open("day-1マップ", ["a"]));
    act(() => result.current.commands.visitList.setUnsaved(true));
    act(() => result.current.commands.visitList.requestConfirmClose("day-2"));

    expect(result.current.state.visitList).toMatchObject({
      kind: "confirm-close",
      mapTab: "day-1マップ",
      originalOrder: ["a"],
      pendingTabChange: "day-2",
    });
    expect(result.current.readModel.showVisitListConfirmDialog).toBe(true);

    act(() => result.current.commands.visitList.discardClose());
    expect(result.current.state.visitList.kind).toBe("inactive");
  });

  it("updates selection payloads without yielding map-editor ownership", () => {
    const { result } = renderHook(() => useAppOverlayController());

    act(() => result.current.commands.mapEditor.openBlockDefinition(null));
    act(() =>
      result.current.commands.mapEditor.startCellSelection({
        type: "rangeStart",
        clickedCells: [],
      }),
    );
    const activeCellCommands = result.current.commands.mapEditor;
    act(() => {
      activeCellCommands.toggleCellSelection({ row: 1, col: 2 });
      activeCellCommands.toggleCellSelection({ row: 2, col: 3 });
    });
    expect(result.current.readModel.cellSelectionMode?.clickedCells).toEqual([
      { row: 1, col: 2 },
      { row: 2, col: 3 },
    ]);

    act(() =>
      result.current.commands.mapEditor.finishCellSelection({
        type: "rangeStart",
        cells: [{ row: 1, col: 2 }],
      }),
    );
    expect(result.current.readModel.pendingCellSelection).not.toBeNull();
    act(() => result.current.commands.mapEditor.clearPendingCellSelection());
    expect(result.current.readModel.pendingCellSelection).toBeNull();
    act(() => activeCellCommands.toggleCellSelection({ row: 9, col: 9 }));
    expect(result.current.state.mapEditor.kind).toBe("block-definition");

    act(() => result.current.commands.mapEditor.close());
    act(() => result.current.commands.mapEditor.openHallDefinition(null));
    act(() =>
      result.current.commands.mapEditor.startVertexSelection({
        clickedVertices: [],
      }),
    );
    act(() =>
      result.current.commands.mapEditor.toggleVertexSelection({
        row: 4,
        col: 5,
      }),
    );
    expect(
      result.current.readModel.vertexSelectionMode?.clickedVertices,
    ).toEqual([{ row: 4, col: 5 }]);
  });

  it("keeps XLSX and toast status concurrent and ignores stale cleanup", () => {
    const { result } = renderHook(() => useAppOverlayController());
    let xlsxRequestId = "";
    let firstToastRequestId = "";

    act(() => {
      xlsxRequestId = result.current.commands.status.startXlsxOperation({
        kind: "import",
        progress: null,
        cancelRequested: false,
      });
      firstToastRequestId = result.current.commands.status.showSmartInsertToast(
        "saved",
        "success",
      );
    });
    expect(result.current.concurrentStatus.xlsxOperation).not.toBeNull();
    expect(result.current.concurrentStatus.smartInsertToast).not.toBeNull();

    act(() =>
      result.current.commands.status.updateXlsxOperation(xlsxRequestId, {
        kind: "import",
        progress: null,
        cancelRequested: true,
      }),
    );
    expect(
      result.current.readModel.xlsxOperationActivity?.cancelRequested,
    ).toBe(true);

    let secondToastRequestId = "";
    act(
      () =>
        (secondToastRequestId =
          result.current.commands.status.showSmartInsertToast("new", "error")),
    );
    act(() =>
      result.current.commands.status.clearSmartInsertToast(firstToastRequestId),
    );

    expect(result.current.readModel.smartInsertToast).toBe("new");
    expect(result.current.readModel.smartInsertToastType).toBe("error");
    expect(result.current.readModel.xlsxOperationActivity?.kind).toBe("import");

    act(() => result.current.commands.status.clearXlsxOperation("xlsx-stale"));
    expect(result.current.readModel.xlsxOperationActivity).not.toBeNull();
    act(() => result.current.commands.status.clearXlsxOperation(xlsxRequestId));
    act(() =>
      result.current.commands.status.clearSmartInsertToast(
        secondToastRequestId,
      ),
    );
    expect(result.current.readModel.xlsxOperationActivity).toBeNull();
    expect(result.current.readModel.smartInsertToast).toBeNull();
  });

  it("expires the current smart-insert toast without clearing its replacement", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAppOverlayController());

    act(() =>
      result.current.commands.status.showSmartInsertToast("first", "success"),
    );
    act(() => vi.advanceTimersByTime(1000));
    act(() =>
      result.current.commands.status.showSmartInsertToast("second", "error"),
    );
    act(() => vi.advanceTimersByTime(1999));
    expect(result.current.readModel.smartInsertToast).toBe("second");

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.readModel.smartInsertToast).toBeNull();
    vi.useRealTimers();
  });

  it("rejects an invalid request ID factory before dispatch", () => {
    const { result } = renderHook(() =>
      useAppOverlayController({ createRequestId: () => "" }),
    );

    let thrown: unknown;
    try {
      result.current.commands.item.openEdit(item("invalid"));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppOverlayInvariantError);
    expect((thrown as AppOverlayInvariantError).code).toBe(
      "overlay.controller.request-id",
    );
    expect(result.current.state.item.kind).toBe("inactive");
  });
});
