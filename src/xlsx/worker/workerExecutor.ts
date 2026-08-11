import { exportToXlsx, importFromXlsx } from "../engine/eventWorkbookEngine";
import { parseMapFile } from "../engine/mapWorkbookEngine";
import type { XlsxImportResult, XlsxProgress } from "../domain/types";
import { preflightXlsx, XlsxPreflightError } from "../security/zipPreflight";
import { XlsxWorkerOperationError, type WorkerExecutor } from "./workerServer";

const XLSX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const abortError = (): Error => {
  try {
    return new DOMException("XLSX operation was aborted.", "AbortError");
  } catch {
    const error = new Error("XLSX operation was aborted.");
    error.name = "AbortError";
    return error;
  }
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortError();
};

const mapPreflightError = (error: unknown): never => {
  if (!(error instanceof XlsxPreflightError)) throw error;
  if (error.category === "aborted") {
    throw new XlsxWorkerOperationError("ABORTED");
  }
  if (error.category === "resource") {
    throw new XlsxWorkerOperationError("RESOURCE_LIMIT");
  }
  if (error.category === "unsupported") {
    throw new XlsxWorkerOperationError("UNSUPPORTED_BROWSER");
  }
  throw new XlsxWorkerOperationError("SECURITY_REJECTED");
};

const preflight = async (
  input: ArrayBuffer,
  signal: AbortSignal,
  progress: (value: XlsxProgress) => void,
): Promise<void> => {
  try {
    await preflightXlsx(input, { signal, progress });
  } catch (error) {
    mapPreflightError(error);
  }
};

const asFile = (input: ArrayBuffer, name: string): File =>
  ({
    name,
    type: XLSX_MIME_TYPE,
    arrayBuffer: async () => input,
  }) as File;

export const xlsxWorkerExecutor: WorkerExecutor = {
  async importWorkbook(request, signal, progress): Promise<XlsxImportResult> {
    await preflight(request.input, signal, progress);
    throwIfAborted(signal);
    progress({ phase: "parse", completed: 0, total: 1 });

    if (request.kind === "event-import") {
      const value = await importFromXlsx(
        asFile(request.input, request.fileName),
        request.input,
      );
      throwIfAborted(signal);
      progress({ phase: "parse", completed: 1, total: 1 });
      return { kind: request.kind, value };
    }

    const value = await parseMapFile(
      asFile(request.input, request.fileName),
      request.settings,
      request.input,
    );
    throwIfAborted(signal);
    progress({ phase: "parse", completed: 1, total: 1 });
    return { kind: request.kind, value };
  },

  async exportWorkbook(snapshot, signal, progress): Promise<Uint8Array> {
    throwIfAborted(signal);
    progress({ phase: "serialize", completed: 0, total: 1 });
    const blob = await exportToXlsx(
      snapshot.eventName,
      snapshot.items,
      snapshot.options,
      snapshot.additionalData,
    );
    throwIfAborted(signal);
    const output = await blob.arrayBuffer();
    throwIfAborted(signal);
    progress({ phase: "serialize", completed: 1, total: 1 });

    // Generated workbooks pass the same closed resource/security contract
    // before their bytes are exposed to a download side effect.
    await preflight(output, signal, progress);
    throwIfAborted(signal);
    return new Uint8Array(output);
  },
};
