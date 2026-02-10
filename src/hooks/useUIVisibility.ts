import { useState, useEffect, useMemo } from 'react';
import { ViewMode } from '../types';

export type UIVisibilityConfig = { header: boolean; tabBar: boolean };
export type UIVisibilitySettings = {
  focus_sp_mapOn: UIVisibilityConfig;
  focus_sp_mapOff: UIVisibilityConfig;
  focus_pc_mapOn: UIVisibilityConfig;
  focus_pc_mapOff: UIVisibilityConfig;
  execute_sp: UIVisibilityConfig;
  execute_pc: UIVisibilityConfig;
};

export const DEFAULT_UI_VISIBILITY: UIVisibilitySettings = {
  focus_sp_mapOn: { header: false, tabBar: false },
  focus_sp_mapOff: { header: true, tabBar: true },
  focus_pc_mapOn: { header: true, tabBar: true },
  focus_pc_mapOff: { header: true, tabBar: true },
  execute_sp: { header: true, tabBar: true },
  execute_pc: { header: true, tabBar: true },
};

export function useUIVisibility(
  activeEventName: string | null,
  currentMode: ViewMode,
  layoutMode: 'pc' | 'smartphone',
  focusModeMapVisible: boolean,
) {
  const [uiVisibilitySettings, setUiVisibilitySettings] = useState<UIVisibilitySettings>(() => {
    try {
      const saved = localStorage.getItem('uiVisibilitySettings');
      if (saved) {
        return { ...DEFAULT_UI_VISIBILITY, ...JSON.parse(saved) };
      }
    } catch { /* ignore */ }
    return DEFAULT_UI_VISIBILITY;
  });
  const [uiVisibilityOverride, setUiVisibilityOverride] = useState(false);
  const [uiSettingsPanelOpen, setUiSettingsPanelOpen] = useState(false);

  // Persist settings
  useEffect(() => {
    localStorage.setItem('uiVisibilitySettings', JSON.stringify(uiVisibilitySettings));
  }, [uiVisibilitySettings]);

  const { showHeaderBar, showTabBar, rawHideSomething } = useMemo(() => {
    if (!activeEventName || uiVisibilityOverride) {
      return { showHeaderBar: true, showTabBar: true, rawHideSomething: false };
    }

    const layout = layoutMode === 'smartphone' ? 'sp' : 'pc';

    let rawHeader = true, rawTabBar = true;
    if (currentMode === 'focus') {
      const key = `focus_${layout}_${focusModeMapVisible ? 'mapOn' : 'mapOff'}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    } else if (currentMode === 'execute') {
      const key = `execute_${layout}` as keyof UIVisibilitySettings;
      const config = uiVisibilitySettings[key];
      rawHeader = config.header;
      rawTabBar = config.tabBar;
    }

    const hideSomething = !rawHeader || !rawTabBar;
    return {
      showHeaderBar: uiVisibilityOverride ? true : rawHeader,
      showTabBar: uiVisibilityOverride ? true : rawTabBar,
      rawHideSomething: hideSomething,
    };
  }, [uiVisibilityOverride, activeEventName, currentMode, layoutMode, focusModeMapVisible, uiVisibilitySettings]);

  return {
    uiVisibilitySettings,
    setUiVisibilitySettings,
    uiVisibilityOverride,
    setUiVisibilityOverride,
    uiSettingsPanelOpen,
    setUiSettingsPanelOpen,
    showHeaderBar,
    showTabBar,
    rawHideSomething,
  };
}
