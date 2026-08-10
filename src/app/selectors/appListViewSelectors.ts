import type { SortState } from "../../features/app-shell/types";
import {
  buildMovePlan,
  getCandidateSourceOrderedIds,
  type MovePlan,
} from "../../features/lists/domain/movePlan";
import type { DayModeState, ShoppingItem, ViewMode } from "../../types/item";
import { getMaplessKey, type HallDefinitionsStore } from "../../types/map";
import {
  getLimitedPurchaseCounts,
  matchesPurchaseStatusFilter,
} from "../../utils/purchaseQuantity";

export type AppExecuteModeStore = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;
export type AppListDayModeStore = Readonly<Record<string, DayModeState>>;

export interface ExecuteColumnItemsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly executeModeItems: AppExecuteModeStore;
  readonly items: readonly ShoppingItem[];
}

export const selectExecuteColumnItems = (
  input: ExecuteColumnItemsSelectorInput,
): ShoppingItem[] => {
  if (!input.activeEventName) return [];
  const executeIds =
    input.executeModeItems[input.activeEventName]?.[input.activeEventDate] ??
    [];
  const itemsById = new Map(input.items.map((item) => [item.id, item]));
  return executeIds
    .map((id) => itemsById.get(id))
    .filter((item): item is ShoppingItem => item != null);
};

export interface BaseFilteredItemsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly currentTabItems: ShoppingItem[];
  readonly dayModes: AppListDayModeStore;
  readonly executeColumnItems: ShoppingItem[];
  readonly sortState: SortState;
}

export const selectBaseFilteredItems = (
  input: BaseFilteredItemsSelectorInput,
): ShoppingItem[] => {
  const itemsForTab = input.currentTabItems;
  if (!input.activeEventName) return itemsForTab;

  const mode = input.dayModes[input.activeEventName]?.[input.activeEventDate];
  if (mode !== "execute") return itemsForTab;
  const sortState = input.sortState;
  if (sortState === "Manual") return input.executeColumnItems;

  return input.executeColumnItems.filter((item) =>
    matchesPurchaseStatusFilter(item, sortState),
  );
};

export interface TemporaryVisibleItemsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly dayModes: AppListDayModeStore;
  readonly executeColumnItems: readonly ShoppingItem[];
  readonly baseFilteredItems: readonly ShoppingItem[];
  readonly recentlyChangedItemIds: ReadonlySet<string>;
  readonly sortState: SortState;
}

export const selectTemporaryVisibleItems = (
  input: TemporaryVisibleItemsSelectorInput,
): ShoppingItem[] => {
  if (!input.activeEventName) return [];
  const mode = input.dayModes[input.activeEventName]?.[input.activeEventDate];
  if (mode !== "execute" || input.sortState === "Manual") return [];

  const baseFilteredItemIds = new Set(
    input.baseFilteredItems.map((item) => item.id),
  );
  return input.executeColumnItems.filter(
    (item) =>
      input.recentlyChangedItemIds.has(item.id) &&
      !baseFilteredItemIds.has(item.id),
  );
};

export interface VisibleItemsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly currentTabItems: ShoppingItem[];
  readonly dayModes: AppListDayModeStore;
  readonly executeColumnItems: readonly ShoppingItem[];
  readonly baseFilteredItems: ShoppingItem[];
  readonly temporaryVisibleItems: readonly ShoppingItem[];
  readonly sortState: SortState;
}

export interface VisibleItemsSelection {
  readonly visibleItemIds: ReadonlySet<string>;
  readonly visibleItems: ShoppingItem[];
}

export const selectVisibleItems = (
  input: VisibleItemsSelectorInput,
): VisibleItemsSelection => {
  const mode = input.activeEventName
    ? input.dayModes[input.activeEventName]?.[input.activeEventDate]
    : undefined;
  const includeTemporary = mode === "execute" && input.sortState !== "Manual";
  const visibleItemIds = new Set([
    ...input.baseFilteredItems.map((item) => item.id),
    ...(includeTemporary
      ? input.temporaryVisibleItems.map((item) => item.id)
      : []),
  ]);

  if (!input.activeEventName) {
    return { visibleItemIds, visibleItems: input.currentTabItems };
  }
  return {
    visibleItemIds,
    visibleItems:
      mode === "execute"
        ? input.executeColumnItems.filter((item) => visibleItemIds.has(item.id))
        : input.baseFilteredItems,
  };
};

export interface SortDisplayLabelSelectorInput {
  readonly sortState: SortState;
  readonly sortLabels: Readonly<Record<SortState, string>>;
  readonly baseFilteredItems: ShoppingItem[];
  readonly temporaryVisibleCount: number;
}

