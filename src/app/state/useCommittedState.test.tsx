// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommittedState } from "./useCommittedState";

describe("useCommittedState", () => {
  it("feeds sequential functional commands from the synchronous committed value", () => {
    const { result } = renderHook(() => useCommittedState({ count: 0 }));

    act(() => {
      result.current.set((current) => ({ count: current.count + 1 }));
      result.current.set((current) => ({ count: current.count + 1 }));
    });

    expect(result.current.value).toEqual({ count: 2 });
    expect(result.current.valueRef.current).toBe(result.current.value);
  });

  it("returns the exact committed result from a domain update", () => {
    const { result } = renderHook(() => useCommittedState<string[]>([]));
    let committed: string[] | undefined;

    act(() => {
      committed = result.current.update((current) => [...current, "A"]);
    });

    expect(committed).toEqual(["A"]);
    expect(result.current.value).toBe(committed);
  });
});
