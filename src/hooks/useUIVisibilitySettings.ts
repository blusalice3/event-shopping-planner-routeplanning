import { useEffect, useState } from 'react';

export type UIVisibilityConfig = {
  header: boolean;
  tabBar: boolean;
};

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

export function useUIVisibilitySettings() {
  const [uiVisibilitySettings, setUiVisibilitySettings] = useState<UIVisibilitySettings>(() => {
    try {
      const saved = localStorage.getItem('uiVisibilitySettings');
      if (saved) {
        return { ...DEFAULT_UI_VISIBILITY, ...JSON.parse(saved) };
      }
    } catch {
      // Ignore malformed localStorage payload.
    }
    return DEFAULT_UI_VISIBILITY;
  });

  useEffect(() => {
    localStorage.setItem('uiVisibilitySettings', JSON.stringify(uiVisibilitySettings));
  }, [uiVisibilitySettings]);

  return { uiVisibilitySettings, setUiVisibilitySettings } as const;
}
