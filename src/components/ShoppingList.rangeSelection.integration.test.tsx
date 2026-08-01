import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import { useListInteractionState } from "../features/lists/hooks/useListInteractionState";
import ShoppingList from "./ShoppingList";

const makeItem = (id: string, number: string): ShoppingItem => ({
  id,
  circle: `Circle ${id}`,
  eventDate: "Day1",
  block: "A",
  number,
  title: `Title ${id}`,
  price: 100,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  priorityLevel: "none",
});

const items = [
  makeItem("first", "01"),
  makeItem("middle-a", "02"),
  makeItem("middle-b", "03"),
  makeItem("last", "04"),
];

const RangeHarness = () => {
  const rangeState = useListInteractionState();

  return (
    <ShoppingList
      items={items}
      onUpdateItem={vi.fn()}
      onMoveItem={vi.fn()}
      onEditRequest={vi.fn()}
      onDeleteRequest={vi.fn()}
      selectedItemIds={rangeState.selectedItemIds}
      onSelectItem={(_itemId, _columnType, presentation) =>
        rangeState.selectItemForRange(_itemId, presentation)
      }
      columnType="candidate"
      currentDay="Day1"
      rangeStart={rangeState.rangeStart}
      rangeEnd={rangeState.rangeEnd}
      onToggleRangeSelection={rangeState.toggleRangeItemIdsSelection}
      onSelectSpaceGroupForRange={rangeState.selectSpaceGroupForRange}
      layoutMode="pc"
      viewMode="edit"
      skipLimitedPurchaseForSingleQuantity
    />
  );
};

const groupedItems = [
  { ...makeItem("priority", "01a"), priorityLevel: "priority" as const },
  { ...makeItem("highest", "01a2"), priorityLevel: "highest" as const },
  {
    ...makeItem("ordinary", "02"),
    block: "B",
    priorityLevel: "none" as const,
  },
];

const SpaceRangeHarness = () => {
  const rangeState = useListInteractionState();

  return (
    <ShoppingList
      items={groupedItems}
      onUpdateItem={vi.fn()}
      onMoveItem={vi.fn()}
      onEditRequest={vi.fn()}
      onDeleteRequest={vi.fn()}
      selectedItemIds={rangeState.selectedItemIds}
      onSelectItem={(itemId, _columnType, presentation) =>
        rangeState.selectItemForRange(itemId, presentation)
      }
      columnType="execute"
      currentDay="Day1"
      rangeStart={rangeState.rangeStart}
      rangeEnd={rangeState.rangeEnd}
      onToggleRangeSelection={rangeState.toggleRangeItemIdsSelection}
      onSelectSpaceGroupForRange={rangeState.selectSpaceGroupForRange}
      showSpaceGroups
      collapsedSpaces={new Set(["A-01a:priority", "A-01a:highest", "B-02"])}
      layoutMode="pc"
      viewMode="edit"
      skipLimitedPurchaseForSingleQuantity
    />
  );
};

describe("ShoppingList range selection integration", () => {
  it("uses the same rendered range for the chain and the actual check state", () => {
    render(<RangeHarness />);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select item Circle first - Title first",
      }),
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select item Circle last - Title last",
      }),
    );

    fireEvent.click(screen.getAllByTitle("範囲内のチェックを入れる")[0]);

    for (const item of items) {
      expect(
        screen.getByRole("checkbox", {
          name: `Select item ${item.circle} - ${item.title}`,
        }),
      ).toBeChecked();
    }

    fireEvent.click(screen.getAllByTitle("範囲内のチェックを外す")[0]);

    for (const item of items) {
      expect(
        screen.getByRole("checkbox", {
          name: `Select item ${item.circle} - ${item.title}`,
        }),
      ).not.toBeChecked();
    }
  });

  it("keeps priority-separated display groups distinct and selects the displayed group span", () => {
    const view = render(<SpaceRangeHarness />);
    const groupElements = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-space-group-key]"),
    );
    const groupKeys = groupElements.map(
      (element) => element.dataset.spaceGroupKey,
    );

    expect(groupElements).toHaveLength(3);
    expect(groupKeys).toContain("A-01a:priority");
    expect(groupKeys).toContain("A-01a:highest");

    const firstCheckbox = groupElements[0].querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const lastCheckbox = groupElements[2].querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(firstCheckbox).not.toBeNull();
    expect(lastCheckbox).not.toBeNull();

    fireEvent.click(firstCheckbox!);
    fireEvent.click(lastCheckbox!);
    fireEvent.click(screen.getAllByTitle("範囲内のチェックを入れる")[0]);

    for (const groupElement of groupElements) {
      expect(
        groupElement.querySelector<HTMLInputElement>('input[type="checkbox"]'),
      ).toBeChecked();
    }
  });
});
