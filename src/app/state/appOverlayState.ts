import type {
  PendingDuplicateEventImport,
  PendingXlsxRestoreCompletion,
} from "./appOverlayTypes";
import type { PendingEventUpdate } from "../../features/events/updateFlow";
import type { PreparedMapImport } from "../../features/map/domain/mapImportFlow";
import type {
  CellSelectionMode,
  PendingCellSelection,
  PendingVertexSelection,
  VertexSelectionMode,
} from "../../features/app-shell/types";
import type { ShoppingItem } from "../../types/item";
import type { AppBackupV1 } from "../../utils/appBackup";
import type { XlsxProgress } from "../../xlsx/domain/types";

export class AppOverlayInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppOverlayInvariantError";
    this.code = code;
  }
}

export type InactiveOverlayState = Readonly<{ kind: "inactive" }>;

export type ItemOverlayState =
  | InactiveOverlayState
  | Readonly<{
      kind: "edit";
      requestId: string;
      item: ShoppingItem;
    }>
  | Readonly<{
      kind: "delete";
      requestId: string;
      item: ShoppingItem;
    }>;

export type EventOverlayState =
  | InactiveOverlayState
  | Readonly<{
      kind: "update";
      requestId: string;
      pending: PendingEventUpdate;
    }>
  | Readonly<{
      kind: "duplicate";
      requestId: string;
      pending: PendingDuplicateEventImport;
    }>
  | Readonly<{
      kind: "url-update";
      requestId: string;
      eventName: string;
    }>
  | Readonly<{
      kind: "rename";
      requestId: string;
      eventName: string;
    }>
  | Readonly<{
      kind: "export";
      requestId: string;
      eventName: string;
    }>;

export type BackupOverlayState =
  | InactiveOverlayState
  | Readonly<{
      kind: "restore";
      requestId: string;
      backup: AppBackupV1;
      xlsxCompletion: PendingXlsxRestoreCompletion | null;
    }>;

export type MapImportOverlayState =
  | InactiveOverlayState
  | Readonly<{
      kind: "import";
      requestId: string;
      file: File;
      eventName: string;
    }>
  | Readonly<{
      kind: "reimport";
      requestId: string;
      preparedImport: PreparedMapImport;
    }>;

export type MapEditorOverlayKind =
  | "block-definition"
  | "cell-selection"
  | "simple-hall-definition"
  | "global-hall-order"
  | "hall-definition"
  | "vertex-selection";

export type MapEditorOverlayState =
  | InactiveOverlayState
  | Readonly<{
      kind: "block-definition";
      requestId: string;
      pendingSelection: PendingCellSelection;
    }>
  | Readonly<{
      kind: "cell-selection";
      requestId: string;
      selection: NonNullable<CellSelectionMode>;
    }>
  | Readonly<{
      kind: "simple-hall-definition";
      requestId: string;
    }>
  | Readonly<{
      kind: "global-hall-order";
      requestId: string;
    }>
  | Readonly<{
      kind: "hall-definition";
      requestId: string;
      pendingSelection: PendingVertexSelection;
    }>
  | Readonly<{
      kind: "vertex-selection";
      requestId: string;
      selection: NonNullable<VertexSelectionMode>;
    }>;

export type VisitListOverlayState =
  | InactiveOverlayState
  | Readonly<{
      kind: "panel";
      requestId: string;
      mapTab: string;
      originalOrder: readonly string[];
      hasUnsavedChanges: boolean;
    }>
  | Readonly<{
      kind: "confirm-close";
      requestId: string;
      mapTab: string;
      originalOrder: readonly string[];
      pendingTabChange: string | null;
    }>;

export interface XlsxOperationOverlayActivity {
  readonly kind: "import" | "export";
  readonly progress: XlsxProgress | null;
  readonly cancelRequested: boolean;
}

export type ConcurrentOverlayStatus = Readonly<{
  xlsxOperation: Readonly<{
    requestId: string;
    activity: XlsxOperationOverlayActivity;
  }> | null;
  smartInsertToast: Readonly<{
    requestId: string;
    message: string;
    tone: "success" | "error";
  }> | null;
}>;

export interface AppOverlayState {
  readonly item: ItemOverlayState;
  readonly event: EventOverlayState;
  readonly backup: BackupOverlayState;
  readonly mapImport: MapImportOverlayState;
  readonly mapEditor: MapEditorOverlayState;
  readonly visitList: VisitListOverlayState;
  readonly concurrentStatus: ConcurrentOverlayStatus;
}

