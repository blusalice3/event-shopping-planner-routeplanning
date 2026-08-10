import type { ShoppingItem } from "../../types/item";
import { extractEventDates } from "../../utils/eventDates";

export const LARGE_XLSX_RESTORE_DEFER_ITEM_THRESHOLD = 10_000;

export function resolveEventListTab(items: ShoppingItem[]): string | null {
  const dates = extractEventDates(items);
  return dates[0] ?? null;
}

export function resolveBulkAddTab(
  newItems: ShoppingItem[],
  existingItems: ShoppingItem[],
): string | null {
  const newEventDates = extractEventDates(newItems);
  if (newEventDates.length > 0) return newEventDates[0];

  const existingEventDates = extractEventDates(existingItems);
  if (existingEventDates.length > 0) return existingEventDates[0];

  return null;
}

type ImportMessageParams = {
  errors: string[];
  eventName: string;
  isUpdate: boolean;
  itemCount: number;
};

export function buildImportCompletionMessage(
  params: ImportMessageParams,
): string {
  if (params.errors.length > 0) {
    return `取り込みが警告付きで完了しました:\n${params.errors.join("\n")}`;
  }
  if (params.isUpdate) {
    return `${params.eventName}を更新しました。\n${params.itemCount}件`;
  }
  return `${params.eventName}を作成しました。\n${params.itemCount}件`;
}

export function shouldDeferLargeXlsxRestoreOpen({
  isXlsxRestore,
  itemCount,
}: {
  isXlsxRestore: boolean;
  itemCount: number;
}): boolean {
  return isXlsxRestore && itemCount >= LARGE_XLSX_RESTORE_DEFER_ITEM_THRESHOLD;
}

export function buildLargeXlsxRestoreDeferredNotice(itemCount: number): string {
  return `大規模なExcel復元（${itemCount}件）のため、リストは自動で開かずイベント一覧に戻りました。`;
}

export function buildLegacySheetFieldFallbackMessage({
  fallbacks,
  skippedItemIds,
}: {
  fallbacks: readonly { itemId: string }[];
  skippedItemIds: ReadonlySet<string>;
}): string | null {
  const appliedCount = fallbacks.filter(
    ({ itemId }) => !skippedItemIds.has(itemId),
  ).length;
  if (appliedCount === 0) return null;

  return `旧形式のため、${appliedCount}件のシート品目でカタログ価格とシート備考を現在の価格・備考から推定して補完しました。`;
}
