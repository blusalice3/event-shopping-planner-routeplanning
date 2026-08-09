import { useEffect, useState } from "react";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

export type ThemeMode = "system" | "light" | "dark";

export function useThemeMode(preferences: PreferencePersistencePort) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      return (preferences.loadPreference("themeMode") as ThemeMode) || "system";
    } catch {
      return "system";
    }
  });

  useEffect(() => {
    const applyTheme = () => {
      const html = document.documentElement;
      html.setAttribute("data-theme", themeMode);
      html.classList.remove("dark");

      if (themeMode === "dark") {
        html.classList.add("dark");
      } else if (
        themeMode === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
      ) {
        html.classList.add("dark");
      }
    };

    applyTheme();
    preferences.savePreference("themeMode", themeMode);

    if (themeMode === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme();
      mediaQuery.addEventListener("change", handler);
      return () => mediaQuery.removeEventListener("change", handler);
    }
  }, [preferences, themeMode]);

  return { themeMode, setThemeMode } as const;
}
