import { describe, expect, it } from "vitest";
import type { NavigatorItem } from "../types";
import {
  buildStatusSegments,
  countNavigatorStatuses,
  getNavigatorStatusKind,
  getNavigatorWarningKinds,
  hasMissingLimitedQuantity,
  hasUndefinedRequiredPrice,
} from "./statusSegments";

const item = (
  id: string,
  purchaseStatus: NavigatorItem["purchaseStatus"],
  overrides: Partial<NavigatorItem> = {},
): NavigatorItem => ({
  id,
  circle: id,
  block: "A",
  number: "01",
  purchaseStatus,
  price: 100,
  quantity: 1,
  ...overrides,
});

describe("statusSegments", () => {
  it("maps all purchase states to the five fixed visual categories", () => {
    expect(getNavigatorStatusKind(item("none", "None"))).toBe("unvisited");
    expect(getNavigatorStatusKind(item("postpone", "Postpone"))).toBe(
      "postponed",
    );
    expect(getNavigatorStatusKind(item("late", "Late"))).toBe("late");
    expect(
      getNavigatorStatusKind(
        item("limited-missing", "LimitedPurchase", { quantity: 3 }),
      ),
    ).toBe("limited");
    expect(
      getNavigatorStatusKind(
        item("limited-complete", "LimitedPurchase", {
          quantity: 3,
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).toBe("completed");
    expect(getNavigatorStatusKind(item("purchased", "Purchased"))).toBe(
      "completed",
    );
    expect(getNavigatorStatusKind(item("sold-out", "SoldOut"))).toBe(
      "completed",
    );
    expect(getNavigatorStatusKind(item("absent", "Absent"))).toBe("completed");
  });

  it("uses the existing strict limited-quantity validity rules", () => {
    expect(
      hasMissingLimitedQuantity(
        item("valid", "LimitedPurchase", {
          quantity: 5,
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).toBe(false);
    expect(
      hasMissingLimitedQuantity(
        item("equal", "LimitedPurchase", {
          quantity: 2,
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).toBe(true);
    expect(
      hasMissingLimitedQuantity(
        item("fraction", "LimitedPurchase", {
          quantity: 3,
          limitedPurchasedQuantity: 1.5,
        }),
      ),
    ).toBe(true);
  });

  it("splits all present categories equally and keeps the fixed display order", () => {
    const items = [
      item("none-1", "None"),
      item("none-2", "None"),
      item("postpone", "Postpone"),
      item("late-1", "Late"),
      item("late-2", "Late"),
      item("late-3", "Late"),
      item("limited", "LimitedPurchase", { quantity: 2 }),
      item("done-1", "Purchased"),
      item("done-2", "SoldOut"),
      item("done-3", "Absent"),
      item("done-4", "LimitedPurchase", {
        quantity: 2,
        limitedPurchasedQuantity: 1,
      }),
    ];

    expect(countNavigatorStatuses(items)).toEqual({
      unvisited: 2,
      postponed: 1,
      late: 3,
      limited: 1,
      completed: 4,
    });
    expect(buildStatusSegments(items)).toEqual([
      {
        kind: "unvisited",
        count: 2,
        startRatio: 0,
        endRatio: 0.2,
        widthRatio: 0.2,
      },
      {
        kind: "postponed",
        count: 1,
        startRatio: 0.2,
        endRatio: 0.4,
        widthRatio: 0.2,
      },
      {
        kind: "late",
        count: 3,
        startRatio: 0.4,
        endRatio: 0.6000000000000001,
        widthRatio: 0.2,
      },
      {
        kind: "limited",
        count: 1,
        startRatio: 0.6000000000000001,
        endRatio: 0.8,
        widthRatio: 0.2,
      },
      {
        kind: "completed",
        count: 4,
        startRatio: 0.8,
        endRatio: 1,
        widthRatio: 0.2,
      },
    ]);
  });

  it("does not make segment width proportional to item count", () => {
    const segments = buildStatusSegments([
      item("none-1", "None"),
      item("none-2", "None"),
      item("none-3", "None"),
      item("done", "Purchased"),
    ]);
    expect(segments.map((segment) => segment.widthRatio)).toEqual([0.5, 0.5]);
    expect(segments.map((segment) => segment.count)).toEqual([3, 1]);
  });

  it("reports warning stripes independently of transition settings", () => {
    const price = item("price", "Purchased", { price: null });
    const legacyPrice = item("legacy-price", "LimitedPurchase", {
      price: -1,
      quantity: 3,
    });
    expect(hasUndefinedRequiredPrice(price)).toBe(true);
    expect(
      hasUndefinedRequiredPrice(item("none", "None", { price: null })),
    ).toBe(false);
    expect(getNavigatorWarningKinds([price, legacyPrice])).toEqual([
      "price",
      "limited",
    ]);
  });

  it("returns no segments or warnings for an empty visit", () => {
    expect(buildStatusSegments([])).toEqual([]);
    expect(getNavigatorWarningKinds([])).toEqual([]);
  });
});
