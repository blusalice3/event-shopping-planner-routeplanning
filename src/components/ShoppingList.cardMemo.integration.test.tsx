import React from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";

type MockShoppingItemCardProps = {
  item: ShoppingItem;
  getLatestItemById?: (itemId: string) => ShoppingItem | undefined;
  onDeleteRequest: (item: ShoppingItem) => void;
  onEditRequest: (item: ShoppingItem) => void;
  onMoveDown?: (itemId: string) => void;
  onMoveUp?: (itemId: string) => void;
  onPostEventDistributionCheckRequest?: (item: ShoppingItem) => void;
  onSelectItem: (itemId: string) => void;
  onUpdate: (item: ShoppingItem) => void;
};

const { cardRenderSpy } = vi.hoisted(() => ({
  cardRenderSpy: vi.fn(),
}));

vi.mock("./ShoppingItemCard", async () => {
  const ReactModule = await import("react");
  const MockShoppingItemCard = ReactModule.memo(
    (props: MockShoppingItemCardProps) => {
      cardRenderSpy(props);
      return ReactModule.createElement("div", {
        "data-mock-shopping-item-card": props.item.id,
      });
    },
  );
  MockShoppingItemCard.displayName = "MockShoppingItemCard";
  return { default: MockShoppingItemCard };
});

import ShoppingList from "./ShoppingList";

type ShoppingListProps = React.ComponentProps<typeof ShoppingList>;

