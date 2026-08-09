import type {
  ExportSnapshot,
  XlsxImportKind,
  XlsxImportRequest,
  XlsxImportResult,
} from "../domain/types";
import type {
  XlsxExecutionPort,
  XlsxProgressListener,
} from "../port/XlsxExecutionPort";
import {
  XLSX_WORKER_PROTOCOL_VERSION,
  isXlsxRequestId,
  parseXlsxWorkerResponse,
  type XlsxWorkerCancel,
  type XlsxWorkerErrorCode,
  type XlsxWorkerRequest,
} from "../port/protocol";

type WorkerLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: EventListener,
  ): void;
  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener: EventListener,
  ): void;
  terminate?: () => void;
};

type PendingRequest = {
  kind: XlsxImportKind | "export";
  resolve: (value: XlsxImportResult | Uint8Array) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  abortListener: () => void;
  timeoutId: ReturnType<typeof setTimeout>;
  cancellationError: Error | null;
  cancellationTimeoutId: ReturnType<typeof setTimeout> | null;
};

export class XlsxWorkerPortError extends Error {
  readonly code: XlsxWorkerErrorCode;

  constructor(code: XlsxWorkerErrorCode, message?: string) {
    super(message ?? `XLSX Worker failed with ${code}.`);
    this.name = "XlsxWorkerPortError";
    this.code = code;
  }
}

const abortError = (): Error => {
  try {
    return new DOMException("XLSX request was aborted.", "AbortError");
  } catch {
    const error = new Error("XLSX request was aborted.");
    error.name = "AbortError";
    return error;
  }
};

export class WorkerXlsxExecutionPort implements XlsxExecutionPort {
  readonly #worker: WorkerLike;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #onProgress?: XlsxProgressListener;
  readonly #requestIdFactory: () => string;
  readonly #requestTimeoutMs: number;
  readonly #cancelAcknowledgementTimeoutMs: number;
  #disposed = false;

