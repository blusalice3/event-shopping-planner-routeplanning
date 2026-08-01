// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LimitedPurchaseExcessConfirmDialog from "./LimitedPurchaseExcessConfirmDialog";

describe("LimitedPurchaseExcessConfirmDialog", () => {
  it("keeps the existing props and focuses the safe fix action first", () => {
    const onFix = vi.fn();
    const onConvertToPurchased = vi.fn();

    render(
      <LimitedPurchaseExcessConfirmDialog
        isOpen
        onFix={onFix}
        onConvertToPurchased={onConvertToPurchased}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");

    expect(buttons[0]).toHaveFocus();

    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onConvertToPurchased).toHaveBeenCalledTimes(1);
  });
});
