import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  NavigationIntent,
  NavigatorEntry,
  NavigatorReturnPoint,
} from "./types";
import {
  useSpaceNavigatorSettings,
  type SpaceNavigatorSettings,
  type SpaceNavigatorSettingsPersistencePort,
} from "./hooks/useSpaceNavigatorSettings";

export type SpaceNavigatorMode = "execute" | "focus";
export type TemporaryNavigationMode = "temporary" | "inspect";
export type SpaceNavigatorActionSource = "navigator" | "map-cell";
export type SpaceNavigatorNotificationTone = "info" | "warning";

export interface SpaceNavigatorLocationSnapshot {
  scrollTop?: number;
  anchorOffset?: number;
  payload?: unknown;
}

export interface SpaceNavigatorActionRequest {
  entry: NavigatorEntry;
  index: number;
  intent: Extract<NavigationIntent, "set-current" | "temporary" | "inspect">;
  confirmed: boolean;
  source: SpaceNavigatorActionSource;
  payload?: unknown;
}

export interface SpaceNavigatorActionResult {
  ok: boolean;
  message?: string;
  tone?: SpaceNavigatorNotificationTone;
  requiresConfirmation?: boolean;
  requiresPhaseSelection?: boolean;
}

export interface SpaceNavigatorNavigateOptions {
  confirmed?: boolean;
  source?: SpaceNavigatorActionSource;
  payload?: unknown;
  expectedRegistrationId?: string;
}

export interface SpaceNavigatorRegistration {
  id: string;
  mode: SpaceNavigatorMode;
  entries: readonly NavigatorEntry[];
  currentIndex: number;
  formalIndex: number;
  layoutMode: "pc" | "smartphone";
  getSnapshot?: () => SpaceNavigatorLocationSnapshot;
  onNavigate: (
    request: SpaceNavigatorActionRequest,
  ) => SpaceNavigatorActionResult | Promise<SpaceNavigatorActionResult>;
  onRestore?: (
    point: NavigatorReturnPoint<InternalSnapshot>,
  ) =>
    | SpaceNavigatorActionResult
    | void
    | Promise<SpaceNavigatorActionResult | void>;
  onPromote?: (
    entry: NavigatorEntry,
    index: number,
    payload?: unknown,
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
    intent: Extract<NavigationIntent, "set-current" | "temporary" | "inspect">,
    confirmed?: boolean,
  ) => Promise<SpaceNavigatorActionResult>;
  navigateByVisitId: (
    visitId: string,
    intent: Extract<NavigationIntent, "set-current" | "temporary" | "inspect">,
    options?: SpaceNavigatorNavigateOptions,
  ) => Promise<SpaceNavigatorActionResult>;
  returnToPrevious: () => Promise<void>;
  switchInspectToTemporary: () => void;
  promoteTemporary: (payload?: unknown) => Promise<SpaceNavigatorActionResult>;
  actionBusy: boolean;
  notification: string | null;
  notificationTone: SpaceNavigatorNotificationTone;
  notify: (message: string, tone?: SpaceNavigatorNotificationTone) => void;
  clearNotification: () => void;
  interactionActive: boolean;
}

const SpaceNavigatorContext = createContext<SpaceNavigatorContextValue | null>(
  null,
);

const volatileSpaceNavigatorSettingsPersistence: SpaceNavigatorSettingsPersistencePort =
  {
    loadPreference: () => null,
    savePreference: () => undefined,
  };