  readonly #messageListener = ((event: MessageEvent) => {
    this.#handleMessage(event.data);
  }) as EventListener;

  readonly #errorListener = (() => {
    this.#rejectAll(
      new XlsxWorkerPortError("WORKER_CRASH", "XLSX Worker crashed."),
    );
  }) as EventListener;

  constructor(
    worker: WorkerLike,
    options: {
      onProgress?: XlsxProgressListener;
      requestIdFactory?: () => string;
      requestTimeoutMs?: number;
      cancelAcknowledgementTimeoutMs?: number;
    } = {},
  ) {
    this.#worker = worker;
    this.#onProgress = options.onProgress;
    this.#requestIdFactory =
      options.requestIdFactory ?? (() => crypto.randomUUID());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#cancelAcknowledgementTimeoutMs =
      options.cancelAcknowledgementTimeoutMs ?? 1_000;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0
    ) {
      throw new TypeError("XLSX Worker timeout must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(this.#cancelAcknowledgementTimeoutMs) ||
      this.#cancelAcknowledgementTimeoutMs <= 0
    ) {
      throw new TypeError(
        "XLSX Worker cancellation timeout must be a positive integer.",
      );
    }
    worker.addEventListener("message", this.#messageListener);
    worker.addEventListener("error", this.#errorListener);
    worker.addEventListener("messageerror", this.#errorListener);
  }

  importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
  ): Promise<XlsxImportResult> {
    const input = request.input;
    return this.#start<XlsxImportResult>(
      request.kind,
      signal,
      (requestId) =>
        request.kind === "event-import"
          ? {
              type: "XLSX_IMPORT_REQUEST",
              protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
              requestId,
              kind: request.kind,
              input,
              fileName: request.fileName,
            }
          : {
              type: "XLSX_IMPORT_REQUEST",
              protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
              requestId,
              kind: request.kind,
              input,
              fileName: request.fileName,
              settings: request.settings,
            },
      [input],
    );
  }

  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    return this.#start<Uint8Array>("export", signal, (requestId) => ({
      type: "XLSX_EXPORT_REQUEST",
      protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
      requestId,
      kind: "export",
      snapshot,
    }));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#worker.removeEventListener("message", this.#messageListener);
    this.#worker.removeEventListener("error", this.#errorListener);
    this.#worker.removeEventListener("messageerror", this.#errorListener);
    this.#worker.terminate?.();
    this.#rejectAll(
      new XlsxWorkerPortError(
        "WORKER_FAILURE",
        "XLSX Worker port was disposed.",
      ),
    );
  }

  #start<T extends XlsxImportResult | Uint8Array>(
    kind: XlsxImportKind | "export",
    signal: AbortSignal,
    buildRequest: (requestId: string) => XlsxWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(
        new XlsxWorkerPortError(
          "WORKER_FAILURE",
          "XLSX Worker port is disposed.",
        ),
      );
    }
    if (signal.aborted) return Promise.reject(abortError());
    const requestId = this.#requestIdFactory();
    if (!isXlsxRequestId(requestId)) {
      return Promise.reject(
        new XlsxWorkerPortError(
          "PROTOCOL_MISMATCH",
          "XLSX request ID is not a UUID.",
        ),
      );
    }
    if (this.#pending.has(requestId)) {
      return Promise.reject(
        new XlsxWorkerPortError(
          "DUPLICATE_REQUEST_ID",
          "XLSX request ID was reused.",
        ),
      );
    }

    return new Promise<T>((resolve, reject) => {
      const cancelWorker = (): void => {
        const cancel: XlsxWorkerCancel = {
          type: "XLSX_CANCEL_REQUEST",
          protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
          requestId,
        };
        try {
          this.#worker.postMessage(cancel);
        } catch {
          // The request is settled locally even if the Worker already crashed.
        }
      };
      const requestCancellation = (error: Error): void => {
        const pending = this.#pending.get(requestId);
        if (!pending || pending.cancellationError) return;
        clearTimeout(pending.timeoutId);
        pending.cancellationError = error;
        cancelWorker();
        pending.cancellationTimeoutId = setTimeout(() => {
          this.#settle(requestId, () => reject(error));
        }, this.#cancelAcknowledgementTimeoutMs);
      };
      const abortListener = (): void => {
        requestCancellation(abortError());
      };
      const timeoutId = setTimeout(() => {
        requestCancellation(
          new XlsxWorkerPortError(
            "TIMEOUT",
            "XLSX Worker exceeded its operation deadline.",
          ),
        );
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, {
        kind,
        resolve: resolve as PendingRequest["resolve"],
        reject,
        signal,
        abortListener,
        timeoutId,
        cancellationError: null,
        cancellationTimeoutId: null,
      });
      signal.addEventListener("abort", abortListener, { once: true });
      try {
        this.#worker.postMessage(buildRequest(requestId), transfer);
      } catch (error) {
        this.#settle(requestId, () =>
          reject(
            error instanceof Error
              ? error
              : new XlsxWorkerPortError("WORKER_FAILURE"),
          ),
        );
      }
    });
  }

  #handleMessage(raw: unknown): void {
    const response = parseXlsxWorkerResponse(raw);
    if (!response) {
      this.#rejectAll(
        new XlsxWorkerPortError(
          "PROTOCOL_MISMATCH",
          "XLSX Worker sent an invalid response.",
        ),
      );
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending) return; // A cancelled request may finish late.
    if (response.kind !== pending.kind) {
      this.#settle(response.requestId, () =>
        pending.reject(
          new XlsxWorkerPortError(
            "PROTOCOL_MISMATCH",
            "XLSX Worker response kind does not match its request.",
          ),
        ),
      );
      return;
    }
    if (pending.cancellationError) {
      if (response.type === "XLSX_ERROR" && response.errorCode === "ABORTED") {
        this.#settle(response.requestId, () =>
          pending.reject(pending.cancellationError!),
        );
      }
      return;
    }
    if (response.type === "XLSX_PROGRESS") {
      this.#onProgress?.(response.requestId, response.progress);
      return;
    }
    if (response.type === "XLSX_ERROR") {
      this.#settle(response.requestId, () =>
        pending.reject(new XlsxWorkerPortError(response.errorCode)),
      );
      return;
    }
    if (response.type === "XLSX_IMPORT_RESULT") {
      this.#settle(response.requestId, () => pending.resolve(response.result));
      return;
    }
    this.#settle(response.requestId, () =>
      pending.resolve(new Uint8Array(response.bytes)),
    );
  }

  #settle(requestId: string, callback: () => void): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timeoutId);
    if (pending.cancellationTimeoutId !== null) {
      clearTimeout(pending.cancellationTimeoutId);
    }
    pending.signal.removeEventListener("abort", pending.abortListener);
    callback();
  }

  #rejectAll(error: Error): void {
    [...this.#pending.entries()].forEach(([requestId, pending]) => {
      this.#settle(requestId, () => pending.reject(error));
    });
  }
}

export const createWorkerXlsxExecutionPort = (
  options: {
    onProgress?: XlsxProgressListener;
    workerFactory?: () => Worker;
    requestTimeoutMs?: number;
    cancelAcknowledgementTimeoutMs?: number;
  } = {},
): WorkerXlsxExecutionPort => {
  if (!options.workerFactory && typeof Worker === "undefined") {
    throw new XlsxWorkerPortError(
      "UNSUPPORTED_BROWSER",
      "This browser does not support module Workers.",
    );
  }
  const worker =
    options.workerFactory?.() ??
    new Worker(new URL("../worker/xlsx.worker.ts", import.meta.url), {
      type: "module",
      name: "event-shopping-planner-xlsx",
    });
  return new WorkerXlsxExecutionPort(worker, {
    onProgress: options.onProgress,
    requestTimeoutMs: options.requestTimeoutMs,
    cancelAcknowledgementTimeoutMs: options.cancelAcknowledgementTimeoutMs,
  });
};
