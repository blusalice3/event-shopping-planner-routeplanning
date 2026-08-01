import { describe, expect, it } from "vitest";
import {
  buildRangePresentation,
  resolveRangeSelection,
  toggleRangeSelection,
  type RangeEndpoint,
  type RangePresentation,
} from "./rangeSelection";

const scopeKey = "event-1/day-1/candidate/edit/revision-1";

const itemEndpoint = (itemId: string, scope = scopeKey): RangeEndpoint => ({
  kind: "item",
  itemId,
  scopeKey: scope,
});

const groupEndpoint = (
  groupKey: string | null,
  scope = scopeKey,
): RangeEndpoint => ({
  kind: "group",
  groupKey,
  scopeKey: scope,
});

describe("buildRangePresentation", () => {
  it("keeps flat item IDs in visible order and removes duplicates", () => {
    expect(
      buildRangePresentation({
        scopeKey,
        grouping: "flat",
        itemIds: ["visible-c", "visible-a", "visible-b", "visible-a"],
      }),
    ).toEqual({
      scopeKey,
      grouping: "flat",
      groups: [],
      itemIds: ["visible-c", "visible-a", "visible-b"],
    });
  });

  it("preserves displayed group order and keeps each item at its first occurrence", () => {
    expect(
      buildRangePresentation({
        scopeKey,
        grouping: "space",
        groups: [
          { key: "A-01", itemIds: ["a", "a", "b"] },
          { key: "A-02", itemIds: ["b", "c", "c"] },
        ],
      }),
    ).toEqual({
      scopeKey,
      grouping: "space",
      groups: [
        { key: "A-01", itemIds: ["a", "b"] },
        { key: "A-02", itemIds: ["c"] },
      ],
      itemIds: ["a", "b", "c"],
    });
  });
});

