import { useEffect, useState } from "react";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

const STORAGE_KEY = "disableLimitedPurchaseQuantityCheck";

export function useDisableLimitedPurchaseQuantityCheck(
  preferences: PreferencePersistencePort,
) {
  const [
    disableLimitedPurchaseQuantityCheck,
    setDisableLimitedPurchaseQuantityCheck,
  ] = useState<boolean>(() => {
    try {
      const saved = preferences.loadPreference(STORAGE_KEY);
      if (saved !== null) return saved === "true";
    } catch {
      // Ignore malformed localStorage payload.
    }
    return false;
  });

  useEffect(() => {
    preferences.savePreference(
      STORAGE_KEY,
      String(disableLimitedPurchaseQuantityCheck),
    );
  }, [disableLimitedPurchaseQuantityCheck, preferences]);

  return {
    disableLimitedPurchaseQuantityCheck,
    setDisableLimitedPurchaseQuantityCheck,
  } as const;
}
