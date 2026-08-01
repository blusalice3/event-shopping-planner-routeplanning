import { describe, expect, it } from "vitest";
import { decideSheetQuantity } from "./quantitySync";

describe("decideSheetQuantity", () => {
  it.each([
    ["1", 1],
    ["01", 1],
    ["20", 20],
    [1, 1],
    [20, 20],
  ] as const)("1～20の整数 %p を数量として反映する", (input, expected) => {
    expect(decideSheetQuantity(input, "existing")).toEqual({
      kind: "apply",
      quantity: expected,
      usedDefault: false,
    });
  });

  it("既存品目の空欄は現在値を維持し、新規品目の空欄は1にする", () => {
    expect(decideSheetQuantity("  ", "existing")).toEqual({
      kind: "preserve",
    });
    expect(decideSheetQuantity(undefined, "new")).toEqual({
      kind: "apply",
      quantity: 1,
      usedDefault: true,
    });
  });

  it.each(["0", "-1", "1.5", "abc", "21", 0, -1, 1.5, 21])(
    "不正な数量 %p を反映しない",
    (input) => {
      expect(decideSheetQuantity(input, "existing").kind).toBe("invalid");
      expect(decideSheetQuantity(input, "new").kind).toBe("invalid");
    },
  );

  it("数字以外を取り除いたり、小数表記を整数へ丸めたりしない", () => {
    expect(decideSheetQuantity("2個", "existing").kind).toBe("invalid");
    expect(decideSheetQuantity("2.0", "existing").kind).toBe("invalid");
  });
});
