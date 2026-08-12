// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DayMapData, HallDefinition } from "../../types/map";
import HallDefinitionPanel from "./HallDefinitionPanel";

const mapData: DayMapData = {
  maxRow: 1,
  maxCol: 1,
  cells: [],
  mergedCells: [],
  blocks: [],
};

const halls: HallDefinition[] = [
  {
    id: "hall-east",
    name: "東ホール",
    vertices: [],
    color: "#FFE0B2",
  },
];

describe("HallDefinitionPanel accessibility", () => {
  it("exposes a labelled modal dialog and AA-safe destructive action text", () => {
    const onClose = vi.fn();
    const renderPanel = (isOpen: boolean) => (
      <>
        <button type="button">ホール定義を開く</button>
        <HallDefinitionPanel
          isOpen={isOpen}
          onClose={onClose}
          mapData={mapData}
          halls={halls}
          onUpdateHalls={vi.fn()}
          onStartVertexSelection={vi.fn()}
        />
      </>
    );
    const view = render(renderPanel(false));
    const opener = view.getByRole("button", { name: "ホール定義を開く" });
    opener.focus();
    view.rerender(renderPanel(true));

    const dialog = view.getByRole("dialog", {
      name: "ホール定義エリア設定",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(
      view.getByRole("heading", {
        level: 2,
        name: "ホール定義エリア設定",
      }),
    ).toBeInTheDocument();
    expect(view.getByRole("button", { name: "東ホールを削除" })).toHaveClass(
      "text-red-700",
      "dark:text-red-300",
    );
    const closeButton = view.getByRole("button", {
      name: "ホール定義エリア設定を閉じる",
    });
    const applyButton = view.getByRole("button", { name: "適用" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(applyButton).toHaveFocus();
    fireEvent.keyDown(applyButton, { key: "Tab" });
    expect(closeButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(renderPanel(false));
    expect(opener).toHaveFocus();
  });

  it("keeps new-hall color swatches inside their buttons", () => {
    const view = render(
      <HallDefinitionPanel
        isOpen
        onClose={vi.fn()}
        mapData={mapData}
        halls={halls}
        onUpdateHalls={vi.fn()}
        onStartVertexSelection={vi.fn()}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "+ 新規" }));

    const colorButtons = view.getAllByRole("button", { name: /^色: #/ });
    expect(colorButtons).toHaveLength(12);
    colorButtons.forEach((button) => {
      expect(button).toHaveClass("relative", "h-8", "w-8", "overflow-hidden");
      expect(button.querySelector("svg")).toHaveClass(
        "absolute",
        "inset-0",
        "h-full",
        "w-full",
      );
    });
  });
});
