import { useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

export function useThemeMode() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('themeMode') as ThemeMode) || 'system';
    }
    return 'system';
  });

  useEffect(() => {
    const applyTheme = () => {
      const html = document.documentElement;
      html.setAttribute('data-theme', themeMode);
      html.classList.remove('dark');

      if (themeMode === 'dark') {
        html.classList.add('dark');
      } else if (
        themeMode === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches
      ) {
        html.classList.add('dark');
      }
    };

    applyTheme();
    localStorage.setItem('themeMode', themeMode);

    if (themeMode === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => applyTheme();
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [themeMode]);

  return { themeMode, setThemeMode } as const;
}
