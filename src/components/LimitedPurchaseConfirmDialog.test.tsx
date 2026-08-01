// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LimitedPurchaseConfirmDialog from "./LimitedPurchaseConfirmDialog";

const renderDialog = (
  overrides: Partial<ComponentProps<typeof LimitedPurchaseConfirmDialog>> = {},
) =>
  render(
    <LimitedPurchaseConfirmDialog
      isOpen
      title="確認"
      message="確認します"
      cancelLabel="戻る"
      confirmLabel="進む"
      initialFocus="cancel"
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      {...overrides}
    />,
  );

describe("LimitedPurchaseConfirmDialog", () => {
  it("places initial focus on the requested button", () => {
    const { rerender } = renderDialog({ initialFocus: "cancel" });

    expect(screen.getByRole("button", { name: "戻る" })).toHaveFocus();

    rerender(
      <LimitedPurchaseConfirmDialog
        isOpen
        title="確認"
        message="確認します"
        cancelLabel="戻る"
        confirmLabel="進む"
        initialFocus="confirm"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "進む" })).toHaveFocus();
  });

  it("traps Tab between cancel and confirm buttons", () => {
    renderDialog({ initialFocus: "confirm" });

    const dialog = screen.getByRole("dialog", { name: "確認" });
    const cancelButton = screen.getByRole("button", { name: "戻る" });
    const confirmButton = screen.getByRole("button", { name: "進む" });

    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirmButton).toHaveFocus();
  });

  it("stops dialog mouse events from React parents and document bubble listeners", () => {
    const parentClick = vi.fn();
    const documentMouseDown = vi.fn();
    const documentMouseUp = vi.fn();
    const documentClick = vi.fn();

    render(
      <div onClick={parentClick}>
        <LimitedPurchaseConfirmDialog
          isOpen
          title="確認"
          message="確認します"
          cancelLabel="戻る"
          confirmLabel="進む"
          initialFocus="cancel"
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </div>,
    );

    document.addEventListener("mousedown", documentMouseDown);
    document.addEventListener("mouseup", documentMouseUp);
    document.addEventListener("click", documentClick);

    const dialog = screen.getByRole("dialog", { name: "確認" });
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
