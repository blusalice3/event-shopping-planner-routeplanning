import { useEffect, useState } from "react";
import {
  PurchaseStatusControlModes,
  type PurchaseStatusControlMode,
} from "../types/item";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

const STORAGE_KEY = "purchaseStatusControlMode";
export const DEFAULT_PURCHASE_STATUS_CONTROL_MODE: PurchaseStatusControlMode =
  "cycle";
const VALID_MODES = new Set<string>(PurchaseStatusControlModes);

export function usePurchaseStatusControlMode(
  preferences: PreferencePersistencePort,
) {
  const [purchaseStatusControlMode, setPurchaseStatusControlMode] =
    useState<PurchaseStatusControlMode>(() => {
      try {
        const saved = preferences.loadPreference(STORAGE_KEY);
        if (saved && VALID_MODES.has(saved)) {
          return saved as PurchaseStatusControlMode;
        }
      } catch {
        // Ignore unavailable or malformed localStorage payloads.
      }
      return DEFAULT_PURCHASE_STATUS_CONTROL_MODE;
    });

  useEffect(() => {
    try {
      preferences.savePreference(STORAGE_KEY, purchaseStatusControlMode);
    } catch {
      // Ignore unavailable localStorage writes.
    }
  }, [preferences, purchaseStatusControlMode]);

  return {
    purchaseStatusControlMode,
    setPurchaseStatusControlMode,
    DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  } as const;
}
