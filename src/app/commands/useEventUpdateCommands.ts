import { useCallback } from "react";
import type {
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import type { BulkAddMetadata } from "../../features/events/bulkAdd";
import type {
  DuplicateEventResolution,
  ImportedShoppingItem,
} from "../../features/events/duplicateEvent";
import type { EventUpdateApplyOptions } from "../../features/events/updateApply";
import {
  applyPendingEventUpdate,
  buildEventUpdateDiffFromSpreadsheet,
  resolveSpreadsheetSource,
  type EventUpdateCommitState,
  type PendingEventUpdate,
  type SpreadsheetSource,
} from "../../features/events/updateFlow";
import { settleEventUpdatePreviewIfCurrent } from "../../features/events/sourceSwitchPreview";
import type { PendingDuplicateEventImport } from "../state/appOverlayTypes";

export interface MutableEventUpdateValue<T> {
  current: T;
}

export interface EventUpdateStatePort {
  readonly eventLists: Record<string, ShoppingItem[]>;
  readonly eventMetadata: Record<string, EventMetadata>;
  readonly pendingDuplicateEvent: PendingDuplicateEventImport | null;
  readonly pendingEventUpdate: PendingEventUpdate | null;
  readonly pendingUpdateEventName: string | null;
  readonly eventListsRef: MutableEventUpdateValue<
    Record<string, ShoppingItem[]>
  >;
  readonly eventMetadataRef: MutableEventUpdateValue<
    Record<string, EventMetadata>
  >;
  readonly executeModeItemsRef: MutableEventUpdateValue<
    Record<string, ExecuteModeItems>
  >;
  readonly pendingEventUpdateBaseItemsRef: MutableEventUpdateValue<
    ShoppingItem[] | null
  >;
  readonly eventUpdatePreviewEpochRef: MutableEventUpdateValue<number>;
}

export interface EventUpdateActionPort {
  applyBulkAdd(
    eventName: string,
    items: ImportedShoppingItem[],
    metadata?: BulkAddMetadata,
  ): Promise<void>;
  commitEventUpdateState(state: EventUpdateCommitState): Promise<boolean>;
  openEventUpdate(pending: PendingEventUpdate): void;
  openUrlUpdate(eventName: string): void;
  closeEventOverlay(): void;
  confirmEventOverlay(): void;
}

export interface EventUpdateEffectPort {
  notify(message: string): void;
  reportError(message: string): void;
}

export interface EventUpdateCommandPorts {
  readonly state: EventUpdateStatePort;
  readonly actions: EventUpdateActionPort;
  readonly effects: EventUpdateEffectPort;
}

export interface EventUpdateCommands {
  handleUpdateEvent(eventName: string): Promise<void>;
  handleDuplicateEventResolution(
    resolution: DuplicateEventResolution,
  ): Promise<void>;
  handleDuplicateEventCancel(): void;
  handleCancelUpdate(): void;
  handleConfirmUpdate(options: EventUpdateApplyOptions): Promise<void>;
  handleUrlUpdate(newUrl: string, sheetName: string): Promise<void>;
}

interface EventUpdatePreviewRequest {
  readonly kind: PendingEventUpdate["kind"];
  readonly eventName: string;
  readonly source: SpreadsheetSource;
  readonly onError: (error: unknown) => void;
}

export const useEventUpdateCommands = ({
  state,
  actions,
  effects,
}: EventUpdateCommandPorts): EventUpdateCommands => {
  const {
    eventLists,
    eventMetadata,
    pendingDuplicateEvent,
    pendingEventUpdate,
    pendingUpdateEventName,
    eventListsRef,
    eventMetadataRef,
    executeModeItemsRef,
    pendingEventUpdateBaseItemsRef,
    eventUpdatePreviewEpochRef,
  } = state;
  const {
    applyBulkAdd,
    commitEventUpdateState,
    openEventUpdate,
    openUrlUpdate,
    closeEventOverlay,
    confirmEventOverlay,
  } = actions;
  const { notify, reportError } = effects;

  const previewEventUpdate = useCallback(
    async ({
      kind,
      eventName,
      source,
      onError,
    }: EventUpdatePreviewRequest): Promise<void> => {
      eventUpdatePreviewEpochRef.current += 1;
      closeEventOverlay();
      pendingEventUpdateBaseItemsRef.current = null;

      const currentItems = eventLists[eventName];
      if (!currentItems) return;
      const requestEpoch = eventUpdatePreviewEpochRef.current;
      const isCurrentRequest = () =>
        eventUpdatePreviewEpochRef.current === requestEpoch &&
        eventListsRef.current[eventName] === currentItems;

      await settleEventUpdatePreviewIfCurrent({
        loadPreview: () =>
          buildEventUpdateDiffFromSpreadsheet(currentItems, source),
        isCurrent: isCurrentRequest,
        commit: (updateDiff) => {
          pendingEventUpdateBaseItemsRef.current = currentItems;
          openEventUpdate(
            kind === "source-switch"
              ? {
                  kind,
                  eventName,
                  diff: updateDiff,
                  nextSource: source,
                }
              : {
                  kind,
                  eventName,
                  diff: updateDiff,
                },
          );
        },
        onError,
      });
    },
    [
      eventLists,
      eventListsRef,
      eventUpdatePreviewEpochRef,
      closeEventOverlay,
      openEventUpdate,
      pendingEventUpdateBaseItemsRef,
    ],
  );

  const handleUpdateEvent = useCallback(
    async (eventName: string): Promise<void> => {
      const source = resolveSpreadsheetSource(eventMetadata[eventName]);
      if (!source) {
        eventUpdatePreviewEpochRef.current += 1;
        openUrlUpdate(eventName);
        return;
      }

      await previewEventUpdate({
        kind: "items-only",
        eventName,
        source,
        onError: () => {
          reportError("Spreadsheet update preview failed (preview-failed).");
          openUrlUpdate(eventName);
        },
      });
    },
    [
      eventMetadata,
      eventUpdatePreviewEpochRef,
      openUrlUpdate,
      previewEventUpdate,
      reportError,
    ],
  );

  const handleDuplicateEventResolution = useCallback(
    async (resolution: DuplicateEventResolution): Promise<void> => {
      const pending = pendingDuplicateEvent;
      if (!pending) return;
      eventUpdatePreviewEpochRef.current += 1;
      closeEventOverlay();

      if (resolution.action === "create-alias") {
        const nextMetadata: BulkAddMetadata | undefined = resolution.source
          ? {
              ...pending.metadata,
              url: resolution.source.url,
              sheetName: resolution.source.sheetName,
              source: "spreadsheet",
            }
          : pending.metadata;
        await applyBulkAdd(
          resolution.eventName,
          resolution.items,
          nextMetadata,
        );
        return;
      }

      if (resolution.action === "append-fixed-items") {
        if (resolution.items.length === 0) {
          notify(
            `追加できる新しい品目はありません。完全一致の${resolution.duplicateItemCount}件は追加対象から除かれました。`,
          );
        } else {
          await applyBulkAdd(resolution.eventName, resolution.items, {
            source: "app",
          });
        }
        return;
      }

      if (resolution.action === "open-update") {
        await previewEventUpdate({
          kind: "items-only",
          eventName: resolution.eventName,
          source: {
            url: resolution.source.url,
            sheetName: resolution.source.sheetName,
          },
          onError: () => {
            reportError("Spreadsheet update preview failed (preview-failed).");
            openUrlUpdate(resolution.eventName);
          },
        });
        return;
      }

      await previewEventUpdate({
        kind: "source-switch",
        eventName: resolution.eventName,
        source: {
          url: resolution.source.url,
          sheetName: resolution.source.sheetName,
        },
        onError: () => {
          reportError(
            "Spreadsheet source switch preview failed (preview-failed).",
          );
          notify(
            "新しい更新元の内容を確認できなかったため、更新元も品目も変更していません。",
          );
        },
      });
    },
    [
      applyBulkAdd,
      closeEventOverlay,
      eventUpdatePreviewEpochRef,
      notify,
      openUrlUpdate,
      pendingDuplicateEvent,
      previewEventUpdate,
      reportError,
    ],
  );

  const handleDuplicateEventCancel = useCallback(() => {
    eventUpdatePreviewEpochRef.current += 1;
    closeEventOverlay();
  }, [closeEventOverlay, eventUpdatePreviewEpochRef]);

  const handleCancelUpdate = useCallback(() => {
    closeEventOverlay();
  }, [closeEventOverlay]);

  const handleConfirmUpdate = useCallback(
    async (options: EventUpdateApplyOptions): Promise<void> => {
      if (!pendingEventUpdate) return;

      const nextState = applyPendingEventUpdate({
        state: {
          eventLists: eventListsRef.current,
          eventMetadata: eventMetadataRef.current,
          executeModeItems: executeModeItemsRef.current,
        },
        pending: pendingEventUpdate,
        baseItems: pendingEventUpdateBaseItemsRef.current,
        options,
      });
      if (!nextState) {
        closeEventOverlay();
        notify(
          "確認中にイベントの品目が変更または削除されたため、更新元も品目も変更していません。もう一度更新してください。",
        );
        return;
      }

      if (!(await commitEventUpdateState(nextState))) return;
      pendingEventUpdateBaseItemsRef.current = null;
      confirmEventOverlay();
      notify("アイテムを更新しました。");
    },
    [
      commitEventUpdateState,
      closeEventOverlay,
      confirmEventOverlay,
      eventListsRef,
      eventMetadataRef,
      executeModeItemsRef,
      notify,
      pendingEventUpdate,
      pendingEventUpdateBaseItemsRef,
    ],
  );

  const handleUrlUpdate = useCallback(
    async (newUrl: string, sheetName: string): Promise<void> => {
      closeEventOverlay();
      if (!pendingUpdateEventName) return;

      const eventName = pendingUpdateEventName;
      const currentMetadata = eventMetadata[eventName];
      const normalizedSheetName =
        sheetName || currentMetadata?.spreadsheetSheetName || "";

      await previewEventUpdate({
        kind: "source-switch",
        eventName,
        source: {
          url: newUrl,
          sheetName: normalizedSheetName,
        },
        onError: () => {
          reportError("Spreadsheet update preview failed (preview-failed).");
          openUrlUpdate(eventName);
        },
      });
    },
    [
      eventMetadata,
      closeEventOverlay,
      openUrlUpdate,
      pendingUpdateEventName,
      previewEventUpdate,
      reportError,
    ],
  );

  return {
    handleUpdateEvent,
    handleDuplicateEventResolution,
    handleDuplicateEventCancel,
    handleCancelUpdate,
    handleConfirmUpdate,
    handleUrlUpdate,
  };
};
