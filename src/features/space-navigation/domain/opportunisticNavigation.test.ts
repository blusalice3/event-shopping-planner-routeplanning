import { describe, expect, it } from "vitest";
import type {
  NavigatorEntry,
  NavigatorItem,
  NavigatorPhase,
  NavigatorPriority,
} from "../types";
import {
  aggregateNavigatorSpace,
  buildInitialPhaseNavigationCandidates,
  buildRemainingSpaceLists,
  findAdjacentSpaceTarget,
  groupCellItemsBySpace,
} from "./opportunisticNavigation";
import {
  buildSpaceKey,
  normalizeBaseSpaceNumber,
  normalizeSpaceBlock,
} from "./visitIdentity";

const emptyStatusCounts = {
  unvisited: 0,
  postponed: 0,
  late: 0,
  limited: 0,
  completed: 0,
};

function item(
  id: string,
  block: string,
  number: string,
  purchaseStatus: NavigatorItem["purchaseStatus"] = "None",
  circle = `circle-${id}`,
): NavigatorItem {
  return {
    id,
    block,
    number,
    circle,
    purchaseStatus,
    price: 100,
    quantity: 1,
    priorityLevel: "none",
  };
}

function entry({
  id,
  phase,
  block,
  number,
  items,
  itemIds = items.map((candidate) => candidate.id),
  priorityLevel = "none",
  phaseIndex = 0,
}: {
  id: string;
  phase: NavigatorPhase;
  block: string;
  number: string;
  items: NavigatorItem[];
  itemIds?: string[];
  priorityLevel?: NavigatorPriority;
  phaseIndex?: number;
}): NavigatorEntry {
  const normalizedBlock = normalizeSpaceBlock(block);
  const normalizedNumber = normalizeBaseSpaceNumber(number);
  return {
    id,
    phase,
    block: normalizedBlock,
    number: normalizedNumber,
    spaceKey: buildSpaceKey(block, number),
    priorityLevel,
    index: 0,
    phaseIndex,
    label: `${normalizedBlock}-${normalizedNumber}`,
    circles: items.map((candidate) => candidate.circle),
    itemIds,
    items,
    statusCounts: { ...emptyStatusCounts },
    statusSegments: [],
    warningKinds: [],
  };
}

function liveMap(items: readonly NavigatorItem[]) {
  return new Map(items.map((candidate) => [candidate.id, candidate]));
}

