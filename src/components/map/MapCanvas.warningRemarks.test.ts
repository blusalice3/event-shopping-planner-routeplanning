import { describe, expect, it } from "vitest";
import {
  shouldDrawReadableNumberBackground,
  shouldHighlightCandidateRemarks,
} from "./MapCanvas";

describe("shouldHighlightCandidateRemarks", () => {
  it.each(["優先です", "委託無", "最優先で購入"])(
    "highlights candidate items with warning remarks: %s",
    (remarks) => {
      expect(
        shouldHighlightCandidateRemarks(
          { id: "candidate", remarks },
          new Set(),
        ),
      ).toBe(true);
    },
  );

  it("does not highlight ordinary candidate remarks", () => {
    expect(
      shouldHighlightCandidateRemarks(
        { id: "candidate", remarks: "新刊セットを確認" },
        new Set(),
      ),
    ).toBe(false);
  });

  it("does not highlight items already in the execute list", () => {
    expect(
      shouldHighlightCandidateRemarks(
        { id: "execute", remarks: "委託無" },
        new Set(["execute"]),
      ),
    ).toBe(false);
  });
});

describe("shouldDrawReadableNumberBackground", () => {
  it.each([
    { hasPriorityUnvisited: true, hasWarningRemarksUnvisited: false },
    { hasPriorityUnvisited: false, hasWarningRemarksUnvisited: true },
  ])("draws a background for highlighted number cells", (state) => {
    expect(shouldDrawReadableNumberBackground(state, 42)).toBe(true);
  });

  it("does not draw the number background for text cells", () => {
    expect(
      shouldDrawReadableNumberBackground(
        { hasPriorityUnvisited: false, hasWarningRemarksUnvisited: true },
        "42",
      ),
    ).toBe(false);
  });
});
