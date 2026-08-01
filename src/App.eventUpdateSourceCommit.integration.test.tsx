import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "./types/item";
import type { EventUpdateDiff } from "./features/events/updateDiff";
import {
  applyPendingEventUpdate,
  type EventUpdateCommitState,
  type PendingEventUpdate,
} from "./features/events/updateFlow";

const EVENT_NAME = "イベントA";

const item = (id: string, title: string): ShoppingItem => ({
  id,
  circle: `サークル-${id}`,
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title,
  price: 1000,
  quantity: 1,
  purchaseStatus: "None",
  remarks: "",
  source: "spreadsheet",
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

const createState = (eventItems: ShoppingItem[]): EventUpdateCommitState => ({
  eventLists: { [EVENT_NAME]: eventItems },
  eventMetadata: {
    [EVENT_NAME]: {
      spreadsheetUrl: "https://example.com/old",
      spreadsheetSheetName: "旧シート",
      lastImportDate: "2026-08-02T00:00:00.000Z",
    },
  },
  executeModeItems: {
    [EVENT_NAME]: {
      "1日目": eventItems.map(({ id }) => id),
    },
  },
});

const appSource = () =>
  readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

const sliceBetween = (
  source: string,
  startNeedle: string,
  endNeedle: string,
) => {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("App event update source commit integration", () => {
  it("commits items, execute lists, and a source switch from one current snapshot", () => {
    const deletedItem = item("delete", "削除対象");
    const retainedItem = item("keep", "維持対象");
    const baseItems = [deletedItem, retainedItem];
    const state = createState(baseItems);
    const pending: PendingEventUpdate = {
      kind: "source-switch",
      eventName: EVENT_NAME,
      diff: diff({ itemsToDelete: [deletedItem] }),
      nextSource: {
        url: "https://example.com/new",
        sheetName: "新シート",
      },
    };

    const result = applyPendingEventUpdate({
      state,
      pending,
      baseItems,
      options: {},
    });

    expect(result).not.toBeNull();
    expect(result?.eventLists[EVENT_NAME]).toEqual([retainedItem]);
    expect(result?.executeModeItems[EVENT_NAME]["1日目"]).toEqual(["keep"]);
    expect(result?.eventMetadata[EVENT_NAME]).toEqual({
      spreadsheetUrl: "https://example.com/new",
      spreadsheetSheetName: "新シート",
      lastImportDate: "2026-08-02T00:00:00.000Z",
    });
    expect(state.eventLists[EVENT_NAME]).toBe(baseItems);
    expect(state.eventMetadata[EVENT_NAME].spreadsheetUrl).toBe(
      "https://example.com/old",
    );
  });

  it("keeps metadata unchanged for an items-only confirmation", () => {
    const baseItems = [item("keep", "更新前")];
    const state = createState(baseItems);
    const pending: PendingEventUpdate = {
      kind: "items-only",
      eventName: EVENT_NAME,
      diff: diff({
        itemsToUpdate: [{ ...baseItems[0], title: "更新後" }],
      }),
    };

    const result = applyPendingEventUpdate({
      state,
      pending,
      baseItems,
      options: {},
    });

    expect(result?.eventLists[EVENT_NAME][0].title).toBe("更新後");
    expect(result?.eventMetadata).toBe(state.eventMetadata);
  });

  it.each(["edited", "deleted"] as const)(
    "rejects a confirmation after the target event was %s",
    (change) => {
      const baseItems = [item("keep", "確認時")];
      const state = createState(baseItems);
      const pending: PendingEventUpdate = {
        kind: "source-switch",
        eventName: EVENT_NAME,
        diff: diff(),
        nextSource: {
          url: "https://example.com/new",
          sheetName: "新シート",
        },
      };
      const currentState: EventUpdateCommitState =
        change === "edited"
          ? {
              ...state,
              eventLists: {
                [EVENT_NAME]: [{ ...baseItems[0], title: "確認後の編集" }],
              },
            }
          : {
              ...state,
              eventLists: {},
            };

      expect(
        applyPendingEventUpdate({
          state: currentState,
          pending,
          baseItems,
          options: {},
        }),
      ).toBeNull();
      expect(currentState.eventMetadata).toBe(state.eventMetadata);
      expect(currentState.executeModeItems).toBe(state.executeModeItems);
    },
  );

  it("keeps preview success limited to one discriminated pending state", () => {
    const source = appSource();
    const previewHandler = sliceBetween(
      source,
      "const previewEventUpdate = useCallback",
      "const handleUpdateEvent = useCallback",
    );

    expect(source).toContain("useState<PendingEventUpdate | null>(null)");
    expect(source).not.toContain("showUpdateConfirmation");
    expect(source).not.toContain("setUpdateData");
    expect(source).not.toContain("setUpdateEventName");
    expect(previewHandler).toContain("setPendingEventUpdate(");
    expect(previewHandler).not.toContain("setEventMetadata(");
    expect(previewHandler).not.toContain("setEventLists(");
    expect(previewHandler).not.toContain("updateExecuteModeItems(");
  });

  it("does not invalidate another event preview when deleting an unrelated event", () => {
    const source = appSource();
    const deleteHandler = sliceBetween(
      source,
      "const handleDeleteEvent = useCallback",
      "const handleRenameEvent = useCallback",
    );

    expect(deleteHandler).not.toContain(
      "eventUpdatePreviewEpochRef.current += 1",
    );
    expect(deleteHandler).toContain(
      "pending?.eventName === eventName ? null : pending",
    );
    expect(deleteHandler).toContain("removeRecordKey(prev, eventName)");
  });

  it("makes callers explicitly distinguish same-source and source-switch previews", () => {
    const source = appSource();
    const duplicateHandler = sliceBetween(
      source,
      "const handleDuplicateEventResolution = useCallback",
      "const handleDuplicateEventCancel = useCallback",
    );
    const urlHandler = sliceBetween(
      source,
      "const handleUrlUpdate = useCallback",
      "const handleImportMapData = useCallback",
    );

    expect(duplicateHandler).toContain('kind: "items-only"');
    expect(duplicateHandler).toContain('kind: "source-switch"');
    expect(urlHandler).toContain('kind: "source-switch"');
    expect(urlHandler).not.toContain("setEventMetadata(");
  });

  it("uses synchronized stores and commits all three results together", () => {
    const source = appSource();
    const confirmHandler = sliceBetween(
      source,
      "const handleConfirmUpdate = useCallback",
      "const handleUrlUpdate = useCallback",
    );

    expect(source).toContain("const eventListsRef = useRef");
    expect(source).toContain("const eventMetadataRef = useRef");
    expect(confirmHandler).toContain("applyPendingEventUpdate({");
    expect(confirmHandler).toContain("eventLists: eventListsRef.current");
    expect(confirmHandler).toContain("eventMetadata: eventMetadataRef.current");
    expect(confirmHandler).toContain(
      "executeModeItems: executeModeItemsRef.current",
    );
    expect(confirmHandler).toContain("commitEventLists(nextState.eventLists)");
    expect(confirmHandler).toContain(
      "commitEventMetadata(nextState.eventMetadata)",
    );
    expect(confirmHandler).toContain(
      "commitExecuteModeItems(nextState.executeModeItems)",
    );
  });

  it("cancels by clearing pending state without restoring captured metadata", () => {
    const source = appSource();
    const cancelHandler = sliceBetween(
      source,
      "const handleCancelUpdate = useCallback",
      "const handleConfirmUpdate = useCallback",
    );

    expect(cancelHandler).toContain("setPendingEventUpdate(null)");
    expect(cancelHandler).not.toContain("setEventMetadata");
    expect(cancelHandler).not.toContain("setEventLists");
  });
});
