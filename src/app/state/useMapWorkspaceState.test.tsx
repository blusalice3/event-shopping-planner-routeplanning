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
    const preferenceCommands = {
      loadPreference: vi.fn(() => null),
      savePreference: vi.fn(),
    };
    const notify = vi.fn();
    const { result } = renderHook(() =>
      useMapWorkspaceState(preferenceCommands, notify),
    );

    act(() => {
      result.current.setMapTabMenuOpen("map-toggle");
      result.current.setMapTabMenuOpen((current) => `${current}-updated`);
      result.current.setVertexGuideOptions((current) => ({
        ...current,
        showGrid: false,
      }));
    });

    expect(result.current.mapTabMenuOpen).toBe("map-toggle-updated");
    expect(result.current.vertexGuideOptions).toEqual({
      showGrid: false,
      showRuler: true,
    });
    expect(preferenceCommands.savePreference).toHaveBeenCalledWith(
      "mapSmartInsertEnabled",
      "true",
    );
    expect(preferenceCommands.savePreference).toHaveBeenCalledWith(
      "mapSmartInsertMode",
      "map",
    );
  });

  it("does not resave preferences when the injected overlay notifier changes", () => {
    const preferenceCommands = {
      loadPreference: vi.fn(() => null),
      savePreference: vi.fn(),
    };
    const firstNotify = vi.fn();
    const secondNotify = vi.fn();
    const { rerender } = renderHook(
      ({ notify }) => useMapWorkspaceState(preferenceCommands, notify),
      { initialProps: { notify: firstNotify } },
    );
    expect(preferenceCommands.savePreference).toHaveBeenCalledTimes(2);

    rerender({ notify: secondNotify });

    expect(preferenceCommands.savePreference).toHaveBeenCalledTimes(2);
  });
});