const item = (index: number): ShoppingItem => ({
  id: `item-${index}`,
  circle: `サークル${index}`,
  eventDate: "1日目",
  block: "東A",
  number: String(index),
  title: `新刊${index}`,
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

const findRenderedCardProps = (
  itemId: string,
): MockShoppingItemCardProps | undefined =>
  cardRenderSpy.mock.calls
    .map(([props]) => props as MockShoppingItemCardProps)
    .find((props) => props.item.id === itemId);

describe("ShoppingList item card memoization", () => {
  beforeEach(() => {
    cardRenderSpy.mockReset();
  });

  it("rerenders only the changed card while stable callbacks read the latest values", () => {
    const initialItems = [item(1), item(2), item(3)];
    const selectedItemIds = new Set<string>();
    const duplicateCircleItemIds = new Set<string>();
    const onUpdateItem = vi.fn<ShoppingListProps["onUpdateItem"]>();
    const onEditRequest = vi.fn<ShoppingListProps["onEditRequest"]>();
    const onDeleteRequest = vi.fn<ShoppingListProps["onDeleteRequest"]>();
    const onSelectItem = vi.fn<ShoppingListProps["onSelectItem"]>();
    const onMoveItemUp =
      vi.fn<NonNullable<ShoppingListProps["onMoveItemUp"]>>();
    const onMoveItemDown =
      vi.fn<NonNullable<ShoppingListProps["onMoveItemDown"]>>();
    const baseProps = {
      onUpdateItem,
      onMoveItem: vi.fn<ShoppingListProps["onMoveItem"]>(),
      onEditRequest,
      onDeleteRequest,
      selectedItemIds,
      onSelectItem,
      onMoveItemUp,
      onMoveItemDown,
      duplicateCircleItemIds,
      columnType: "execute",
      viewMode: "execute",
      forceFullListRenderer: true,
      skipLimitedPurchaseForSingleQuantity: false,
    } satisfies Omit<ShoppingListProps, "items">;

    const view = render(<ShoppingList {...baseProps} items={initialItems} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(initialItems.length);
    const initialChangedCardProps = findRenderedCardProps("item-2");
    expect(initialChangedCardProps).toBeDefined();

    cardRenderSpy.mockClear();
    const updatedItems = initialItems.map((currentItem) =>
      currentItem.id === "item-2"
        ? { ...currentItem, title: "更新された新刊" }
        : currentItem,
    );
    view.rerender(<ShoppingList {...baseProps} items={updatedItems} />);

    expect(cardRenderSpy).toHaveBeenCalledTimes(1);
    const updatedChangedCardProps = findRenderedCardProps("item-2");
    expect(updatedChangedCardProps).toBeDefined();
    expect(updatedChangedCardProps?.onSelectItem).toBe(
      initialChangedCardProps?.onSelectItem,
    );
    expect(updatedChangedCardProps?.onUpdate).toBe(
      initialChangedCardProps?.onUpdate,
    );
    expect(updatedChangedCardProps?.onEditRequest).toBe(
      initialChangedCardProps?.onEditRequest,
    );
    expect(updatedChangedCardProps?.onDeleteRequest).toBe(
      initialChangedCardProps?.onDeleteRequest,
    );
    expect(updatedChangedCardProps?.onMoveUp).toBe(
      initialChangedCardProps?.onMoveUp,
    );
    expect(updatedChangedCardProps?.onMoveDown).toBe(
      initialChangedCardProps?.onMoveDown,
    );
    expect(updatedChangedCardProps?.getLatestItemById).toBe(
      initialChangedCardProps?.getLatestItemById,
    );
    expect(updatedChangedCardProps?.onPostEventDistributionCheckRequest).toBe(
      initialChangedCardProps?.onPostEventDistributionCheckRequest,
    );
    expect(initialChangedCardProps?.getLatestItemById?.("item-2")).toBe(
      updatedItems[1],
    );

    const latestOnSelectItem = vi.fn<ShoppingListProps["onSelectItem"]>();
    const latestOnUpdateItem = vi.fn<ShoppingListProps["onUpdateItem"]>();
    const latestOnEditRequest = vi.fn<ShoppingListProps["onEditRequest"]>();
    const latestOnDeleteRequest = vi.fn<ShoppingListProps["onDeleteRequest"]>();
    const latestOnMoveItemUp =
      vi.fn<NonNullable<ShoppingListProps["onMoveItemUp"]>>();
    const latestOnMoveItemDown =
      vi.fn<NonNullable<ShoppingListProps["onMoveItemDown"]>>();
    cardRenderSpy.mockClear();
    view.rerender(
      <ShoppingList
        {...baseProps}
        items={updatedItems}
        onUpdateItem={latestOnUpdateItem}
        onEditRequest={latestOnEditRequest}
        onDeleteRequest={latestOnDeleteRequest}
        onSelectItem={latestOnSelectItem}
        onMoveItemUp={latestOnMoveItemUp}
        onMoveItemDown={latestOnMoveItemDown}
      />,
    );

    expect(cardRenderSpy).not.toHaveBeenCalled();
    act(() => {
      initialChangedCardProps?.onUpdate(updatedItems[1]);
      initialChangedCardProps?.onEditRequest(updatedItems[1]);
      initialChangedCardProps?.onDeleteRequest(updatedItems[1]);
      initialChangedCardProps?.onSelectItem("item-2");
      initialChangedCardProps?.onMoveUp?.("item-2");
      initialChangedCardProps?.onMoveDown?.("item-2");
    });
    expect(latestOnSelectItem).toHaveBeenCalledWith(
      "item-2",
      "execute",
      expect.objectContaining({ grouping: "flat" }),
    );
    expect(latestOnUpdateItem).toHaveBeenCalledWith(updatedItems[1]);
    expect(latestOnEditRequest).toHaveBeenCalledWith(updatedItems[1]);
    expect(latestOnDeleteRequest).toHaveBeenCalledWith(updatedItems[1]);
    expect(latestOnMoveItemUp).toHaveBeenCalledWith("item-2", "execute");
    expect(latestOnMoveItemDown).toHaveBeenCalledWith("item-2", "execute");
    expect(onSelectItem).not.toHaveBeenCalled();
    expect(onUpdateItem).not.toHaveBeenCalled();
    expect(onEditRequest).not.toHaveBeenCalled();
    expect(onDeleteRequest).not.toHaveBeenCalled();
    expect(onMoveItemUp).not.toHaveBeenCalled();
    expect(onMoveItemDown).not.toHaveBeenCalled();
  });

  it("keeps committed callback targets when a concurrent render is abandoned", () => {
    const currentItem = item(1);
    const initialUpdate = vi.fn<ShoppingListProps["onUpdateItem"]>();
    const initialSelect = vi.fn<ShoppingListProps["onSelectItem"]>();
    const pendingUpdate = vi.fn<ShoppingListProps["onUpdateItem"]>();
    const pendingSelect = vi.fn<ShoppingListProps["onSelectItem"]>();
    const suspended = new Promise<void>(() => undefined);
    const SuspendAfterList = ({ active }: { active: boolean }) => {
      if (active) throw suspended;
      return null;
    };
    const renderTree = (
      active: boolean,
      onUpdateItem: ShoppingListProps["onUpdateItem"],
      onSelectItem: ShoppingListProps["onSelectItem"],
    ) => (
      <React.Suspense fallback={<div>pending render</div>}>
        <ShoppingList
          items={[currentItem]}
          onUpdateItem={onUpdateItem}
          onMoveItem={vi.fn<ShoppingListProps["onMoveItem"]>()}
          onEditRequest={vi.fn<ShoppingListProps["onEditRequest"]>()}
          onDeleteRequest={vi.fn<ShoppingListProps["onDeleteRequest"]>()}
          selectedItemIds={new Set<string>()}
          onSelectItem={onSelectItem}
          columnType="execute"
          viewMode="execute"
          forceFullListRenderer
          skipLimitedPurchaseForSingleQuantity={false}
        />
        <SuspendAfterList active={active} />
      </React.Suspense>
    );

    const view = render(renderTree(false, initialUpdate, initialSelect));
    const committedCardProps = findRenderedCardProps(currentItem.id);
    expect(committedCardProps).toBeDefined();

    view.rerender(renderTree(true, pendingUpdate, pendingSelect));

    act(() => {
      committedCardProps?.onUpdate(currentItem);
      committedCardProps?.onSelectItem(currentItem.id);
    });
    expect(initialUpdate).toHaveBeenCalledWith(currentItem);
    expect(initialSelect).toHaveBeenCalledWith(
      currentItem.id,
      "execute",
      expect.objectContaining({ grouping: "flat" }),
    );
    expect(pendingUpdate).not.toHaveBeenCalled();
    expect(pendingSelect).not.toHaveBeenCalled();
  });
});
