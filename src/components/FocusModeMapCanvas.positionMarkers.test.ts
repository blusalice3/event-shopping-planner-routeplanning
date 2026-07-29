import { describe, expect, it } from "vitest";
import {
  FOCUS_MAP_OFFICIAL_MARKER_STYLE,
  FOCUS_MAP_TEMPORARY_MARKER_STYLE,
  resolveFocusMapCellPositionFlags,
  resolveFocusMapPositionKeys,
  resolveFocusMapRouteProgressState,
} from "./FocusModeMapCanvas";

describe("FocusModeMapCanvas position markers", () => {
  it("preserves the legacy single-position behavior when new props are omitted", () => {
    expect(
      resolveFocusMapPositionKeys({
        currentVisitKey: "2026-01-01-A-01a",
      }),
    ).toEqual({
      officialVisitKey: "2026-01-01-A-01a",
      temporaryVisitKey: null,
      centerVisitKey: "2026-01-01-A-01a",
    });
  });

  it("keeps the official marker separate and centers the temporary target", () => {
    expect(
      resolveFocusMapPositionKeys({
        currentVisitKey: "2026-01-01-Y-12a",
        formalCurrentVisitKey: "2026-01-01-A-01a",
        temporaryVisitKey: "2026-01-01-Y-12a",
      }),
    ).toEqual({
      officialVisitKey: "2026-01-01-A-01a",
      temporaryVisitKey: "2026-01-01-Y-12a",
      centerVisitKey: "2026-01-01-Y-12a",
    });
  });

  it("can mark both positions on one numeric map cell", () => {
    const flags = resolveFocusMapCellPositionFlags(
      new Set(["2026-01-01-Y-12a", "2026-01-01-Y-12b"]),
      {
        officialVisitKey: "2026-01-01-Y-12a",
        temporaryVisitKey: "2026-01-01-Y-12b",
      },
    );

    expect(flags).toEqual({
      isOfficialPosition: true,
      isTemporaryPosition: true,
    });
    expect(FOCUS_MAP_OFFICIAL_MARKER_STYLE).toMatchObject({
      lineStyle: "solid",
      pin: "\u{1F4CD}",
    });
    expect(FOCUS_MAP_TEMPORARY_MARKER_STYLE).toMatchObject({
      lineStyle: "dashed",
      frameCount: 2,
      label: "一時",
    });
  });

  it("classifies route colors only from the supplied formal route index", () => {
    expect(resolveFocusMapRouteProgressState(0, 2)).toBe("visited");
    expect(resolveFocusMapRouteProgressState(1, 2)).toBe("current");
    expect(resolveFocusMapRouteProgressState(2, 2)).toBe("upcoming");
  });
});
