// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import UpdateConfirmationModal from "./UpdateConfirmationModal";

const commonProps = {
  itemsToDelete: [],
  itemsToUpdate: [],
  itemsToAdd: [],
  onCancel: vi.fn(),
};

describe("UpdateConfirmationModal quantity confirmation", () => {
  it("通常更新では更新元の案内を表示せずキャンセルできる", () => {
    const onCancel = vi.fn();
    render(
      <UpdateConfirmationModal
        {...commonProps}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.queryByText("更新元を切り替えます")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "更新元を切り替えて更新" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("不正数量を利用者向けに説明する", () => {
    render(
      <UpdateConfirmationModal
        {...commonProps}
        quantityWarnings={[
          {
            kind: "new-item-skipped",
            reason: "out-of-range",
            receivedValue: "21",
            circle: "サークルA",
            eventDate: "1日目",
            block: "東A",
            number: "01a",
            title: "新刊",
          },
        ]}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByText("数量を反映できなかった行: 1件"),
    ).toBeInTheDocument();
    expect(screen.getByText(/数量は1～20の整数/)).toBeInTheDocument();
    expect(screen.getByText(/品目を追加しません/)).toBeInTheDocument();
  });

  it("購入済み予定数量を既定では反映せず、チェック時だけ許可する", () => {
    const onConfirm = vi.fn();
    render(
      <UpdateConfirmationModal
        {...commonProps}
        pendingPurchasedQuantityChanges={[
          {
            itemId: "item-1",
            circle: "サークルA",
            eventDate: "1日目",
            block: "東A",
            number: "01a",
            title: "新刊",
            purchaseStatus: "LimitedPurchase",
            currentQuantity: 2,
            nextQuantity: 4,
          },
        ]}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/実際に購入した数量/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "更新を実行" }));
    expect(onConfirm).toHaveBeenLastCalledWith({
      applyPurchasedQuantityChanges: false,
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /スプレッドシートの予定数量へ変更する/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "更新を実行" }));
    expect(onConfirm).toHaveBeenLastCalledWith({
      applyPurchasedQuantityChanges: true,
    });
  });

  it("限数の実購入数以下になる予定数量を反映しない理由を表示する", () => {
    render(
      <UpdateConfirmationModal
        {...commonProps}
        limitedPurchaseQuantityConflicts={[
          {
            itemId: "item-1",
            circle: "サークルA",
            eventDate: "1日目",
            block: "東A",
            number: "01a",
            title: "新刊",
            currentQuantity: 5,
            nextQuantity: 2,
            actualPurchasedQuantity: 3,
          },
        ]}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByText("限数購入の予定数量を反映できない品目: 1件"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/予定数量は実購入数より多い必要があります/),
    ).toBeInTheDocument();
    expect(screen.getByText(/実購入3、予定5 → 2/)).toBeInTheDocument();
  });

  it("更新元切替では新しい接続先とキャンセル時の扱いを表示する", () => {
    render(
      <UpdateConfirmationModal
        {...commonProps}
        nextSource={{
          url: "https://docs.google.com/spreadsheets/d/new-source",
          sheetName: "新刊一覧",
        }}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("更新元を切り替えます")).toBeInTheDocument();
    expect(
      screen.getByText("https://docs.google.com/spreadsheets/d/new-source"),
    ).toBeInTheDocument();
    expect(screen.getByText("新刊一覧")).toBeInTheDocument();
    expect(
      screen.getByText("キャンセルすると、品目も更新元も変更されません。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "更新元を切り替えて更新" }),
    ).toBeInTheDocument();
  });
});
