import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../types/item";
import { buildRouteDiagnostics } from "./routeDiagnostics";

const makeItem = (
  id: string,
  block: string,
  number: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `Circle ${id}`,
  eventDate: "Day1",
  block,
  number,
  title: `Title ${id}`,
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

describe("buildRouteDiagnostics", () => {
  it("reports normal when all locations are known and the route is reachable", () => {
    expect(
      buildRouteDiagnostics({
        missingItemIds: [],
        items: [],
        validLocationCount: 3,
        routeUnreachable: false,
      }),
    ).toEqual({
      statuses: ["normal"],
      missingItemCount: 0,
      missingLocations: [],
      validLocationCount: 3,
    });
  });

  it("groups missing items at the same normalized block and number", () => {
    const items = [
      makeItem("a", "東A", "12"),
      makeItem("b", " 東A ", "12"),
      makeItem("c", "西B", "3"),
    ];

    const result = buildRouteDiagnostics({
      missingItemIds: ["a", "b", "b", "c"],
      items,
      validLocationCount: 2,
      routeUnreachable: false,
    });

    expect(result.statuses).toEqual(["missing-location"]);
    expect(result.missingItemCount).toBe(3);
    expect(result.missingLocations.map((group) => group.label)).toEqual([
      "東A-12（2アイテム）",
      "西B-3（1アイテム）",
    ]);
    expect(result.missingLocations[0].items).toEqual([
      { id: "a", circle: "Circle a", title: "Title a" },
      { id: "b", circle: "Circle b", title: "Title b" },
    ]);
  });

  it("can report missing locations and an unreachable route together", () => {
    const result = buildRouteDiagnostics({
      missingItemIds: ["a"],
      items: [makeItem("a", "A", "1")],
      validLocationCount: 2,
      routeUnreachable: true,
    });

    expect(result.statuses).toEqual(["missing-location", "unreachable"]);
  });

  it.each([0, 1])(
    "does not report unreachable with %i valid location(s)",
    (validLocationCount) => {
      const result = buildRouteDiagnostics({
        missingItemIds: [],
        items: [],
        validLocationCount,
        routeUnreachable: true,
      });

      expect(result.statuses).toEqual(["normal"]);
    },
  );
});