export function SpaceNavigatorProvider({
  children,
  settingsPersistence = volatileSpaceNavigatorSettingsPersistence,
}: {
  children: React.ReactNode;
  settingsPersistence?: SpaceNavigatorSettingsPersistencePort;
}) {
  const { settings, updateSettings, resetSettings } =
    useSpaceNavigatorSettings(settingsPersistence);
  const [registration, setRegistration] =
    useState<SpaceNavigatorRegistration | null>(null);
  const registrationRef = useRef<SpaceNavigatorRegistration | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [temporaryMode, setTemporaryMode] =
    useState<TemporaryNavigationMode | null>(null);
  const [history, setHistory] = useState<InternalReturnPoint[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const [notificationTone, setNotificationTone] =
    useState<SpaceNavigatorNotificationTone>("info");
  const [actionBusy, setActionBusy] = useState(false);
  const notificationTimerRef = useRef<number | null>(null);
  const temporaryModeRef = useRef<TemporaryNavigationMode | null>(null);
  const historyRef = useRef<InternalReturnPoint[]>([]);
  const actionBusyRef = useRef(false);
  const registrationGenerationRef = useRef(0);
  temporaryModeRef.current = temporaryMode;
  historyRef.current = history;

  useEffect(
    () => () => {
      if (notificationTimerRef.current !== null) {
        window.clearTimeout(notificationTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (settings.railVisible || settings.footerButtonVisible || !pickerOpen)
      return;
    registrationRef.current?.onInteractionEnd?.();
    setPickerOpen(false);
  }, [pickerOpen, settings.footerButtonVisible, settings.railVisible]);

  const notify = useCallback(
    (message: string, tone: SpaceNavigatorNotificationTone = "info") => {
      setNotificationTone(tone);
      setNotification(message);
      if (notificationTimerRef.current !== null) {
        window.clearTimeout(notificationTimerRef.current);
      }
      notificationTimerRef.current = window.setTimeout(() => {
        setNotification(null);
        setNotificationTone("info");
        notificationTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  const clearNotification = useCallback(() => {
    setNotification(null);
    setNotificationTone("info");
    if (notificationTimerRef.current !== null) {
      window.clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
  }, []);

  const register = useCallback(
    (nextRegistration: SpaceNavigatorRegistration) => {
      registrationGenerationRef.current += 1;
      if (
        registrationRef.current &&
        registrationRef.current.id !== nextRegistration.id
      ) {
        setPickerOpen(false);
        setTemporaryMode(null);
        setHistory([]);
        temporaryModeRef.current = null;
        historyRef.current = [];
      }
      registrationRef.current = nextRegistration;
      setRegistration(nextRegistration);
      actionBusyRef.current = false;
      setActionBusy(false);

      return () => {
        if (registrationRef.current?.id !== nextRegistration.id) return;
        registrationGenerationRef.current += 1;
        registrationRef.current = null;
        setRegistration(null);
        setPickerOpen(false);
        setTemporaryMode(null);
        setHistory([]);
        temporaryModeRef.current = null;
        historyRef.current = [];
        actionBusyRef.current = false;
        setActionBusy(false);
      };
    },
    [],
  );

  const updateRegistration = useCallback(
    (nextRegistration: SpaceNavigatorRegistration) => {
      if (registrationRef.current?.id !== nextRegistration.id) return;
      registrationRef.current = nextRegistration;
      setRegistration(nextRegistration);
    },
    [],
  );

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

  const navigateByVisitId = useCallback(
    async (
      visitId: string,
      intent: Extract<
        NavigationIntent,
        "set-current" | "temporary" | "inspect"
      >,
      options: SpaceNavigatorNavigateOptions = {},
    ): Promise<SpaceNavigatorActionResult> => {
      if (actionBusyRef.current) {
        return { ok: false, message: "移動処理中です" };
      }
      const generation = registrationGenerationRef.current;
      actionBusyRef.current = true;
      setActionBusy(true);

      try {
        const active = registrationRef.current;
        if (
          options.expectedRegistrationId &&
          active?.id !== options.expectedRegistrationId
        ) {
          return {
            ok: false,
            message: "表示内容が切り替わったため、移動先を選び直してください",
          };
        }
        const targetIndex =
          active?.entries.findIndex((candidate) => candidate.id === visitId) ??
          -1;
        const entry =
          targetIndex >= 0 ? active?.entries[targetIndex] : undefined;
        if (!active || !entry) {
          return {
            ok: false,
            message: "選択した訪問先は現在の一覧にありません",
          };
        }

        const priorMode = temporaryModeRef.current;
        const sourceEntry = active.entries[active.currentIndex];
        const sourceLabel = sourceEntry
          ? `${sourceEntry.label}${sourceEntry.circles[0] ? `・${sourceEntry.circles[0]}` : ""}`
          : "元のスペース";
        const returnPoint: InternalReturnPoint = {
          visitId: sourceEntry?.id ?? entry.id,
          navigatorIndex: active.currentIndex,
          mode: intent === "inspect" ? "inspect" : "temporary",
          phase: active.entries[active.currentIndex]?.phase,
          phaseIndex: active.entries[active.currentIndex]?.phaseIndex,
          scrollTop: window.scrollY,
          snapshot: {
            location: active.getSnapshot?.(),
            previousMode: priorMode,
            label: sourceLabel,
          },
        };

        if (intent === "temporary" || intent === "inspect") {
          temporaryModeRef.current = intent;
          setTemporaryMode(intent);
        } else {
          temporaryModeRef.current = null;
          setTemporaryMode(null);
        }

        const result = await active.onNavigate({
          entry,
          index: targetIndex,
          intent,
          confirmed: options.confirmed ?? false,
          source: options.source ?? "navigator",
          payload: options.payload,
        });
        if (
          generation !== registrationGenerationRef.current ||
          registrationRef.current?.id !== active.id
        ) {
          return {
            ok: false,
            message: "表示内容が切り替わったため、移動を取り消しました",
          };
        }
        if (!result.ok) {
          temporaryModeRef.current = priorMode;
          setTemporaryMode(priorMode);
          if (result.message && !result.requiresConfirmation) {
            notify(result.message, result.tone);
          }
          return result;
        }

        if (intent === "temporary" || intent === "inspect") {
          const nextHistory = [...historyRef.current, returnPoint];
          historyRef.current = nextHistory;
          setHistory(nextHistory);
        } else {
          historyRef.current = [];
          setHistory([]);
        }

        if (result.message) notify(result.message, result.tone);
        setPickerOpen(false);
        active.onInteractionEnd?.();
        return result;
      } finally {
        if (generation === registrationGenerationRef.current) {
          actionBusyRef.current = false;
          setActionBusy(false);
        }
      }
    },
    [notify],
  );

  const navigate = useCallback(
    (
      targetIndex: number,
      intent: Extract<
        NavigationIntent,
        "set-current" | "temporary" | "inspect"
      >,
      confirmed = false,
    ): Promise<SpaceNavigatorActionResult> => {
      const active = registrationRef.current;
      const visitId = active?.entries[targetIndex]?.id;
      if (!visitId) {
        return Promise.resolve({
          ok: false,
          message: "選択した訪問先は現在の一覧にありません",
        });
      }
      return navigateByVisitId(visitId, intent, { confirmed });
    },
    [navigateByVisitId],
  );

  const returnToPrevious = useCallback(async () => {
    if (actionBusyRef.current) return;
    const active = registrationRef.current;
    if (!active || historyRef.current.length === 0) return;

    const generation = registrationGenerationRef.current;
    actionBusyRef.current = true;
    setActionBusy(true);
    active.onInteractionStart?.();
    try {
      let remainingHistory = [...historyRef.current];
      while (remainingHistory.length > 0) {
        const point = remainingHistory[remainingHistory.length - 1];
        const result = await active.onRestore?.(point);
        if (
          generation !== registrationGenerationRef.current ||
          registrationRef.current?.id !== active.id
        ) {
          return;
        }
        if (result && !result.ok) {
          if (result.message) notify(result.message, result.tone);
          remainingHistory = remainingHistory.slice(0, -1);
          continue;
        }

        const nextHistory = remainingHistory.slice(0, -1);
        const nextMode = point.snapshot?.previousMode ?? null;
        historyRef.current = nextHistory;
        temporaryModeRef.current = nextMode;
        setHistory(nextHistory);
        setTemporaryMode(nextMode);
        if (result?.message) notify(result.message, result.tone);
        return;
      }

      historyRef.current = [];
      temporaryModeRef.current = null;
      setHistory([]);
      setTemporaryMode(null);
    } catch {
      notify("元の位置へ戻せませんでした。もう一度お試しください");
    } finally {
      active.onInteractionEnd?.();
      if (generation === registrationGenerationRef.current) {
        actionBusyRef.current = false;
        setActionBusy(false);
      }
    }
  }, [notify]);

  const switchInspectToTemporary = useCallback(() => {
    if (temporaryModeRef.current !== "inspect") return;
    temporaryModeRef.current = "temporary";
    setTemporaryMode("temporary");
  }, []);

  const promoteTemporary = useCallback(
    async (payload?: unknown): Promise<SpaceNavigatorActionResult> => {
      if (actionBusyRef.current) {
        return { ok: false, message: "移動処理中です" };
      }
      const active = registrationRef.current;
      const entry = active?.entries[active.currentIndex];
      if (!active || !entry) {
        return { ok: false, message: "現在の訪問先を確定できませんでした" };
      }

      const generation = registrationGenerationRef.current;
      actionBusyRef.current = true;
      setActionBusy(true);
      const priorMode = temporaryModeRef.current;
      temporaryModeRef.current = null;
      setTemporaryMode(null);
      try {
        const result = active.onPromote
          ? await active.onPromote(entry, active.currentIndex, payload)
          : await active.onNavigate({
              entry,
              index: active.currentIndex,
              intent: "set-current",
              confirmed: true,
              source: "navigator",
              payload,
            });

        if (
          generation !== registrationGenerationRef.current ||
          registrationRef.current?.id !== active.id
        ) {
          return {
            ok: false,
            message: "表示内容が切り替わったため、確定を取り消しました",
          };
        }
        if (!result.ok) {
          temporaryModeRef.current = priorMode;
          setTemporaryMode(priorMode);
          if (result.message) notify(result.message, result.tone);
          return result;
        }

        historyRef.current = [];
        setHistory([]);
        if (result.message) notify(result.message, result.tone);
        return result;
      } finally {
        if (generation === registrationGenerationRef.current) {
          actionBusyRef.current = false;
          setActionBusy(false);
        }
      }
    },
    [notify],
  );

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
      isInspecting: temporaryMode === "inspect",
      history,
      navigate,
      navigateByVisitId,
      returnToPrevious,
      switchInspectToTemporary,
      promoteTemporary,
      actionBusy,
      notification,
      notificationTone,
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
      navigateByVisitId,
      returnToPrevious,
      switchInspectToTemporary,
      promoteTemporary,
      actionBusy,
      notification,
      notificationTone,
      notify,
      clearNotification,
    ],
  );

  return (
    <SpaceNavigatorContext.Provider value={value}>
      {children}
    </SpaceNavigatorContext.Provider>
  );
}

export function useSpaceNavigator() {
  const context = useContext(SpaceNavigatorContext);
  if (!context) {
    throw new Error(
      "useSpaceNavigator must be used within SpaceNavigatorProvider",
    );
  }
  return context;
}

export function useOptionalSpaceNavigator() {
  return useContext(SpaceNavigatorContext);
}
