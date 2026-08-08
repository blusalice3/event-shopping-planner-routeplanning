// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import type { HallDefinition } from "../types/map";
import { ItemEditDialog } from "./ItemEditDialog";

const item: ShoppingItem = {
  id: "item-1",
  circle: "サークルA",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊セット",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const halls: HallDefinition[] = [
  {
    id: "east-1",
    name: "東1ホール",
    vertices: [],
    blockNames: ["東A"],
  },
  {
    id: "east-2",
    name: "東2ホール",
    vertices: [],
    blockNames: ["東A"],
  },
];

const expectExplicitLabel = (
  dialog: HTMLElement,
  control: HTMLElement,
  labelText: string,
) => {
  expect(control.id).not.toBe("");
  const label = Array.from(dialog.querySelectorAll("label")).find(
    (candidate) => candidate.htmlFor === control.id,
  );
  expect(label).toBeDefined();
  expect(label).toHaveTextContent(labelText);
};

describe("ItemEditDialog accessibility", () => {
  it("contains keyboard focus, closes on Escape, and restores the opener", () => {
    const onClose = vi.fn();
    const renderView = (isOpen: boolean) => (
      <>
        <button type="button">アイテム編集を開く</button>
        {isOpen && (
          <ItemEditDialog item={item} onSave={vi.fn()} onClose={onClose} />
        )}
      </>
    );
    const view = render(renderView(false));
    const opener = screen.getByRole("button", { name: "アイテム編集を開く" });
    opener.focus();

    view.rerender(renderView(true));
    const dialog = screen.getByRole("dialog", { name: "アイテム編集" });
    const dialogQueries = within(dialog);
    const firstControl = dialogQueries.getByRole("combobox", {
      name: "サークル名",
    });
    const lastControl = dialogQueries.getByRole("button", { name: "保存" });
    expect(firstControl).toHaveFocus();

    fireEvent.keyDown(firstControl, { key: "Tab", shiftKey: true });
    expect(lastControl).toHaveFocus();
    fireEvent.keyDown(lastControl, { key: "Tab" });
    expect(firstControl).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(renderView(false));
    expect(opener).toHaveFocus();
  });

  it("exposes a named modal and explicitly associates every visible control label", () => {
    const onSave = vi.fn();
    render(
      <ItemEditDialog
        item={item}
        halls={halls}
        onSave={onSave}
        onClose={vi.fn()}
        onPriorityChange={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "アイテム編集" });
    const dialogQueries = within(dialog);
    const heading = dialogQueries.getByRole("heading", {
      name: "アイテム編集",
    });
    const descriptionId = dialog.getAttribute("aria-describedby");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "1日目 東A-01a",
    );

    const labeledControls: Array<[HTMLElement, string]> = [
      [
        dialogQueries.getByRole("combobox", { name: "サークル名" }),
        "サークル名",
      ],
      [dialogQueries.getByRole("textbox", { name: "タイトル" }), "タイトル"],
      [dialogQueries.getByRole("textbox", { name: "参加日" }), "参加日"],
      [dialogQueries.getByRole("textbox", { name: "ブロック" }), "ブロック"],
      [dialogQueries.getByRole("textbox", { name: "ナンバー" }), "ナンバー"],
      [
        dialogQueries.getByRole("textbox", { name: "購入金額" }),
        "購入金額（利用者が編集）",
      ],
      [
        dialogQueries.getByRole("combobox", { name: "クイック選択" }),
        "クイック選択",
      ],
      [dialogQueries.getByRole("combobox", { name: "数量" }), "数量"],
      [dialogQueries.getByRole("combobox", { name: "購入状態" }), "購入状態"],
      [
        dialogQueries.getByRole("combobox", { name: /ホール設定/ }),
        "ホール設定",
      ],
      [dialogQueries.getByRole("combobox", { name: "優先度" }), "優先度"],
      [
        dialogQueries.getByRole("textbox", { name: "利用者メモ" }),
        "利用者メモ",
      ],
      [dialogQueries.getByRole("textbox", { name: "URL" }), "URL"],
    ];

    for (const [control, labelText] of labeledControls) {
      expectExplicitLabel(dialog, control, labelText);
    }
    expect(
      dialogQueries.getByRole("combobox", { name: "サークル名" }),
    ).toBeRequired();

    fireEvent.change(dialogQueries.getByRole("textbox", { name: "参加日" }), {
      target: { value: "2日目" },
    });
    fireEvent.change(
      dialogQueries.getByRole("combobox", { name: "クイック選択" }),
      { target: { value: "1200" } },
    );
    fireEvent.change(dialogQueries.getByRole("combobox", { name: "数量" }), {
      target: { value: "2" },
    });
    fireEvent.click(dialogQueries.getByRole("button", { name: "保存" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ eventDate: "2日目", price: 1200, quantity: 2 }),
    );
  });

  it("keeps the conditional limited-purchase inputs explicitly labeled", () => {
    render(
      <ItemEditDialog
        item={{
          ...item,
          purchaseStatus: "LimitedPurchase",
          quantity: 4,
          limitedPurchasedQuantity: 2,
        }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "アイテム編集" });
    const dialogQueries = within(dialog);
    expectExplicitLabel(
      dialog,
      dialogQueries.getByRole("textbox", { name: "実購入数" }),
      "実購入数",
    );
    expectExplicitLabel(
      dialog,
      dialogQueries.getByRole("textbox", { name: "購入予定量" }),
      "購入予定量",
    );
  });
});
