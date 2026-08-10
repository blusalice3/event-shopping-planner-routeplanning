// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AddItemDialogView } from "./FocusModeDialogs";

function AddItemDialogFocusHarness({ onClose }: { onClose: () => void }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setIsOpen(true)}>
        追加ダイアログを開く
      </button>
      <AddItemDialogView
        dialog={{
          isOpen,
          eventDate: "1日目",
          block: "東A",
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
        setDialog={() => undefined}
        setForm={() => undefined}
        currentVisit={undefined}
        priceOptions={[0, 500]}
        onPriceInputChange={() => undefined}
        onPriceSelectChange={() => undefined}
        onClose={() => {
          onClose();
          setIsOpen(false);
        }}
        onSubmit={() => undefined}
      />
    </>
  );
}

describe("AddItemDialogView accessibility", () => {
  it("names the modal and explicitly associates every visible field label", () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AddItemDialogView
        dialog={{
          isOpen: true,
          eventDate: "1日目",
          block: "東A",
          number: "01",
        }}
        form={{
          circle: "サークルA",
          title: "新刊セット",
          price: "1000",
          quantity: "2",
          remarks: "スケブお願い",
          url: "https://example.com",
          purchaseStatus: "Purchased",
        }}
        setDialog={vi.fn()}
        setForm={vi.fn()}
        currentVisit={undefined}
        priceOptions={[0, 500, 1000]}
        onPriceInputChange={vi.fn()}
        onPriceSelectChange={vi.fn()}
        onClose={onClose}
        onSubmit={onSubmit}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "新規アイテム追加",
    });
    const heading = within(dialog).getByRole("heading", {
      level: 2,
      name: "新規アイテム追加",
    });
    const description = within(dialog).getByText("1日目 東A-01");

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", heading.id);
    expect(dialog).toHaveAttribute("aria-describedby", description.id);

    const labels = Array.from(dialog.querySelectorAll("label"));
    const controls = Array.from(
      dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
        "input, select",
      ),
    );

    expect(labels).toHaveLength(11);
    expect(controls).toHaveLength(11);
    expect(new Set(controls.map((control) => control.id)).size).toBe(
      controls.length,
    );
    for (const label of labels) {
      expect(label.htmlFor).not.toBe("");
      expect(document.getElementById(label.htmlFor)).toBe(label.control);
      expect(label.control).toBeInstanceOf(HTMLElement);
    }

    const circle = within(dialog).getByLabelText(/^サークル名/);
    expect(circle).toBeRequired();
    expect(within(dialog).getByLabelText("参加日")).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText("ブロック")).toHaveAttribute(
      "readonly",
    );

    for (const name of ["クイック選択", "数量", "購入状態"]) {
      expect(within(dialog).getByRole("combobox", { name })).toHaveAttribute(
        "id",
      );
    }

    const cancelButton = within(dialog).getByRole("button", {
      name: "キャンセル",
    });
    const submitButton = within(dialog).getByRole("button", {
      name: "リストに追加",
    });
    expect(cancelButton).toHaveAttribute("type", "button");
    expect(submitButton).toHaveAttribute("type", "button");

    fireEvent.click(cancelButton);
    fireEvent.click(submitButton);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("locks interaction to the modal and restores focus after Escape", () => {
    const onClose = vi.fn();
    render(<AddItemDialogFocusHarness onClose={onClose} />);

    const opener = screen.getByRole("button", {
      name: "追加ダイアログを開く",
    });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", {
      name: "新規アイテム追加",
    });
    const circle = within(dialog).getByLabelText(/^サークル名/);
    const submitButton = within(dialog).getByRole("button", {
      name: "リストに追加",
    });

    expect(circle).toHaveFocus();
    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
    );

    fireEvent.keyDown(circle, { key: "Tab", shiftKey: true });
    expect(submitButton).toHaveFocus();
    fireEvent.keyDown(submitButton, { key: "Tab" });
    expect(circle).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("dialog", { name: "新規アイテム追加" }),
    ).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(document.body).not.toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
    );
  });
});
