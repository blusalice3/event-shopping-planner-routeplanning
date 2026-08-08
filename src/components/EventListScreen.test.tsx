// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EventListScreen from "./EventListScreen";

const renderEventListScreen = (eventNames: string[]) =>
  render(
    <EventListScreen
      eventNames={eventNames}
      onSelect={vi.fn()}
      onDelete={vi.fn()}
      onExport={vi.fn()}
      onImportExportFile={vi.fn()}
      onExportBackup={vi.fn()}
      onRestoreBackup={vi.fn()}
    />,
  );

const expectAccessibleActionColors = () => {
  const importButton = screen.getByRole("button", {
    name: /Excel.*取り込み/,
  });
  const exportBackupButton = screen.getByRole("button", {
    name: "JSONバックアップ保存",
  });
  const restoreBackupButton = screen.getByRole("button", {
    name: "JSONバックアップ復元",
  });

  for (const actionButton of [
    importButton,
    exportBackupButton,
    restoreBackupButton,
  ]) {
    expect(actionButton).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-offset-2",
      "dark:focus-visible:ring-offset-slate-900",
    );
  }

  expect(importButton).toHaveClass(
    "bg-green-700",
    "hover:bg-green-800",
    "focus-visible:bg-green-800",
    "focus-visible:ring-green-700",
    "dark:focus-visible:ring-green-400",
  );
  expect(importButton).not.toHaveClass("bg-green-600", "hover:bg-green-700");

  expect(exportBackupButton).toHaveClass(
    "bg-blue-600",
    "hover:bg-blue-700",
    "focus-visible:bg-blue-700",
    "focus-visible:ring-blue-700",
    "dark:focus-visible:ring-blue-300",
  );

  expect(restoreBackupButton).toHaveClass(
    "border-blue-500",
    "text-blue-700",
    "hover:bg-blue-50",
    "focus-visible:bg-blue-50",
    "focus-visible:ring-blue-700",
    "dark:text-blue-300",
    "dark:hover:bg-blue-950/40",
    "dark:focus-visible:bg-blue-950/40",
    "dark:focus-visible:ring-blue-300",
  );
};

describe("EventListScreen action colors", () => {
  it("空リスト画面のExcel/JSON操作をAA配色と明瞭なフォーカス表示にする", () => {
    renderEventListScreen([]);

    expectAccessibleActionColors();
  });

  it("保存済みリスト画面でも同じAA配色を維持する", () => {
    renderEventListScreen(["夏イベント"]);

    expectAccessibleActionColors();
  });
});
