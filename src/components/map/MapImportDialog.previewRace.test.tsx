// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BLOCK_DETECTION_SETTINGS,
  type BlockDetectionSettings,
  type DayMapData,
} from "../../types/map";
import type { ParseMapFileResult } from "../../xlsx/domain/mapWorkbook";
import type { XlsxImportKind, XlsxImportResult } from "../../xlsx/domain/types";
import type { XlsxExecutionPort } from "../../xlsx/port/XlsxExecutionPort";
import MapImportDialog from "./MapImportDialog";

const importWorkbookMock = vi.fn<XlsxExecutionPort["importWorkbook"]>();
const xlsxExecutionPort: XlsxExecutionPort = {
  importWorkbook: importWorkbookMock,
  exportWorkbook: vi.fn(),
};

function mapWorkerResult(
  kind: Extract<XlsxImportKind, "map-preview" | "map-import">,
  value: ParseMapFileResult,
): XlsxImportResult {
  return { kind, value };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createMapData(blockName: string): Record<string, DayMapData> {
  return {
    "1日目マップ": {
      maxRow: 1,
      maxCol: 1,
      cells: [],
      mergedCells: [],
      blocks: [
        {
          name: blockName,
          startRow: 1,
          startCol: 1,
          endRow: 1,
          endCol: 1,
          numberCells: [],
        },
      ],
    },
  };
}

function successfulResult(
  data: Record<string, DayMapData>,
): ParseMapFileResult {
  return {
    data,
    skippedSheets: [],
    error: null,
  };
}

function cloneDefaultSettings(): BlockDetectionSettings {
  return {
    ...DEFAULT_BLOCK_DETECTION_SETTINGS,
    allowedCharTypes: {
      ...DEFAULT_BLOCK_DETECTION_SETTINGS.allowedCharTypes,
    },
  };
}

function renderDialog(
  file: File,
  onImport = vi.fn(),
  savedSettings: BlockDetectionSettings | null = null,
) {
  const rendered = render(
    <MapImportDialog
      isOpen
      file={file}
      eventName="対象イベント"
      savedSettings={savedSettings}
      onImport={onImport}
      onClose={vi.fn()}
      xlsxExecutionPort={xlsxExecutionPort}
    />,
  );
  return { ...rendered, onImport };
}

describe("MapImportDialog preview input race", () => {
  beforeEach(() => {
    importWorkbookMock.mockReset();
    vi.stubGlobal("alert", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("discards a deferred preview after settings change and reparses on import", async () => {
    const stalePreview = createDeferred<ParseMapFileResult>();
    const staleData = createMapData("旧設定ブロック");
    const currentData = createMapData("新設定ブロック");
    importWorkbookMock
      .mockReturnValueOnce(
        stalePreview.promise.then((value) =>
          mapWorkerResult("map-preview", value),
        ),
      )
      .mockResolvedValueOnce(
        mapWorkerResult("map-import", successfulResult(currentData)),
      );

    const file = new File(["map"], "map.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      lastModified: 1,
    });
    const { container, onImport } = renderDialog(file);

    fireEvent.click(
      screen.getByRole("button", { name: /ブロック自動検出の詳細設定/ }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /プレビュー（ブロック検出）/ }),
    );
    await waitFor(() => expect(importWorkbookMock).toHaveBeenCalledTimes(1));

    const maxNameLength = container.querySelector<HTMLInputElement>(
      'input[type="range"][min="1"][max="10"]',
    );
    expect(maxNameLength).not.toBeNull();
    fireEvent.change(maxNameLength!, { target: { value: "5" } });

    await act(async () => {
      stalePreview.resolve(successfulResult(staleData));
      await stalePreview.promise;
    });

    expect(screen.queryByText("旧設定ブロック")).not.toBeInTheDocument();
    expect(alert).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(importWorkbookMock).toHaveBeenCalledTimes(2);
    expect(importWorkbookMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        kind: "map-import",
        settings: expect.objectContaining({ maxBlockNameLength: 5 }),
      }),
    );
    expect(onImport).toHaveBeenCalledWith(
      currentData,
      expect.objectContaining({ maxBlockNameLength: 5 }),
      { "1日目マップ": 0 },
    );
  });

  it("discards a deferred preview when the File object changes", async () => {
    const stalePreview = createDeferred<ParseMapFileResult>();
    const currentData = createMapData("差し替え後ブロック");
    importWorkbookMock
      .mockReturnValueOnce(
        stalePreview.promise.then((value) =>
          mapWorkerResult("map-preview", value),
        ),
      )
      .mockResolvedValueOnce(
        mapWorkerResult("map-import", successfulResult(currentData)),
      );

    const fileOptions = {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      lastModified: 10,
    };
    const firstFile = new File(["A"], "same.xlsx", fileOptions);
    const replacementFile = new File(["B"], "same.xlsx", fileOptions);
    const onImport = vi.fn();
    const { container, rerender } = renderDialog(firstFile, onImport);

    fireEvent.click(
      screen.getByRole("button", { name: /ブロック自動検出の詳細設定/ }),
    );
    const maxNameLength = container.querySelector<HTMLInputElement>(
      'input[type="range"][min="1"][max="10"]',
    );
    expect(maxNameLength).not.toBeNull();
    fireEvent.change(maxNameLength!, { target: { value: "5" } });

    fireEvent.click(
      screen.getByRole("button", { name: /プレビュー（ブロック検出）/ }),
    );
    await waitFor(() => expect(importWorkbookMock).toHaveBeenCalledTimes(1));

    rerender(
      <MapImportDialog
        isOpen
        file={replacementFile}
        eventName="対象イベント"
        savedSettings={null}
        onImport={onImport}
        onClose={vi.fn()}
        xlsxExecutionPort={xlsxExecutionPort}
      />,
    );

    expect(
      container.querySelector<HTMLInputElement>(
        'input[type="range"][min="1"][max="10"]',
      )?.value,
    ).toBe("5");

    await act(async () => {
      stalePreview.resolve(
        successfulResult(createMapData("差し替え前ブロック")),
      );
      await stalePreview.promise;
    });

    expect(screen.queryByText("差し替え前ブロック")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(importWorkbookMock).toHaveBeenCalledTimes(2);
    expect(importWorkbookMock.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        kind: "map-import",
        settings: expect.objectContaining({ maxBlockNameLength: 5 }),
      }),
    );
    expect(onImport.mock.calls[0][0]).toBe(currentData);
  });

  it("keeps user adjustments when saved settings rerender with the same content", () => {
    const file = new File(["map"], "map.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      lastModified: 15,
    });
    const savedSettings = cloneDefaultSettings();
    const onImport = vi.fn();
    const { container, rerender } = renderDialog(file, onImport, savedSettings);

    fireEvent.click(
      screen.getByRole("button", { name: /ブロック自動検出の詳細設定/ }),
    );
    const maxNameLength = container.querySelector<HTMLInputElement>(
      'input[type="range"][min="1"][max="10"]',
    );
    expect(maxNameLength).not.toBeNull();
    fireEvent.change(maxNameLength!, { target: { value: "6" } });

    rerender(
      <MapImportDialog
        isOpen
        file={file}
        eventName="対象イベント"
        savedSettings={{
          ...savedSettings,
          allowedCharTypes: { ...savedSettings.allowedCharTypes },
        }}
        onImport={onImport}
        onClose={vi.fn()}
        xlsxExecutionPort={xlsxExecutionPort}
      />,
    );

    expect(
      container.querySelector<HTMLInputElement>(
        'input[type="range"][min="1"][max="10"]',
      )?.value,
    ).toBe("6");
  });

  it("reuses a preview only while its file and settings signature still matches", async () => {
    const previewData = createMapData("再利用ブロック");
    importWorkbookMock.mockResolvedValueOnce(
      mapWorkerResult("map-preview", successfulResult(previewData)),
    );

    const file = new File(["map"], "map.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      lastModified: 20,
    });
    const { onImport } = renderDialog(file);

    fireEvent.click(
      screen.getByRole("button", { name: /プレビュー（ブロック検出）/ }),
    );
    expect(await screen.findByText("再利用ブロック")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(importWorkbookMock).toHaveBeenCalledTimes(1);
    expect(onImport.mock.calls[0][0]).toBe(previewData);
  });
});
