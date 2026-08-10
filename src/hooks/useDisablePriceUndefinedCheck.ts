import { useEffect, useState } from "react";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

const STORAGE_KEY = "disablePriceUndefinedCheck";

export function useDisablePriceUndefinedCheck(
  preferences: PreferencePersistencePort,
) {
  const [disablePriceUndefinedCheck, setDisablePriceUndefinedCheck] =
    useState<boolean>(() => {
      try {
        const saved = preferences.loadPreference(STORAGE_KEY);
        if (saved !== null) return saved === "true";
      } catch {
        // Ignore malformed localStorage payload.
      }
      return false;
    });

  useEffect(() => {
    preferences.savePreference(STORAGE_KEY, String(disablePriceUndefinedCheck));
  }, [disablePriceUndefinedCheck, preferences]);

  return { disablePriceUndefinedCheck, setDisablePriceUndefinedCheck } as const;
}
