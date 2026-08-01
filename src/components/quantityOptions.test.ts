import { describe, expect, it } from "vitest";
import {
  buildQuantityOptions,
  isStandardQuantityOption,
  QUANTITY_OPTION_MAX,
  QUANTITY_OPTION_MIN,
} from "./quantityOptions";

describe("quantity options", () => {
  it("offers every standard quantity from 1 through 20", () => {
    expect(buildQuantityOptions()).toEqual(
      Array.from(
        { length: QUANTITY_OPTION_MAX - QUANTITY_OPTION_MIN + 1 },
        (_, index) => index + QUANTITY_OPTION_MIN,
      ),
    );
  });

  it("keeps a current out-of-range value without duplicating standard values", () => {
    expect(buildQuantityOptions(25)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => index + 1),
      25,
    ]);
    expect(buildQuantityOptions("20")).toHaveLength(20);
  });

  it("identifies only integer values in the standard range", () => {
    expect(isStandardQuantityOption(1)).toBe(true);
    expect(isStandardQuantityOption(20)).toBe(true);
    expect(isStandardQuantityOption(0)).toBe(false);
    expect(isStandardQuantityOption(20.5)).toBe(false);
    expect(isStandardQuantityOption(25)).toBe(false);
  });
});
