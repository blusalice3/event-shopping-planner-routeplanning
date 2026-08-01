import type {
  FocusNavigatorSources,
  NavigatorBuildSource,
  NavigatorEntry,
  NavigatorItem,
  NavigatorPhase,
  NavigatorSourceVisit,
} from "../types";
import { NAVIGATOR_PHASE_ORDER } from "../types";
import { buildVisitIdentity } from "./visitIdentity";
import {
  buildStatusSegments,
  countNavigatorStatuses,
  getNavigatorWarningKinds,
} from "./statusSegments";

function isSourceVisit(
  source: NavigatorBuildSource,
): source is NavigatorSourceVisit {
  return "items" in source && Array.isArray(source.items);
}

function asSourceVisit(
  source: NavigatorBuildSource,
  defaultPhase?: NavigatorPhase,
): NavigatorSourceVisit {
  if (isSourceVisit(source)) {
    return {
      ...source,
      ...(defaultPhase ? { phase: defaultPhase } : {}),
    };
  }

  return {
    ...(defaultPhase ? { phase: defaultPhase } : {}),
    block: source.block,
    number: source.number,
    priorityLevel: source.priorityLevel,
    items: [source],
  };
}

interface MutableEntrySource {
  identity: ReturnType<typeof buildVisitIdentity>;
  label?: string;
  items: NavigatorItem[];
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
}

/**
 * Builds entries without sorting. The caller's route/filter order is the
 * source of truth; repeated identities are merged into their first position.
 */
export function buildNavigatorEntries(
  sources: readonly NavigatorBuildSource[],
  options: { phase?: NavigatorPhase } = {},
): NavigatorEntry[] {
  const order: string[] = [];
  const grouped = new Map<string, MutableEntrySource>();

  sources.forEach((source) => {
    const visit = asSourceVisit(source, options.phase);
    const firstItem = visit.items[0];
    const block = visit.block ?? firstItem?.block;
    const number = visit.number ?? firstItem?.number;
    if (block === undefined || number === undefined) return;

    const identity = buildVisitIdentity({
      phase: visit.phase,
      block,
      number,
      priorityLevel: visit.priorityLevel ?? firstItem?.priorityLevel,
    });
    const existing = grouped.get(identity.id);

    if (existing) {
      existing.items.push(...visit.items);
      return;
    }

    order.push(identity.id);
    grouped.set(identity.id, {
      identity,
      label: visit.label,
      items: [...visit.items],
    });
  });

  const phaseCounts = new Map<NavigatorPhase | undefined, number>();
  return order.map((id, index) => {
    const source = grouped.get(id)!;
    const { identity, items } = source;
    const phaseIndex = phaseCounts.get(identity.phase) ?? 0;
    phaseCounts.set(identity.phase, phaseIndex + 1);

    return {
      ...identity,
      index,
      phaseIndex,
      label: source.label ?? identity.spaceKey,
      circles: uniqueInOrder(
        items
          .map((item) => item.circle.trim())
          .filter((circle) => circle.length > 0),
      ),
      itemIds: uniqueInOrder(items.map((item) => item.id)),
      items,
      statusCounts: countNavigatorStatuses(items),
      statusSegments: buildStatusSegments(items),
      warningKinds: getNavigatorWarningKinds(items),
    };
  });
}

export function buildExecutionNavigatorEntries(
  items: readonly NavigatorItem[],
): NavigatorEntry[] {
  return buildNavigatorEntries(items);
}

/**
 * Concatenates the focus phases in the fixed normal → postponed → late order.
 * Each phase accepts either already-grouped visits or raw ordered items.
 */
export function buildFocusNavigatorEntries(
  sourcesByPhase: FocusNavigatorSources,
): NavigatorEntry[] {
  const entries = NAVIGATOR_PHASE_ORDER.flatMap((phase) =>
    buildNavigatorEntries(sourcesByPhase[phase] ?? [], { phase }),
  );
  const phaseCounts = new Map<NavigatorPhase, number>();

  return entries.map((entry, index) => {
    const phase = entry.phase!;
    const phaseIndex = phaseCounts.get(phase) ?? 0;
    phaseCounts.set(phase, phaseIndex + 1);
    return { ...entry, index, phaseIndex };
  });
}
