import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  NavigationIntent,
  NavigatorEntry,
  NavigatorReturnPoint,
} from './types';
import {
  useSpaceNavigatorSettings,
  type SpaceNavigatorSettings,
} from './hooks/useSpaceNavigatorSettings';

export type SpaceNavigatorMode = 'execute' | 'focus';
export type TemporaryNavigationMode = 'temporary' | 'inspect';

export interface SpaceNavigatorLocationSnapshot {
  scrollTop?: number;
  anchorOffset?: number;
  payload?: unknown;
}

export interface SpaceNavigatorActionRequest {
  entry: NavigatorEntry;
  index: number;
  intent: Extract<NavigationIntent, 'set-current' | 'temporary' | 'inspect'>;
  confirmed: boolean;
}

export interface SpaceNavigatorActionResult {
  ok: boolean;
  message?: string;
  requiresConfirmation?: boolean;
}

export interface SpaceNavigatorRegistration {
  id: string;
  mode: SpaceNavigatorMode;
  entries: readonly NavigatorEntry[];
  currentIndex: number;
  formalIndex: number;
  layoutMode: 'pc' | 'smartphone';
  getSnapshot?: () => SpaceNavigatorLocationSnapshot;
  onNavigate: (
    request: SpaceNavigatorActionRequest,
  ) => SpaceNavigatorActionResult | Promise<SpaceNavigatorActionResult>;
  onRestore?: (
    point: NavigatorReturnPoint<InternalSnapshot>,
  ) => void | Promise<void>;
  onPromote?: (
    entry: NavigatorEntry,
    index: number,
  ) => SpaceNavigatorActionResult | Promise<SpaceNavigatorActionResult>;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
}

interface InternalSnapshot {
  location?: SpaceNavigatorLocationSnapshot;
  previousMode: TemporaryNavigationMode | null;
  label: string;
}

type InternalReturnPoint = NavigatorReturnPoint<InternalSnapshot>;

interface SpaceNavigatorContextValue {
  settings: SpaceNavigatorSettings;
  updateSettings: (patch: Partial<SpaceNavigatorSettings>) => void;
  resetSettings: () => void;
  registration: SpaceNavigatorRegistration | null;
  register: (registration: SpaceNavigatorRegistration) => () => void;
  updateRegistration: (registration: SpaceNavigatorRegistration) => void;
  pickerOpen: boolean;
  openPicker: () => void;
  closePicker: () => void;
  temporaryMode: TemporaryNavigationMode | null;
  isInspecting: boolean;
  history: readonly InternalReturnPoint[];
  navigate: (
    targetIndex: number,
    intent: Extract<NavigationIntent, 'set-current' | 'temporary' | 'inspect'>,
    confirmed?: boolean,
  ) => Promise<SpaceNavigatorActionResult>;
  returnToPrevious: () => Promise<void>;
  promoteTemporary: () => Promise<SpaceNavigatorActionResult>;
  notification: string | null;
  notify: (message: string) => void;
  clearNotification: () => void;
  interactionActive: boolean;
}

const SpaceNavigatorContext = createContext<SpaceNavigatorContextValue | null>(null);

