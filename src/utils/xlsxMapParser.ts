/**
 * Test/legacy compatibility facade.
 *
 * Production UI code uses XlsxExecutionPort and pure domain helpers instead.
 */
export {
  parseMapFile,
  findZeroBlockMapSheets,
  type ParseMapFileResult,
} from "../xlsx/engine/mapWorkbookEngine";
export {
  createBlockDefinition,
  extractNumberAlphaPrefix,
  extractNumberFromItemNumber,
  matchItemToCell,
} from "../xlsx/domain/itemNumber";
