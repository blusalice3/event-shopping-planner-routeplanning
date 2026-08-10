import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerXlsxExecutionPort,
  WorkerXlsxExecutionPort,
  XlsxWorkerPortError,
} from "./workerXlsxExecutionPort";
import type { XlsxWorkerRequest } from "../port/protocol";
import { DEFAULT_BLOCK_DETECTION_SETTINGS } from "../../types/map";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

class FakeWorker {
  readonly sent: Array<{
    message: unknown;
    transfer: Transferable[];
  }> = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  onPost?: (message: unknown) => void;
  terminated = false;

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.sent.push({ message, transfer });
    this.onPost?.(message);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitMessage(data: unknown): void {
    this.listeners.get("message")?.forEach((listener) => {
      (listener as unknown as (event: { data: unknown }) => void)({
        data,
      });
    });
  }

  emitError(): void {
    this.listeners.get("error")?.forEach((listener) => {
      (listener as unknown as () => void)();
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("WorkerXlsxExecutionPort protocol", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("transfers the input and accepts progress plus one matching result", async () => {
    const worker = new FakeWorker();
    const progress: unknown[] = [];
    worker.onPost = (raw) => {
      const request = raw as XlsxWorkerRequest;
      if (request.type !== "XLSX_IMPORT_REQUEST") return;
      queueMicrotask(() => {
        worker.emitMessage({
          type: "XLSX_PROGRESS",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: request.kind,
          progress: {
            phase: "preflight",
            completed: 1,
            total: 2,
          },
        });
        worker.emitMessage({
          type: "XLSX_IMPORT_RESULT",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: request.kind,
          result: {
            kind: request.kind,
            value: {
              success: true,
              eventName: "event",
              items: [],
              errors: [],
            },
          },
        });
        worker.emitMessage({
          type: "XLSX_IMPORT_RESULT",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: request.kind,
          result: {
            kind: request.kind,
            value: {
              success: false,
              eventName: "",
              items: [],
              errors: ["late"],
            },
          },
        });
      });
    };
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
      onProgress: (_requestId, value) => progress.push(value),
    });
    const input = new ArrayBuffer(8);

    await expect(
      port.importWorkbook(
        { kind: "event-import", input, fileName: "event.xlsx" },
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "event-import",
      value: {
        success: true,
        eventName: "event",
        items: [],
        errors: [],
      },
    });
    expect(worker.sent[0].transfer).toEqual([input]);
    expect(progress).toEqual([{ phase: "preflight", completed: 1, total: 2 }]);
  });

  it("rejects a response whose kind does not match the request", async () => {
    const worker = new FakeWorker();
    worker.onPost = (raw) => {
      const request = raw as XlsxWorkerRequest;
      if (request.type !== "XLSX_IMPORT_REQUEST") return;
      queueMicrotask(() =>
        worker.emitMessage({
          type: "XLSX_IMPORT_RESULT",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: "map-import",
          result: {
            kind: "map-import",
            value: {},
          },
        }),
      );
    };
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });
    await expect(
      port.importWorkbook(
        {
          kind: "map-preview",
          input: new ArrayBuffer(1),
          fileName: "preview.xlsx",
          settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("sends cancel and rejects locally without accepting a late result", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });
    const promise = port.importWorkbook(
      {
        kind: "map-import",
        input: new ArrayBuffer(1),
        fileName: "map.xlsx",
        settings: DEFAULT_BLOCK_DETECTION_SETTINGS,
      },
      controller.signal,
    );
    const rejection = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    expect(worker.sent[1].message).toEqual({
      type: "XLSX_CANCEL_REQUEST",
      protocolVersion: 1,
      requestId: REQUEST_ID,
    });

    worker.emitMessage({
      type: "XLSX_IMPORT_RESULT",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "map-import",
      result: {
        kind: "map-import",
        value: { data: null, skippedSheets: [], error: null },
      },
    });
    worker.emitMessage({
      type: "XLSX_ERROR",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "map-import",
      errorCode: "ABORTED",
    });
    await rejection;
  });

  it("rejects every pending operation when the Worker crashes", async () => {
    const worker = new FakeWorker();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });
    const promise = port.exportWorkbook(
      {
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
      new AbortController().signal,
    );
    const rejection =
      expect(promise).rejects.toBeInstanceOf(XlsxWorkerPortError);
    worker.emitError();
    await rejection;
  });

  it("cancels and fails closed when an operation exceeds its deadline", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
      requestTimeoutMs: 25,
    });
    const promise = port.importWorkbook(
      {
        kind: "event-import",
        input: new ArrayBuffer(1),
        fileName: "event.xlsx",
      },
      new AbortController().signal,
    );

