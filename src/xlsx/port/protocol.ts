import type {
  ExportSnapshot,
  XlsxImportKind,
  XlsxImportResult,
  XlsxProgress,
} from "../domain/types";
import {
  isBlockDetectionSettings,
  type BlockDetectionSettings,
} from "../../types/map";

export const XLSX_WORKER_PROTOCOL_VERSION = 1 as const;

export type XlsxWorkerRequest =
  | {
      type: "XLSX_IMPORT_REQUEST";
      protocolVersion: 1;
      requestId: string;
      kind: "event-import";
      input: ArrayBuffer;
      fileName: string;
    }
  | {
      type: "XLSX_IMPORT_REQUEST";
      protocolVersion: 1;
      requestId: string;
      kind: "map-preview" | "map-import";
      input: ArrayBuffer;
      fileName: string;
      settings: BlockDetectionSettings;
    }
  | {
      type: "XLSX_EXPORT_REQUEST";
      protocolVersion: 1;
      requestId: string;
      kind: "export";
      snapshot: ExportSnapshot;
    };

export type XlsxWorkerCancel = {
  type: "XLSX_CANCEL_REQUEST";
  protocolVersion: 1;
  requestId: string;
};

export type XlsxWorkerErrorCode =
  | "ABORTED"
  | "DUPLICATE_REQUEST_ID"
  | "INVALID_REQUEST"
  | "PROTOCOL_MISMATCH"
  | "RESOURCE_LIMIT"
  | "SECURITY_REJECTED"
  | "TIMEOUT"
  | "UNSUPPORTED_BROWSER"
  | "WORKER_CRASH"
  | "WORKER_FAILURE";

export type XlsxWorkerResponse =
  | {
      type: "XLSX_PROGRESS";
      protocolVersion: 1;
      requestId: string;
      kind: XlsxImportKind | "export";
      progress: XlsxProgress;
    }
  | {
      type: "XLSX_IMPORT_RESULT";
      protocolVersion: 1;
      requestId: string;
      kind: XlsxImportKind;
      result: XlsxImportResult;
    }
  | {
      type: "XLSX_EXPORT_RESULT";
      protocolVersion: 1;
      requestId: string;
      kind: "export";
      bytes: Uint8Array;
    }
  | {
      type: "XLSX_ERROR";
      protocolVersion: 1;
      requestId: string;
      kind: XlsxImportKind | "export" | "unknown";
      errorCode: XlsxWorkerErrorCode;
    };

const IMPORT_KINDS = new Set<XlsxImportKind>([
  "event-import",
  "map-preview",
  "map-import",
]);

const ERROR_CODES = new Set<XlsxWorkerErrorCode>([
  "ABORTED",
  "DUPLICATE_REQUEST_ID",
  "INVALID_REQUEST",
  "PROTOCOL_MISMATCH",
  "RESOURCE_LIMIT",
  "SECURITY_REJECTED",
  "TIMEOUT",
  "UNSUPPORTED_BROWSER",
  "WORKER_CRASH",
  "WORKER_FAILURE",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
};

const allowedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): boolean => {
  const allowedSet = new Set(allowed);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowedSet.has(key))
  );
};

const isRecordArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every(isRecord);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isExportOptions = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, [
    "includeItems",
    "includeLayoutInfo",
    "includeMapData",
    "includeRouteInfo",
    "format",
  ]) &&
  typeof value.includeItems === "boolean" &&
  typeof value.includeLayoutInfo === "boolean" &&
  typeof value.includeMapData === "boolean" &&
  typeof value.includeRouteInfo === "boolean" &&
  (value.format === "full" || value.format === "simple");

const EXPORT_ADDITIONAL_DATA_KEYS = [
  "metadata",
  "executeModeItems",
  "dayModes",
  "mapData",
  "mapRotationSettings",
  "mapViewportSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "blockDetectionSettings",
] as const;

const isExportAdditionalData = (value: unknown): boolean =>
  isRecord(value) &&
  allowedKeys(value, EXPORT_ADDITIONAL_DATA_KEYS, []) &&
  Object.values(value).every((entry) => entry === undefined || isRecord(entry));

const EVENT_RESULT_KEYS = [
  "success",
  "eventName",
  "items",
  "metadata",
  "layoutInfo",
  "mapData",
  "mapRotationSettings",
  "mapViewportSettings",
  "routeSettings",
  "hallDefinitions",
  "hallRouteSettings",
  "blockDetectionSettings",
  "errors",
  "itemFallbackWarnings",
  "legacySheetFieldFallbacks",
] as const;

const isEventImportValue = (value: unknown): boolean =>
  isRecord(value) &&
  allowedKeys(value, EVENT_RESULT_KEYS, [
    "success",
    "eventName",
    "items",
    "errors",
  ]) &&
  typeof value.success === "boolean" &&
  typeof value.eventName === "string" &&
  isRecordArray(value.items) &&
  isStringArray(value.errors) &&
  (value.itemFallbackWarnings === undefined ||
    isRecordArray(value.itemFallbackWarnings)) &&
  (value.legacySheetFieldFallbacks === undefined ||
    isRecordArray(value.legacySheetFieldFallbacks));

