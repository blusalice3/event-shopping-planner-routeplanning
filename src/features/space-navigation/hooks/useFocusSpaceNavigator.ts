import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  FocusMapViewportSnapshot,
  FocusPhase,
} from "../../../types/focus";
import type { ShoppingItem } from "../../../types/item";
import {
  useOptionalSpaceNavigator,
  type SpaceNavigatorActionResult,
  type SpaceNavigatorRegistration,
} from "../SpaceNavigatorContext";
import { buildFocusNavigatorEntries } from "../domain/buildNavigatorEntries";
import { evaluateNavigationGuard } from "../domain/navigationGuard";
import {
  buildStatusSegments,
  countNavigatorStatuses,
  getNavigatorWarningKinds,
} from "../domain/statusSegments";
import {
  aggregateNavigatorSpace,
  buildInitialPhaseNavigationCandidates,
  buildRemainingSpaceLists,
  findAdjacentSpaceTarget,
  type InitialPhaseNavigationCandidates,
  type OpportunisticSpaceTarget,
  type OpportunisticStepDirection,
  type RemainingSpaceLists,
} from "../domain/opportunisticNavigation";
import { buildSpaceKey } from "../domain/visitIdentity";
import type {
  FocusNavigatorSources,
  NavigationGuardResult,
  NavigatorEntry,
} from "../types";

type SingleDisplaySnapshot = {
  kind: "single";
  entry: NavigatorEntry;
};

export type FocusTemporarySubview = "visit" | "remaining" | "ended";

export type AggregateDisplaySnapshot = {
  kind: "space-aggregate";
  entry: NavigatorEntry;
  representativeVisitId: string;
  movementBasisPhase: FocusPhase | null;
  phaseSelected: boolean;
  subview: FocusTemporarySubview;
};

type DisplaySnapshot = SingleDisplaySnapshot | AggregateDisplaySnapshot;

export interface FocusSpaceAggregateNavigationPayload {
  kind: "space-aggregate";
  spaceKey: string;
  representativeVisitId: string;
  displayLabel?: string;
}

export interface FocusSpaceAggregatePromotionPayload {
  kind: "space-aggregate-promotion";
  phase: FocusPhase;
}

type RestorePayload = {
  displaySnapshot: DisplaySnapshot | null;
  mapViewport?: FocusMapViewportSnapshot;
};

const isSpaceAggregateNavigationPayload = (
  value: unknown,
): value is FocusSpaceAggregateNavigationPayload => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FocusSpaceAggregateNavigationPayload>;
  return (
    candidate.kind === "space-aggregate" &&
    typeof candidate.spaceKey === "string" &&
    typeof candidate.representativeVisitId === "string"
  );
};

const isSpaceAggregatePromotionPayload = (
  value: unknown,
): value is FocusSpaceAggregatePromotionPayload => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FocusSpaceAggregatePromotionPayload>;
  return (
    candidate.kind === "space-aggregate-promotion" &&
    (candidate.phase === "normal" ||
      candidate.phase === "postponed" ||
      candidate.phase === "late")
  );
};

export interface UseFocusSpaceNavigatorArgs {
  registrationId: string;
  enabled: boolean;
  layoutMode: "pc" | "smartphone";
  sourcesByPhase: FocusNavigatorSources;
  officialPhase: FocusPhase;
  officialPhaseIndex: number;
  latestItemsById: ReadonlyMap<string, ShoppingItem>;
  disablePriceUndefinedCheck: boolean;
  disableLimitedPurchaseQuantityCheck: boolean;
  getDeferredLimitedItemIds: (
    entry: NavigatorEntry,
  ) => ReadonlySet<string> | undefined;
  onCommitOfficial: (entry: NavigatorEntry) => void;
  onGuardResult: (result: NavigationGuardResult) => void;
  onInteractionStart?: () => void;
  getMapViewportSnapshot?: () => FocusMapViewportSnapshot | undefined;
  restoreMapViewportSnapshot?: (snapshot: FocusMapViewportSnapshot) => void;
}

const phaseOrder: readonly FocusPhase[] = ["normal", "postponed", "late"];
const EMPTY_ITEM_IDS: readonly string[] = [];
const EMPTY_REMAINING_SPACE_LISTS: RemainingSpaceLists = {
  normal: [],
  postponed: [],
  late: [],
};

const getBlockingMessage = (result: NavigationGuardResult): string => {
  const hasPrice = result.blockingReasons.includes("price");
  const hasLimited = result.blockingReasons.includes("limited");
  if (hasPrice && hasLimited) return "価格と限数の実購入数を入力してください";
  if (hasPrice) return "価格未定のアイテムがあります。価格を入力してください。";
  return "限数未入力があります。実購入数を入力してください";
};

