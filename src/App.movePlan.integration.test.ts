import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function sliceBetween(
  source: string,
  startNeedle: string,
  endNeedle: string,
): string {
  const start = source.indexOf(startNeedle);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("App move plan integration", () => {
  it("uses the complete candidate source and passes effective IDs to add", () => {
    const source = readSource("src/App.tsx");
    const handler = sliceBetween(
      source,
      "const handleMoveToExecuteColumn = useCallback",
      "const handleRemoveFromExecuteColumn = useCallback",
    );

    expect(handler).toContain("getCandidateSourceOrderedIds(");
    expect(handler).toContain("const plan = buildMovePlan({");
    expect(handler).toContain('expansionPolicy: "same-visit"');
    expect(handler).toContain("const effectiveIds = plan.effective");
    expect(handler).toMatch(
      /computeMoveToExecuteColumn\(\s*effectiveIds,\s*currentEventDate/,
    );
  });

  it("uses execute order as the source and passes effective IDs to remove", () => {
    const source = readSource("src/App.tsx");
    const handler = sliceBetween(
      source,
      "const handleRemoveFromExecuteColumn = useCallback",
      "const handleToggleMode = useCallback",
    );

    expect(handler).toMatch(
      /sourceOrderedIds:\s*executeModeItemsRef\.current\[activeEventName\]\?\.\[currentEventDate\]/,
    );
    expect(handler).toContain("const effectiveIds = plan.effective");
    expect(handler).toMatch(
      /computeRemoveFromExecuteColumn\(\s*effectiveIds,\s*prev\[activeEventName\]/,
    );
  });

  it("passes the same derived plans to desktop and smartphone controls", () => {
    const appSource = readSource("src/App.tsx");
    const headerSource = readSource(
      "src/features/app-shell/components/AppHeaderShell.tsx",
    );
    const overlaySource = readSource(
      "src/features/app-shell/components/AppOverlayLayer.tsx",
    );

    expect(
      appSource.match(/candidateMovePlan=\{candidateMovePlan\}/g),
    ).toHaveLength(2);
    expect(
      appSource.match(/executeMovePlan=\{executeMovePlan\}/g),
    ).toHaveLength(2);
    expect(headerSource).toContain("formatMovePlanCount(candidateMovePlan)");
    expect(headerSource).toContain("candidateMovePlan.requested");
    expect(overlaySource).toContain("formatMovePlanCount(candidateMovePlan)");
    expect(overlaySource).toContain("candidateMovePlan.requested");
  });
});
