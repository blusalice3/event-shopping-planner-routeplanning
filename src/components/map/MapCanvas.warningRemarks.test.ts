import { describe, expect, it } from "vitest";
import {
  shouldDrawReadableNumberBackground,
  shouldHighlightCandidateRemarks,
  syncCanvasBackingStoreSize,
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

describe("syncCanvasBackingStoreSize", () => {
  it("does not reset an already correctly sized backing store", () => {
    let width = 0;
    let height = 0;
    let widthWrites = 0;
    let heightWrites = 0;
    const canvas = {
      style: { width: "", height: "" },
      get width() {
        return width;
      },
      set width(value: number) {
        widthWrites++;
        width = value;
      },
      get height() {
        return height;
      },
      set height(value: number) {
        heightWrites++;
        height = value;
      },
    } as unknown as HTMLCanvasElement;

    syncCanvasBackingStoreSize(canvas, 281, 201, 1.25);
    syncCanvasBackingStoreSize(canvas, 281, 201, 1.25);

    expect(canvas.style.width).toBe("281px");
    expect(canvas.style.height).toBe("201px");
    expect(width).toBe(351);
    expect(height).toBe(251);
    expect(widthWrites).toBe(1);
    expect(heightWrites).toBe(1);
  });
});
