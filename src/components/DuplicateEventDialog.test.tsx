// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EventMetadata, ShoppingItem } from "../types/item";
import {
  analyzeDuplicateEventImport,
  type DifferentSourceEventAnalysis,
  type ImportedShoppingItem,
  type SameSourceEventAnalysis,
} from "../features/events/duplicateEvent";
import DuplicateEventDialog from "./DuplicateEventDialog";

const incomingItem: ImportedShoppingItem = {
  circle: "サークルA",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊",
  price: 1000,
  quantity: 1,
  remarks: "",
};

const existingItem: ShoppingItem = {
  id: "existing",
  purchaseStatus: "None",
  ...incomingItem,
};

const metadata = (documentId: string): EventMetadata => ({
  spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${documentId}/edit`,
  spreadsheetSheetName: "品目表",
  lastImportDate: "2026-01-01T00:00:00.000Z",
});

function differentSourceAnalysis(): DifferentSourceEventAnalysis {
  const analysis = analyzeDuplicateEventImport({
    eventName: "既存イベント",
    incomingItems: [incomingItem, { ...incomingItem, number: "02a" }],
    incomingSource: {
      url: "https://docs.google.com/spreadsheets/d/new-doc/edit",
      sheetName: "品目表",
    },
    eventLists: { 既存イベント: [existingItem] },
    eventMetadata: { 既存イベント: metadata("old-doc") },
  });
  if (analysis.kind !== "different-source") {
    throw new Error("expected different-source");
  }
  return analysis;
}

function sameSourceAnalysis(): SameSourceEventAnalysis {
  const analysis = analyzeDuplicateEventImport({
    eventName: "既存イベント",
    incomingItems: [incomingItem],
    incomingSource: {
      url: "https://docs.google.com/spreadsheets/d/same-doc/view",
      sheetName: " 品目表 ",
    },
    eventLists: { 既存イベント: [existingItem] },
    eventMetadata: { 既存イベント: metadata("same-doc") },
  });
  if (analysis.kind !== "same-source") {
    throw new Error("expected same-source");
  }
  return analysis;
}

describe("DuplicateEventDialog", () => {
  it("別更新元では安全な別名作成を推奨し、既存名を拒否する", () => {
    const onResolve = vi.fn();
    render(
      <DuplicateEventDialog
        analysis={differentSourceAnalysis()}
        existingEventNames={["既存イベント", "使用中"]}
        onResolve={onResolve}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/別名作成（推奨）/)).toBeChecked();
    const aliasInput = screen.getByLabelText("新しいイベント名");
    fireEvent.change(aliasInput, { target: { value: " 使用中 " } });

    expect(
      screen.getByText(
        "この名前はすでに使用中です。別の名前を入力してください。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "別名で作成" })).toBeDisabled();

    fireEvent.change(aliasInput, {
      target: { value: "既存イベント（夏版）" },
    });
    fireEvent.click(screen.getByRole("button", { name: "別名で作成" }));

    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "create-alias",
        originalEventName: "既存イベント",
        eventName: "既存イベント（夏版）",
      }),
    );
  });

  it("固定品目追加は完全一致の除外件数と追加対象だけを返す", () => {
    const onResolve = vi.fn();
    render(
      <DuplicateEventDialog
        analysis={differentSourceAnalysis()}
        existingEventNames={["既存イベント"]}
        onResolve={onResolve}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("固定品目として追加"));
    expect(
      screen.getByText("完全一致の1件は追加対象から除かれます。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "固定品目として追加" }));

    expect(onResolve).toHaveBeenCalledWith({
      action: "append-fixed-items",
      eventName: "既存イベント",
      items: [{ ...incomingItem, number: "02a" }],
      duplicateItemCount: 1,
      itemSource: "app",
    });
  });

  it("更新元切替は危険を説明し、即時更新ではなく差分確認を返す", () => {
    const onResolve = vi.fn();
    render(
      <DuplicateEventDialog
        analysis={differentSourceAnalysis()}
        existingEventNames={["既存イベント"]}
        onResolve={onResolve}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("更新元を切り替える"));
    expect(
      screen.getByText(/次回以降は新しい表の内容が基準になります/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "差分確認へ" }));

    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "switch-source",
        eventName: "既存イベント",
        nextStep: "review-update-diff",
      }),
    );
  });

  it("同じ更新元では自動更新せず「アイテム更新へ」だけを提示する", () => {
    const onResolve = vi.fn();
    render(
      <DuplicateEventDialog
        analysis={sameSourceAnalysis()}
        existingEventNames={["既存イベント"]}
        onResolve={onResolve}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/まだ内容は書き換わりません/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/別名作成/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "アイテム更新へ" }));

    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "open-update",
        eventName: "既存イベント",
        nextStep: "review-update-diff",
      }),
    );
  });
});
