// @vitest-environment jsdom

import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDisableLimitedPurchaseQuantityCheck } from "./useDisableLimitedPurchaseQuantityCheck";

describe("useDisableLimitedPurchaseQuantityCheck", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false", () => {
    const { result } = renderHook(() =>
      useDisableLimitedPurchaseQuantityCheck(),
    );

    expect(result.current.disableLimitedPurchaseQuantityCheck).toBe(false);
  });

  it("loads true from localStorage", () => {
    localStorage.setItem("disableLimitedPurchaseQuantityCheck", "true");

    const { result } = renderHook(() =>
      useDisableLimitedPurchaseQuantityCheck(),
    );

    expect(result.current.disableLimitedPurchaseQuantityCheck).toBe(true);
  });

  it("persists changes to localStorage", () => {
    const { result } = renderHook(() =>
      useDisableLimitedPurchaseQuantityCheck(),
    );

    act(() => {
      result.current.setDisableLimitedPurchaseQuantityCheck(true);
    });

    expect(localStorage.getItem("disableLimitedPurchaseQuantityCheck")).toBe(
      "true",
    );
  });
});
