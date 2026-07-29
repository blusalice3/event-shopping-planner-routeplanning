import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type { ShoppingItem } from '../../../types/item';
import {
  useOptionalSpaceNavigator,
  type SpaceNavigatorLocationSnapshot,
  type SpaceNavigatorRegistration,
  type TemporaryNavigationMode,
} from '../SpaceNavigatorContext';
import { buildExecutionNavigatorEntries } from '../domain/buildNavigatorEntries';
import { evaluateNavigationGuard } from '../domain/navigationGuard';
import type { NavigatorEntry } from '../types';

const VISIT_ID_ATTRIBUTE = 'data-space-navigation-visit-id';
const ANCHOR_ATTRIBUTE = 'data-space-navigation-anchor';
const PROGRAMMATIC_SCROLL_IDLE_MS = 120;
const PROGRAMMATIC_SCROLL_TIMEOUT_MS = 2_000;

type RestorePoint = Parameters<
  NonNullable<SpaceNavigatorRegistration['onRestore']>
>[0];

interface ExecutionSnapshotPayload {
  visitId?: string;
  formalVisitId?: string;
}

interface ProgrammaticNavigationOperation {
  generation: number;
  token: number;
  targetVisitId: string;
}

export interface ExecutionNavigationGuardFeedback {
  priceItemIds: readonly string[];
  limitedItemIds: readonly string[];
  message: string | null;
}

export interface UseExecutionSpaceNavigatorOptions {
  enabled: boolean;
  registrationId: string;
  items: readonly ShoppingItem[];
  layoutMode: 'pc' | 'smartphone';
  showSpaceGroups: boolean;
  collapsedSpaces?: ReadonlySet<string>;
  onToggleSpaceCollapse?: (groupKey: string) => void;
  deferredLimitedItemIdsByGroupKey: ReadonlyMap<string, ReadonlySet<string>>;
  disablePriceUndefinedCheck: boolean;
  disableLimitedPurchaseQuantityCheck: boolean;
  containerRef: RefObject<HTMLElement | null>;
  onGuardFeedback?: (feedback: ExecutionNavigationGuardFeedback) => void;
}

export interface ExecutionSpaceNavigatorState {
  entries: readonly NavigatorEntry[];
  currentIndex: number;
  formalIndex: number;
  isInspecting: boolean;
}

function getLegacyGroupKey(entry: NavigatorEntry): string {
  return entry.priorityLevel === 'none'
    ? entry.spaceKey
    : `${entry.spaceKey}:${entry.priorityLevel}`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => resolve());
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

