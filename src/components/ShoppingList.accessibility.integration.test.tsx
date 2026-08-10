import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import ShoppingList from "./ShoppingList";

const groupedItems: ShoppingItem[] = [
  {
    id: "item-highest",
    circle: "最優先サークル",
    eventDate: "1日目",
    block: "東A",
    number: "01a",
    title: "最優先アイテム",
    price: 1_000,
    purchaseStatus: "None",
    quantity: 1,
    remarks: "",
    priorityLevel: "highest",
  },
  {
    id: "item-priority",
    circle: "優先サークル",
    eventDate: "1日目",
    block: "東A",
    number: "02a",
    title: "優先アイテム",
    price: 800,
    purchaseStatus: "Postpone",
    quantity: 1,
    remarks: "",
    priorityLevel: "priority",
  },
  {
    id: "item-normal",
    circle: "通常サークル",
    eventDate: "1日目",
    block: "東A",
    number: "03a",
    title: "通常アイテム",
    price: 500,
    purchaseStatus: "Late",
    quantity: 1,
    remarks: "",
    priorityLevel: "none",
  },
];

const commonProps = {
  items: groupedItems,
  onUpdateItem: vi.fn(),
  onMoveItem: vi.fn(),
  onEditRequest: vi.fn(),
  onDeleteRequest: vi.fn(),
  selectedItemIds: new Set<string>(),
  onSelectItem: vi.fn(),
  layoutMode: "pc" as const,
  viewMode: "execute" as const,
  columnType: "execute" as const,
  skipLimitedPurchaseForSingleQuantity: true,
  forceFullListRenderer: true,
};

const expectAccessibleGroupHeaders = () => {
  for (const { label, backgroundClass } of [
    {
      label: "ホール未定義最優先",
      backgroundClass: "bg-red-100",
    },
    {
      label: "ホール未定義優先",
      backgroundClass: "bg-orange-100",
    },
    {
      label: "ホール未定義",
      backgroundClass: "bg-slate-100",
    },
  ]) {
    const header = screen.getByText(label).closest("div.sticky");
    expect(header).toBeInTheDocument();
    expect(header).toHaveClass(backgroundClass);
    expect(within(header as HTMLElement).getByText("1件")).toHaveClass(
      "text-slate-600",
      "dark:text-slate-300",
    );
  }
};

const expectFullRendererRowsUseSharedController = (
  expectedGroups: readonly { key: string; label: string }[],
) => {
  const list = screen.getByRole("list", { name: "買い物リスト" });
  expect(list).toHaveAttribute("data-list-renderer", "full");
  expect(list).toHaveAttribute("data-list-controller", "shared");
  const expectedRows = expectedGroups.flatMap((group, index) => [
    {
      rowKey: `group:${JSON.stringify(group.key)}`,
      accessibleName: `${group.label} 1件`,
      positionInSet: null,
      setSize: null,
    },
    {
      rowKey: `item:${JSON.stringify(groupedItems[index].id)}`,
      accessibleName: `${groupedItems[index].block}${groupedItems[index].number} ${groupedItems[index].circle} ${groupedItems[index].title}`,
      positionInSet: String(index + 1),
      setSize: String(groupedItems.length),
    },
  ]);
  expect(
    Array.from(list.querySelectorAll<HTMLElement>('[role="listitem"]')).map(
      (row) => ({
        rowKey: row.dataset.rowKey,
        accessibleName: row.getAttribute("aria-label"),
        positionInSet: row.getAttribute("aria-posinset"),
        setSize: row.getAttribute("aria-setsize"),
      }),
    ),
  ).toEqual(
    expectedRows.map((row) => ({
      ...row,
      rowKey: row.rowKey,
    })),
  );
};

describe("ShoppingList accessibility", () => {
  it("keeps priority group counts readable in space and hall grouping", () => {
    const { rerender } = render(
      <ShoppingList {...commonProps} showSpaceGroups />,
    );

    expectAccessibleGroupHeaders();
    expectFullRendererRowsUseSharedController([
      { key: "東A-01a:highest", label: "東A-01a" },
      { key: "東A-02a:priority", label: "東A-02a" },
      { key: "東A-03a", label: "東A-03a" },
    ]);

    rerender(<ShoppingList {...commonProps} showHallGroups />);

    expectAccessibleGroupHeaders();
    expectFullRendererRowsUseSharedController([
      { key: "undefined:highest", label: "ホール未定義最優先" },
      { key: "undefined:priority", label: "ホール未定義優先" },
      { key: "ungrouped:2", label: "ホール未定義" },
    ]);
  });

  it("renders the add-item form as a named modal with visible labels and contained focus", () => {
    const onAddItem = vi.fn();
    render(
      <ShoppingList
        {...commonProps}
        currentDay="1日目"
        onAddItem={onAddItem}
        showSpaceGroups
      />,
    );

    const opener = screen.getAllByRole("button", {
      name: "このスペースにアイテムを追加",
    })[0];
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "新規アイテム追加" });
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "新規アイテム追加",
    });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "1日目 東A-01a",
    );
    const dialogQueries = within(dialog);

    for (const label of [
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
    ]) {
      const control = dialogQueries.getByLabelText(label, {
        exact: false,
      }) as HTMLInputElement | HTMLSelectElement;
      expect(control.id).not.toBe("");
      expect(Array.from(control.labels ?? [])).toHaveLength(1);
      expect(control.labels?.[0]).toHaveTextContent(label);
    }

    const circleInput = dialogQueries.getByRole("combobox", {
      name: "サークル名",
    });
    const cancelButton = dialogQueries.getByRole("button", {
      name: "キャンセル",
    });
    expect(circleInput).toBeRequired();
    expect(circleInput).toHaveFocus();

    fireEvent.keyDown(circleInput, { key: "Tab", shiftKey: true });
    expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton, { key: "Tab" });
    expect(circleInput).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "新規アイテム追加" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(onAddItem).not.toHaveBeenCalled();
  });
});
