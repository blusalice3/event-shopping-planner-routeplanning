// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAppNavigationController } from "./useAppNavigationController";

describe("useAppNavigationController", () => {
  it("projects typed commands to the legacy view consumed by the shell", () => {
    const { result } = renderHook(() => useAppNavigationController());

    expect(result.current.state).toEqual({ kind: "event-list" });
    expect(result.current).toMatchObject({
      activeEventName: null,
      activeTab: "eventList",
      mapViewActive: false,
    });

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
    expect(result.current).toMatchObject({
      activeEventName: "イベントA",
      activeTab: "2日目",
      mapViewActive: true,
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
    expect(result.current).toMatchObject({
      activeEventName: null,
      activeTab: "eventList",
      mapViewActive: false,
    });
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
