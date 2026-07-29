import { describe, expect, it } from "vitest";
import type { MapRoutePoint } from "./mapRoutePoints";
import { validateMapSmartInsert } from "./mapSmartInsert";

const point = (itemId: string, groupKey: string | null): MapRoutePoint => ({
  itemId,
  row: 1,
  col: 1,
  order: 0,
  priorityLevel: "none",
  groupKey,
  hallId: null,
  anchorLabel: itemId,
});

describe("validateMapSmartInsert", () => {
  it("accepts compatible unresolved hall priority groups", () => {
    expect(
      validateMapSmartInsert({
        anchorItemId: "a",
        pendingItemIds: ["b"],
        routePoints: [
          point("a", "undefined:priority"),
          point("b", "undefined:priority"),
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("rejects group mismatches", () => {
    const result = validateMapSmartInsert({
      anchorItemId: "a",
      pendingItemIds: ["b"],
      routePoints: [point("a", "h1:none"), point("b", "h2:none")],
    });

    expect(result).toMatchObject({ ok: false, reason: "group-mismatch" });
  });
});