export interface AppOverlayReadModel {
  readonly editDialogItem: ShoppingItem | null;
  readonly itemToDelete: ShoppingItem | null;
  readonly pendingEventUpdate: PendingEventUpdate | null;
  readonly showUrlUpdateDialog: boolean;
  readonly pendingUpdateEventName: string | null;
  readonly showRenameDialog: boolean;
  readonly eventToRename: string | null;
  readonly pendingDuplicateEvent: PendingDuplicateEventImport | null;
  readonly showExportOptions: boolean;
  readonly exportEventName: string | null;
  readonly pendingBackup: AppBackupV1 | null;
  readonly pendingXlsxRestoreCompletion: PendingXlsxRestoreCompletion | null;
  readonly mapImportDialogOpen: boolean;
  readonly mapImportPendingFile: File | null;
  readonly mapImportPendingEventName: string;
  readonly pendingMapReimport: PreparedMapImport | null;
  readonly blockDefinitionMode: boolean;
  readonly pendingCellSelection: PendingCellSelection;
  readonly cellSelectionMode: CellSelectionMode;
  readonly simpleHallDefinitionMode: boolean;
  readonly globalHallOrderPanelOpen: boolean;
  readonly hallDefinitionMode: boolean;
  readonly pendingVertexSelection: PendingVertexSelection;
  readonly vertexSelectionMode: VertexSelectionMode;
  readonly visitListPanelOpen: boolean;
  readonly visitListPanelMapTab: string | null;
  readonly visitListHasUnsavedChanges: boolean;
  readonly visitListOriginalOrder: readonly string[];
  readonly showVisitListConfirmDialog: boolean;
  readonly pendingTabChange: string | null;
  readonly xlsxOperationActivity: XlsxOperationOverlayActivity | null;
  readonly smartInsertToast: string | null;
  readonly smartInsertToastType: "success" | "error";
}

export type AppOverlayAction =
  | Readonly<{
      type: "item/open-edit";
      requestId: string;
      item: ShoppingItem;
    }>
  | Readonly<{
      type: "item/open-delete";
      requestId: string;
      item: ShoppingItem;
    }>
  | Readonly<{
      type: "item/close" | "item/confirm";
      requestId: string;
      expectedKind: "edit" | "delete";
    }>
  | Readonly<{
      type: "event/open-update";
      requestId: string;
      pending: PendingEventUpdate;
    }>
  | Readonly<{
      type: "event/open-duplicate";
      requestId: string;
      pending: PendingDuplicateEventImport;
    }>
  | Readonly<{
      type: "event/open-url-update" | "event/open-rename" | "event/open-export";
      requestId: string;
      eventName: string;
    }>
  | Readonly<{
      type: "event/close" | "event/confirm";
      requestId: string;
      expectedKind: Exclude<EventOverlayState, InactiveOverlayState>["kind"];
    }>
  | Readonly<{
      type: "backup/open-restore";
      requestId: string;
      backup: AppBackupV1;
      xlsxCompletion: PendingXlsxRestoreCompletion | null;
    }>
  | Readonly<{
      type: "backup/close" | "backup/confirm";
      requestId: string;
    }>
  | Readonly<{
      type: "map-import/open";
      requestId: string;
      file: File;
      eventName: string;
    }>
  | Readonly<{
      type: "map-import/request-reimport";
      requestId: string;
      preparedImport: PreparedMapImport;
    }>
  | Readonly<{
      type: "map-import/close-dialog";
      requestId: string;
    }>
  | Readonly<{
      type: "map-import/cancel-reimport" | "map-import/confirm-reimport";
      requestId: string;
    }>
  | Readonly<{
      type: "map-editor/open-block-definition";
      requestId: string;
      pendingSelection: PendingCellSelection;
    }>
  | Readonly<{
      type:
        | "map-editor/open-simple-hall-definition"
        | "map-editor/open-global-hall-order";
      requestId: string;
    }>
  | Readonly<{
      type: "map-editor/open-hall-definition";
      requestId: string;
      pendingSelection: PendingVertexSelection;
    }>
  | Readonly<{
      type: "map-editor/start-cell-selection";
      requestId: string;
      selection: NonNullable<CellSelectionMode>;
    }>
  | Readonly<{
      type: "map-editor/clear-pending-cell-selection";
      requestId: string;
    }>
  | Readonly<{
      type: "map-editor/toggle-cell";
      requestId: string;
      cell: NonNullable<CellSelectionMode>["clickedCells"][number];
    }>
  | Readonly<{
      type: "map-editor/finish-cell-selection";
      requestId: string;
      pendingSelection: PendingCellSelection;
    }>
  | Readonly<{
      type: "map-editor/start-vertex-selection";
      requestId: string;
      selection: NonNullable<VertexSelectionMode>;
    }>
  | Readonly<{
      type: "map-editor/clear-pending-vertex-selection";
      requestId: string;
    }>
  | Readonly<{
      type: "map-editor/toggle-vertex";
      requestId: string;
      vertex: NonNullable<VertexSelectionMode>["clickedVertices"][number];
    }>
  | Readonly<{
      type: "map-editor/finish-vertex-selection";
      requestId: string;
      pendingSelection: PendingVertexSelection;
    }>
  | Readonly<{
      type: "map-editor/close";
      requestId: string;
      expectedKind: MapEditorOverlayKind;
    }>
  | Readonly<{
      type: "visit-list/open";
      requestId: string;
      mapTab: string;
      originalOrder: readonly string[];
    }>
  | Readonly<{
      type: "visit-list/set-unsaved";
      requestId: string;
      hasUnsavedChanges: boolean;
    }>
  | Readonly<{
      type: "visit-list/request-confirm-close";
      requestId: string;
      pendingTabChange: string | null;
    }>
  | Readonly<{
      type: "visit-list/close-panel";
      requestId: string;
    }>
  | Readonly<{
      type: "visit-list/confirm-close" | "visit-list/discard-close";
      requestId: string;
    }>
  | Readonly<{
      type: "status/set-xlsx-operation";
      requestId: string;
      activity: XlsxOperationOverlayActivity;
    }>
  | Readonly<{
      type: "status/update-xlsx-operation";
      requestId: string;
      activity: XlsxOperationOverlayActivity;
    }>
  | Readonly<{
      type: "status/clear-xlsx-operation";
      requestId: string;
    }>
  | Readonly<{
      type: "status/show-smart-insert-toast";
      requestId: string;
      message: string;
      tone: "success" | "error";
    }>
  | Readonly<{
      type: "status/clear-smart-insert-toast";
      requestId: string;
    }>;

