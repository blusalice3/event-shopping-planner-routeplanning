import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

export const DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY = true;

const STORAGE_KEY = "skipLimitedPurchaseForSingleQuantity";

const readStoredValue = (preferences: PreferencePersistencePort): boolean => {
  try {
    const value = preferences.loadPreference(STORAGE_KEY);
    if (value === "true") return true;
    if (value === "false") return false;
    return DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY;
  } catch {
    return DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY;
  }
};

const writeStoredValue = (
  preferences: PreferencePersistencePort,
  value: boolean,
) => {
  try {
    preferences.savePreference(STORAGE_KEY, String(value));
  } catch {
    // Ignore storage failures; the in-memory setting still updates.
  }
};

export function useSkipLimitedPurchaseForSingleQuantity(
  preferences: PreferencePersistencePort,
) {
  const [skipLimitedPurchaseForSingleQuantity, setValue] = useState(() =>
    readStoredValue(preferences),
  );

  const setSkipLimitedPurchaseForSingleQuantity = useCallback<
    Dispatch<SetStateAction<boolean>>
  >(
    (nextValue) => {
      setValue((current) => {
        const resolved =
          typeof nextValue === "function" ? nextValue(current) : nextValue;
        writeStoredValue(preferences, resolved);
        return resolved;
      });
    },
    [preferences],
  );

  return {
    skipLimitedPurchaseForSingleQuantity,
    setSkipLimitedPurchaseForSingleQuantity,
  };
}
