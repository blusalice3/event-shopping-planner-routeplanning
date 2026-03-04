import type { EventMetadata, ShoppingItem } from '../../types';
import { fetchEventItemsFromSpreadsheet } from './sheetImport';
import { createEventUpdateDiff, normalizeSheetItemsUrls, type EventUpdateDiff } from './updateDiff';

export type SpreadsheetSource = {
  url: string;
  sheetName: string;
};

export function resolveSpreadsheetSource(
  metadata?: EventMetadata,
  urlOverride?: SpreadsheetSource,
): SpreadsheetSource | null {
  const url = urlOverride?.url || metadata?.spreadsheetUrl;
  if (!url) return null;

  return {
    url,
    sheetName: urlOverride?.sheetName || metadata?.spreadsheetSheetName || '',
  };
}

export async function buildEventUpdateDiffFromSpreadsheet(
  currentItems: ShoppingItem[],
  source: SpreadsheetSource,
): Promise<EventUpdateDiff> {
  const sheetItems = await fetchEventItemsFromSpreadsheet(source.url, source.sheetName);
  const normalizedSheetItems = normalizeSheetItemsUrls(sheetItems);
  return createEventUpdateDiff(currentItems, normalizedSheetItems);
}
