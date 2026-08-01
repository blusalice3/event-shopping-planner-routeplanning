// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { normalizePersistenceFailure } from "../hooks/useIndexedDbPersistence";
import PersistenceStatusIndicator from "./PersistenceStatusIndicator";

describe("PersistenceStatusIndicator", () => {
  it.each([
    ["unsaved", "未保存"],
    ["saving", "保存中…"],
    ["saved", "保存済み"],
  ] as const)("%s 状態を表示する", (status, label) => {
    render(
      <PersistenceStatusIndicator
        status={status}
        showRoutineStatus
        failedStores={[]}
        onRetry={vi.fn()}
        onExportBackup={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(label);
  });

  it.each(["unsaved", "saving", "saved"] as const)(
    "設定がオフなら %s 状態を表示しない",
    (status) => {
      render(
        <PersistenceStatusIndicator
          status={status}
          showRoutineStatus={false}
          failedStores={[]}
          onRetry={vi.fn()}
          onExportBackup={vi.fn()}
        />,
      );

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    },
  );

  it("失敗箇所と、再試行・バックアップ操作を表示する", () => {
    const onRetry = vi.fn();
    const onExportBackup = vi.fn();
    render(
      <PersistenceStatusIndicator
        status="failed"
        showRoutineStatus={false}
        failedStores={["eventLists", "mapData"]}
        onRetry={onRetry}
        onExportBackup={onExportBackup}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "保存できなかった内容: イベントリスト・マップ",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存を再試行" }));
    fireEvent.click(
      screen.getByRole("button", { name: "JSONバックアップを保存" }),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onExportBackup).toHaveBeenCalledTimes(1);
  });

  it("原因別の対処案と安全化された技術情報を表示する", () => {
    const failureDetails = [
      normalizePersistenceFailure(
        "mapData",
        Object.assign(new Error("map quota"), {
          name: "QuotaExceededError",
        }),
      ),
      normalizePersistenceFailure(
        "eventLists",
        Object.assign(new Error("permission denied"), {
          name: "SecurityError",
        }),
      ),
      normalizePersistenceFailure(
        "executeModeItems",
        Object.assign(new Error("cannot clone"), {
          name: "DataCloneError",
        }),
      ),
      normalizePersistenceFailure(
        "dayModes",
        Object.assign(new Error("database closed"), {
          name: "InvalidStateError",
        }),
      ),
      normalizePersistenceFailure("routeSettings", {
        name: "Odd\nError!",
        message: "first line\r\nsecond line",
      }),
    ];

    render(
      <PersistenceStatusIndicator
        status="failed"
        showRoutineStatus
        failedStores={failureDetails.map(({ storeName }) => storeName)}
        failureDetails={failureDetails}
        onRetry={vi.fn()}
        onExportBackup={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("保存容量が不足しています");
    expect(alert).toHaveTextContent("JSONバックアップを保存");
    expect(alert).toHaveTextContent("サイトデータの保存を許可");
    expect(alert).toHaveTextContent("保存できない形式のデータ");
    expect(alert).toHaveTextContent("保存領域に異常");
    expect(alert).toHaveTextContent("予期しない問題");
    expect(alert).toHaveTextContent(
      "原因コード: OddError / 詳細: first line second line",
    );
  });
});
