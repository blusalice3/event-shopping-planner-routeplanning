import { describe, expect, it, vi } from "vitest";
import { createStartupRecoveryBundle } from "./persistenceResilience";
import { exportStartupRecoveryBundle } from "./persistenceRecoveryExport";

const recoveryBundle = createStartupRecoveryBundle({
  capturedAt: "2026-08-03T00:00:00.000Z",
  issues: [
    {
      stage: "startup",
      code: "conflict",
      message: "保存候補を一意に選べません。",
    },
  ],
  candidates: [
    {
      id: "candidate-1",
      source: "legacy-localStorage",
      rawValue: '{"event":"候補"}',
    },
  ],
});

describe("exportStartupRecoveryBundle", () => {
  it("実Blobを作成してdownloadへ渡し、正確なファイル名とbyte数を返す", () => {
    const download = vi.fn();

    const result = exportStartupRecoveryBundle(recoveryBundle, {
      download,
      now: () => new Date("2026-08-03T01:02:03.456Z"),
    });

    expect(result).toEqual({
      status: "completed",
      fileName: "event-shopping-planner-recovery-2026-08-03T01-02-03-456Z.json",
      byteSize: expect.any(Number),
    });
    expect(result.status === "completed" && result.byteSize).toBeGreaterThan(0);
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, fileName] = download.mock.calls[0] as [Blob, string];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(
      result.status === "completed" ? result.byteSize : undefined,
    );
    expect(blob.type).toBe("application/json;charset=utf-8");
    expect(fileName).toBe(
      result.status === "completed" ? result.fileName : undefined,
    );
  });

  it("0 byteになるserializationを拒否し、downloadを呼ばない", () => {
    const download = vi.fn();

    const result = exportStartupRecoveryBundle(recoveryBundle, {
      serialize: () => "",
      download,
    });

    expect(result).toEqual({ status: "failed" });
    expect(download).not.toHaveBeenCalled();
  });

  it("download例外の詳細を伝搬せず失敗結果へ閉じ込める", () => {
    const download = vi.fn(() => {
      throw new Error("非公開の保存候補本文");
    });

    expect(exportStartupRecoveryBundle(recoveryBundle, { download })).toEqual({
      status: "failed",
    });
    expect(download).toHaveBeenCalledTimes(1);
  });
});
