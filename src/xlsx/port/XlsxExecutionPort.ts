import type {
  ExportSnapshot,
  XlsxImportRequest,
  XlsxImportResult,
  XlsxProgress,
} from "../domain/types";

export interface XlsxExecutionPort {
  importWorkbook(
    request: XlsxImportRequest,
    signal: AbortSignal,
  ): Promise<XlsxImportResult>;

  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<Uint8Array>;
}

export type XlsxProgressListener = (
  requestId: string,
  progress: XlsxProgress,
) => void;
