// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StartupRecoveryCandidate } from "../utils/persistenceResilience";
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

const recoveryCandidates = [
  {
    id: "runtime-candidate",
    source: "runtime-fallback",
    role: "app-payload",
    adoptable: true,
    storeName: "events",
    key: "event-list",
    sourceKey: "runtime-envelope-key",
    targetKey: "data",
    revision: "revision-12",
    digest: "sha256:runtime-candidate",
    payload: { title: "画面に表示してはいけない極秘イベント" },
    rawValue: "画面に表示してはいけないraw本文",
  },
  {
    id: "legacy-candidate",
    source: "legacy-localStorage",
    role: "legacy-migration-source",
    adoptable: false,
    storeName: "mapData",
    key: "legacy-map",
    sourceKey: "mapData",
    targetKey: "data",
    revision: "revision-9",
    digest: "sha256:legacy-candidate",
    payload: { secret: "候補2の非公開payload" },
  },
] satisfies readonly StartupRecoveryCandidate[];

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
    const exitButton = screen.getByRole("button", {
      name: "何も削除せず終了",
    });

    expect(main).toHaveAttribute("aria-busy", "true");
    expect(retryButton).toBeDisabled();
    expect(exportButton).toBeDisabled();
    expect(exitButton).toBeDisabled();
    fireEvent.click(retryButton);
    fireEvent.click(exportButton);
    fireEvent.click(exitButton);
    expect(onRetry).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        name: "保存データを安全に読み込めませんでした",
      }),
    ).toBeVisible();
  });

  it("候補ごとの識別情報と自動採用しない理由だけを表示する", () => {
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        candidates={recoveryCandidates}
        onAdopt={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("group", { name: "明示的に採用する保存候補" }),
    ).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByText("runtime-fallback")).toBeVisible();
    expect(screen.getByText("events")).toBeVisible();
    expect(screen.getByText("event-list")).toBeVisible();
    expect(screen.getByText("revision-12")).toBeVisible();
    expect(screen.getByText("sha256:runtime-candidate")).toBeVisible();
    expect(screen.getByText("legacy-localStorage")).toBeVisible();
    expect(screen.getAllByText("なぜ自動採用しないか:")).toHaveLength(2);
    expect(
      screen.getByText(
        "実行時フォールバックが確定済みrootから連続する保存か安全に証明できないためです。",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("画面に表示してはいけない極秘イベント"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("画面に表示してはいけないraw本文"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("候補2の非公開payload")).not.toBeInTheDocument();
  });

  it("radioで選んだ候補だけを警告付きで明示採用し、二重実行を防ぐ", () => {
    const onAdopt = vi.fn();
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        candidates={recoveryCandidates}
        onAdopt={onAdopt}
      />,
    );

    const adoptButton = screen.getByRole("button", {
      name: "選択候補を明示的に採用",
    });
    expect(adoptButton).toBeDisabled();
    expect(adoptButton).toHaveAccessibleDescription(
      expect.stringContaining(
        "先にJSONで退避し、内容を確認できた候補だけを選択してください。",
      ),
    );
    expect(adoptButton).toHaveAccessibleDescription(
      expect.stringContaining("旧原本と未選択候補は削除しません"),
    );
    expect(adoptButton).toHaveAccessibleDescription(
      expect.stringContaining("明示的に採用する候補を1つ選択してください。"),
    );

    const [runtimeCandidateRadio, legacyCandidateRadio] =
      screen.getAllByRole("radio");
    expect(legacyCandidateRadio).toBeDisabled();
    expect(legacyCandidateRadio).not.toBeChecked();
    expect(adoptButton).toBeDisabled();

    fireEvent.click(runtimeCandidateRadio);
    expect(runtimeCandidateRadio).toBeChecked();
    expect(adoptButton).toBeEnabled();

    fireEvent.click(adoptButton);
    fireEvent.click(adoptButton);

    expect(onAdopt).toHaveBeenCalledTimes(1);
    expect(onAdopt).toHaveBeenCalledWith("runtime-candidate");
    expect(
      screen.getByRole("button", { name: "選択候補を採用中…" }),
    ).toBeDisabled();
    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
  });

  it("採用中は候補選択とほかの回復操作を無効化し、失敗理由を通知する", () => {
    const onRetry = vi.fn();
    const onExport = vi.fn();
    const onAdopt = vi.fn();
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        candidates={recoveryCandidates}
        isAdopting
        adoptionError="候補のdigestを検証できませんでした。"
        onRetry={onRetry}
        onExport={onExport}
        onAdopt={onAdopt}
      />,
    );

    expect(screen.getByRole("main")).toHaveAttribute("aria-busy", "true");
    screen.getAllByRole("radio").forEach((radio) => {
      expect(radio).toBeDisabled();
    });
    expect(
      screen.getByRole("button", { name: "選択候補を採用中…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "読み込みを再試行" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "保存候補をJSONで退避" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "何も削除せず終了" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "候補を採用できませんでした。候補のdigestを検証できませんでした。",
      ),
    ).toHaveAttribute("role", "alert");
  });

  it("何も削除せず終了してもblocking画面を保ち、タブを閉じる案内だけを示す", () => {
    const onRetry = vi.fn();
    const onExport = vi.fn();
    const onAdopt = vi.fn();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    render(
      <PersistenceRecoveryScreen
        {...defaultProps}
        candidates={recoveryCandidates}
        onRetry={onRetry}
        onExport={onExport}
        onAdopt={onAdopt}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "何も削除せず終了" }));

    const main = screen.getByRole("main");
    const title = screen.getByRole("heading", {
      name: "何も削除せず終了しました",
    });
    expect(main).toHaveAccessibleName("何も削除せず終了しました");
    expect(main).toHaveTextContent(
      "保存候補と旧原本は削除も変更もしていません",
    );
    expect(main).toHaveTextContent("このタブ（画面）を閉じてください");
    expect(title).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "読み込みを再試行" }),
    ).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
    expect(onExport).not.toHaveBeenCalled();
    expect(onAdopt).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });
});
