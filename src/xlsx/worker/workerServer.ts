import type {
  ExportSnapshot,
  XlsxImportKind,
  XlsxImportRequest,
  XlsxImportResult,
  XlsxProgress,
} from "../domain/types";
import {
  XLSX_WORKER_PROTOCOL_VERSION,
  isXlsxRequestId,
  parseXlsxWorkerRequest,
  type XlsxWorkerErrorCode,
  type XlsxWorkerRequest,
  type XlsxWorkerResponse,
} from "../port/protocol";

export type WorkerExecutor = {
  importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
    progress: (value: XlsxProgress) => void,
  ): Promise<XlsxImportResult>;
  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
    progress: (value: XlsxProgress) => void,
  ): Promise<Uint8Array>;
};

export type WorkerEndpoint = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: EventListener): void;
  removeEventListener(type: "message", listener: EventListener): void;
};

export class XlsxWorkerOperationError extends Error {
  readonly code: XlsxWorkerErrorCode;

  constructor(code: XlsxWorkerErrorCode, message?: string) {
    super(message ?? code);
    this.name = "XlsxWorkerOperationError";
    this.code = code;
  }
}

type RunningRequest = {
  kind: XlsxImportKind | "export";
  controller: AbortController;
  terminalSent: boolean;
};

const operationErrorCode = (error: unknown): XlsxWorkerErrorCode => {
  if (error instanceof XlsxWorkerOperationError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "ABORTED";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "ABORTED";
  }
  return "WORKER_FAILURE";
};

export const installXlsxWorkerServer = (
  endpoint: WorkerEndpoint,
  executor: WorkerExecutor,
): (() => void) => {
  const running = new Map<string, RunningRequest>();

  const post = (
    response: XlsxWorkerResponse,
    transfer: Transferable[] = [],
  ): void => endpoint.postMessage(response, transfer);

  const terminal = (
    requestId: string,
    response: XlsxWorkerResponse,
    transfer: Transferable[] = [],
  ): void => {
    const operation = running.get(requestId);
    if (!operation || operation.terminalSent) return;
    operation.terminalSent = true;
    running.delete(requestId);
    post(response, transfer);
  };

  const execute = async (request: XlsxWorkerRequest): Promise<void> => {
    const kind = request.kind;
    const operation = running.get(request.requestId);
    if (!operation) return;
    const progress = (value: XlsxProgress): void => {
      if (operation.terminalSent || operation.controller.signal.aborted) {
        return;
      }
      post({
        type: "XLSX_PROGRESS",
        protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        kind,
        progress: value,
      });
    };

    try {
      if (request.type === "XLSX_IMPORT_REQUEST") {
        const importRequest: XlsxImportRequest =
          request.kind === "event-import"
            ? {
                kind: request.kind,
                input: request.input,
                fileName: request.fileName,
              }
            : {
                kind: request.kind,
                input: request.input,
                fileName: request.fileName,
                settings: request.settings,
              };
        const result = await executor.importWorkbook(
          importRequest,
          operation.controller.signal,
          progress,
        );
        if (result.kind !== request.kind) {
          throw new XlsxWorkerOperationError("PROTOCOL_MISMATCH");
        }
        terminal(request.requestId, {
          type: "XLSX_IMPORT_RESULT",
          protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          kind: request.kind,
          result,
        });
      } else {
        const bytes = await executor.exportWorkbook(
          request.snapshot,
          operation.controller.signal,
          progress,
        );
        const stableBytes = new Uint8Array(bytes);
        terminal(
          request.requestId,
          {
            type: "XLSX_EXPORT_RESULT",
            protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
            requestId: request.requestId,
            kind: "export",
            bytes: stableBytes,
          },
          [stableBytes.buffer],
        );
      }
    } catch (error) {
      terminal(request.requestId, {
        type: "XLSX_ERROR",
        protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        kind,
        errorCode: operationErrorCode(error),
      });
    }
  };

  const listener = ((event: MessageEvent) => {
    const request = parseXlsxWorkerRequest(event.data);
    if (!request) {
      const raw =
        typeof event.data === "object" &&
        event.data !== null &&
        "requestId" in event.data &&
        isXlsxRequestId(event.data.requestId)
          ? event.data.requestId
          : crypto.randomUUID();
      post({
        type: "XLSX_ERROR",
        protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
        requestId: raw,
        kind: "unknown",
        errorCode: "INVALID_REQUEST",
      });
      return;
    }
    if (request.type === "XLSX_CANCEL_REQUEST") {
      const operation = running.get(request.requestId);
      if (operation) {
        operation.controller.abort();
        terminal(request.requestId, {
          type: "XLSX_ERROR",
          protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          kind: operation.kind,
          errorCode: "ABORTED",
        });
      }
      return;
    }
    if (running.has(request.requestId)) {
      running.get(request.requestId)?.controller.abort();
      terminal(request.requestId, {
        type: "XLSX_ERROR",
        protocolVersion: XLSX_WORKER_PROTOCOL_VERSION,
        requestId: request.requestId,
        kind: request.kind,
        errorCode: "DUPLICATE_REQUEST_ID",
      });
      return;
    }
    running.set(request.requestId, {
      kind: request.kind,
      controller: new AbortController(),
      terminalSent: false,
    });
    void execute(request);
  }) as EventListener;

  endpoint.addEventListener("message", listener);
  return () => {
    endpoint.removeEventListener("message", listener);
    running.forEach(({ controller }) => controller.abort());
    running.clear();
  };
};