async function scrollElementIntoViewAndWait(
  element: HTMLElement,
  behavior: ScrollBehavior,
): Promise<void> {
  if (behavior !== 'smooth') {
    element.scrollIntoView({ block: 'center', behavior });
    await nextFrame();
    await nextFrame();
    return;
  }

  await new Promise<void>((resolve) => {
    let settledTimerId: number | null = null;
    let timeoutId: number | null = null;
    let firstFrameId: number | null = null;
    let secondFrameId: number | null = null;
    let sawScroll = false;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('scroll', handleScroll);
      if (settledTimerId !== null) window.clearTimeout(settledTimerId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (
        firstFrameId !== null &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(firstFrameId);
      }
      if (
        secondFrameId !== null &&
        typeof window.cancelAnimationFrame === 'function'
      ) {
        window.cancelAnimationFrame(secondFrameId);
      }
      resolve();
    };

    const scheduleSettled = () => {
      if (settledTimerId !== null) window.clearTimeout(settledTimerId);
      settledTimerId = window.setTimeout(
        finish,
        PROGRAMMATIC_SCROLL_IDLE_MS,
      );
    };

    function handleScroll() {
      sawScroll = true;
      scheduleSettled();
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    timeoutId = window.setTimeout(finish, PROGRAMMATIC_SCROLL_TIMEOUT_MS);
    element.scrollIntoView({ block: 'center', behavior });

    if (typeof window.requestAnimationFrame === 'function') {
      firstFrameId = window.requestAnimationFrame(() => {
        firstFrameId = null;
        secondFrameId = window.requestAnimationFrame(() => {
          secondFrameId = null;
          if (!sawScroll) finish();
        });
      });
    } else {
      settledTimerId = window.setTimeout(finish, 0);
    }
  });

  // Flush the final scroll/ResizeObserver callbacks while the caller's
  // programmatic-navigation lock is still held.
  await nextFrame();
  await nextFrame();
}

function getWindowScrollTop(): number {
  return window.scrollY ?? document.documentElement.scrollTop ?? 0;
}

function scrollWindowTo(top: number): void {
  if (typeof window.scrollTo !== 'function') return;
  try {
    window.scrollTo({ top, behavior: 'auto' });
  } catch {
    window.scrollTo(0, top);
  }
}

function scrollWindowBy(top: number): void {
  if (typeof window.scrollBy !== 'function') return;
  try {
    window.scrollBy({ top, behavior: 'auto' });
  } catch {
    window.scrollBy(0, top);
  }
}

export function useExecutionSpaceNavigator(
  options: UseExecutionSpaceNavigatorOptions,
): ExecutionSpaceNavigatorState {
  const {
    enabled,
    registrationId,
    items,
    layoutMode,
    showSpaceGroups,
    collapsedSpaces,
    onToggleSpaceCollapse,
    deferredLimitedItemIdsByGroupKey,
    disablePriceUndefinedCheck,
    disableLimitedPurchaseQuantityCheck,
    containerRef,
    onGuardFeedback,
  } = options;
  const navigator = useOptionalSpaceNavigator();
  const notify = navigator?.notify;
  const entries = useMemo(() => buildExecutionNavigatorEntries(items), [items]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [formalIndex, setFormalIndex] = useState(0);
  const currentIndexRef = useRef(0);
  const formalIndexRef = useRef(0);
  const currentVisitIdRef = useRef<string | null>(entries[0]?.id ?? null);
  const formalVisitIdRef = useRef<string | null>(entries[0]?.id ?? null);
  const temporaryModeRef = useRef<TemporaryNavigationMode | null>(null);
  const registrationRef = useRef<SpaceNavigatorRegistration | null>(null);
  const expansionInFlightRef = useRef(new Set<string>());
  const emptyRecoveryInFlightRef = useRef(false);
  const emptyRecoveryNotifiedRef = useRef(false);
  const programmaticNavigationInFlightRef = useRef(false);
  const programmaticTargetVisitIdRef = useRef<string | null>(null);
  const programmaticTargetScrollTopRef = useRef<number | null>(null);
  const programmaticOperationTokenRef = useRef(0);
  const registrationGenerationRef = useRef(0);
  const entriesRef = useRef(entries);
  const entriesLengthRef = useRef(entries.length);
  entriesRef.current = entries;
  entriesLengthRef.current = entries.length;

  const cancelProgrammaticNavigation = useCallback(() => {
    programmaticOperationTokenRef.current += 1;
    programmaticNavigationInFlightRef.current = false;
    programmaticTargetVisitIdRef.current = null;
    programmaticTargetScrollTopRef.current = null;
  }, []);

  const beginProgrammaticNavigation = useCallback(
    (targetVisitId: string): ProgrammaticNavigationOperation => {
      const operation = {
        generation: registrationGenerationRef.current,
        token: programmaticOperationTokenRef.current + 1,
        targetVisitId,
      };
      programmaticOperationTokenRef.current = operation.token;
      programmaticNavigationInFlightRef.current = true;
      programmaticTargetVisitIdRef.current = targetVisitId;
      programmaticTargetScrollTopRef.current = null;
      return operation;
    },
    [],
  );

  const isCurrentProgrammaticNavigation = useCallback(
    (operation: ProgrammaticNavigationOperation): boolean =>
      operation.generation === registrationGenerationRef.current &&
      operation.token === programmaticOperationTokenRef.current,
    [],
  );

  const completeProgrammaticNavigation = useCallback(
    (
      operation: ProgrammaticNavigationOperation,
      keepTargetLock: boolean,
    ): boolean => {
      if (!isCurrentProgrammaticNavigation(operation)) return false;

      programmaticNavigationInFlightRef.current = false;
      const targetStillExists = entriesRef.current.some(
        (entry) => entry.id === operation.targetVisitId,
      );
      if (keepTargetLock && targetStillExists) {
        programmaticTargetVisitIdRef.current = operation.targetVisitId;
        programmaticTargetScrollTopRef.current = getWindowScrollTop();
      } else {
        programmaticTargetVisitIdRef.current = null;
        programmaticTargetScrollTopRef.current = null;
      }
      return true;
    },
    [isCurrentProgrammaticNavigation],
  );

  const setDisplayedVisit = useCallback(
    (visitId: string, updateFormal: boolean): boolean => {
      const latestEntries = entriesRef.current;
      const nextIndex = latestEntries.findIndex((entry) => entry.id === visitId);
      if (nextIndex < 0) return false;
      const nextEntry = latestEntries[nextIndex];
      currentIndexRef.current = nextIndex;
      currentVisitIdRef.current = nextEntry.id;
      setCurrentIndex((previous) => (previous === nextIndex ? previous : nextIndex));

      if (updateFormal) {
        formalIndexRef.current = nextIndex;
        formalVisitIdRef.current = nextEntry.id;
        setFormalIndex((previous) => (previous === nextIndex ? previous : nextIndex));
      }
      return true;
    },
    [],
  );

  const setDisplayedEntry = useCallback(
    (index: number, updateFormal: boolean): boolean => {
      const latestEntries = entriesRef.current;
      if (latestEntries.length === 0) {
        currentIndexRef.current = 0;
        setCurrentIndex(0);
        if (updateFormal) {
          formalIndexRef.current = 0;
          setFormalIndex(0);
        }
        return false;
      }

      const nextIndex = Math.max(0, Math.min(index, latestEntries.length - 1));
      return setDisplayedVisit(latestEntries[nextIndex].id, updateFormal);
    },
    [setDisplayedVisit],
  );

  const findAnchors = useCallback(
    (visitId: string): HTMLElement[] => {
      const container = containerRef.current;
      if (!container) return [];
      return Array.from(
        container.querySelectorAll<HTMLElement>(`[${VISIT_ID_ATTRIBUTE}]`),
      ).filter((element) => element.dataset.spaceNavigationVisitId === visitId);
    },
    [containerRef],
  );

  const findPreferredAnchor = useCallback(
    (visitId: string): HTMLElement | null => {
      const anchors = findAnchors(visitId);
      if (anchors.length === 0) return null;
      const preferredKind = showSpaceGroups ? 'heading' : 'item';
      return (
        anchors.find(
          (element) => element.dataset.spaceNavigationAnchor === preferredKind,
        ) ??
        anchors[0] ??
        null
      );
    },
    [findAnchors, showSpaceGroups],
  );

  const ensureEntryExpanded = useCallback(
    async (entry: NavigatorEntry) => {
      if (!showSpaceGroups || !onToggleSpaceCollapse) return;
      const groupKey = getLegacyGroupKey(entry);
      if (!collapsedSpaces?.has(groupKey)) return;
      if (expansionInFlightRef.current.has(groupKey)) return;

      expansionInFlightRef.current.add(groupKey);
      onToggleSpaceCollapse(groupKey);
      await nextFrame();
      await nextFrame();
      expansionInFlightRef.current.delete(groupKey);
    },
    [collapsedSpaces, onToggleSpaceCollapse, showSpaceGroups],
  );

  const revealEntry = useCallback(
    async (entry: NavigatorEntry, behavior: ScrollBehavior = 'smooth') => {
      await ensureEntryExpanded(entry);
      await nextFrame();
      const anchor = findPreferredAnchor(entry.id);
      if (!anchor) return;

      if (typeof anchor.scrollIntoView === 'function') {
        await scrollElementIntoViewAndWait(anchor, behavior);
        return;
      }

      const rect = anchor.getBoundingClientRect();
      scrollWindowTo(getWindowScrollTop() + rect.top + rect.height / 2 - window.innerHeight / 2);
      await nextFrame();
      await nextFrame();
    },
    [ensureEntryExpanded, findPreferredAnchor],
  );

  const getSnapshot = useCallback((): SpaceNavigatorLocationSnapshot => {
    const entry = entries[currentIndexRef.current];
    const anchor = entry ? findPreferredAnchor(entry.id) : null;
    const rect = anchor?.getBoundingClientRect();
    const payload: ExecutionSnapshotPayload = {
      visitId: currentVisitIdRef.current ?? undefined,
      formalVisitId: formalVisitIdRef.current ?? undefined,
    };

    return {
      scrollTop: getWindowScrollTop(),
      ...(rect
        ? { anchorOffset: rect.top + rect.height / 2 - window.innerHeight / 2 }
        : {}),
      payload,
    };
  }, [entries, findPreferredAnchor]);

  const onNavigate = useCallback(
    async (
      request: Parameters<SpaceNavigatorRegistration['onNavigate']>[0],
    ) => {
      const latestEntries = entriesRef.current;
      const targetIndex = latestEntries.findIndex(
        (entry) => entry.id === request.entry.id,
      );
      if (targetIndex < 0) {
        return {
          ok: false,
          message: '選択した訪問先は絞り込み対象外になりました',
        };
      }
      const targetEntry = latestEntries[targetIndex];
      const currentIndexById = currentVisitIdRef.current
        ? latestEntries.findIndex(
            (entry) => entry.id === currentVisitIdRef.current,
          )
        : -1;
      const effectiveCurrentIndex =
        currentIndexById >= 0
          ? currentIndexById
          : Math.max(
              0,
              Math.min(currentIndexRef.current, latestEntries.length - 1),
            );
      const currentEntry = latestEntries[effectiveCurrentIndex];
      const deferredIds = currentEntry
        ? deferredLimitedItemIdsByGroupKey.get(getLegacyGroupKey(currentEntry))
        : undefined;
      const guard = evaluateNavigationGuard({
        intent: request.intent,
        currentIndex: effectiveCurrentIndex,
        targetIndex,
        currentItems: currentEntry?.items ?? [],
        settings: {
          disablePriceUndefinedCheck,
          disableLimitedPurchaseQuantityCheck,
          deferredLimitedItemIds: deferredIds,
        },
      });
      const blockedByPrice = guard.blockingReasons.includes('price');
      const blockedByLimited = guard.blockingReasons.includes('limited');

      let guardMessage: string | null = null;
      if (blockedByPrice && blockedByLimited) {
        guardMessage = '価格と限数の実購入数を入力してください';
      } else if (blockedByPrice) {
        guardMessage = '価格未定のアイテムがあります。価格を入力してください。';
      } else if (blockedByLimited) {
        guardMessage = '限数未入力があります。実購入数を入力してください';
      }

      onGuardFeedback?.({
        priceItemIds: blockedByPrice ? guard.priceWarningItemIds : [],
        limitedItemIds: blockedByLimited
          ? guard.limitedWarningItemIds.filter((id) => !deferredIds?.has(id))
          : [],
        message: guardMessage,
      });

      if (!guard.allowed) {
        return { ok: false, message: guardMessage ?? undefined };
      }
      if (
        guard.advisoryReasons.includes('unvisited') &&
        !request.confirmed
      ) {
        return {
          ok: false,
          requiresConfirmation: true,
          message: '現在のスペースに未購入のアイテムがあります。移動しますか？',
        };
      }

      temporaryModeRef.current =
        request.intent === 'set-current' ? null : request.intent;
      const operation = beginProgrammaticNavigation(targetEntry.id);
      let keepTargetLock = false;
      try {
        if (
          !setDisplayedVisit(
            targetEntry.id,
            request.intent === 'set-current',
          )
        ) {
          return {
            ok: false,
            message: '選択した訪問先は絞り込み対象外になりました',
          };
        }
        await revealEntry(targetEntry);
        if (!isCurrentProgrammaticNavigation(operation)) {
          return {
            ok: false,
            message: '表示条件が切り替わったため、移動を取り消しました',
          };
        }
        if (
          !setDisplayedVisit(
            operation.targetVisitId,
            request.intent === 'set-current',
          )
        ) {
          return {
            ok: false,
            message: '移動先が絞り込み対象外になりました',
          };
        }
        keepTargetLock = true;
        return { ok: true };
      } finally {
        completeProgrammaticNavigation(operation, keepTargetLock);
      }
    },
    [
      beginProgrammaticNavigation,
      completeProgrammaticNavigation,
      deferredLimitedItemIdsByGroupKey,
      disableLimitedPurchaseQuantityCheck,
      disablePriceUndefinedCheck,
      isCurrentProgrammaticNavigation,
      onGuardFeedback,
      revealEntry,
      setDisplayedVisit,
    ],
  );

  const onRestore = useCallback(
    async (point: RestorePoint) => {
      const latestEntries = entriesRef.current;
      if (latestEntries.length === 0) return;
      const exactIndex = latestEntries.findIndex(
        (entry) => entry.id === point.visitId,
      );
      const targetIndex =
        exactIndex >= 0
          ? exactIndex
          : Math.max(
              0,
              Math.min(point.navigatorIndex, latestEntries.length - 1),
            );
      const targetEntry = latestEntries[targetIndex];
      const snapshot = point.snapshot as
        | {
            location?: SpaceNavigatorLocationSnapshot;
            previousMode?: TemporaryNavigationMode | null;
          }
        | undefined;
      const priorMode = snapshot?.previousMode ?? null;

      const operation = beginProgrammaticNavigation(targetEntry.id);
      let keepTargetLock = false;
      try {
        temporaryModeRef.current = priorMode;
        setDisplayedVisit(targetEntry.id, priorMode === null);
        await ensureEntryExpanded(targetEntry);
        await nextFrame();

        const anchor = findPreferredAnchor(targetEntry.id);
        const savedOffset = snapshot?.location?.anchorOffset;
        if (anchor && typeof savedOffset === 'number') {
          const rect = anchor.getBoundingClientRect();
          const currentOffset = rect.top + rect.height / 2 - window.innerHeight / 2;
          scrollWindowBy(currentOffset - savedOffset);
        } else {
          scrollWindowTo(snapshot?.location?.scrollTop ?? point.scrollTop ?? 0);
        }
        await nextFrame();
        await nextFrame();
        if (
          isCurrentProgrammaticNavigation(operation) &&
          setDisplayedVisit(operation.targetVisitId, priorMode === null)
        ) {
          keepTargetLock = true;
        }
      } finally {
        completeProgrammaticNavigation(operation, keepTargetLock);
      }

      if (exactIndex < 0) {
        notify?.(
          '元の訪問先が絞り込み対象外になったため、最も近い訪問先へ戻りました',
        );
      }
    },
    [
      beginProgrammaticNavigation,
      completeProgrammaticNavigation,
      ensureEntryExpanded,
      findPreferredAnchor,
      isCurrentProgrammaticNavigation,
      notify,
      setDisplayedVisit,
    ],
  );

  const onPromote = useCallback(
    async (entry: NavigatorEntry, _index: number) => {
      temporaryModeRef.current = null;
      return setDisplayedVisit(entry.id, true)
        ? { ok: true }
        : {
            ok: false,
            message: '現在の訪問先は絞り込み対象外になりました',
          };
    },
    [setDisplayedVisit],
  );

  useEffect(() => {
    temporaryModeRef.current = navigator?.temporaryMode ?? null;
  }, [navigator?.temporaryMode]);

  useLayoutEffect(() => {
    registrationGenerationRef.current += 1;
    cancelProgrammaticNavigation();
    expansionInFlightRef.current.clear();
    emptyRecoveryInFlightRef.current = false;
    emptyRecoveryNotifiedRef.current = false;
    temporaryModeRef.current = null;

    const firstEntry = entriesRef.current[0];
    currentIndexRef.current = 0;
    formalIndexRef.current = 0;
    currentVisitIdRef.current = firstEntry?.id ?? null;
    formalVisitIdRef.current = firstEntry?.id ?? null;
    setCurrentIndex(0);
    setFormalIndex(0);

    return () => {
      registrationGenerationRef.current += 1;
      cancelProgrammaticNavigation();
      expansionInFlightRef.current.clear();
    };
  }, [cancelProgrammaticNavigation, registrationId]);

  useLayoutEffect(() => {
    if (enabled) return;
    registrationGenerationRef.current += 1;
    cancelProgrammaticNavigation();
  }, [cancelProgrammaticNavigation, enabled]);

  useEffect(() => {
    if (entries.length === 0) {
      cancelProgrammaticNavigation();
      currentIndexRef.current = 0;
      formalIndexRef.current = 0;
      setCurrentIndex(0);
      setFormalIndex(0);
      return;
    }

    const previousCurrentId = currentVisitIdRef.current;
    const previousFormalId = formalVisitIdRef.current;
    const currentMatch = previousCurrentId
      ? entries.findIndex((entry) => entry.id === previousCurrentId)
      : -1;
    const formalMatch = previousFormalId
      ? entries.findIndex((entry) => entry.id === previousFormalId)
      : -1;
    const currentWasRemoved = previousCurrentId !== null && currentMatch < 0;
    const formalWasRemoved = previousFormalId !== null && formalMatch < 0;
    const programmaticTargetWasRemoved =
      programmaticTargetVisitIdRef.current &&
      !entries.some(
        (entry) => entry.id === programmaticTargetVisitIdRef.current,
      );
    if (programmaticTargetWasRemoved) {
      cancelProgrammaticNavigation();
    }
    const nextCurrentIndex =
      currentMatch >= 0
        ? currentMatch
        : Math.max(0, Math.min(currentIndexRef.current, entries.length - 1));
    const nextFormalIndex =
      formalMatch >= 0
        ? formalMatch
        : Math.max(0, Math.min(formalIndexRef.current, entries.length - 1));

    currentIndexRef.current = nextCurrentIndex;
    currentVisitIdRef.current = entries[nextCurrentIndex].id;
    setCurrentIndex(nextCurrentIndex);
    formalIndexRef.current = nextFormalIndex;
    formalVisitIdRef.current = entries[nextFormalIndex].id;
    setFormalIndex(nextFormalIndex);

    if (currentWasRemoved || formalWasRemoved) {
      notify?.(
        '絞り込みにより表示中の訪問先が対象外になったため、最も近い訪問先へ移動しました',
      );
    }
    if (currentWasRemoved) {
      const targetEntry = entries[nextCurrentIndex];
      const operation = beginProgrammaticNavigation(targetEntry.id);
      void (async () => {
        let keepTargetLock = false;
        try {
          await revealEntry(targetEntry);
          if (
            isCurrentProgrammaticNavigation(operation) &&
            setDisplayedVisit(
              operation.targetVisitId,
              temporaryModeRef.current === null,
            )
          ) {
            keepTargetLock = true;
          }
        } finally {
          completeProgrammaticNavigation(operation, keepTargetLock);
        }
      })();
    }
  }, [
    beginProgrammaticNavigation,
    cancelProgrammaticNavigation,
    completeProgrammaticNavigation,
    entries,
    isCurrentProgrammaticNavigation,
    notify,
    revealEntry,
    setDisplayedVisit,
  ]);

  const historyDepth = navigator?.history.length ?? 0;
  const returnToPrevious = navigator?.returnToPrevious;
  useEffect(() => {
    if (entries.length > 0) {
      emptyRecoveryNotifiedRef.current = false;
      return;
    }
    if (
      !enabled ||
      temporaryModeRef.current === null ||
      historyDepth === 0 ||
      !returnToPrevious ||
      emptyRecoveryInFlightRef.current
    ) {
      return;
    }

    // With no rendered target, onRestore cannot scroll to an anchor. Preserve
    // the formal visit identity and make it the display identity before the
    // context pops this temporary return point. If filters later reveal items,
    // both indices resolve from the same formal visit instead of the stale
    // temporary destination.
    currentVisitIdRef.current = formalVisitIdRef.current;
    currentIndexRef.current = 0;
    setCurrentIndex(0);

    if (!emptyRecoveryNotifiedRef.current) {
      emptyRecoveryNotifiedRef.current = true;
      notify?.(
        '絞り込み結果が0件になったため、一時移動を終了して元の位置に戻りました',
      );
    }

    emptyRecoveryInFlightRef.current = true;
    // updateRegistration is a later effect in this hook. Defer the context
    // action to a microtask so it restores through the new empty registration,
    // rather than the previous render's still-populated adapter.
    void Promise.resolve()
      .then(async () => {
        if (entriesLengthRef.current !== 0) return;
        await returnToPrevious();
      })
      .finally(() => {
        emptyRecoveryInFlightRef.current = false;
      });
  }, [enabled, entries.length, historyDepth, notify, returnToPrevious]);

  useEffect(() => {
    if (!enabled || entries.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    let frameId: number | null = null;

    const updateFromViewportCenter = () => {
      frameId = null;
      if (programmaticNavigationInFlightRef.current) return;
      if (programmaticTargetVisitIdRef.current !== null) {
        const currentScrollTop = getWindowScrollTop();
        const lockedScrollTop = programmaticTargetScrollTopRef.current;
        if (lockedScrollTop === null) {
          programmaticTargetScrollTopRef.current = currentScrollTop;
          return;
        }
        if (Math.abs(currentScrollTop - lockedScrollTop) < 1) return;

        // Release only after the document actually moved. Input intent alone
        // (for example a wheel gesture at the scroll boundary) must not unlock
        // the selected visit, while focus-driven/keyboard scrolling is covered
        // by the same coordinate change.
        programmaticTargetVisitIdRef.current = null;
        programmaticTargetScrollTopRef.current = null;
      }
      const preferredKind = showSpaceGroups ? 'heading' : 'item';
      const anchors = Array.from(
        container.querySelectorAll<HTMLElement>(
          `[${VISIT_ID_ATTRIBUTE}][${ANCHOR_ATTRIBUTE}="${preferredKind}"]`,
        ),
      );
      if (anchors.length === 0) return;
      const viewportCenter = window.innerHeight / 2;
      let nearest: { index: number; distance: number } | null = null;

      for (const anchor of anchors) {
        const visitId = anchor.dataset.spaceNavigationVisitId;
        const index = entries.findIndex((entry) => entry.id === visitId);
        if (index < 0) continue;
        const rect = anchor.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
        if (!nearest || distance < nearest.distance) {
          nearest = { index, distance };
        }
      }

      if (!nearest) return;
      setDisplayedEntry(
        nearest.index,
        temporaryModeRef.current === null,
      );
    };

    const scheduleUpdate = () => {
      if (frameId !== null) return;
      if (typeof window.requestAnimationFrame === 'function') {
        frameId = window.requestAnimationFrame(updateFromViewportCenter);
      } else {
        updateFromViewportCenter();
      }
    };

    scheduleUpdate();
    window.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(scheduleUpdate)
        : null;
    observer?.observe(container);

    return () => {
      window.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      observer?.disconnect();
      if (frameId !== null && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [containerRef, enabled, entries, setDisplayedEntry, showSpaceGroups]);

  const registration = useMemo<SpaceNavigatorRegistration>(
    () => ({
      id: registrationId,
      mode: 'execute',
      entries,
      currentIndex,
      formalIndex,
      layoutMode,
      getSnapshot,
      onNavigate,
      onRestore,
      onPromote,
    }),
    [
      currentIndex,
      entries,
      formalIndex,
      getSnapshot,
      layoutMode,
      onNavigate,
      onPromote,
      onRestore,
      registrationId,
    ],
  );
  registrationRef.current = registration;

  const register = navigator?.register;
  const updateRegistration = navigator?.updateRegistration;
  useEffect(() => {
    if (!enabled || !register || !registrationRef.current) return;
    return register(registrationRef.current);
  }, [enabled, register, registrationId]);

  useEffect(() => {
    if (!enabled || !updateRegistration) return;
    updateRegistration(registration);
  }, [enabled, registration, updateRegistration]);

  return {
    entries,
    currentIndex,
    formalIndex,
    isInspecting: Boolean(enabled && navigator?.isInspecting),
  };
}
