import { useEffect, useState } from 'react';

const STORAGE_KEY = 'disableLimitedPurchaseQuantityCheck';

export function useDisableLimitedPurchaseQuantityCheck() {
  const [disableLimitedPurchaseQuantityCheck, setDisableLimitedPurchaseQuantityCheck] =
    useState<boolean>(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) return saved === 'true';
      } catch {
        // Ignore malformed localStorage payload.
      }
      return false;
    });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(disableLimitedPurchaseQuantityCheck));
  }, [disableLimitedPurchaseQuantityCheck]);

  return {
    disableLimitedPurchaseQuantityCheck,
    setDisableLimitedPurchaseQuantityCheck,
  } as const;
}
