import { describe, expect, it } from "vitest";
import type { DayMapData } from "../types/map";
import {
  buildDayMapPathfindingSignature,
  buildDayMapVisitLookupSignature,
  findRouteLookupNumberCell,
  getRouteLookupNumberCellEntries,
} from "./mapRoutingSignature";

const makeMap = (overrides: Partial<DayMapData> = {}): DayMapData => ({
  sheetName: "Sheet",
  rows: 10,
  cols: 10,
  maxRow: 10,
  maxCol: 10,
  cells: [
    {
      row: 1,
      col: 1,
      value: 1,
      backgroundColor: "#fff",
      borders: { top: null, right: null, bottom: null, left: null },
    },
  ],
  mergedCells: [],
  blocks: [
    {
      name: "A",
      startRow: 1,
      startCol: 1,
      endRow: 3,
      endCol: 3,
      numberCells: [
        { row: 3, col: 3, value: 1 },
        { row: 2, col: 2, value: 1 },
        { row: 1, col: 3, value: 2 },
      ],
      color: "#000",
    },
  ],
  ...overrides,
});

describe("map routing signatures", () => {
  it("finds duplicate number cells deterministically by value row and col", () => {
    const block = makeMap().blocks[0];

    expect(findRouteLookupNumberCell(block, 1)).toEqual({
      row: 2,
      col: 2,
      value: 1,
    });
    expect(getRouteLookupNumberCellEntries(block)).toEqual([
      [1, { row: 2, col: 2, value: 1 }],
      [2, { row: 1, col: 3, value: 2 }],
    ]);
  });

  it("keeps visit lookup signature stable when uniquely named blocks are reordered", () => {
    const a = makeMap({
      blocks: [
        { ...makeMap().blocks[0], name: "B" },
        { ...makeMap().blocks[0], name: "A" },
      ],
    });
    const b = makeMap({ blocks: [...a.blocks].reverse() });

    expect(buildDayMapVisitLookupSignature(a)).toBe(
      buildDayMapVisitLookupSignature(b),
    );
  });

  it("changes visit lookup signature when duplicate named blocks are reordered", () => {
    const a = makeMap({
      blocks: [
        {
          ...makeMap().blocks[0],
          name: "A",
          numberCells: [{ row: 1, col: 1, value: 1 }],
        },
        {
          ...makeMap().blocks[0],
          name: "A",
          numberCells: [{ row: 2, col: 2, value: 1 }],
        },
      ],
    });
    const b = makeMap({ blocks: [...a.blocks].reverse() });

    expect(buildDayMapVisitLookupSignature(a)).not.toBe(
      buildDayMapVisitLookupSignature(b),
    );
  });

  it("does not change visit lookup signature when only non-selected duplicate numberCells change", () => {
    const a = makeMap();
    const b = makeMap({
      blocks: [
        {
          ...a.blocks[0],
          numberCells: [
            { row: 99, col: 99, value: 1 },
            { row: 2, col: 2, value: 1 },
            { row: 1, col: 3, value: 2 },
          ],
        },
      ],
    });

    expect(buildDayMapVisitLookupSignature(a)).toBe(
      buildDayMapVisitLookupSignature(b),
    );
  });

  it("uses the same preferred cell rule for lookup and signature entries", () => {
    const block = makeMap().blocks[0];

    expect(findRouteLookupNumberCell(block, 1)).toEqual(
      getRouteLookupNumberCellEntries(block).find(
        ([value]) => value === 1,
      )?.[1],
    );
  });

  it("changes visit lookup signature when selected duplicate number cell coordinates change", () => {
    const base = makeMap();
    const changed = makeMap({
      blocks: [
        {
          ...base.blocks[0],
          numberCells: [
            { row: 10, col: 10, value: 1 },
            { row: 1, col: 2, value: 1 },
            { row: 1, col: 3, value: 2 },
          ],
        },
      ],
    });

    expect(buildDayMapVisitLookupSignature(changed)).not.toBe(
      buildDayMapVisitLookupSignature(base),
    );
  });

  it("changes visit lookup signature when block name changes", () => {
    const base = makeMap();
    const changed = makeMap({ blocks: [{ ...base.blocks[0], name: "B" }] });

    expect(buildDayMapVisitLookupSignature(changed)).not.toBe(
      buildDayMapVisitLookupSignature(base),
    );
  });

  it("changes visit lookup signature when a block rename makes case-insensitive fallback ambiguous", () => {
    const base = makeMap({
      blocks: [
        { ...makeMap().blocks[0], name: "A" },
        { ...makeMap().blocks[0], name: "B" },
      ],
    });
    const ambiguous = makeMap({
      blocks: [
        { ...makeMap().blocks[0], name: "A" },
        { ...makeMap().blocks[0], name: "a" },
      ],
    });

    expect(buildDayMapVisitLookupSignature(ambiguous)).not.toBe(
      buildDayMapVisitLookupSignature(base),
    );
  });

  it("keeps visit lookup signature stable when case-insensitive duplicate block names are reordered without exact duplicate names", () => {
    const map = makeMap({
      blocks: [
        { ...makeMap().blocks[0], name: "A" },
        { ...makeMap().blocks[0], name: "a" },
      ],
    });

    expect(buildDayMapVisitLookupSignature(map)).toBe(
      buildDayMapVisitLookupSignature(
        makeMap({ blocks: [...map.blocks].reverse() }),
      ),
    );
  });

  it("does not change visit lookup signature when block display and range fields change", () => {
    const base = makeMap();
    const changed = makeMap({
      blocks: [
        {
          ...base.blocks[0],
          startRow: 99,
          startCol: 98,
          endRow: 97,
          endCol: 96,
          color: "#f00",
          id: "block-id",
          nameCells: [{ row: 5, col: 5 }],
          cellGroups: [{ type: "individual", cells: [{ row: 6, col: 6 }] }],
          isAutoDetected: true,
          isWallBlock: true,
        },
      ],
    });

    expect(buildDayMapVisitLookupSignature(changed)).toBe(
      buildDayMapVisitLookupSignature(base),
    );
  });

  it("does not collide when names contain delimiter-like characters", () => {
    expect(
      buildDayMapVisitLookupSignature(
        makeMap({ blocks: [{ ...makeMap().blocks[0], name: "A\u001fB" }] }),
      ),
    ).not.toBe(
      buildDayMapVisitLookupSignature(
        makeMap({
          blocks: [
            {
              ...makeMap().blocks[0],
              name: "A",
              numberCells: [{ row: 2, col: 2, value: 1 }],
            },
          ],
        }),
      ),
    );
  });

  it("changes pathfinding signature for cell value, value type, text, background, and bounds changes", () => {
    const base = makeMap();
    expect(
      buildDayMapPathfindingSignature(
        makeMap({ cells: [{ ...base.cells[0], value: 2 }] }),
      ),
    ).not.toBe(buildDayMapPathfindingSignature(base));
    expect(
      buildDayMapPathfindingSignature(
        makeMap({ cells: [{ ...base.cells[0], value: "1" }] }),
      ),
    ).not.toBe(buildDayMapPathfindingSignature(base));
    expect(
      buildDayMapPathfindingSignature(
        makeMap({ cells: [{ ...base.cells[0], value: "wall-b" }] }),
      ),
    ).not.toBe(
      buildDayMapPathfindingSignature(
        makeMap({ cells: [{ ...base.cells[0], value: "wall-a" }] }),
      ),
    );
    expect(
      buildDayMapPathfindingSignature(
        makeMap({ cells: [{ ...base.cells[0], backgroundColor: "#000" }] }),
      ),
    ).not.toBe(buildDayMapPathfindingSignature(base));
    expect(buildDayMapPathfindingSignature(makeMap({ maxRow: 11 }))).not.toBe(
      buildDayMapPathfindingSignature(base),
    );
    expect(buildDayMapPathfindingSignature(makeMap({ maxCol: 11 }))).not.toBe(
      buildDayMapPathfindingSignature(base),
    );
  });

  it("ignores sheetName rows cols fontColor borders merged flags and mergedCells for pathfinding signature", () => {
    const base = makeMap();

    expect(
      buildDayMapPathfindingSignature(
        makeMap({
          sheetName: "Other",
          rows: 99,
          cols: 99,
          cells: [
            {
              ...base.cells[0],
              fontColor: "#f00",
              borders: {
                top: { style: "thin", color: "#000" },
                right: null,
                bottom: null,
                left: null,
              },
              isMerged: true,
              mergeParent: { row: 1, col: 1 },
              isVerticalText: true,
            },
          ],
          mergedCells: [
            { startRow: 1, startCol: 1, endRow: 1, endCol: 1, value: "x" },
          ],
        }),
      ),
    ).toBe(buildDayMapPathfindingSignature(base));
  });
});
