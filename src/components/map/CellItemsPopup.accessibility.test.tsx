// @vitest-environment jsdom

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../types/item";
import CellItemsPopup from "./CellItemsPopup";

const item: ShoppingItem = {
  id: "accessible-item",
  circle: "アクセシブルサークル",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊セット",
  price: 1_000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "利用者メモ",
  url: "https://example.com",
};

const renderPopup = (
  props: Partial<ComponentProps<typeof CellItemsPopup>> = {},
) =>
  render(
    <CellItemsPopup
      isOpen
      onClose={vi.fn()}
      blockName="東A"
      number={1}
      items={[item]}
      executeModeItemIds={new Set()}
      onAddToVisitList={vi.fn()}
      onRemoveFromVisitList={vi.fn()}
      eventDate="1日目"
      position={{ x: 100, y: 100 }}
      {...props}
    />,
  );

const expectVisibleLabelConnections = (
  dialog: HTMLElement,
  accessibleNames: string[],
) => {
  const ids = accessibleNames.map((accessibleName) => {
    const label = Array.from(dialog.querySelectorAll("label")).find(
      (candidate) =>
        candidate.textContent?.replace(/\s*\*$/, "").trim() === accessibleName,
    );
    expect(label).toBeDefined();
    expect(label).toBeVisible();
    expect(label!.htmlFor).not.toBe("");
    const control = document.getElementById(label!.htmlFor);
    expect(control).not.toBeNull();
    expect(dialog).toContainElement(control);
    expect(["INPUT", "SELECT", "TEXTAREA"]).toContain(control!.tagName);
    return control!.id;
  });

  expect(new Set(ids).size).toBe(ids.length);
};

describe("CellItemsPopup dialog accessibility", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the add form as a named modal with visible unique labels", () => {
    renderPopup({ onAddItem: vi.fn() });

    expect(
      screen.getByRole("button", { name: "東A-1のアイテム一覧を閉じる" }),
    ).toBeInTheDocument();
    const opener = screen.getByRole("button", { name: "新規アイテム追加" });
    opener.focus();
    fireEvent.click(opener, {
      detail: 0,
    });

    const dialog = screen.getByRole("dialog", { name: "新規アイテム追加" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      within(dialog).getByRole("heading", {
        level: 2,
        name: "新規アイテム追加",
      }),
    ).toBeInTheDocument();
    expectVisibleLabelConnections(dialog, [
      "サークル名",
      "タイトル",
      "参加日",
      "ブロック",
      "ナンバー",
      "購入金額",
      "クイック選択",
      "数量",
      "購入状態",
      "利用者メモ",
      "URL",
    ]);
    const firstControl = within(dialog).getByRole("combobox", {
      name: "サークル名",
    });
    const lastControl = within(dialog).getByRole("button", {
      name: "キャンセル",
    });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(firstControl, { key: "Tab", shiftKey: true });
    expect(lastControl).toHaveFocus();
    fireEvent.keyDown(lastControl, { key: "Tab" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "新規アイテム追加" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("exposes the edit form as a named modal with visible unique labels", () => {
    vi.useFakeTimers();
    renderPopup({ onUpdateItem: vi.fn(), onUpdateItemPriority: vi.fn() });

    const itemRow = screen
      .getByText(item.circle)
      .closest<HTMLElement>(".cursor-pointer");
    expect(itemRow).not.toBeNull();
    fireEvent.pointerDown(itemRow!, {
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const editButton = screen.getByRole("button", { name: /編集/ });
    editButton.focus();
    fireEvent.click(editButton, {
      detail: 0,
    });

    const dialog = screen.getByRole("dialog", { name: "アイテム編集" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      within(dialog).getByRole("heading", {
        level: 2,
        name: "アイテム編集",
      }),
    ).toBeInTheDocument();
    expectVisibleLabelConnections(dialog, [
      "サークル名",
      "タイトル",
      "クイック選択",
      "直接入力",
      "数量",
      "購入状態",
      "優先度",
      "利用者メモ",
      "URL",
    ]);
    const firstControl = within(dialog).getByLabelText("サークル名");
    const lastControl = within(dialog).getByRole("button", { name: "保存" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(firstControl, { key: "Tab", shiftKey: true });
    expect(lastControl).toHaveFocus();
    fireEvent.keyDown(lastControl, { key: "Tab" });
    expect(firstControl).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "アイテム編集" }),
    ).not.toBeInTheDocument();
    const popupCloseButton = screen.getByRole("button", {
      name: "東A-1のアイテム一覧を閉じる",
    });
    const popup = popupCloseButton.closest<HTMLElement>(".fixed");
    expect(popup).toContainElement(document.activeElement as HTMLElement);
  });
});
