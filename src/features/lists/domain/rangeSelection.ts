/**
 * Pure display-range selection domain.
 *
 * The presentation is deliberately built from the IDs that are actually
 * rendered. Range resolution therefore never needs to reconstruct UI order
 * from the source ShoppingItem array.
 */

export type RangeGrouping = "flat" | "hall" | "space";
export type RangeGroupKey = string | null;

export interface RangeDisplayGroupInput {
  key: RangeGroupKey;
  itemIds: readonly string[];
}

export interface RangeDisplayGroup {
  key: RangeGroupKey;
  itemIds: readonly string[];
}

export interface RangePresentation {
  /**
   * Identifies the event/day/column/view/filter revision represented here.
   * Endpoints from another scope must not be reinterpreted in this view.
   */
  scopeKey: string;
  grouping: RangeGrouping;
  groups: readonly RangeDisplayGroup[];
  /** All visible item IDs, exactly once, in rendered order. */
  itemIds: readonly string[];
}

export type BuildRangePresentationInput =
  | {
      scopeKey: string;
      grouping: "flat";
      itemIds: readonly string[];
      groups?: never;
    }
  | {
      scopeKey: string;
      grouping: "hall" | "space";
      groups: readonly RangeDisplayGroupInput[];
      itemIds?: never;
    };

export type RangeEndpoint =
  | {
      kind: "item";
      itemId: string;
      scopeKey: string;
    }
  | {
      kind: "group";
      groupKey: RangeGroupKey;
      scopeKey: string;
    };

export type RangeInvalidReason =
  | "scope-mismatch"
  | "endpoint-kind-mismatch"
  | "group-endpoint-not-supported"
  | "ambiguous-group-key"
  | "start-not-visible"
  | "end-not-visible"
  | "same-endpoint"
  | "adjacent"
  | "cross-hall"
  | "empty-range";

export type ResolvedRangeEndpoint =
  | {
      kind: "item";
      /** null in flat mode; otherwise the containing display-group index. */
      groupIndex: number | null;
      /** Index within its group, or the flat display index in flat mode. */
      itemIndex: number;
      /** Index in the flattened visible item order. */
      displayIndex: number;
    }
  | {
      kind: "group";
      groupIndex: number;
      itemIndex: null;
      displayIndex: null;
    };

export type RangeResolution =
  | {
      valid: true;
      /**
       * The resolved target, de-duplicated and always ordered as rendered,
       * regardless of which endpoint was clicked first.
       */
      itemIds: string[];
      coverage: "item-slice" | "group-span";
      /** Display-group keys covered by the range, in rendered order. */
      orderedGroupKeys: RangeGroupKey[];
      /** Resolved location of the endpoint clicked first. */
      start: ResolvedRangeEndpoint;
      /** Resolved location of the endpoint clicked second. */
      end: ResolvedRangeEndpoint;
    }
  | {
      valid: false;
      reason: RangeInvalidReason;
      itemIds: [];
    };

export type RangeToggleOperation = "select" | "deselect" | "none";

export interface RangeToggleResult {
  selectedItemIds: Set<string>;
  operation: RangeToggleOperation;
}

function uniqueInOrder(itemIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const itemId of itemIds) {
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    result.push(itemId);
  }

  return result;
}

/**
 * Creates the single ordered representation shared by range rendering and
 * range actions. When an item is accidentally present more than once, its
 * first visible occurrence wins.
 */
export function buildRangePresentation(
  input: BuildRangePresentationInput,
): RangePresentation {
  if (input.grouping === "flat") {
    return {
      scopeKey: input.scopeKey,
      grouping: input.grouping,
      groups: [],
      itemIds: uniqueInOrder(input.itemIds),
    };
  }

  const seenItemIds = new Set<string>();
  const groups = input.groups.map((group): RangeDisplayGroup => {
    const itemIds: string[] = [];

    for (const itemId of group.itemIds) {
      if (seenItemIds.has(itemId)) continue;
      seenItemIds.add(itemId);
      itemIds.push(itemId);
    }

    return { key: group.key, itemIds };
  });

  return {
    scopeKey: input.scopeKey,
    grouping: input.grouping,
    groups,
    itemIds: groups.flatMap((group) => group.itemIds),
  };
}

function invalid(reason: RangeInvalidReason): RangeResolution {
  return { valid: false, reason, itemIds: [] };
}

