import * as React from "react";
import FocusMode from "./FocusMode";
import type { DayMapData, HallDefinition } from "../types/map";
import type { FocusModeSessionState } from "../types/focus";
import type { PurchaseStatusControlMode, ShoppingItem } from "../types/item";

export const completedFixture: FocusModeSessionState = {
  phase: "normal",
  phaseIndex: 0,
  savedPhaseIndices: { normal: 0, postponed: 0, late: 0 },
  postponedItemIds: [],
  lateItemIds: [],
  isCompleted: true,
  lastPurchaseChangeAt: null,
};

export const incompleteSessionFixture: FocusModeSessionState = {
  phase: "normal",
  phaseIndex: 0,
  savedPhaseIndices: { normal: 0, postponed: 0, late: 0 },
  postponedItemIds: [],
  lateItemIds: [],
  isCompleted: false,
  lastPurchaseChangeAt: null,
};

// 単一訪問先 + 単一アイテム(status=None)fixture
export const singleVisitNoneItemFixture = {
  items: [
    {
      id: "item-1",
      eventDate: "2026-01-01",
      block: "A",
      number: "01a",
      circle: "サークル1",
      title: "タイトル1",
      price: 1000,
      quantity: 1,
      purchaseStatus: "None",
      priorityLevel: "none",
      remarks: "",
      url: "",
    } as ShoppingItem,
  ],
  executeModeItemIds: ["item-1"],
};

// 単一訪問先 + 単一アイテム(status=Postpone)fixture。auto-advance トリガ用
export const singleVisitPostponeItemFixture = {
  items: [
    {
      ...singleVisitNoneItemFixture.items[0],
      purchaseStatus: "Postpone" as const,
    },
  ],
  executeModeItemIds: ["item-1"],
};

// 完了済み + lastPurchaseChangeAt あり fixture (pointer 復元時 lpc 保持検証用)
export const completedWithLastChangeFixture: FocusModeSessionState = {
  ...completedFixture,
  lastPurchaseChangeAt: {
    phase: "normal",
    phaseIndex: 0,
    visitKey: "2026-01-01-A-01a-none",
  },
};

const cloneSessionState = (
  state: FocusModeSessionState | null | undefined,
): FocusModeSessionState | null => {
  if (!state) return null;
  return {
    ...state,
    savedPhaseIndices: { ...state.savedPhaseIndices },
    postponedItemIds: [...state.postponedItemIds],
    lateItemIds: [...state.lateItemIds],
    lastPurchaseChangeAt: state.lastPurchaseChangeAt
      ? { ...state.lastPurchaseChangeAt }
      : (state.lastPurchaseChangeAt ?? null),
  };
};

// 最低限の FocusMode props 生成ヘルパ
export const minimalProps = (
  overrides: {
    resumeState?: FocusModeSessionState | null;
    items?: ShoppingItem[];
    executeModeItemIds?: string[];
    onUpdateItem?: (item: ShoppingItem) => void;
    onSessionStateChange?: (state: FocusModeSessionState) => void;
    onModeChange?: (mode: "edit" | "execute", lastItemId?: string) => void;
    disablePriceUndefinedCheck?: boolean;
    disableLimitedPurchaseQuantityCheck?: boolean;
    skipLimitedPurchaseForSingleQuantity?: boolean;
    purchaseStatusControlMode?: PurchaseStatusControlMode;
    postEventDistributionCheckEnabled?: boolean;
  } = {},
) => ({
  items: overrides.items ?? [],
  executeModeItemIds: overrides.executeModeItemIds ?? [],
  onUpdateItem: overrides.onUpdateItem ?? (() => {}),
  onModeChange: overrides.onModeChange ?? (() => {}),
  layoutMode: "pc" as const,
  onLayoutModeChange: () => {},
  mapData: {} as { [dayMapName: string]: DayMapData },
  hallDefinitions: [] as HallDefinition[],
  hallOrder: [] as string[],
  resumeState: cloneSessionState(overrides.resumeState),
  onSessionStateChange: overrides.onSessionStateChange ?? (() => {}),
  disablePriceUndefinedCheck: overrides.disablePriceUndefinedCheck ?? false,
  disableLimitedPurchaseQuantityCheck:
    overrides.disableLimitedPurchaseQuantityCheck ?? false,
  skipLimitedPurchaseForSingleQuantity:
    overrides.skipLimitedPurchaseForSingleQuantity ?? true,
  purchaseStatusControlMode: overrides.purchaseStatusControlMode ?? "cycle",
  postEventDistributionCheckEnabled:
    overrides.postEventDistributionCheckEnabled ?? true,
});

/**
 * FocusMode を items state 付きでラップする統合テスト用ハーネス。
 *
 * 設計方針:
 *   - items は `useState(initialItems)` で初期化し、以降は内部 state で管理。
 *     **initialItems の後続変更は意図的に反映しない**(同期を廃止したため、
 *     毎回新規配列を渡してもユーザー操作の state を上書きしない)。
 *   - items を差し替えてテストしたいときは `<Harness key={n} ... />` のように
 *     key を変えて明示的にリマウントする。
 *   - items state は `handleUpdateItem` が回せるよう React state で管理。
 */
export const StatefulFocusModeHarness: React.FC<{
  initialItems: ShoppingItem[];
  executeModeItemIds: string[];
  resumeState: FocusModeSessionState | null;
  onSessionStateChange?: (state: FocusModeSessionState) => void;
  disableLimitedPurchaseQuantityCheck?: boolean;
  postEventDistributionCheckEnabled?: boolean;
}> = ({
  initialItems,
  executeModeItemIds,
  resumeState,
  onSessionStateChange,
  disableLimitedPurchaseQuantityCheck,
  postEventDistributionCheckEnabled,
}) => {
  const [items, setItems] = React.useState(initialItems);
  // 後続 initialItems 変更は取り込まない。リセットしたければ key でリマウント
  const handleUpdateItem = React.useCallback((updated: ShoppingItem) => {
    setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
  }, []);
  return (
    <FocusMode
      {...minimalProps({
        items,
        executeModeItemIds,
        onUpdateItem: handleUpdateItem,
        resumeState,
        onSessionStateChange,
        disableLimitedPurchaseQuantityCheck,
        postEventDistributionCheckEnabled,
      })}
    />
  );
};
