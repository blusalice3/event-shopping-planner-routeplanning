import { useEffect, useState } from "react";
import { NumberCellOutlineStyle } from "../types/map";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

const STORAGE_KEY = "numberCellOutlineStyle";
const DEFAULT_STYLE: NumberCellOutlineStyle = "rounded";

export function useNumberCellOutlineStyle(
  preferences: PreferencePersistencePort,
) {
  const [numberCellOutlineStyle, setNumberCellOutlineStyle] =
    useState<NumberCellOutlineStyle>(() => {
      try {
        const saved = preferences.loadPreference(STORAGE_KEY);
        if (saved && ["rounded", "square", "none", "dashed"].includes(saved)) {
          return saved as NumberCellOutlineStyle;
        }
      } catch {
        // Ignore malformed localStorage payload.
      }
      return DEFAULT_STYLE;
    });

  useEffect(() => {
    preferences.savePreference(STORAGE_KEY, numberCellOutlineStyle);
  }, [numberCellOutlineStyle, preferences]);

  return {
    numberCellOutlineStyle,
    setNumberCellOutlineStyle,
    DEFAULT_OUTLINE_STYLE: DEFAULT_STYLE,
  } as const;
}
