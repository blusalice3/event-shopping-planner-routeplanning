import { describe, expect, it } from "vitest";
import type { LimitedBulkDialogContext } from "../types/limitedPurchase";
import type { ShoppingItem } from "../types/item";
import { computeLimitedBulkSubmitDecision } from "./limitedBulkFlow";

const flowToken = Symbol("limited-bulk-flow");

const item: ShoppingItem = {
  id: "item-1",
  circle: "Circle",
  eventDate: "Day1",
  block: "A",
  number: "01",
  title: "Book",
  price: 1000,
  purchaseStatus: "None",
  quantity: 2,
  remarks: "",
};

const context: LimitedBulkDialogContext = {
  itemSnapshot: item,
  queueIds: ["item-1"],
  index: 0,
  skippedCount: 1,
  preserveStartNotification: false,
  flowToken,
};

describe("computeLimitedBulkSubmitDecision", () => {
  it("returns stale when the flow is inactive", () => {
    expect(
      computeLimitedBulkSubmitDecision({
        context,
        latestItem: item,
        decision: {
          isBaseTarget: true,
          isTarget: true,
          skippedForSingleQuantity: false,
        },
        isActiveFlow: false,
      }),
    ).toEqual({ kind: "stale", flowToken });
  });

  it("does not require a decision when the latest item is missing", () => {
    expect(
      computeLimitedBulkSubmitDecision({
        context,
        latestItem: undefined,
        isActiveFlow: true,
      }),
    ).toEqual({
      kind: "notFound",
      flowToken,
      nextIndex: 1,
      nextSkippedCount: 2,
    });
  });

  it("skips latest items that are no longer targets", () => {
    expect(
      computeLimitedBulkSubmitDecision({
        context,
        latestItem: item,
        decision: {
          isBaseTarget: true,
          isTarget: false,
          skippedForSingleQuantity: true,
        },
        isActiveFlow: true,
      }),
    ).toEqual({
      kind: "notTarget",
      flowToken,
      nextIndex: 1,
      nextSkippedCount: 2,
    });
  });

  it("commits active target items", () => {
    expect(
      computeLimitedBulkSubmitDecision({
        context,
        latestItem: item,
        decision: {
          isBaseTarget: true,
          isTarget: true,
          skippedForSingleQuantity: false,
        },
        isActiveFlow: true,
      }),
    ).toEqual({
      kind: "commit",
      baseItem: item,
      flowToken,
      nextIndex: 1,
      nextSkippedCount: 1,
    });
  });
});
