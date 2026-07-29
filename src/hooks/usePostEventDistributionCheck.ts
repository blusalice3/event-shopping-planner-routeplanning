import { useEffect, useState } from 'react';

const STORAGE_KEY = 'postEventDistributionCheckEnabled';
export const DEFAULT_POST_EVENT_DISTRIBUTION_CHECK_ENABLED = true;

export function usePostEventDistributionCheck() {
  const [postEventDistributionCheckEnabled, setPostEventDistributionCheckEnabled] =
    useState<boolean>(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'true') return true;
        if (saved === 'false') return false;
      } catch {
        // Ignore unavailable or malformed localStorage payload.
      }
      return DEFAULT_POST_EVENT_DISTRIBUTION_CHECK_ENABLED;
    });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(postEventDistributionCheckEnabled));
    } catch {
      // Ignore unavailable localStorage writes.
    }
  }, [postEventDistributionCheckEnabled]);

  return {
    postEventDistributionCheckEnabled,
    setPostEventDistributionCheckEnabled,
    DEFAULT_POST_EVENT_DISTRIBUTION_CHECK_ENABLED,
  } as const;
}
