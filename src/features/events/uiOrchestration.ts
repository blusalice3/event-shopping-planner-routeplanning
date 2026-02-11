import type { ShoppingItem } from '../../types';
import { extractEventDates } from '../../utils/eventDates';

export function resolveEventListTab(items: ShoppingItem[]): string {
  const dates = extractEventDates(items);
  return dates[0] || 'eventList';
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
    return `Import completed with warnings:\n${params.errors.join('\n')}`;
  }
  if (params.isUpdate) {
    return `${params.eventName} updated.\n${params.itemCount} items.`;
  }
  return `${params.eventName} created.\n${params.itemCount} items.`;
}
