import { describe, expect, it } from "vitest";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../../types/map";
import type {
  XlsxImportRequest,
  XlsxImportResult,
  XlsxProgress,
} from "../domain/types";
import type { XlsxWorkerResponse } from "../port/protocol";
import {
  installXlsxWorkerServer,
  XlsxWorkerOperationError,
  type WorkerEndpoint,
  type WorkerExecutor,
} from "./workerServer";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

class FakeEndpoint implements WorkerEndpoint {
  readonly responses: XlsxWorkerResponse[] = [];
  readonly transfers: Transferable[][] = [];
  listener: EventListener | null = null;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.responses.push(message as XlsxWorkerResponse);
    this.transfers.push(transfer);
  }

  addEventListener(_type: "message", listener: EventListener): void {
    this.listener = listener;
  }

  removeEventListener(_type: "message", listener: EventListener): void {
    if (this.listener === listener) this.listener = null;
  }

  send(data: unknown): void {
    (this.listener as unknown as (event: { data: unknown }) => void)?.({
      data,
    });
  }
}

const importRequest = (
  input = new ArrayBuffer(1),
): Record<string, unknown> => ({
  type: "XLSX_IMPORT_REQUEST",
  protocolVersion: 1,
  requestId: REQUEST_ID,
  kind: "event-import",
  input,
  fileName: "event.xlsx",
});

