// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import type { BulkAddMetadata } from "../../features/events/bulkAdd";
import type {
  DuplicateEventResolution,
  SameSourceEventAnalysis,
} from "../../features/events/duplicateEvent";
import type { EventUpdateDiff } from "../../features/events/updateDiff";
import type {
  EventUpdateCommitState,
  PendingEventUpdate,
} from "../../features/events/updateFlow";
import type { PendingDuplicateEventImport } from "../state/appOverlayTypes";

const updateFlowMocks = vi.hoisted(() => ({
  buildEventUpdateDiffFromSpreadsheet: vi.fn(),
}));

vi.mock("../../features/events/updateFlow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../features/events/updateFlow")>();
  return {
    ...actual,
    buildEventUpdateDiffFromSpreadsheet:
      updateFlowMocks.buildEventUpdateDiffFromSpreadsheet,
  };
});

import {
  useEventUpdateCommands,
  type EventUpdateActionPort,
  type EventUpdateCommandPorts,
  type EventUpdateStatePort,
} from "./useEventUpdateCommands";

const EVENT = "イベントA";
const DAY = "1日目";
const SOURCE = {
  url: "https://docs.google.com/spreadsheets/d/source",
  sheetName: "一覧",
};

const item = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `サークル-${id}`,
  eventDate: DAY,
  block: "東A",
  number: "01a",
  title: `頒布物-${id}`,
  price: 1000,
  quantity: 1,
  purchaseStatus: "None",
  remarks: "",
  source: "spreadsheet",
  ...overrides,
});

const diff = (overrides: Partial<EventUpdateDiff> = {}): EventUpdateDiff => ({
  itemsToDelete: [],
  itemsToUpdate: [],
  itemsToAdd: [],
  protectedFromDelete: 0,
  protectedFromUpdate: 0,
  quantityWarnings: [],
  pendingPurchasedQuantityChanges: [],
  limitedPurchaseQuantityConflicts: [],
  ...overrides,
});

const duplicateAnalysis = (
  incomingItems: SameSourceEventAnalysis["incomingItems"],
): SameSourceEventAnalysis => ({
  kind: "same-source",
  eventName: EVENT,
  incomingItems,
  itemsForFixedAdd: incomingItems,
  duplicateItemCount: 0,
  incomingSource: SOURCE,
  incomingSourceIdentity: null,
  existingSource: SOURCE,
  existingSourceIdentity: null,
  sourceComparison: {
    primaryMatch: true,
    gidComparison: "not-comparable",
    isSameSource: true,
  },
});

interface HarnessStores {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
  pendingDuplicateEvent: PendingDuplicateEventImport | null;
  pendingEventUpdate: PendingEventUpdate | null;
  pendingUpdateEventName: string | null;
  showUrlUpdateDialog: boolean;
}

interface HarnessOptions extends Partial<
  Pick<
    EventUpdateStatePort,
    | "eventLists"
    | "eventMetadata"
    | "pendingDuplicateEvent"
    | "pendingEventUpdate"
    | "pendingUpdateEventName"
  >
> {
  executeModeItems?: Record<string, ExecuteModeItems>;
  pendingBaseItems?: ShoppingItem[] | null;
}

