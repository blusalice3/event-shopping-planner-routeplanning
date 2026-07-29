// @vitest-environment jsdom

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import { acquireBodyScrollLock } from "../utils/bodyScrollLock";
import ShoppingList from "./ShoppingList";

const item: ShoppingItem = {
  id: "touch-item",
  circle: "タッチ確認",
  eventDate: "Day1",
  block: "A",
  number: "01a",
  title: "長押し対象",
  price: 500,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  priorityLevel: "none",
};

describe("ShoppingList touch drag cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.style.overflow = "";
    document.body.style.overscrollBehavior = "";
  });

  it("fully releases its drag resources without unlocking another body-scroll owner", () => {
    vi.useFakeTimers();
    document.body.style.overflow = "auto";
    const releaseNavigatorLock = acquireBodyScrollLock({
      lockOverscroll: true,
    });
    const view = render(
      <ShoppingList
        items={[item]}
        onUpdateItem={vi.fn()}
        onMoveItem={vi.fn()}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        selectedItemIds={new Set()}
        onSelectItem={vi.fn()}
        columnType="candidate"
        currentDay="Day1"
        layoutMode="smartphone"
        viewMode="edit"
        skipLimitedPurchaseForSingleQuantity
      />,
    );
    const source = view.container.querySelector<HTMLElement>(
      '[data-item-id="touch-item"]',
    );
    expect(source).not.toBeNull();

    fireEvent.touchStart(source!, {
      touches: [{ clientX: 80, clientY: 160 }],
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(source).toHaveClass("opacity-40");
    expect(source).toHaveAttribute("draggable", "false");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("none");

    view.unmount();

    expect(source).not.toHaveClass("opacity-40");
    expect(source).toHaveAttribute("draggable", "true");
    expect(document.body.style.overflow).toBe("hidden");
    expect(document.body.style.overscrollBehavior).toBe("none");
    expect(
      Array.from(document.body.children).some(
        (element) => (element as HTMLElement).style.zIndex === "9999",
      ),
    ).toBe(false);

    releaseNavigatorLock();
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehavior).toBe("");
  });
});
