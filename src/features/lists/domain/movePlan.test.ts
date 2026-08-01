import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import {
  buildMovePlan,
  formatMovePlanCount,
  getCandidateSourceOrderedIds,
} from "./movePlan";

const targetDay = "2026-07-30";

function makeItem(
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem {
  return {
    id,
    circle: id,
    eventDate: targetDay,
    block: "A",
    number: "01a",
    title: "",
    price: null,
    purchaseStatus: "None",
    quantity: 1,
    remarks: "",
    priorityLevel: "none",
    ...overrides,
  };
}

describe("buildMovePlan", () => {
  it("keeps exact moves in source-column order and classifies invalid requests", () => {
    const allItems = [
      makeItem("source-b"),
      makeItem("source-a"),
      makeItem("wrong-date", { eventDate: "2026-07-29" }),
      makeItem("other-column"),
    ];

    const result = buildMovePlan({
      requestedIds: [
        "source-a",
        "missing",
        "wrong-date",
        "other-column",
        "source-b",
        "source-a",
        "missing",
      ],
      sourceOrderedIds: ["source-b", "source-a", "source-b", "wrong-date"],
      allItems,
      dayName: targetDay,
      expansionPolicy: "exact",
    });

    expect(result).toEqual({
      requested: ["source-b", "source-a"],
      effective: ["source-b", "source-a"],
      implicit: [],
      excluded: {
        missing: ["missing"],
        wrongDate: ["wrong-date"],
        notInSourceColumn: ["other-column"],
      },
    });
  });

  it("adds only same-day, same-source, same-space and same-priority siblings", () => {
    const allItems = [
      makeItem("seed", { number: "01a", priorityLevel: "priority" }),
      makeItem("same-visit", {
        number: "01a2",
        priorityLevel: "priority",
      }),
      makeItem("same-space-other-priority", {
        number: "01a3",
        priorityLevel: "highest",
      }),
      makeItem("other-space", {
        number: "01b",
        priorityLevel: "priority",
      }),
      makeItem("same-visit-other-day", {
        eventDate: "2026-07-29",
        number: "01a4",
        priorityLevel: "priority",
      }),
      makeItem("same-visit-other-column", {
        number: "01a5",
        priorityLevel: "priority",
      }),
    ];

    const result = buildMovePlan({
      requestedIds: ["seed"],
      sourceOrderedIds: [
        "other-space",
        "same-visit",
        "same-space-other-priority",
        "same-visit-other-day",
        "seed",
      ],
      allItems,
      dayName: targetDay,
      expansionPolicy: "same-visit",
    });

    expect(result.requested).toEqual(["seed"]);
    expect(result.effective).toEqual(["same-visit", "seed"]);
    expect(result.implicit).toEqual(["same-visit"]);
    expect(result.excluded).toEqual({
      missing: [],
      wrongDate: [],
      notInSourceColumn: [],
    });
  });

  it("expands every accepted requested visit and preserves one source order", () => {
    const allItems = [
      makeItem("a-implicit", { block: "A", number: "01a2" }),
      makeItem("b-requested", {
        block: "B",
        number: "02",
        priorityLevel: "highest",
      }),
      makeItem("a-requested", { block: "A", number: "01a" }),
      makeItem("b-implicit", {
        block: "B",
        number: "02",
        priorityLevel: "highest",
      }),
    ];

    const result = buildMovePlan({
      requestedIds: ["b-requested", "a-requested", "b-requested"],
      sourceOrderedIds: [
        "a-implicit",
        "b-requested",
        "a-requested",
        "b-implicit",
        "a-implicit",
      ],
      allItems,
      dayName: targetDay,
      expansionPolicy: "same-visit",
    });

    expect(result.requested).toEqual(["b-requested", "a-requested"]);
    expect(result.effective).toEqual([
      "a-implicit",
      "b-requested",
      "a-requested",
      "b-implicit",
    ]);
    expect(result.implicit).toEqual(["a-implicit", "b-implicit"]);
  });

  it("does not let excluded requests seed implicit expansion", () => {
    const allItems = [
      makeItem("wrong-date-seed", {
        eventDate: "2026-07-29",
        number: "03a",
      }),
      makeItem("same-space-today", { number: "03a2" }),
      makeItem("other-column-seed", { number: "04a" }),
      makeItem("same-space-in-source", { number: "04a2" }),
    ];

    const result = buildMovePlan({
      requestedIds: ["wrong-date-seed", "other-column-seed", "missing"],
      sourceOrderedIds: ["same-space-today", "same-space-in-source"],
      allItems,
      dayName: targetDay,
      expansionPolicy: "same-visit",
    });

    expect(result).toEqual({
      requested: [],
      effective: [],
      implicit: [],
      excluded: {
        missing: ["missing"],
        wrongDate: ["wrong-date-seed"],
        notInSourceColumn: ["other-column-seed"],
      },
    });
  });

  it("treats omitted and explicit none priority as the same visit", () => {
    const allItems = [
      makeItem("implicit-none", { priorityLevel: "none" }),
      makeItem("requested-omitted", { priorityLevel: undefined }),
    ];

    const result = buildMovePlan({
      requestedIds: ["requested-omitted"],
      sourceOrderedIds: ["implicit-none", "requested-omitted"],
      allItems,
      dayName: targetDay,
      expansionPolicy: "same-visit",
    });

    expect(result.effective).toEqual(["implicit-none", "requested-omitted"]);
    expect(result.implicit).toEqual(["implicit-none"]);
  });
});

describe("formatMovePlanCount", () => {
  it("shows the legacy concise count when nothing is added implicitly", () => {
    expect(
      formatMovePlanCount({
        requested: ["a", "b"],
        effective: ["a", "b"],
        implicit: [],
      }),
    ).toBe("2件");
  });

  it("shows both selected and effective counts when siblings are added", () => {
    expect(
      formatMovePlanCount({
        requested: ["a", "b"],
        effective: ["a", "b", "c"],
        implicit: ["c"],
      }),
    ).toBe("選択2件（移動3件）");
  });
});

describe("getCandidateSourceOrderedIds", () => {
  it("returns the whole current-day candidate column in item order", () => {
    const allItems = [
      makeItem("candidate-b"),
      makeItem("execute"),
      makeItem("other-day", { eventDate: "2026-07-29" }),
      makeItem("candidate-a"),
      makeItem("candidate-b"),
    ];

    expect(
      getCandidateSourceOrderedIds(allItems, targetDay, ["execute"]),
    ).toEqual(["candidate-b", "candidate-a"]);
  });
});
