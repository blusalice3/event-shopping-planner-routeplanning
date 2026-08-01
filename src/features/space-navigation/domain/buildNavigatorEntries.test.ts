import { describe, expect, it } from "vitest";
import type { NavigatorItem, NavigatorSourceVisit } from "../types";
import {
  buildExecutionNavigatorEntries,
  buildFocusNavigatorEntries,
  buildNavigatorEntries,
} from "./buildNavigatorEntries";

const makeItem = (
  id: string,
  block: string,
  number: string,
  overrides: Partial<NavigatorItem> = {},
): NavigatorItem => ({
  id,
  circle: `circle-${id}`,
  block,
  number,
  purchaseStatus: "None",
  price: 100,
  quantity: 1,
  priorityLevel: "none",
  ...overrides,
});

describe("buildNavigatorEntries", () => {
  it("merges normalized aliases in first-seen route order", () => {
    const entries = buildExecutionNavigatorEntries([
      makeItem("a-1", "A", "01a2", { circle: "Alpha" }),
      makeItem("b", "B", "02", { circle: "Beta" }),
      makeItem("a-2", "Ａ", "０１Ａ", { circle: "Alpha" }),
      makeItem("a-3", "A", "01a3", { circle: "Gamma" }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual([
      "A-01a:none",
      "B-02:none",
    ]);
    expect(entries[0]).toMatchObject({
      index: 0,
      phaseIndex: 0,
      block: "A",
      number: "01a",
      spaceKey: "A-01a",
      label: "A-01a",
      circles: ["Alpha", "Gamma"],
      itemIds: ["a-1", "a-2", "a-3"],
    });
  });

  it("keeps the same space as separate priority visits", () => {
    const entries = buildExecutionNavigatorEntries([
      makeItem("highest", "A", "01", { priorityLevel: "highest" }),
      makeItem("priority", "A", "01", { priorityLevel: "priority" }),
      makeItem("normal", "A", "01", { priorityLevel: "none" }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual([
      "A-01:highest",
      "A-01:priority",
      "A-01:none",
    ]);
  });

  it("accepts pre-grouped source visits and retains their display label", () => {
    const visits: NavigatorSourceVisit[] = [
      {
        block: "A",
        number: "01",
        priorityLevel: "highest",
        label: "東ホール A-01",
        items: [
          makeItem("one", "A", "01", { purchaseStatus: "Purchased" }),
          makeItem("two", "A", "01", { purchaseStatus: "Late" }),
        ],
      },
    ];

    const [entry] = buildNavigatorEntries(visits);
    expect(entry.label).toBe("東ホール A-01");
    expect(entry.statusCounts).toMatchObject({ late: 1, completed: 1 });
    expect(entry.statusSegments.map((segment) => segment.kind)).toEqual([
      "late",
      "completed",
    ]);
  });

  it("accepts the existing FocusMode { key, items } visit shape", () => {
    const existingVisits = [
      {
        key: "legacy-route-key",
        items: [
          makeItem("highest", "A", "01a2", {
            priorityLevel: "highest",
          }),
        ],
      },
    ];

    expect(buildNavigatorEntries(existingVisits)[0]).toMatchObject({
      id: "A-01a:highest",
      block: "A",
      number: "01a",
      priorityLevel: "highest",
    });
  });

  it("concatenates raw item and grouped visit inputs by fixed focus phase order", () => {
    const shared = makeItem("normal-a", "A", "01", {
      priorityLevel: "highest",
    });
    const entries = buildFocusNavigatorEntries({
      late: [
        makeItem("late-a", "A", "01", {
          priorityLevel: "highest",
          purchaseStatus: "Late",
        }),
      ],
      normal: [shared, makeItem("normal-b", "B", "02")],
      postponed: [
        {
          block: "A",
          number: "01",
          priorityLevel: "highest",
          items: [
            makeItem("postponed-a", "A", "01", {
              priorityLevel: "highest",
              purchaseStatus: "Postpone",
            }),
          ],
        },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      "normal:A-01:highest",
      "normal:B-02:none",
      "postponed:A-01:highest",
      "late:A-01:highest",
    ]);
    expect(entries.map((entry) => entry.phase)).toEqual([
      "normal",
      "normal",
      "postponed",
      "late",
    ]);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(entries.map((entry) => entry.phaseIndex)).toEqual([0, 1, 0, 0]);
  });

  it.each([1, 100, 300])(
    "builds %i distinct visits without truncation",
    (count) => {
      const entries = buildExecutionNavigatorEntries(
        Array.from({ length: count }, (_, index) =>
          makeItem(`item-${index}`, "A", String(index + 1).padStart(3, "0")),
        ),
      );
      expect(entries).toHaveLength(count);
      expect(entries[0].index).toBe(0);
      expect(entries[count - 1].index).toBe(count - 1);
    },
  );

  it("keeps price and limited warning stripes on an entry", () => {
    const [entry] = buildExecutionNavigatorEntries([
      makeItem("price", "A", "01", {
        purchaseStatus: "Purchased",
        price: null,
      }),
      makeItem("limited", "A", "01", {
        purchaseStatus: "LimitedPurchase",
        quantity: 3,
      }),
    ]);
    expect(entry.warningKinds).toEqual(["price", "limited"]);
  });
});