export const selectSortDisplayLabel = (
  input: SortDisplayLabelSelectorInput,
): string => {
  const buildTemporaryLabel = (baseLabel: string): string =>
    input.temporaryVisibleCount > 0
      ? `${baseLabel}（一時表示${input.temporaryVisibleCount}件）`
      : baseLabel;

  if (input.sortState !== "LimitedPurchase") {
    return buildTemporaryLabel(input.sortLabels[input.sortState]);
  }

  const limitedCounts = getLimitedPurchaseCounts(input.baseFilteredItems);
  const details = [
    limitedCounts.missing > 0 ? `未入力${limitedCounts.missing}` : null,
    input.temporaryVisibleCount > 0
      ? `一時表示${input.temporaryVisibleCount}`
      : null,
  ].filter((value): value is string => value != null);

  return details.length > 0
    ? `限数 ${limitedCounts.total}件（${details.join("・")}）`
    : `限数 ${limitedCounts.total}件`;
};

export interface SearchMatchesSelectorInput {
  readonly searchKeyword: string;
  readonly activeEventName: string | null;
  readonly activeTab: string;
  readonly eventDates: readonly string[];
  readonly currentTabItems: readonly ShoppingItem[];
}

export const selectSearchMatches = (
  input: SearchMatchesSelectorInput,
): string[] => {
  if (
    !input.searchKeyword.trim() ||
    !input.activeEventName ||
    !input.eventDates.includes(input.activeTab)
  ) {
    return [];
  }

  const keyword = input.searchKeyword.trim().toLowerCase();
  return input.currentTabItems
    .filter(
      (item) =>
        item.circle.toLowerCase().includes(keyword) ||
        item.title.toLowerCase().includes(keyword) ||
        item.remarks.toLowerCase().includes(keyword),
    )
    .map((item) => item.id);
};

export interface DuplicateCircleItemsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeTab: string;
  readonly eventDates: readonly string[];
  readonly currentTabItems: readonly ShoppingItem[];
}

export const selectDuplicateCircleItemIds = (
  input: DuplicateCircleItemsSelectorInput,
): Set<string> => {
  if (!input.activeEventName || !input.eventDates.includes(input.activeTab)) {
    return new Set<string>();
  }

  const itemIdsByCircle = new Map<string, string[]>();
  input.currentTabItems.forEach((item) => {
    const circle = item.circle.trim();
    if (!circle) return;
    const itemIds = itemIdsByCircle.get(circle) ?? [];
    itemIds.push(item.id);
    itemIdsByCircle.set(circle, itemIds);
  });

  const duplicateIds = new Set<string>();
  itemIdsByCircle.forEach((itemIds) => {
    if (itemIds.length > 1) {
      itemIds.forEach((id) => duplicateIds.add(id));
    }
  });
  return duplicateIds;
};

const compareBlocks = (first: string, second: string): number => {
  const firstNumber = Number(first);
  const secondNumber = Number(second);
  if (!Number.isNaN(firstNumber) && !Number.isNaN(secondNumber)) {
    return firstNumber - secondNumber;
  }
  return first.localeCompare(second, "ja", {
    numeric: true,
    sensitivity: "base",
  });
};

export interface BlockOptionsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly executeModeItems: AppExecuteModeStore;
  readonly currentTabItems: readonly ShoppingItem[];
}

export interface BlockOptionsSelection {
  readonly availableBlocks: string[];
  readonly allBlocksForHallDefinition: string[];
  readonly blocksWithPriorityRemarks: Set<string>;
}

export const selectBlockOptions = (
  input: BlockOptionsSelectorInput,
): BlockOptionsSelection => {
  if (!input.activeEventName) {
    return {
      availableBlocks: [],
      allBlocksForHallDefinition: [],
      blocksWithPriorityRemarks: new Set<string>(),
    };
  }

  const executeIds = new Set(
    input.executeModeItems[input.activeEventName]?.[input.activeEventDate] ??
      [],
  );
  const candidateItems = input.currentTabItems.filter(
    (item) => !executeIds.has(item.id),
  );
  const availableBlocks = Array.from(
    new Set(candidateItems.map((item) => item.block).filter(Boolean)),
  ).sort(compareBlocks);
  const allBlocksForHallDefinition = Array.from(
    new Set(input.currentTabItems.map((item) => item.block).filter(Boolean)),
  ).sort(compareBlocks);
  const blocksWithPriorityRemarks = new Set<string>();
  candidateItems.forEach((item) => {
    if (
      item.remarks &&
      (item.remarks.includes("優先") || item.remarks.includes("委託無"))
    ) {
      blocksWithPriorityRemarks.add(item.block);
    }
  });

  return {
    availableBlocks,
    allBlocksForHallDefinition,
    blocksWithPriorityRemarks,
  };
};

export interface CurrentMaplessHallsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly hallDefinitions: HallDefinitionsStore;
}

