import type { FocusPhase } from "../../types/focus";
import type { PurchaseStatus, ShoppingItem } from "../../types/item";

export const NAVIGATOR_PHASE_ORDER = [
  "normal",
  "postponed",
  "late",
] as const satisfies readonly FocusPhase[];

export type NavigatorPhase = FocusPhase;
export type NavigatorPriority = NonNullable<ShoppingItem["priorityLevel"]>;

export const NAVIGATOR_STATUS_ORDER = [
  "unvisited",
  "postponed",
  "late",
  "limited",
  "completed",
] as const;

export type NavigatorStatusKind = (typeof NAVIGATOR_STATUS_ORDER)[number];
export type NavigatorWarningKind = "price" | "limited";

/**
 * A deliberately small, structural item type. ShoppingItem can be passed
 * directly, while pure-domain tests and future importers do not need to
 * manufacture unrelated UI fields.
 */
export interface NavigatorItem {
  id: string;
  circle: string;
  block: string;
  number: string;
  purchaseStatus: PurchaseStatus;
  price: number | null;
  quantity: number;
  limitedPurchasedQuantity?: number;
  priorityLevel?: NavigatorPriority;
}

export interface NavigatorStatusSegment {
  kind: NavigatorStatusKind;
  count: number;
  startRatio: number;
  endRatio: number;
  widthRatio: number;
}

export type NavigatorStatusCounts = Record<NavigatorStatusKind, number>;

export interface VisitIdentity {
  id: string;
  spaceKey: string;
  phase?: NavigatorPhase;
  block: string;
  number: string;
  priorityLevel: NavigatorPriority;
}

export interface NavigatorSourceVisit {
  /** Existing FocusMode visits expose this key; identity is still normalized from item fields. */
  key?: string;
  phase?: NavigatorPhase;
  block?: string;
  number?: string;
  priorityLevel?: NavigatorPriority;
  label?: string;
  items: readonly NavigatorItem[];
}

export type NavigatorBuildSource = NavigatorSourceVisit | NavigatorItem;

export interface NavigatorEntry extends VisitIdentity {
  index: number;
  phaseIndex: number;
  label: string;
  circles: string[];
  itemIds: string[];
  items: readonly NavigatorItem[];
  statusCounts: NavigatorStatusCounts;
  statusSegments: NavigatorStatusSegment[];
  warningKinds: NavigatorWarningKind[];
}

export type FocusNavigatorSources = Partial<
  Record<NavigatorPhase, readonly NavigatorBuildSource[]>
>;

export type NavigationIntent =
  | "set-current"
  | "temporary"
  | "inspect"
  | "return"
  | "promote-temporary";

export type NavigationDirection = "forward" | "backward" | "same";
export type NavigationBlockReason = NavigatorWarningKind;
export type NavigationAdvisoryReason = "unvisited";

export interface NavigationGuardSettings {
  disablePriceUndefinedCheck?: boolean;
  disableLimitedPurchaseQuantityCheck?: boolean;
  /**
   * Supports the existing "defer this visit's missing limited quantities"
   * flow. It affects movement blocking only, never the warning stripe.
   */
  deferredLimitedItemIds?: ReadonlySet<string> | readonly string[];
}

export interface NavigationGuardInput {
  intent: NavigationIntent;
  currentIndex: number;
  targetIndex: number;
  currentItems: readonly NavigatorItem[];
  settings?: NavigationGuardSettings;
}

export interface NavigationGuardResult {
  allowed: boolean;
  direction: NavigationDirection;
  checked: boolean;
  blockingReasons: NavigationBlockReason[];
  advisoryReasons: NavigationAdvisoryReason[];
  priceWarningItemIds: string[];
  limitedWarningItemIds: string[];
  unvisitedItemIds: string[];
}

export interface NavigatorReturnPoint<TSnapshot = unknown> {
  visitId: string;
  navigatorIndex: number;
  mode: "temporary" | "inspect";
  phase?: NavigatorPhase;
  phaseIndex?: number;
  scrollTop?: number;
  anchorOffset?: number;
  snapshot?: TSnapshot;
}

export type NavigatorReturnHistory<
  TPoint extends NavigatorReturnPoint = NavigatorReturnPoint,
> = readonly TPoint[];

export interface PopReturnHistoryResult<
  TPoint extends NavigatorReturnPoint = NavigatorReturnPoint,
> {
  point: TPoint | null;
  history: NavigatorReturnHistory<TPoint>;
}
