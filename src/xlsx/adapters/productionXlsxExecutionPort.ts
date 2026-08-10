import type {
  ExportSnapshot,
  XlsxImportRequest,
  XlsxImportResult,
} from "../domain/types";
import type {
  XlsxExecutionPort,
  XlsxProgressListener,
} from "../port/XlsxExecutionPort";
import {
  createWorkerXlsxExecutionPort,
  type WorkerXlsxExecutionPort,
} from "./workerXlsxExecutionPort";

type WorkerPortFactory = (
  onProgress?: XlsxProgressListener,
) => WorkerXlsxExecutionPort;

/**
 * Production XLSX composition.
 *
 * Each operation owns a Worker so timeout, cancellation, protocol failure, or
 * a crash can terminate all in-flight engine work without poisoning retries.
 * There is deliberately no main-thread fallback.
 */
export class ProductionXlsxExecutionPort implements XlsxExecutionPort {
  readonly #createPort: WorkerPortFactory;

  constructor(createPort?: WorkerPortFactory) {
    this.#createPort =
      createPort ??
      ((onProgress) =>
        createWorkerXlsxExecutionPort({
          onProgress,
        }));
  }

  importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
    onProgress?: XlsxProgressListener,
  ): Promise<XlsxImportResult> {
    return this.#run(onProgress, (port) =>
      port.importWorkbook(request, signal),
    );
  }

  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
    onProgress?: XlsxProgressListener,
  ): Promise<Uint8Array> {
    return this.#run(onProgress, (port) =>
      port.exportWorkbook(snapshot, signal),
    );
  }

  async #run<T>(
    onProgress: XlsxProgressListener | undefined,
    operation: (port: WorkerXlsxExecutionPort) => Promise<T>,
  ): Promise<T> {
    const port = this.#createPort(onProgress);
    try {
      return await operation(port);
    } finally {
      port.dispose();
    }
  }
}

export const productionXlsxExecutionPort = new ProductionXlsxExecutionPort();
