import type { EventMetadata, ShoppingItem } from "../../types/item";

export type ImportedShoppingItem = Omit<ShoppingItem, "id" | "purchaseStatus">;

export type DuplicateEventSource = {
  url: string;
  sheetName: string;
};

export type SpreadsheetSourceIdentity = {
  documentId: string;
  normalizedSheetName: string;
  gid?: string;
};

export type SourceIdentityComparison = {
  primaryMatch: boolean;
  gidComparison: "same" | "different" | "not-comparable";
  isSameSource: boolean;
};

type DuplicateEventAnalysisBase = {
  eventName: string;
  incomingItems: ImportedShoppingItem[];
  itemsForFixedAdd: ImportedShoppingItem[];
  duplicateItemCount: number;
  incomingSource: DuplicateEventSource | null;
  incomingSourceIdentity: SpreadsheetSourceIdentity | null;
  existingSource: DuplicateEventSource | null;
  existingSourceIdentity: SpreadsheetSourceIdentity | null;
  sourceComparison: SourceIdentityComparison;
};

export type CreateEventAnalysis = DuplicateEventAnalysisBase & {
  kind: "create";
};

export type SameSourceEventAnalysis = DuplicateEventAnalysisBase & {
  kind: "same-source";
};

export type DifferentSourceEventAnalysis = DuplicateEventAnalysisBase & {
  kind: "different-source";
};

export type DuplicateEventAnalysis =
  | CreateEventAnalysis
  | SameSourceEventAnalysis
  | DifferentSourceEventAnalysis;

export type AnalyzeDuplicateEventInput = {
  eventName: string;
  incomingItems: ImportedShoppingItem[];
  incomingSource?: DuplicateEventSource | null;
  eventLists: Record<string, ShoppingItem[]>;
  eventMetadata: Record<string, EventMetadata>;
};

export type SameSourceUpdateResolution = {
  action: "open-update";
  eventName: string;
  source: DuplicateEventSource;
  sourceIdentity: SpreadsheetSourceIdentity;
  nextStep: "review-update-diff";
};

export type CreateAliasResolution = {
  action: "create-alias";
  originalEventName: string;
  eventName: string;
  items: ImportedShoppingItem[];
  source: DuplicateEventSource | null;
};

export type AppendFixedItemsResolution = {
  action: "append-fixed-items";
  eventName: string;
  items: ImportedShoppingItem[];
  duplicateItemCount: number;
  itemSource: "app";
};

export type SwitchSourceResolution = {
  action: "switch-source";
  eventName: string;
  source: DuplicateEventSource;
  sourceIdentity: SpreadsheetSourceIdentity;
  nextStep: "review-update-diff";
};

export type DuplicateEventResolution =
  | SameSourceUpdateResolution
  | CreateAliasResolution
  | AppendFixedItemsResolution
  | SwitchSourceResolution;

export type DifferentSourceChoice =
  | "create-alias"
  | "append-fixed-items"
  | "switch-source";

