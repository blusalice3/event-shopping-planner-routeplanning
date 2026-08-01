import { describe, expect, it, vi } from "vitest";
import { settleEventUpdatePreviewIfCurrent } from "./sourceSwitchPreview";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("settleEventUpdatePreviewIfCurrent", () => {
  it("commits the preview while its request is still current", async () => {
    const commit = vi.fn();
    const onError = vi.fn();

    await expect(
      settleEventUpdatePreviewIfCurrent({
        loadPreview: async () => "current-preview",
        isCurrent: () => true,
        commit,
        onError,
      }),
    ).resolves.toBe("committed");

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("current-preview");
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not let an older response overwrite a newer update preview", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const commit = vi.fn();
    const onError = vi.fn();
    let currentEpoch = 1;

    const firstResult = settleEventUpdatePreviewIfCurrent({
      loadPreview: () => first.promise,
      isCurrent: () => currentEpoch === 1,
      commit,
      onError,
    });

    currentEpoch = 2;
    const secondResult = settleEventUpdatePreviewIfCurrent({
      loadPreview: () => second.promise,
      isCurrent: () => currentEpoch === 2,
      commit,
      onError,
    });

    second.resolve("second-preview");
    await expect(secondResult).resolves.toBe("committed");
    first.resolve("first-preview");
    await expect(firstResult).resolves.toBe("stale");

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith("second-preview");
    expect(onError).not.toHaveBeenCalled();
  });

  it("discards a completion after the target event is edited", async () => {
    const deferred = createDeferred<string>();
    const commit = vi.fn();
    const onError = vi.fn();
    const requestedItems = [{ id: "item-1", protectionLevel: "none" }];
    let currentItems: typeof requestedItems | undefined = requestedItems;

    const result = settleEventUpdatePreviewIfCurrent({
      loadPreview: () => deferred.promise,
      isCurrent: () => currentItems === requestedItems,
      commit,
      onError,
    });

    currentItems = [{ id: "item-1", protectionLevel: "full" }];
    deferred.resolve("preview-before-edit");

    await expect(result).resolves.toBe("stale");
    expect(commit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("discards a completion after the target event is deleted", async () => {
    const deferred = createDeferred<string>();
    const commit = vi.fn();
    const onError = vi.fn();
    const requestedItems = [{ id: "item-1" }];
    let currentItems: typeof requestedItems | undefined = requestedItems;

    const result = settleEventUpdatePreviewIfCurrent({
      loadPreview: () => deferred.promise,
      isCurrent: () => currentItems === requestedItems,
      commit,
      onError,
    });

    currentItems = undefined;
    deferred.resolve("preview-before-delete");

    await expect(result).resolves.toBe("stale");
    expect(commit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("suppresses an obsolete request failure after a newer request starts", async () => {
    const deferred = createDeferred<string>();
    const commit = vi.fn();
    const onError = vi.fn();
    let currentEpoch = 1;

    const result = settleEventUpdatePreviewIfCurrent({
      loadPreview: () => deferred.promise,
      isCurrent: () => currentEpoch === 1,
      commit,
      onError,
    });

    currentEpoch = 2;
    deferred.reject(new Error("obsolete request failed"));

    await expect(result).resolves.toBe("stale");
    expect(commit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