    const rejection = expect(promise).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(worker.sent[1].message).toEqual({
      type: "XLSX_CANCEL_REQUEST",
      protocolVersion: 1,
      requestId: REQUEST_ID,
    });
    worker.emitMessage({
      type: "XLSX_IMPORT_RESULT",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "event-import",
      result: {
        kind: "event-import",
        value: {
          success: true,
          eventName: "late",
          items: [],
          errors: [],
        },
      },
    });
    worker.emitMessage({
      type: "XLSX_ERROR",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "event-import",
      errorCode: "ABORTED",
    });
    await rejection;
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid timeout value of %s",
    (requestTimeoutMs) => {
      expect(
        () =>
          new WorkerXlsxExecutionPort(new FakeWorker(), {
            requestTimeoutMs,
          }),
      ).toThrowError(
        new TypeError("XLSX Worker timeout must be a positive integer."),
      );
    },
  );

  it("rejects before posting when the signal is already aborted", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    controller.abort();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });

    await expect(
      port.exportWorkbook(
        {
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
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.sent).toEqual([]);
  });

  it("rejects a non-UUID request ID before posting", async () => {
    const worker = new FakeWorker();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => "not-a-uuid",
    });

    await expect(
      port.importWorkbook(
        {
          kind: "event-import",
          input: new ArrayBuffer(1),
          fileName: "event.xlsx",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect(worker.sent).toEqual([]);
  });

  it("rejects reuse of a pending request ID", async () => {
    const worker = new FakeWorker();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });
    const first = port.importWorkbook(
      {
        kind: "event-import",
        input: new ArrayBuffer(1),
        fileName: "first.xlsx",
      },
      new AbortController().signal,
    );
    const firstRejection = expect(first).rejects.toMatchObject({
      code: "WORKER_FAILURE",
    });

    await expect(
      port.importWorkbook(
        {
          kind: "event-import",
          input: new ArrayBuffer(1),
          fileName: "second.xlsx",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_REQUEST_ID" });

    port.dispose();
    await firstRejection;
  });

  it("disposes once, terminates the Worker, and rejects future work", async () => {
    const worker = new FakeWorker();
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });

    port.dispose();
    port.dispose();

    expect(worker.terminated).toBe(true);
    expect(
      [...worker.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
    await expect(
      port.importWorkbook(
        {
          kind: "event-import",
          input: new ArrayBuffer(1),
          fileName: "event.xlsx",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "WORKER_FAILURE" });
  });

  it("rejects all pending operations after an invalid Worker response", async () => {
    const worker = new FakeWorker();
    const ids = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => ids.shift() ?? "missing",
    });
    const first = port.importWorkbook(
      {
        kind: "event-import",
        input: new ArrayBuffer(1),
        fileName: "event.xlsx",
      },
      new AbortController().signal,
    );
    const second = port.exportWorkbook(
      {
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
      new AbortController().signal,
    );
    const firstRejection = expect(first).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    const secondRejection = expect(second).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });

    worker.emitMessage({ protocolVersion: 99 });

    await Promise.all([firstRejection, secondRejection]);
  });

  it("maps a Worker protocol error to XlsxWorkerPortError", async () => {
    const worker = new FakeWorker();
    worker.onPost = (raw) => {
      const request = raw as XlsxWorkerRequest;
      if (request.type !== "XLSX_IMPORT_REQUEST") return;
      queueMicrotask(() => {
        worker.emitMessage({
          type: "XLSX_ERROR",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: request.kind,
          errorCode: "RESOURCE_LIMIT",
        });
      });
    };
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });

    await expect(
      port.importWorkbook(
        {
          kind: "event-import",
          input: new ArrayBuffer(1),
          fileName: "event.xlsx",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
  });

  it("copies a successful export response", async () => {
    const worker = new FakeWorker();
    const bytes = new Uint8Array([4, 5, 6]);
    worker.onPost = (raw) => {
      const request = raw as XlsxWorkerRequest;
      if (request.type !== "XLSX_EXPORT_REQUEST") return;
      queueMicrotask(() => {
        worker.emitMessage({
          type: "XLSX_EXPORT_RESULT",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: "export",
          bytes,
        });
      });
    };
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });

    const result = await port.exportWorkbook(
      {
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
      new AbortController().signal,
    );

    expect(result).toEqual(bytes);
    expect(result).not.toBe(bytes);
  });

  it.each([
    ["Error", new Error("post failed"), new Error("post failed")],
    ["non-Error", "post failed", { code: "WORKER_FAILURE" }],
  ] as const)(
    "settles when initial postMessage throws an %s value",
    async (_label, thrown, expected) => {
      const worker = new FakeWorker();
      worker.postMessage = () => {
        throw thrown;
      };
      const port = new WorkerXlsxExecutionPort(worker, {
        requestIdFactory: () => REQUEST_ID,
      });

      await expect(
        port.importWorkbook(
          {
            kind: "event-import",
            input: new ArrayBuffer(1),
            fileName: "event.xlsx",
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject(expected);
    },
  );

  it("still settles cancellation when posting cancel fails", async () => {
    const worker = new FakeWorker();
    const controller = new AbortController();
    let posts = 0;
    worker.postMessage = (message, transfer = []) => {
      posts += 1;
      if (posts > 1) throw new Error("Worker is already gone");
      worker.sent.push({ message, transfer });
    };
    const port = new WorkerXlsxExecutionPort(worker, {
      requestIdFactory: () => REQUEST_ID,
    });
    const promise = port.importWorkbook(
      {
        kind: "event-import",
        input: new ArrayBuffer(1),
        fileName: "event.xlsx",
      },
      controller.signal,
    );
    const rejection = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });

    controller.abort();

    await rejection;
    expect(posts).toBe(2);
  });

  it("uses a supplied Worker factory and default request ID generator", async () => {
    const worker = new FakeWorker();
    vi.stubGlobal("crypto", { randomUUID: () => REQUEST_ID });
    worker.onPost = (raw) => {
      const request = raw as XlsxWorkerRequest;
      if (request.type !== "XLSX_EXPORT_REQUEST") return;
      queueMicrotask(() => {
        worker.emitMessage({
          type: "XLSX_EXPORT_RESULT",
          protocolVersion: 1,
          requestId: request.requestId,
          kind: "export",
          bytes: new Uint8Array([7]),
        });
      });
    };
    const port = createWorkerXlsxExecutionPort({
      workerFactory: () => worker as unknown as Worker,
    });

    await expect(
      port.exportWorkbook(
        {
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
        new AbortController().signal,
      ),
    ).resolves.toEqual(new Uint8Array([7]));
  });

  it("fails closed when module Workers are unavailable", () => {
    vi.stubGlobal("Worker", undefined);

    expect(() => createWorkerXlsxExecutionPort()).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_BROWSER" }),
    );
  });
});
