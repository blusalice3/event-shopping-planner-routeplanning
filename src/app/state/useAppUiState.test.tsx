// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppUiState } from "./useAppUiState";

describe("useAppUiState", () => {
  it("keeps non-overlay UI setters composable after overlay ownership moved", () => {
    const { result } = renderHook(() => useAppUiState());

    act(() => {
      result.current.setSearchKeyword("イベントA");
      result.current.setBlockSortDirection("asc");
      result.current.setRecentlyChangedItemIds(
        (current) => new Set([...current, "item-1"]),
      );
    });

    expect(result.current).toMatchObject({
      searchKeyword: "イベントA",
      blockSortDirection: "asc",
    });
    expect(result.current.recentlyChangedItemIds).toEqual(new Set(["item-1"]));
  });

  it("selects the responsive layout only during reducer initialization", () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });
    const { result } = renderHook(() => useAppUiState());

    expect(result.current.layoutMode).toBe("smartphone");

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalWidth,
    });
  });
});
