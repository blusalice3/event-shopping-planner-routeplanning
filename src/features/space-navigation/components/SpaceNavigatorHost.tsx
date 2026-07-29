import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { acquireBodyScrollLock } from "../../../utils/bodyScrollLock";
import type { NavigationIntent } from "../types";
import {
  useOptionalSpaceNavigator,
  type SpaceNavigatorActionResult,
} from "../SpaceNavigatorContext";
import { SpaceNavigatorActionDialog } from "./SpaceNavigatorActionDialog";
import { SpaceNavigatorPicker } from "./SpaceNavigatorPicker";
import { SpaceNavigatorRail } from "./SpaceNavigatorRail";
import { TemporaryNavigationBanner } from "./TemporaryNavigationBanner";

type SelectableIntent = Extract<
  NavigationIntent,
  "set-current" | "temporary" | "inspect"
>;

export function SpaceNavigatorHost() {
  const navigator = useOptionalSpaceNavigator();
  const registration = navigator?.registration;
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [actionTargetVisitId, setActionTargetVisitId] = useState<string | null>(
    null,
  );
  const [actionResult, setActionResult] =
    useState<SpaceNavigatorActionResult | null>(null);
  const [pendingIntent, setPendingIntent] = useState<SelectableIntent | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const openedFromRailRef = useRef(false);
  const settingsEnabled = Boolean(
    navigator?.settings.railVisible ||
      navigator?.settings.footerButtonVisible,
  );
  const hostVisible = Boolean(
    navigator &&
      registration &&
      registration.entries.length > 0 &&
      settingsEnabled,
  );
  const navigationOverlayOpen = Boolean(
    hostVisible && (navigator?.pickerOpen || actionTargetVisitId !== null),
  );
  const actionTargetIndex =
    actionTargetVisitId === null
      ? -1
      : (registration?.entries.findIndex(
          (entry) => entry.id === actionTargetVisitId,
        ) ?? -1);
  const actionTarget =
    actionTargetIndex >= 0
      ? registration?.entries[actionTargetIndex] ?? null
      : null;

  useEffect(() => {
    if (!navigator?.pickerOpen || !registration) return;
    if (!openedFromRailRef.current) {
      setCandidateIndex(
        Math.min(
          Math.max(registration.currentIndex, 0),
          Math.max(0, registration.entries.length - 1),
        ),
      );
    }
    openedFromRailRef.current = false;
    setActionTargetVisitId(null);
    setActionResult(null);
    setPendingIntent(null);
  }, [navigator?.pickerOpen, registration?.id]);

  useEffect(() => {
    if (actionTargetVisitId === null || actionTarget) return;
    setActionTargetVisitId(null);
    setActionResult(null);
    setPendingIntent(null);
    setBusy(false);
  }, [actionTarget, actionTargetVisitId]);

  useEffect(() => {
    if (!registration) return;
    setCandidateIndex((current) =>
      Math.min(
        Math.max(current, 0),
        Math.max(0, registration.entries.length - 1),
      ),
    );
  }, [registration?.entries.length, registration]);

  useEffect(() => {
    if (!registration || navigator?.pickerOpen) return;
    setCandidateIndex(
      Math.min(
        Math.max(registration.currentIndex, 0),
        Math.max(0, registration.entries.length - 1),
      ),
    );
  }, [
    navigator?.pickerOpen,
    registration?.currentIndex,
    registration?.entries.length,
    registration?.id,
  ]);

  useEffect(() => {
    if (!navigationOverlayOpen) return;
    return acquireBodyScrollLock({ lockOverscroll: true });
  }, [navigationOverlayOpen]);

  if (!navigator || !registration || registration.entries.length === 0)
    return null;

  if (!settingsEnabled) return null;

  const handleChoose = async (intent: SelectableIntent, confirmed = false) => {
    if (actionTargetIndex < 0 || busy) return;
    setBusy(true);
    setPendingIntent(intent);
    const result = await navigator.navigate(
      actionTargetIndex,
      intent,
      confirmed,
    );
    setBusy(false);
    if (result.ok) {
      setActionTargetVisitId(null);
      setActionResult(null);
      setPendingIntent(null);
      return;
    }
    setActionResult(result);
  };

  return ReactDOM.createPortal(
    <>
      {navigator.settings.railVisible && (
        <SpaceNavigatorRail
          entries={registration.entries}
          currentIndex={registration.currentIndex}
          formalIndex={registration.formalIndex}
          candidateIndex={candidateIndex}
          side={navigator.settings.side}
          onCandidateChange={(index) => {
            openedFromRailRef.current = true;
            setCandidateIndex(index);
          }}
          onOpen={() => {
            openedFromRailRef.current = true;
            navigator.openPicker();
          }}
        />
      )}

      {navigator.pickerOpen && (
        <SpaceNavigatorPicker
          entries={registration.entries}
          candidateIndex={candidateIndex}
          side={navigator.settings.side}
          onCandidateChange={setCandidateIndex}
          onSelect={() => {
            setActionTargetVisitId(
              registration.entries[candidateIndex]?.id ?? null,
            );
            setActionResult(null);
            setPendingIntent(null);
          }}
          onClose={navigator.closePicker}
        />
      )}

      {actionTarget && (
        <SpaceNavigatorActionDialog
          entry={actionTarget}
          result={actionResult}
          pendingIntent={pendingIntent}
          busy={busy}
          onChoose={(intent, confirmed) =>
            void handleChoose(intent, confirmed)
          }
          onCancel={() => {
            setActionTargetVisitId(null);
            setActionResult(null);
            setPendingIntent(null);
          }}
        />
      )}

      <TemporaryNavigationBanner />

      {navigator.notification && (
        <button
          type="button"
          onClick={navigator.clearNotification}
          className="fixed left-1/2 z-[95] max-w-[calc(100%-1rem)] -translate-x-1/2 rounded-lg bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-xl dark:bg-slate-100 dark:text-slate-950"
          style={{ bottom: "calc(var(--footer-height, 0px) + .75rem)" }}
          role="status"
        >
          {navigator.notification}
        </button>
      )}
    </>,
    document.body,
  );
}
