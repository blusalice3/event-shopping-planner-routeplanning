import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../types/item";
import { ItemEditDialog } from "./ItemEditDialog";
import ShoppingItemCard from "./ShoppingItemCard";
import { AddItemDialogView } from "./focus/FocusModeDialogs";

const baseItem: ShoppingItem = {
  id: "item-1",
  circle: "サークルA",
  eventDate: "1日目",
  block: "A",
  number: "01",
  title: "新刊",
  price: 900,
  purchaseStatus: "None",
  quantity: 25,
  remarks: "当日確認",
};

const optionValues = (select: HTMLElement): string[] =>
  Array.from((select as HTMLSelectElement).options).map(
    (option) => option.value,
  );

describe("quantity and synchronized field presentation", () => {
  it("separates sheet values from user-editable values in the item editor", () => {
    render(
      <ItemEditDialog
        item={{
          ...baseItem,
          catalogPrice: 1200,
          sheetRemarks: "新刊セットあり",
        }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText("カタログ価格（シート・読み取り専用）"),
    ).toHaveTextContent("1,200円");
    expect(
      screen.getByLabelText("シート備考（読み取り専用）"),
    ).toHaveTextContent("新刊セットあり");
    expect(screen.getByRole("textbox", { name: "購入金額" })).toHaveValue(
      "900",
    );
    expect(screen.getByRole("textbox", { name: "利用者メモ" })).toHaveValue(
      "当日確認",
    );

    const quantity = screen.getByRole("combobox", { name: "数量" });
    expect(optionValues(quantity)).toEqual([
      ...Array.from({ length: 20 }, (_, index) => String(index + 1)),
      "25",
    ]);
    expect(quantity).toHaveValue("25");
    expect(
      within(quantity).getByRole("option", { name: "25（現在値）" }),
    ).toBeInTheDocument();
  });

  it("does not invent duplicate sheet fields for legacy items", () => {
    render(
      <ItemEditDialog item={baseItem} onSave={vi.fn()} onClose={vi.fn()} />,
    );

    expect(
      screen.queryByLabelText("カタログ価格（シート・読み取り専用）"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("シート備考（読み取り専用）"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "購入金額" })).toHaveValue(
      "900",
    );
    expect(screen.getByRole("textbox", { name: "利用者メモ" })).toHaveValue(
      "当日確認",
    );
  });

  it("shows source data read-only and keeps purchase data editable on cards", () => {
    const onUpdate = vi.fn();
    render(
      <ShoppingItemCard
        item={{
          ...baseItem,
          catalogPrice: 1200,
          sheetRemarks: "シート側の備考",
        }}
        onUpdate={onUpdate}
        isStriped={false}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        isSelected={false}
        onSelectItem={vi.fn()}
        skipLimitedPurchaseForSingleQuantity
      />,
    );

    const sheetInfo = screen.getByLabelText("シート情報");
    expect(sheetInfo).toHaveTextContent("カタログ価格: 1,200円");
    expect(sheetInfo).toHaveTextContent("シート備考: シート側の備考");
    expect(screen.getByRole("textbox", { name: "利用者メモ" })).toHaveValue(
      "当日確認",
    );
    expect(screen.getByRole("combobox", { name: "購入金額" })).toHaveValue(
      "900",
    );

    const quantity = screen.getByRole("combobox", {
      name: "購入予定数量",
    });
    expect(quantity).toHaveValue("25");
    expect(optionValues(quantity)).toContain("20");
    fireEvent.change(quantity, { target: { value: "20" } });
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 20 }),
    );
  });

  it("uses the same 1-to-20 range in the focus-mode add dialog", () => {
    render(
      <AddItemDialogView
        dialog={{
          isOpen: true,
          eventDate: "1日目",
          block: "A",
          number: "01",
        }}
        form={{
          circle: "サークルA",
          title: "",
          price: "",
          quantity: "1",
          remarks: "",
          url: "",
          purchaseStatus: "Purchased",
        }}
        setDialog={vi.fn()}
        setForm={vi.fn()}
        currentVisit={undefined}
        priceOptions={[0, 100]}
        onPriceInputChange={vi.fn()}
        onPriceSelectChange={vi.fn()}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const quantity = screen.getByRole("combobox", { name: "数量" });
    expect(optionValues(quantity)).toEqual(
      Array.from({ length: 20 }, (_, index) => String(index + 1)),
    );
    expect(screen.getByText("購入金額")).toBeInTheDocument();
    expect(screen.getByText("利用者メモ")).toBeInTheDocument();
  });
});
