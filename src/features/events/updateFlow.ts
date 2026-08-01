import type {
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import {
  applyEventUpdateToItems,
  removeDeletedIdsFromExecuteModeItems,
  type EventUpdateApplyOptions,
} from "./updateApply";
import { fetchEventItemsFromSpreadsheet } from "./sheetImport";
import {
  createEventUpdateDiff,
  normalizeSheetItemsUrls,
  type EventUpdateDiff,
} from "./updateDiff";

export type SpreadsheetSource = {
  url: string;
  sheetName: string;
};

export type PendingEventUpdate =
  | {
      kind: "items-only";
      eventName: string;
      diff: EventUpdateDiff;
    }
  | {
      kind: "source-switch";
      eventName: string;
      diff: EventUpdateDiff;
      nextSource: SpreadsheetSource;
    };

export type EventUpdateCommitState = {
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
  executeModeItems: Record<string, ExecuteModeItems>;
};

export function applyPendingEventUpdate({
  state,
  pending,
  baseItems,
  options,
}: {
  state: EventUpdateCommitState;
  pending: PendingEventUpdate;
  baseItems: ShoppingItem[] | null;
  options: EventUpdateApplyOptions;
}): EventUpdateCommitState | null {
  const currentItems = state.eventLists[pending.eventName];
  if (!currentItems || currentItems !== baseItems) {
    return null;
  }

  const deleteIds = new Set(pending.diff.itemsToDelete.map((item) => item.id));
  const currentExecuteModeItems = state.executeModeItems[pending.eventName];
  const nextExecuteModeItems = currentExecuteModeItems
    ? {
        ...state.executeModeItems,
        [pending.eventName]: removeDeletedIdsFromExecuteModeItems(
          currentExecuteModeItems,
          deleteIds,
        ),
      }
    : state.executeModeItems;
  const nextEventMetadata =
    pending.kind === "source-switch"
      ? {
          ...state.eventMetadata,
          [pending.eventName]: {
            spreadsheetUrl: pending.nextSource.url,
            spreadsheetSheetName: pending.nextSource.sheetName,
            lastImportDate:
              state.eventMetadata[pending.eventName]?.lastImportDate || "",
          },
        }
      : state.eventMetadata;

  return {
    eventLists: {
      ...state.eventLists,
      [pending.eventName]: applyEventUpdateToItems(
        currentItems,
        pending.diff,
        options,
      ),
    },
    eventMetadata: nextEventMetadata,
    executeModeItems: nextExecuteModeItems,
  };
}

export function resolveSpreadsheetSource(
  metadata?: EventMetadata,
  urlOverride?: SpreadsheetSource,
): SpreadsheetSource | null {
  const url = urlOverride?.url || metadata?.spreadsheetUrl;
  if (!url) return null;

  return {
    url,
    sheetName: urlOverride?.sheetName || metadata?.spreadsheetSheetName || "",
  };
}

export async function buildEventUpdateDiffFromSpreadsheet(
  currentItems: ShoppingItem[],
  source: SpreadsheetSource,
): Promise<EventUpdateDiff> {
  const sheetItems = await fetchEventItemsFromSpreadsheet(
    source.url,
    source.sheetName,
  );
  const normalizedSheetItems = normalizeSheetItemsUrls(sheetItems);
  return createEventUpdateDiff(currentItems, normalizedSheetItems);
}
