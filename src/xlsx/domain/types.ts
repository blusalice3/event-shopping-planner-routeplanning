import type { BlockDetectionSettings } from "../../types/map";
import type {
  EventWorkbookExportSnapshot,
  EventWorkbookImportResult,
} from "./eventWorkbook";
import type { ParseMapFileResult } from "./mapWorkbook";

export type XlsxImportKind = "event-import" | "map-preview" | "map-import";

export type XlsxImportRequest =
  | { kind: "event-import"; input: ArrayBuffer; fileName: string }
  | {
      kind: "map-preview";
      input: ArrayBuffer;
      fileName: string;
      settings: BlockDetectionSettings;
    }
  | {
      kind: "map-import";
      input: ArrayBuffer;
      fileName: string;
      settings: BlockDetectionSettings;
    };

export type EventImportResult = EventWorkbookImportResult;
export type MapPreviewResult = ParseMapFileResult;
export type MapImportResult = ParseMapFileResult;

export type XlsxImportResult =
  | { kind: "event-import"; value: EventImportResult }
  | { kind: "map-preview"; value: MapPreviewResult }
  | { kind: "map-import"; value: MapImportResult };

export type ExportSnapshot = EventWorkbookExportSnapshot;

export type XlsxProgressPhase =
  | "preflight"
  | "inflate"
  | "parse"
  | "serialize"
  | "digest";

export type XlsxProgress = Readonly<{
  phase: XlsxProgressPhase;
  completed: number;
  total: number;
}>;
