import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../types/item";
import {
  applyLimitedPurchase,
  formatDisplayQuantity,
  getActualPurchasedQuantity,
  getChargeableQuantity,
  getLimitedBulkInputTargetDecision,
  getLimitedBulkInputTargets,
  getLimitedPurchaseCounts,
  getNextPurchaseStatus,
  getPlannedBudgetQuantity,
  getSafePriceForCalculation,
  hasMissingLimitedPurchaseQuantity,
  isCountedAsPurchased,
  isPriceRequiredStatus,
  isPurchasedLike,
  isUndefinedPrice,
  matchesPurchaseStatusFilter,
  normalizeLimitedPurchaseFields,
  parseDecimalIntegerInput,
  validateLimitedPurchasePlannedQuantity,
  validateLimitedPurchaseQuantities,
} from "./purchaseQuantity";

const makeItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "item-1",
  circle: "Circle",
  eventDate: "Day1",
  block: "A",
  number: "01",
  title: "Title",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

describe("purchaseQuantity utilities", () => {
  it("skips LimitedPurchase in cycle mode for quantity 1 when enabled", () => {
    expect(
      getNextPurchaseStatus("Late", {
        item: makeItem({ quantity: 1 }),
        skipLimitedPurchaseForSingleQuantity: true,
      }),
    ).toBe("None");
    expect(
      getNextPurchaseStatus("Late", {
        item: makeItem({ quantity: 2 }),
        skipLimitedPurchaseForSingleQuantity: true,
      }),
    ).toBe("LimitedPurchase");
    expect(
      getNextPurchaseStatus("Late", {
        item: makeItem({ quantity: 1 }),
        skipLimitedPurchaseForSingleQuantity: false,
      }),
    ).toBe("LimitedPurchase");
  });

  it("falls back to None for an invalid current status", () => {
    expect(
      getNextPurchaseStatus("Unknown" as never, {
        item: makeItem({ quantity: 1 }),
        skipLimitedPurchaseForSingleQuantity: true,
      }),
    ).toBe("None");
  });

  it("keeps existing missing LimitedPurchase items in bulk targets", () => {
    const quantityOneNone = makeItem({
      id: "none-1",
      purchaseStatus: "None",
      quantity: 1,
    });
    const quantityTwoLate = makeItem({
      id: "late-2",
      purchaseStatus: "Late",
      quantity: 2,
    });
    const missingLimited = makeItem({
      id: "limited-1",
      purchaseStatus: "LimitedPurchase",
      quantity: 1,
    });

    expect(
      getLimitedBulkInputTargetDecision(quantityOneNone, {
        skipLimitedPurchaseForSingleQuantity: true,
      }),
    ).toEqual({
      isBaseTarget: true,
      isTarget: false,
      skippedForSingleQuantity: true,
    });

    expect(
      getLimitedBulkInputTargets(
        [quantityOneNone, quantityTwoLate, missingLimited],
        {
          skipLimitedPurchaseForSingleQuantity: true,
        },
      ),
    ).toEqual({
      targets: [quantityTwoLate, missingLimited],
      singleQuantitySkippedCount: 1,
      baseTargetCount: 3,
    });
  });

  it("formats limited purchase quantities", () => {
    expect(
      formatDisplayQuantity(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).toBe("2/5");
    expect(
      formatDisplayQuantity(
        makeItem({ purchaseStatus: "LimitedPurchase", quantity: 5 }),
      ),
    ).toBe("-/5");
  });

  it("identifies purchased-like and price-required statuses", () => {
    expect(isPurchasedLike(makeItem({ purchaseStatus: "Purchased" }))).toBe(
      true,
    );
    expect(
      isPurchasedLike(makeItem({ purchaseStatus: "LimitedPurchase" })),
    ).toBe(true);
    expect(
      isPriceRequiredStatus(makeItem({ purchaseStatus: "Purchased" })),
    ).toBe(true);
    expect(
      isPriceRequiredStatus(makeItem({ purchaseStatus: "LimitedPurchase" })),
    ).toBe(true);
  });

  it("handles undefined prices", () => {
    expect(isUndefinedPrice(null)).toBe(true);
    expect(isUndefinedPrice(-1)).toBe(true);
    expect(getSafePriceForCalculation(null)).toBe(0);
    expect(getSafePriceForCalculation(-1)).toBe(0);
  });

  it("uses actual quantity for limited purchase charge calculations", () => {
    expect(
      getChargeableQuantity(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).toBe(2);
    expect(
      getChargeableQuantity(
        makeItem({ purchaseStatus: "LimitedPurchase", quantity: 5 }),
      ),
    ).toBe(0);
    expect(
      getActualPurchasedQuantity(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 5,
        }),
      ),
    ).toBeUndefined();
    expect(getPlannedBudgetQuantity(makeItem({ quantity: 7 }))).toBe(7);
  });

  it("detects missing limited purchase quantities from invalid actual values", () => {
    expect(
      hasMissingLimitedPurchaseQuantity(
        makeItem({ purchaseStatus: "LimitedPurchase" }),
      ),
    ).toBe(true);
    expect(
      hasMissingLimitedPurchaseQuantity(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 0,
        }),
      ),
    ).toBe(true);
    expect(
      hasMissingLimitedPurchaseQuantity(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 2.5,
        }),
      ),
    ).toBe(true);
    expect(
      hasMissingLimitedPurchaseQuantity(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 5,
        }),
      ),
    ).toBe(true);
  });

  it("counts purchased and limited purchase items correctly", () => {
    expect(
      isCountedAsPurchased(makeItem({ purchaseStatus: "Purchased" })),
    ).toBe(true);
    expect(
      isCountedAsPurchased(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).toBe(true);
    expect(
      isCountedAsPurchased(
        makeItem({ purchaseStatus: "LimitedPurchase", quantity: 5 }),
      ),
    ).toBe(false);
  });

  it("matches purchase status filters with Purchased and LimitedPurchase separated", () => {
    expect(
      matchesPurchaseStatusFilter(
        makeItem({ purchaseStatus: "Purchased" }),
        "Purchased",
      ),
    ).toBe(true);
    expect(
      matchesPurchaseStatusFilter(
        makeItem({ purchaseStatus: "LimitedPurchase" }),
        "Purchased",
      ),
    ).toBe(false);
    expect(
      matchesPurchaseStatusFilter(
        makeItem({ purchaseStatus: "LimitedPurchase" }),
        "LimitedPurchase",
      ),
    ).toBe(true);
  });

  it("counts limited purchase totals and missing quantities", () => {
    expect(
      getLimitedPurchaseCounts([
        makeItem({
          id: "1",
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 2,
        }),
        makeItem({ id: "2", purchaseStatus: "LimitedPurchase", quantity: 5 }),
        makeItem({
          id: "3",
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 1,
        }),
        makeItem({ id: "4", purchaseStatus: "Purchased" }),
      ]),
    ).toEqual({ total: 3, missing: 1 });
  });

  it("validates limited purchase quantities in actual-first order", () => {
    expect(validateLimitedPurchaseQuantities(undefined, undefined)).toEqual({
      ok: false,
      error: "actual_required",
    });
    expect(validateLimitedPurchaseQuantities(Number.NaN, 5)).toEqual({
      ok: false,
      error: "actual_not_integer",
    });
    expect(validateLimitedPurchaseQuantities(Number.NaN, undefined)).toEqual({
      ok: false,
      error: "actual_not_integer",
    });
    expect(validateLimitedPurchaseQuantities(2.5, 5)).toEqual({
      ok: false,
      error: "actual_not_integer",
    });
    expect(validateLimitedPurchaseQuantities(0, 5)).toEqual({
      ok: false,
      error: "actual_not_positive",
    });
    expect(validateLimitedPurchaseQuantities(0, undefined)).toEqual({
      ok: false,
      error: "actual_not_positive",
    });
    expect(validateLimitedPurchaseQuantities(5, 5)).toEqual({
      ok: false,
      error: "actual_not_less_than_planned",
    });
    expect(validateLimitedPurchaseQuantities(8, 5)).toEqual({
      ok: false,
      error: "actual_not_less_than_planned",
    });
    expect(validateLimitedPurchasePlannedQuantity(Number.NaN)).toEqual({
      ok: false,
      error: "planned_not_integer",
    });
  });

  it("parses only half-width decimal integer strings", () => {
    expect(parseDecimalIntegerInput("05")).toBe(5);
    expect(parseDecimalIntegerInput("001")).toBe(1);
    for (const value of ["1e3", "0x10", "2.0", "1,000", "５"]) {
      expect(Number.isNaN(parseDecimalIntegerInput(value))).toBe(true);
    }
  });

  it("normalizes stale or invalid limited purchase fields", () => {
    expect(
      normalizeLimitedPurchaseFields(
        makeItem({
          purchaseStatus: "Purchased",
          limitedPurchasedQuantity: 2,
        }),
      ),
    ).not.toHaveProperty("limitedPurchasedQuantity");
    expect(
      normalizeLimitedPurchaseFields(
        makeItem({
          purchaseStatus: "LimitedPurchase",
          quantity: 5,
          limitedPurchasedQuantity: 5,
        }),
      ),
    ).not.toHaveProperty("limitedPurchasedQuantity");
    expect(
      normalizeLimitedPurchaseFields(makeItem({ price: -1 })).price,
    ).toBeNull();
  });

  it("does not create a limitedPurchasedQuantity property for deferred limited purchase input", () => {
    expect(applyLimitedPurchase(makeItem(), { planned: 5 })).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });
});