const refreshDisplaySnapshot = (
  snapshot: DisplaySnapshot,
  latestItemsById: ReadonlyMap<string, ShoppingItem>,
): DisplaySnapshot => {
  const latestItems = snapshot.entry.itemIds.map((itemId) => {
    const latest = latestItemsById.get(itemId);
    if (latest) return latest;
    if (snapshot.kind === "space-aggregate") return undefined;
    return snapshot.entry.items.find((item) => item.id === itemId) as
      | ShoppingItem
      | undefined;
  });
  const items = latestItems.filter(
    (item): item is ShoppingItem =>
      item !== undefined &&
      (snapshot.kind !== "space-aggregate" ||
        buildSpaceKey(item.block, item.number) === snapshot.entry.spaceKey),
  );
  const circles = Array.from(
    new Set(
      items
        .map((item) => item.circle.trim())
        .filter((circle) => circle.length > 0),
    ),
  );
  return {
    ...snapshot,
    entry: {
      ...snapshot.entry,
      itemIds: items.map((item) => item.id),
      items,
      circles,
      statusCounts: countNavigatorStatuses(items),
      statusSegments: buildStatusSegments(items),
      warningKinds: getNavigatorWarningKinds(items),
    },
  };
};

const insertRetainedEntry = (
  entries: readonly NavigatorEntry[],
  retainedEntry: NavigatorEntry | null,
): NavigatorEntry[] => {
  if (
    !retainedEntry ||
    entries.some((entry) => entry.id === retainedEntry.id)
  ) {
    return entries.map((entry) => ({ ...entry }));
  }

  const phase = retainedEntry.phase ?? "normal";
  const phaseEntries = entries.filter((entry) => entry.phase === phase);
  const phaseStart = entries.findIndex((entry) => entry.phase === phase);
  let insertionIndex: number;
  if (phaseStart >= 0) {
    insertionIndex =
      phaseStart + Math.min(retainedEntry.phaseIndex, phaseEntries.length);
  } else {
    const phasePosition = phaseOrder.indexOf(phase);
    const nextPhase = phaseOrder
      .slice(phasePosition + 1)
      .find((candidate) => entries.some((entry) => entry.phase === candidate));
    insertionIndex = nextPhase
      ? entries.findIndex((entry) => entry.phase === nextPhase)
      : entries.length;
  }

  const next = [...entries];
  next.splice(insertionIndex, 0, retainedEntry);
  const phaseCounts = new Map<FocusPhase, number>();
  return next.map((entry, index) => {
    const entryPhase = entry.phase ?? "normal";
    const phaseIndex = phaseCounts.get(entryPhase) ?? 0;
    phaseCounts.set(entryPhase, phaseIndex + 1);
    return { ...entry, index, phaseIndex };
  });
};

