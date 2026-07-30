import type { ShoppingItem } from "../../../types/item";
import { getSpaceKey } from "../../../utils/spaceGrouping";

export type MovePlanExpansionPolicy = "exact" | "same-visit";

export interface BuildMovePlanInput {
  requestedIds: readonly string[];
  sourceOrderedIds: readonly string[];
  allItems: readonly ShoppingItem[];
  dayName: string;
  expansionPolicy: MovePlanExpansionPolicy;
}

export interface MovePlanExcludedIds {
  missing: string[];
  wrongDate: string[];
  notInSourceColumn: string[];
}

export interface MovePlan {
  /**
   * 移動元の列に存在し、対象日も一致した明示選択。
   * sourceOrderedIds の順序で重複を除く。
   */
  requested: string[];
  /**
   * 実際の移動対象。requested と暗黙追加を合わせたもの。
   * sourceOrderedIds の順序で重複を除く。
   */
  effective: string[];
  /**
   * same-visit 規則によって requested に追加された対象。
   * sourceOrderedIds の順序で重複を除く。
   */
  implicit: string[];
  /**
   * 移動対象に採用できなかった明示選択。
   * 各配列は requestedIds の初出順で重複を除く。
   */
  excluded: MovePlanExcludedIds;
}

export function formatMovePlanCount(
  plan: Pick<MovePlan, "requested" | "effective" | "implicit">,
): string {
  return plan.implicit.length > 0
    ? `選択${plan.requested.length}件（移動${plan.effective.length}件）`
    : `${plan.requested.length}件`;
}

export function getCandidateSourceOrderedIds(
  allItems: readonly ShoppingItem[],
  dayName: string,
  executeOrderedIds: readonly string[],
): string[] {
  const executeIdSet = new Set(executeOrderedIds);
  const seenIds = new Set<string>();
  const candidateIds: string[] = [];

  for (const item of allItems) {
    if (
      item.eventDate !== dayName ||
      executeIdSet.has(item.id) ||
      seenIds.has(item.id)
    ) {
      continue;
    }
    seenIds.add(item.id);
    candidateIds.push(item.id);
  }

  return candidateIds;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function getVisitGroupKey(item: ShoppingItem): string {
  return JSON.stringify([
    getSpaceKey(item.block, item.number),
    item.priorityLevel ?? "none",
  ]);
}

/**
 * 明示された選択から、移動前に表示・確認できる移動計画を構築する。
 *
 * same-visit は、明示選択と同じ日・同じ移動元列にある
 * 「同一スペース + 同一優先度」の兄弟だけを暗黙に追加する。
 */
export function buildMovePlan(input: BuildMovePlanInput): MovePlan {
  const { requestedIds, sourceOrderedIds, allItems, dayName, expansionPolicy } =
    input;

  const itemsById = new Map<string, ShoppingItem>();
  for (const item of allItems) {
    if (!itemsById.has(item.id)) {
      itemsById.set(item.id, item);
    }
  }

  const orderedSourceIds = uniqueIds(sourceOrderedIds);
  const sourceIdSet = new Set(orderedSourceIds);
  const acceptedRequestedIdSet = new Set<string>();
  const excluded: MovePlanExcludedIds = {
    missing: [],
    wrongDate: [],
    notInSourceColumn: [],
  };

  for (const requestedId of uniqueIds(requestedIds)) {
    const item = itemsById.get(requestedId);
    if (!item) {
      excluded.missing.push(requestedId);
      continue;
    }
    if (item.eventDate !== dayName) {
      excluded.wrongDate.push(requestedId);
      continue;
    }
    if (!sourceIdSet.has(requestedId)) {
      excluded.notInSourceColumn.push(requestedId);
      continue;
    }
    acceptedRequestedIdSet.add(requestedId);
  }

  const requested = orderedSourceIds.filter((id) =>
    acceptedRequestedIdSet.has(id),
  );

  if (expansionPolicy === "exact" || requested.length === 0) {
    return {
      requested,
      effective: [...requested],
      implicit: [],
      excluded,
    };
  }

  const requestedVisitGroupKeys = new Set(
    requested.map((id) => getVisitGroupKey(itemsById.get(id)!)),
  );
  const effective = orderedSourceIds.filter((id) => {
    const item = itemsById.get(id);
    return (
      item?.eventDate === dayName &&
      requestedVisitGroupKeys.has(getVisitGroupKey(item))
    );
  });
  const implicit = effective.filter((id) => !acceptedRequestedIdSet.has(id));

  return { requested, effective, implicit, excluded };
}
