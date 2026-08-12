// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../types/item";
import CellItemsPopup from "./CellItemsPopup";

const item: ShoppingItem = {
  id: "item-a-01",
  circle: "Circle A",
  eventDate: "Day1",
  block: "A",
  number: "01a",
  title: "Title A",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const renderPopup = (
  props: Partial<ComponentProps<typeof CellItemsPopup>> = {},
) => {
  const onAddToVisitList = vi.fn();
  const onBatchAddToVisitList = vi.fn();

  render(
    <CellItemsPopup
      isOpen
      onClose={vi.fn()}
      blockName="A"
      number={1}
      items={[item]}
      executeModeItemIds={new Set()}
      onAddToVisitList={onAddToVisitList}
      onRemoveFromVisitList={vi.fn()}
      onBatchAddToVisitList={onBatchAddToVisitList}
      {...props}
    />,
  );

  return { onAddToVisitList, onBatchAddToVisitList };
};

const pointerClick = (element: HTMLElement) => {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
  });
  fireEvent.pointerUp(element, {
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 0,
  });
  fireEvent.click(element, { detail: 1 });
};

describe("CellItemsPopup opening-click guard", () => {
  it("renders in a body portal at the viewport center", () => {
    renderPopup();

    const popup = screen.getByRole("dialog", {
      name: "A-1のアイテム一覧",
    });
    expect(popup).toHaveClass(
      "left-1/2",
      "top-1/2",
      "-translate-x-1/2",
      "-translate-y-1/2",
    );
    expect(popup).not.toHaveClass("left-4", "right-4");
    expect(popup.parentElement).toBe(document.body);
  });

  it("allows an immediate pointer click on an item", () => {
    const { onAddToVisitList } = renderPopup();
    const itemRow = screen
      .getByText(item.circle)
      .closest<HTMLElement>(".cursor-pointer");

    expect(itemRow).not.toBeNull();
    pointerClick(itemRow!);

    expect(onAddToVisitList).toHaveBeenCalledWith(item.id);
  });

  it("allows an immediate pointer click on a header badge", () => {
    const { onBatchAddToVisitList } = renderPopup();
    const badge = screen.getByTitle(/0\/1件追加済み/);

    pointerClick(badge);

    expect(onBatchAddToVisitList).toHaveBeenCalledWith([item.id]);
  });

  it("allows an immediate keyboard click on an item", () => {
    const { onAddToVisitList } = renderPopup();
    const itemRow = screen
      .getByText(item.circle)
      .closest<HTMLElement>(".cursor-pointer");

    expect(itemRow).not.toBeNull();
    fireEvent.click(itemRow!, { detail: 0 });

    expect(onAddToVisitList).toHaveBeenCalledWith(item.id);
  });

  it("allows an immediate legacy touch interaction on a header badge", () => {
    const { onBatchAddToVisitList } = renderPopup();
    const badge = screen.getByTitle(/0\/1件追加済み/);

    fireEvent.touchStart(badge);
    fireEvent.click(badge, { detail: 1 });

    expect(onBatchAddToVisitList).toHaveBeenCalledWith([item.id]);
  });

  it("still blocks a compatibility click from the gesture that opened it", () => {
    const { onAddToVisitList } = renderPopup();
    const itemRow = screen
      .getByText(item.circle)
      .closest<HTMLElement>(".cursor-pointer");

    expect(itemRow).not.toBeNull();
    fireEvent.click(itemRow!, { detail: 1 });

    expect(onAddToVisitList).not.toHaveBeenCalled();
  });
});