const SPREADSHEET_PATH_PATTERN = /^\/spreadsheets\/d\/([^/?#]+)/i;

function normalizeGid(value: string | null): string | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  return value.replace(/^0+(?=\d)/, "");
}

export function normalizeSheetName(sheetName: string): string {
  return sheetName
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("ja-JP");
}

export function extractGoogleSheetsSourceIdentity(
  source: DuplicateEventSource,
): SpreadsheetSourceIdentity | null {
  try {
    const url = new URL(source.url.trim());
    if (url.hostname.toLocaleLowerCase() !== "docs.google.com") {
      return null;
    }

    const documentId = url.pathname.match(SPREADSHEET_PATH_PATTERN)?.[1];
    if (!documentId) return null;

    const hashParameters = new URLSearchParams(url.hash.replace(/^#/, ""));
    const gid = normalizeGid(
      url.searchParams.get("gid") ?? hashParameters.get("gid"),
    );

    return {
      documentId: decodeURIComponent(documentId),
      normalizedSheetName: normalizeSheetName(source.sheetName),
      ...(gid ? { gid } : {}),
    };
  } catch {
    return null;
  }
}

export function compareSpreadsheetSourceIdentities(
  current: SpreadsheetSourceIdentity | null,
  incoming: SpreadsheetSourceIdentity | null,
): SourceIdentityComparison {
  const primaryMatch =
    current !== null &&
    incoming !== null &&
    current.documentId === incoming.documentId &&
    current.normalizedSheetName === incoming.normalizedSheetName;

  const gidComparison =
    current?.gid && incoming?.gid
      ? current.gid === incoming.gid
        ? "same"
        : "different"
      : "not-comparable";

  return {
    primaryMatch,
    gidComparison,
    // gid は古い保存データや共有URLに含まれないことがあるため、主判定を覆さない。
    isSameSource: primaryMatch,
  };
}

function getExactImportItemKey(
  item: ShoppingItem | ImportedShoppingItem,
): string {
  const catalogPrice =
    item.catalogPrice === undefined ? item.price : item.catalogPrice;
  const sheetRemarks =
    item.sheetRemarks === undefined ? item.remarks : item.sheetRemarks;

  return JSON.stringify([
    item.circle,
    item.eventDate,
    item.block,
    item.number,
    item.title,
    catalogPrice,
    item.quantity,
    sheetRemarks,
    item.url || null,
  ]);
}

export function excludeExactDuplicateItems(
  incomingItems: ImportedShoppingItem[],
  existingItems: Array<ShoppingItem | ImportedShoppingItem>,
): {
  items: ImportedShoppingItem[];
  duplicateItemCount: number;
} {
  const seenKeys = new Set(existingItems.map(getExactImportItemKey));
  const items: ImportedShoppingItem[] = [];
  let duplicateItemCount = 0;

  incomingItems.forEach((item) => {
    const key = getExactImportItemKey(item);
    if (seenKeys.has(key)) {
      duplicateItemCount += 1;
      return;
    }

    seenKeys.add(key);
    items.push(item);
  });

  return { items, duplicateItemCount };
}

function sourceFromMetadata(
  metadata: EventMetadata | undefined,
): DuplicateEventSource | null {
  if (!metadata?.spreadsheetUrl) return null;
  return {
    url: metadata.spreadsheetUrl,
    sheetName: metadata.spreadsheetSheetName || "",
  };
}

export function analyzeDuplicateEventImport({
  eventName,
  incomingItems,
  incomingSource = null,
  eventLists,
  eventMetadata,
}: AnalyzeDuplicateEventInput): DuplicateEventAnalysis {
  const normalizedEventName = eventName.trim();
  const eventExists = Object.prototype.hasOwnProperty.call(
    eventLists,
    normalizedEventName,
  );
  const existingItems = eventExists
    ? eventLists[normalizedEventName] || []
    : [];
  const deduplicatedImport = excludeExactDuplicateItems(incomingItems, []);
  const fixedAdd = excludeExactDuplicateItems(incomingItems, existingItems);
  const existingSource = eventExists
    ? sourceFromMetadata(eventMetadata[normalizedEventName])
    : null;
  const incomingSourceIdentity = incomingSource
    ? extractGoogleSheetsSourceIdentity(incomingSource)
    : null;
  const existingSourceIdentity = existingSource
    ? extractGoogleSheetsSourceIdentity(existingSource)
    : null;
  const sourceComparison = compareSpreadsheetSourceIdentities(
    existingSourceIdentity,
    incomingSourceIdentity,
  );

  const common: DuplicateEventAnalysisBase = {
    eventName: normalizedEventName,
    incomingItems: deduplicatedImport.items,
    itemsForFixedAdd: fixedAdd.items,
    duplicateItemCount: fixedAdd.duplicateItemCount,
    incomingSource,
    incomingSourceIdentity,
    existingSource,
    existingSourceIdentity,
    sourceComparison,
  };

  if (!eventExists) {
    return { ...common, kind: "create" };
  }

  return sourceComparison.isSameSource
    ? { ...common, kind: "same-source" }
    : { ...common, kind: "different-source" };
}

function normalizeEventName(eventName: string): string {
  return eventName.trim();
}

export function validateAliasEventName(
  aliasName: string,
  existingEventNames: string[],
): string | null {
  const normalizedAlias = normalizeEventName(aliasName);
  if (!normalizedAlias) {
    return "別名を入力してください。";
  }

  const isAlreadyUsed = existingEventNames.some(
    (name) => normalizeEventName(name) === normalizedAlias,
  );
  if (isAlreadyUsed) {
    return "この名前はすでに使用中です。別の名前を入力してください。";
  }

  return null;
}

export function createUniqueAliasEventName(
  eventName: string,
  existingEventNames: string[],
): string {
  const baseName = `${normalizeEventName(eventName)}（別名）`;
  if (!validateAliasEventName(baseName, existingEventNames)) return baseName;

  let suffix = 2;
  while (
    validateAliasEventName(
      `${normalizeEventName(eventName)}（別名${suffix}）`,
      existingEventNames,
    )
  ) {
    suffix += 1;
  }
  return `${normalizeEventName(eventName)}（別名${suffix}）`;
}

export function buildSameSourceUpdateResolution(
  analysis: SameSourceEventAnalysis,
): SameSourceUpdateResolution {
  if (!analysis.incomingSource || !analysis.incomingSourceIdentity) {
    throw new Error("更新元を確認できないため、差分確認へ進めません。");
  }

  return {
    action: "open-update",
    eventName: analysis.eventName,
    source: analysis.incomingSource,
    sourceIdentity: analysis.incomingSourceIdentity,
    nextStep: "review-update-diff",
  };
}

export function buildDifferentSourceResolution(
  analysis: DifferentSourceEventAnalysis,
  choice: DifferentSourceChoice,
  options: {
    aliasName?: string;
    existingEventNames: string[];
  },
): CreateAliasResolution | AppendFixedItemsResolution | SwitchSourceResolution {
  if (choice === "create-alias") {
    const aliasName = normalizeEventName(options.aliasName || "");
    const validationError = validateAliasEventName(
      aliasName,
      options.existingEventNames,
    );
    if (validationError) throw new Error(validationError);

    return {
      action: "create-alias",
      originalEventName: analysis.eventName,
      eventName: aliasName,
      items: analysis.incomingItems,
      source: analysis.incomingSource,
    };
  }

  if (choice === "append-fixed-items") {
    return {
      action: "append-fixed-items",
      eventName: analysis.eventName,
      items: analysis.itemsForFixedAdd,
      duplicateItemCount: analysis.duplicateItemCount,
      itemSource: "app",
    };
  }

  if (!analysis.incomingSource || !analysis.incomingSourceIdentity) {
    throw new Error(
      "新しい更新元を確認できません。URLとシート名を確認してください。",
    );
  }

  return {
    action: "switch-source",
    eventName: analysis.eventName,
    source: analysis.incomingSource,
    sourceIdentity: analysis.incomingSourceIdentity,
    nextStep: "review-update-diff",
  };
}
