import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = () =>
  readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

const sliceBetween = (
  source: string,
  startNeedle: string,
  endNeedle: string,
) => {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("App executeModeItems commit integration", () => {
  it("keeps setExecuteModeItems behind the ref-backed commit helper", () => {
    const source = appSource();
    const setterCalls = [...source.matchAll(/\bsetExecuteModeItems\(/g)].map(
      (match) => match.index ?? -1,
    );
    const helperIndex = source.indexOf(
      "const commitExecuteModeItems = useCallback",
    );

    expect(setterCalls).toHaveLength(1);
    expect(setterCalls[0]).toBeGreaterThan(helperIndex);
    expect(source).not.toContain("setExecuteModeItems((prev)");
    expect(source).not.toContain(
      "executeModeItemsRef.current = executeModeItems",
    );
  });

  it("routes persistence loading and updater paths through committed helpers", () => {
    const source = appSource();

    expect(source).toContain(
      "setExecuteModeItems: setExecuteModeItemsCommitted",
    );
    expect(source).toContain("const updateExecuteModeItems = useCallback");
    expect(source).toContain("executeModeItemsRef.current = nextAllEvents");
    expect(source).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems)",
    );
  });

  it("keeps candidate/execute normal add, delete, and reorder paths on the ref-backed updater", () => {
    const source = appSource();

    const dragReorderHandler = sliceBetween(
      source,
      "const handleMoveItem = useCallback",
      "const handleMoveItemVerticalInternal = useCallback",
    );
    const verticalReorderHandler = sliceBetween(
      source,
      "const handleMoveItemVerticalInternal = useCallback",
      "const handleMoveItemUp = useCallback",
    );
    const normalAddHandler = sliceBetween(
      source,
      "const handleMoveToExecuteColumn = useCallback",
      "const handleRemoveFromExecuteColumn = useCallback",
    );
    const normalRemoveHandler = sliceBetween(
      source,
      "const handleRemoveFromExecuteColumn = useCallback",
      "const handleToggleMode = useCallback",
    );

    expect(dragReorderHandler).toContain("updateExecuteModeItems((prev)");
    expect(verticalReorderHandler).toContain("updateExecuteModeItems((prev)");
    expect(normalAddHandler).toContain("updateExecuteModeItems((prev)");
    expect(normalRemoveHandler).toContain("updateExecuteModeItems((prev)");
    expect(dragReorderHandler).toContain(
      "executeModeItemsRef.current[activeEventName] || {}",
    );
    expect(verticalReorderHandler).toContain(
      "executeModeItemsRef.current[activeEventName] || {}",
    );
    expect(normalAddHandler).toContain("prev[activeEventName] || {}");
    expect(normalRemoveHandler).toContain("prev[activeEventName] || {}");
    expect(dragReorderHandler).not.toContain(
      "executeModeItems[activeEventName] || {}",
    );
    expect(verticalReorderHandler).not.toContain(
      "executeModeItems[activeEventName] || {}",
    );
    expect(normalAddHandler).not.toContain(
      "executeModeItems[activeEventName] || {}",
    );
    expect(normalRemoveHandler).not.toContain(
      "executeModeItems[activeEventName] || {}",
    );
  });

  it("keeps event delete, rename, and import execute-list writes on the ref-backed updater", () => {
    const source = appSource();

    const deleteHandler = sliceBetween(
      source,
      "const handleDeleteEvent = useCallback",
      "const handleRenameEvent = useCallback",
    );
    const renameHandler = sliceBetween(
      source,
      "const handleConfirmRename = useCallback",
      "const handleSortToggle = () =>",
    );
    const importHandler = sliceBetween(
      source,
      "const handleExportFileImport = useCallback",
      "const handleImportMapData = useCallback",
    );

    expect(deleteHandler).toContain(
      "updateExecuteModeItems((prev) => removeRecordKey(prev, eventName))",
    );
    expect(renameHandler).toMatch(
      /updateExecuteModeItems\(\(prev\) =>\s*renameRecordKey\(prev, eventToRename, newName\),?\s*\)/,
    );
    expect(importHandler).toMatch(
      /updateExecuteModeItems\(\(prev\) =>\s*upsertRecordKey\(prev, eventName, executeItems\),?\s*\)/,
    );
  });

  it("keeps map normal, batch, remove, and reorder paths on committed execute-list helpers", () => {
    const source = appSource();

    const mapAddHandler = sliceBetween(
      source,
      "const handleAddToExecuteListFromMap = useCallback",
      "const handleAddToExecuteListFromMapAtPosition = useCallback",
    );
    const mapPositionAddHandler = sliceBetween(
      source,
      "const handleAddToExecuteListFromMapAtPosition = useCallback",
      "const handleRemoveFromExecuteListFromMap = useCallback",
    );
    const mapRemoveHandler = sliceBetween(
      source,
      "const handleRemoveFromExecuteListFromMap = useCallback",
      "const handleBatchAddToExecuteListFromMap = useCallback",
    );
    const mapBatchAddHandler = sliceBetween(
      source,
      "const handleBatchAddToExecuteListFromMap = useCallback",
      "const handleBatchAddToExecuteListFromMapAtPosition = useCallback",
    );
    const mapBatchPositionAddHandler = sliceBetween(
      source,
      "const handleBatchAddToExecuteListFromMapAtPosition = useCallback",
      "const handleBatchRemoveFromExecuteListFromMap = useCallback",
    );
    const mapBatchRemoveHandler = sliceBetween(
      source,
      "const handleBatchRemoveFromExecuteListFromMap = useCallback",
      "const handleAddNewItemFromMap = useCallback",
    );
    const mapMoveFirstHandler = sliceBetween(
      source,
      "const handleMoveToFirstFromMap = useCallback",
      "const handleMoveToLastFromMap = useCallback",
    );
    const mapMoveLastHandler = sliceBetween(
      source,
      "const handleMoveToLastFromMap = useCallback",
      "const currentMapExecuteItemIds = useMemo",
    );

    expect(mapAddHandler).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems)",
    );
    expect(mapPositionAddHandler).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems)",
    );
    expect(mapRemoveHandler).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems)",
    );
    expect(mapRemoveHandler).toContain(
      "computeRemoveFromExecuteListFromMapWithResult",
    );
    expect(mapRemoveHandler).not.toContain("expandExecuteRemovalItemIds");
    expect(mapBatchAddHandler).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, current)",
    );
    expect(mapBatchPositionAddHandler).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems)",
    );
    expect(mapBatchRemoveHandler).toContain(
      "commitExecuteModeItemsForEvent(activeEventName, result.executeModeItems)",
    );
    expect(mapBatchRemoveHandler).toContain(
      "computeRemoveFromExecuteListFromMapWithResult",
    );
    expect(mapBatchRemoveHandler).not.toContain("for (const id of itemIds)");
    expect(mapBatchRemoveHandler).not.toContain("expandExecuteRemovalItemIds");
    expect(mapMoveFirstHandler).toContain("updateExecuteModeItems((prev)");
    expect(mapMoveLastHandler).toContain("updateExecuteModeItems((prev)");
  });

  it("keeps batch before position insertion in forward order against the same reference", () => {
    const source = appSource();
    const batchHandlerStart = source.indexOf(
      "const handleBatchAddToExecuteListFromMapAtPosition",
    );
    const batchHandlerEnd = source.indexOf(
      "const handleBatchRemoveFromExecuteListFromMap",
      batchHandlerStart,
    );
    const batchHandler = source.slice(batchHandlerStart, batchHandlerEnd);

    expect(batchHandler).toContain("computeInsertIntoExecuteAtPosition");
    expect(batchHandler).toMatch(/itemIds,\s*referenceItemId,\s*position/);
    expect(batchHandler).not.toContain("reverse()");
  });

  it("keeps the visibility override button above the settings header and navigator layers", () => {
    const source = appSource();
    const overrideButton = sliceBetween(
      source,
      "{rawHideSomething &&",
      "<AppMainContent",
    );

    expect(overrideButton).toContain("z-[110]");
    expect(overrideButton).not.toContain("z-20");
  });
});