function valid(
  itemIds: readonly string[],
  coverage: "item-slice" | "group-span",
  orderedGroupKeys: readonly RangeGroupKey[],
  start: ResolvedRangeEndpoint,
  end: ResolvedRangeEndpoint,
): RangeResolution {
  const uniqueItemIds = uniqueInOrder(itemIds);
  return uniqueItemIds.length === 0
    ? invalid("empty-range")
    : {
        valid: true,
        itemIds: uniqueItemIds,
        coverage,
        orderedGroupKeys: [...orderedGroupKeys],
        start,
        end,
      };
}

function findItemLocation(
  presentation: RangePresentation,
  itemId: string,
): {
  displayIndex: number;
  groupIndex: number;
  groupItemIndex: number;
} | null {
  const displayIndex = presentation.itemIds.indexOf(itemId);
  if (displayIndex === -1) return null;

  if (presentation.grouping === "flat") {
    return {
      displayIndex,
      groupIndex: -1,
      groupItemIndex: displayIndex,
    };
  }

  for (
    let groupIndex = 0;
    groupIndex < presentation.groups.length;
    groupIndex += 1
  ) {
    const groupItemIndex =
      presentation.groups[groupIndex].itemIds.indexOf(itemId);
    if (groupItemIndex !== -1) {
      return { displayIndex, groupIndex, groupItemIndex };
    }
  }

  return null;
}

function findUniqueGroupIndex(
  groups: readonly RangeDisplayGroup[],
  groupKey: RangeGroupKey,
): number | "ambiguous" {
  let result = -1;

  for (let index = 0; index < groups.length; index += 1) {
    if (groups[index].key !== groupKey) continue;
    if (result !== -1) return "ambiguous";
    result = index;
  }

  return result;
}

function groupSpanItemIds(
  groups: readonly RangeDisplayGroup[],
  firstGroupIndex: number,
  secondGroupIndex: number,
): string[] {
  const startIndex = Math.min(firstGroupIndex, secondGroupIndex);
  const endIndex = Math.max(firstGroupIndex, secondGroupIndex);
  return groups
    .slice(startIndex, endIndex + 1)
    .flatMap((group) => group.itemIds);
}

function groupSpanKeys(
  groups: readonly RangeDisplayGroup[],
  firstGroupIndex: number,
  secondGroupIndex: number,
): RangeGroupKey[] {
  const startIndex = Math.min(firstGroupIndex, secondGroupIndex);
  const endIndex = Math.max(firstGroupIndex, secondGroupIndex);
  return groups.slice(startIndex, endIndex + 1).map((group) => group.key);
}

function resolveItemEndpoints(
  presentation: RangePresentation,
  start: Extract<RangeEndpoint, { kind: "item" }>,
  end: Extract<RangeEndpoint, { kind: "item" }>,
): RangeResolution {
  const startLocation = findItemLocation(presentation, start.itemId);
  if (!startLocation) return invalid("start-not-visible");

  const endLocation = findItemLocation(presentation, end.itemId);
  if (!endLocation) return invalid("end-not-visible");

  const resolvedStart: ResolvedRangeEndpoint = {
    kind: "item",
    groupIndex:
      presentation.grouping === "flat" ? null : startLocation.groupIndex,
    itemIndex: startLocation.groupItemIndex,
    displayIndex: startLocation.displayIndex,
  };
  const resolvedEnd: ResolvedRangeEndpoint = {
    kind: "item",
    groupIndex:
      presentation.grouping === "flat" ? null : endLocation.groupIndex,
    itemIndex: endLocation.groupItemIndex,
    displayIndex: endLocation.displayIndex,
  };

  if (start.itemId === end.itemId) return invalid("same-endpoint");

  if (
    presentation.grouping === "hall" &&
    startLocation.groupIndex !== endLocation.groupIndex
  ) {
    return invalid("cross-hall");
  }

  if (Math.abs(startLocation.displayIndex - endLocation.displayIndex) === 1) {
    return invalid("adjacent");
  }

  if (presentation.grouping === "flat") {
    const firstIndex = Math.min(
      startLocation.displayIndex,
      endLocation.displayIndex,
    );
    const lastIndex = Math.max(
      startLocation.displayIndex,
      endLocation.displayIndex,
    );
    return valid(
      presentation.itemIds.slice(firstIndex, lastIndex + 1),
      "item-slice",
      [],
      resolvedStart,
      resolvedEnd,
    );
  }

  if (
    presentation.grouping === "space" &&
    startLocation.groupIndex !== endLocation.groupIndex
  ) {
    return valid(
      groupSpanItemIds(
        presentation.groups,
        startLocation.groupIndex,
        endLocation.groupIndex,
      ),
      "group-span",
      groupSpanKeys(
        presentation.groups,
        startLocation.groupIndex,
        endLocation.groupIndex,
      ),
      resolvedStart,
      resolvedEnd,
    );
  }

  const group = presentation.groups[startLocation.groupIndex];
  if (!group) return invalid("empty-range");

  const firstIndex = Math.min(
    startLocation.groupItemIndex,
    endLocation.groupItemIndex,
  );
  const lastIndex = Math.max(
    startLocation.groupItemIndex,
    endLocation.groupItemIndex,
  );
  return valid(
    group.itemIds.slice(firstIndex, lastIndex + 1),
    "item-slice",
    [group.key],
    resolvedStart,
    resolvedEnd,
  );
}

