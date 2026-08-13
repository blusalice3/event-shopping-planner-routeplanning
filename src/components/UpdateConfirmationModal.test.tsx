// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppFieldSyncCandidate } from "../features/events/updateDiff";
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
      priceSyncMode: "preserve",
      remarksSyncMode: "preserve",
    });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /スプレッドシートの予定数量へ変更する/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "更新を実行" }));
    expect(onConfirm).toHaveBeenLastCalledWith({
      applyPurchasedQuantityChanges: true,
      priceSyncMode: "preserve",
      remarksSyncMode: "preserve",
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

const fillEmptyCandidate: AppFieldSyncCandidate = {
  itemId: "item-fill",
  circle: "サークル補完",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊セット",
  purchaseStatus: "None",
  price: {
    currentValue: null,
    previousSheetValue: null,
    sheetValue: 1200,
    canFillEmpty: true,
  },
  remarks: {
    currentValue: "",
    previousSheetValue: "",
    sheetValue: "会場限定特典付き",
    canFillEmpty: true,
  },
};

const purchasedOverwriteCandidate: AppFieldSyncCandidate = {
  itemId: "item-purchased",
  circle: "サークル購入済",
  eventDate: "1日目",
  block: "東A",
  number: "02b",
  title: "既刊",
  purchaseStatus: "Purchased",
  price: {
    currentValue: 900,
    previousSheetValue: 1000,
    sheetValue: null,
    canFillEmpty: false,
  },
  remarks: {
    currentValue: "利用者の記録",
    previousSheetValue: "旧シート備考",
    sheetValue: "",
    canFillEmpty: false,
  },
};

const purchasedFillEmptyCandidate: AppFieldSyncCandidate = {
  ...fillEmptyCandidate,
  itemId: "item-purchased-fill",
  circle: "サークル購入済補完",
  purchaseStatus: "Purchased",
};

describe("UpdateConfirmationModal app field synchronization", () => {
  it("空欄補完を既定で選択し、対象件数と変更前後を表示する", () => {
    const onConfirm = vi.fn();
    render(
      <UpdateConfirmationModal
        {...commonProps}
        appFieldSyncCandidates={[fillEmptyCandidate]}
        onConfirm={onConfirm}
      />,
    );

    const fillEmptyCheckbox = screen.getByRole("checkbox", {
      name: /今回新しく設定されたシート値を空欄へ補完する/,
    });
    expect(fillEmptyCheckbox).toBeChecked();
    expect(
      screen.getByText(/購入金額 1件、\s*利用者メモ 1件/),
    ).toBeInTheDocument();

    const priceList = screen.getByRole("list", {
      name: "空欄を補完する購入金額の候補",
    });
    expect(
      within(priceList).getByText(/価格未定 → 1,200円/),
    ).toBeInTheDocument();
    const remarksList = screen.getByRole("list", {
      name: "空欄を補完する利用者メモの候補",
    });
    expect(
      within(remarksList).getByText(/（空欄） → 「会場限定特典付き」/),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("checkbox", {
        name: /購入金額をカタログ価格で上書きする/,
      }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: /利用者メモをシート備考で上書きする/,
      }),
    ).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "更新を実行" }));
    expect(onConfirm).toHaveBeenCalledWith({
      applyPurchasedQuantityChanges: false,
      priceSyncMode: "fill-empty",
      remarksSyncMode: "fill-empty",
    });
  });

  it("明示した上書きを優先し、シートの空欄も反映することを警告する", () => {
    const onConfirm = vi.fn();
    render(
      <UpdateConfirmationModal
        {...commonProps}
        appFieldSyncCandidates={[purchasedOverwriteCandidate]}
        onConfirm={onConfirm}
      />,
    );

    expect(
      screen.queryByRole("checkbox", {
        name: /今回新しく設定されたシート値を空欄へ補完する/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/シート側が空欄の場合も購入金額は「価格未定」/),
    ).toBeInTheDocument();
    expect(screen.getByText(/保護された品目は対象外/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /購入金額をカタログ価格で上書きする/,
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "購入済み・限数品目の実購入金額が変更されます：1件",
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /利用者メモをシート備考で上書きする/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "更新を実行" }));

    expect(onConfirm).toHaveBeenCalledWith({
      applyPurchasedQuantityChanges: false,
      priceSyncMode: "overwrite",
      remarksSyncMode: "overwrite",
    });
  });

  it("既定の空欄補完でも購入済み品目の購入金額変更を警告する", () => {
    render(
      <UpdateConfirmationModal
        {...commonProps}
        appFieldSyncCandidates={[purchasedFillEmptyCandidate]}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "購入済み・限数品目の実購入金額が変更されます：1件",
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /今回新しく設定されたシート値を空欄へ補完する/,
      }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("上書きしていない欄だけ空欄補完の選択を適用する", () => {
    const onConfirm = vi.fn();
    render(
      <UpdateConfirmationModal
        {...commonProps}
        appFieldSyncCandidates={[fillEmptyCandidate]}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /利用者メモをシート備考で上書きする/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "更新を実行" }));

    expect(onConfirm).toHaveBeenCalledWith({
      applyPurchasedQuantityChanges: false,
      priceSyncMode: "fill-empty",
      remarksSyncMode: "overwrite",
    });
  });

  it("候補配列が変わると補完と上書きの選択を既定値へ戻す", () => {
    const { rerender } = render(
      <UpdateConfirmationModal
        {...commonProps}
        appFieldSyncCandidates={[fillEmptyCandidate]}
        onConfirm={vi.fn()}
      />,
    );

    const fillEmptyCheckbox = screen.getByRole("checkbox", {
      name: /今回新しく設定されたシート値を空欄へ補完する/,
    });
    const overwritePriceCheckbox = screen.getByRole("checkbox", {
      name: /購入金額をカタログ価格で上書きする/,
    });
    fireEvent.click(fillEmptyCheckbox);
    fireEvent.click(overwritePriceCheckbox);
    expect(fillEmptyCheckbox).not.toBeChecked();
    expect(overwritePriceCheckbox).toBeChecked();

    rerender(
      <UpdateConfirmationModal
        {...commonProps}
        appFieldSyncCandidates={[
          { ...fillEmptyCandidate, itemId: "item-fill-next" },
        ]}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("checkbox", {
        name: /今回新しく設定されたシート値を空欄へ補完する/,
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", {
        name: /購入金額をカタログ価格で上書きする/,
      }),
    ).not.toBeChecked();
  });
});
