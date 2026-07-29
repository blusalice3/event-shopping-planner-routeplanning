import { useEffect, useMemo, useRef } from "react";
import type { FocusPhase } from "../../../types/focus";
import type { ShoppingItem } from "../../../types/item";

type VisitGroup = {
  key: string;
  items: ShoppingItem[];
};

interface UseAutoSkipEmptyVisitArgs {
  paused?: boolean;
  isCompleted: boolean;
  allVisitsLength: number;
  currentVisitDisplayItemsLength: number;
  currentPhaseVisits: VisitGroup[];
  currentPhaseIndex: number;
  currentPhase: FocusPhase;
  postponedPhaseItemIds: Set<string>;
  latePhaseItemIds: Set<string>;
  executeItems: ShoppingItem[];
  isResumeChoiceOpen: boolean;
  clearAutoAdvanceTimer: () => void;
  setPostponedPhaseItemIds: (ids: Set<string>) => void;
  setLatePhaseItemIds: (ids: Set<string>) => void;
  setNotification: (message: string) => void;
  setCurrentPhase: (phase: FocusPhase) => void;
  setCurrentPhaseIndex: (index: number) => void;
  setIsCompleted: (isCompleted: boolean) => void;
}

export function useAutoSkipEmptyVisit({
  paused = false,
  isCompleted,
  allVisitsLength,
  currentVisitDisplayItemsLength,
  currentPhaseVisits,
  currentPhaseIndex,
  currentPhase,
  postponedPhaseItemIds,
  latePhaseItemIds,
  executeItems,
  isResumeChoiceOpen,
  clearAutoAdvanceTimer,
  setPostponedPhaseItemIds,
  setLatePhaseItemIds,
  setNotification,
  setCurrentPhase,
  setCurrentPhaseIndex,
  setIsCompleted,
}: UseAutoSkipEmptyVisitArgs) {
  const autoAdvanceProcessedRef = useRef(false);

  useEffect(() => {
    if (paused) {
      autoAdvanceProcessedRef.current = false;
      return;
    }

    if (isResumeChoiceOpen) {
      autoAdvanceProcessedRef.current = false;
      return;
    }

    if (isCompleted || allVisitsLength === 0) {
      autoAdvanceProcessedRef.current = false;
      return;
    }

    if (currentVisitDisplayItemsLength > 0) {
      autoAdvanceProcessedRef.current = false;
      return;
    }

    if (autoAdvanceProcessedRef.current) return;

    if (currentPhaseVisits.length === 0) {
      autoAdvanceProcessedRef.current = false;
      return;
    }

    autoAdvanceProcessedRef.current = true;

    for (let i = currentPhaseIndex + 1; i < currentPhaseVisits.length; i++) {
      const visit = currentPhaseVisits[i];
      let hasItems = false;
      if (currentPhase === "normal") {
        hasItems = visit.items.length > 0;
      } else if (currentPhase === "postponed") {
        hasItems = visit.items.some((item) =>
          postponedPhaseItemIds.has(item.id),
        );
      } else {
        hasItems = visit.items.some((item) => latePhaseItemIds.has(item.id));
      }
      if (hasItems) {
        setCurrentPhaseIndex(i);
        return;
      }
    }

    clearAutoAdvanceTimer();

    if (currentPhase === "normal") {
      const postponedIds = new Set(
        executeItems
          .filter((item) => item.purchaseStatus === "Postpone")
          .map((item) => item.id),
      );
      const lateIds = new Set(
        executeItems
          .filter((item) => item.purchaseStatus === "Late")
          .map((item) => item.id),
      );

      if (postponedIds.size > 0) {
        setPostponedPhaseItemIds(postponedIds);
        setLatePhaseItemIds(lateIds);
        setNotification("後回しアイテムの巡回を開始します");
        setCurrentPhase("postponed");
        setCurrentPhaseIndex(0);
      } else if (lateIds.size > 0) {
        setPostponedPhaseItemIds(postponedIds);
        setLatePhaseItemIds(lateIds);
        setNotification("遅参アイテムの巡回を開始します");
        setCurrentPhase("late");
        setCurrentPhaseIndex(0);
      } else {
        setIsCompleted(true);
      }
    } else if (currentPhase === "postponed") {
      const currentLateIds = new Set(latePhaseItemIds);
      executeItems.forEach((item) => {
        if (item.purchaseStatus === "Late") {
          currentLateIds.add(item.id);
        }
      });

      if (currentLateIds.size > 0) {
        setLatePhaseItemIds(currentLateIds);
        setNotification("遅参アイテムの巡回を開始します");
        setCurrentPhase("late");
        setCurrentPhaseIndex(0);
      } else {
        setIsCompleted(true);
      }
    } else {
      setIsCompleted(true);
    }
  }, [
    paused,
    isCompleted,
    allVisitsLength,
    currentVisitDisplayItemsLength,
    currentPhaseVisits,
    currentPhaseIndex,
    currentPhase,
    postponedPhaseItemIds,
    latePhaseItemIds,
    executeItems,
    clearAutoAdvanceTimer,
    isResumeChoiceOpen,
    setPostponedPhaseItemIds,
    setLatePhaseItemIds,
    setNotification,
    setCurrentPhase,
    setCurrentPhaseIndex,
    setIsCompleted,
  ]);

  return useMemo(
    () =>
      !paused &&
      !isResumeChoiceOpen &&
      !isCompleted &&
      allVisitsLength > 0 &&
      currentVisitDisplayItemsLength === 0 &&
      currentPhaseVisits.length > 0,
    [
      paused,
      isResumeChoiceOpen,
      isCompleted,
      allVisitsLength,
      currentVisitDisplayItemsLength,
      currentPhaseVisits.length,
    ],
  );
}
