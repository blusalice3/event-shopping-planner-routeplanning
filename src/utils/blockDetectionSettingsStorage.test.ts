// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../types/map";
import {
  BlockDetectionSettingsRollbackError,
  BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
  loadBlockDetectionSettings,
  loadBlockDetectionSettingsStore,
  readBlockDetectionSettingsStoreForBackup,
  removeBlockDetectionSettingsForEvent,
  renameBlockDetectionSettingsForEvent,
  replaceBlockDetectionSettingsForEvent,
  runWithBlockDetectionSettingsRestore,
  saveBlockDetectionSettings,
} from "./blockDetectionSettingsStorage";

const makeSettings = (maxBlockNameLength: number) => ({
  ...DEFAULT_BLOCK_DETECTION_SETTINGS,
  maxBlockNameLength,
  allowedCharTypes: {
    ...DEFAULT_BLOCK_DETECTION_SETTINGS.allowedCharTypes,
  },
});

describe("blockDetectionSettingsStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("イベントごとの設定を保存し、指定イベントだけを読み込む", () => {
    saveBlockDetectionSettings("春イベント", makeSettings(3));
    saveBlockDetectionSettings("夏イベント", makeSettings(5));

    expect(loadBlockDetectionSettings("春イベント")).toEqual(makeSettings(3));
    expect(loadBlockDetectionSettingsStore(["夏イベント"])).toEqual({
      夏イベント: makeSettings(5),
    });
  });

  it("壊れた保存値は利用せず、安全な空設定として扱う", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        春イベント: {
          ...makeSettings(3),
          polygonThreshold: 101,
        },
      }),
    );

    expect(loadBlockDetectionSettings("春イベント")).toBeNull();
    expect(loadBlockDetectionSettingsStore()).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it("対象外の壊れた孤立設定は、現行イベントの読込を妨げない", () => {
    localStorage.setItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        現行イベント: makeSettings(4),
        削除済みイベント: {
          ...makeSettings(5),
          polygonThreshold: 101,
        },
      }),
    );

    expect(loadBlockDetectionSettings("現行イベント")).toEqual(makeSettings(4));
    expect(loadBlockDetectionSettingsStore(["現行イベント"])).toEqual({
      現行イベント: makeSettings(4),
    });
  });

  it("バックアップ対象の設定が壊れている場合は欠落させず失敗にする", () => {
    localStorage.setItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        現行イベント: {
          ...makeSettings(4),
          maxRegionSize: "2000",
        },
      }),
    );

    expect(() =>
      readBlockDetectionSettingsStoreForBackup(["現行イベント"]),
    ).toThrow("現行イベント");
  });

  it("対象イベントだけを置換・削除し、他イベントを保持する", () => {
    saveBlockDetectionSettings("春イベント", makeSettings(3));
    saveBlockDetectionSettings("夏イベント", makeSettings(5));

    replaceBlockDetectionSettingsForEvent("春イベント", makeSettings(7));
    expect(loadBlockDetectionSettingsStore()).toEqual({
      春イベント: makeSettings(7),
      夏イベント: makeSettings(5),
    });

    replaceBlockDetectionSettingsForEvent("春イベント", null);
    expect(loadBlockDetectionSettingsStore()).toEqual({
      夏イベント: makeSettings(5),
    });
  });

  it("イベント名の変更と削除へ設定を追従させる", () => {
    saveBlockDetectionSettings("旧イベント", makeSettings(3));
    saveBlockDetectionSettings("保持イベント", makeSettings(5));
    saveBlockDetectionSettings("新イベント", makeSettings(7));

    renameBlockDetectionSettingsForEvent("旧イベント", "新イベント");
    expect(loadBlockDetectionSettingsStore()).toEqual({
      新イベント: makeSettings(3),
      保持イベント: makeSettings(5),
    });

    removeBlockDetectionSettingsForEvent("新イベント");
    expect(loadBlockDetectionSettingsStore()).toEqual({
      保持イベント: makeSettings(5),
    });
  });

  it("復元後の処理が失敗した場合、元の保存文字列へ戻せる", () => {
    const original = '{"夏イベント":{"custom":"preserve-exactly"}}';
    localStorage.setItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY, original);

    expect(() =>
      replaceBlockDetectionSettingsForEvent("春イベント", makeSettings(4)),
    ).toThrow("夏イベント");
    expect(localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY)).toBe(
      original,
    );

    localStorage.clear();
    saveBlockDetectionSettings("夏イベント", makeSettings(5));
    const validOriginal = localStorage.getItem(
      BLOCK_DETECTION_SETTINGS_STORAGE_KEY,
    );
    const rollback = replaceBlockDetectionSettingsForEvent(
      "春イベント",
      makeSettings(4),
    );

    rollback();

    expect(localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY)).toBe(
      validOriginal,
    );
  });

  it("関連データの保存失敗時だけ設定をロールバックする", async () => {
    saveBlockDetectionSettings("春イベント", makeSettings(3));
    const original = localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY);

    await expect(
      runWithBlockDetectionSettingsRestore(
        "春イベント",
        makeSettings(7),
        async () => {
          throw new Error("IndexedDB failure");
        },
      ),
    ).rejects.toThrow("IndexedDB failure");
    expect(localStorage.getItem(BLOCK_DETECTION_SETTINGS_STORAGE_KEY)).toBe(
      original,
    );

    await runWithBlockDetectionSettingsRestore(
      "春イベント",
      makeSettings(6),
      async () => "saved",
    );
    expect(loadBlockDetectionSettings("春イベント")).toEqual(makeSettings(6));
  });

  it("設定ロールバック自体が失敗した場合は専用エラーで通知する", async () => {
    saveBlockDetectionSettings("春イベント", makeSettings(3));
    const originalSetItem = Storage.prototype.setItem;
    const rollbackError = new Error("localStorage rollback failure");
    let writeCount = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      writeCount += 1;
      if (writeCount === 2) throw rollbackError;
      originalSetItem.call(this, key, value);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const commitError = new Error("IndexedDB failure");

    let caught: unknown;
    try {
      await runWithBlockDetectionSettingsRestore(
        "春イベント",
        makeSettings(7),
        async () => {
          throw commitError;
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BlockDetectionSettingsRollbackError);
    expect(caught).toMatchObject({
      originalError: commitError,
      rollbackError,
    });
    expect(loadBlockDetectionSettings("春イベント")).toEqual(makeSettings(7));
  });
});