describe("resolveRangeSelection with item endpoints", () => {
  it("uses flat visible order and produces the same ordered range in reverse", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "flat",
      itemIds: ["display-a", "display-b", "display-c", "display-d"],
    });

    const forward = resolveRangeSelection(
      presentation,
      itemEndpoint("display-a"),
      itemEndpoint("display-d"),
    );
    const reverse = resolveRangeSelection(
      presentation,
      itemEndpoint("display-d"),
      itemEndpoint("display-a"),
    );

    expect(forward).toEqual({
      valid: true,
      coverage: "item-slice",
      itemIds: ["display-a", "display-b", "display-c", "display-d"],
      orderedGroupKeys: [],
      start: {
        kind: "item",
        groupIndex: null,
        itemIndex: 0,
        displayIndex: 0,
      },
      end: {
        kind: "item",
        groupIndex: null,
        itemIndex: 3,
        displayIndex: 3,
      },
    });
    expect(reverse).toMatchObject({
      valid: true,
      coverage: "item-slice",
      itemIds: ["display-a", "display-b", "display-c", "display-d"],
      orderedGroupKeys: [],
      start: {
        kind: "item",
        groupIndex: null,
        itemIndex: 3,
        displayIndex: 3,
      },
      end: {
        kind: "item",
        groupIndex: null,
        itemIndex: 0,
        displayIndex: 0,
      },
    });
  });

  it("rejects adjacent flat items", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "flat",
      itemIds: ["a", "b", "c"],
    });

    expect(
      resolveRangeSelection(presentation, itemEndpoint("b"), itemEndpoint("c")),
    ).toEqual({
      valid: false,
      reason: "adjacent",
      itemIds: [],
    });
  });

  it("slices items inside the same displayed hall group", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "hall",
      groups: [
        { key: "east:none", itemIds: ["e1", "e2", "e3", "e4"] },
        { key: "west:none", itemIds: ["w1", "w2", "w3"] },
      ],
    });

    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("e4"),
        itemEndpoint("e1"),
      ),
    ).toEqual({
      valid: true,
      coverage: "item-slice",
      itemIds: ["e1", "e2", "e3", "e4"],
      orderedGroupKeys: ["east:none"],
      start: {
        kind: "item",
        groupIndex: 0,
        itemIndex: 3,
        displayIndex: 3,
      },
      end: {
        kind: "item",
        groupIndex: 0,
        itemIndex: 0,
        displayIndex: 0,
      },
    });
  });

  it("rejects a range across displayed hall groups", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "hall",
      groups: [
        { key: "east:none", itemIds: ["e1", "e2"] },
        { key: "west:none", itemIds: ["w1", "w2"] },
      ],
    });

    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("e1"),
        itemEndpoint("w2"),
      ),
    ).toEqual({
      valid: false,
      reason: "cross-hall",
      itemIds: [],
    });
  });

  it("slices item endpoints inside one displayed space group", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "space",
      groups: [
        { key: "A-01:none", itemIds: ["a1", "a2", "a3", "a4"] },
        { key: "A-02:none", itemIds: ["b1"] },
      ],
    });

    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("a1"),
        itemEndpoint("a4"),
      ),
    ).toEqual({
      valid: true,
      coverage: "item-slice",
      itemIds: ["a1", "a2", "a3", "a4"],
      orderedGroupKeys: ["A-01:none"],
      start: {
        kind: "item",
        groupIndex: 0,
        itemIndex: 0,
        displayIndex: 0,
      },
      end: {
        kind: "item",
        groupIndex: 0,
        itemIndex: 3,
        displayIndex: 3,
      },
    });
  });

  it("selects complete displayed groups when item endpoints cross spaces", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "space",
      groups: [
        { key: "A-01:none", itemIds: ["a1", "a2"] },
        { key: "A-02:none", itemIds: ["b1", "b2"] },
        { key: "A-03:none", itemIds: ["c1", "c2"] },
      ],
    });

    const forward = resolveRangeSelection(
      presentation,
      itemEndpoint("a2"),
      itemEndpoint("c1"),
    );
    const reverse = resolveRangeSelection(
      presentation,
      itemEndpoint("c1"),
      itemEndpoint("a2"),
    );

    expect(forward).toEqual({
      valid: true,
      coverage: "group-span",
      itemIds: ["a1", "a2", "b1", "b2", "c1", "c2"],
      orderedGroupKeys: ["A-01:none", "A-02:none", "A-03:none"],
      start: {
        kind: "item",
        groupIndex: 0,
        itemIndex: 1,
        displayIndex: 1,
      },
      end: {
        kind: "item",
        groupIndex: 2,
        itemIndex: 0,
        displayIndex: 4,
      },
    });
    expect(reverse).toMatchObject({
      valid: true,
      coverage: "group-span",
      itemIds: ["a1", "a2", "b1", "b2", "c1", "c2"],
      orderedGroupKeys: ["A-01:none", "A-02:none", "A-03:none"],
      start: {
        kind: "item",
        groupIndex: 2,
        itemIndex: 0,
        displayIndex: 4,
      },
      end: {
        kind: "item",
        groupIndex: 0,
        itemIndex: 1,
        displayIndex: 1,
      },
    });
  });

  it("rejects cross-space item endpoints when the cards are adjacent", () => {
    const presentation = buildRangePresentation({
      scopeKey,
      grouping: "space",
      groups: [
        { key: "A-01:none", itemIds: ["a1"] },
        { key: "A-02:none", itemIds: ["b1", "b2"] },
      ],
    });

    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("a1"),
        itemEndpoint("b1"),
      ),
    ).toEqual({
      valid: false,
      reason: "adjacent",
      itemIds: [],
    });
  });
});

