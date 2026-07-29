import { describe, expect, it } from "vitest";
import {
  buildSpaceKey,
  buildVisitId,
  buildVisitIdentity,
  isSameVisit,
  normalizeBaseSpaceNumber,
  normalizeSpaceBlock,
} from "./visitIdentity";

describe("visitIdentity", () => {
  it("normalizes full-width text, case, whitespace, and a trailing sub-number", () => {
    expect(normalizeBaseSpaceNumber(" ０１Ａ２ ")).toBe("01a");
    expect(normalizeBaseSpaceNumber("15c3")).toBe("15c");
    expect(normalizeBaseSpaceNumber("01Ab12")).toBe("01ab");
  });

  it("does not strip meaningful digits from numbers without a letter suffix", () => {
    expect(normalizeBaseSpaceNumber("012")).toBe("012");
    expect(normalizeBaseSpaceNumber("42")).toBe("42");
  });

  it("normalizes a block without changing its case-sensitive identity", () => {
    expect(normalizeSpaceBlock(" Ａ  西 ")).toBe("A 西");
    expect(buildSpaceKey(" A ", "０１A2")).toBe("A-01a");
  });

  it("includes priority in every visit id", () => {
    expect(buildVisitId({ block: "A", number: "01" })).toBe("A-01:none");
    expect(
      buildVisitId({ block: "A", number: "01", priorityLevel: "highest" }),
    ).toBe("A-01:highest");
    expect(
      buildVisitId({ block: "A", number: "01", priorityLevel: "priority" }),
    ).toBe("A-01:priority");
  });

  it("includes the focus phase while retaining a readable space identity", () => {
    expect(
      buildVisitIdentity({
        phase: "normal",
        block: "A",
        number: "01",
        priorityLevel: "highest",
      }),
    ).toEqual({
      id: "normal:A-01:highest",
      spaceKey: "A-01",
      phase: "normal",
      block: "A",
      number: "01",
      priorityLevel: "highest",
    });
    expect(
      buildVisitId({
        phase: "postponed",
        block: "A",
        number: "01",
        priorityLevel: "highest",
      }),
    ).toBe("postponed:A-01:highest");
  });

  it("treats normalized aliases as the same visit but separates priority and phase", () => {
    expect(
      isSameVisit(
        { block: "Ａ", number: "01A2", priorityLevel: "none" },
        { block: "A", number: "01a", priorityLevel: "none" },
      ),
    ).toBe(true);
    expect(
      isSameVisit(
        { block: "A", number: "01a", priorityLevel: "highest" },
        { block: "A", number: "01a", priorityLevel: "priority" },
      ),
    ).toBe(false);
    expect(
      isSameVisit(
        { phase: "normal", block: "A", number: "01a" },
        { phase: "late", block: "A", number: "01a" },
      ),
    ).toBe(false);
  });
});
