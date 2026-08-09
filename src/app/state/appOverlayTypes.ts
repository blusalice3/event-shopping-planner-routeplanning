import type { BulkAddMetadata } from "../../features/events/bulkAdd";
import type {
  DifferentSourceEventAnalysis,
  SameSourceEventAnalysis,
} from "../../features/events/duplicateEvent";

export type PendingDuplicateEventImport = {
  analysis: SameSourceEventAnalysis | DifferentSourceEventAnalysis;
  metadata?: BulkAddMetadata;
};

export type PendingXlsxRestoreCompletion = {
  errors: string[];
  itemCount: number;
};