describe("resolveRangeSelection with group endpoints", () => {
  const spacePresentation = buildRangePresentation({
    scopeKey,
    grouping: "space",
    groups: [
      { key: "A-01:none", itemIds: ["a1", "a2"] },
      { key: "A-02:none", itemIds: ["b1"] },
      { key: "A-03:none", itemIds: ["c1", "c2"] },
    ],
  });

  it("selects complete non-adjacent displayed space groups in either direction", () => {
    const forward = resolveRangeSelection(
      spacePresentation,
      groupEndpoint("A-01:none"),
      groupEndpoint("A-03:none"),
    );
    const reverse = resolveRangeSelection(
      spacePresentation,
      groupEndpoint("A-03:none"),
      groupEndpoint("A-01:none"),
    );

    expect(forward).toEqual({
      valid: true,
      coverage: "group-span",
      itemIds: ["a1", "a2", "b1", "c1", "c2"],
      orderedGroupKeys: ["A-01:none", "A-02:none", "A-03:none"],
      start: {
        kind: "group",
        groupIndex: 0,
        itemIndex: null,
        displayIndex: null,
      },
      end: {
        kind: "group",
        groupIndex: 2,
        itemIndex: null,
        displayIndex: null,
      },
    });
    expect(reverse).toMatchObject({
      valid: true,
      coverage: "group-span",
      itemIds: ["a1", "a2", "b1", "c1", "c2"],
      orderedGroupKeys: ["A-01:none", "A-02:none", "A-03:none"],
      start: {
        kind: "group",
        groupIndex: 2,
        itemIndex: null,
        displayIndex: null,
      },
      end: {
        kind: "group",
        groupIndex: 0,
        itemIndex: null,
        displayIndex: null,
      },
    });
  });

  it("rejects adjacent displayed group headers", () => {
    expect(
      resolveRangeSelection(
        spacePresentation,
        groupEndpoint("A-01:none"),
        groupEndpoint("A-02:none"),
      ),
    ).toEqual({
      valid: false,
      reason: "adjacent",
      itemIds: [],
    });
  });

  it("rejects group endpoints in flat mode and across hall groups", () => {
    const flatPresentation = buildRangePresentation({
      scopeKey,
      grouping: "flat",
      itemIds: ["a", "b", "c"],
    });
    const hallPresentation = buildRangePresentation({
      scopeKey,
      grouping: "hall",
      groups: [
        { key: "east", itemIds: ["e1"] },
        { key: "west", itemIds: ["w1"] },
      ],
    });

    expect(
      resolveRangeSelection(
        flatPresentation,
        groupEndpoint("first"),
        groupEndpoint("third"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "group-endpoint-not-supported",
    });
    expect(
      resolveRangeSelection(
        hallPresentation,
        groupEndpoint("east"),
        groupEndpoint("west"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "cross-hall",
    });
  });
});

describe("resolveRangeSelection invalid reasons", () => {
  const presentation: RangePresentation = buildRangePresentation({
    scopeKey,
    grouping: "flat",
    itemIds: ["a", "b", "c"],
  });

  it("rejects stale scopes before reinterpreting their endpoints", () => {
    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("a", "old-scope"),
        itemEndpoint("c"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "scope-mismatch",
    });
  });

  it("reports endpoint kind mismatch and missing endpoints", () => {
    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("a"),
        groupEndpoint("group"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "endpoint-kind-mismatch",
    });
    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("missing"),
        itemEndpoint("c"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "start-not-visible",
    });
    expect(
      resolveRangeSelection(
        presentation,
        itemEndpoint("a"),
        itemEndpoint("missing"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "end-not-visible",
    });
  });

  it("rejects the same endpoint and ambiguous group keys", () => {
    expect(
      resolveRangeSelection(presentation, itemEndpoint("a"), itemEndpoint("a")),
    ).toMatchObject({
      valid: false,
      reason: "same-endpoint",
    });

    const duplicateGroupPresentation = buildRangePresentation({
      scopeKey,
      grouping: "space",
      groups: [
        { key: "duplicate", itemIds: ["a"] },
        { key: "middle", itemIds: ["b"] },
        { key: "duplicate", itemIds: ["c"] },
      ],
    });
    expect(
      resolveRangeSelection(
        duplicateGroupPresentation,
        groupEndpoint("duplicate"),
        groupEndpoint("middle"),
      ),
    ).toMatchObject({
      valid: false,
      reason: "ambiguous-group-key",
    });
  });
});

describe("toggleRangeSelection", () => {
  it("selects the whole de-duplicated range when any target is missing", () => {
    const selected = new Set(["a", "outside"]);
    const result = toggleRangeSelection(selected, ["a", "b", "b"]);

    expect(result.operation).toBe("select");
    expect([...result.selectedItemIds].sort()).toEqual(["a", "b", "outside"]);
    expect([...selected].sort()).toEqual(["a", "outside"]);
  });

  it("deselects only the range when every target is already selected", () => {
    const selected = new Set(["a", "b", "outside"]);
    const result = toggleRangeSelection(selected, ["a", "b", "a"]);

    expect(result.operation).toBe("deselect");
    expect([...result.selectedItemIds]).toEqual(["outside"]);
    expect([...selected].sort()).toEqual(["a", "b", "outside"]);
  });

  it("returns an unchanged clone for an empty target", () => {
    const selected = new Set(["outside"]);
    const result = toggleRangeSelection(selected, []);

    expect(result.operation).toBe("none");
    expect([...result.selectedItemIds]).toEqual(["outside"]);
    expect(result.selectedItemIds).not.toBe(selected);
  });
});