export function useFocusSpaceNavigator({
  registrationId,
  enabled,
  layoutMode,
  sourcesByPhase,
  officialPhase,
  officialPhaseIndex,
  latestItemsById,
  disablePriceUndefinedCheck,
  disableLimitedPurchaseQuantityCheck,
  getDeferredLimitedItemIds,
  onCommitOfficial,
  onGuardResult,
  onInteractionStart,
  getMapViewportSnapshot,
  restoreMapViewportSnapshot,
}: UseFocusSpaceNavigatorArgs) {
  const navigator = useOptionalSpaceNavigator();
  const [displaySnapshot, setDisplaySnapshot] =
    useState<DisplaySnapshot | null>(null);
  const [recenterRevision, setRecenterRevision] = useState(0);
  const [pendingMoveDirection, setPendingMoveDirection] =
    useState<OpportunisticStepDirection | null>(null);
  const [promotionPhaseChoiceOpen, setPromotionPhaseChoiceOpen] =
    useState(false);
  const previousRegistrationIdRef = useRef(registrationId);

  useEffect(() => {
    const registrationChanged =
      previousRegistrationIdRef.current !== registrationId;
    previousRegistrationIdRef.current = registrationId;
    if (enabled && !registrationChanged) return;
    setDisplaySnapshot(null);
    setPendingMoveDirection(null);
    setPromotionPhaseChoiceOpen(false);
  }, [enabled, registrationId]);

  const baseEntries = useMemo(
    () => buildFocusNavigatorEntries(sourcesByPhase),
    [sourcesByPhase],
  );
  const refreshedDisplaySnapshot = useMemo(
    () =>
      displaySnapshot
        ? refreshDisplaySnapshot(displaySnapshot, latestItemsById)
        : null,
    [displaySnapshot, latestItemsById],
  );
  const refreshedRetainedEntry = useMemo(
    () => refreshedDisplaySnapshot?.entry ?? null,
    [refreshedDisplaySnapshot],
  );
  const entries = useMemo(
    () => insertRetainedEntry(baseEntries, refreshedRetainedEntry),
    [baseEntries, refreshedRetainedEntry],
  );

  const formalPhaseEntries = baseEntries.filter(
    (entry) => entry.phase === officialPhase,
  );
  const formalBaseEntry =
    formalPhaseEntries.length > 0
      ? formalPhaseEntries[
          Math.min(
            Math.max(0, officialPhaseIndex),
            formalPhaseEntries.length - 1,
          )
        ]
      : null;
  const formalEntry = formalBaseEntry
    ? (entries.find((entry) => entry.id === formalBaseEntry.id) ?? null)
    : null;
  const formalRouteIndex = formalBaseEntry
    ? Math.max(
        0,
        baseEntries.findIndex((entry) => entry.id === formalBaseEntry.id),
      )
    : 0;
  const formalIndex = formalEntry
    ? entries.findIndex((entry) => entry.id === formalEntry.id)
    : 0;
  const displayEntry =
    (refreshedDisplaySnapshot
      ? entries.find((entry) => entry.id === refreshedDisplaySnapshot.entry.id)
      : formalEntry) ?? null;
  const currentIndex = displayEntry
    ? Math.max(
        0,
        entries.findIndex((entry) => entry.id === displayEntry.id),
      )
    : formalIndex;

  const makeDisplaySnapshot = useCallback(
    (entry: NavigatorEntry): SingleDisplaySnapshot => ({
      kind: "single",
      entry: {
        ...entry,
        items: entry.items.map(
          (item) => latestItemsById.get(item.id) ?? (item as ShoppingItem),
        ),
      },
    }),
    [latestItemsById],
  );

  const makeAggregateDisplaySnapshot = useCallback(
    ({
      spaceKey,
      representativeVisitId,
      displayLabel,
      movementBasisPhase,
      phaseSelected,
      subview = "visit",
    }: {
      spaceKey: string;
      representativeVisitId?: string;
      displayLabel?: string;
      movementBasisPhase: FocusPhase | null;
      phaseSelected: boolean;
      subview?: FocusTemporarySubview;
    }): AggregateDisplaySnapshot | null => {
      const aggregate = aggregateNavigatorSpace(baseEntries, spaceKey, {
        latestItemsById,
      });
      if (!aggregate) return null;
      const representativeEntry =
        baseEntries.find(
          (entry) =>
            entry.id === representativeVisitId &&
            entry.spaceKey === aggregate.spaceKey,
        ) ?? aggregate.representativeEntry;
      const entryPhase =
        movementBasisPhase ?? representativeEntry.phase ?? "normal";
      const phaseEntries = baseEntries.filter(
        (entry) => entry.phase === entryPhase,
      );
      const phaseIndex = Math.max(
        0,
        phaseEntries.findIndex((entry) => entry.id === representativeEntry.id),
      );
      const items = aggregate.items as readonly ShoppingItem[];
      return {
        kind: "space-aggregate",
        representativeVisitId: representativeEntry.id,
        movementBasisPhase,
        phaseSelected,
        subview,
        entry: {
          ...representativeEntry,
          id: `space-aggregate:${aggregate.spaceKey}`,
          phase: entryPhase,
          phaseIndex,
          label: displayLabel || aggregate.label,
          itemIds: [...aggregate.itemIds],
          items,
          circles: [...aggregate.circles],
          statusCounts: countNavigatorStatuses(items),
          statusSegments: buildStatusSegments(items),
          warningKinds: getNavigatorWarningKinds(items),
        },
      };
    },
    [baseEntries, latestItemsById],
  );

  const runGuard = useCallback(
    (
      targetIndex: number,
      intent: "set-current" | "temporary" | "inspect",
    ): NavigationGuardResult => {
      const currentEntry = entries[currentIndex];
      const result = evaluateNavigationGuard({
        intent,
        currentIndex,
        targetIndex,
        currentItems: currentEntry?.items ?? [],
        settings: {
          disablePriceUndefinedCheck,
          disableLimitedPurchaseQuantityCheck,
          deferredLimitedItemIds: currentEntry
            ? getDeferredLimitedItemIds(currentEntry)
            : undefined,
        },
      });
      onGuardResult(result);
      return result;
    },
    [
      currentIndex,
      disableLimitedPurchaseQuantityCheck,
      disablePriceUndefinedCheck,
      entries,
      getDeferredLimitedItemIds,
      onGuardResult,
    ],
  );

  const runAggregateForwardGuard = useCallback(
    (entry: NavigatorEntry): NavigationGuardResult => {
      const result = evaluateNavigationGuard({
        intent: "temporary",
        currentIndex: 0,
        targetIndex: 1,
        currentItems: entry.items,
        settings: {
          disablePriceUndefinedCheck,
          disableLimitedPurchaseQuantityCheck,
          deferredLimitedItemIds: getDeferredLimitedItemIds(entry),
        },
      });
      onGuardResult(result);
      return result;
    },
    [
      disableLimitedPurchaseQuantityCheck,
      disablePriceUndefinedCheck,
      getDeferredLimitedItemIds,
      onGuardResult,
    ],
  );

  const resolvePromotedEntry = useCallback(
    (
      entry: NavigatorEntry,
    ): { entry: NavigatorEntry | null; didFallback: boolean } => {
      const liveEntry = baseEntries.find(
        (candidate) => candidate.id === entry.id,
      );
      if (liveEntry) return { entry: liveEntry, didFallback: false };
      if (entry.phase === "normal") return { entry: null, didFallback: false };
      const normalFallback = baseEntries.find(
        (candidate) =>
          candidate.phase === "normal" &&
          candidate.spaceKey === entry.spaceKey &&
          candidate.priorityLevel === entry.priorityLevel,
      );
      return {
        entry: normalFallback ?? null,
        didFallback: Boolean(normalFallback),
      };
    },
    [baseEntries],
  );

  const handleNavigate = useCallback<SpaceNavigatorRegistration["onNavigate"]>(
    ({ entry, index, intent, confirmed, source, payload }) => {
      if (
        source === "map-cell" &&
        (intent === "temporary" || intent === "inspect") &&
        isSpaceAggregateNavigationPayload(payload)
      ) {
        const aggregateSnapshot = makeAggregateDisplaySnapshot({
          spaceKey: payload.spaceKey,
          representativeVisitId: payload.representativeVisitId,
          displayLabel: payload.displayLabel,
          movementBasisPhase: null,
          phaseSelected: false,
        });
        if (!aggregateSnapshot) {
          return {
            ok: false,
            message:
              "このスペースの巡回対象が変更されたため、選び直してください",
          };
        }
        setPendingMoveDirection(null);
        setPromotionPhaseChoiceOpen(false);
        setDisplaySnapshot(aggregateSnapshot);
        setRecenterRevision((revision) => revision + 1);
        return { ok: true };
      }

      const guard = runGuard(index, intent);
      if (!guard.allowed) {
        return {
          ok: false,
          message: getBlockingMessage(guard),
          tone: "warning",
        };
      }
      if (
        guard.checked &&
        guard.advisoryReasons.includes("unvisited") &&
        !confirmed
      ) {
        return {
          ok: false,
          requiresConfirmation: true,
          message:
            "現在のスペースに未購入のアイテムがあります。確認して移動してください。",
          tone: "warning",
        };
      }

      if (intent === "set-current") {
        const resolved = resolvePromotedEntry(entry);
        if (!resolved.entry) {
          return {
            ok: false,
            message: "選択した訪問先を現在地にできませんでした",
          };
        }
        onCommitOfficial(resolved.entry);
        setDisplaySnapshot(null);
      } else {
        setDisplaySnapshot(makeDisplaySnapshot(entry));
      }
      setPendingMoveDirection(null);
      setPromotionPhaseChoiceOpen(false);
      setRecenterRevision((revision) => revision + 1);
      return {
        ok: true,
        message:
          guard.checked && guard.advisoryReasons.includes("unvisited")
            ? "前のスペースに未購入のアイテムがあります"
            : undefined,
        tone:
          guard.checked && guard.advisoryReasons.includes("unvisited")
            ? "warning"
            : undefined,
      };
    },
    [
      makeAggregateDisplaySnapshot,
      makeDisplaySnapshot,
      onCommitOfficial,
      resolvePromotedEntry,
      runGuard,
    ],
  );

  const handlePromote = useCallback<
    NonNullable<SpaceNavigatorRegistration["onPromote"]>
  >(
    (entry, _index, payload) => {
      if (refreshedDisplaySnapshot?.kind === "space-aggregate") {
        if (!isSpaceAggregatePromotionPayload(payload)) {
          setPromotionPhaseChoiceOpen(true);
          return {
            ok: false,
            requiresPhaseSelection: true,
          };
        }
        const targetEntry =
          baseEntries.find(
            (candidate) =>
              candidate.phase === payload.phase &&
              candidate.spaceKey === refreshedDisplaySnapshot.entry.spaceKey,
          ) ?? null;
        if (!targetEntry) {
          return {
            ok: false,
            message: "選択したフェーズには現在地にできる訪問先がありません",
          };
        }
        onCommitOfficial(targetEntry);
        setPromotionPhaseChoiceOpen(false);
        setPendingMoveDirection(null);
        setDisplaySnapshot(null);
        setRecenterRevision((revision) => revision + 1);
        return { ok: true };
      }

      const resolved = resolvePromotedEntry(entry);
      if (!resolved.entry) {
        return { ok: false, message: "一時移動先を現在地にできませんでした" };
      }
      onCommitOfficial(resolved.entry);
      setPromotionPhaseChoiceOpen(false);
      setPendingMoveDirection(null);
      setDisplaySnapshot(null);
      setRecenterRevision((revision) => revision + 1);
      return {
        ok: true,
        message: resolved.didFallback
          ? "対象フェーズから移動済みのため、同じスペースの通常フェーズを現在地にしました"
          : undefined,
      };
    },
    [
      baseEntries,
      onCommitOfficial,
      refreshedDisplaySnapshot,
      resolvePromotedEntry,
    ],
  );

  const handleRestore = useCallback<
    NonNullable<SpaceNavigatorRegistration["onRestore"]>
  >(
    (point) => {
      const payload = point.snapshot?.location?.payload as
        | RestorePayload
        | undefined;
      const snapshot = payload?.displaySnapshot;
      let restoredSnapshot: DisplaySnapshot | null = null;

      if (snapshot?.kind === "space-aggregate") {
        restoredSnapshot = makeAggregateDisplaySnapshot({
          spaceKey: snapshot.entry.spaceKey,
          representativeVisitId: snapshot.representativeVisitId,
          displayLabel: snapshot.entry.label,
          movementBasisPhase: snapshot.movementBasisPhase,
          phaseSelected: snapshot.phaseSelected,
          subview: snapshot.subview,
        });
        if (!restoredSnapshot) {
          return {
            ok: false,
            message:
              "元の一時表示先が巡回対象から外れたため、さらに前の位置へ戻ります",
          };
        }
      } else if (snapshot?.kind === "single") {
        const liveEntry = baseEntries.find(
          (entry) => entry.id === snapshot.entry.id,
        );
        if (!liveEntry) {
          return {
            ok: false,
            message:
              "元の一時表示先が巡回対象から外れたため、さらに前の位置へ戻ります",
          };
        }
        restoredSnapshot = makeDisplaySnapshot(liveEntry);
      }

      setDisplaySnapshot(restoredSnapshot);
      setPendingMoveDirection(null);
      setPromotionPhaseChoiceOpen(false);
      if (payload?.mapViewport) {
        restoreMapViewportSnapshot?.(payload.mapViewport);
      }
      setRecenterRevision((revision) => revision + 1);
      return { ok: true };
    },
    [
      baseEntries,
      makeAggregateDisplaySnapshot,
      makeDisplaySnapshot,
      restoreMapViewportSnapshot,
    ],
  );

  const registration = useMemo<SpaceNavigatorRegistration>(
    () => ({
      id: registrationId,
      mode: "focus",
      entries,
      currentIndex,
      formalIndex,
      layoutMode,
      getSnapshot: () => ({
        payload: {
          displaySnapshot: refreshedDisplaySnapshot,
          mapViewport: getMapViewportSnapshot?.(),
        } satisfies RestorePayload,
      }),
      onNavigate: handleNavigate,
      onRestore: handleRestore,
      onPromote: handlePromote,
      onInteractionStart,
    }),
    [
      currentIndex,
      entries,
      formalIndex,
      handleNavigate,
      handlePromote,
      handleRestore,
      layoutMode,
      onInteractionStart,
      refreshedDisplaySnapshot,
      getMapViewportSnapshot,
      registrationId,
    ],
  );
  const latestRegistrationRef = useRef(registration);
  latestRegistrationRef.current = registration;

  const register = navigator?.register;
  const updateRegistration = navigator?.updateRegistration;
  useEffect(() => {
    if (!enabled || !register) return;
    return register(latestRegistrationRef.current);
  }, [enabled, register, registrationId]);

  useEffect(() => {
    if (!enabled || !updateRegistration) return;
    updateRegistration(registration);
  }, [enabled, registration, updateRegistration]);

  const previousFormalEntryIdRef = useRef<string | null>(
    formalEntry?.id ?? null,
  );
  useEffect(() => {
    if (displaySnapshot) return;
    const nextId = formalEntry?.id ?? null;
    if (previousFormalEntryIdRef.current === nextId) return;
    previousFormalEntryIdRef.current = nextId;
    setRecenterRevision((revision) => revision + 1);
  }, [displaySnapshot, formalEntry?.id]);

  const aggregateSnapshot =
    refreshedDisplaySnapshot?.kind === "space-aggregate"
      ? refreshedDisplaySnapshot
      : null;
  const emptyAggregateRecoveryRef = useRef(false);

  useEffect(() => {
    const aggregateIsEmpty =
      aggregateSnapshot !== null &&
      aggregateSnapshot.entry.itemIds.length === 0;
    if (!aggregateIsEmpty) {
      emptyAggregateRecoveryRef.current = false;
      return;
    }
    if (emptyAggregateRecoveryRef.current) return;
    emptyAggregateRecoveryRef.current = true;
    setPendingMoveDirection(null);
    setPromotionPhaseChoiceOpen(false);
    navigator?.notify(
      "表示中のスペースが巡回対象から外れたため、元の位置へ戻りました",
    );
    if (navigator && navigator.history.length > 0) {
      void navigator.returnToPrevious();
    } else {
      setDisplaySnapshot(null);
      setRecenterRevision((revision) => revision + 1);
    }
  }, [aggregateSnapshot, navigator]);

  const moveToAggregateTarget = useCallback(
    (
      target: OpportunisticSpaceTarget,
      direction: OpportunisticStepDirection,
    ): SpaceNavigatorActionResult => {
      const activeSnapshot =
        refreshedDisplaySnapshot?.kind === "space-aggregate"
          ? refreshedDisplaySnapshot
          : null;
      if (!activeSnapshot) return { ok: false };

      if (direction === "next") {
        const guard = runAggregateForwardGuard(activeSnapshot.entry);
        if (!guard.allowed) {
          const message = getBlockingMessage(guard);
          navigator?.notify(message, "warning");
          return { ok: false, message, tone: "warning" };
        }
        if (guard.advisoryReasons.includes("unvisited")) {
          navigator?.notify(
            "前のスペースに未購入のアイテムがあります",
            "warning",
          );
        }
      }

      const nextSnapshot = makeAggregateDisplaySnapshot({
        spaceKey: target.spaceKey,
        representativeVisitId: target.representativeVisitId,
        movementBasisPhase: target.phase,
        phaseSelected: true,
      });
      if (!nextSnapshot) {
        const message =
          "移動先の巡回対象が変更されたため、残り一覧を更新しました";
        navigator?.notify(message);
        return { ok: false, message };
      }
      setDisplaySnapshot(nextSnapshot);
      setPendingMoveDirection(null);
      setRecenterRevision((revision) => revision + 1);
      return { ok: true };
    },
    [
      makeAggregateDisplaySnapshot,
      navigator,
      refreshedDisplaySnapshot,
      runAggregateForwardGuard,
    ],
  );

  const initialPhaseCandidates = useMemo<InitialPhaseNavigationCandidates>(
    () =>
      aggregateSnapshot && pendingMoveDirection
        ? buildInitialPhaseNavigationCandidates(baseEntries, {
            currentSpaceKey: aggregateSnapshot.entry.spaceKey,
            direction: pendingMoveDirection,
            latestItemsById,
          })
        : { normal: null, postponed: null, late: null },
    [aggregateSnapshot, baseEntries, latestItemsById, pendingMoveDirection],
  );

  const aggregatePhasePresence = useMemo<Record<FocusPhase, boolean>>(() => {
    const spaceKey = aggregateSnapshot?.entry.spaceKey;
    return {
      normal: Boolean(
        spaceKey &&
        baseEntries.some(
          (entry) => entry.phase === "normal" && entry.spaceKey === spaceKey,
        ),
      ),
      postponed: Boolean(
        spaceKey &&
        baseEntries.some(
          (entry) => entry.phase === "postponed" && entry.spaceKey === spaceKey,
        ),
      ),
      late: Boolean(
        spaceKey &&
        baseEntries.some(
          (entry) => entry.phase === "late" && entry.spaceKey === spaceKey,
        ),
      ),
    };
  }, [aggregateSnapshot?.entry.spaceKey, baseEntries]);

  const remainingSpaceLists = useMemo<RemainingSpaceLists>(
    () =>
      aggregateSnapshot
        ? buildRemainingSpaceLists(baseEntries, {
            currentSpaceKey: aggregateSnapshot.entry.spaceKey,
            latestItemsById,
          })
        : EMPTY_REMAINING_SPACE_LISTS,
    [aggregateSnapshot, baseEntries, latestItemsById],
  );

  const moveTemporaryBy = useCallback(
    (delta: -1 | 1): SpaceNavigatorActionResult => {
      const activeSnapshot = refreshedDisplaySnapshot;
      if (!activeSnapshot || navigator?.isInspecting) {
        return { ok: false };
      }

      if (activeSnapshot.kind === "space-aggregate") {
        if (activeSnapshot.subview !== "visit") return { ok: false };
        const direction: OpportunisticStepDirection =
          delta > 0 ? "next" : "previous";
        if (!activeSnapshot.movementBasisPhase) {
          setPendingMoveDirection(direction);
          return { ok: false, requiresPhaseSelection: true };
        }

        const target = findAdjacentSpaceTarget(baseEntries, {
          currentSpaceKey: activeSnapshot.entry.spaceKey,
          phase: activeSnapshot.movementBasisPhase,
          direction,
          latestItemsById,
        });
        if (target) return moveToAggregateTarget(target, direction);

        if (direction === "next") {
          const guard = runAggregateForwardGuard(activeSnapshot.entry);
          if (!guard.allowed) {
            const message = getBlockingMessage(guard);
            navigator?.notify(message, "warning");
            return { ok: false, message, tone: "warning" };
          }
          setDisplaySnapshot({
            ...activeSnapshot,
            phaseSelected: true,
            subview: "remaining",
          });
          return { ok: true };
        }

        const message = "前のスペースはありません";
        navigator?.notify(message);
        return { ok: false, message };
      }

      const targetIndex = currentIndex + delta;
      const targetEntry = entries[targetIndex];
      if (!targetEntry) {
        return {
          ok: false,
          message: delta > 0 ? "最後の訪問先です" : "最初の訪問先です",
        };
      }
      if (delta > 0) {
        const guard = runGuard(targetIndex, "temporary");
        if (!guard.allowed) {
          const message = getBlockingMessage(guard);
          navigator?.notify(message, "warning");
          return { ok: false, message, tone: "warning" };
        }
        if (guard.advisoryReasons.includes("unvisited")) {
          navigator?.notify(
            "前のスペースに未購入のアイテムがあります",
            "warning",
          );
        }
      }
      setDisplaySnapshot(makeDisplaySnapshot(targetEntry));
      setRecenterRevision((revision) => revision + 1);
      return { ok: true };
    },
    [
      baseEntries,
      currentIndex,
      entries,
      latestItemsById,
      makeDisplaySnapshot,
      moveToAggregateTarget,
      navigator,
      refreshedDisplaySnapshot,
      runAggregateForwardGuard,
      runGuard,
    ],
  );

  const selectMovementPhase = useCallback(
    (phase: FocusPhase): SpaceNavigatorActionResult => {
      const activeSnapshot =
        refreshedDisplaySnapshot?.kind === "space-aggregate"
          ? refreshedDisplaySnapshot
          : null;
      const direction = pendingMoveDirection;
      if (!activeSnapshot || !direction || !aggregatePhasePresence[phase]) {
        return { ok: false, message: "このフェーズには移動先がありません" };
      }
      setPendingMoveDirection(null);

      const selectedSnapshot: AggregateDisplaySnapshot = {
        ...activeSnapshot,
        movementBasisPhase: phase,
        phaseSelected: true,
        subview: "visit",
      };
      // The selected basis is a user decision, so retain it even when the
      // forward price/limited guard stops the actual movement.
      setDisplaySnapshot(selectedSnapshot);

      const target = buildInitialPhaseNavigationCandidates(baseEntries, {
        currentSpaceKey: activeSnapshot.entry.spaceKey,
        direction,
        latestItemsById,
      })[phase];
      if (target) return moveToAggregateTarget(target, direction);

      if (direction === "next") {
        const guard = runAggregateForwardGuard(activeSnapshot.entry);
        if (!guard.allowed) {
          const message = getBlockingMessage(guard);
          navigator?.notify(message, "warning");
          return { ok: false, message, tone: "warning" };
        }
        setDisplaySnapshot({ ...selectedSnapshot, subview: "remaining" });
        return { ok: true };
      }

      const message = "前のスペースはありません";
      navigator?.notify(message);
      return { ok: false, message };
    },
    [
      aggregatePhasePresence,
      baseEntries,
      latestItemsById,
      moveToAggregateTarget,
      navigator,
      pendingMoveDirection,
      refreshedDisplaySnapshot,
      runAggregateForwardGuard,
    ],
  );

  const cancelMovementPhaseSelection = useCallback(() => {
    setPendingMoveDirection(null);
  }, []);

  const selectRemainingSpace = useCallback(
    (
      phase: FocusPhase,
      representativeVisitId: string,
    ): SpaceNavigatorActionResult => {
      const activeSnapshot =
        refreshedDisplaySnapshot?.kind === "space-aggregate"
          ? refreshedDisplaySnapshot
          : null;
      if (!activeSnapshot) return { ok: false };
      const latestLists = buildRemainingSpaceLists(baseEntries, {
        currentSpaceKey: activeSnapshot.entry.spaceKey,
        latestItemsById,
      });
      const candidate = latestLists[phase].find(
        (entry) =>
          entry.representativeVisitId === representativeVisitId ||
          entry.visitIds.includes(representativeVisitId),
      );
      if (!candidate || candidate.isCurrent) {
        const message =
          "購入状態が変更されたため、選択した候補は一覧から外れました";
        navigator?.notify(message);
        return { ok: false, message };
      }
      const nextSnapshot = makeAggregateDisplaySnapshot({
        spaceKey: candidate.spaceKey,
        representativeVisitId: candidate.representativeVisitId,
        movementBasisPhase: phase,
        phaseSelected: true,
      });
      if (!nextSnapshot) {
        const message =
          "移動先の巡回対象が変更されたため、候補を選び直してください";
        navigator?.notify(message);
        return { ok: false, message };
      }
      setDisplaySnapshot(nextSnapshot);
      setRecenterRevision((revision) => revision + 1);
      return { ok: true };
    },
    [
      baseEntries,
      latestItemsById,
      makeAggregateDisplaySnapshot,
      navigator,
      refreshedDisplaySnapshot,
    ],
  );

  const setTemporarySubview = useCallback((subview: FocusTemporarySubview) => {
    setDisplaySnapshot((current) =>
      current?.kind === "space-aggregate" ? { ...current, subview } : current,
    );
  }, []);

  const confirmPromotionPhase = useCallback(
    async (phase: FocusPhase): Promise<SpaceNavigatorActionResult> => {
      const result = await navigator?.promoteTemporary({
        kind: "space-aggregate-promotion",
        phase,
      } satisfies FocusSpaceAggregatePromotionPayload);
      if (result?.ok) setPromotionPhaseChoiceOpen(false);
      return result ?? { ok: false };
    },
    [navigator],
  );

  return {
    entries,
    baseEntries,
    currentIndex,
    formalIndex,
    formalRouteIndex,
    displayEntry,
    displayPhase: displayEntry?.phase ?? officialPhase,
    displayPhaseIndex: displayEntry?.phaseIndex ?? officialPhaseIndex,
    displayItemIds: displayEntry?.itemIds ?? EMPTY_ITEM_IDS,
    isTemporaryActive: refreshedDisplaySnapshot !== null,
    isInspecting: Boolean(refreshedDisplaySnapshot && navigator?.isInspecting),
    interactionActive: Boolean(
      navigator?.pickerOpen || refreshedDisplaySnapshot,
    ),
    pickerOpen: Boolean(navigator?.pickerOpen),
    recenterRevision,
    moveTemporaryBy,
    isSpaceAggregate: aggregateSnapshot !== null,
    aggregateSpaceKey: aggregateSnapshot?.entry.spaceKey ?? null,
    movementBasisPhase: aggregateSnapshot?.movementBasisPhase ?? null,
    temporarySubview: aggregateSnapshot?.subview ?? "visit",
    movementPhaseSelectionOpen: pendingMoveDirection !== null,
    movementDirection: pendingMoveDirection,
    initialPhaseCandidates,
    aggregatePhasePresence,
    selectMovementPhase,
    cancelMovementPhaseSelection,
    remainingSpaceLists,
    selectRemainingSpace,
    showTemporaryEnd: () => setTemporarySubview("ended"),
    showRemainingSpaces: () => setTemporarySubview("remaining"),
    closeRemainingSpaces: () => setTemporarySubview("visit"),
    promotionPhaseChoiceOpen,
    promotionPhasePresence: aggregatePhasePresence,
    cancelPromotionPhaseSelection: () => setPromotionPhaseChoiceOpen(false),
    confirmPromotionPhase,
  };
}