describe("groupCellItemsBySpace", () => {
  it("groups normalized aliases, deduplicates IDs, preserves first display notation, and sorts naturally", () => {
    const fullWidthA = item("a-1", "Ｙ", "１２Ａ１");
    const groups = groupCellItemsBySpace([
      item("b", "Y", "12b"),
      fullWidthA,
      { ...fullWidthA, circle: "duplicate must not replace first" },
      item("base", "Y", "12"),
      item("a-2", "Y", "12a2"),
    ]);

    expect(groups.map((group) => group.spaceKey)).toEqual([
      "Y-12",
      "Y-12a",
      "Y-12b",
    ]);
    expect(groups[1]).toMatchObject({
      normalizedBlock: "Y",
      normalizedNumber: "12a",
      displayBlock: "Ｙ",
      displayNumber: "１２Ａ",
      displayLabel: "Ｙ-１２Ａ",
      itemIds: ["a-1", "a-2"],
    });
    expect(groups[1].items[0]).toBe(fullWidthA);
  });

  it("uses first-valid-input wins for duplicate IDs and safely ignores empty identities", () => {
    const groups = groupCellItemsBySpace([
      item("", "A", "12a"),
      item("blank-block", " ", "12a"),
      item("blank-number", "A", " "),
      item("same", "A", "12a1"),
      item("same", "A", "12b"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      spaceKey: "A-12a",
      displayNumber: "12a",
      itemIds: ["same"],
    });
  });

  it("returns an empty list for an empty cell", () => {
    expect(groupCellItemsBySpace([])).toEqual([]);
  });
});

describe("aggregateNavigatorSpace", () => {
  it("aggregates every phase and priority with first-route representatives and unique live item IDs", () => {
    const shared = item("shared", "A", "12a1");
    const highest = item("highest", "A", "12A2");
    const normal = item("normal", "A", "12a");
    const postponed = item("postponed", "A", "12a", "Postpone");
    const other = item("other", "B", "20");
    const entries = [
      entry({
        id: "normal:A-12a:highest",
        phase: "normal",
        block: "A",
        number: "12a",
        items: [shared, highest],
        priorityLevel: "highest",
      }),
      entry({
        id: "normal:A-12a:none",
        phase: "normal",
        block: "A",
        number: "12a",
        items: [shared, normal],
      }),
      entry({
        id: "postponed:A-12a:none",
        phase: "postponed",
        block: "A",
        number: "12a",
        items: [shared, postponed],
      }),
      entry({
        id: "normal:B-20:none",
        phase: "normal",
        block: "B",
        number: "20",
        items: [other],
      }),
    ];

    const aggregate = aggregateNavigatorSpace(entries, "A-12a", {
      latestItemsById: liveMap([shared, highest, normal, postponed, other]),
    });

    expect(aggregate).toMatchObject({
      representativeVisitId: "normal:A-12a:highest",
      visitIds: [
        "normal:A-12a:highest",
        "normal:A-12a:none",
        "postponed:A-12a:none",
      ],
      phases: ["normal", "postponed"],
      itemIds: ["shared", "highest", "normal", "postponed"],
    });
  });

  it("omits invalid visits, deleted item IDs, and items moved to another space", () => {
    const live = item("live", "A", "12a");
    const moved = item("moved", "B", "12a");
    const entries = [
      entry({
        id: "",
        phase: "normal",
        block: "A",
        number: "12a",
        items: [item("invalid-visit-item", "A", "12a")],
      }),
      entry({
        id: "normal:A-12a:none",
        phase: "normal",
        block: "A",
        number: "12a",
        items: [live, item("deleted", "A", "12a"), moved],
        itemIds: ["live", "deleted", "moved", "missing"],
      }),
    ];

    expect(
      aggregateNavigatorSpace(entries, "A-12a", {
        latestItemsById: liveMap([live, moved]),
      }),
    ).toMatchObject({
      representativeVisitId: "normal:A-12a:none",
      itemIds: ["live"],
    });
    expect(aggregateNavigatorSpace(entries, "missing")).toBeNull();
    expect(aggregateNavigatorSpace([], "A-12a")).toBeNull();
  });
});

describe("findAdjacentSpaceTarget", () => {
  const normalAHighest = item("normal-a-highest", "A", "01");
  const normalANone = item("normal-a-none", "A", "01");
  const normalB = item("normal-b", "B", "02");
  const normalC = item("normal-c", "C", "03");
  const postponedXHighest = item("postponed-x-highest", "P", "01");
  const postponedXNone = item("postponed-x-none", "P", "01");
  const postponedY = item("postponed-y", "P", "02");
  const lateZ = item("late-z", "L", "01");
  const lateW = item("late-w", "L", "02");
  const routeEntries = [
    entry({
      id: "normal:A-01:highest",
      phase: "normal",
      block: "A",
      number: "01",
      items: [normalAHighest],
      priorityLevel: "highest",
      phaseIndex: 0,
    }),
    entry({
      id: "normal:A-01:none",
      phase: "normal",
      block: "A",
      number: "01",
      items: [normalANone],
      phaseIndex: 1,
    }),
    entry({
      id: "normal:B-02:none",
      phase: "normal",
      block: "B",
      number: "02",
      items: [normalB],
      phaseIndex: 2,
    }),
    entry({
      id: "normal:C-03:none",
      phase: "normal",
      block: "C",
      number: "03",
      items: [normalC],
      phaseIndex: 3,
    }),
    entry({
      id: "postponed:P-01:highest",
      phase: "postponed",
      block: "P",
      number: "01",
      items: [postponedXHighest],
      priorityLevel: "highest",
      phaseIndex: 0,
    }),
    entry({
      id: "postponed:P-01:none",
      phase: "postponed",
      block: "P",
      number: "01",
      items: [postponedXNone],
      phaseIndex: 1,
    }),
    entry({
      id: "postponed:P-02:none",
      phase: "postponed",
      block: "P",
      number: "02",
      items: [postponedY],
      phaseIndex: 2,
    }),
    entry({
      id: "late:L-01:none",
      phase: "late",
      block: "L",
      number: "01",
      items: [lateZ],
      phaseIndex: 0,
    }),
    entry({
      id: "late:L-02:none",
      phase: "late",
      block: "L",
      number: "02",
      items: [lateW],
      phaseIndex: 1,
    }),
  ];

  it("uses the earliest matching visit and skips priority duplicates", () => {
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "A-01",
        phase: "normal",
        direction: "next",
      }),
    ).toMatchObject({
      representativeVisitId: "normal:B-02:none",
      spaceKey: "B-02",
      phase: "normal",
    });
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "B-02",
        phase: "normal",
        direction: "previous",
      }),
    ).toMatchObject({
      representativeVisitId: "normal:A-01:highest",
      spaceKey: "A-01",
    });
  });

  it("crosses only backward boundaries and falls through an empty postponed phase", () => {
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "P-01",
        phase: "postponed",
        direction: "previous",
      }),
    ).toMatchObject({ spaceKey: "C-03", phase: "normal" });
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "L-01",
        phase: "late",
        direction: "previous",
      }),
    ).toMatchObject({ spaceKey: "P-02", phase: "postponed" });

    const withoutPostponed = routeEntries.filter(
      (candidate) => candidate.phase !== "postponed",
    );
    expect(
      findAdjacentSpaceTarget(withoutPostponed, {
        currentSpaceKey: "L-01",
        phase: "late",
        direction: "previous",
      }),
    ).toMatchObject({ spaceKey: "C-03", phase: "normal" });
  });

  it("returns null at forward ends, the normal backward start, and absent phases", () => {
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "C-03",
        phase: "normal",
        direction: "next",
      }),
    ).toBeNull();
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "A-01",
        phase: "normal",
        direction: "previous",
      }),
    ).toBeNull();
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "A-01",
        phase: "late",
        direction: "next",
      }),
    ).toBeNull();
  });

  it("skips candidates whose only item ID was deleted from the live map", () => {
    const liveItems = [
      normalAHighest,
      normalANone,
      normalC,
      postponedXHighest,
      postponedXNone,
      postponedY,
      lateZ,
      lateW,
    ];
    expect(
      findAdjacentSpaceTarget(routeEntries, {
        currentSpaceKey: "A-01",
        phase: "normal",
        direction: "next",
        latestItemsById: liveMap(liveItems),
      }),
    ).toMatchObject({ spaceKey: "C-03" });
  });
});

