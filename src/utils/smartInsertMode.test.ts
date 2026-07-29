import { describe, expect, it } from "vitest";
import { normalizeSmartInsertMode } from "./smartInsertMode";

describe("normalizeSmartInsertMode", () => {
  it.each([
    ["card", "map"],
    ["invalid", "map"],
    [null, "map"],
    ["map", "map"],
    ["preview", "preview"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeSmartInsertMode(input)).toBe(expected);
  });
});
