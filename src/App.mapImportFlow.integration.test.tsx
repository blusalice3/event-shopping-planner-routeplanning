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

const occurrenceCount = (source: string, needle: string): number =>
  source.split(needle).length - 1;

describe("App map import flow integration", () => {
  it("wires the common commit to every state and persistence effect once", () => {
    const source = appSource();
    const commitHandler = sliceBetween(
      source,
      "const commitPreparedMapImport = useCallback",
      "const handleMapImportConfirm = useCallback",
    );

    expect(
      occurrenceCount(commitHandler, "commitPreparedMapImportFlow({"),
    ).toBe(1);
    for (const effect of [
      "setEventLists",
      "setMapData",
      "setMapRotationSettings",
      "setRouteSettings",
      "setHallDefinitions",
      "setHallRouteSettings",
      "setMapViewportSettings",
      "saveBlockDetectionSettings",
      "activateTarget:",
      "finishImport:",
      "notify:",
    ]) {
      expect(commitHandler).toContain(effect);
    }
  });

  it("dispatches only after a non-empty target plan is built", () => {
    const source = appSource();
    const importHandler = sliceBetween(
      source,
      "const handleMapImportConfirm = useCallback",
      "const handleMapReimportConfirm = useCallback",
    );
    const zeroTargetBranch = sliceBetween(
      importHandler,
      "if (targets.length === 0)",
      "try {",
    );
    const buildIndex = importHandler.indexOf("buildMapReimportPlan({");
    const dispatchIndex = importHandler.indexOf(
      "dispatchPreparedMapImport(preparedImport",
    );

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(dispatchIndex).toBeGreaterThan(buildIndex);
    expect(occurrenceCount(importHandler, "dispatchPreparedMapImport(")).toBe(
      1,
    );
    expect(importHandler).not.toContain("saveBlockDetectionSettings(");
    expect(zeroTargetBranch).not.toContain("dispatchPreparedMapImport(");
    expect(zeroTargetBranch).not.toContain("commitPreparedMapImport(");
  });

  it("does not commit or save from planning failure and cancel handlers", () => {
    const source = appSource();
    const importHandler = sliceBetween(
      source,
      "const handleMapImportConfirm = useCallback",
      "const handleMapReimportConfirm = useCallback",
    );
    const failureHandler = sliceBetween(
      importHandler,
      "} catch (error) {",
      "},\n    [",
    );
    const cancelHandler = sliceBetween(
      source,
      "const handleMapReimportCancel = useCallback",
      "const handleMapImportClose = useCallback",
    );

    expect(failureHandler).not.toContain("dispatchPreparedMapImport(");
    expect(failureHandler).not.toContain("commitPreparedMapImport(");
    expect(failureHandler).not.toContain("saveBlockDetectionSettings(");
    expect(cancelHandler).toContain("cancelPendingMapImport({");
    expect(cancelHandler).not.toContain("commitPreparedMapImport(");
    expect(cancelHandler).not.toContain("saveBlockDetectionSettings(");
  });

  it("uses the same common commit only after confirmation", () => {
    const source = appSource();
    const confirmHandler = sliceBetween(
      source,
      "const handleMapReimportConfirm = useCallback",
      "const handleMapReimportCancel = useCallback",
    );

    expect(confirmHandler).toContain(
      "commitPreparedMapImport(pendingMapReimport, options)",
    );
    expect(confirmHandler).not.toContain("commitPreparedMapImportFlow(");
    expect(confirmHandler).not.toContain("saveBlockDetectionSettings(");
  });
});
