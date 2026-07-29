import { describe, expect, it } from "vitest";
import { HallDefinition } from "../types/map";
import { calculatePolygonArea, validateHallPolygon } from "./polygonValidation";

const createHall = (
  id: string,
  name: string,
  vertices: { row: number; col: number }[],
): HallDefinition => ({
  id,
  name,
  vertices,
});

describe("polygonValidation", () => {
  it("calculates polygon area", () => {
    const area = calculatePolygonArea([
      { row: 1, col: 1 },
      { row: 1, col: 5 },
      { row: 4, col: 5 },
      { row: 4, col: 1 },
    ]);
    expect(area).toBe(12);
  });

  it("detects self intersection as an error", () => {
    const result = validateHallPolygon({
      vertices: [
        { row: 1, col: 1 },
        { row: 4, col: 4 },
        { row: 1, col: 4 },
        { row: 4, col: 1 },
      ],
      existingHalls: [],
      mapBounds: { maxRow: 10, maxCol: 10 },
    });

    expect(
      result.issues.some((issue) => issue.code === "self_intersection"),
    ).toBe(true);
    expect(result.issues.some((issue) => issue.level === "error")).toBe(true);
  });

  it("detects too-small polygons as errors", () => {
    const result = validateHallPolygon({
      vertices: [
        { row: 1, col: 1 },
        { row: 1, col: 2 },
        { row: 2, col: 2 },
        { row: 2, col: 1 },
      ],
      existingHalls: [],
      mapBounds: { maxRow: 10, maxCol: 10 },
      minArea: 4,
    });

    expect(
      result.issues.some(
        (issue) => issue.code === "too_small" && issue.level === "error",
      ),
    ).toBe(true);
  });

  it("warns when overlap with existing hall is high", () => {
    const existingHall = createHall("h1", "既存ホール", [
      { row: 2, col: 2 },
      { row: 2, col: 8 },
      { row: 8, col: 8 },
      { row: 8, col: 2 },
    ]);

    const result = validateHallPolygon({
      vertices: [
        { row: 3, col: 3 },
        { row: 3, col: 7 },
        { row: 7, col: 7 },
        { row: 7, col: 3 },
      ],
      existingHalls: [existingHall],
      mapBounds: { maxRow: 10, maxCol: 10 },
      overlapThreshold: 0.5,
    });

    expect(
      result.issues.some(
        (issue) =>
          issue.code === "overlap_with_existing" && issue.level === "warning",
      ),
    ).toBe(true);
  });

  it("returns no issues for a valid polygon", () => {
    const result = validateHallPolygon({
      vertices: [
        { row: 1, col: 1 },
        { row: 1, col: 6 },
        { row: 5, col: 6 },
        { row: 5, col: 1 },
      ],
      existingHalls: [],
      mapBounds: { maxRow: 10, maxCol: 10 },
    });

    expect(result.issues).toHaveLength(0);
  });
});
