// @vitest-environment jsdom

import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import VisitListPanel from "./VisitListPanel";

const item: ShoppingItem = {
  id: "touch-cancel-item",
  eventDate: "Day1",
  block: "A",
  number: "01a",
  circle: "タッチキャンセル確認",
  title: "長押しドラッグ対象",
  price: 500,
  quantity: 1,
  purchaseStatus: "None",
  priorityLevel: "none",
  remarks: "補助テキスト",
  url: "",
};

describe("VisitListPanel touch drag cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.className = "";
    document.body.style.overflow = "";
    document.body.style.overscrollBehavior = "";
    document.body.style.touchAction = "";
  });

  it("releases the body lock and clears drag UI after touchcancel", () => {
    vi.useFakeTimers();
    document.body.style.overflow = "auto";
    document.body.style.touchAction = "pan-y";

    const view = render(
      <VisitListPanel
        isOpen
        onClose={vi.fn()}
        items={[item]}
        onUpdateOrder={vi.fn()}
        mapData={null}
        hallDefinitions={[]}
        hallOrder={[]}
        layoutMode="smartphone"
        onHighlightCell={vi.fn()}
        onClearHighlight={vi.fn()}
        hasUnsavedChanges={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const source =
      view.container.querySelector<HTMLElement>("[data-drag-item]");
    expect(source).not.toBeNull();
    expect(view.getByRole("dialog", { name: "訪問先リスト" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(
      view.getByRole("heading", { level: 2, name: "訪問先リスト" }),
    ).toBeInTheDocument();
    expect(view.getByText("1件", { selector: "span" })).toHaveClass(
      "text-slate-800",
      "dark:text-slate-100",
    );
    expect(view.getByText("長押しドラッグ対象")).toHaveClass(
      "text-slate-700",
      "dark:text-slate-300",
    );
    expect(view.getByText("補助テキスト")).toHaveClass(
      "text-orange-800",
      "dark:text-orange-300",
    );

    fireEvent.touchStart(source!, {
      touches: [{ clientX: 120, clientY: 240 }],
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-touch-lock",
    );
    expect(
      view.container.querySelector(".pointer-events-none.border-blue-500"),
    ).not.toBeNull();
    expect(source).toHaveClass("opacity-50");

    fireEvent.touchCancel(source!, {
      changedTouches: [{ clientX: 120, clientY: 240 }],
    });

    expect(document.body).toHaveClass("esp-body-scroll-lock");
    expect(document.body).not.toHaveClass("esp-body-touch-lock");
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.touchAction).toBe("pan-y");
    expect(
      view.container.querySelector(".pointer-events-none.border-blue-500"),
    ).toBeNull();
    expect(source).not.toHaveClass("opacity-50");
  });

  it("contains mobile modal focus, closes on Escape, and restores the opener", () => {
    const onClose = vi.fn();
    const renderPanel = (isOpen: boolean) => (
      <>
        <button type="button">訪問先リストを開く</button>
        <VisitListPanel
          isOpen={isOpen}
          onClose={onClose}
          items={[item]}
          onUpdateOrder={vi.fn()}
          mapData={null}
          hallDefinitions={[]}
          hallOrder={[]}
          layoutMode="smartphone"
          onHighlightCell={vi.fn()}
          onClearHighlight={vi.fn()}
          hasUnsavedChanges={false}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </>
    );
    const view = render(renderPanel(false));
    const opener = view.getByRole("button", { name: "訪問先リストを開く" });
    opener.focus();
    view.rerender(renderPanel(true));

    const dialog = view.getByRole("dialog", { name: "訪問先リスト" });
    const enabledButtons = within(dialog)
      .getAllByRole("button")
      .filter((button) => !(button as HTMLButtonElement).disabled);
    const firstControl = enabledButtons[0];
    const lastControl = enabledButtons[enabledButtons.length - 1];
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(firstControl, { key: "Tab", shiftKey: true });
    expect(lastControl).toHaveFocus();
    fireEvent.keyDown(lastControl, { key: "Tab" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(renderPanel(false));
    expect(opener).toHaveFocus();
  });

  it("labels the desktop side panel as a complementary landmark with a level-two heading", () => {
    const view = render(
      <VisitListPanel
        isOpen
        onClose={vi.fn()}
        items={[item]}
        onUpdateOrder={vi.fn()}
        mapData={null}
        hallDefinitions={[]}
        hallOrder={[]}
        layoutMode="pc"
        onHighlightCell={vi.fn()}
        onClearHighlight={vi.fn()}
        hasUnsavedChanges={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const panel = view.getByRole("complementary", { name: "訪問先リスト" });
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(
      view.getByRole("heading", { level: 2, name: "訪問先リスト" }),
    ).toBeInTheDocument();
    expect(view.getByText("1件", { selector: "span" })).toHaveClass(
      "text-slate-800",
      "dark:text-slate-100",
    );
    expect(view.getByText("長押しドラッグ対象")).toHaveClass(
      "text-slate-700",
      "dark:text-slate-300",
    );
    expect(view.getByText("補助テキスト")).toHaveClass(
      "text-orange-800",
      "dark:text-orange-300",
    );
  });
});
