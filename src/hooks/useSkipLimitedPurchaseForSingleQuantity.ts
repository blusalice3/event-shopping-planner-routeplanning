import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export const DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY = true;

const STORAGE_KEY = 'skipLimitedPurchaseForSingleQuantity';

const readStoredValue = (): boolean => {
  if (typeof window === 'undefined') return DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY;

  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === 'true') return true;
    if (value === 'false') return false;
    return DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY;
  } catch {
    return DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY;
  }
};

const writeStoredValue = (value: boolean) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Ignore storage failures; the in-memory setting still updates.
  }
};

export function useSkipLimitedPurchaseForSingleQuantity() {
  const [skipLimitedPurchaseForSingleQuantity, setValue] = useState(readStoredValue);

  const setSkipLimitedPurchaseForSingleQuantity = useCallback<Dispatch<SetStateAction<boolean>>>(
    (nextValue) => {
    setValue((current) => {
      const resolved = typeof nextValue === 'function' ? nextValue(current) : nextValue;
      writeStoredValue(resolved);
      return resolved;
    });
    },
    [],
  );

  return {
    skipLimitedPurchaseForSingleQuantity,
    setSkipLimitedPurchaseForSingleQuantity,
  };
}
