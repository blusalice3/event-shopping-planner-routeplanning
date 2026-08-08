// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialMapWorkspaceState,
  useMapWorkspaceState,
} from "./useMapWorkspaceState";

describe("map workspace state", () => {
  it("loads versioned preferences while failing closed on invalid values", () => {
    const storage = {
      getItem: vi.fn((key: string) =>
        key === "mapSmartInsertEnabled" ? "false" : "unknown-mode",
      ),
    };

    expect(createInitialMapWorkspaceState(storage)).toMatchObject({
      mapSmartInsertEnabled: false,
      mapSmartInsertMode: "map",
      mapIsRouteVisible: true,
    });
  });

  it("supports the existing React setter contract through one typed reducer", () => {
    const { result } = renderHook(() => useMapWorkspaceState());

    act(() => {
      result.current.setVisitListOriginalOrder(["a"]);
      result.current.setVisitListOriginalOrder((current) => [...current, "b"]);
      result.current.setVertexGuideOptions((current) => ({
        ...current,
        showGrid: false,
      }));
    });

    expect(result.current.visitListOriginalOrder).toEqual(["a", "b"]);
    expect(result.current.vertexGuideOptions).toEqual({
      showGrid: false,
      showRuler: true,
    });
  });
});
