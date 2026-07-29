import { describe, expect, it } from "vitest";
import {
  isPointInPolygonInclusive,
  isRoutePathInsideHallPolygon,
} from "./mapRoutePolygon";

const square = [
  { row: 1, col: 1 },
  { row: 1, col: 4 },
  { row: 4, col: 4 },
  { row: 4, col: 1 },
];

describe("mapRoutePolygon", () => {
  it("treats boundary points as inside", () => {
    expect(isPointInPolygonInclusive(1, 2, square)).toBe(true);
  });

  it("rejects route segments that leave the polygon", () => {
    expect(
      isRoutePathInsideHallPolygon(
        [
          { row: 2, col: 2 },
          { row: 5, col: 5 },
        ],
        square,
      ),
    ).toBe(false);
  });
});
