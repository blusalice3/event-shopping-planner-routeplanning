import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FocusPhase } from "../../../types/focus";
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
import type {
  FocusNavigatorSources,
  NavigationGuardResult,
  NavigatorEntry,
} from "../types";

type DisplaySnapshot = {
  entry: NavigatorEntry;
};

type RestorePayload = {
  displaySnapshot: DisplaySnapshot | null;
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
}

const phaseOrder: readonly FocusPhase[] = ["normal", "postponed", "late"];
const EMPTY_ITEM_IDS: readonly string[] = [];

const getBlockingMessage = (result: NavigationGuardResult): string => {
  const hasPrice = result.blockingReasons.includes("price");
  const hasLimited = result.blockingReasons.includes("limited");
  if (hasPrice && hasLimited) return "価格と限数の実購入数を入力してください";
  if (hasPrice) return "価格未定のアイテムがあります。価格を入力してください。";
  return "限数未入力があります。実購入数を入力してください";
};

const refreshSnapshotEntry = (
  snapshot: DisplaySnapshot,
  latestItemsById: ReadonlyMap<string, ShoppingItem>,
): NavigatorEntry => {
  const latestItems = snapshot.entry.itemIds.map(
    (itemId) =>
      latestItemsById.get(itemId) ??
      (snapshot.entry.items.find((item) => item.id === itemId) as
        | ShoppingItem
        | undefined),
  );
  const items = latestItems.filter(
    (item): item is ShoppingItem => item !== undefined,
  );
  return {
    ...snapshot.entry,
    items,
    statusCounts: countNavigatorStatuses(items),
    statusSegments: buildStatusSegments(items),
    warningKinds: getNavigatorWarningKinds(items),
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
}: UseFocusSpaceNavigatorArgs) {
  const navigator = useOptionalSpaceNavigator();
  const [displaySnapshot, setDisplaySnapshot] =
    useState<DisplaySnapshot | null>(null);
  const [recenterRevision, setRecenterRevision] = useState(0);

  const baseEntries = useMemo(
    () => buildFocusNavigatorEntries(sourcesByPhase),
    [sourcesByPhase],
  );
  const refreshedRetainedEntry = useMemo(
    () =>
      displaySnapshot
        ? refreshSnapshotEntry(displaySnapshot, latestItemsById)
        : null,
    [displaySnapshot, latestItemsById],
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
  const formalIndex = formalEntry
    ? entries.findIndex((entry) => entry.id === formalEntry.id)
    : 0;
  const displayEntry =
    (displaySnapshot
      ? entries.find((entry) => entry.id === displaySnapshot.entry.id)
      : formalEntry) ?? null;
  const currentIndex = displayEntry
    ? Math.max(
        0,
        entries.findIndex((entry) => entry.id === displayEntry.id),
      )
    : formalIndex;

  const makeDisplaySnapshot = useCallback(
    (entry: NavigatorEntry): DisplaySnapshot => ({
      entry: {
        ...entry,
        items: entry.items.map(
          (item) => latestItemsById.get(item.id) ?? (item as ShoppingItem),
        ),
      },
    }),
    [latestItemsById],
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
    ({ entry, index, intent, confirmed }) => {
      const guard = runGuard(index, intent);
      if (!guard.allowed) {
        return {
          ok: false,
          message: getBlockingMessage(guard),
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
      setRecenterRevision((revision) => revision + 1);
      return {
        ok: true,
        message:
          guard.checked && guard.advisoryReasons.includes("unvisited")
            ? "前のスペースに未購入のアイテムがあります"
            : undefined,
      };
    },
    [makeDisplaySnapshot, onCommitOfficial, resolvePromotedEntry, runGuard],
  );

  const handlePromote = useCallback<
    NonNullable<SpaceNavigatorRegistration["onPromote"]>
  >(
    (entry) => {
      const resolved = resolvePromotedEntry(entry);
      if (!resolved.entry) {
        return { ok: false, message: "一時移動先を現在地にできませんでした" };
      }
      onCommitOfficial(resolved.entry);
      setDisplaySnapshot(null);
      setRecenterRevision((revision) => revision + 1);
      return {
        ok: true,
        message: resolved.didFallback
          ? "対象フェーズから移動済みのため、同じスペースの通常フェーズを現在地にしました"
          : undefined,
      };
    },
    [onCommitOfficial, resolvePromotedEntry],
  );

  const handleRestore = useCallback<
    NonNullable<SpaceNavigatorRegistration["onRestore"]>
  >((point) => {
    const payload = point.snapshot?.location?.payload as
      | RestorePayload
      | undefined;
    if (payload?.displaySnapshot) {
      setDisplaySnapshot(payload.displaySnapshot);
    } else {
      setDisplaySnapshot(null);
    }
    setRecenterRevision((revision) => revision + 1);
  }, []);

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
          displaySnapshot,
        } satisfies RestorePayload,
      }),
      onNavigate: handleNavigate,
      onRestore: handleRestore,
      onPromote: handlePromote,
      onInteractionStart,
    }),
    [
      currentIndex,
      displaySnapshot,
      entries,
      formalIndex,
      handleNavigate,
      handlePromote,
      handleRestore,
      layoutMode,
      onInteractionStart,
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

  const moveTemporaryBy = useCallback(
    (delta: -1 | 1): SpaceNavigatorActionResult => {
      if (!displaySnapshot || navigator?.isInspecting) {
        return { ok: false };
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
          navigator?.notify(message);
          return { ok: false, message };
        }
        if (guard.advisoryReasons.includes("unvisited")) {
          navigator?.notify("前のスペースに未購入のアイテムがあります");
        }
      }
      setDisplaySnapshot(makeDisplaySnapshot(targetEntry));
      setRecenterRevision((revision) => revision + 1);
      return { ok: true };
    },
    [
      currentIndex,
      displaySnapshot,
      entries,
      makeDisplaySnapshot,
      navigator,
      runGuard,
    ],
  );

  return {
    entries,
    baseEntries,
    currentIndex,
    formalIndex,
    displayEntry,
    displayPhase: displayEntry?.phase ?? officialPhase,
    displayPhaseIndex: displayEntry?.phaseIndex ?? officialPhaseIndex,
    displayItemIds: displayEntry?.itemIds ?? EMPTY_ITEM_IDS,
    isTemporaryActive: displaySnapshot !== null,
    isInspecting: Boolean(displaySnapshot && navigator?.isInspecting),
    interactionActive: Boolean(navigator?.pickerOpen || displaySnapshot),
    pickerOpen: Boolean(navigator?.pickerOpen),
    recenterRevision,
    moveTemporaryBy,
  };
}
