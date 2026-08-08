import type {
  ExportSnapshot,
  XlsxImportRequest,
  XlsxImportResult,
} from "../domain/types";
import type { XlsxExecutionPort } from "../port/XlsxExecutionPort";
import {
  createWorkerXlsxExecutionPort,
  type WorkerXlsxExecutionPort,
} from "./workerXlsxExecutionPort";

type WorkerPortFactory = () => WorkerXlsxExecutionPort;

/**
 * Production XLSX composition.
 *
 * Each operation owns a Worker so timeout, cancellation, protocol failure, or
 * a crash can terminate all in-flight engine work without poisoning retries.
 * There is deliberately no main-thread fallback.
 */
export class ProductionXlsxExecutionPort implements XlsxExecutionPort {
  readonly #createPort: WorkerPortFactory;

  constructor(createPort: WorkerPortFactory = createWorkerXlsxExecutionPort) {
    this.#createPort = createPort;
  }

  importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
  ): Promise<XlsxImportResult> {
    return this.#run((port) => port.importWorkbook(request, signal));
  }

  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#run((port) => port.exportWorkbook(snapshot, signal));
  }

  async #run<T>(
    operation: (port: WorkerXlsxExecutionPort) => Promise<T>,
  ): Promise<T> {
    const port = this.#createPort();
    try {
      return await operation(port);
    } finally {
      port.dispose();
    }
  }
}

export const productionXlsxExecutionPort = new ProductionXlsxExecutionPort();
