import type {
  DayModeState,
  EventMetadata,
  ExecuteModeItems,
  ShoppingItem,
} from "../../types/item";
import { extractEventDates } from "../../utils/eventDates";
import { getItemKey } from "../../utils/itemComparison";
import { resolveBulkAddTab } from "./uiOrchestration";

export type BulkAddLayoutInfo = {
  itemKey: string;
  eventDate: string;
  columnType: "execute" | "candidate";
  order: number;
};

export type BulkAddMetadata = {
  url?: string;
  sheetName?: string;
  layoutInfo?: BulkAddLayoutInfo[];
  source?: "spreadsheet" | "app";
};

export type BulkAddUiPlan = {
  alertMessage: string;
  nextActiveEventName: string | null;
  nextActiveTab: string | null;
};

function resolveItemSource(metadata?: BulkAddMetadata): "spreadsheet" | "app" {
  return metadata?.source ?? (metadata?.url ? "spreadsheet" : "app");
}

export function hasBulkAddLayoutInfo(
  metadata?: BulkAddMetadata,
): metadata is BulkAddMetadata & { layoutInfo: BulkAddLayoutInfo[] } {
  return !!metadata?.layoutInfo && metadata.layoutInfo.length > 0;
}

export function buildBulkAddItems(
  newItemsData: Omit<ShoppingItem, "id" | "purchaseStatus">[],
  metadata?: BulkAddMetadata,
): ShoppingItem[] {
  const itemSource = resolveItemSource(metadata);
  const defaultProtectionLevel = itemSource === "app" ? "full" : "none";

  return newItemsData.map((itemData) => ({
    id: crypto.randomUUID(),
    ...itemData,
    ...(itemSource === "spreadsheet"
      ? {
          catalogPrice: itemData.catalogPrice ?? itemData.price,
          sheetRemarks: itemData.sheetRemarks ?? itemData.remarks,
        }
      : {}),
    quantity: itemData.quantity ?? 1,
    purchaseStatus: "None",
    source: itemSource,
    protectionLevel: defaultProtectionLevel,
  }));
}

export function buildLayoutAppliedEventItems(
  newItems: ShoppingItem[],
  layoutInfo: BulkAddLayoutInfo[],
): { sortedItems: ShoppingItem[]; executeModeItems: ExecuteModeItems } {
  const itemsMap = new Map<string, ShoppingItem>();
  newItems.forEach((item) => {
    const key = getItemKey(item);
    itemsMap.set(key, item);
  });

  const eventDatesForLayout = extractEventDates(newItems);
  const executeModeItems: ExecuteModeItems = {};
  const sortedItemsByDate: ShoppingItem[] = [];

  const layoutItemKeys = new Set(layoutInfo.map((layout) => layout.itemKey));
  const otherItems = newItems.filter(
    (item) => !layoutItemKeys.has(getItemKey(item)),
  );
  const otherItemsByDate: Record<string, ShoppingItem[]> = {};

  otherItems.forEach((item) => {
    if (!otherItemsByDate[item.eventDate]) {
      otherItemsByDate[item.eventDate] = [];
    }
    otherItemsByDate[item.eventDate].push(item);
  });

  eventDatesForLayout.forEach((eventDate) => {
    const executeItemsForDate = layoutInfo
      .filter(
        (layout) =>
          layout.eventDate === eventDate && layout.columnType === "execute",
      )
      .sort((a, b) => a.order - b.order)
      .map((layout) => itemsMap.get(layout.itemKey))
      .filter(Boolean) as ShoppingItem[];

    const candidateItemsForDate = layoutInfo
      .filter(
        (layout) =>
          layout.eventDate === eventDate && layout.columnType === "candidate",
      )
      .sort((a, b) => a.order - b.order)
      .map((layout) => itemsMap.get(layout.itemKey))
      .filter(Boolean) as ShoppingItem[];

    executeModeItems[eventDate] = executeItemsForDate.map((item) => item.id);
    sortedItemsByDate.push(
      ...executeItemsForDate,
      ...candidateItemsForDate,
      ...(otherItemsByDate[eventDate] || []),
    );
  });

  const otherItemsWithoutDate = otherItems.filter(
    (item) => !eventDatesForLayout.includes(item.eventDate),
  );
  sortedItemsByDate.push(...otherItemsWithoutDate);

  return {
    sortedItems: sortedItemsByDate,
    executeModeItems,
  };
}

export function buildBulkAddEventMetadata(
  metadata?: BulkAddMetadata,
): EventMetadata | null {
  if (!metadata?.url) return null;

  return {
    spreadsheetUrl: metadata.url,
    spreadsheetSheetName: metadata.sheetName || "",
    lastImportDate: new Date().toISOString(),
  };
}

export function buildInitialDayModesForBulkAdd(
  newItems: ShoppingItem[],
): DayModeState {
  const newEventDates = extractEventDates(newItems);
  const initialDayModes: DayModeState = {};

  newEventDates.forEach((date) => {
    initialDayModes[date] = "edit";
  });

  return initialDayModes;
}

export function buildInitialExecuteItemsForBulkAdd(
  newItems: ShoppingItem[],
): ExecuteModeItems {
  const newEventDates = extractEventDates(newItems);
  const initialExecuteItems: ExecuteModeItems = {};

  newEventDates.forEach((date) => {
    initialExecuteItems[date] = [];
  });

  return initialExecuteItems;
}

export function buildBulkAddUiPlan(
  eventName: string,
  newItems: ShoppingItem[],
  isNewEvent: boolean,
  existingEventItems: ShoppingItem[],
): BulkAddUiPlan {
  const nextActiveTab =
    newItems.length > 0
      ? resolveBulkAddTab(newItems, existingEventItems)
      : null;

  return {
    alertMessage: isNewEvent
      ? `${newItems.length} items imported into a new event.`
      : `${newItems.length} items added.`,
    nextActiveEventName: isNewEvent ? eventName : null,
    nextActiveTab,
  };
}