const exportRequest = (): Record<string, unknown> => ({
  type: "XLSX_EXPORT_REQUEST",
  protocolVersion: 1,
  requestId: REQUEST_ID,
  kind: "export",
  snapshot: {
    schemaVersion: 1,
    eventName: "event",
    items: [],
    options: {
      includeItems: true,
      includeLayoutInfo: false,
      includeMapData: false,
      includeRouteInfo: false,
      format: "simple",
    },
    additionalData: {},
  },
});

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("XLSX worker server protocol", () => {
  it("emits progress followed by one terminal result", async () => {
    const endpoint = new FakeEndpoint();
    const executor: WorkerExecutor = {
      async importWorkbook(
        request: XlsxImportRequest,
        _signal: AbortSignal,
        progress: (value: XlsxProgress) => void,
      ) {
        progress({ phase: "parse", completed: 1, total: 1 });
        return { kind: request.kind, value: { ok: true } } as never;
      },
      async exportWorkbook() {
        return new Uint8Array([1]);
      },
    };
    installXlsxWorkerServer(endpoint, executor);
    endpoint.send(importRequest());
    await flush();

    expect(endpoint.responses).toEqual([
      {
        type: "XLSX_PROGRESS",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        progress: { phase: "parse", completed: 1, total: 1 },
      },
      {
        type: "XLSX_IMPORT_RESULT",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        result: { kind: "event-import", value: { ok: true } },
      },
    ]);
  });

  it("makes cancellation terminal even if the executor ignores abort", async () => {
    const endpoint = new FakeEndpoint();
    const deferred: {
      resolve?: (value: XlsxImportResult) => void;
    } = {};
    const executor: WorkerExecutor = {
      importWorkbook: () =>
        new Promise((resolve) => {
          deferred.resolve = resolve;
        }),
      async exportWorkbook() {
        return new Uint8Array();
      },
    };
    installXlsxWorkerServer(endpoint, executor);
    endpoint.send(importRequest());
    endpoint.send({
      type: "XLSX_CANCEL_REQUEST",
      protocolVersion: 1,
      requestId: REQUEST_ID,
    });
    deferred.resolve?.({
      kind: "event-import",
      value: {
        success: true,
        eventName: "late",
        items: [],
        errors: [],
      },
    });
    await flush();

    const terminal = endpoint.responses.filter(
      ({ type }) => type !== "XLSX_PROGRESS",
    );
    expect(terminal).toEqual([
      {
        type: "XLSX_ERROR",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        errorCode: "ABORTED",
      },
    ]);
  });

  it("aborts a duplicate request ID and emits only one terminal error", async () => {
    const endpoint = new FakeEndpoint();
    const executor: WorkerExecutor = {
      importWorkbook: () => new Promise(() => undefined),
      async exportWorkbook() {
        return new Uint8Array();
      },
    };
    installXlsxWorkerServer(endpoint, executor);
    endpoint.send(importRequest());
    endpoint.send(importRequest());
    await flush();

    expect(endpoint.responses).toEqual([
      {
        type: "XLSX_ERROR",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        errorCode: "DUPLICATE_REQUEST_ID",
      },
    ]);
  });

  it("exports a stable byte copy and transfers its buffer", async () => {
    const endpoint = new FakeEndpoint();
    const source = new Uint8Array([1, 2, 3]);
    const executor: WorkerExecutor = {
      async importWorkbook(request) {
        return { kind: request.kind, value: {} } as never;
      },
      async exportWorkbook(_snapshot, _signal, progress) {
        progress({ phase: "serialize", completed: 1, total: 1 });
        return source;
      },
    };
    installXlsxWorkerServer(endpoint, executor);

    endpoint.send(exportRequest());
    await flush();

    expect(endpoint.responses).toEqual([
      {
        type: "XLSX_PROGRESS",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "export",
        progress: { phase: "serialize", completed: 1, total: 1 },
      },
      {
        type: "XLSX_EXPORT_RESULT",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "export",
        bytes: new Uint8Array([1, 2, 3]),
      },
    ]);
    expect((endpoint.responses[1] as { bytes: Uint8Array }).bytes).not.toBe(
      source,
    );
    expect(endpoint.transfers[1]).toEqual([
      (endpoint.responses[1] as { bytes: Uint8Array }).bytes.buffer,
    ]);
  });

  it("passes map settings to the executor and rejects a mismatched result", async () => {
    const endpoint = new FakeEndpoint();
    const observed: XlsxImportRequest[] = [];
    const executor: WorkerExecutor = {
      async importWorkbook(request) {
        observed.push(request);
        return {
          kind: "event-import",
          value: {
            success: true,
            eventName: "wrong",
            items: [],
            errors: [],
          },
        };
      },
      async exportWorkbook() {
        return new Uint8Array([1]);
      },
    };
    installXlsxWorkerServer(endpoint, executor);
    const input = new ArrayBuffer(1);

    endpoint.send({
      type: "XLSX_IMPORT_REQUEST",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "map-preview",
      input,
      fileName: "map.xlsx",
      settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
    });
    await flush();

    expect(observed).toEqual([
      {
        kind: "map-preview",
        input,
        fileName: "map.xlsx",
        settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
      },
    ]);
    expect(endpoint.responses).toEqual([
      {
        type: "XLSX_ERROR",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "map-preview",
        errorCode: "PROTOCOL_MISMATCH",
      },
    ]);
  });

  it.each([
    [
      "explicit operation error",
      () => new XlsxWorkerOperationError("SECURITY_REJECTED"),
      "SECURITY_REJECTED",
    ],
    [
      "DOM abort error",
      () => new DOMException("aborted", "AbortError"),
      "ABORTED",
    ],
    [
      "Error abort error",
      () => Object.assign(new Error("aborted"), { name: "AbortError" }),
      "ABORTED",
    ],
    ["ordinary error", () => new Error("failure"), "WORKER_FAILURE"],
  ] as const)(
    "maps %s to its closed protocol error",
    async (_label, makeError, expectedCode) => {
      const endpoint = new FakeEndpoint();
      const executor: WorkerExecutor = {
        async importWorkbook() {
          throw makeError();
        },
        async exportWorkbook() {
          return new Uint8Array([1]);
        },
      };
      installXlsxWorkerServer(endpoint, executor);

      endpoint.send(importRequest());
      await flush();

      expect(endpoint.responses).toEqual([
        {
          type: "XLSX_ERROR",
          protocolVersion: 1,
          requestId: REQUEST_ID,
          kind: "event-import",
          errorCode: expectedCode,
        },
      ]);
    },
  );

  it("rejects invalid requests while preserving a valid supplied request ID", () => {
    const endpoint = new FakeEndpoint();
    const executor: WorkerExecutor = {
      async importWorkbook(request) {
        return { kind: request.kind, value: {} } as never;
      },
      async exportWorkbook() {
        return new Uint8Array([1]);
      },
    };
    installXlsxWorkerServer(endpoint, executor);

    endpoint.send({ requestId: REQUEST_ID });
    endpoint.send(null);

    expect(endpoint.responses[0]).toEqual({
      type: "XLSX_ERROR",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "unknown",
      errorCode: "INVALID_REQUEST",
    });
    expect(endpoint.responses[1]).toMatchObject({
      type: "XLSX_ERROR",
      protocolVersion: 1,
      kind: "unknown",
      errorCode: "INVALID_REQUEST",
    });
    expect(endpoint.responses[1]?.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it("ignores cancellation for an unknown request", () => {
    const endpoint = new FakeEndpoint();
    const executor: WorkerExecutor = {
      async importWorkbook(request) {
        return { kind: request.kind, value: {} } as never;
      },
      async exportWorkbook() {
        return new Uint8Array([1]);
      },
    };
    installXlsxWorkerServer(endpoint, executor);

    endpoint.send({
      type: "XLSX_CANCEL_REQUEST",
      protocolVersion: 1,
      requestId: REQUEST_ID,
    });

    expect(endpoint.responses).toEqual([]);
  });

  it("removes its listener and aborts every operation during cleanup", () => {
    const endpoint = new FakeEndpoint();
    let signal: AbortSignal | undefined;
    let progress: ((value: XlsxProgress) => void) | undefined;
    const executor: WorkerExecutor = {
      importWorkbook: (_request, currentSignal, currentProgress) => {
        signal = currentSignal;
        progress = currentProgress;
        return new Promise(() => undefined);
      },
      async exportWorkbook() {
        return new Uint8Array([1]);
      },
    };
    const cleanup = installXlsxWorkerServer(endpoint, executor);
    endpoint.send(importRequest());

    cleanup();
    progress?.({ phase: "parse", completed: 1, total: 1 });

    expect(endpoint.listener).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(endpoint.responses).toEqual([]);
  });
});
