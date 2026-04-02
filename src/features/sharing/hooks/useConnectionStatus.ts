import { useState, useEffect } from 'react';

interface UseConnectionStatusReturn {
  isOnline: boolean;
}

/**
 * ネットワーク接続状態を監視するフック。
 * オフライン遷移は即座に検出、オンライン遷移は2秒デバウンスでフラップ抑制。
 */
export function useConnectionStatus(): UseConnectionStatusReturn {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleOnline = () => {
      // オンライン復帰は2秒デバウンス（フラップ抑制）
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => setIsOnline(true), 2000);
    };

    const handleOffline = () => {
      // オフライン遷移は即座に検出
      if (debounceTimer) clearTimeout(debounceTimer);
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // 初期状態を同期
    setIsOnline(navigator.onLine);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (debounceTimer) clearTimeout(debounceTimer);
    };
  }, []);

  return { isOnline };
}
