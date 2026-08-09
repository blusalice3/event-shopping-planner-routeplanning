// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppNavigationController } from "./useAppNavigationController";

describe("useAppNavigationController", () => {
  it("exposes typed state transitions without a scalar projection", () => {
    const { result } = renderHook(() => useAppNavigationController());

    expect(result.current.state).toEqual({ kind: "event-list" });
    expect(Object.keys(result.current).sort()).toEqual([
      "commands",
      "dispatch",
      "state",
    ]);

    act(() => {
      result.current.commands.openEvent("イベントA", "1日目");
    });
    expect(result.current.state).toEqual({
      kind: "event",
      eventName: "イベントA",
      day: "1日目",
      surface: "list",
    });

    act(() => {
      result.current.commands.toggleEventSurface();
      result.current.commands.changeDay("2日目");
    });
    expect(result.current.state).toEqual({
      kind: "event",
      eventName: "イベントA",
      day: "2日目",
      surface: "map",
    });

    act(() => {
      result.current.commands.showImport("イベントA");
    });
    expect(result.current.state).toEqual({
      kind: "import",
      eventName: "イベントA",
    });

    act(() => {
      result.current.commands.showEventList();
    });
    expect(result.current.state).toEqual({ kind: "event-list" });
  });

  it("keeps command identities stable while state changes", () => {
    const { result } = renderHook(() => useAppNavigationController());
    const commands = result.current.commands;

    act(() => {
      result.current.commands.openEvent("イベントA", "1日目", "map");
    });

    expect(result.current.commands).toBe(commands);
  });
});
