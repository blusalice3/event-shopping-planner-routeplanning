import { useCallback, useEffect, useState } from "react";

export type SpaceNavigatorSide = "left" | "right";

export interface SpaceNavigatorSettings {
  railVisible: boolean;
  footerButtonVisible: boolean;
  side: SpaceNavigatorSide;
}

export const DEFAULT_SPACE_NAVIGATOR_SETTINGS: SpaceNavigatorSettings = {
  railVisible: true,
  footerButtonVisible: true,
  side: "left",
};

const STORAGE_KEY = "spaceNavigatorSettings";

const isSide = (value: unknown): value is SpaceNavigatorSide =>
  value === "left" || value === "right";

const readSettings = (): SpaceNavigatorSettings => {
  if (typeof window === "undefined") return DEFAULT_SPACE_NAVIGATOR_SETTINGS;

  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_SPACE_NAVIGATOR_SETTINGS;

    const parsed = JSON.parse(saved) as Partial<SpaceNavigatorSettings>;
    return {
      railVisible:
        typeof parsed.railVisible === "boolean"
          ? parsed.railVisible
          : DEFAULT_SPACE_NAVIGATOR_SETTINGS.railVisible,
      footerButtonVisible:
        typeof parsed.footerButtonVisible === "boolean"
          ? parsed.footerButtonVisible
          : DEFAULT_SPACE_NAVIGATOR_SETTINGS.footerButtonVisible,
      side: isSide(parsed.side)
        ? parsed.side
        : DEFAULT_SPACE_NAVIGATOR_SETTINGS.side,
    };
  } catch {
    return DEFAULT_SPACE_NAVIGATOR_SETTINGS;
  }
};

export function useSpaceNavigatorSettings() {
  const [settings, setSettings] =
    useState<SpaceNavigatorSettings>(readSettings);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage can be unavailable in private browsing or a locked-down webview.
    }
  }, [settings]);

  const updateSettings = useCallback(
    (patch: Partial<SpaceNavigatorSettings>) => {
      setSettings((current) => ({ ...current, ...patch }));
    },
    [],
  );

  const resetSettings = useCallback(() => {
    setSettings(DEFAULT_SPACE_NAVIGATOR_SETTINGS);
  }, []);

  return {
    settings,
    setSettings,
    updateSettings,
    resetSettings,
  } as const;
}