export const selectCurrentMaplessHalls = (
  input: CurrentMaplessHallsSelectorInput,
): HallDefinitionsStore[string][string] => {
  if (!input.activeEventName || !input.activeEventDate) return [];
  return (
    input.hallDefinitions[input.activeEventName]?.[
      getMaplessKey(input.activeEventDate)
    ] ?? []
  );
};

export interface CandidateColumnItemsSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly executeModeItems: AppExecuteModeStore;
  readonly currentTabItems: readonly ShoppingItem[];
  readonly selectedBlockFilters: ReadonlySet<string>;
  readonly candidateNumberSortDirection: "asc" | "desc" | null;
}

export const selectCandidateColumnItems = (
  input: CandidateColumnItemsSelectorInput,
): ShoppingItem[] => {
  if (!input.activeEventName) return [];
  const executeIds = new Set(
    input.executeModeItems[input.activeEventName]?.[input.activeEventDate] ??
      [],
  );
  let filtered = input.currentTabItems.filter(
    (item) => !executeIds.has(item.id),
  );
  if (input.selectedBlockFilters.size > 0) {
    filtered = filtered.filter((item) =>
      input.selectedBlockFilters.has(item.block),
    );
  }
  if (input.candidateNumberSortDirection !== null) return filtered;

  return [...filtered].sort((first, second) => {
    const blockComparison = first.block.localeCompare(second.block, "ja", {
      numeric: true,
      sensitivity: "base",
    });
    return blockComparison !== 0
      ? blockComparison
      : first.number.localeCompare(second.number, "ja", {
          numeric: true,
          sensitivity: "base",
        });
  });
};

export interface VisibleSearchMatchesSelectorInput {
  readonly searchMatches: readonly string[];
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly dayModes: AppListDayModeStore;
  readonly visibleItems: readonly ShoppingItem[];
  readonly executeColumnItems: readonly ShoppingItem[];
  readonly candidateColumnItems: readonly ShoppingItem[];
}

export const selectVisibleSearchMatches = (
  input: VisibleSearchMatchesSelectorInput,
): string[] => {
  if (input.searchMatches.length === 0) return [];
  const mode = input.activeEventName
    ? input.dayModes[input.activeEventName]?.[input.activeEventDate]
    : undefined;
  const visibleItemIds =
    mode === "execute"
      ? new Set(input.visibleItems.map((item) => item.id))
      : new Set(
          [...input.executeColumnItems, ...input.candidateColumnItems].map(
            (item) => item.id,
          ),
        );
  return input.searchMatches.filter((id) => visibleItemIds.has(id));
};

export interface MovePlanStateSelectorInput {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly currentMode: ViewMode;
  readonly executeModeItems: AppExecuteModeStore;
  readonly items: readonly ShoppingItem[];
  readonly selectedItemIds: ReadonlySet<string>;
}

export interface MovePlanStateSelection {
  readonly currentExecuteOrderedIds: readonly string[];
  readonly candidateSourceOrderedIds: string[];
  readonly candidateMovePlan: MovePlan;
  readonly executeMovePlan: MovePlan;
  readonly hasCandidateSelection: boolean;
  readonly hasExecuteSelection: boolean;
  readonly showMoveButtons: boolean;
}

export const selectMovePlanState = (
  input: MovePlanStateSelectorInput,
): MovePlanStateSelection => {
  const currentExecuteOrderedIds = input.activeEventName
    ? (input.executeModeItems[input.activeEventName]?.[input.activeEventDate] ??
      [])
    : [];
  const candidateSourceOrderedIds = getCandidateSourceOrderedIds(
    input.items,
    input.activeEventDate,
    currentExecuteOrderedIds,
  );
  const requestedIds = Array.from(input.selectedItemIds);
  const candidateMovePlan = buildMovePlan({
    requestedIds,
    sourceOrderedIds: candidateSourceOrderedIds,
    allItems: input.items,
    dayName: input.activeEventDate,
    expansionPolicy: "same-visit",
  });
  const executeMovePlan = buildMovePlan({
    requestedIds,
    sourceOrderedIds: currentExecuteOrderedIds,
    allItems: input.items,
    dayName: input.activeEventDate,
    expansionPolicy: "same-visit",
  });
  const hasCandidateSelection =
    input.currentMode === "edit" && candidateMovePlan.requested.length > 0;
  const hasExecuteSelection =
    input.currentMode === "edit" && executeMovePlan.requested.length > 0;

  return {
    currentExecuteOrderedIds,
    candidateSourceOrderedIds,
    candidateMovePlan,
    executeMovePlan,
    hasCandidateSelection,
    hasExecuteSelection,
    showMoveButtons:
      (hasCandidateSelection && !hasExecuteSelection) ||
      (hasExecuteSelection && !hasCandidateSelection),
  };
};
