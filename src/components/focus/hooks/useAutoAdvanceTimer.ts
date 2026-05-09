import { useCallback, useEffect, useRef, useState } from 'react';

export function useAutoAdvanceTimer() {
  const autoAdvanceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [autoAdvanceCountdown, setAutoAdvanceCountdown] = useState<number | null>(null);

  const clearAutoAdvanceTimer = useCallback(() => {
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current);
      autoAdvanceTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setAutoAdvanceCountdown(null);
  }, []);

  const startAutoAdvance = useCallback((onAdvance: () => void) => {
    if (autoAdvanceTimerRef.current) return;

    setAutoAdvanceCountdown(3);

    countdownIntervalRef.current = setInterval(() => {
      setAutoAdvanceCountdown((prev) => {
        if (prev === null || prev <= 1) return prev;
        return prev - 1;
      });
    }, 1000);

    autoAdvanceTimerRef.current = setTimeout(() => {
      onAdvance();
    }, 3000);
  }, []);

  useEffect(() => clearAutoAdvanceTimer, [clearAutoAdvanceTimer]);

  return {
    autoAdvanceCountdown,
    clearAutoAdvanceTimer,
    startAutoAdvance,
  };
}