const createHarness = (options: HarnessOptions = {}) => {
  const initialItems = [item("keep"), item("delete")];
  const eventLists = options.eventLists ?? { [EVENT]: initialItems };
  const eventMetadata = options.eventMetadata ?? {
    [EVENT]: {
      spreadsheetUrl: SOURCE.url,
      spreadsheetSheetName: SOURCE.sheetName,
      lastImportDate: "2026-08-09T00:00:00.000Z",
    },
  };
  const executeModeItems = options.executeModeItems ?? {
    [EVENT]: { [DAY]: initialItems.map(({ id }) => id) },
  };
  const stores: HarnessStores = {
    eventLists,
    eventMetadata,
    executeModeItems,
    pendingDuplicateEvent: options.pendingDuplicateEvent ?? null,
    pendingEventUpdate: options.pendingEventUpdate ?? null,
    pendingUpdateEventName: options.pendingUpdateEventName ?? null,
    showUrlUpdateDialog: false,
  };
  const refs = {
    eventListsRef: { current: eventLists },
    eventMetadataRef: { current: eventMetadata },
    executeModeItemsRef: { current: executeModeItems },
    pendingEventUpdateBaseItemsRef: {
      current:
        options.pendingBaseItems === undefined
          ? (eventLists[EVENT] ?? null)
          : options.pendingBaseItems,
    },
    eventUpdatePreviewEpochRef: { current: 0 },
  };
  const applyBulkAdd =
    vi.fn<
      (
        eventName: string,
        items: SameSourceEventAnalysis["incomingItems"],
        metadata?: BulkAddMetadata,
      ) => Promise<void>
    >();
  const commitEventUpdateState = vi.fn(async (next: EventUpdateCommitState) => {
    stores.eventLists = next.eventLists;
    stores.eventMetadata = next.eventMetadata;
    stores.executeModeItems = next.executeModeItems;
    refs.eventListsRef.current = next.eventLists;
    refs.eventMetadataRef.current = next.eventMetadata;
    refs.executeModeItemsRef.current = next.executeModeItems;
    return true;
  });
  const closeEventOverlay = vi.fn(() => {
    stores.pendingDuplicateEvent = null;
    stores.pendingEventUpdate = null;
    stores.pendingUpdateEventName = null;
    stores.showUrlUpdateDialog = false;
  });
  const openEventUpdate = vi.fn((value: PendingEventUpdate) => {
    closeEventOverlay();
    stores.pendingEventUpdate = value;
  });
  const openUrlUpdate = vi.fn((eventName: string) => {
    closeEventOverlay();
    stores.pendingUpdateEventName = eventName;
    stores.showUrlUpdateDialog = true;
  });
  const confirmEventOverlay = vi.fn(closeEventOverlay);
  const notify = vi.fn();
  const reportError = vi.fn();
  const actions: EventUpdateActionPort = {
    applyBulkAdd,
    commitEventUpdateState,
    openEventUpdate,
    openUrlUpdate,
    closeEventOverlay,
    confirmEventOverlay,
  };
  const ports: EventUpdateCommandPorts = {
    state: {
      eventLists,
      eventMetadata,
      pendingDuplicateEvent: stores.pendingDuplicateEvent,
      pendingEventUpdate: stores.pendingEventUpdate,
      pendingUpdateEventName: stores.pendingUpdateEventName,
      ...refs,
    },
    actions,
    effects: { notify, reportError },
  };

  return {
    ports,
    stores,
    refs,
    spies: {
      applyBulkAdd,
      commitEventUpdateState,
      openEventUpdate,
      openUrlUpdate,
      closeEventOverlay,
      confirmEventOverlay,
      notify,
      reportError,
    },
  };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("useEventUpdateCommands", () => {
  beforeEach(() => {
    updateFlowMocks.buildEventUpdateDiffFromSpreadsheet.mockReset();
  });

  it("commits only the newest preview from the current event-list identity", async () => {
    const first = deferred<EventUpdateDiff>();
    const second = deferred<EventUpdateDiff>();
    const firstDiff = diff({ protectedFromDelete: 1 });
    const secondDiff = diff({ protectedFromUpdate: 2 });
    updateFlowMocks.buildEventUpdateDiffFromSpreadsheet
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const harness = createHarness();
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.handleUpdateEvent(EVENT);
      secondRequest = result.current.handleUpdateEvent(EVENT);
    });
    await act(async () => {
      second.resolve(secondDiff);
      await secondRequest;
    });
    await act(async () => {
      first.resolve(firstDiff);
      await firstRequest;
    });

    const committed = harness.spies.openEventUpdate.mock.calls.map(
      ([value]) => value,
    );
    expect(committed).toEqual([
      { kind: "items-only", eventName: EVENT, diff: secondDiff },
    ]);
    expect(harness.refs.pendingEventUpdateBaseItemsRef.current).toBe(
      harness.ports.state.eventLists[EVENT],
    );
    expect(harness.refs.eventUpdatePreviewEpochRef.current).toBe(2);
  });

  it("rejects a preview when the target list identity changes in flight", async () => {
    const pending = deferred<EventUpdateDiff>();
    updateFlowMocks.buildEventUpdateDiffFromSpreadsheet.mockReturnValueOnce(
      pending.promise,
    );
    const harness = createHarness();
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    let request!: Promise<void>;
    act(() => {
      request = result.current.handleUpdateEvent(EVENT);
    });
    harness.refs.eventListsRef.current = {
      [EVENT]: [...harness.ports.state.eventLists[EVENT]],
    };
    await act(async () => {
      pending.resolve(diff());
      await request;
    });

    expect(harness.spies.openEventUpdate).not.toHaveBeenCalled();
    expect(harness.refs.pendingEventUpdateBaseItemsRef.current).toBeNull();
  });

  it("opens URL fallback for missing metadata and restores it after preview failure", async () => {
    const missingSource = createHarness({ eventMetadata: {} });
    const missingResult = renderHook(() =>
      useEventUpdateCommands(missingSource.ports),
    ).result;

    await act(async () => {
      await missingResult.current.handleUpdateEvent(EVENT);
    });
    expect(missingSource.refs.eventUpdatePreviewEpochRef.current).toBe(1);
    expect(missingSource.spies.openUrlUpdate).toHaveBeenCalledWith(EVENT);

    const failure = new Error("network unavailable");
    updateFlowMocks.buildEventUpdateDiffFromSpreadsheet.mockRejectedValueOnce(
      failure,
    );
    const fallback = createHarness({ pendingUpdateEventName: EVENT });
    const fallbackResult = renderHook(() =>
      useEventUpdateCommands(fallback.ports),
    ).result;

    await act(async () => {
      await fallbackResult.current.handleUrlUpdate(
        "https://docs.google.com/spreadsheets/d/replacement",
        "",
      );
    });

    expect(
      updateFlowMocks.buildEventUpdateDiffFromSpreadsheet,
    ).toHaveBeenCalledWith(fallback.ports.state.eventLists[EVENT], {
      url: "https://docs.google.com/spreadsheets/d/replacement",
      sheetName: SOURCE.sheetName,
    });
    expect(fallback.spies.closeEventOverlay).toHaveBeenCalled();
    expect(fallback.spies.openUrlUpdate).toHaveBeenCalledWith(EVENT);
    expect(fallback.spies.reportError).toHaveBeenCalledWith(
      "Spreadsheet update preview failed (preview-failed).",
    );
  });

  it("resolves alias and fixed-item duplicate choices without changing source accidentally", async () => {
    const incomingItems = [
      {
        circle: "新規サークル",
        eventDate: DAY,
        block: "西B",
        number: "02b",
        title: "新刊",
        price: 500,
        quantity: 1,
        remarks: "",
      },
    ];
    const pendingDuplicateEvent: PendingDuplicateEventImport = {
      analysis: duplicateAnalysis(incomingItems),
      metadata: { source: "spreadsheet", url: "old", sheetName: "旧" },
    };
    const aliasHarness = createHarness({ pendingDuplicateEvent });
    const aliasResult = renderHook(() =>
      useEventUpdateCommands(aliasHarness.ports),
    ).result;
    const aliasResolution: DuplicateEventResolution = {
      action: "create-alias",
      originalEventName: EVENT,
      eventName: "イベントA 別名",
      items: incomingItems,
      source: {
        url: "https://docs.google.com/spreadsheets/d/new",
        sheetName: "新",
      },
    };

    await act(async () => {
      await aliasResult.current.handleDuplicateEventResolution(aliasResolution);
    });
    expect(aliasHarness.spies.closeEventOverlay).toHaveBeenCalled();
    expect(aliasHarness.spies.applyBulkAdd).toHaveBeenCalledWith(
      "イベントA 別名",
      incomingItems,
      {
        source: "spreadsheet",
        url: "https://docs.google.com/spreadsheets/d/new",
        sheetName: "新",
      },
    );

    const fixedHarness = createHarness({ pendingDuplicateEvent });
    const fixedResult = renderHook(() =>
      useEventUpdateCommands(fixedHarness.ports),
    ).result;
    await act(async () => {
      await fixedResult.current.handleDuplicateEventResolution({
        action: "append-fixed-items",
        eventName: EVENT,
        items: [],
        duplicateItemCount: 3,
        itemSource: "app",
      });
    });
    expect(fixedHarness.spies.applyBulkAdd).not.toHaveBeenCalled();
    expect(fixedHarness.spies.notify).toHaveBeenCalledWith(
      "追加できる新しい品目はありません。完全一致の3件は追加対象から除かれました。",
    );
  });

  it("previews a different-source resolution with the reviewed source binding", async () => {
    const previewDiff = diff({ protectedFromUpdate: 1 });
    updateFlowMocks.buildEventUpdateDiffFromSpreadsheet.mockResolvedValueOnce(
      previewDiff,
    );
    const incomingItems = [
      {
        circle: "切替サークル",
        eventDate: DAY,
        block: "南C",
        number: "03a",
        title: "切替新刊",
        price: 700,
        quantity: 1,
        remarks: "",
      },
    ];
    const pendingDuplicateEvent: PendingDuplicateEventImport = {
      analysis: {
        ...duplicateAnalysis(incomingItems),
        kind: "different-source",
        sourceComparison: {
          primaryMatch: false,
          gidComparison: "not-comparable",
          isSameSource: false,
        },
      },
    };
    const harness = createHarness({ pendingDuplicateEvent });
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    await act(async () => {
      await result.current.handleDuplicateEventResolution({
        action: "switch-source",
        eventName: EVENT,
        source: {
          url: "https://docs.google.com/spreadsheets/d/reviewed-source",
          sheetName: "切替先",
        },
        sourceIdentity: {
          documentId: "reviewed-source",
          normalizedSheetName: "切替先",
        },
        nextStep: "review-update-diff",
      });
    });

    expect(
      updateFlowMocks.buildEventUpdateDiffFromSpreadsheet,
    ).toHaveBeenCalledWith(harness.ports.state.eventLists[EVENT], {
      url: "https://docs.google.com/spreadsheets/d/reviewed-source",
      sheetName: "切替先",
    });
    expect(harness.spies.openEventUpdate).toHaveBeenLastCalledWith({
      kind: "source-switch",
      eventName: EVENT,
      diff: previewDiff,
      nextSource: {
        url: "https://docs.google.com/spreadsheets/d/reviewed-source",
        sheetName: "切替先",
      },
    });
    expect(harness.refs.pendingEventUpdateBaseItemsRef.current).toBe(
      harness.ports.state.eventLists[EVENT],
    );
  });

  it("commits source, item, and execute changes through one composite action", async () => {
    const baseItems = [item("keep"), item("delete")];
    const pendingEventUpdate: PendingEventUpdate = {
      kind: "source-switch",
      eventName: EVENT,
      diff: diff({ itemsToDelete: [baseItems[1]] }),
      nextSource: {
        url: "https://docs.google.com/spreadsheets/d/new",
        sheetName: "更新後",
      },
    };
    const harness = createHarness({
      eventLists: { [EVENT]: baseItems },
      executeModeItems: { [EVENT]: { [DAY]: ["keep", "delete"] } },
      pendingEventUpdate,
      pendingBaseItems: baseItems,
    });
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    await act(() => result.current.handleConfirmUpdate({}));

    expect(harness.spies.commitEventUpdateState).toHaveBeenCalledTimes(1);
    const committed = harness.spies.commitEventUpdateState.mock.calls[0][0];
    expect(committed.eventLists[EVENT].map(({ id }) => id)).toEqual(["keep"]);
    expect(committed.executeModeItems[EVENT][DAY]).toEqual(["keep"]);
    expect(committed.eventMetadata[EVENT]).toMatchObject({
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/new",
      spreadsheetSheetName: "更新後",
    });
    expect(harness.refs.pendingEventUpdateBaseItemsRef.current).toBeNull();
    expect(harness.spies.confirmEventOverlay).toHaveBeenCalled();
    expect(harness.spies.notify).toHaveBeenCalledWith(
      "アイテムを更新しました。",
    );
  });

  it("keeps the reviewed update open when its atomic commit fails", async () => {
    const baseItems = [item("keep")];
    const pendingEventUpdate: PendingEventUpdate = {
      kind: "items-only",
      eventName: EVENT,
      diff: diff(),
    };
    const harness = createHarness({
      eventLists: { [EVENT]: baseItems },
      pendingEventUpdate,
      pendingBaseItems: baseItems,
    });
    harness.ports.actions.commitEventUpdateState = vi.fn(async () => false);
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    await act(() => result.current.handleConfirmUpdate({}));

    expect(harness.refs.pendingEventUpdateBaseItemsRef.current).toBe(baseItems);
    expect(harness.spies.confirmEventOverlay).not.toHaveBeenCalled();
    expect(harness.spies.notify).not.toHaveBeenCalledWith(
      "アイテムを更新しました。",
    );
  });

  it("fails closed without a partial commit after the reviewed list changes", async () => {
    const baseItems = [item("keep")];
    const pendingEventUpdate: PendingEventUpdate = {
      kind: "items-only",
      eventName: EVENT,
      diff: diff(),
    };
    const harness = createHarness({
      eventLists: { [EVENT]: baseItems },
      pendingEventUpdate,
      pendingBaseItems: baseItems,
    });
    harness.refs.eventListsRef.current = {
      [EVENT]: [{ ...baseItems[0], title: "確認後の変更" }],
    };
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    await act(() => result.current.handleConfirmUpdate({}));

    expect(harness.spies.commitEventUpdateState).not.toHaveBeenCalled();
    expect(harness.spies.closeEventOverlay).toHaveBeenCalled();
    expect(harness.spies.notify).toHaveBeenCalledWith(
      "確認中にイベントの品目が変更または削除されたため、更新元も品目も変更していません。もう一度更新してください。",
    );
  });

  it("invalidates in-flight work when duplicate resolution is cancelled", () => {
    const harness = createHarness({
      pendingDuplicateEvent: {
        analysis: duplicateAnalysis([]),
      },
    });
    const { result } = renderHook(() => useEventUpdateCommands(harness.ports));

    act(() => {
      result.current.handleDuplicateEventCancel();
      result.current.handleCancelUpdate();
    });

    expect(harness.refs.eventUpdatePreviewEpochRef.current).toBe(1);
    expect(harness.spies.closeEventOverlay).toHaveBeenCalledTimes(2);
  });
});
