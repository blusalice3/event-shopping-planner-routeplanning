import { describe, expect, it } from "vitest";
import {
  candidateIndexFromCenteredCoordinate,
  candidateIndexFromCoordinate,
  clampCandidateIndex,
  stepCandidateIndex,
} from "./candidateIndex";

describe("candidateIndex", () => {
  it("uses -1 as the only empty-list candidate", () => {
    expect(clampCandidateIndex(0, 0)).toBe(-1);
    expect(
      candidateIndexFromCoordinate({
        coordinate: 50,
        start: 0,
        end: 100,
        count: 0,
      }),
    ).toBe(-1);
  });

  it("always snaps a one-visit rail to index zero", () => {
    [-100, 0, 50, 100, 200].forEach((coordinate) => {
      expect(
        candidateIndexFromCoordinate({
          coordinate,
          start: 0,
          end: 100,
          count: 1,
        }),
      ).toBe(0);
    });
  });

  it.each([100, 300])("selects all %i equal rail sections exactly", (count) => {
    for (let index = 0; index < count; index += 1) {
      const coordinate = index + 0.5;
      expect(
        candidateIndexFromCoordinate({
          coordinate,
          start: 0,
          end: count,
          count,
        }),
      ).toBe(index);
    }
    expect(
      candidateIndexFromCoordinate({
        coordinate: -1,
        start: 0,
        end: count,
        count,
      }),
    ).toBe(0);
    expect(
      candidateIndexFromCoordinate({
        coordinate: count + 1,
        start: 0,
        end: count,
        count,
      }),
    ).toBe(count - 1);
  });

  it.each([1, 100, 300])(
    "snaps centered picker rows for %i visits",
    (count) => {
      const currentIndex = Math.floor(count / 2);
      expect(
        candidateIndexFromCenteredCoordinate({
          coordinate: 500,
          centerCoordinate: 500,
          rowExtent: 48,
          currentIndex,
          count,
        }),
      ).toBe(currentIndex);
      expect(
        candidateIndexFromCenteredCoordinate({
          coordinate: 548,
          centerCoordinate: 500,
          rowExtent: 48,
          currentIndex,
          count,
        }),
      ).toBe(Math.min(count - 1, currentIndex + 1));
      expect(
        candidateIndexFromCenteredCoordinate({
          coordinate: -10_000,
          centerCoordinate: 500,
          rowExtent: 48,
          currentIndex,
          count,
        }),
      ).toBe(0);
      expect(
        candidateIndexFromCenteredCoordinate({
          coordinate: 10_000,
          centerCoordinate: 500,
          rowExtent: 48,
          currentIndex,
          count,
        }),
      ).toBe(count - 1);
    },
  );

  it("steps one visit and clamps at either end", () => {
    expect(stepCandidateIndex(0, -1, 300)).toBe(0);
    expect(stepCandidateIndex(0, 1, 300)).toBe(1);
    expect(stepCandidateIndex(299, 1, 300)).toBe(299);
  });

  it("handles invalid geometry without producing an out-of-range index", () => {
    expect(
      candidateIndexFromCoordinate({
        coordinate: Number.NaN,
        start: 0,
        end: 100,
        count: 100,
      }),
    ).toBe(0);
    expect(
      candidateIndexFromCenteredCoordinate({
        coordinate: 100,
        centerCoordinate: 50,
        rowExtent: 0,
        currentIndex: 99,
        count: 100,
      }),
    ).toBe(99);
  });
});
