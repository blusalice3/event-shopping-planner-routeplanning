import { describe, expect, it } from "vitest";
import {
  LIST_RENDERER_PREFERENCE_STORAGE_KEY,
  resolveListRendererPreference,
} from "./ListRendererPreferencePort";
import { createLocalStorageListRendererPreferenceAdapter } from "./localStorageListRendererPreferenceAdapter";

class MemoryStorage {
  readonly values = new Map<string, string>();
  throwOnRead = false;
  throwOnWrite = false;

  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error("read unavailable");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("write unavailable");
    this.values.set(key, value);
  }
}

describe("versioned list renderer preference", () => {
  it("defaults a missing preference to auto", () => {
    const port = createLocalStorageListRendererPreferenceAdapter(
      new MemoryStorage(),
    );

    expect(port.read()).toEqual({ status: "missing" });
    expect(resolveListRendererPreference(port.read())).toBe("auto");
  });

  it("round-trips the strict v1 shape", () => {
    const storage = new MemoryStorage();
    const port = createLocalStorageListRendererPreferenceAdapter(storage);

    expect(port.write("full")).toBe(true);
    expect(storage.values.get(LIST_RENDERER_PREFERENCE_STORAGE_KEY)).toBe(
      '{"version":1,"value":"full"}',
    );
    expect(port.read()).toEqual({ status: "ok", value: "full" });
  });

  it.each([
    "not-json",
    "null",
    '{"version":2,"value":"auto"}',
    '{"version":1,"value":"virtual"}',
    '{"version":1,"value":"auto","future":true}',
  ])("fails corrupt or unknown values closed to full: %s", (rawValue) => {
    const storage = new MemoryStorage();
    storage.values.set(LIST_RENDERER_PREFERENCE_STORAGE_KEY, rawValue);
    const result =
      createLocalStorageListRendererPreferenceAdapter(storage).read();

    expect(result).toEqual({ status: "invalid" });
    expect(resolveListRendererPreference(result)).toBe("full");
  });

  it("contains unavailable storage reads and writes", () => {
    const storage = new MemoryStorage();
    const port = createLocalStorageListRendererPreferenceAdapter(storage);
    storage.throwOnRead = true;
    storage.throwOnWrite = true;

    expect(port.read()).toEqual({ status: "unavailable" });
    expect(resolveListRendererPreference(port.read())).toBe("full");
    expect(port.write("auto")).toBe(false);
  });
});
