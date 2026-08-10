// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../types/item";
import { LimitedPurchaseMissingListView } from "./LimitedPurchaseMissingListView";

const makeItem = (patch: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "limited-1",
  circle: "Circle A",
  eventDate: "day1",
  block: "A",
  number: "01a",
  title: "Book A",
  price: 100,
  purchaseStatus: "LimitedPurchase",
  quantity: 5,
  remarks: "",
  ...patch,
});

const renderView = (items: ShoppingItem[] = [makeItem()]) => {
  const onUpdateItem = vi.fn();
  const onBack = vi.fn();

  render(
    <LimitedPurchaseMissingListView
      items={items}
      onUpdateItem={onUpdateItem}
      onBack={onBack}
    />,
  );

  return { onUpdateItem, onBack };
};

const getFirstRowControls = () => {
  const row = screen
    .getByText("Circle A")
    .closest('div[class*="rounded-lg"]') as HTMLElement;
  const inputs = within(row).getAllByRole("textbox") as HTMLInputElement[];
  const saveButton = within(row).getByRole("button");
  return {
    row,
    actualInput: inputs[0],
    plannedInput: inputs[1],
    priceInput: inputs[2],
    saveButton,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LimitedPurchaseMissingListView", () => {
  it("uses AA normal and hover colors for save actions", () => {
    renderView();

    expect(getFirstRowControls().saveButton).toHaveClass(
      "bg-orange-700",
      "hover:bg-orange-800",
      "text-white",
    );
  });

  it("saves price and planned quantity while actual stays blank", async () => {
    const user = userEvent.setup();
    const { onUpdateItem } = renderView([makeItem({ price: null })]);
    const { plannedInput, priceInput, saveButton } = getFirstRowControls();

    await user.clear(plannedInput);
    await user.type(plannedInput, "07");
    await user.type(priceInput, "1200");
    await user.click(saveButton);

    expect(onUpdateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseStatus: "LimitedPurchase",
        quantity: 7,
        price: 1200,
      }),
    );
    expect(onUpdateItem.mock.calls[0][0]).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });

  it("saves a blank price as null while actual stays blank", async () => {
    const user = userEvent.setup();
    const { onUpdateItem } = renderView();
    const { priceInput, saveButton } = getFirstRowControls();

    await user.clear(priceInput);
    await user.click(saveButton);

    expect(onUpdateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseStatus: "LimitedPurchase",
        quantity: 5,
        price: null,
      }),
    );
    expect(onUpdateItem.mock.calls[0][0]).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });

  it("does not save invalid price text", async () => {
    const user = userEvent.setup();
    const { onUpdateItem } = renderView();
    const { priceInput, saveButton } = getFirstRowControls();

    await user.clear(priceInput);
    await user.type(priceInput, "1,000");
    await user.click(saveButton);

    expect(onUpdateItem).not.toHaveBeenCalled();
  });

  it("opens custom confirmation for actual greater than planned and can convert to purchased", async () => {
    const user = userEvent.setup();
    const { onUpdateItem } = renderView();
    const { actualInput, saveButton } = getFirstRowControls();

    await user.type(actualInput, "6");
    await user.click(saveButton);

    const excessDialog = screen.getByRole("dialog");
    await user.click(within(excessDialog).getAllByRole("button")[1]);

    expect(onUpdateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        purchaseStatus: "Purchased",
        quantity: 5,
        price: 100,
      }),
    );
    expect(onUpdateItem.mock.calls[0][0]).not.toHaveProperty(
      "limitedPurchasedQuantity",
    );
  });
});
