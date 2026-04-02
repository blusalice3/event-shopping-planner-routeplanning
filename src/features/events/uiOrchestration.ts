import type { ShoppingItem } from '../../types';
import { extractEventDates } from '../../utils/eventDates';

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

export function buildImportCompletionMessage(params: ImportMessageParams): string {
  if (params.errors.length > 0) {
    return `取り込みが警告付きで完了しました:\n${params.errors.join('\n')}`;
  }
  if (params.isUpdate) {
    return `${params.eventName}を更新しました。\n${params.itemCount}件`;
  }
  return `${params.eventName}を作成しました。\n${params.itemCount}件`;
}
