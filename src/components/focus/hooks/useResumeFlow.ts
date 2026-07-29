import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { FocusModeSessionState, FocusPhase } from '../../../types/focus';
import type { ShoppingItem } from '../../../types/item';
import {
  buildResumeChoiceDialogState,
  type ResumeChoiceDialogState,
} from '../resumeChoice';

type VisitGroup = {
  key: string;
  items: ShoppingItem[];
};

const isSameIdSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

const buildIdSetSignature = (ids: Set<string>) => Array.from(ids).sort().join('\u001e');

interface UseResumeFlowArgs {
  resumeState: FocusModeSessionState | null;
  currentPhase: FocusPhase;
  visitsByPhase: Record<FocusPhase, VisitGroup[]>;
  currentPostponedItemIds: Set<string>;
  currentLateItemIds: Set<string>;
  clearAutoAdvanceTimer: () => void;
  setPostponedPhaseItemIds: Dispatch<SetStateAction<Set<string>>>;
  setLatePhaseItemIds: Dispatch<SetStateAction<Set<string>>>;
}

export function useResumeFlow({
  resumeState,
  currentPhase,
  visitsByPhase,
  currentPostponedItemIds,
  currentLateItemIds,
  clearAutoAdvanceTimer,
  setPostponedPhaseItemIds,
  setLatePhaseItemIds,
}: UseResumeFlowArgs) {
  const [resumeChoiceDialog, setResumeChoiceDialog] =
    useState<ResumeChoiceDialogState | null>(null);
  const didSyncOnResumeRef = useRef(false);
  const hadResumeStateRef = useRef(Boolean(resumeState));
  const didInitResumeChoiceRef = useRef(false);
  const initialResumeStateRef = useRef<FocusModeSessionState | null>(resumeState ?? null);
  const [pendingResumeSyncSignature, setPendingResumeSyncSignature] = useState<string | null>(null);
  const [isResumeSyncComplete, setIsResumeSyncComplete] = useState(() => !resumeState);
  const [isResumeCompletionChecked, setIsResumeCompletionChecked] = useState(() => !resumeState);
  const [isResumeInitResolved, setIsResumeInitResolved] = useState(() => !resumeState);
  const isResumeTransitioning = Boolean(resumeState) && !hadResumeStateRef.current;

  const resumeSyncCandidateSignature = useMemo(
    () =>
      `${buildIdSetSignature(currentPostponedItemIds)}\u001f${buildIdSetSignature(currentLateItemIds)}`,
    [currentPostponedItemIds, currentLateItemIds],
  );

  useEffect(() => {
    if (!initialResumeStateRef.current && resumeState) {
      initialResumeStateRef.current = resumeState;
    }
  }, [resumeState]);

  useEffect(() => {
    if (resumeChoiceDialog?.isOpen) {
      clearAutoAdvanceTimer();
    }
  }, [resumeChoiceDialog?.isOpen, clearAutoAdvanceTimer]);

  useEffect(() => {
    const hasResumeState = Boolean(resumeState);

    if (hasResumeState && !hadResumeStateRef.current) {
      initialResumeStateRef.current = resumeState;
      didSyncOnResumeRef.current = false;
      didInitResumeChoiceRef.current = false;
      setIsResumeInitResolved(false);
      setPendingResumeSyncSignature(null);
      setIsResumeSyncComplete(false);
      setIsResumeCompletionChecked(false);
    }

    if (!hasResumeState && hadResumeStateRef.current) {
      initialResumeStateRef.current = null;
      setResumeChoiceDialog(null);
      clearAutoAdvanceTimer();
      didSyncOnResumeRef.current = false;
      setPendingResumeSyncSignature(null);
      setIsResumeSyncComplete(true);
      setIsResumeCompletionChecked(true);
      didInitResumeChoiceRef.current = false;
      setIsResumeInitResolved(true);
    }

    hadResumeStateRef.current = hasResumeState;
  }, [resumeState, clearAutoAdvanceTimer]);

  useEffect(() => {
    if (!resumeState) return;
    if (didSyncOnResumeRef.current) return;

    if (pendingResumeSyncSignature !== resumeSyncCandidateSignature) {
      setPendingResumeSyncSignature(resumeSyncCandidateSignature);
      return;
    }

    const postponedNow = new Set(currentPostponedItemIds);
    const lateNow = new Set(currentLateItemIds);

    setPostponedPhaseItemIds((prev) => (isSameIdSet(prev, postponedNow) ? prev : postponedNow));
    setLatePhaseItemIds((prev) => (isSameIdSet(prev, lateNow) ? prev : lateNow));

    didSyncOnResumeRef.current = true;
    setIsResumeSyncComplete(true);
  }, [
    resumeState,
    pendingResumeSyncSignature,
    resumeSyncCandidateSignature,
    currentPostponedItemIds,
    currentLateItemIds,
    setPostponedPhaseItemIds,
    setLatePhaseItemIds,
  ]);

  useEffect(() => {
    if (!resumeState) {
      setIsResumeCompletionChecked(true);
      return;
    }
    if (!isResumeSyncComplete) return;
    setIsResumeCompletionChecked(true);
  }, [resumeState, isResumeSyncComplete]);

  useEffect(() => {
    if (didInitResumeChoiceRef.current) return;
    if (!resumeState) {
      setIsResumeInitResolved(true);
      return;
    }
    if (!didSyncOnResumeRef.current) return;
    if (!isResumeSyncComplete) return;
    if (!isResumeCompletionChecked) return;

    const dialogState = buildResumeChoiceDialogState({
      initialResumeState: initialResumeStateRef.current,
      visitsByPhase,
      currentPhase,
    });

    if (dialogState) {
      setResumeChoiceDialog(dialogState);
    }
    didInitResumeChoiceRef.current = true;
    setIsResumeInitResolved(true);
  }, [
    resumeState,
    isResumeSyncComplete,
    isResumeCompletionChecked,
    visitsByPhase,
    currentPhase,
  ]);

  return {
    resumeChoiceDialog,
    setResumeChoiceDialog,
    isResumeTransitioning,
    isResumeInitResolved,
  };
}
