import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { FocusModeHeader, FocusModeItemList } from "./FocusModePanels";
import type { ShoppingItem } from "../../types/item";

const baseItem: ShoppingItem = {
  id: "item-1",
  circle: "Circle",
  eventDate: "Day1",
  block: "A",
  number: "01",
  title: "Title",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const renderHeader = (
  overrides: Partial<ComponentProps<typeof FocusModeHeader>> = {},
) => {
  const props: ComponentProps<typeof FocusModeHeader> = {
    layoutMode: "pc",
    isMapVisible: false,
    spaceInfo: "A-01a",
    circleName: "Circle",
    currentVisitCheckedCount: 1,
    currentVisitTotalCount: 2,
    currentVisitPriceInfo: {
      chargeableTotal: 1000,
      plannedTotal: 1500,
      priceMissingItemCount: 1,
    },
    currentPhase: "normal",
    onPhaseChangeRequest: vi.fn(),
    currentVisitItems: [baseItem],
    onBulkStatusChange: vi.fn(),
    nextVisitInfo: {
      spaceInfo: "A-02a",
      circleName: "Next Circle",
    },
    ...overrides,
  };

  return render(<FocusModeHeader {...props} />);
};

describe("FocusModeItemList purchase status control mode", () => {
  it("passes radial purchase status control mode to item cards", () => {
    render(
      <FocusModeItemList
        itemListRef={{ current: null }}
        layoutMode="pc"
        isMapVisible={false}
        currentVisitDisplayItems={[baseItem]}
        blinkingPriceItemIds={new Set()}
        onUpdateItem={vi.fn()}
        skipLimitedPurchaseForSingleQuantity
        purchaseStatusControlMode="radial"
      />,
    );

    expect(
      screen.getByRole("button", { name: /Current status/i }),
    ).toHaveAttribute("aria-haspopup", "dialog");
  });
});

describe("FocusModeHeader responsive layout", () => {
  it("uses smartphone-specific compact layout and horizontal bulk status row", () => {
    renderHeader({ layoutMode: "smartphone" });

    expect(screen.getByTestId("focus-header-smartphone-main")).toHaveClass(
      "grid",
      "grid-cols-[minmax(0,1fr)_auto]",
    );
    expect(screen.getByTestId("focus-header-smartphone-payment")).toHaveClass(
      "border-t",
      "items-baseline",
    );
    expect(screen.getByTestId("focus-header-bulk-scroll")).toHaveClass(
      "overflow-x-auto",
    );
    expect(screen.getByTestId("focus-header-bulk-row")).toHaveClass(
      "flex-nowrap",
      "w-max",
    );
    expect(screen.getByTestId("focus-header-next-visit")).toHaveAttribute(
      "title",
      "A-02a Next Circle",
    );
    expect(screen.getByRole("combobox", { name: "phase" })).toBeInTheDocument();
  });

  it("applies w-full and max-w-[7.5rem] to the smartphone phase select", () => {
    renderHeader({ layoutMode: "smartphone" });

    expect(screen.getByRole("combobox", { name: "phase" })).toHaveClass(
      "w-full",
      "max-w-[7.5rem]",
    );
  });

  it("keeps desktop layout without smartphone-only scroll containers on pc", () => {
    renderHeader({ layoutMode: "pc" });

    expect(
      screen.queryByTestId("focus-header-smartphone-main"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("focus-header-smartphone-payment"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("focus-header-bulk-scroll"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "phase" })).toBeInTheDocument();
  });

  it("uses dash fallback for empty next visit info on smartphone", () => {
    renderHeader({
      layoutMode: "smartphone",
      nextVisitInfo: {
        spaceInfo: "",
        circleName: "",
      },
    });

    const nextVisit = screen.getByTestId("focus-header-next-visit");
    expect(nextVisit).toHaveAttribute("title", "-");
    expect(nextVisit).toHaveTextContent("-");
  });

  it("falls back to dash when next visit info contains only whitespace on smartphone", () => {
    renderHeader({
      layoutMode: "smartphone",
      nextVisitInfo: {
        spaceInfo: "   ",
        circleName: "\t",
      },
    });

    const nextVisit = screen.getByTestId("focus-header-next-visit");
    expect(nextVisit).toHaveAttribute("title", "-");
    expect(nextVisit).toHaveTextContent("-");
  });

  it("invokes onBulkStatusChange when the first (Purchased) bulk status button is clicked on smartphone", () => {
    const onBulkStatusChange = vi.fn();
    renderHeader({
      layoutMode: "smartphone",
      onBulkStatusChange,
    });

    const buttons = within(
      screen.getByTestId("focus-header-bulk-row"),
    ).getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(onBulkStatusChange).toHaveBeenCalledTimes(1);
    expect(onBulkStatusChange).toHaveBeenCalledWith("Purchased");
  });

  it("keeps title attributes on smartphone bulk status buttons", () => {
    renderHeader({ layoutMode: "smartphone" });

    const buttons = within(
      screen.getByTestId("focus-header-bulk-row"),
    ).getAllByRole("button");

    buttons.forEach((button) => {
      expect(button).toHaveAttribute("title");
      expect(button.getAttribute("title")).not.toBe("");
    });
  });

  it("invokes onPhaseChangeRequest when phase is changed on smartphone", () => {
    const onPhaseChangeRequest = vi.fn();
    renderHeader({
      layoutMode: "smartphone",
      onPhaseChangeRequest,
    });

    fireEvent.change(screen.getByRole("combobox", { name: "phase" }), {
      target: { value: "late" },
    });

    expect(onPhaseChangeRequest).toHaveBeenCalledWith("late");
  });
});
