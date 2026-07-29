import { describe, expect, it } from "vitest";
import type { NavigatorItem, NavigationIntent } from "../types";
import { evaluateNavigationGuard } from "./navigationGuard";

const makeItem = (
  id: string,
  overrides: Partial<NavigatorItem> = {},
): NavigatorItem => ({
  id,
  circle: id,
  block: "A",
  number: "01",
  purchaseStatus: "Purchased",
  price: 100,
  quantity: 1,
  ...overrides,
});

const blockedItems: NavigatorItem[] = [
  makeItem("price", { price: null }),
  makeItem("limited", {
    purchaseStatus: "LimitedPurchase",
    price: 100,
    quantity: 3,
  }),
  makeItem("unvisited", { purchaseStatus: "None", price: null }),
];

describe("evaluateNavigationGuard", () => {
  it.each<NavigationIntent>(["set-current", "temporary"])(
    "blocks forward %s movement on current-visit price and limited inputs",
    (intent) => {
      expect(
        evaluateNavigationGuard({
          intent,
          currentIndex: 2,
          targetIndex: 8,
          currentItems: blockedItems,
        }),
      ).toEqual({
        allowed: false,
        direction: "forward",
        checked: true,
        blockingReasons: ["price", "limited"],
        advisoryReasons: ["unvisited"],
        priceWarningItemIds: ["price"],
        limitedWarningItemIds: ["limited"],
        unvisitedItemIds: ["unvisited"],
      });
    },
  );

  it("allows unvisited items after an advisory when no blocking input is missing", () => {
    const result = evaluateNavigationGuard({
      intent: "set-current",
      currentIndex: 0,
      targetIndex: 1,
      currentItems: [makeItem("none", { purchaseStatus: "None", price: null })],
    });
    expect(result.allowed).toBe(true);
    expect(result.advisoryReasons).toEqual(["unvisited"]);
    expect(result.blockingReasons).toEqual([]);
  });

  it("honors both block-disable settings but preserves warning data", () => {
    const result = evaluateNavigationGuard({
      intent: "temporary",
      currentIndex: 0,
      targetIndex: 9,
      currentItems: blockedItems,
      settings: {
        disablePriceUndefinedCheck: true,
        disableLimitedPurchaseQuantityCheck: true,
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.blockingReasons).toEqual([]);
    expect(result.priceWarningItemIds).toEqual(["price"]);
    expect(result.limitedWarningItemIds).toEqual(["limited"]);
  });

  it("supports the existing per-item limited-input deferral", () => {
    const result = evaluateNavigationGuard({
      intent: "set-current",
      currentIndex: 0,
      targetIndex: 1,
      currentItems: [
        makeItem("limited-1", {
          purchaseStatus: "LimitedPurchase",
          quantity: 3,
        }),
        makeItem("limited-2", {
          purchaseStatus: "LimitedPurchase",
          quantity: 4,
        }),
      ],
      settings: { deferredLimitedItemIds: new Set(["limited-1"]) },
    });
    expect(result.allowed).toBe(false);
    expect(result.blockingReasons).toEqual(["limited"]);

    const allDeferred = evaluateNavigationGuard({
      intent: "set-current",
      currentIndex: 0,
      targetIndex: 1,
      currentItems: result.limitedWarningItemIds.map((id) =>
        makeItem(id, { purchaseStatus: "LimitedPurchase", quantity: 3 }),
      ),
      settings: { deferredLimitedItemIds: ["limited-1", "limited-2"] },
    });
    expect(allDeferred.allowed).toBe(true);
  });

  it.each<NavigationIntent>(["inspect", "return", "promote-temporary"])(
    "does not check %s movement even when it points forward",
    (intent) => {
      const result = evaluateNavigationGuard({
        intent,
        currentIndex: 0,
        targetIndex: 10,
        currentItems: blockedItems,
      });
      expect(result).toMatchObject({
        allowed: true,
        direction: "forward",
        checked: false,
        blockingReasons: [],
        advisoryReasons: [],
      });
    },
  );

  it.each([
    { currentIndex: 5, targetIndex: 2, direction: "backward" as const },
    { currentIndex: 5, targetIndex: 5, direction: "same" as const },
  ])(
    "never blocks a $direction move",
    ({ currentIndex, targetIndex, direction }) => {
      const result = evaluateNavigationGuard({
        intent: "set-current",
        currentIndex,
        targetIndex,
        currentItems: blockedItems,
      });
      expect(result).toMatchObject({
        allowed: true,
        direction,
        checked: false,
        blockingReasons: [],
      });
    },
  );
});
