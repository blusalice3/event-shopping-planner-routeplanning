// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SingleQuantityLimitedPurchaseChoiceDialog from "./SingleQuantityLimitedPurchaseChoiceDialog";

const renderDialog = () => {
  const onPurchased = vi.fn();
  const onLimited = vi.fn();
  const onCancel = vi.fn();

  render(
    <SingleQuantityLimitedPurchaseChoiceDialog
      isOpen
      onPurchased={onPurchased}
      onLimited={onLimited}
      onCancel={onCancel}
    />,
  );

  const dialog = screen.getByRole("dialog");
  const buttons = within(dialog).getAllByRole("button");

  return {
    dialog,
    cancelButton: buttons[0],
    limitedButton: buttons[1],
    purchasedButton: buttons[2],
    onPurchased,
    onLimited,
    onCancel,
  };
};

describe("SingleQuantityLimitedPurchaseChoiceDialog", () => {
  it("renders as a modal dialog and places initial focus on purchased", () => {
    const { dialog, purchasedButton } = renderDialog();

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(purchasedButton).toHaveFocus();
  });

  it("calls each action handler from its button", () => {
    const {
      cancelButton,
      limitedButton,
      purchasedButton,
      onCancel,
      onLimited,
      onPurchased,
    } = renderDialog();

    fireEvent.click(purchasedButton);
    fireEvent.click(limitedButton);
    fireEvent.click(cancelButton);

    expect(onPurchased).toHaveBeenCalledTimes(1);
    expect(onLimited).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("treats Escape as cancel", () => {
    const { onCancel } = renderDialog();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("traps Tab between the three dialog buttons", () => {
    const { dialog, cancelButton, purchasedButton } = renderDialog();

    expect(purchasedButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(purchasedButton).toHaveFocus();
  });

  it("stops dialog mouse events from React parents and document bubble listeners", () => {
    const parentClick = vi.fn();
    const documentMouseDown = vi.fn();
    const documentMouseUp = vi.fn();
    const documentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <SingleQuantityLimitedPurchaseChoiceDialog
          isOpen
          onPurchased={vi.fn()}
          onLimited={vi.fn()}
          onCancel={vi.fn()}
        />
      </div>,
    );

    document.addEventListener("mousedown", documentMouseDown);
    document.addEventListener("mouseup", documentMouseUp);
    document.addEventListener("click", documentClick);

    const dialog = screen.getByRole("dialog");
    fireEvent.mouseDown(dialog);
    fireEvent.mouseUp(dialog);
    fireEvent.click(dialog);

    expect(parentClick).not.toHaveBeenCalled();
    expect(documentMouseDown).not.toHaveBeenCalled();
    expect(documentMouseUp).not.toHaveBeenCalled();
    expect(documentClick).not.toHaveBeenCalled();

    document.removeEventListener("mousedown", documentMouseDown);
    document.removeEventListener("mouseup", documentMouseUp);
    document.removeEventListener("click", documentClick);
  });
});
