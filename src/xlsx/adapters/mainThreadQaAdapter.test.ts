import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../../types/map";
import { MainThreadQaXlsxExecutionPort } from "./mainThreadQaAdapter";

const file = { name: "fixture.xlsx" } as File;

describe("explicit main-thread XLSX QA adapter", () => {
  it("preserves closed import kind without committing side effects", async () => {
    const importMap = vi.fn(async (_file: File) => ({
      data: null,
      skippedSheets: [],
      error: null,
    }));
    const adapter = new MainThreadQaXlsxExecutionPort({
      createFile: () => file,
      importMap,
    });
    await expect(
      adapter.importWorkbook(
        {
          kind: "map-preview",
          input: new ArrayBuffer(1),
          fileName: "map.xlsx",
          settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "map-preview",
      value: {
        data: null,
        skippedSheets: [],
        error: null,
      },
    });
    expect(importMap).toHaveBeenCalledWith(
      file,
      DEFAULT_BLOCK_DETECTION_SETTINGS,
    );
  });

  it("rejects an already aborted request before invoking legacy code", async () => {
    const importEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const adapter = new MainThreadQaXlsxExecutionPort({
      createFile: () => file,
      importEvent,
    });
    await expect(
      adapter.importWorkbook(
        {
          kind: "event-import",
          input: new ArrayBuffer(1),
          fileName: "event.xlsx",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(importEvent).not.toHaveBeenCalled();
  });
});