const isMapImportValue = (value: unknown): boolean =>
  isRecord(value) &&
  exactKeys(value, ["data", "skippedSheets", "error"]) &&
  (value.data === null || isRecord(value.data)) &&
  isStringArray(value.skippedSheets) &&
  (value.error === null || typeof value.error === "string");

export const isXlsxRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

export const isXlsxImportKind = (value: unknown): value is XlsxImportKind =>
  typeof value === "string" && IMPORT_KINDS.has(value as XlsxImportKind);

const isXlsxFileName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 1 &&
  value.length <= 255 &&
  !/[/\\\0]/u.test(value) &&
  /\.xlsx$/iu.test(value);

export const parseXlsxWorkerRequest = (
  value: unknown,
): XlsxWorkerRequest | XlsxWorkerCancel | null => {
  if (
    !isRecord(value) ||
    value.protocolVersion !== XLSX_WORKER_PROTOCOL_VERSION ||
    !isXlsxRequestId(value.requestId)
  ) {
    return null;
  }

  if (
    value.type === "XLSX_CANCEL_REQUEST" &&
    exactKeys(value, ["type", "protocolVersion", "requestId"])
  ) {
    return value as XlsxWorkerCancel;
  }

  if (
    value.type === "XLSX_IMPORT_REQUEST" &&
    value.input instanceof ArrayBuffer
  ) {
    if (
      value.kind === "event-import" &&
      exactKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "kind",
        "input",
        "fileName",
      ]) &&
      isXlsxFileName(value.fileName)
    ) {
      return value as XlsxWorkerRequest;
    }
    if (
      (value.kind === "map-preview" || value.kind === "map-import") &&
      exactKeys(value, [
        "type",
        "protocolVersion",
        "requestId",
        "kind",
        "input",
        "fileName",
        "settings",
      ]) &&
      isXlsxFileName(value.fileName) &&
      isBlockDetectionSettings(value.settings)
    ) {
      return value as XlsxWorkerRequest;
    }
  }

  if (
    value.type === "XLSX_EXPORT_REQUEST" &&
    exactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "kind",
      "snapshot",
    ]) &&
    value.kind === "export" &&
    isRecord(value.snapshot) &&
    exactKeys(value.snapshot, [
      "schemaVersion",
      "eventName",
      "items",
      "options",
      "additionalData",
    ]) &&
    value.snapshot.schemaVersion === 1 &&
    typeof value.snapshot.eventName === "string" &&
    value.snapshot.eventName.length > 0 &&
    isRecordArray(value.snapshot.items) &&
    isExportOptions(value.snapshot.options) &&
    isExportAdditionalData(value.snapshot.additionalData)
  ) {
    return value as XlsxWorkerRequest;
  }
  return null;
};

const isProgress = (value: unknown): value is XlsxProgress =>
  isRecord(value) &&
  exactKeys(value, ["phase", "completed", "total"]) &&
  ["preflight", "inflate", "parse", "serialize", "digest"].includes(
    String(value.phase),
  ) &&
  Number.isSafeInteger(value.completed) &&
  Number.isSafeInteger(value.total) &&
  Number(value.completed) >= 0 &&
  Number(value.total) >= 0 &&
  Number(value.completed) <= Number(value.total);

export const parseXlsxWorkerResponse = (
  value: unknown,
): XlsxWorkerResponse | null => {
  if (
    !isRecord(value) ||
    value.protocolVersion !== XLSX_WORKER_PROTOCOL_VERSION ||
    !isXlsxRequestId(value.requestId)
  ) {
    return null;
  }
  if (
    value.type === "XLSX_PROGRESS" &&
    exactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "kind",
      "progress",
    ]) &&
    (isXlsxImportKind(value.kind) || value.kind === "export") &&
    isProgress(value.progress)
  ) {
    return value as XlsxWorkerResponse;
  }
  if (
    value.type === "XLSX_IMPORT_RESULT" &&
    exactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "kind",
      "result",
    ]) &&
    isXlsxImportKind(value.kind) &&
    isRecord(value.result) &&
    exactKeys(value.result, ["kind", "value"]) &&
    value.result.kind === value.kind &&
    (value.kind === "event-import"
      ? isEventImportValue(value.result.value)
      : isMapImportValue(value.result.value))
  ) {
    return value as XlsxWorkerResponse;
  }
  if (
    value.type === "XLSX_EXPORT_RESULT" &&
    exactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "kind",
      "bytes",
    ]) &&
    value.kind === "export" &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 0
  ) {
    return value as XlsxWorkerResponse;
  }
  if (
    value.type === "XLSX_ERROR" &&
    exactKeys(value, [
      "type",
      "protocolVersion",
      "requestId",
      "kind",
      "errorCode",
    ]) &&
    (isXlsxImportKind(value.kind) ||
      value.kind === "export" ||
      value.kind === "unknown") &&
    typeof value.errorCode === "string" &&
    ERROR_CODES.has(value.errorCode as XlsxWorkerErrorCode)
  ) {
    return value as XlsxWorkerResponse;
  }
  return null;
};
