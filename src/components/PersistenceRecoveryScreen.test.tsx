// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PersistenceRecoveryScreen from "./PersistenceRecoveryScreen";

const defaultProps = {
  message: "旧データと保存済みデータの新旧を安全に判定できません。",
  details: [
    "イベントリストの内容が競合しています。",
    "原本は保持されています。",
  ],
  canExport: true,
  isRetrying: false,
  onRetry: vi.fn(),
  onExport: vi.fn(),
};

describe("PersistenceRecoveryScreen", () => {
  it("通常画面と自動保存を止めて候補を保持することを表示する", () => {
    render(<PersistenceRecoveryScreen {...defaultProps} />);

    const main = screen.getByRole("main");
    expect(main).toHaveAccessibleName("保存データを安全に読み込めませんでした");
    expect(main).toHaveTextContent(
      "通常画面への反映とイベント・マップデータの自動保存は開始していません",
    );
    expect(main).toHaveTextContent(
      "安全を確認できない移行元・退避候補は自動削除せず",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(defaultProps.message);
    expect(
      screen.getByRole("list", { name: "読み込み失敗の詳細" }),
    ).toHaveTextContent(defaultProps.details.join(""));
  });

  it("再試行と保存候補のJSON退避を実行できる", () => {
    const onRetry = vi.fn();
    const onExport = vi.fn();
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        onRetry={onRetry}
        onExport={onExport}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "読み込みを再試行" }));
    fireEvent.click(
      screen.getByRole("button", { name: "保存候補をJSONで退避" }),
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it("退避用データがない場合はJSON退避を無効化して理由を示す", () => {
    const onExport = vi.fn();
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        canExport={false}
        onExport={onExport}
      />,
    );

    const exportButton = screen.getByRole("button", {
      name: "保存候補をJSONで退避",
    });
    const reason =
      "退避できる保存候補を準備できていないため、JSONで退避できません。";
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAccessibleDescription(reason);
    expect(screen.getByText(reason)).toBeVisible();
    fireEvent.click(exportButton);
    expect(onExport).not.toHaveBeenCalled();
  });

  it("再試行中は状態を伝え、回復操作の重複実行を防ぐ", () => {
    const onRetry = vi.fn();
    const onExport = vi.fn();
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        isRetrying
        onRetry={onRetry}
        onExport={onExport}
      />,
    );

    const main = screen.getByRole("main");
    const retryButton = screen.getByRole("button", {
      name: "読み込みを再試行中…",
    });
    const exportButton = screen.getByRole("button", {
      name: "保存候補をJSONで退避",
    });

    expect(main).toHaveAttribute("aria-busy", "true");
    expect(retryButton).toBeDisabled();
    expect(exportButton).toBeDisabled();
    fireEvent.click(retryButton);
    fireEvent.click(exportButton);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
  });
});
