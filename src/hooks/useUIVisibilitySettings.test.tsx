// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_UI_VISIBILITY,
  type UIVisibilitySettings,
  useDeferredUIVisibilitySettings,
  useUIVisibilitySettings,
} from "./useUIVisibilitySettings";

const cloneSettings = (settings: UIVisibilitySettings): UIVisibilitySettings =>
  structuredClone(settings);

describe("useUIVisibilitySettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("既存の保存値には保存状態表示の既定値を補完する", () => {
    localStorage.setItem(
      "uiVisibilitySettings",
      JSON.stringify({
        execute_pc: { header: false, tabBar: true },
      }),
    );

    const { result } = renderHook(() => useUIVisibilitySettings());

    expect(result.current.uiVisibilitySettings.execute_pc.header).toBe(false);
    expect(result.current.uiVisibilitySettings.showPersistenceStatus).toBe(
      true,
    );
  });

  it("保存状態表示をオフにした設定を復元する", () => {
    localStorage.setItem(
      "uiVisibilitySettings",
      JSON.stringify({ showPersistenceStatus: false }),
    );

    const { result } = renderHook(() => useUIVisibilitySettings());

    expect(result.current.uiVisibilitySettings.showPersistenceStatus).toBe(
      false,
    );
  });
});

describe("useDeferredUIVisibilitySettings", () => {
  it("commits checkbox changes only when the settings panel closes", () => {
    const appliedSettings = cloneSettings(DEFAULT_UI_VISIBILITY);
    const setAppliedSettings = vi.fn();
    const setVisibilityOverride = vi.fn();
    const { result } = renderHook(() =>
      useDeferredUIVisibilitySettings({
        appliedSettings,
        setAppliedSettings,
        setVisibilityOverride,
      }),
    );

    act(() => result.current.openPanel());
    act(() => result.current.updateDraftConfig("execute_pc", "header", false));

    expect(result.current.draftSettings.execute_pc.header).toBe(false);
    expect(appliedSettings.execute_pc.header).toBe(true);
    expect(setAppliedSettings).not.toHaveBeenCalled();
    expect(setVisibilityOverride).not.toHaveBeenCalled();

    act(() => result.current.closePanel());

    expect(setAppliedSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        execute_pc: { header: false, tabBar: true },
      }),
    );
    expect(setVisibilityOverride).toHaveBeenCalledWith(false);
  });

  it("starts every edit session from the latest applied settings", () => {
    const setAppliedSettings = vi.fn();
    const setVisibilityOverride = vi.fn();
    const initialSettings = cloneSettings(DEFAULT_UI_VISIBILITY);
    const latestSettings = cloneSettings(DEFAULT_UI_VISIBILITY);
    latestSettings.focus_pc_mapOn.tabBar = false;

    const { result, rerender } = renderHook(
      ({ appliedSettings }) =>
        useDeferredUIVisibilitySettings({
          appliedSettings,
          setAppliedSettings,
          setVisibilityOverride,
        }),
      { initialProps: { appliedSettings: initialSettings } },
    );

    act(() => result.current.openPanel());
    act(() => result.current.closePanel());
    rerender({ appliedSettings: latestSettings });
    act(() => result.current.openPanel());

    expect(result.current.draftSettings.focus_pc_mapOn.tabBar).toBe(false);
  });

  it("can close without changing the visibility override", () => {
    const setAppliedSettings = vi.fn();
    const setVisibilityOverride = vi.fn();
    const { result } = renderHook(() =>
      useDeferredUIVisibilitySettings({
        appliedSettings: cloneSettings(DEFAULT_UI_VISIBILITY),
        setAppliedSettings,
        setVisibilityOverride,
      }),
    );

    act(() => result.current.openPanel());
    act(() => result.current.closePanel({ resetVisibilityOverride: false }));

    expect(setAppliedSettings).toHaveBeenCalledOnce();
    expect(setVisibilityOverride).not.toHaveBeenCalled();
  });
});