describe("buildInitialPhaseNavigationCandidates", () => {
  it("returns actual per-phase targets and null when the current space is absent", () => {
    const entries = [
      entry({
        id: "normal:A-01:none",
        phase: "normal",
        block: "A",
        number: "01",
        items: [item("normal-current", "A", "01")],
      }),
      entry({
        id: "normal:B-02:none",
        phase: "normal",
        block: "B",
        number: "02",
        items: [item("normal-next", "B", "02")],
      }),
      entry({
        id: "postponed:A-01:none",
        phase: "postponed",
        block: "A",
        number: "01",
        items: [item("postponed-current", "A", "01", "Postpone")],
      }),
      entry({
        id: "postponed:P-02:none",
        phase: "postponed",
        block: "P",
        number: "02",
        items: [item("postponed-next", "P", "02", "Postpone")],
      }),
      entry({
        id: "late:L-01:none",
        phase: "late",
        block: "L",
        number: "01",
        items: [item("late-only", "L", "01", "Late")],
      }),
    ];

    const candidates = buildInitialPhaseNavigationCandidates(entries, {
      currentSpaceKey: "A-01",
      direction: "next",
    });
    expect(candidates.normal).toMatchObject({ spaceKey: "B-02" });
    expect(candidates.postponed).toMatchObject({ spaceKey: "P-02" });
    expect(candidates.late).toBeNull();
  });
});

