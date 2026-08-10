// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../types/item";
import InsertPositionDialog from "./InsertPositionDialog";

const addingItem: ShoppingItem = {
  id: "adding-item",
  circle: "追加サークル",
  eventDate: "1日目",
  block: "東A",
  number: "02a",
  title: "追加アイテム",
  price: 500,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const referenceItem: ShoppingItem = {
  ...addingItem,
  id: "reference-item",
  circle: "基準サークル",
  number: "01a",
};

describe("InsertPositionDialog accessibility", () => {
  afterEach(() => {
    cleanup();
  });

  it("exposes an accurately modal named dialog and descriptive position buttons", () => {
    const onSelect = vi.fn();
    render(
      <InsertPositionDialog
        isOpen
        addingItem={addingItem}
        nearbyVisitItems={[{ item: referenceItem, visitIndex: 0 }]}
        allVisitItems={[{ item: referenceItem, visitIndex: 0 }]}
        hasHallDefinition
        onSelect={onSelect}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "追加位置を選択" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      within(dialog).getByRole("heading", {
        level: 2,
        name: "追加位置を選択",
      }),
    ).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(/東A-02a.*追加サークル/);

    const firstPosition = within(dialog).getByRole("button", {
      name: "挿入位置 A を選択",
    });
    expect(
      within(dialog).getByRole("button", { name: "挿入位置 B を選択" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "同じホールの末尾に追加" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "リスト末尾に追加" }),
    ).toBeInTheDocument();

    fireEvent.click(firstPosition);
    expect(onSelect).toHaveBeenCalledWith({
      type: "before",
      referenceItemId: referenceItem.id,
    });
  });

  it("manages focus, keyboard dismissal, and body scrolling for the modal lifecycle", () => {
    const opener = document.createElement("button");
    opener.textContent = "追加位置を開く";
    document.body.appendChild(opener);
    opener.focus();

    const onCancel = vi.fn();
    const dialogProps = {
      addingItem,
      nearbyVisitItems: [{ item: referenceItem, visitIndex: 0 }],
      allVisitItems: [{ item: referenceItem, visitIndex: 0 }],
      hasHallDefinition: true,
      onSelect: vi.fn(),
      onCancel,
    };
    const view = render(<InsertPositionDialog {...dialogProps} isOpen />);

    const dialog = screen.getByRole("dialog", { name: "追加位置を選択" });
    const firstPosition = within(dialog).getByRole("button", {
      name: "挿入位置 A を選択",
    });
    const cancelButton = within(dialog).getByRole("button", {
      name: "キャンセル",
    });

    expect(firstPosition).toHaveFocus();
    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
      "esp-body-touch-lock",
    );

    cancelButton.focus();
    fireEvent.keyDown(cancelButton, { key: "Tab" });
    expect(firstPosition).toHaveFocus();

    firstPosition.focus();
    fireEvent.keyDown(firstPosition, { key: "Tab", shiftKey: true });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(cancelButton, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);

    view.rerender(<InsertPositionDialog {...dialogProps} isOpen={false} />);
    expect(document.body).not.toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
      "esp-body-touch-lock",
    );
    expect(opener).toHaveFocus();

    opener.remove();
  });
});
