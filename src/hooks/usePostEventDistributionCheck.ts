import { useEffect, useState } from "react";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

const STORAGE_KEY = "postEventDistributionCheckEnabled";
export const DEFAULT_POST_EVENT_DISTRIBUTION_CHECK_ENABLED = true;

export function usePostEventDistributionCheck(
  preferences: PreferencePersistencePort,
) {
  const [
    postEventDistributionCheckEnabled,
    setPostEventDistributionCheckEnabled,
  ] = useState<boolean>(() => {
    try {
      const saved = preferences.loadPreference(STORAGE_KEY);
      if (saved === "true") return true;
      if (saved === "false") return false;
    } catch {
      // Ignore unavailable or malformed localStorage payload.
    }
    return DEFAULT_POST_EVENT_DISTRIBUTION_CHECK_ENABLED;
  });

  useEffect(() => {
    try {
      preferences.savePreference(
        STORAGE_KEY,
        String(postEventDistributionCheckEnabled),
      );
    } catch {
      // Ignore unavailable localStorage writes.
    }
  }, [postEventDistributionCheckEnabled, preferences]);

  return {
    postEventDistributionCheckEnabled,
    setPostEventDistributionCheckEnabled,
    DEFAULT_POST_EVENT_DISTRIBUTION_CHECK_ENABLED,
  } as const;
}