export function SpaceNavigatorProvider({ children }: { children: React.ReactNode }) {
  const { settings, updateSettings, resetSettings } = useSpaceNavigatorSettings();
  const [registration, setRegistration] = useState<SpaceNavigatorRegistration | null>(null);
  const registrationRef = useRef<SpaceNavigatorRegistration | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [temporaryMode, setTemporaryMode] = useState<TemporaryNavigationMode | null>(null);
  const [history, setHistory] = useState<InternalReturnPoint[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const notificationTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (notificationTimerRef.current !== null) {
        window.clearTimeout(notificationTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (settings.railVisible || settings.footerButtonVisible) return;
    if (!pickerOpen && temporaryMode === null && history.length === 0) return;
    const active = registrationRef.current;
    const formalReturnPoint = history[0];
    if (active && formalReturnPoint) {
      void active.onRestore?.(formalReturnPoint);
      active.onInteractionEnd?.();
    }
    setPickerOpen(false);
    setTemporaryMode(null);
    setHistory([]);
  }, [
    history,
    pickerOpen,
    settings.footerButtonVisible,
    settings.railVisible,
    temporaryMode,
  ]);

  const notify = useCallback((message: string) => {
    setNotification(message);
    if (notificationTimerRef.current !== null) {
      window.clearTimeout(notificationTimerRef.current);
    }
    notificationTimerRef.current = window.setTimeout(() => {
      setNotification(null);
      notificationTimerRef.current = null;
    }, 4000);
  }, []);

  const clearNotification = useCallback(() => {
    setNotification(null);
    if (notificationTimerRef.current !== null) {
      window.clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
  }, []);

  const register = useCallback((nextRegistration: SpaceNavigatorRegistration) => {
    registrationRef.current = nextRegistration;
    setRegistration(nextRegistration);

    return () => {
      if (registrationRef.current?.id !== nextRegistration.id) return;
      registrationRef.current = null;
      setRegistration(null);
      setPickerOpen(false);
      setTemporaryMode(null);
      setHistory([]);
    };
  }, []);

  const updateRegistration = useCallback((nextRegistration: SpaceNavigatorRegistration) => {
    if (registrationRef.current?.id !== nextRegistration.id) return;
    registrationRef.current = nextRegistration;
    setRegistration(nextRegistration);
  }, []);

  const openPicker = useCallback(() => {
    const active = registrationRef.current;
    if (!active || active.entries.length === 0) return;
    active.onInteractionStart?.();
    setPickerOpen(true);
  }, []);

  const closePicker = useCallback(() => {
    registrationRef.current?.onInteractionEnd?.();
    setPickerOpen(false);
  }, []);

  const navigate = useCallback(
    async (
      targetIndex: number,
      intent: Extract<NavigationIntent, 'set-current' | 'temporary' | 'inspect'>,
      confirmed = false,
    ): Promise<SpaceNavigatorActionResult> => {
      const active = registrationRef.current;
      const entry = active?.entries[targetIndex];
      if (!active || !entry) {
        return { ok: false, message: '選択した訪問先は現在の一覧にありません' };
      }

      const priorMode = temporaryMode;
      const sourceEntry = active.entries[active.currentIndex];
      const sourceLabel = sourceEntry
        ? `${sourceEntry.label}${sourceEntry.circles[0] ? `・${sourceEntry.circles[0]}` : ''}`
        : '元のスペース';
      const returnPoint: InternalReturnPoint = {
        visitId: sourceEntry?.id ?? entry.id,
        navigatorIndex: active.currentIndex,
        mode: intent === 'inspect' ? 'inspect' : 'temporary',
        phase: active.entries[active.currentIndex]?.phase,
        phaseIndex: active.entries[active.currentIndex]?.phaseIndex,
        scrollTop: window.scrollY,
        snapshot: {
          location: active.getSnapshot?.(),
          previousMode: priorMode,
          label: sourceLabel,
        },
      };

      if (intent === 'temporary' || intent === 'inspect') {
        setTemporaryMode(intent);
      } else {
        setTemporaryMode(null);
      }

      const result = await active.onNavigate({ entry, index: targetIndex, intent, confirmed });
      if (!result.ok) {
        setTemporaryMode(priorMode);
        if (result.message && !result.requiresConfirmation) notify(result.message);
        return result;
      }

      if (intent === 'temporary' || intent === 'inspect') {
        setHistory((current) => [...current, returnPoint]);
      } else {
        setHistory([]);
      }

      if (result.message) notify(result.message);
      setPickerOpen(false);
      active.onInteractionEnd?.();
      return result;
    },
    [notify, temporaryMode],
  );

  const returnToPrevious = useCallback(async () => {
    const active = registrationRef.current;
    const point = history[history.length - 1];
    if (!active || !point) return;

    active.onInteractionStart?.();
    await active.onRestore?.(point);
    setHistory((current) => current.slice(0, -1));
    setTemporaryMode(point.snapshot?.previousMode ?? null);
    active.onInteractionEnd?.();
  }, [history]);

  const promoteTemporary = useCallback(async (): Promise<SpaceNavigatorActionResult> => {
    const active = registrationRef.current;
    const entry = active?.entries[active.currentIndex];
    if (!active || !entry) {
      return { ok: false, message: '現在の訪問先を確定できませんでした' };
    }

    const priorMode = temporaryMode;
    setTemporaryMode(null);
    const result = active.onPromote
      ? await active.onPromote(entry, active.currentIndex)
      : await active.onNavigate({
          entry,
          index: active.currentIndex,
          intent: 'set-current',
          confirmed: true,
        });

    if (!result.ok) {
      setTemporaryMode(priorMode);
      if (result.message) notify(result.message);
      return result;
    }

    setHistory([]);
    if (result.message) notify(result.message);
    return result;
  }, [notify, temporaryMode]);

  const value = useMemo<SpaceNavigatorContextValue>(
    () => ({
      settings,
      updateSettings,
      resetSettings,
      registration,
      register,
      updateRegistration,
      pickerOpen,
      openPicker,
      closePicker,
      temporaryMode,
      isInspecting: temporaryMode === 'inspect',
      history,
      navigate,
      returnToPrevious,
      promoteTemporary,
      notification,
      notify,
      clearNotification,
      interactionActive: pickerOpen || temporaryMode !== null,
    }),
    [
      settings,
      updateSettings,
      resetSettings,
      registration,
      register,
      updateRegistration,
      pickerOpen,
      openPicker,
      closePicker,
      temporaryMode,
      history,
      navigate,
      returnToPrevious,
      promoteTemporary,
      notification,
      notify,
      clearNotification,
    ],
  );

  return <SpaceNavigatorContext.Provider value={value}>{children}</SpaceNavigatorContext.Provider>;
}

export function useSpaceNavigator() {
  const context = useContext(SpaceNavigatorContext);
  if (!context) {
    throw new Error('useSpaceNavigator must be used within SpaceNavigatorProvider');
  }
  return context;
}

export function useOptionalSpaceNavigator() {
  return useContext(SpaceNavigatorContext);
}
