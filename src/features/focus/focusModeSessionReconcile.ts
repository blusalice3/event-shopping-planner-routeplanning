import type { FocusModeSessionState, FocusPhase } from '../../types/focus';
import type { ExecuteModeItems, ShoppingItem } from '../../types/item';

const FOCUS_SESSION_KEY_SEPARATOR = '::';

type ParsedFocusSessionKey = {
  eventName: string;
  eventDate: string;
};

const parseFocusSessionKey = (key: string): ParsedFocusSessionKey | null => {
  const separatorIndex = key.lastIndexOf(FOCUS_SESSION_KEY_SEPARATOR);
  if (separatorIndex <= 0) return null;

  const eventName = key.slice(0, separatorIndex);
  const eventDate = key.slice(separatorIndex + FOCUS_SESSION_KEY_SEPARATOR.length);
  if (!eventName || !eventDate) return null;
  return { eventName, eventDate };
};

const areStringArraysEqual = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

const pushUniqueId = (ids: string[], seen: Set<string>, id: string): void => {
  if (seen.has(id)) return;
  seen.add(id);
  ids.push(id);
};

const extractBaseNumber = (number: string): string => {
  const match = number.match(/^(\d+[a-zA-Z])/);
  return match ? match[1].toLowerCase() : number.toLowerCase();
};

const getVisitKey = (item: ShoppingItem): string => {
  const baseNumber = extractBaseNumber(item.number);
  const priority = item.priorityLevel || 'none';
  return `${item.eventDate}-${item.block}-${baseNumber}-${priority}`;
};

const buildPhaseItemIds = (
  eventItems: ShoppingItem[],
  routeItemIds: string[],
  status: ShoppingItem['purchaseStatus'],
): string[] => {
  const eventItemsById = new Map(eventItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const phaseItemIds: string[] = [];

  routeItemIds.forEach((itemId) => {
    const item = eventItemsById.get(itemId);
    if (!item || item.purchaseStatus !== status) return;
    pushUniqueId(phaseItemIds, seen, item.id);
  });

  return phaseItemIds;
};

const clampVisitIndex = (index: number | undefined, visitKeys: string[]): number => {
  if (visitKeys.length === 0) return 0;
  return Math.min(Math.max(0, index ?? 0), visitKeys.length - 1);
};

const buildPhaseVisitKeys = (
  eventItems: ShoppingItem[],
  routeItemIds: string[],
  postponedItemIds: string[],
  lateItemIds: string[],
): Record<FocusPhase, string[]> => {
  const eventItemsById = new Map(eventItems.map((item) => [item.id, item]));
  const postponedIdSet = new Set(postponedItemIds);
  const lateIdSet = new Set(lateItemIds);
  const visitOrder: string[] = [];
  const visitFlags = new Map<string, { postponed: boolean; late: boolean }>();

  routeItemIds.forEach((itemId) => {
    const item = eventItemsById.get(itemId);
    if (!item) return;

    const visitKey = getVisitKey(item);
    if (!visitFlags.has(visitKey)) {
      visitOrder.push(visitKey);
      visitFlags.set(visitKey, { postponed: false, late: false });
    }

    const flags = visitFlags.get(visitKey)!;
    flags.postponed = flags.postponed || postponedIdSet.has(item.id);
    flags.late = flags.late || lateIdSet.has(item.id);
  });

  return {
    normal: visitOrder,
    postponed: visitOrder.filter((visitKey) => visitFlags.get(visitKey)?.postponed),
    late: visitOrder.filter((visitKey) => visitFlags.get(visitKey)?.late),
  };
};

export const reconcileFocusModeSessions = (
  sessions: Record<string, FocusModeSessionState>,
  eventLists: Record<string, ShoppingItem[]>,
  executeModeItems: Record<string, ExecuteModeItems>,
  validSessionKeys: Set<string>,
): Record<string, FocusModeSessionState> => {
  let changed = false;
  const next: Record<string, FocusModeSessionState> = {};

  Object.entries(sessions).forEach(([key, value]) => {
    if (!validSessionKeys.has(key)) {
      changed = true;
      return;
    }

    const parsedKey = parseFocusSessionKey(key);
    if (!parsedKey) {
      changed = true;
      return;
    }

    const routeItemIds = executeModeItems[parsedKey.eventName]?.[parsedKey.eventDate] ?? [];
    const eventItems = eventLists[parsedKey.eventName] ?? [];
    const postponedItemIds = buildPhaseItemIds(eventItems, routeItemIds, 'Postpone');
    const lateItemIds = buildPhaseItemIds(eventItems, routeItemIds, 'Late');
    const phaseVisitKeys = buildPhaseVisitKeys(
      eventItems,
      routeItemIds,
      postponedItemIds,
      lateItemIds,
    );
    const phase =
      phaseVisitKeys[value.phase]?.length > 0 || phaseVisitKeys.normal.length === 0
        ? value.phase
        : 'normal';
    const phaseIndex = clampVisitIndex(value.phaseIndex, phaseVisitKeys[phase]);
    const savedPhaseIndices: Record<FocusPhase, number> = {
      normal: clampVisitIndex(value.savedPhaseIndices.normal, phaseVisitKeys.normal),
      postponed: clampVisitIndex(value.savedPhaseIndices.postponed, phaseVisitKeys.postponed),
      late: clampVisitIndex(value.savedPhaseIndices.late, phaseVisitKeys.late),
    };
    const lastPurchaseChangeAt = (() => {
      const lastChange = value.lastPurchaseChangeAt ?? null;
      if (!lastChange) return null;

      const visitKeys = phaseVisitKeys[lastChange.phase];
      const phaseIndexForVisit = visitKeys.indexOf(lastChange.visitKey);
      if (phaseIndexForVisit < 0) return null;

      return {
        ...lastChange,
        phaseIndex: phaseIndexForVisit,
      };
    })();

    const isSessionProgressMetadataUnchanged =
      phase === value.phase &&
      phaseIndex === value.phaseIndex &&
      areStringArraysEqual(postponedItemIds, value.postponedItemIds) &&
      areStringArraysEqual(lateItemIds, value.lateItemIds) &&
      savedPhaseIndices.normal === value.savedPhaseIndices.normal &&
      savedPhaseIndices.postponed === value.savedPhaseIndices.postponed &&
      savedPhaseIndices.late === value.savedPhaseIndices.late &&
      JSON.stringify(lastPurchaseChangeAt) === JSON.stringify(value.lastPurchaseChangeAt ?? null);

    if (isSessionProgressMetadataUnchanged) {
      next[key] = value;
      return;
    }

    changed = true;
    next[key] = {
      ...value,
      phase,
      phaseIndex,
      postponedItemIds,
      lateItemIds,
      savedPhaseIndices,
      lastPurchaseChangeAt,
      isCompleted: value.isCompleted ? false : value.isCompleted,
    };
  });

  return changed ? next : sessions;
};
