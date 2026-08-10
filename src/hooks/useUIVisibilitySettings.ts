import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { PreferencePersistencePort } from "../app/ports/PersistenceCommandPort";

export type UIVisibilityConfig = {
  header: boolean;
  tabBar: boolean;
};

export type UIVisibilityModeKey =
  | "focus_sp_mapOn"
  | "focus_sp_mapOff"
  | "focus_pc_mapOn"
  | "focus_pc_mapOff"
  | "execute_sp"
  | "execute_pc";

export type UIVisibilitySettings = Record<
  UIVisibilityModeKey,
  UIVisibilityConfig
> & {
  showPersistenceStatus: boolean;
};

export const DEFAULT_UI_VISIBILITY: UIVisibilitySettings = {
  focus_sp_mapOn: { header: false, tabBar: false },
  focus_sp_mapOff: { header: true, tabBar: true },
  focus_pc_mapOn: { header: true, tabBar: true },
  focus_pc_mapOff: { header: true, tabBar: true },
  execute_sp: { header: true, tabBar: true },
  execute_pc: { header: true, tabBar: true },
  showPersistenceStatus: true,
};

type CloseUIVisibilityPanelOptions = {
  resetVisibilityOverride?: boolean;
};

type DeferredUIVisibilitySettingsParams = {
  appliedSettings: UIVisibilitySettings;
  setAppliedSettings: Dispatch<SetStateAction<UIVisibilitySettings>>;
  setVisibilityOverride: Dispatch<SetStateAction<boolean>>;
};

export function useUIVisibilitySettings(
  preferences: PreferencePersistencePort,
) {
  const [uiVisibilitySettings, setUiVisibilitySettings] =
    useState<UIVisibilitySettings>(() => {
      try {
        const saved = preferences.loadPreference("uiVisibilitySettings");
        if (saved) {
          return { ...DEFAULT_UI_VISIBILITY, ...JSON.parse(saved) };
        }
      } catch {
        // Ignore malformed localStorage payload.
      }
      return DEFAULT_UI_VISIBILITY;
    });

  useEffect(() => {
    preferences.savePreference(
      "uiVisibilitySettings",
      JSON.stringify(uiVisibilitySettings),
    );
  }, [preferences, uiVisibilitySettings]);

  return { uiVisibilitySettings, setUiVisibilitySettings } as const;
}

export function useDeferredUIVisibilitySettings({
  appliedSettings,
  setAppliedSettings,
  setVisibilityOverride,
}: DeferredUIVisibilitySettingsParams) {
  const [draftSettings, setDraftSettingsState] = useState(appliedSettings);
  const [isPanelOpen, setIsPanelOpenState] = useState(false);
  const appliedSettingsRef = useRef(appliedSettings);
  const draftSettingsRef = useRef(draftSettings);
  const isPanelOpenRef = useRef(isPanelOpen);

  useEffect(() => {
    appliedSettingsRef.current = appliedSettings;
  }, [appliedSettings]);

  const setDraftSettings = useCallback<
    Dispatch<SetStateAction<UIVisibilitySettings>>
  >((action) => {
    const nextSettings =
      typeof action === "function" ? action(draftSettingsRef.current) : action;
    draftSettingsRef.current = nextSettings;
    setDraftSettingsState(nextSettings);
  }, []);

  const openPanel = useCallback(() => {
    const nextDraft = appliedSettingsRef.current;
    draftSettingsRef.current = nextDraft;
    setDraftSettingsState(nextDraft);
    isPanelOpenRef.current = true;
    setIsPanelOpenState(true);
  }, []);

  const closePanel = useCallback(
    (options: CloseUIVisibilityPanelOptions = {}) => {
      if (isPanelOpenRef.current) {
        setAppliedSettings(draftSettingsRef.current);
      }
      isPanelOpenRef.current = false;
      setIsPanelOpenState(false);
      if (options.resetVisibilityOverride !== false) {
        setVisibilityOverride(false);
      }
    },
    [setAppliedSettings, setVisibilityOverride],
  );

  const togglePanel = useCallback(() => {
    if (isPanelOpenRef.current) {
      closePanel();
      return;
    }
    openPanel();
  }, [closePanel, openPanel]);

  const updateDraftConfig = useCallback(
    (
      key: UIVisibilityModeKey,
      field: keyof UIVisibilityConfig,
      value: boolean,
    ) => {
      setDraftSettings((previous) => ({
        ...previous,
        [key]: {
          ...DEFAULT_UI_VISIBILITY[key],
          ...previous[key],
          [field]: value,
        },
      }));
    },
    [setDraftSettings],
  );

  return {
    draftSettings,
    isPanelOpen,
    setDraftSettings,
    openPanel,
    closePanel,
    togglePanel,
    updateDraftConfig,
  } as const;
}
