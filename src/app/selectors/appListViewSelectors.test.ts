import { describe, expect, it } from "vitest";
import type { SortState } from "../../features/app-shell/types";
import type { ShoppingItem } from "../../types/item";
import {
  selectBaseFilteredItems,
  selectBlockOptions,
  selectCandidateColumnItems,
  selectDuplicateCircleItemIds,
  selectExecuteColumnItems,
  selectMovePlanState,
  selectSearchMatches,
  selectSortDisplayLabel,
  selectTemporaryVisibleItems,
  selectVisibleItems,
  selectVisibleSearchMatches,
} from "./appListViewSelectors";

const item = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: id,
  eventDate: "1日目",
  block: "A",
  number: "01a",
  title: "",
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

const sortLabels: Record<SortState, string> = {
  Manual: "巡回順",
  Postpone: "後回し",
  Late: "遅参",
  Absent: "欠席",
  SoldOut: "売切",
  None: "未購入",
  Purchased: "購入済",
  LimitedPurchase: "限数",
};

describe("appListViewSelectors", () => {
  it("keeps execute order while applying status and temporary-visibility filters", () => {
    const none = item("none");
    const purchased = item("purchased", { purchaseStatus: "Purchased" });
    const late = item("late", { purchaseStatus: "Late" });
    const input = {
      activeEventName: "event",
      activeEventDate: "1日目",
      executeModeItems: {
        event: { "1日目": ["missing", "late", "purchased", "none"] },
      },
      items: [none, purchased, late],
    };
    const executeColumnItems = selectExecuteColumnItems(input);
    expect(executeColumnItems.map(({ id }) => id)).toEqual([
      "late",
      "purchased",
      "none",
    ]);

    const baseFilteredItems = selectBaseFilteredItems({
      activeEventName: "event",
      activeEventDate: "1日目",
      currentTabItems: input.items,
      dayModes: { event: { "1日目": "execute" } },
      executeColumnItems,
      sortState: "Purchased",
    });
    const temporaryVisibleItems = selectTemporaryVisibleItems({
      activeEventName: "event",
      activeEventDate: "1日目",
      dayModes: { event: { "1日目": "execute" } },
      executeColumnItems,
      baseFilteredItems,
      recentlyChangedItemIds: new Set(["late"]),
      sortState: "Purchased",
    });
    const visible = selectVisibleItems({
      activeEventName: "event",
      activeEventDate: "1日目",
      currentTabItems: input.items,
      dayModes: { event: { "1日目": "execute" } },
      executeColumnItems,
      baseFilteredItems,
      temporaryVisibleItems,
      sortState: "Purchased",
    });

    expect(baseFilteredItems.map(({ id }) => id)).toEqual(["purchased"]);
    expect(temporaryVisibleItems.map(({ id }) => id)).toEqual(["late"]);
    expect([...visible.visibleItemIds]).toEqual(["purchased", "late"]);
    expect(visible.visibleItems.map(({ id }) => id)).toEqual([
      "late",
      "purchased",
    ]);

    const editItems = [none, purchased];
    expect(
      selectBaseFilteredItems({
        activeEventName: "event",
        activeEventDate: "1日目",
        currentTabItems: editItems,
        dayModes: { event: { "1日目": "edit" } },
        executeColumnItems,
        sortState: "Manual",
      }),
    ).toBe(editItems);
  });

  it("builds the exact limited-purchase label details", () => {
    expect(
      selectSortDisplayLabel({
        sortState: "LimitedPurchase",
        sortLabels,
        baseFilteredItems: [
          item("missing", {
            purchaseStatus: "LimitedPurchase",
            quantity: 2,
          }),
          item("complete", {
            purchaseStatus: "LimitedPurchase",
            quantity: 3,
            limitedPurchasedQuantity: 1,
          }),
        ],
        temporaryVisibleCount: 2,
      }),
    ).toBe("限数 2件（未入力1・一時表示2）");
  });

  it("derives search and duplicate-circle results only on an event-date tab", () => {
    const items = [
      item("one", { circle: " Circle ", title: "Target" }),
      item("two", { circle: "Circle", remarks: "target note" }),
      item("three", { circle: "Other" }),
    ];
    const searchInput = {
      searchKeyword: " TARGET ",
      activeEventName: "event",
      activeTab: "1日目",
      eventDates: ["1日目"],
      currentTabItems: items,
    } as const;
    expect(selectSearchMatches(searchInput)).toEqual(["one", "two"]);
    expect([
      ...selectDuplicateCircleItemIds({
        activeEventName: "event",
        activeTab: "1日目",
        eventDates: ["1日目"],
        currentTabItems: items,
      }),
    ]).toEqual(["one", "two"]);
    expect(
      selectSearchMatches({ ...searchInput, activeTab: "eventList" }),
    ).toEqual([]);
  });

  it("derives candidate sorting, block options, and visible search matches", () => {
    const execute = item("execute", { block: "1" });
    const sourceFirst = item("source-first", {
      block: "10",
      number: "2",
      remarks: "優先",
    });
    const sortedFirst = item("sorted-first", {
      block: "2",
      number: "1",
      remarks: "委託無",
    });
    const currentTabItems = [execute, sourceFirst, sortedFirst];
    const base = {
      activeEventName: "event",
      activeEventDate: "1日目",
      executeModeItems: { event: { "1日目": ["execute"] } },
      currentTabItems,
      selectedBlockFilters: new Set<string>(),
    } as const;

    const sorted = selectCandidateColumnItems({
      ...base,
      candidateNumberSortDirection: null,
    });
    const sourceOrder = selectCandidateColumnItems({
      ...base,
      candidateNumberSortDirection: "asc",
    });
    expect(sorted.map(({ id }) => id)).toEqual([
      "sorted-first",
      "source-first",
    ]);
    expect(sourceOrder.map(({ id }) => id)).toEqual([
      "source-first",
      "sorted-first",
    ]);

    const blocks = selectBlockOptions(base);
    expect(blocks.availableBlocks).toEqual(["2", "10"]);
    expect(blocks.allBlocksForHallDefinition).toEqual(["1", "2", "10"]);
    expect([...blocks.blocksWithPriorityRemarks]).toEqual(["10", "2"]);
    expect(
      selectVisibleSearchMatches({
        searchMatches: ["execute", "source-first", "not-visible"],
        activeEventName: "event",
        activeEventDate: "1日目",
        dayModes: { event: { "1日目": "edit" } },
        visibleItems: [],
        executeColumnItems: [execute],
        candidateColumnItems: sorted,
      }),
    ).toEqual(["execute", "source-first"]);
  });

  it("builds same-visit move plans and only exposes one directional action", () => {
    const selected = item("selected", { block: "A", number: "01a" });
    const sibling = item("sibling", { block: "A", number: "01a2" });
    const execute = item("execute", { block: "B", number: "02a" });
    const selection = selectMovePlanState({
      activeEventName: "event",
      activeEventDate: "1日目",
      currentMode: "edit",
      executeModeItems: { event: { "1日目": ["execute"] } },
      items: [selected, sibling, execute],
      selectedItemIds: new Set(["selected"]),
    });

    expect(selection.currentExecuteOrderedIds).toEqual(["execute"]);
    expect(selection.candidateSourceOrderedIds).toEqual([
      "selected",
      "sibling",
    ]);
    expect(selection.candidateMovePlan).toMatchObject({
      requested: ["selected"],
      effective: ["selected", "sibling"],
      implicit: ["sibling"],
    });
    expect(selection.executeMovePlan.requested).toEqual([]);
    expect(selection.hasCandidateSelection).toBe(true);
    expect(selection.hasExecuteSelection).toBe(false);
    expect(selection.showMoveButtons).toBe(true);
  });
});