describe("buildRemainingSpaceLists", () => {
  it("builds status-specific route-ordered lists and aggregates each space independently", () => {
    const normalA1 = item("normal-a-1", "A", "01", "None", "Alpha");
    const normalA2 = item("normal-a-2", "A", "01", "None", "Beta");
    const normalB = item("normal-b", "B", "02", "None", "Gamma");
    const postponedA = item("postponed-a", "A", "01", "Postpone", "Alpha");
    const postponedD = item("postponed-d", "D", "04", "Postpone", "Delta");
    const lateE = item("late-e", "E", "05", "Late", "Echo");
    const entries = [
      entry({
        id: "normal:A-01:highest",
        phase: "normal",
        block: "A",
        number: "01",
        items: [normalA1],
        priorityLevel: "highest",
      }),
      entry({
        id: "normal:A-01:none",
        phase: "normal",
        block: "A",
        number: "01",
        items: [normalA1, normalA2],
      }),
      entry({
        id: "normal:B-02:none",
        phase: "normal",
        block: "B",
        number: "02",
        items: [normalB],
      }),
      entry({
        id: "postponed:A-01:none",
        phase: "postponed",
        block: "A",
        number: "01",
        items: [postponedA],
      }),
      entry({
        id: "postponed:D-04:none",
        phase: "postponed",
        block: "D",
        number: "04",
        items: [postponedD],
      }),
      entry({
        id: "late:E-05:none",
        phase: "late",
        block: "E",
        number: "05",
        items: [lateE],
      }),
    ];

    const lists = buildRemainingSpaceLists(entries, {
      currentSpaceKey: "A-01",
    });
    expect(lists.normal.map((candidate) => candidate.spaceKey)).toEqual([
      "A-01",
      "B-02",
    ]);
    expect(lists.normal[0]).toMatchObject({
      purchaseStatus: "None",
      itemIds: ["normal-a-1", "normal-a-2"],
      circles: ["Alpha", "Beta"],
      isCurrent: true,
    });
    expect(lists.postponed.map((candidate) => candidate.spaceKey)).toEqual([
      "A-01",
      "D-04",
    ]);
    expect(lists.postponed[0]).toMatchObject({
      purchaseStatus: "Postpone",
      itemIds: ["postponed-a"],
      isCurrent: true,
    });
    expect(lists.late).toHaveLength(1);
    expect(lists.late[0]).toMatchObject({
      purchaseStatus: "Late",
      spaceKey: "E-05",
      itemIds: ["late-e"],
      isCurrent: false,
    });
  });

  it("re-resolves live status and omits deleted, completed, and invalid-ID entries", () => {
    const deleted = item("deleted", "A", "01");
    const nowCompleted = item("completed", "B", "02", "Purchased");
    const stillLate = item("late", "L", "03", "Late");
    const entries = [
      entry({
        id: "normal:A-01:none",
        phase: "normal",
        block: "A",
        number: "01",
        items: [deleted],
      }),
      entry({
        id: "normal:B-02:none",
        phase: "normal",
        block: "B",
        number: "02",
        items: [item("completed", "B", "02", "None")],
      }),
      entry({
        id: "",
        phase: "late",
        block: "X",
        number: "99",
        items: [item("invalid-visit", "X", "99", "Late")],
      }),
      entry({
        id: "late:L-03:none",
        phase: "late",
        block: "L",
        number: "03",
        items: [stillLate],
        itemIds: ["late", "missing"],
      }),
    ];

    const lists = buildRemainingSpaceLists(entries, {
      latestItemsById: liveMap([nowCompleted, stillLate]),
    });
    expect(lists.normal).toEqual([]);
    expect(lists.postponed).toEqual([]);
    expect(lists.late.map((candidate) => candidate.itemIds)).toEqual([
      ["late"],
    ]);
    expect(buildRemainingSpaceLists([])).toEqual({
      normal: [],
      postponed: [],
      late: [],
    });
  });
});
