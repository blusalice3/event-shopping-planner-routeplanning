// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import BackupRestoreDialog, {
  createUniqueRestoredEventName,
} from "./BackupRestoreDialog";

describe("createUniqueRestoredEventName", () => {
  it("既存名と重ならない復元名を連番で作る", () => {
    expect(
      createUniqueRestoredEventName("春イベント", [
        "春イベント（復元）",
        "春イベント（復元2）",
      ]),
    ).toBe("春イベント（復元3）");
  });
});

describe("BackupRestoreDialog", () => {
  it("別名復元を既定にして、選んだ復元元と復元先を渡す", async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);

    render(
      <BackupRestoreDialog
        isOpen
        backupEventNames={["春イベント"]}
        currentEventNames={["春イベント"]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );

    expect(screen.getByLabelText(/別名で復元（推奨）/)).toBeChecked();
    expect(screen.getByLabelText("復元後のイベント名")).toHaveValue(
      "春イベント（復元）",
    );

    fireEvent.click(screen.getByRole("button", { name: "別名で復元" }));

    await waitFor(() => {
      expect(onRestore).toHaveBeenCalledWith(
        "春イベント",
        "春イベント（復元）",
      );
    });
  });

  it("既存名への別名復元を止め、置換時は警告と専用ボタンを表示する", () => {
    render(
      <BackupRestoreDialog
        isOpen
        backupEventNames={["春イベント"]}
        currentEventNames={["春イベント", "使用中"]}
        onClose={vi.fn()}
        onRestore={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("復元後のイベント名"), {
      target: { value: "使用中" },
    });
    expect(
      screen.getByText("この名前は使用中です。別の名前を入力してください。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "別名で復元" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/同名で置換/));
    expect(
      screen.getByText("現在の「春イベント」の全データが置き換わります。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "置換して復元" })).toBeEnabled();
  });

  it("親の再描画では選択と復元中状態を初期化しない", async () => {
    let finishRestore!: () => void;
    const onRestore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRestore = resolve;
        }),
    );
    const { rerender } = render(
      <BackupRestoreDialog
        isOpen
        backupEventNames={["春イベント", "夏イベント"]}
        currentEventNames={["春イベント"]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );

    fireEvent.change(screen.getByLabelText("復元するイベント"), {
      target: { value: "夏イベント" },
    });
    fireEvent.click(screen.getByRole("button", { name: "別名で復元" }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "復元中…" })).toBeDisabled();

    rerender(
      <BackupRestoreDialog
        isOpen
        backupEventNames={["春イベント", "夏イベント"]}
        currentEventNames={["春イベント"]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );

    expect(screen.getByLabelText("復元するイベント")).toHaveValue("夏イベント");
    expect(screen.getByRole("button", { name: "復元中…" })).toBeDisabled();

    await act(async () => {
      finishRestore();
      await Promise.resolve();
    });
  });
});
