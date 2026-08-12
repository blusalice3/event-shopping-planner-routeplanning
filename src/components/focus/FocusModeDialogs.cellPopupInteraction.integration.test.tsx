import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CellItemPopup,
  PhaseChangeDialogView,
  type CellTemporaryTarget,
} from "./FocusModeDialogs";

const temporaryTarget: CellTemporaryTarget = {
  visitId: "visit-a-01",
  spaceKey: "A-01",
  displayLabel: "A-01",
  itemIds: ["item-a-01"],
  itemCount: 1,
};

type PopupAction = "temporary" | "add";

const renderOpenPopup = () => {
  const onAddItem = vi.fn();
  const onTemporaryMove = vi.fn(async () => false);
  const onClose = vi.fn();

  render(
    <CellItemPopup
      state={{
        isOpen: true,
        blockName: "A",
        number: 1,
        items: [],
      }}
      canAddItem
      temporaryTargets={[temporaryTarget]}
      onAddItem={onAddItem}
      onTemporaryMove={onTemporaryMove}
      onClose={onClose}
    />,
  );

  return { onAddItem, onTemporaryMove, onClose };
};

const getAction = (
  action: PopupAction,
  callbacks: ReturnType<typeof renderOpenPopup>,
) => {
  if (action === "temporary") {
    return {
      button: screen.getByRole("button", { name: "A-01に一時移動" }),
      callback: callbacks.onTemporaryMove,
    };
  }

  return {
    button: screen.getByRole("button", { name: "新規アイテム追加" }),
    callback: callbacks.onAddItem,
  };
};

const clickWithDetail = async (button: HTMLElement, detail: number) => {
  await act(async () => {
    fireEvent.click(button, { detail });
  });
};

const pointerDown = (element: HTMLElement) => {
  fireEvent.pointerDown(element, {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    buttons: 1,
  });
};

describe("CellItemPopup opening-click guard", () => {
  it("uses the AA green action background", () => {
    const callbacks = renderOpenPopup();

    expect(getAction("add", callbacks).button).toHaveClass(
      "bg-green-700",
      "hover:bg-green-800",
      "text-white",
    );
  });

  it("portals the centered popup to the document body", () => {
    renderOpenPopup();

    const popup = screen.getByRole("dialog", { name: "A-1のアイテム" });
    expect(popup).toHaveClass("fixed", "inset-0", "items-center");
    expect(popup.parentElement).toBe(document.body);
  });

  it.each<PopupAction>(["temporary", "add"])(
    "blocks an opening gesture click for the %s action when the popup received no pointerdown",
    async (action) => {
      const callbacks = renderOpenPopup();
      const { button, callback } = getAction(action, callbacks);

      // Models the compatibility click that can be hit-tested against a popup
      // mounted by the canvas pointerup from the same physical tap.
      await clickWithDetail(button, 1);

      expect(callback).not.toHaveBeenCalled();
    },
  );

  it.each<PopupAction>(["temporary", "add"])(
    "allows a pointer click for the %s action after pointerdown inside the popup",
    async (action) => {
      const callbacks = renderOpenPopup();
      const { button, callback } = getAction(action, callbacks);

      pointerDown(button);
      await clickWithDetail(button, 1);

      expect(callback).toHaveBeenCalledTimes(1);
    },
  );

  it.each<PopupAction>(["temporary", "add"])(
    "allows an immediate keyboard click for the %s action",
    async (action) => {
      const callbacks = renderOpenPopup();
      const { button, callback } = getAction(action, callbacks);

      await clickWithDetail(button, 0);

      expect(callback).toHaveBeenCalledTimes(1);
    },
  );
});

describe("focus dialog accessible white-text backgrounds", () => {
  it("provides a named modal, contained focus, and opener restoration", () => {
    const onCancel = vi.fn();
    const renderDialog = (isOpen: boolean) => (
      <>
        <button type="button">フェーズ変更を開く</button>
        <PhaseChangeDialogView
          dialog={{
            isOpen,
            targetPhase: "postponed",
            hasSavedIndex: false,
            savedIndex: 0,
          }}
          visitsByPhase={{ normal: [], postponed: [], late: [] }}
          onStart={vi.fn()}
          onSaved={vi.fn()}
          onCancel={onCancel}
        />
      </>
    );
    const { rerender } = render(renderDialog(false));
    const opener = screen.getByRole("button", { name: "フェーズ変更を開く" });
    opener.focus();
    rerender(renderDialog(true));

    const dialog = screen.getByRole("dialog", {
      name: "フェーズを切り替えますか？",
    });
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "フェーズを切り替えますか？",
    });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.parentElement).toHaveClass(
      "fixed",
      "inset-0",
      "items-center",
    );
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId!)).toHaveTextContent(
      "後回しフェーズに移動します",
    );
    expect(heading.parentElement).toHaveClass(
      "from-indigo-600",
      "to-purple-600",
      "text-white",
    );
    expect(screen.getByText("後回しフェーズに移動します")).not.toHaveClass(
      "opacity-80",
    );
    const cancelButton = screen.getByRole("button", { name: "キャンセル" });
    expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton, { key: "Tab" });
    expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(renderDialog(false));
    expect(
      screen.queryByRole("dialog", { name: "フェーズを切り替えますか？" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("CellItemPopup backdrop dismissal", () => {
  it("closes when a new pointer interaction clicks the backdrop", async () => {
    const { onClose } = renderOpenPopup();
    const backdrop = screen.getByRole("dialog", {
      name: "A-1のアイテム",
    });

    pointerDown(backdrop);
    await clickWithDetail(backdrop, 1);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the click is inside the popup content", async () => {
    const { onClose } = renderOpenPopup();
    const content = screen.getByText(
      "このセルには今回の巡回対象アイテムがありません",
    );

    pointerDown(content);
    await clickWithDetail(content, 1);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close from the opening gesture compatibility click", async () => {
    const { onClose } = renderOpenPopup();
    const backdrop = screen.getByRole("dialog", {
      name: "A-1のアイテム",
    });

    await clickWithDetail(backdrop, 1);

    expect(onClose).not.toHaveBeenCalled();
  });
});