function resolveGroupEndpoints(
  presentation: RangePresentation,
  start: Extract<RangeEndpoint, { kind: "group" }>,
  end: Extract<RangeEndpoint, { kind: "group" }>,
): RangeResolution {
  if (presentation.grouping === "flat") {
    return invalid("group-endpoint-not-supported");
  }

  const startGroupIndex = findUniqueGroupIndex(
    presentation.groups,
    start.groupKey,
  );
  if (startGroupIndex === "ambiguous") {
    return invalid("ambiguous-group-key");
  }
  if (startGroupIndex === -1) return invalid("start-not-visible");

  const endGroupIndex = findUniqueGroupIndex(presentation.groups, end.groupKey);
  if (endGroupIndex === "ambiguous") {
    return invalid("ambiguous-group-key");
  }
  if (endGroupIndex === -1) return invalid("end-not-visible");

  if (startGroupIndex === endGroupIndex) return invalid("same-endpoint");
  if (presentation.grouping === "hall") return invalid("cross-hall");
  if (Math.abs(startGroupIndex - endGroupIndex) === 1) {
    return invalid("adjacent");
  }

  const resolvedStart: ResolvedRangeEndpoint = {
    kind: "group",
    groupIndex: startGroupIndex,
    itemIndex: null,
    displayIndex: null,
  };
  const resolvedEnd: ResolvedRangeEndpoint = {
    kind: "group",
    groupIndex: endGroupIndex,
    itemIndex: null,
    displayIndex: null,
  };

  return valid(
    groupSpanItemIds(presentation.groups, startGroupIndex, endGroupIndex),
    "group-span",
    groupSpanKeys(presentation.groups, startGroupIndex, endGroupIndex),
    resolvedStart,
    resolvedEnd,
  );
}

/**
 * Resolves a pair of endpoints against the current rendered presentation.
 *
 * - Flat ranges are slices of visible item order.
 * - Hall ranges may only slice items inside one displayed hall group.
 * - Space ranges slice within one group, but include complete displayed groups
 *   when their endpoints cross space groups.
 * - Adjacent endpoints do not form a range.
 */
export function resolveRangeSelection(
  presentation: RangePresentation,
  start: RangeEndpoint,
  end: RangeEndpoint,
): RangeResolution {
  if (
    start.scopeKey !== presentation.scopeKey ||
    end.scopeKey !== presentation.scopeKey
  ) {
    return invalid("scope-mismatch");
  }

  if (start.kind !== end.kind) {
    return invalid("endpoint-kind-mismatch");
  }

  if (start.kind === "item" && end.kind === "item") {
    return resolveItemEndpoints(presentation, start, end);
  }

  if (start.kind === "group" && end.kind === "group") {
    return resolveGroupEndpoints(presentation, start, end);
  }

  return invalid("endpoint-kind-mismatch");
}

/**
 * Returns a new Set without mutating the caller's selection.
 *
 * If every range item is selected, all range items are removed. Otherwise all
 * range items are added. Selection outside the range is always preserved.
 */
export function toggleRangeSelection(
  selectedItemIds: ReadonlySet<string>,
  rangeItemIds: readonly string[],
): RangeToggleResult {
  const targetItemIds = uniqueInOrder(rangeItemIds);
  const nextSelectedItemIds = new Set(selectedItemIds);

  if (targetItemIds.length === 0) {
    return {
      selectedItemIds: nextSelectedItemIds,
      operation: "none",
    };
  }

  const allSelected = targetItemIds.every((itemId) =>
    selectedItemIds.has(itemId),
  );

  if (allSelected) {
    targetItemIds.forEach((itemId) => nextSelectedItemIds.delete(itemId));
    return {
      selectedItemIds: nextSelectedItemIds,
      operation: "deselect",
    };
  }

  targetItemIds.forEach((itemId) => nextSelectedItemIds.add(itemId));
  return {
    selectedItemIds: nextSelectedItemIds,
    operation: "select",
  };
}
