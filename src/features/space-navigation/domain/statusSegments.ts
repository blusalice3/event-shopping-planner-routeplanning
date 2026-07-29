import type {
  NavigatorItem,
  NavigatorStatusCounts,
  NavigatorStatusKind,
  NavigatorStatusSegment,
  NavigatorWarningKind,
} from "../types";
import { NAVIGATOR_STATUS_ORDER } from "../types";

export function hasMissingLimitedQuantity(
  item: Pick<
    NavigatorItem,
    "purchaseStatus" | "limitedPurchasedQuantity" | "quantity"
  >,
): boolean {
  if (item.purchaseStatus !== "LimitedPurchase") return false;
  const planned = item.quantity;
  const actual = item.limitedPurchasedQuantity;
  return !(
    Number.isInteger(planned) &&
    planned > 0 &&
    typeof actual === "number" &&
    Number.isInteger(actual) &&
    actual > 0 &&
    actual < planned
  );
}

export function hasUndefinedRequiredPrice(
  item: Pick<NavigatorItem, "purchaseStatus" | "price">,
): boolean {
  const requiresPrice =
    item.purchaseStatus === "Purchased" ||
    item.purchaseStatus === "LimitedPurchase";
  return requiresPrice && (item.price === null || item.price === -1);
}

export function getNavigatorStatusKind(
  item: Pick<
    NavigatorItem,
    "purchaseStatus" | "limitedPurchasedQuantity" | "quantity"
  >,
): NavigatorStatusKind {
  switch (item.purchaseStatus) {
    case "None":
      return "unvisited";
    case "Postpone":
      return "postponed";
    case "Late":
      return "late";
    case "LimitedPurchase":
      return hasMissingLimitedQuantity(item) ? "limited" : "completed";
    case "Purchased":
    case "SoldOut":
    case "Absent":
      return "completed";
  }
}

export function countNavigatorStatuses(
  items: readonly Pick<
    NavigatorItem,
    "purchaseStatus" | "limitedPurchasedQuantity" | "quantity"
  >[],
): NavigatorStatusCounts {
  const counts: NavigatorStatusCounts = {
    unvisited: 0,
    postponed: 0,
    late: 0,
    limited: 0,
    completed: 0,
  };

  items.forEach((item) => {
    counts[getNavigatorStatusKind(item)] += 1;
  });

  return counts;
}

/**
 * Every category that exists receives the same visual width. Counts are kept
 * separately for the picker text and accessibility labels.
 */
export function buildStatusSegments(
  items: readonly Pick<
    NavigatorItem,
    "purchaseStatus" | "limitedPurchasedQuantity" | "quantity"
  >[],
): NavigatorStatusSegment[] {
  const counts = countNavigatorStatuses(items);
  const presentKinds = NAVIGATOR_STATUS_ORDER.filter(
    (kind) => counts[kind] > 0,
  );
  if (presentKinds.length === 0) return [];

  const widthRatio = 1 / presentKinds.length;
  return presentKinds.map((kind, index) => ({
    kind,
    count: counts[kind],
    startRatio: index * widthRatio,
    endRatio: index === presentKinds.length - 1 ? 1 : (index + 1) * widthRatio,
    widthRatio,
  }));
}

export function getNavigatorWarningKinds(
  items: readonly Pick<
    NavigatorItem,
    "purchaseStatus" | "price" | "limitedPurchasedQuantity" | "quantity"
  >[],
): NavigatorWarningKind[] {
  const warnings: NavigatorWarningKind[] = [];
  if (items.some(hasUndefinedRequiredPrice)) warnings.push("price");
  if (items.some(hasMissingLimitedQuantity)) warnings.push("limited");
  return warnings;
}

export function getNavigatorWarningItemIds(
  items: readonly NavigatorItem[],
): Record<NavigatorWarningKind, string[]> {
  return {
    price: items.filter(hasUndefinedRequiredPrice).map((item) => item.id),
    limited: items.filter(hasMissingLimitedQuantity).map((item) => item.id),
  };
}
