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
    onProgress?: XlsxProgressListener,
  ): Promise<XlsxImportResult>;

  exportWorkbook(
    snapshot: ExportSnapshot,
    signal: AbortSignal,
    onProgress?: XlsxProgressListener,
  ): Promise<Uint8Array>;
}

export type XlsxProgressListener = (
  requestId: string,
  progress: XlsxProgress,
) => void;
