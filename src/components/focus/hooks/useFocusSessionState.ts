import { useState } from "react";
import type { FocusModeSessionState, FocusPhase } from "../../../types/focus";

export type PhaseChangeDialogState = {
  isOpen: boolean;
  targetPhase: FocusPhase | null;
  hasSavedIndex: boolean;
  savedIndex: number;
};

export function useFocusSessionState(
  resumeState: FocusModeSessionState | null,
) {
  const [currentPhase, setCurrentPhase] = useState<FocusPhase>(
    () => resumeState?.phase || "normal",
  );
  const [currentPhaseIndex, setCurrentPhaseIndex] = useState(() =>
    Math.max(0, resumeState?.phaseIndex || 0),
  );
  const [lastInteractedItemId, setLastInteractedItemId] = useState<
    string | null
  >(null);
  const [isNextButtonBlinking, setIsNextButtonBlinking] = useState(false);
  const [blinkingPriceItemIds, setBlinkingPriceItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [notification, setNotification] = useState<string | null>(null);
  const [isCompleted, setIsCompleted] = useState(false);
  const [postponedPhaseItemIds, setPostponedPhaseItemIds] = useState<
    Set<string>
  >(() => new Set(resumeState?.postponedItemIds || []));
  const [latePhaseItemIds, setLatePhaseItemIds] = useState<Set<string>>(
    () => new Set(resumeState?.lateItemIds || []),
  );
  const [phaseChangeDialog, setPhaseChangeDialog] =
    useState<PhaseChangeDialogState>({
      isOpen: false,
      targetPhase: null,
      hasSavedIndex: false,
      savedIndex: 0,
    });
  const [lastPurchaseChangeAt, setLastPurchaseChangeAt] = useState<{
    phase: FocusPhase;
    phaseIndex: number;
    visitKey: string;
  } | null>(() => resumeState?.lastPurchaseChangeAt ?? null);
  const [savedPhaseIndices, setSavedPhaseIndices] = useState<
    Record<FocusPhase, number>
  >(() => ({
    normal: resumeState?.savedPhaseIndices?.normal || 0,
    postponed: resumeState?.savedPhaseIndices?.postponed || 0,
    late: resumeState?.savedPhaseIndices?.late || 0,
  }));

  return {
    currentPhase,
    setCurrentPhase,
    currentPhaseIndex,
    setCurrentPhaseIndex,
    lastInteractedItemId,
    setLastInteractedItemId,
    isNextButtonBlinking,
    setIsNextButtonBlinking,
    blinkingPriceItemIds,
    setBlinkingPriceItemIds,
    notification,
    setNotification,
    isCompleted,
    setIsCompleted,
    postponedPhaseItemIds,
    setPostponedPhaseItemIds,
    latePhaseItemIds,
    setLatePhaseItemIds,
    phaseChangeDialog,
    setPhaseChangeDialog,
    lastPurchaseChangeAt,
    setLastPurchaseChangeAt,
    savedPhaseIndices,
    setSavedPhaseIndices,
  };
}