const inactive = (): InactiveOverlayState => ({ kind: "inactive" });
const MAX_VERTEX_SELECTION_COUNT = 6;

export const createInitialAppOverlayState = (): AppOverlayState => ({
  item: inactive(),
  event: inactive(),
  backup: inactive(),
  mapImport: inactive(),
  mapEditor: inactive(),
  visitList: inactive(),
  concurrentStatus: {
    xlsxOperation: null,
    smartInsertToast: null,
  },
});

const fail = (code: string, message: string): never => {
  throw new AppOverlayInvariantError(code, message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertRecord = (value: unknown, code: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(code, `${code}: object payload is required.`);

const assertExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${code}: payload keys must be ${expected.join(", ")}.`);
  }
};

const assertNonEmptyString = (value: unknown, code: string): string =>
  typeof value === "string" && value.trim().length > 0
    ? value
    : fail(code, `${code}: non-empty string is required.`);

const assertRequestId = (value: unknown, code: string): string =>
  assertNonEmptyString(value, code);

const assertObjectPayload = (value: unknown, code: string): void => {
  assertRecord(value, code);
};

const assertFilePayload = (value: unknown, code: string): void => {
  const candidate = assertRecord(value, code);
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.arrayBuffer !== "function"
  ) {
    fail(code, `${code}: File-compatible payload is required.`);
  }
};

const assertStringArray = (value: unknown, code: string): void => {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    fail(code, `${code}: string array is required.`);
  }
};

const assertInactive = (value: unknown, code: string): void => {
  const record = assertRecord(value, code);
  assertExactKeys(record, ["kind"], code);
  if (record.kind !== "inactive")
    fail(code, `${code}: inactive state required.`);
};

const assertRequestState = (
  record: Record<string, unknown>,
  keys: readonly string[],
  code: string,
): void => {
  assertExactKeys(record, ["kind", "requestId", ...keys], code);
  assertRequestId(record.requestId, `${code}.requestId`);
};

const assertItemOverlayState = (value: unknown): void => {
  const record = assertRecord(value, "overlay.item");
  if (record.kind === "inactive") return assertInactive(record, "overlay.item");
  if (record.kind !== "edit" && record.kind !== "delete") {
    fail("overlay.item.kind", "Unknown item overlay kind.");
  }
  assertRequestState(record, ["item"], "overlay.item");
  assertObjectPayload(record.item, "overlay.item.item");
};

const assertEventOverlayState = (value: unknown): void => {
  const record = assertRecord(value, "overlay.event");
  if (record.kind === "inactive")
    return assertInactive(record, "overlay.event");
  if (record.kind === "update" || record.kind === "duplicate") {
    assertRequestState(record, ["pending"], "overlay.event");
    assertObjectPayload(record.pending, "overlay.event.pending");
    return;
  }
  if (
    record.kind === "url-update" ||
    record.kind === "rename" ||
    record.kind === "export"
  ) {
    assertRequestState(record, ["eventName"], "overlay.event");
    assertNonEmptyString(record.eventName, "overlay.event.eventName");
    return;
  }
  fail("overlay.event.kind", "Unknown event overlay kind.");
};

const assertBackupOverlayState = (value: unknown): void => {
  const record = assertRecord(value, "overlay.backup");
  if (record.kind === "inactive")
    return assertInactive(record, "overlay.backup");
  if (record.kind !== "restore") {
    fail("overlay.backup.kind", "Unknown backup overlay kind.");
  }
  assertRequestState(record, ["backup", "xlsxCompletion"], "overlay.backup");
  assertObjectPayload(record.backup, "overlay.backup.backup");
  if (record.xlsxCompletion !== null) {
    const completion = assertRecord(
      record.xlsxCompletion,
      "overlay.backup.xlsxCompletion",
    );
    assertExactKeys(
      completion,
      ["errors", "itemCount"],
      "overlay.backup.xlsxCompletion",
    );
    assertStringArray(
      completion.errors,
      "overlay.backup.xlsxCompletion.errors",
    );
    if (
      typeof completion.itemCount !== "number" ||
      !Number.isInteger(completion.itemCount) ||
      completion.itemCount < 0
    ) {
      fail(
        "overlay.backup.xlsxCompletion.itemCount",
        "XLSX itemCount must be a non-negative integer.",
      );
    }
  }
};

const assertMapImportOverlayState = (value: unknown): void => {
  const record = assertRecord(value, "overlay.mapImport");
  if (record.kind === "inactive") {
    return assertInactive(record, "overlay.mapImport");
  }
  if (record.kind === "import") {
    assertRequestState(record, ["file", "eventName"], "overlay.mapImport");
    assertFilePayload(record.file, "overlay.mapImport.file");
    assertNonEmptyString(record.eventName, "overlay.mapImport.eventName");
    return;
  }
  if (record.kind === "reimport") {
    assertRequestState(record, ["preparedImport"], "overlay.mapImport");
    const prepared = assertRecord(
      record.preparedImport,
      "overlay.mapImport.preparedImport",
    );
    const plan = assertRecord(
      prepared.plan,
      "overlay.mapImport.preparedImport.plan",
    );
    assertNonEmptyString(
      plan.eventName,
      "overlay.mapImport.preparedImport.plan.eventName",
    );
    return;
  }
  fail("overlay.mapImport.kind", "Unknown map import overlay kind.");
};

const assertMapEditorOverlayState = (value: unknown): void => {
  const record = assertRecord(value, "overlay.mapEditor");
  if (record.kind === "inactive") {
    return assertInactive(record, "overlay.mapEditor");
  }
  if (
    record.kind === "simple-hall-definition" ||
    record.kind === "global-hall-order"
  ) {
    assertRequestState(record, [], "overlay.mapEditor");
    return;
  }
  if (record.kind === "block-definition" || record.kind === "hall-definition") {
    assertRequestState(record, ["pendingSelection"], "overlay.mapEditor");
    if (
      record.pendingSelection !== null &&
      !isRecord(record.pendingSelection)
    ) {
      fail(
        "overlay.mapEditor.pendingSelection",
        "Pending selection must be an object or null.",
      );
    }
    return;
  }
  if (record.kind === "cell-selection" || record.kind === "vertex-selection") {
    assertRequestState(record, ["selection"], "overlay.mapEditor");
    assertObjectPayload(record.selection, "overlay.mapEditor.selection");
    return;
  }
  fail("overlay.mapEditor.kind", "Unknown map editor overlay kind.");
};

const assertVisitListOverlayState = (value: unknown): void => {
  const record = assertRecord(value, "overlay.visitList");
  if (record.kind === "inactive") {
    return assertInactive(record, "overlay.visitList");
  }
  if (record.kind === "panel") {
    assertRequestState(
      record,
      ["mapTab", "originalOrder", "hasUnsavedChanges"],
      "overlay.visitList",
    );
    assertNonEmptyString(record.mapTab, "overlay.visitList.mapTab");
    assertStringArray(record.originalOrder, "overlay.visitList.originalOrder");
    if (typeof record.hasUnsavedChanges !== "boolean") {
      fail(
        "overlay.visitList.hasUnsavedChanges",
        "Visit-list unsaved flag must be boolean.",
      );
    }
    return;
  }
  if (record.kind === "confirm-close") {
    assertRequestState(
      record,
      ["mapTab", "originalOrder", "pendingTabChange"],
      "overlay.visitList",
    );
    assertNonEmptyString(record.mapTab, "overlay.visitList.mapTab");
    assertStringArray(record.originalOrder, "overlay.visitList.originalOrder");
    if (
      record.pendingTabChange !== null &&
      typeof record.pendingTabChange !== "string"
    ) {
      fail(
        "overlay.visitList.pendingTabChange",
        "Pending tab must be a string or null.",
      );
    }
    return;
  }
  fail("overlay.visitList.kind", "Unknown visit-list overlay kind.");
};

const assertXlsxActivity = (value: unknown, code: string): void => {
  const activity = assertRecord(value, code);
  assertExactKeys(activity, ["kind", "progress", "cancelRequested"], code);
  if (activity.kind !== "import" && activity.kind !== "export") {
    fail(`${code}.kind`, "XLSX operation kind must be import or export.");
  }
  if (activity.progress !== null && !isRecord(activity.progress)) {
    fail(`${code}.progress`, "XLSX progress must be an object or null.");
  }
  if (typeof activity.cancelRequested !== "boolean") {
    fail(`${code}.cancelRequested`, "XLSX cancel flag must be boolean.");
  }
};

const assertConcurrentStatus = (value: unknown): void => {
  const record = assertRecord(value, "overlay.concurrentStatus");
  assertExactKeys(
    record,
    ["xlsxOperation", "smartInsertToast"],
    "overlay.concurrentStatus",
  );
  if (record.xlsxOperation !== null) {
    const operation = assertRecord(
      record.xlsxOperation,
      "overlay.concurrentStatus.xlsxOperation",
    );
    assertExactKeys(
      operation,
      ["requestId", "activity"],
      "overlay.concurrentStatus.xlsxOperation",
    );
    assertRequestId(
      operation.requestId,
      "overlay.concurrentStatus.xlsxOperation.requestId",
    );
    assertXlsxActivity(
      operation.activity,
      "overlay.concurrentStatus.xlsxOperation.activity",
    );
  }
  if (record.smartInsertToast !== null) {
    const toast = assertRecord(
      record.smartInsertToast,
      "overlay.concurrentStatus.smartInsertToast",
    );
    assertExactKeys(
      toast,
      ["requestId", "message", "tone"],
      "overlay.concurrentStatus.smartInsertToast",
    );
    assertRequestId(
      toast.requestId,
      "overlay.concurrentStatus.smartInsertToast.requestId",
    );
    assertNonEmptyString(
      toast.message,
      "overlay.concurrentStatus.smartInsertToast.message",
    );
    if (toast.tone !== "success" && toast.tone !== "error") {
      fail(
        "overlay.concurrentStatus.smartInsertToast.tone",
        "Toast tone must be success or error.",
      );
    }
  }
};

export function assertAppOverlayState(
  value: unknown,
): asserts value is AppOverlayState {
  const record = assertRecord(value, "overlay");
  assertExactKeys(
    record,
    [
      "item",
      "event",
      "backup",
      "mapImport",
      "mapEditor",
      "visitList",
      "concurrentStatus",
    ],
    "overlay",
  );
  assertItemOverlayState(record.item);
  assertEventOverlayState(record.event);
  assertBackupOverlayState(record.backup);
  assertMapImportOverlayState(record.mapImport);
  assertMapEditorOverlayState(record.mapEditor);
  assertVisitListOverlayState(record.visitList);
  assertConcurrentStatus(record.concurrentStatus);
}

const requireInactive = (
  family: InactiveOverlayState | { readonly kind: string },
  code: string,
): void => {
  if (family.kind !== "inactive") {
    fail(code, `${code}: another overlay in this family is already active.`);
  }
};

const requireCurrent = <
  T extends { readonly kind: string; readonly requestId?: string },
>(
  family: T,
  requestId: string,
  expectedKind: string,
  code: string,
): void => {
  assertRequestId(requestId, `${code}.requestId`);
  if (family.kind !== expectedKind || family.requestId !== requestId) {
    fail(code, `${code}: stale or mismatched overlay action rejected.`);
  }
};

const checked = (state: AppOverlayState): AppOverlayState => {
  assertAppOverlayState(state);
  return state;
};

export const reduceAppOverlayState = (
  state: AppOverlayState,
  action: AppOverlayAction,
): AppOverlayState => {
  assertAppOverlayState(state);
  const actionRecord = assertRecord(action, "overlay.action");

  switch (action.type) {
    case "item/open-edit":
    case "item/open-delete": {
      requireInactive(state.item, "overlay.item.busy");
      assertRequestId(action.requestId, "overlay.item.requestId");
      assertObjectPayload(action.item, "overlay.item.item");
      return checked({
        ...state,
        item: {
          kind: action.type === "item/open-edit" ? "edit" : "delete",
          requestId: action.requestId,
          item: action.item,
        },
      });
    }
    case "item/close":
    case "item/confirm":
      requireCurrent(
        state.item,
        action.requestId,
        action.expectedKind,
        "overlay.item.stale-action",
      );
      return checked({ ...state, item: inactive() });

    case "event/open-update":
    case "event/open-duplicate": {
      requireInactive(state.event, "overlay.event.busy");
      assertRequestId(action.requestId, "overlay.event.requestId");
      assertObjectPayload(action.pending, "overlay.event.pending");
      return checked({
        ...state,
        event: {
          kind: action.type === "event/open-update" ? "update" : "duplicate",
          requestId: action.requestId,
          pending: action.pending,
        } as EventOverlayState,
      });
    }
    case "event/open-url-update":
    case "event/open-rename":
    case "event/open-export": {
      requireInactive(state.event, "overlay.event.busy");
      assertRequestId(action.requestId, "overlay.event.requestId");
      assertNonEmptyString(action.eventName, "overlay.event.eventName");
      const kind =
        action.type === "event/open-url-update"
          ? "url-update"
          : action.type === "event/open-rename"
            ? "rename"
            : "export";
      return checked({
        ...state,
        event: {
          kind,
          requestId: action.requestId,
          eventName: action.eventName,
        },
      });
    }
    case "event/close":
    case "event/confirm":
      requireCurrent(
        state.event,
        action.requestId,
        action.expectedKind,
        "overlay.event.stale-action",
      );
      return checked({ ...state, event: inactive() });

    case "backup/open-restore":
      requireInactive(state.backup, "overlay.backup.busy");
      return checked({
        ...state,
        backup: {
          kind: "restore",
          requestId: assertRequestId(
            action.requestId,
            "overlay.backup.requestId",
          ),
          backup: action.backup,
          xlsxCompletion: action.xlsxCompletion,
        },
      });
    case "backup/close":
    case "backup/confirm":
      requireCurrent(
        state.backup,
        action.requestId,
        "restore",
        "overlay.backup.stale-action",
      );
      return checked({ ...state, backup: inactive() });

    case "map-import/open":
      requireInactive(state.mapImport, "overlay.mapImport.busy");
      assertFilePayload(action.file, "overlay.mapImport.file");
      return checked({
        ...state,
        mapImport: {
          kind: "import",
          requestId: assertRequestId(
            action.requestId,
            "overlay.mapImport.requestId",
          ),
          file: action.file,
          eventName: assertNonEmptyString(
            action.eventName,
            "overlay.mapImport.eventName",
          ),
        },
      });
    case "map-import/request-reimport":
      requireCurrent(
        state.mapImport,
        action.requestId,
        "import",
        "overlay.mapImport.stale-dialog-action",
      );
      return checked({
        ...state,
        mapImport: {
          kind: "reimport",
          requestId: action.requestId,
          preparedImport: action.preparedImport,
        },
      });
    case "map-import/close-dialog":
      requireCurrent(
        state.mapImport,
        action.requestId,
        "import",
        "overlay.mapImport.stale-dialog-action",
      );
      return checked({ ...state, mapImport: inactive() });
    case "map-import/cancel-reimport":
    case "map-import/confirm-reimport":
      requireCurrent(
        state.mapImport,
        action.requestId,
        "reimport",
        "overlay.mapImport.stale-reimport-action",
      );
      return checked({ ...state, mapImport: inactive() });

    case "map-editor/open-block-definition":
      requireInactive(state.mapEditor, "overlay.mapEditor.busy");
      return checked({
        ...state,
        mapEditor: {
          kind: "block-definition",
          requestId: assertRequestId(
            action.requestId,
            "overlay.mapEditor.requestId",
          ),
          pendingSelection: action.pendingSelection,
        },
      });
    case "map-editor/open-simple-hall-definition":
    case "map-editor/open-global-hall-order":
      requireInactive(state.mapEditor, "overlay.mapEditor.busy");
      return checked({
        ...state,
        mapEditor: {
          kind:
            action.type === "map-editor/open-simple-hall-definition"
              ? "simple-hall-definition"
              : "global-hall-order",
          requestId: assertRequestId(
            action.requestId,
            "overlay.mapEditor.requestId",
          ),
        },
      });
    case "map-editor/open-hall-definition":
      requireInactive(state.mapEditor, "overlay.mapEditor.busy");
      return checked({
        ...state,
        mapEditor: {
          kind: "hall-definition",
          requestId: assertRequestId(
            action.requestId,
            "overlay.mapEditor.requestId",
          ),
          pendingSelection: action.pendingSelection,
        },
      });
    case "map-editor/start-cell-selection":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        "block-definition",
        "overlay.mapEditor.stale-block-action",
      );
      return checked({
        ...state,
        mapEditor: {
          kind: "cell-selection",
          requestId: action.requestId,
          selection: action.selection,
        },
      });
    case "map-editor/clear-pending-cell-selection":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        "block-definition",
        "overlay.mapEditor.stale-block-action",
      );
      return checked({
        ...state,
        mapEditor: {
          kind: "block-definition",
          requestId: action.requestId,
          pendingSelection: null,
        },
      });
    case "map-editor/toggle-cell": {
      const mapEditor = state.mapEditor;
      requireCurrent(
        mapEditor,
        action.requestId,
        "cell-selection",
        "overlay.mapEditor.stale-cell-action",
      );
      if (mapEditor.kind !== "cell-selection") {
        return fail(
          "overlay.mapEditor.stale-cell-action",
          "Cell selection update requires the active selection.",
        );
      }
      const existingIndex = mapEditor.selection.clickedCells.findIndex(
        (cell) => cell.row === action.cell.row && cell.col === action.cell.col,
      );
      const clickedCells =
        existingIndex >= 0
          ? mapEditor.selection.clickedCells.filter(
              (_cell, index) => index !== existingIndex,
            )
          : [...mapEditor.selection.clickedCells, action.cell];
      return checked({
        ...state,
        mapEditor: {
          ...mapEditor,
          selection: { ...mapEditor.selection, clickedCells },
        },
      });
    }
    case "map-editor/finish-cell-selection":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        "cell-selection",
        "overlay.mapEditor.stale-cell-action",
      );
      return checked({
        ...state,
        mapEditor: {
          kind: "block-definition",
          requestId: action.requestId,
          pendingSelection: action.pendingSelection,
        },
      });
    case "map-editor/start-vertex-selection":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        "hall-definition",
        "overlay.mapEditor.stale-hall-action",
      );
      return checked({
        ...state,
        mapEditor: {
          kind: "vertex-selection",
          requestId: action.requestId,
          selection: action.selection,
        },
      });
    case "map-editor/clear-pending-vertex-selection":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        "hall-definition",
        "overlay.mapEditor.stale-hall-action",
      );
      return checked({
        ...state,
        mapEditor: {
          kind: "hall-definition",
          requestId: action.requestId,
          pendingSelection: null,
        },
      });
    case "map-editor/toggle-vertex": {
      const mapEditor = state.mapEditor;
      requireCurrent(
        mapEditor,
        action.requestId,
        "vertex-selection",
        "overlay.mapEditor.stale-vertex-action",
      );
      if (mapEditor.kind !== "vertex-selection") {
        return fail(
          "overlay.mapEditor.stale-vertex-action",
          "Vertex selection update requires the active selection.",
        );
      }
      const existingIndex = mapEditor.selection.clickedVertices.findIndex(
        (vertex) =>
          vertex.row === action.vertex.row && vertex.col === action.vertex.col,
      );
      if (
        existingIndex < 0 &&
        mapEditor.selection.clickedVertices.length >= MAX_VERTEX_SELECTION_COUNT
      ) {
        return state;
      }
      const clickedVertices =
        existingIndex >= 0
          ? mapEditor.selection.clickedVertices.filter(
              (_vertex, index) => index !== existingIndex,
            )
          : [...mapEditor.selection.clickedVertices, action.vertex];
      return checked({
        ...state,
        mapEditor: {
          ...mapEditor,
          selection: { ...mapEditor.selection, clickedVertices },
        },
      });
    }
    case "map-editor/finish-vertex-selection":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        "vertex-selection",
        "overlay.mapEditor.stale-vertex-action",
      );
      return checked({
        ...state,
        mapEditor: {
          kind: "hall-definition",
          requestId: action.requestId,
          pendingSelection: action.pendingSelection,
        },
      });
    case "map-editor/close":
      requireCurrent(
        state.mapEditor,
        action.requestId,
        action.expectedKind,
        "overlay.mapEditor.stale-close",
      );
      return checked({ ...state, mapEditor: inactive() });

    case "visit-list/open":
      requireInactive(state.visitList, "overlay.visitList.busy");
      assertStringArray(
        action.originalOrder,
        "overlay.visitList.originalOrder",
      );
      return checked({
        ...state,
        visitList: {
          kind: "panel",
          requestId: assertRequestId(
            action.requestId,
            "overlay.visitList.requestId",
          ),
          mapTab: assertNonEmptyString(
            action.mapTab,
            "overlay.visitList.mapTab",
          ),
          originalOrder: [...action.originalOrder],
          hasUnsavedChanges: false,
        },
      });
    case "visit-list/set-unsaved": {
      const visitList = state.visitList;
      requireCurrent(
        visitList,
        action.requestId,
        "panel",
        "overlay.visitList.stale-panel-action",
      );
      if (visitList.kind !== "panel") {
        throw new AppOverlayInvariantError(
          "overlay.visitList.stale-panel-action",
          "Visit-list panel action requires the active panel.",
        );
      }
      return checked({
        ...state,
        visitList: {
          ...visitList,
          hasUnsavedChanges: action.hasUnsavedChanges,
        },
      });
    }
    case "visit-list/request-confirm-close": {
      const visitList = state.visitList;
      requireCurrent(
        visitList,
        action.requestId,
        "panel",
        "overlay.visitList.stale-panel-action",
      );
      if (visitList.kind !== "panel") {
        throw new AppOverlayInvariantError(
          "overlay.visitList.stale-panel-action",
          "Visit-list confirmation requires the active panel.",
        );
      }
      if (!visitList.hasUnsavedChanges) {
        fail(
          "overlay.visitList.no-unsaved-changes",
          "Visit-list confirmation requires unsaved changes.",
        );
      }
      return checked({
        ...state,
        visitList: {
          kind: "confirm-close",
          requestId: action.requestId,
          mapTab: visitList.mapTab,
          originalOrder: visitList.originalOrder,
          pendingTabChange: action.pendingTabChange,
        },
      });
    }
    case "visit-list/close-panel":
      requireCurrent(
        state.visitList,
        action.requestId,
        "panel",
        "overlay.visitList.stale-panel-action",
      );
      return checked({ ...state, visitList: inactive() });
    case "visit-list/confirm-close":
    case "visit-list/discard-close":
      requireCurrent(
        state.visitList,
        action.requestId,
        "confirm-close",
        "overlay.visitList.stale-confirm-action",
      );
      return checked({ ...state, visitList: inactive() });

    case "status/set-xlsx-operation":
      assertXlsxActivity(
        action.activity,
        "overlay.concurrentStatus.xlsxOperation.activity",
      );
      return checked({
        ...state,
        concurrentStatus: {
          ...state.concurrentStatus,
          xlsxOperation: {
            requestId: assertRequestId(
              action.requestId,
              "overlay.concurrentStatus.xlsxOperation.requestId",
            ),
            activity: action.activity,
          },
        },
      });
    case "status/update-xlsx-operation":
      if (
        state.concurrentStatus.xlsxOperation?.requestId !== action.requestId
      ) {
        fail(
          "overlay.concurrentStatus.stale-xlsx-action",
          "Stale XLSX status action rejected.",
        );
      }
      assertXlsxActivity(
        action.activity,
        "overlay.concurrentStatus.xlsxOperation.activity",
      );
      return checked({
        ...state,
        concurrentStatus: {
          ...state.concurrentStatus,
          xlsxOperation: {
            requestId: action.requestId,
            activity: action.activity,
          },
        },
      });
    case "status/clear-xlsx-operation":
      if (
        state.concurrentStatus.xlsxOperation?.requestId !== action.requestId
      ) {
        fail(
          "overlay.concurrentStatus.stale-xlsx-action",
          "Stale XLSX status action rejected.",
        );
      }
      return checked({
        ...state,
        concurrentStatus: {
          ...state.concurrentStatus,
          xlsxOperation: null,
        },
      });
    case "status/show-smart-insert-toast":
      return checked({
        ...state,
        concurrentStatus: {
          ...state.concurrentStatus,
          smartInsertToast: {
            requestId: assertRequestId(
              action.requestId,
              "overlay.concurrentStatus.smartInsertToast.requestId",
            ),
            message: assertNonEmptyString(
              action.message,
              "overlay.concurrentStatus.smartInsertToast.message",
            ),
            tone: action.tone,
          },
        },
      });
    case "status/clear-smart-insert-toast":
      if (
        state.concurrentStatus.smartInsertToast?.requestId !== action.requestId
      ) {
        fail(
          "overlay.concurrentStatus.stale-toast-action",
          "Stale toast action rejected.",
        );
      }
      return checked({
        ...state,
        concurrentStatus: {
          ...state.concurrentStatus,
          smartInsertToast: null,
        },
      });
    default:
      return fail(
        "overlay.action.type",
        `Unknown overlay action: ${String(actionRecord.type)}.`,
      );
  }
};

export const selectAppOverlayReadModel = (
  state: AppOverlayState,
): AppOverlayReadModel => {
  assertAppOverlayState(state);
  const mapImportEventName =
    state.mapImport.kind === "import"
      ? state.mapImport.eventName
      : state.mapImport.kind === "reimport"
        ? state.mapImport.preparedImport.plan.eventName
        : "";
  return {
    editDialogItem: state.item.kind === "edit" ? state.item.item : null,
    itemToDelete: state.item.kind === "delete" ? state.item.item : null,
    pendingEventUpdate:
      state.event.kind === "update" ? state.event.pending : null,
    showUrlUpdateDialog: state.event.kind === "url-update",
    pendingUpdateEventName:
      state.event.kind === "url-update" ? state.event.eventName : null,
    showRenameDialog: state.event.kind === "rename",
    eventToRename: state.event.kind === "rename" ? state.event.eventName : null,
    pendingDuplicateEvent:
      state.event.kind === "duplicate" ? state.event.pending : null,
    showExportOptions: state.event.kind === "export",
    exportEventName:
      state.event.kind === "export" ? state.event.eventName : null,
    pendingBackup: state.backup.kind === "restore" ? state.backup.backup : null,
    pendingXlsxRestoreCompletion:
      state.backup.kind === "restore" ? state.backup.xlsxCompletion : null,
    mapImportDialogOpen: state.mapImport.kind === "import",
    mapImportPendingFile:
      state.mapImport.kind === "import" ? state.mapImport.file : null,
    mapImportPendingEventName: mapImportEventName,
    pendingMapReimport:
      state.mapImport.kind === "reimport"
        ? state.mapImport.preparedImport
        : null,
    blockDefinitionMode: state.mapEditor.kind === "block-definition",
    pendingCellSelection:
      state.mapEditor.kind === "block-definition"
        ? state.mapEditor.pendingSelection
        : null,
    cellSelectionMode:
      state.mapEditor.kind === "cell-selection"
        ? state.mapEditor.selection
        : null,
    simpleHallDefinitionMode: state.mapEditor.kind === "simple-hall-definition",
    globalHallOrderPanelOpen: state.mapEditor.kind === "global-hall-order",
    hallDefinitionMode: state.mapEditor.kind === "hall-definition",
    pendingVertexSelection:
      state.mapEditor.kind === "hall-definition"
        ? state.mapEditor.pendingSelection
        : null,
    vertexSelectionMode:
      state.mapEditor.kind === "vertex-selection"
        ? state.mapEditor.selection
        : null,
    visitListPanelOpen:
      state.visitList.kind === "panel" ||
      state.visitList.kind === "confirm-close",
    visitListPanelMapTab:
      state.visitList.kind === "inactive" ? null : state.visitList.mapTab,
    visitListHasUnsavedChanges:
      state.visitList.kind === "panel"
        ? state.visitList.hasUnsavedChanges
        : state.visitList.kind === "confirm-close",
    visitListOriginalOrder:
      state.visitList.kind === "inactive"
        ? []
        : [...state.visitList.originalOrder],
    showVisitListConfirmDialog: state.visitList.kind === "confirm-close",
    pendingTabChange:
      state.visitList.kind === "confirm-close"
        ? state.visitList.pendingTabChange
        : null,
    xlsxOperationActivity:
      state.concurrentStatus.xlsxOperation?.activity ?? null,
    smartInsertToast: state.concurrentStatus.smartInsertToast?.message ?? null,
    smartInsertToastType:
      state.concurrentStatus.smartInsertToast?.tone ?? "success",
  };
};

export type ActiveAppOverlayKind =
  | `item:${Exclude<ItemOverlayState, InactiveOverlayState>["kind"]}`
  | `event:${Exclude<EventOverlayState, InactiveOverlayState>["kind"]}`
  | `backup:${Exclude<BackupOverlayState, InactiveOverlayState>["kind"]}`
  | `map-import:${Exclude<MapImportOverlayState, InactiveOverlayState>["kind"]}`
  | `map-editor:${Exclude<MapEditorOverlayState, InactiveOverlayState>["kind"]}`
  | `visit-list:${Exclude<VisitListOverlayState, InactiveOverlayState>["kind"]}`;

export const selectActiveAppOverlayKinds = (
  state: AppOverlayState,
): ActiveAppOverlayKind[] => {
  assertAppOverlayState(state);
  const active: ActiveAppOverlayKind[] = [];
  if (state.item.kind !== "inactive") active.push(`item:${state.item.kind}`);
  if (state.event.kind !== "inactive") active.push(`event:${state.event.kind}`);
  if (state.backup.kind !== "inactive") {
    active.push(`backup:${state.backup.kind}`);
  }
  if (state.mapImport.kind !== "inactive") {
    active.push(`map-import:${state.mapImport.kind}`);
  }
  if (state.mapEditor.kind !== "inactive") {
    active.push(`map-editor:${state.mapEditor.kind}`);
  }
  if (state.visitList.kind !== "inactive") {
    active.push(`visit-list:${state.visitList.kind}`);
  }
  return active;
};

export const selectHasBlockingAppOverlay = (state: AppOverlayState): boolean =>
  selectActiveAppOverlayKinds(state).length > 0;

export const selectConcurrentOverlayStatus = (
  state: AppOverlayState,
): ConcurrentOverlayStatus => {
  assertAppOverlayState(state);
  return state.concurrentStatus;
};
