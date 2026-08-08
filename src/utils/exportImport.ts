/**
 * Test/legacy compatibility facade.
 *
 * Production UI code must use XlsxExecutionPort. The ExcelJS engine is bundled
 * only into the XLSX Worker (or an explicitly imported nonproduction QA adapter).
 */
export {
  exportToXlsx,
  importFromXlsx,
} from "../xlsx/engine/eventWorkbookEngine";
export type {
  EventWorkbookImportResult as ImportResult,
  ItemFallbackWarning,
  LegacySheetFieldFallback,
} from "../xlsx/domain/eventWorkbook";
export { downloadBlob } from "./downloadBlob";
