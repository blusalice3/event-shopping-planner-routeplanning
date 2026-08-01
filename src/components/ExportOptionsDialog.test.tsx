// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ExportOptionsDialog from "./ExportOptionsDialog";

describe("ExportOptionsDialog", () => {
  it("ブロック定義の無効な選択肢を表示せず、マップ選択だけを渡す", () => {
    const onExport = vi.fn();
    render(
      <ExportOptionsDialog
        isOpen
        onClose={vi.fn()}
        onExport={onExport}
        hasMapData
      />,
    );

    expect(screen.queryByText(/ブロック定義/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));

    expect(onExport).toHaveBeenCalledWith({
      includeItems: true,
      includeLayoutInfo: true,
      includeMapData: true,
      includeRouteInfo: true,
      format: "full",
    });
  });

  it("簡易版ではマップを含めない", () => {
    const onExport = vi.fn();
    render(
      <ExportOptionsDialog
        isOpen
        onClose={vi.fn()}
        onExport={onExport}
        hasMapData
      />,
    );

    fireEvent.click(screen.getByLabelText(/簡易版/));
    fireEvent.click(screen.getByRole("button", { name: "エクスポート" }));

    expect(onExport).toHaveBeenCalledWith(
      expect.objectContaining({
        includeMapData: false,
        format: "simple",
      }),
    );
  });
});
