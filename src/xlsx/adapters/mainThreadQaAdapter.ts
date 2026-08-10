import { exportToXlsx, importFromXlsx } from "../engine/eventWorkbookEngine";
import { parseMapFile } from "../engine/mapWorkbookEngine";
import type {
  ExportSnapshot,
  XlsxImportRequest,
  XlsxImportResult,
} from "../domain/types";
import type { XlsxExecutionPort } from "../port/XlsxExecutionPort";

type LegacyExportArguments = Parameters<typeof exportToXlsx>;

export type MainThreadQaAdapterDependencies = {
  createFile(input: ArrayBuffer, name: string): File;
  importEvent(file: File): ReturnType<typeof importFromXlsx>;
  importMap(
    file: File,
    settings: Parameters<typeof parseMapFile>[1],
  ): ReturnType<typeof parseMapFile>;
  exportEvent(
    eventName: LegacyExportArguments[0],
    items: LegacyExportArguments[1],
    options: LegacyExportArguments[2],
    additionalData: LegacyExportArguments[3],
  ): ReturnType<typeof exportToXlsx>;
};

const defaultDependencies: MainThreadQaAdapterDependencies = {
  createFile: (input, name) =>
    new File([input], name, {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
  importEvent: importFromXlsx,
  importMap: parseMapFile,
  exportEvent: exportToXlsx,
};

const abortError = (): Error => {
  try {
    return new DOMException("XLSX QA operation was aborted.", "AbortError");
  } catch {
    const error = new Error("XLSX QA operation was aborted.");
    error.name = "AbortError";
    return error;
  }
};

const assertNotAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError();
};

/**
 * Explicit, nonproduction semantic-parity adapter.
 *
 * Production composition must instantiate WorkerXlsxExecutionPort instead.
 * This class never acts as a runtime fallback for a Worker error.
 */
export class MainThreadQaXlsxExecutionPort implements XlsxExecutionPort {
  readonly #dependencies: MainThreadQaAdapterDependencies;

  constructor(
    dependencyOverrides: Partial<MainThreadQaAdapterDependencies> = {},
  ) {
    if (import.meta.env.PROD) {
      throw new Error(
        "The main-thread XLSX adapter is forbidden in production builds.",
      );
    }
    this.#dependencies = {
      ...defaultDependencies,
      ...dependencyOverrides,
    };
  }

  async importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
  ): Promise<XlsxImportResult> {
    assertNotAborted(signal);
    const file = this.#dependencies.createFile(request.input, request.fileName);
    if (request.kind === "event-import") {
      const value = await this.#dependencies.importEvent(file);
      assertNotAborted(signal);
      return { kind: request.kind, value };
    }
    const value = await this.#dependencies.importMap(file, request.settings);
    assertNotAborted(signal);
    return { kind: request.kind, value };
  }

  async exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    assertNotAborted(signal);
    const blob = await this.#dependencies.exportEvent(
      snapshot.eventName,
      snapshot.items,
      snapshot.options,
      snapshot.additionalData,
    );
    assertNotAborted(signal);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assertNotAborted(signal);
    return bytes;
  }
}
