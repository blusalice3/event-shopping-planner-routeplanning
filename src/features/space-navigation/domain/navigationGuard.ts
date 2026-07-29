import type {
  NavigationDirection,
  NavigationGuardInput,
  NavigationGuardResult,
  NavigationIntent,
} from "../types";
import { getNavigatorWarningItemIds } from "./statusSegments";

export function getNavigationDirection(
  currentIndex: number,
  targetIndex: number,
): NavigationDirection {
  if (targetIndex > currentIndex) return "forward";
  if (targetIndex < currentIndex) return "backward";
  return "same";
}

export function shouldCheckNavigation(
  intent: NavigationIntent,
  direction: NavigationDirection,
): boolean {
  return (
    direction === "forward" &&
    (intent === "set-current" || intent === "temporary")
  );
}

function toSet(
  values: ReadonlySet<string> | readonly string[] | undefined,
): ReadonlySet<string> {
  if (!values) return new Set<string>();
  return values instanceof Set ? values : new Set(values);
}

export function evaluateNavigationGuard(
  input: NavigationGuardInput,
): NavigationGuardResult {
  const direction = getNavigationDirection(
    input.currentIndex,
    input.targetIndex,
  );
  const checked = shouldCheckNavigation(input.intent, direction);
  const warningIds = getNavigatorWarningItemIds(input.currentItems);
  const unvisitedItemIds = input.currentItems
    .filter((item) => item.purchaseStatus === "None")
    .map((item) => item.id);

  if (!checked) {
    return {
      allowed: true,
      direction,
      checked: false,
      blockingReasons: [],
      advisoryReasons: [],
      priceWarningItemIds: warningIds.price,
      limitedWarningItemIds: warningIds.limited,
      unvisitedItemIds,
    };
  }

  const settings = input.settings ?? {};
  const deferredIds = toSet(settings.deferredLimitedItemIds);
  const unresolvedLimitedIds = warningIds.limited.filter(
    (id) => !deferredIds.has(id),
  );
  const blockingReasons: NavigationGuardResult["blockingReasons"] = [];

  if (!settings.disablePriceUndefinedCheck && warningIds.price.length > 0) {
    blockingReasons.push("price");
  }
  if (
    !settings.disableLimitedPurchaseQuantityCheck &&
    unresolvedLimitedIds.length > 0
  ) {
    blockingReasons.push("limited");
  }

  return {
    allowed: blockingReasons.length === 0,
    direction,
    checked: true,
    blockingReasons,
    advisoryReasons: unvisitedItemIds.length > 0 ? ["unvisited"] : [],
    priceWarningItemIds: warningIds.price,
    limitedWarningItemIds: warningIds.limited,
    unvisitedItemIds,
  };
}
