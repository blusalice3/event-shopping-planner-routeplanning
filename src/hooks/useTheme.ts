import { useState, useEffect } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

export function useTheme() {
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
      } else if (themeMode === 'system') {
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
          html.classList.add('dark');
        }
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

  const cycleTheme = () => {
    setThemeMode(prev => {
      if (prev === 'system') return 'light';
      if (prev === 'light') return 'dark';
      return 'system';
    });
  };

  return { themeMode, setThemeMode, cycleTheme };
}
