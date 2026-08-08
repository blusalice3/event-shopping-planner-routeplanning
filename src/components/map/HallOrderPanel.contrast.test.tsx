// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HallDefinition, HallRouteSettings } from "../../types/map";
import HallOrderPanel from "./HallOrderPanel";

const halls: HallDefinition[] = [
  {
    id: "hall-1",
    name: "東1",
    vertices: [],
    color: "#FFE0B2",
  },
  {
    id: "hall-dark",
    name: "東2",
    vertices: [],
    color: "#000",
  },
  {
    id: "hall-invalid",
    name: "東3",
    vertices: [],
    color: "black",
  },
];

const hallRouteSettings: HallRouteSettings = {
  hallOrder: [
    "hall-1",
    "hall-dark",
    "hall-invalid",
    "hall-1:priority",
    "hall-1:highest",
  ],
  hallVisitLists: [],
};

describe("HallOrderPanel badge contrast", () => {
  it("uses AA-safe priority fills and selects a readable foreground for hall colors", () => {
    const onClose = vi.fn();
    const renderPanel = (isOpen: boolean) => (
      <>
        <button type="button">ホール順設定を開く</button>
        <HallOrderPanel
          isOpen={isOpen}
          onClose={onClose}
          halls={halls}
          hallRouteSettings={hallRouteSettings}
          onUpdateHallRouteSettings={vi.fn()}
          getItemCountInHall={() => 1}
        />
      </>
    );
    const view = render(renderPanel(false));
    const opener = view.getByRole("button", { name: "ホール順設定を開く" });
    opener.focus();
    view.rerender(renderPanel(true));

    const normalBadge = view.container
      .querySelector('circle[fill="#FFE0B2"]')
      ?.closest("span");
    const darkBadge = view.container
      .querySelector('circle[fill="#000000"]')
      ?.closest("span");
    const fallbackBadge = view.container
      .querySelector('circle[fill="#9CA3AF"]')
      ?.closest("span");
    const priorityBadge = view.container
      .querySelector('circle[fill="#C2410C"]')
      ?.closest("span");
    const highestBadge = view.container
      .querySelector('circle[fill="#B91C1C"]')
      ?.closest("span");
    const dialog = view.getByRole("dialog", {
      name: "ホール間移動順序",
    });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      view.getByRole("heading", { level: 2, name: "ホール間移動順序" }),
    ).toBeInTheDocument();
    expect(normalBadge).toHaveClass("text-black");
    expect(darkBadge).toHaveClass("text-white");
    expect(fallbackBadge).toHaveClass("text-black");
    expect(priorityBadge).toHaveClass("text-white");
    expect(highestBadge).toHaveClass("text-white");
    for (const helperText of view.getAllByText("1件の訪問先")) {
      expect(helperText).toHaveClass("text-slate-700", "dark:text-slate-200");
    }
    const closeButton = view.getByRole("button", {
      name: "ホール間移動順序を閉じる",
    });
    const saveButton = view.getByRole("button", { name: "保存" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(saveButton).toHaveFocus();
    fireEvent.keyDown(saveButton, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(renderPanel(false));
    expect(opener).toHaveFocus();
  });
});
