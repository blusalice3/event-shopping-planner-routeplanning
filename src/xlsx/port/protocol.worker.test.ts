import { describe, expect, it } from "vitest";
import { parseXlsxWorkerRequest, parseXlsxWorkerResponse } from "./protocol";

const REQUEST_ID = "00000000-0000-4000-8000-000000000001";

describe("closed XLSX Worker protocol", () => {
  it("accepts a complete export snapshot with absent optional metadata", () => {
    const request = {
      type: "XLSX_EXPORT_REQUEST",
      protocolVersion: 1,
      requestId: REQUEST_ID,
      kind: "export",
      snapshot: {
        schemaVersion: 1,
        eventName: "イベント",
        items: [],
        options: {
          includeItems: true,
          includeLayoutInfo: false,
          includeMapData: false,
          includeRouteInfo: false,
          format: "simple",
        },
        additionalData: {
          metadata: undefined,
        },
      },
    };

    expect(parseXlsxWorkerRequest(request)).toEqual(request);
  });

  it.each([
    {
      name: "path-bearing file name",
      value: {
        type: "XLSX_IMPORT_REQUEST",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        input: new ArrayBuffer(1),
        fileName: "../event.xlsx",
      },
    },
    {
      name: "unknown request field",
      value: {
        type: "XLSX_IMPORT_REQUEST",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        input: new ArrayBuffer(1),
        fileName: "event.xlsx",
        fallback: "main-thread",
      },
    },
  ])("rejects $name", ({ value }) => {
    expect(parseXlsxWorkerRequest(value)).toBeNull();
  });

  it("rejects a terminal result whose domain payload is incomplete", () => {
    expect(
      parseXlsxWorkerResponse({
        type: "XLSX_IMPORT_RESULT",
        protocolVersion: 1,
        requestId: REQUEST_ID,
        kind: "event-import",
        result: {
          kind: "event-import",
          value: { success: true },
        },
      }),
    ).toBeNull();
  });
});
