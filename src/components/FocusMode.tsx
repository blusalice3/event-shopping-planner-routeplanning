import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  ShoppingItem,
  PurchaseStatus,
  PurchaseStatusControlMode,
} from "../types/item";
import {
  DayMapData,
  HallDefinition,
  NumberCellOutlineStyle,
} from "../types/map";
import {
  FocusModeSessionState,
  FocusPhase,
  FocusMapCenteringMode,
  FocusMapViewportRestoreRequest,
  FocusMapViewportSnapshot,
} from "../types/focus";
import FocusModeMapCanvas from "./FocusModeMapCanvas";
import {
  AddItemDialogView,
  CellItemPopup,
  PhaseChangeDialogView,
  TemporaryPhaseChoiceDialog,
  TemporaryRemainingSpacesDialog,
  type CellTemporaryTarget,
  type TemporaryPhaseChoice,
  type TemporaryRemainingSection,
} from "./focus/FocusModeDialogs";
import {
  FocusModeHeader,
  FocusModeItemList,
  FocusModeMapControls,
} from "./focus/FocusModePanels";
import { FocusModeFooterPortal } from "./focus/FocusModeFooterPortal";
import LimitedPurchaseDialog from "./LimitedPurchaseDialog";
import type {
  BulkLimitedMessageState,
  LimitedBulkDialogContext,
  LimitedBulkNotificationOwner,
  LimitedPurchaseDialogResult,
} from "../types/limitedPurchase";
import { LimitedPurchaseMissingListView } from "./focus/LimitedPurchaseMissingListView";
import {
  AutoAdvancingStateView,
  CompletionStateView,
  EmptyVisitStateView,
  ResumeChoiceDialogView,
  TemporaryTourEndStateView,
} from "./focus/FocusModeStateViews";
import { resolveResumeChoice } from "./focus/resumeChoice";
import { useAutoSkipEmptyVisit } from "./focus/hooks/useAutoSkipEmptyVisit";
import { useFocusSessionState } from "./focus/hooks/useFocusSessionState";
import { useResumeFlow } from "./focus/hooks/useResumeFlow";
import { extractNumberFromItemNumber } from "../utils/xlsxMapParser";
import {
  buildItemRoutingSignature,
  sortItemsByHallOrder,
} from "../utils/hallGrouping";
import {
  buildDayMapPathfindingSignature,
  buildDayMapVisitLookupSignature,
  findRouteLookupNumberCell,
} from "../utils/mapRoutingSignature";
import { buildHallDefinitionsRoutingSignature } from "../utils/hallRoutingSignature";
import {
  calculateStrictFocusRoute,
  type FocusRouteCalculation,
} from "../utils/focusRouteCalculation";
import { buildRouteDiagnostics } from "../utils/routeDiagnostics";
import {
  applyLimitedPurchase,
  applyPurchasedFromLimitedInput,
  clearLimitedPurchase,
  getActualPurchasedQuantity,
  getChargeableQuantity,
  getLimitedBulkInputTargetDecision,
  getLimitedBulkInputTargets,
  getPlannedBudgetQuantity,
  getPlannedQuantity,
  getSafePriceForCalculation,
  hasMissingLimitedPurchaseQuantity,
  isCountedAsPurchased,
  isPriceRequiredStatus,
  isUndefinedPrice,
} from "../utils/purchaseQuantity";
import {
  computeLimitedBulkCancelDecision,
  computeLimitedBulkSubmitDecision,
} from "../utils/limitedBulkFlow";
import PostEventDistributionCheckDialog, {
  type PostEventDistributionCheckMode,
} from "./PostEventDistributionCheckDialog";
import {
  type PostEventDistributionAnswer,
  upsertPostEventDistributionRemark,
} from "../utils/postEventDistributionCheck";
import {
  useFocusSpaceNavigator,
  type FocusSpaceAggregateNavigationPayload,
} from "../features/space-navigation/hooks/useFocusSpaceNavigator";
import type {
  NavigationGuardResult,
  NavigatorEntry,
  NavigatorSourceVisit,
} from "../features/space-navigation/types";
import {
  buildSpaceKey,
  normalizeBaseSpaceNumber,
  normalizeSpaceBlock,
} from "../features/space-navigation/domain/visitIdentity";
import {
  aggregateNavigatorSpace,
  groupCellItemsBySpace,
} from "../features/space-navigation/domain/opportunisticNavigation";
import { useOptionalSpaceNavigator } from "../features/space-navigation/SpaceNavigatorContext";
import { SPACE_NAVIGATOR_RAIL_WIDTH_PX } from "../features/space-navigation/components/SpaceNavigatorRail";
// フェーズの定義
interface FocusModeProps {
  items: ShoppingItem[];
  executeModeItemIds: string[];
  onUpdateItem: (item: ShoppingItem) => void;
  onModeChange: (mode: "edit" | "execute", lastItemId?: string) => void;
  layoutMode: "pc" | "smartphone";
  onLayoutModeChange: (mode: "pc" | "smartphone") => void;
  // マップ関連の追加props
  mapData?: { [dayMapName: string]: DayMapData };
  hallDefinitions?: HallDefinition[];
  hallOrder?: string[];
  onMapVisibilityChange?: (isMapVisible: boolean) => void;
  // 新規アイテム追加（purchaseStatusを含めることが可能）
  onAddItem?: (
    item: Omit<ShoppingItem, "id"> & { purchaseStatus?: PurchaseStatus },
  ) => void;
  // アイテム編集・削除
  onEditRequest?: (item: ShoppingItem) => void;
  onDeleteRequest?: (item: ShoppingItem) => void;
  // アプリ全体の表示倍率
  appZoomLevel?: number;
  resumeState?: FocusModeSessionState | null;
  onSessionStateChange?: (state: FocusModeSessionState) => void;
  mapRotationAngle?: number;
  mapInitialRotationAngle?: number;
  onMapRotationAngleChange?: (angle: number) => void;
  numberCellOutlineStyle?: NumberCellOutlineStyle;
  disablePriceUndefinedCheck?: boolean;
  disableLimitedPurchaseQuantityCheck?: boolean;
  skipLimitedPurchaseForSingleQuantity: boolean;
  purchaseStatusControlMode?: PurchaseStatusControlMode;
  postEventDistributionCheckEnabled?: boolean;
}
type PostEventDistributionCheckContext = {
  mode: PostEventDistributionCheckMode;
  targets: ShoppingItem[];
};
// スワイプ判定の閾値
const SWIPE_THRESHOLD = 50;
const FOOTER_HEIGHT_SP = 56;
const HEADER_HEIGHT = 64;
const FOOTER_HEIGHT_PC = 64;
const getVisitKey = (item: ShoppingItem): string => {
  const priority = item.priorityLevel || "none";
  return `${item.eventDate.trim()}-${buildSpaceKey(item.block, item.number)}-${priority}`;
};
const getMapVisitKey = (item: ShoppingItem): string => {
  return `${item.eventDate.trim()}-${buildSpaceKey(item.block, item.number)}`;
};
const getSpaceDisplayLabel = (item: ShoppingItem): string => {
  return `${normalizeSpaceBlock(item.block)}-${normalizeBaseSpaceNumber(item.number).toUpperCase()}`;
};

const FocusMode: React.FC<FocusModeProps> = ({
  items,
  executeModeItemIds,
  onUpdateItem,
  onModeChange,
  layoutMode,
  onLayoutModeChange,
  mapData,
  hallDefinitions,
  hallOrder = [],
  onMapVisibilityChange,
  onAddItem,
  onEditRequest,
  onDeleteRequest,
  appZoomLevel = 100,
  resumeState = null,
  onSessionStateChange,
  mapRotationAngle = 0,
  mapInitialRotationAngle = 0,
  onMapRotationAngleChange,
  numberCellOutlineStyle = "rounded",
  disablePriceUndefinedCheck = false,
  disableLimitedPurchaseQuantityCheck = false,
  skipLimitedPurchaseForSingleQuantity,
  purchaseStatusControlMode = "cycle",
  postEventDistributionCheckEnabled = true,
}) => {
  const spaceNavigator = useOptionalSpaceNavigator();
  const noopRotationHandler = useCallback(() => {}, []);
  const stableMapRotationHandler =
    onMapRotationAngleChange || noopRotationHandler;
  const {
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
  } = useFocusSessionState(resumeState);
  const clearAutoAdvanceTimer = useCallback(() => {}, []);
  const [blinkingLimitedMissingItemIds, setBlinkingLimitedMissingItemIds] =
    useState<Set<string>>(new Set());
  const [
    deferredLimitedItemIdsByVisitKey,
    setDeferredLimitedItemIdsByVisitKey,
  ] = useState<Map<string, Set<string>>>(() => new Map());
  const [limitedBulkDialogContext, setLimitedBulkDialogContext] =
    useState<LimitedBulkDialogContext | null>(null);
  const [bulkLimitedMessage, setBulkLimitedMessage] =
    useState<BulkLimitedMessageState | null>(null);
  const [
    postEventDistributionCheckContext,
    setPostEventDistributionCheckContext,
  ] = useState<PostEventDistributionCheckContext | null>(null);
  const activeLimitedBulkFlowTokenRef = useRef<symbol | null>(null);
  const limitedBulkNotificationOwnerRef =
    useRef<LimitedBulkNotificationOwner | null>(null);
  const [completionSubView, setCompletionSubView] = useState<
    "summary" | "limitedMissingList"
  >("summary");
  // ナビゲーションボタンの位置オフセット
  const [navButtonOffset, setNavButtonOffset] = useState({ left: 0, right: 0 });
  // アイテムリストのref
  const itemListRef = useRef<HTMLDivElement>(null);
  // スワイプ関連のref
  const touchStartXRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const isSwipingRef = useRef(false);
  // スワイプコンテナのref
  const swipeContainerRef = useRef<HTMLDivElement>(null);
  const [isMapVisible, setIsMapVisible] = useState(false);
  const [mapZoomLevel, setMapZoomLevel] = useState<number>(100);
  const mapViewportSnapshotRef = useRef<FocusMapViewportSnapshot | null>(null);
  const mapViewportRestoreRevisionRef = useRef(0);
  const [mapViewportRestoreRequest, setMapViewportRestoreRequest] =
    useState<FocusMapViewportRestoreRequest | null>(null);
  const handleMapViewportSnapshotChange = useCallback(
    (snapshot: FocusMapViewportSnapshot) => {
      mapViewportSnapshotRef.current = snapshot;
    },
    [],
  );
  const getMapViewportSnapshot = useCallback(
    () => mapViewportSnapshotRef.current ?? undefined,
    [],
  );
  const restoreMapViewportSnapshot = useCallback(
    (snapshot: FocusMapViewportSnapshot) => {
      setMapZoomLevel(snapshot.zoomLevel);
      stableMapRotationHandler(snapshot.rotationAngle);
      mapViewportRestoreRevisionRef.current += 1;
      setMapViewportRestoreRequest({
        snapshot,
        revision: mapViewportRestoreRevisionRef.current,
      });
    },
    [stableMapRotationHandler],
  );
  const handleMapViewportRestoreApplied = useCallback((revision: number) => {
    setMapViewportRestoreRequest((current) =>
      current?.revision === revision ? null : current,
    );
  }, []);
  const selectedHallId: string | "follow" = "follow";
  const [mapCenteringMode, setMapCenteringMode] =
    useState<FocusMapCenteringMode>("prevToCurrent");
  const [splitRatio, setSplitRatio] = useState(50);
  const splitDragRef = useRef<{ startY: number; startRatio: number } | null>(
    null,
  );
  const [measuredFooterHeight, setMeasuredFooterHeight] =
    useState<number>(FOOTER_HEIGHT_SP);
  const [cellPopupState, setCellPopupState] = useState<{
    isOpen: boolean;
    blockName: string;
    number: number;
    items: ShoppingItem[];
  }>({ isOpen: false, blockName: "", number: 0, items: [] });
  const [addItemDialog, setAddItemDialog] = useState<{
    isOpen: boolean;
    eventDate: string;
    block: string;
    number: string;
  }>({ isOpen: false, eventDate: "", block: "", number: "" });
  const [newItemForm, setNewItemForm] = useState({
    circle: "",
    title: "",
    price: "",
    quantity: "1",
    remarks: "",
    url: "",
    purchaseStatus: "Purchased" as "Purchased" | "Postpone" | "Late",
  });
  // マップが利用可能かどうか
  const hasMapData = useMemo(() => {
    return mapData && Object.keys(mapData).length > 0;
  }, [mapData]);
  const headerContainerClass = useMemo(
    () =>
      layoutMode === "smartphone"
        ? "px-2 py-1 mb-1 mx-2"
        : "px-4 py-1 mb-1 mx-16",
    [layoutMode],
  );
  const itemListContainerClass = useMemo(
    () =>
      `${layoutMode === "smartphone" ? "space-y-2" : "space-y-4"} pb-24 ${
        layoutMode === "smartphone" ? "mx-2" : "mx-16"
      }`,
    [layoutMode],
  );
  useEffect(() => {
    const fallbackHeight =
      layoutMode === "smartphone" ? FOOTER_HEIGHT_SP : FOOTER_HEIGHT_PC;
    setMeasuredFooterHeight(fallbackHeight);
  }, [layoutMode]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined")
      return;
    if (!isMapVisible || isCompleted) return;
    const footer = document.getElementById("focus-mode-footer");
    if (!footer) return;
    const updateHeight = () => {
      const nextHeight = footer.getBoundingClientRect().height;
      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
      setMeasuredFooterHeight((prev) =>
        Math.abs(prev - nextHeight) > 0.5 ? nextHeight : prev,
      );
    };
    updateHeight();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(() => updateHeight());
      resizeObserver.observe(footer);
    }
    window.addEventListener("resize", updateHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [layoutMode, isMapVisible, isCompleted]);
  const itemsById = useMemo(() => {
    return new Map(items.map((item) => [item.id, item]));
  }, [items]);

  const executeItems = useMemo(() => {
    const rawItems = executeModeItemIds
      .map((id) => itemsById.get(id))
      .filter((item): item is ShoppingItem => item !== undefined);
    // ホール定義 0 件でも sortItemsByHallOrder は未定義+優先度バケットで並べ替える
    const firstItem = rawItems[0];
    if (!firstItem) return rawItems;
    const dayMapData = mapData
      ? mapData[`${firstItem.eventDate}マップ`] || null
      : null;
    return sortItemsByHallOrder(
      rawItems,
      dayMapData,
      hallDefinitions || [],
      hallOrder,
    );
  }, [itemsById, executeModeItemIds, hallDefinitions, hallOrder, mapData]);
  const executeItemsById = useMemo(() => {
    return new Map(executeItems.map((item) => [item.id, item]));
  }, [executeItems]);
  const executeModeItemIdSet = useMemo(() => {
    return new Set(executeModeItemIds);
  }, [executeModeItemIds]);

  const executeItemsRoutingSignature = useMemo(() => {
    return buildItemRoutingSignature(items, executeModeItemIds);
  }, [items, executeModeItemIds]);

  const hallDefinitionsRoutingSignature = useMemo(() => {
    return buildHallDefinitionsRoutingSignature(hallDefinitions);
  }, [hallDefinitions]);

  const hallOrderRoutingSignature = useMemo(() => {
    return JSON.stringify(hallOrder);
  }, [hallOrder]);

  const routeDayMapData = useMemo(() => {
    const firstItem = executeModeItemIds
      .map((id) => itemsById.get(id))
      .find((item): item is ShoppingItem => item !== undefined);

    if (!firstItem || !mapData) return null;
    return mapData[`${firstItem.eventDate}マップ`] || null;
  }, [executeModeItemIds, itemsById, mapData]);

  const routeVisitLookupMapSignature = useMemo(() => {
    return buildDayMapVisitLookupSignature(routeDayMapData);
  }, [routeDayMapData]);

  const routePositionSignature = useMemo(() => {
    return JSON.stringify([
      executeItemsRoutingSignature,
      hallDefinitionsRoutingSignature,
      hallOrderRoutingSignature,
      routeVisitLookupMapSignature,
    ]);
  }, [
    executeItemsRoutingSignature,
    hallDefinitionsRoutingSignature,
    hallOrderRoutingSignature,
    routeVisitLookupMapSignature,
  ]);

  const routePositionItemsRef = useRef<{
    signature: string;
    items: ShoppingItem[];
  } | null>(null);

  const routePositionItems = useMemo(() => {
    if (routePositionItemsRef.current?.signature === routePositionSignature) {
      return routePositionItemsRef.current.items;
    }

    const rawItems = executeModeItemIds
      .map((id) => itemsById.get(id))
      .filter((item): item is ShoppingItem => item !== undefined);

    const firstItem = rawItems[0];
    const sortedItems = firstItem
      ? sortItemsByHallOrder(
          rawItems,
          mapData ? mapData[`${firstItem.eventDate}マップ`] || null : null,
          hallDefinitions || [],
          hallOrder,
        )
      : rawItems;

    routePositionItemsRef.current = {
      signature: routePositionSignature,
      items: sortedItems,
    };
    return sortedItems;
  }, [
    routePositionSignature,
    executeModeItemIds,
    itemsById,
    hallDefinitions,
    hallOrder,
    mapData,
  ]);
  // 全訪問先リストを実行列順序で生成
  const allVisits = useMemo(() => {
    const visitKeyOrder: string[] = [];
    const visitMap = new Map<string, ShoppingItem[]>();
    executeItems.forEach((item) => {
      const key = getVisitKey(item);
      if (!visitMap.has(key)) {
        visitMap.set(key, []);
        visitKeyOrder.push(key);
      }
      visitMap.get(key)!.push(item);
    });
    return visitKeyOrder.map((key) => ({
      key,
      items: visitMap.get(key)!,
    }));
  }, [executeItems]);
  const currentPostponedItemIds = useMemo(() => {
    return new Set(
      executeItems
        .filter((item) => item.purchaseStatus === "Postpone")
        .map((item) => item.id),
    );
  }, [executeItems]);
  const currentLateItemIds = useMemo(() => {
    return new Set(
      executeItems
        .filter((item) => item.purchaseStatus === "Late")
        .map((item) => item.id),
    );
  }, [executeItems]);
  const visitsByPhase = useMemo(() => {
    const normal: typeof allVisits = [];
    const postponed: typeof allVisits = [];
    const late: typeof allVisits = [];
    allVisits.forEach((visit) => {
      // 通常フェーズ: 全ての訪問先を含む
      normal.push(visit);
      // 後回しフェーズ: 記憶されたアイテムIDがある訪問先
      if (currentPhase === "normal") {
        const hasPostponedItems = visit.items.some((item) =>
          currentPostponedItemIds.has(item.id),
        );
        if (hasPostponedItems) postponed.push(visit);
      } else {
        const hasPostponedItems = visit.items.some((item) =>
          postponedPhaseItemIds.has(item.id),
        );
        if (hasPostponedItems) postponed.push(visit);
      }
      // 遅参フェーズ: 記憶されたアイテムIDがある訪問先
      if (currentPhase === "normal" || currentPhase === "postponed") {
        const hasLateItems = visit.items.some((item) =>
          currentLateItemIds.has(item.id),
        );
        if (hasLateItems) late.push(visit);
      } else {
        const hasLateItems = visit.items.some((item) =>
          latePhaseItemIds.has(item.id),
        );
        if (hasLateItems) late.push(visit);
      }
    });
    return { normal, postponed, late };
  }, [
    allVisits,
    currentPhase,
    currentPostponedItemIds,
    currentLateItemIds,
    postponedPhaseItemIds,
    latePhaseItemIds,
  ]);
  const formalPhaseVisits = useMemo(
    () => visitsByPhase[currentPhase],
    [visitsByPhase, currentPhase],
  );
  const formalCurrentVisit = useMemo(() => {
    if (formalPhaseVisits.length === 0) return null;
    const safeIndex = Math.min(currentPhaseIndex, formalPhaseVisits.length - 1);
    return formalPhaseVisits[safeIndex] || null;
  }, [formalPhaseVisits, currentPhaseIndex]);
  const formalCurrentVisitDisplayItems = useMemo(() => {
    if (!formalCurrentVisit) return [];
    if (currentPhase === "normal") return formalCurrentVisit.items;
    const phaseIds =
      currentPhase === "postponed" ? postponedPhaseItemIds : latePhaseItemIds;
    return formalCurrentVisit.items.filter((item) => phaseIds.has(item.id));
  }, [
    currentPhase,
    formalCurrentVisit,
    latePhaseItemIds,
    postponedPhaseItemIds,
  ]);

  const effectivePostponedItemIds =
    currentPhase === "normal" ? currentPostponedItemIds : postponedPhaseItemIds;
  const effectiveLateItemIds =
    currentPhase === "late" ? latePhaseItemIds : currentLateItemIds;
  const navigatorSourcesByPhase = useMemo(
    () => ({
      normal: visitsByPhase.normal.map(
        (visit): NavigatorSourceVisit => ({ ...visit, items: visit.items }),
      ),
      postponed: visitsByPhase.postponed
        .map(
          (visit): NavigatorSourceVisit => ({
            ...visit,
            items: visit.items.filter((item) =>
              effectivePostponedItemIds.has(item.id),
            ),
          }),
        )
        .filter((visit) => visit.items.length > 0),
      late: visitsByPhase.late
        .map(
          (visit): NavigatorSourceVisit => ({
            ...visit,
            items: visit.items.filter((item) =>
              effectiveLateItemIds.has(item.id),
            ),
          }),
        )
        .filter((visit) => visit.items.length > 0),
    }),
    [
      effectiveLateItemIds,
      effectivePostponedItemIds,
      visitsByPhase.late,
      visitsByPhase.normal,
      visitsByPhase.postponed,
    ],
  );

  const {
    resumeChoiceDialog,
    setResumeChoiceDialog,
    isResumeTransitioning,
    isResumeInitResolved,
  } = useResumeFlow({
    resumeState,
    currentPhase,
    visitsByPhase,
    currentPostponedItemIds,
    currentLateItemIds,
    clearAutoAdvanceTimer,
    setPostponedPhaseItemIds,
    setLatePhaseItemIds,
  });
  const closeNavigatorEditableSurfaces = useCallback(() => {
    clearAutoAdvanceTimer();
    activeLimitedBulkFlowTokenRef.current = null;
    setBulkLimitedMessage(null);
    setPhaseChangeDialog({
      isOpen: false,
      targetPhase: null,
      hasSavedIndex: false,
      savedIndex: 0,
    });
    setCellPopupState((previous) =>
      previous.isOpen ? { ...previous, isOpen: false } : previous,
    );
    setAddItemDialog((previous) =>
      previous.isOpen ? { ...previous, isOpen: false } : previous,
    );
    setLimitedBulkDialogContext(null);
    setPostEventDistributionCheckContext(null);
  }, [clearAutoAdvanceTimer, setPhaseChangeDialog]);

  const commitNavigatorOfficialPosition = useCallback(
    (entry: NavigatorEntry) => {
      const targetPhase = entry.phase ?? "normal";
      setSavedPhaseIndices((previous) => ({
        ...previous,
        [currentPhase]: currentPhaseIndex,
      }));
      if (
        currentPhase === "normal" &&
        (targetPhase === "postponed" || targetPhase === "late")
      ) {
        setPostponedPhaseItemIds(new Set(currentPostponedItemIds));
        setLatePhaseItemIds(new Set(currentLateItemIds));
      } else if (currentPhase === "postponed" && targetPhase === "late") {
        const mergedLateIds = new Set(latePhaseItemIds);
        currentLateItemIds.forEach((itemId) => mergedLateIds.add(itemId));
        setLatePhaseItemIds(mergedLateIds);
      }
      setCurrentPhase(targetPhase);
      setCurrentPhaseIndex(entry.phaseIndex);
      setIsCompleted(false);
      setIsNextButtonBlinking(false);
      clearAutoAdvanceTimer();
    },
    [
      clearAutoAdvanceTimer,
      currentLateItemIds,
      currentPhase,
      currentPhaseIndex,
      currentPostponedItemIds,
      latePhaseItemIds,
    ],
  );
  const handleNavigatorGuardResult = useCallback(
    (result: NavigationGuardResult) => {
      setBlinkingPriceItemIds(new Set(result.priceWarningItemIds));
      setBlinkingLimitedMissingItemIds(
        result.blockingReasons.includes("limited")
          ? new Set(result.limitedWarningItemIds)
          : new Set(),
      );
    },
    [],
  );
  const getNavigatorDeferredLimitedItemIds = useCallback(
    (entry: NavigatorEntry) => {
      const deferredIds = new Set<string>();
      entry.items.forEach((item) => {
        const itemDeferredIds = deferredLimitedItemIdsByVisitKey.get(
          getVisitKey(item as ShoppingItem),
        );
        itemDeferredIds?.forEach((itemId) => deferredIds.add(itemId));
      });
      return deferredIds.size > 0 ? deferredIds : undefined;
    },
    [deferredLimitedItemIdsByVisitKey],
  );
  const focusNavigatorRegistrationId = useMemo(
    () => `focus:${executeItems[0]?.eventDate ?? "empty"}`,
    [executeItems],
  );
  const {
    entries: navigatorEntries,
    baseEntries: baseNavigatorEntries,
    currentIndex: displayNavigatorIndex,
    formalRouteIndex,
    displayEntry,
    displayPhase,
    displayPhaseIndex,
    displayItemIds,
    isTemporaryActive,
    isInspecting,
    interactionActive: isNavigatorInteractionActive,
    pickerOpen: isNavigatorPickerOpen,
    recenterRevision,
    moveTemporaryBy,
    isSpaceAggregate,
    aggregateSpaceKey,
    movementBasisPhase,
    temporarySubview,
    movementPhaseSelectionOpen,
    movementDirection,
    initialPhaseCandidates,
    aggregatePhasePresence,
    selectMovementPhase,
    cancelMovementPhaseSelection,
    remainingSpaceLists,
    selectRemainingSpace,
    showTemporaryEnd,
    showRemainingSpaces,
    closeRemainingSpaces,
    promotionPhaseChoiceOpen,
    promotionPhasePresence,
    cancelPromotionPhaseSelection,
    confirmPromotionPhase,
  } = useFocusSpaceNavigator({
    registrationId: focusNavigatorRegistrationId,
    enabled:
      allVisits.length > 0 &&
      !isCompleted &&
      isResumeInitResolved &&
      !resumeChoiceDialog?.isOpen,
    layoutMode,
    sourcesByPhase: navigatorSourcesByPhase,
    officialPhase: currentPhase,
    officialPhaseIndex: currentPhaseIndex,
    latestItemsById: executeItemsById,
    disablePriceUndefinedCheck,
    disableLimitedPurchaseQuantityCheck,
    getDeferredLimitedItemIds: getNavigatorDeferredLimitedItemIds,
    onCommitOfficial: commitNavigatorOfficialPosition,
    onGuardResult: handleNavigatorGuardResult,
    onInteractionStart: closeNavigatorEditableSurfaces,
    getMapViewportSnapshot,
    restoreMapViewportSnapshot,
  });
  const activeNavigatorRailSide =
    spaceNavigator?.settings.railVisible &&
    spaceNavigator.registration?.id === focusNavigatorRegistrationId
      ? spaceNavigator.settings.side
      : null;
  const safeAppScale = Math.max(0.01, appZoomLevel / 100);
  const railClearance = activeNavigatorRailSide
    ? SPACE_NAVIGATOR_RAIL_WIDTH_PX / safeAppScale
    : 0;
  // FocusMode lives inside the app-level scale transform, while the rail is a
  // body portal. Convert its physical hit width back to FocusMode units.
  const navPrevStyle = useMemo(
    () => ({
      left: `${16 + navButtonOffset.left + (activeNavigatorRailSide === "left" ? railClearance : 0)}px`,
      transition: "left 0.2s ease-out",
    }),
    [activeNavigatorRailSide, navButtonOffset.left, railClearance],
  );
  const navNextStyle = useMemo(
    () => ({
      right: `${16 + navButtonOffset.right + (activeNavigatorRailSide === "right" ? railClearance : 0)}px`,
      transition: "right 0.2s ease-out",
    }),
    [activeNavigatorRailSide, navButtonOffset.right, railClearance],
  );
  const splitMapNextStyle = useMemo(
    () => ({
      right: `${16 + (activeNavigatorRailSide === "right" ? railClearance : 0)}px`,
      transition: "right 0.2s ease-out",
    }),
    [activeNavigatorRailSide, railClearance],
  );
  const completionPrevStyle = useMemo(
    () => ({
      left: `${16 + (activeNavigatorRailSide === "left" ? railClearance : 0)}px`,
      transition: "left 0.2s ease-out",
    }),
    [activeNavigatorRailSide, railClearance],
  );
  useEffect(() => {
    if (!isInspecting) return;
    closeNavigatorEditableSurfaces();
  }, [closeNavigatorEditableSurfaces, isInspecting]);

  const resolveNavigatorEntryVisit = useCallback(
    (entry: NavigatorEntry | undefined) => {
      if (!entry) return null;
      const firstItem = entry.itemIds
        .map((itemId) => itemsById.get(itemId))
        .find((item): item is ShoppingItem => item !== undefined);
      if (!firstItem) return null;
      const visitKey = getVisitKey(firstItem);
      if (entry.id.startsWith("space-aggregate:")) {
        return {
          key: visitKey,
          items: entry.itemIds
            .map((itemId) => itemsById.get(itemId))
            .filter((item): item is ShoppingItem => item !== undefined),
        };
      }
      return (
        allVisits.find((visit) => visit.key === visitKey) ?? {
          key: visitKey,
          items: entry.itemIds
            .map((itemId) => itemsById.get(itemId))
            .filter((item): item is ShoppingItem => item !== undefined),
        }
      );
    },
    [allVisits, itemsById],
  );
  const currentVisit = useMemo(
    () => resolveNavigatorEntryVisit(displayEntry ?? undefined),
    [displayEntry, resolveNavigatorEntryVisit],
  );
  const nextVisit = useMemo(
    () =>
      resolveNavigatorEntryVisit(navigatorEntries[displayNavigatorIndex + 1]),
    [displayNavigatorIndex, navigatorEntries, resolveNavigatorEntryVisit],
  );
  const prevVisit = useMemo(
    () =>
      resolveNavigatorEntryVisit(navigatorEntries[displayNavigatorIndex - 1]),
    [displayNavigatorIndex, navigatorEntries, resolveNavigatorEntryVisit],
  );
  const currentVisitDisplayItems = useMemo(
    () =>
      displayItemIds
        .map((itemId) => itemsById.get(itemId))
        .filter((item): item is ShoppingItem => item !== undefined),
    [displayItemIds, itemsById],
  );
  const formalPhaseEntriesLength = useMemo(
    () =>
      baseNavigatorEntries.filter((entry) => entry.phase === currentPhase)
        .length,
    [baseNavigatorEntries, currentPhase],
  );
  const nextAllVisitKeys = useMemo(
    () =>
      baseNavigatorEntries
        .map((entry) => {
          const firstItem = entry.itemIds
            .map((itemId) => itemsById.get(itemId))
            .find((item): item is ShoppingItem => item !== undefined);
          return firstItem ? getVisitKey(firstItem) : null;
        })
        .filter((visitKey): visitKey is string => visitKey !== null),
    [baseNavigatorEntries, itemsById],
  );
  const allVisitKeysSignature = useMemo(
    () => JSON.stringify(nextAllVisitKeys),
    [nextAllVisitKeys],
  );
  const allVisitKeysRef = useRef<{ signature: string; keys: string[] } | null>(
    null,
  );
  const allVisitKeys = useMemo(() => {
    if (allVisitKeysRef.current?.signature === allVisitKeysSignature) {
      return allVisitKeysRef.current.keys;
    }
    allVisitKeysRef.current = {
      signature: allVisitKeysSignature,
      keys: nextAllVisitKeys,
    };
    return nextAllVisitKeys;
  }, [allVisitKeysSignature, nextAllVisitKeys]);
  const currentVisitUndefinedPriceItems = useMemo(
    () =>
      currentVisitDisplayItems.filter(
        (item) => isPriceRequiredStatus(item) && isUndefinedPrice(item.price),
      ),
    [currentVisitDisplayItems],
  );
  const currentVisitUndefinedPriceItemIds = useMemo(
    () => new Set(currentVisitUndefinedPriceItems.map((item) => item.id)),
    [currentVisitUndefinedPriceItems],
  );
  const blockedByPrice = useMemo(
    () =>
      !disablePriceUndefinedCheck && currentVisitUndefinedPriceItems.length > 0,
    [disablePriceUndefinedCheck, currentVisitUndefinedPriceItems],
  );
  const currentVisitLimitedMissingItems = useMemo(
    () => currentVisitDisplayItems.filter(hasMissingLimitedPurchaseQuantity),
    [currentVisitDisplayItems],
  );
  const isCurrentVisitLimitedCheckDeferred = useMemo(() => {
    if (currentVisitLimitedMissingItems.length === 0) return false;
    return currentVisitLimitedMissingItems.every((item) =>
      deferredLimitedItemIdsByVisitKey.get(getVisitKey(item))?.has(item.id),
    );
  }, [currentVisitLimitedMissingItems, deferredLimitedItemIdsByVisitKey]);
  const isLimitedPurchaseQuantityCheckDisabledForCurrentVisit =
    disableLimitedPurchaseQuantityCheck || isCurrentVisitLimitedCheckDeferred;
  const blockedByLimited = useMemo(
    () =>
      !isLimitedPurchaseQuantityCheckDisabledForCurrentVisit &&
      currentVisitLimitedMissingItems.length > 0,
    [
      isLimitedPurchaseQuantityCheckDisabledForCurrentVisit,
      currentVisitLimitedMissingItems,
    ],
  );
  const nextButtonBlockTone =
    blockedByPrice && blockedByLimited
      ? "both"
      : blockedByPrice
        ? "price"
        : blockedByLimited
          ? "limited"
          : "none";
  // フェーズ名の日本語表示
  const phaseDisplayName = useMemo(() => {
    switch (currentPhase) {
      case "normal":
        return "通常";
      case "postponed":
        return "後回し";
      case "late":
        return "遅参";
    }
  }, [currentPhase]);
  const totalVisits = baseNavigatorEntries.length;
  const currentVisitNumber = formalRouteIndex + 1;
  const remainingCost = useMemo(() => {
    return executeItems.reduce((sum, item) => {
      const isPurchasable =
        item.purchaseStatus === "None" ||
        item.purchaseStatus === "Postpone" ||
        item.purchaseStatus === "Late";
      if (!isPurchasable) return sum;
      const price = getSafePriceForCalculation(item.price);
      return sum + price * getPlannedBudgetQuantity(item);
    }, 0);
  }, [executeItems]);
  // 購入済み件数
  const purchasedCount = useMemo(() => {
    return executeItems.filter(isCountedAsPurchased).length;
  }, [executeItems]);
  const currentVisitCheckedCount = useMemo(() => {
    return currentVisitDisplayItems.filter(
      (item) => item.purchaseStatus !== "None",
    ).length;
  }, [currentVisitDisplayItems]);
  // 現在の訪問先のアイテム総数
  const currentVisitTotalCount = useMemo(() => {
    return currentVisitDisplayItems.length;
  }, [currentVisitDisplayItems]);
  // 現在の訪問先のアイテム総額情報
  const currentVisitPriceInfo = useMemo(() => {
    let chargeableTotal = 0;
    let plannedTotal = 0;
    currentVisitDisplayItems.forEach((item) => {
      if (currentVisitUndefinedPriceItemIds.has(item.id)) return;
      const price = getSafePriceForCalculation(item.price);
      chargeableTotal += price * getChargeableQuantity(item);
      plannedTotal += price * getPlannedBudgetQuantity(item);
    });
    return {
      chargeableTotal,
      plannedTotal,
      priceMissingItemCount: currentVisitUndefinedPriceItems.length,
    };
  }, [
    currentVisitDisplayItems,
    currentVisitUndefinedPriceItemIds,
    currentVisitUndefinedPriceItems,
  ]);
  const markLimitedPurchaseQuantityDeferred = useCallback(
    (visitKey: string, itemId: string) => {
      setDeferredLimitedItemIdsByVisitKey((previous) => {
        const next = new Map(previous);
        const itemIds = new Set(next.get(visitKey) ?? []);
        itemIds.add(itemId);
        next.set(visitKey, itemIds);
        return next;
      });
    },
    [],
  );
  const clearLimitedPurchaseQuantityDeferredForItem = useCallback(
    (itemId: string) => {
      setDeferredLimitedItemIdsByVisitKey((previous) => {
        let mutated = false;
        const next = new Map<string, Set<string>>();
        previous.forEach((itemIds, visitKey) => {
          if (!itemIds.has(itemId)) {
            next.set(visitKey, itemIds);
            return;
          }
          mutated = true;
          const updated = new Set(itemIds);
          updated.delete(itemId);
          if (updated.size > 0) {
            next.set(visitKey, updated);
          }
        });
        return mutated ? next : previous;
      });
    },
    [],
  );
  const handleLimitedPurchaseDefer = useCallback(
    (item: ShoppingItem) => {
      if (isInspecting) return;
      markLimitedPurchaseQuantityDeferred(getVisitKey(item), item.id);
    },
    [isInspecting, markLimitedPurchaseQuantityDeferred],
  );
  const updateItemWithDeferredCleanup = useCallback(
    (updatedItem: ShoppingItem) => {
      if (isInspecting) {
        setNotification("内容確認中は編集できません");
        return;
      }
      const shouldClearDefer =
        updatedItem.purchaseStatus !== "LimitedPurchase" ||
        !hasMissingLimitedPurchaseQuantity(updatedItem);
      if (shouldClearDefer) {
        clearLimitedPurchaseQuantityDeferredForItem(updatedItem.id);
      }
      onUpdateItem(updatedItem);
    },
    [
      clearLimitedPurchaseQuantityDeferredForItem,
      isInspecting,
      onUpdateItem,
      setNotification,
    ],
  );
  const openPostEventDistributionCheck = useCallback(
    (mode: PostEventDistributionCheckMode, targets: ShoppingItem[]) => {
      if (
        isInspecting ||
        !postEventDistributionCheckEnabled ||
        targets.length === 0
      ) {
        return;
      }
      clearAutoAdvanceTimer();
      setPostEventDistributionCheckContext({ mode, targets });
    },
    [clearAutoAdvanceTimer, isInspecting, postEventDistributionCheckEnabled],
  );
  const handlePostEventDistributionCheckApply = useCallback(
    (answers: { itemId: string; answer: PostEventDistributionAnswer }[]) => {
      if (isInspecting) {
        setPostEventDistributionCheckContext(null);
        setNotification("内容確認中は事後通販・頒布可否を記録できません");
        return;
      }
      answers.forEach(({ itemId, answer }) => {
        const latestItem = items.find((item) => item.id === itemId);
        if (!latestItem) return;
        updateItemWithDeferredCleanup({
          ...latestItem,
          remarks: upsertPostEventDistributionRemark(
            latestItem.remarks,
            answer,
          ),
        });
      });
      setPostEventDistributionCheckContext(null);
    },
    [isInspecting, items, setNotification, updateItemWithDeferredCleanup],
  );
  const handlePostEventDistributionCheckCancel = useCallback(() => {
    setPostEventDistributionCheckContext(null);
  }, []);
  useEffect(() => {
    setDeferredLimitedItemIdsByVisitKey((previous) => {
      if (previous.size === 0) return previous;

      let mutated = false;
      const next = new Map<string, Set<string>>();
      previous.forEach((itemIds, visitKey) => {
        const retainedIds = new Set<string>();
        itemIds.forEach((itemId) => {
          const latest = itemsById.get(itemId);
          const isInExecuteScope =
            executeModeItemIdSet.has(itemId) || executeItemsById.has(itemId);
          if (
            latest &&
            isInExecuteScope &&
            latest.purchaseStatus === "LimitedPurchase" &&
            hasMissingLimitedPurchaseQuantity(latest) &&
            getVisitKey(latest) === visitKey
          ) {
            retainedIds.add(itemId);
          } else {
            mutated = true;
          }
        });
        if (retainedIds.size > 0) {
          next.set(visitKey, retainedIds);
        } else if (itemIds.size > 0) {
          mutated = true;
        }
      });

      return mutated ? next : previous;
    });
  }, [executeItemsById, executeModeItemIdSet, itemsById]);
  // 次の訪問先情報
  const nextVisitInfo = useMemo(() => {
    if (!nextVisit) return { spaceInfo: "最終", circleName: "" };
    const item = nextVisit.items[0];
    if (!item) return { spaceInfo: "最終", circleName: "" };
    return {
      spaceInfo: getSpaceDisplayLabel(item),
      circleName: item.circle || "",
    };
  }, [nextVisit]);
  // 現在のマップ名
  const currentMapName = useMemo(() => {
    if (!currentVisit || currentVisit.items.length === 0) return null;
    const eventDate = currentVisit.items[0].eventDate;
    return `${eventDate}マップ`;
  }, [currentVisit]);
  // 現在のマップデータ
  const currentMapData = useMemo(() => {
    if (!currentMapName || !mapData) return null;
    return mapData[currentMapName] || null;
  }, [currentMapName, mapData]);

  const currentVisitLookupMapSignature = useMemo(() => {
    return JSON.stringify([
      currentMapName || "",
      buildDayMapVisitLookupSignature(currentMapData),
    ]);
  }, [currentMapName, currentMapData]);

  const currentVisitLookupMapDataRef = useRef<{
    signature: string;
    mapData: DayMapData | null;
  } | null>(null);

  const currentVisitLookupMapData = useMemo(() => {
    if (!currentMapName || !currentMapData) return null;

    if (
      currentVisitLookupMapDataRef.current?.signature ===
      currentVisitLookupMapSignature
    ) {
      return currentVisitLookupMapDataRef.current.mapData;
    }

    currentVisitLookupMapDataRef.current = {
      signature: currentVisitLookupMapSignature,
      mapData: currentMapData,
    };

    return currentMapData;
  }, [currentMapData, currentMapName, currentVisitLookupMapSignature]);

  const currentRouteMapDataSignature = useMemo(() => {
    return JSON.stringify([
      currentMapName || "",
      buildDayMapPathfindingSignature(currentMapData),
    ]);
  }, [currentMapName, currentMapData]);

  const currentRouteMapDataRef = useRef<{
    signature: string;
    mapData: DayMapData | null;
  } | null>(null);

  const currentRouteMapData = useMemo(() => {
    if (!currentMapName || !currentMapData) return null;

    if (
      currentRouteMapDataRef.current?.signature === currentRouteMapDataSignature
    ) {
      return currentRouteMapDataRef.current.mapData;
    }

    currentRouteMapDataRef.current = {
      signature: currentRouteMapDataSignature,
      mapData: currentMapData,
    };

    return currentMapData;
  }, [currentMapData, currentMapName, currentRouteMapDataSignature]);

  // マップ用のdayName（マップ名からサフィックスを除去）
  const mapDayName = useMemo(() => {
    if (!currentMapName) return "";
    const dayMatch = currentMapName.match(/^(.+)マップ$/);
    return dayMatch ? dayMatch[1].trim() : "";
  }, [currentMapName]);
  const visitKeyCellMap = useMemo(() => {
    const map = new Map<string, { row: number; col: number; key: string }>();
    if (!mapDayName || !currentVisitLookupMapData) return map;
    routePositionItems.forEach((item) => {
      const itemEventDate = item.eventDate?.trim() || "";
      if (itemEventDate !== mapDayName) return;
      const itemBlockName = normalizeSpaceBlock(item.block || "");
      let block = currentVisitLookupMapData.blocks.find(
        (candidate) => normalizeSpaceBlock(candidate.name) === itemBlockName,
      );
      if (!block) {
        const candidates = currentVisitLookupMapData.blocks.filter(
          (candidate) =>
            normalizeSpaceBlock(candidate.name).toLowerCase() ===
            itemBlockName.toLowerCase(),
        );
        if (candidates.length === 1) block = candidates[0];
      }
      if (!block) return;
      const numStr = extractNumberFromItemNumber(
        normalizeBaseSpaceNumber(item.number),
      );
      if (!numStr) return;
      const num = parseInt(numStr, 10);
      const cell = findRouteLookupNumberCell(block, num);
      if (!cell) return;
      const visitKey = getVisitKey(item);
      if (!map.has(visitKey)) {
        map.set(visitKey, {
          row: cell.row,
          col: cell.col,
          key: `${cell.row}-${cell.col}`,
        });
      }
    });
    return map;
  }, [routePositionItems, currentVisitLookupMapData, mapDayName]);
  const routeCoordsSignature = useMemo(() => {
    return JSON.stringify(
      allVisitKeys.map((visitKey) => {
        const coord = visitKeyCellMap.get(visitKey);
        return coord
          ? [visitKey, coord.row, coord.col, coord.key]
          : [visitKey, "missing"];
      }),
    );
  }, [allVisitKeys, visitKeyCellMap]);

  const precomputedAllVisitCellCoordsRef = useRef<{
    signature: string;
    coords: { row: number; col: number; key: string }[];
  } | null>(null);

  const precomputedAllVisitCellCoords = useMemo(() => {
    if (
      precomputedAllVisitCellCoordsRef.current?.signature ===
      routeCoordsSignature
    ) {
      return precomputedAllVisitCellCoordsRef.current.coords;
    }

    const coords: { row: number; col: number; key: string }[] = [];
    for (const visitKey of allVisitKeys) {
      const coord = visitKeyCellMap.get(visitKey);
      if (coord) {
        coords.push(coord);
      }
    }

    precomputedAllVisitCellCoordsRef.current = {
      signature: routeCoordsSignature,
      coords,
    };

    return coords;
  }, [allVisitKeys, visitKeyCellMap, routeCoordsSignature]);
  const routeSegmentsSignature = useMemo(
    () => JSON.stringify([currentRouteMapDataSignature, routeCoordsSignature]),
    [currentRouteMapDataSignature, routeCoordsSignature],
  );
  const precomputedRouteCalculationRef = useRef<{
    signature: string;
    result: FocusRouteCalculation;
  } | null>(null);
  const precomputedRouteCalculation = useMemo(() => {
    if (
      precomputedRouteCalculationRef.current?.signature ===
      routeSegmentsSignature
    ) {
      return precomputedRouteCalculationRef.current.result;
    }
    const result = calculateStrictFocusRoute(
      currentRouteMapData,
      allVisitKeys,
      visitKeyCellMap,
    );
    precomputedRouteCalculationRef.current = {
      signature: routeSegmentsSignature,
      result,
    };
    return result;
  }, [
    allVisitKeys,
    currentRouteMapData,
    routeSegmentsSignature,
    visitKeyCellMap,
  ]);
  const precomputedRouteSegments = precomputedRouteCalculation.segments;
  const missingRouteVisitKeys = useMemo(
    () => new Set(precomputedRouteCalculation.missingVisitKeys),
    [precomputedRouteCalculation.missingVisitKeys],
  );
  const missingRouteItemIds = useMemo(
    () =>
      routePositionItems
        .filter((item) => missingRouteVisitKeys.has(getVisitKey(item)))
        .map((item) => item.id),
    [missingRouteVisitKeys, routePositionItems],
  );
  const routeDiagnostics = useMemo(
    () =>
      buildRouteDiagnostics({
        missingItemIds: missingRouteItemIds,
        items: routePositionItems,
        validLocationCount: precomputedRouteCalculation.validLocationCount,
        routeUnreachable: precomputedRouteCalculation.unreachable,
      }),
    [missingRouteItemIds, precomputedRouteCalculation, routePositionItems],
  );
  const followHall = useMemo(() => {
    if (
      !hallDefinitions ||
      hallDefinitions.length === 0 ||
      !currentVisit ||
      !currentMapData
    )
      return null;
    const currentItem = currentVisit.items[0];
    if (!currentItem) return null;
    const block = currentMapData.blocks.find(
      (b) => b.name === currentItem.block,
    );
    if (!block) return null;
    const numStr = currentItem.number.match(/^(\d+)/)?.[1];
    if (!numStr) return null;
    const num = parseInt(numStr, 10);
    const cell = findRouteLookupNumberCell(block, num);
    if (!cell) return null;
    for (const hall of hallDefinitions) {
      if (hall.vertices.length < 3) continue;
      let inside = false;
      const vertices = hall.vertices;
      for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i].col,
          yi = vertices[i].row;
        const xj = vertices[j].col,
          yj = vertices[j].row;
        if (
          yi > cell.row !== yj > cell.row &&
          cell.col < ((xj - xi) * (cell.row - yi)) / (yj - yi) + xi
        ) {
          inside = !inside;
        }
      }
      if (inside) return hall;
    }
    return null;
  }, [hallDefinitions, currentVisit, currentMapData]);
  // 選択されたホール
  const selectedHall = useMemo(() => {
    if (selectedHallId === "follow") {
      return followHall;
    }
    return hallDefinitions?.find((h) => h.id === selectedHallId) || null;
  }, [selectedHallId, followHall, hallDefinitions]);
  useEffect(() => {
    setSavedPhaseIndices((prev) => ({
      ...prev,
      [currentPhase]: currentPhaseIndex,
    }));
  }, [currentPhase, currentPhaseIndex]);
  useEffect(() => {
    if (!onSessionStateChange) return;
    if (isResumeTransitioning) return;
    if (!isResumeInitResolved) return;
    if (resumeChoiceDialog?.isOpen) return;
    onSessionStateChange({
      phase: currentPhase,
      phaseIndex: currentPhaseIndex,
      savedPhaseIndices: {
        normal: savedPhaseIndices.normal,
        postponed: savedPhaseIndices.postponed,
        late: savedPhaseIndices.late,
      },
      postponedItemIds: Array.from(postponedPhaseItemIds),
      lateItemIds: Array.from(latePhaseItemIds),
      lastPurchaseChangeAt,
      isCompleted,
    });
  }, [
    onSessionStateChange,
    isResumeTransitioning,
    isResumeInitResolved,
    resumeChoiceDialog?.isOpen,
    currentPhase,
    currentPhaseIndex,
    savedPhaseIndices.normal,
    savedPhaseIndices.postponed,
    savedPhaseIndices.late,
    postponedPhaseItemIds,
    latePhaseItemIds,
    lastPurchaseChangeAt,
    isCompleted,
  ]);
  const handlePhaseChangeRequest = useCallback(
    (targetPhase: FocusPhase) => {
      if (isTemporaryActive) {
        setNotification(
          isInspecting
            ? "内容確認中はフェーズを変更できません"
            : "一時移動中は前後ボタンまたはスペースナビを使用してください",
        );
        return;
      }
      if (targetPhase === currentPhase) return;
      const targetVisits = visitsByPhase[targetPhase];
      if (targetVisits.length === 0) {
        setNotification(
          `${targetPhase === "normal" ? "通常" : targetPhase === "postponed" ? "後回し" : "遅参"}フェーズに該当するアイテムがありません`,
        );
        return;
      }
      // 保存されたインデックスがあるかチェック
      const savedIndex = savedPhaseIndices[targetPhase];
      const hasSavedIndex = savedIndex > 0 && savedIndex < targetVisits.length;
      setPhaseChangeDialog({
        isOpen: true,
        targetPhase,
        hasSavedIndex,
        savedIndex: hasSavedIndex ? savedIndex : 0,
      });
    },
    [
      currentPhase,
      isInspecting,
      isTemporaryActive,
      savedPhaseIndices,
      visitsByPhase,
    ],
  );
  const executePhaseChangeFromStart = useCallback(() => {
    if (isInspecting) {
      setPhaseChangeDialog({
        isOpen: false,
        targetPhase: null,
        hasSavedIndex: false,
        savedIndex: 0,
      });
      setNotification("内容確認中はフェーズを変更できません");
      return;
    }
    const { targetPhase } = phaseChangeDialog;
    if (!targetPhase) return;
    setSavedPhaseIndices((prev) => ({
      ...prev,
      [currentPhase]: currentPhaseIndex,
    }));
    // フェーズ切り替え前に必要なデータを準備
    if (
      currentPhase === "normal" &&
      (targetPhase === "postponed" || targetPhase === "late")
    ) {
      // 通常フェーズから後回し・遅参へ: 現在の後回し・遅参アイテムを記憶
      const postponedIds = new Set(
        executeItems
          .filter((item) => item.purchaseStatus === "Postpone")
          .map((item) => item.id),
      );
      setPostponedPhaseItemIds(postponedIds);
      const lateIds = new Set(
        executeItems
          .filter((item) => item.purchaseStatus === "Late")
          .map((item) => item.id),
      );
      setLatePhaseItemIds(lateIds);
    } else if (currentPhase === "postponed" && targetPhase === "late") {
      // 後回しフェーズから遅参へ：遅参アイテムを更新
      const currentLateIds = new Set(latePhaseItemIds);
      executeItems.forEach((item) => {
        if (item.purchaseStatus === "Late") {
          currentLateIds.add(item.id);
        }
      });
      setLatePhaseItemIds(currentLateIds);
    }
    setCurrentPhase(targetPhase);
    setCurrentPhaseIndex(0);
    setIsNextButtonBlinking(false);
    setIsCompleted(false);
    clearAutoAdvanceTimer();
    const phaseName =
      targetPhase === "normal"
        ? "通常"
        : targetPhase === "postponed"
          ? "後回し"
          : "遅参";
    setNotification(`${phaseName}フェーズを最初から開始します`);
    setPhaseChangeDialog({
      isOpen: false,
      targetPhase: null,
      hasSavedIndex: false,
      savedIndex: 0,
    });
  }, [
    phaseChangeDialog,
    currentPhase,
    currentPhaseIndex,
    executeItems,
    isInspecting,
    latePhaseItemIds,
    clearAutoAdvanceTimer,
  ]);
  const executePhaseChangeFromSaved = useCallback(() => {
    if (isInspecting) {
      setPhaseChangeDialog({
        isOpen: false,
        targetPhase: null,
        hasSavedIndex: false,
        savedIndex: 0,
      });
      setNotification("内容確認中はフェーズを変更できません");
      return;
    }
    const { targetPhase, savedIndex } = phaseChangeDialog;
    if (!targetPhase) return;
    setSavedPhaseIndices((prev) => ({
      ...prev,
      [currentPhase]: currentPhaseIndex,
    }));
    // フェーズ切り替え前に必要なデータを準備
    if (
      currentPhase === "normal" &&
      (targetPhase === "postponed" || targetPhase === "late")
    ) {
      const postponedIds = new Set(
        executeItems
          .filter((item) => item.purchaseStatus === "Postpone")
          .map((item) => item.id),
      );
      setPostponedPhaseItemIds(postponedIds);
      const lateIds = new Set(
        executeItems
          .filter((item) => item.purchaseStatus === "Late")
          .map((item) => item.id),
      );
      setLatePhaseItemIds(lateIds);
    } else if (currentPhase === "postponed" && targetPhase === "late") {
      const currentLateIds = new Set(latePhaseItemIds);
      executeItems.forEach((item) => {
        if (item.purchaseStatus === "Late") {
          currentLateIds.add(item.id);
        }
      });
      setLatePhaseItemIds(currentLateIds);
    }
    setCurrentPhase(targetPhase);
    setCurrentPhaseIndex(savedIndex);
    setIsNextButtonBlinking(false);
    setIsCompleted(false);
    clearAutoAdvanceTimer();
    const phaseName =
      targetPhase === "normal"
        ? "通常"
        : targetPhase === "postponed"
          ? "後回し"
          : "遅参";
    setNotification(`${phaseName}フェーズを途中から再開します`);
    setPhaseChangeDialog({
      isOpen: false,
      targetPhase: null,
      hasSavedIndex: false,
      savedIndex: 0,
    });
  }, [
    phaseChangeDialog,
    currentPhase,
    currentPhaseIndex,
    executeItems,
    isInspecting,
    latePhaseItemIds,
    clearAutoAdvanceTimer,
  ]);
  // フェーズ切り替えダイアログをキャンセル
  const cancelPhaseChange = useCallback(() => {
    setPhaseChangeDialog({
      isOpen: false,
      targetPhase: null,
      hasSavedIndex: false,
      savedIndex: 0,
    });
  }, []);
  // 次へボタンの点滅を更新
  useEffect(() => {
    if (currentVisitDisplayItems.length === 0) {
      setBlinkingPriceItemIds(new Set<string>());
      setBlinkingLimitedMissingItemIds(new Set<string>());
      setIsNextButtonBlinking(false);
      return;
    }

    const hasBlockingIssue = blockedByPrice || blockedByLimited;
    setBlinkingPriceItemIds(
      new Set(currentVisitUndefinedPriceItems.map((item) => item.id)),
    );
    setBlinkingLimitedMissingItemIds(
      blockedByLimited
        ? new Set(currentVisitLimitedMissingItems.map((item) => item.id))
        : new Set(),
    );

    if (hasBlockingIssue) {
      setIsNextButtonBlinking(false);
      return;
    }

    const hasUnprocessed = currentVisitDisplayItems.some(
      (item) => item.purchaseStatus === "None",
    );
    setIsNextButtonBlinking(
      !hasUnprocessed && currentVisitDisplayItems.length > 0,
    );
  }, [
    blockedByLimited,
    blockedByPrice,
    currentVisitDisplayItems,
    currentVisitLimitedMissingItems,
    currentVisitUndefinedPriceItems,
  ]);
  // 通知を自動で消す
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    if (!bulkLimitedMessage) return;
    const owner = limitedBulkNotificationOwnerRef.current;
    const timer = setTimeout(() => {
      if (limitedBulkNotificationOwnerRef.current === owner) {
        limitedBulkNotificationOwnerRef.current = null;
        setBulkLimitedMessage(null);
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, [bulkLimitedMessage]);

  const clearLimitedBulkMessage = useCallback((flowToken?: symbol) => {
    if (
      flowToken !== undefined &&
      limitedBulkNotificationOwnerRef.current?.flowToken !== flowToken
    ) {
      return;
    }
    limitedBulkNotificationOwnerRef.current = null;
    setBulkLimitedMessage(null);
  }, []);

  const showLimitedBulkMessage = useCallback(
    (message: string, flowToken: symbol) => {
      limitedBulkNotificationOwnerRef.current = { flowToken, message };
      setBulkLimitedMessage((current) => ({
        message,
        nonce: (current?.nonce ?? 0) + 1,
      }));
    },
    [],
  );
  // マップ表示状態の通知
  useEffect(() => {
    if (onMapVisibilityChange) {
      onMapVisibilityChange(isMapVisible);
    }
  }, [isMapVisible, onMapVisibilityChange]);
  // ナビゲーションボタンの位置を調整
  useEffect(() => {
    const checkOverlap = () => {
      if (!itemListRef.current) return;
      const buttonSize = 56; // w-14 = 56px
      const buttonMargin = 16; // left-4/right-4 = 16px
      const viewportHeight = window.innerHeight;
      const buttonCenterY = viewportHeight / 2;
      const interactiveElements = itemListRef.current.querySelectorAll(
        'button, select, [role="button"]',
      );
      let leftOffset = 0;
      let rightOffset = 0;
      interactiveElements.forEach((element) => {
        const rect = element.getBoundingClientRect();
        // ボタンの上下範囲
        const buttonTop = buttonCenterY - buttonSize / 2;
        const buttonBottom = buttonCenterY + buttonSize / 2;
        const yOverlap = !(rect.bottom < buttonTop || rect.top > buttonBottom);
        if (yOverlap) {
          // 左ボタンとの重なりチェック
          const leftButtonRight = buttonMargin + buttonSize;
          if (rect.left < leftButtonRight) {
            leftOffset = Math.max(leftOffset, leftButtonRight - rect.left + 8);
          }
          // 右ボタンとの重なりチェック
          const rightButtonLeft = window.innerWidth - buttonMargin - buttonSize;
          if (rect.right > rightButtonLeft) {
            rightOffset = Math.max(
              rightOffset,
              rect.right - rightButtonLeft + 8,
            );
          }
        }
      });
      setNavButtonOffset({ left: leftOffset, right: rightOffset });
    };
    // 初回チェックと再チェック
    const timer = setTimeout(checkOverlap, 100);
    window.addEventListener("resize", checkOverlap);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", checkOverlap);
    };
  }, [currentVisitDisplayItems, displayNavigatorIndex, displayPhase]);
  // 次のフェーズまたは訪問先へ移動する関数
  const moveToNext = useCallback(() => {
    clearAutoAdvanceTimer();
    const nextIndex = currentPhaseIndex + 1;
    if (nextIndex < formalPhaseVisits.length) {
      // 同じフェーズ内で次へ
      setCurrentPhaseIndex(nextIndex);
      setIsNextButtonBlinking(false);
    } else {
      // フェーズの終わり - 次のフェーズへ
      if (currentPhase === "normal") {
        // 通常フェーズ終了 → 後回しアイテムIDを記憶
        const postponedIds = new Set(
          executeItems
            .filter((item) => item.purchaseStatus === "Postpone")
            .map((item) => item.id),
        );
        setPostponedPhaseItemIds(postponedIds);
        const lateIds = new Set(
          executeItems
            .filter((item) => item.purchaseStatus === "Late")
            .map((item) => item.id),
        );
        setLatePhaseItemIds(lateIds);
        if (postponedIds.size > 0) {
          setNotification("後回しアイテムの巡回を開始します");
          setCurrentPhase("postponed");
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else if (lateIds.size > 0) {
          setNotification("遅参アイテムの巡回を開始します");
          setCurrentPhase("late");
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
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
        setLatePhaseItemIds(currentLateIds);
        if (currentLateIds.size > 0) {
          setNotification("遅参アイテムの巡回を開始します");
          setCurrentPhase("late");
          setCurrentPhaseIndex(0);
          setIsNextButtonBlinking(false);
        } else {
          setIsCompleted(true);
        }
      } else {
        setIsCompleted(true);
      }
    }
  }, [
    currentPhaseIndex,
    formalPhaseVisits.length,
    currentPhase,
    executeItems,
    clearAutoAdvanceTimer,
    latePhaseItemIds,
  ]);
  const handleNext = useCallback(() => {
    if (isInspecting) {
      setNotification("内容確認中は前後移動できません");
      return;
    }
    if (isTemporaryActive) {
      const result = moveTemporaryBy(1);
      if (!result.ok && result.message) {
        setNotification(result.message, result.tone);
      }
      return;
    }
    setBlinkingPriceItemIds(
      new Set(currentVisitUndefinedPriceItems.map((item) => item.id)),
    );
    setBlinkingLimitedMissingItemIds(
      blockedByLimited
        ? new Set(currentVisitLimitedMissingItems.map((item) => item.id))
        : new Set(),
    );

    if (blockedByPrice && blockedByLimited) {
      setNotification("価格と限数の実購入数を入力してください", "warning");
      return;
    }
    if (blockedByPrice) {
      setNotification(
        "価格未定のアイテムがあります。価格を入力してください。",
        "warning",
      );
      return;
    }
    if (blockedByLimited) {
      setNotification(
        "限数未入力があります。実購入数を入力してください",
        "warning",
      );
      return;
    }
    const hasUncheckedItems = currentVisitDisplayItems.some(
      (item) => item.purchaseStatus === "None",
    );
    clearAutoAdvanceTimer();
    moveToNext();
    // チェック漏れがある場合は通知を表示
    if (hasUncheckedItems) {
      setTimeout(() => {
        setNotification("前のサークルでチェック漏れがあります", "warning");
      }, 100);
    }
  }, [
    blockedByLimited,
    blockedByPrice,
    currentVisitDisplayItems,
    currentVisitLimitedMissingItems,
    currentVisitUndefinedPriceItems,
    clearAutoAdvanceTimer,
    isInspecting,
    isTemporaryActive,
    moveTemporaryBy,
    moveToNext,
  ]);
  // 前の訪問先へ
  const handlePrev = useCallback(() => {
    clearAutoAdvanceTimer();
    if (isInspecting) {
      setNotification("内容確認中は前後移動できません");
      return;
    }
    if (isTemporaryActive) {
      const result = moveTemporaryBy(-1);
      if (!result.ok && result.message) {
        setNotification(result.message, result.tone);
      }
      return;
    }
    if (isCompleted) {
      setIsCompleted(false);
      if (latePhaseItemIds.size > 0) {
        setCurrentPhase("late");
        setCurrentPhaseIndex(visitsByPhase.late.length - 1);
      } else if (postponedPhaseItemIds.size > 0) {
        setCurrentPhase("postponed");
        setCurrentPhaseIndex(visitsByPhase.postponed.length - 1);
      } else if (visitsByPhase.normal.length > 0) {
        setCurrentPhase("normal");
        setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
      }
      return;
    }
    if (currentPhaseIndex > 0) {
      setCurrentPhaseIndex(currentPhaseIndex - 1);
      setIsNextButtonBlinking(false);
    } else {
      // フェーズの最初 - 前のフェーズへ
      if (currentPhase === "postponed" && visitsByPhase.normal.length > 0) {
        setCurrentPhase("normal");
        setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
        setIsNextButtonBlinking(false);
      } else if (currentPhase === "late") {
        if (postponedPhaseItemIds.size > 0) {
          setCurrentPhase("postponed");
          setCurrentPhaseIndex(visitsByPhase.postponed.length - 1);
          setIsNextButtonBlinking(false);
        } else if (visitsByPhase.normal.length > 0) {
          setCurrentPhase("normal");
          setCurrentPhaseIndex(visitsByPhase.normal.length - 1);
          setIsNextButtonBlinking(false);
        } else {
          setNotification("最初の訪問サークル・スペースです");
        }
      } else {
        setNotification("最初の訪問サークル・スペースです");
      }
    }
  }, [
    currentPhaseIndex,
    currentPhase,
    visitsByPhase,
    clearAutoAdvanceTimer,
    isInspecting,
    isTemporaryActive,
    isCompleted,
    postponedPhaseItemIds,
    latePhaseItemIds,
    moveTemporaryBy,
  ]);
  // アイテム更新ハンドラ
  const handleUpdateItem = useCallback(
    (updatedItem: ShoppingItem) => {
      if (isInspecting) {
        setNotification("内容確認中は編集できません");
        return;
      }
      setLastInteractedItemId(updatedItem.id);
      // まずアイテムを更新
      updateItemWithDeferredCleanup(updatedItem);
      // 購入状態が変更されたかチェック
      const originalItem = currentVisitDisplayItems.find(
        (i) => i.id === updatedItem.id,
      );
      if (!originalItem) {
        clearAutoAdvanceTimer();
        return;
      }
      const purchaseStatusChanged =
        originalItem.purchaseStatus !== updatedItem.purchaseStatus;

      if (!purchaseStatusChanged) {
        clearAutoAdvanceTimer();
        return;
      }

      if (!isTemporaryActive) {
        setLastPurchaseChangeAt({
          phase: currentPhase,
          phaseIndex: currentPhaseIndex,
          visitKey: getVisitKey(originalItem),
        });
      }
      clearAutoAdvanceTimer();
    },
    [
      updateItemWithDeferredCleanup,
      currentVisitDisplayItems,
      clearAutoAdvanceTimer,
      currentPhase,
      currentPhaseIndex,
      isInspecting,
      isTemporaryActive,
    ],
  );

  const getLatestItemById = useCallback(
    (itemId: string): ShoppingItem | undefined =>
      items.find((item) => item.id === itemId),
    [items],
  );

  const isLimitedBulkInputTarget = useCallback(
    (item: ShoppingItem): boolean =>
      getLimitedBulkInputTargetDecision(item, {
        skipLimitedPurchaseForSingleQuantity,
      }).isTarget,
    [skipLimitedPurchaseForSingleQuantity],
  );

  const isActiveLimitedBulkFlow = useCallback(
    (flowToken: symbol): boolean =>
      activeLimitedBulkFlowTokenRef.current === flowToken,
    [],
  );

  const finishLimitedBulkFlow = useCallback(
    (
      skipped: number,
      options: { flowToken?: symbol; preserveStartNotification?: boolean } = {},
    ) => {
      setLimitedBulkDialogContext((current) =>
        options.flowToken !== undefined &&
        current?.flowToken !== options.flowToken
          ? current
          : null,
      );
      if (
        options.flowToken === undefined ||
        activeLimitedBulkFlowTokenRef.current === options.flowToken
      ) {
        activeLimitedBulkFlowTokenRef.current = null;
      }
      if (skipped > 0) {
        showLimitedBulkMessage(
          `対象外になったアイテムを${skipped}件スキップしました`,
          options.flowToken ?? Symbol("limited-bulk-flow"),
        );
        return;
      }
      if (!options.preserveStartNotification) {
        clearLimitedBulkMessage(options.flowToken);
      }
    },
    [clearLimitedBulkMessage, showLimitedBulkMessage],
  );

  const advanceLimitedBulkToNextTarget = useCallback(
    (
      queueIds: string[],
      startIndex: number,
      skippedSoFar: number,
      preserveStartNotification: boolean,
      flowToken: symbol,
    ) => {
      if (isInspecting) {
        activeLimitedBulkFlowTokenRef.current = null;
        setLimitedBulkDialogContext(null);
        return;
      }
      let skipped = 0;
      for (let index = startIndex; index < queueIds.length; index += 1) {
        const latestItem = getLatestItemById(queueIds[index]);
        if (latestItem !== undefined && isLimitedBulkInputTarget(latestItem)) {
          setLimitedBulkDialogContext({
            itemSnapshot: latestItem,
            queueIds,
            index,
            skippedCount: skippedSoFar + skipped,
            preserveStartNotification,
            flowToken,
          });
          return;
        }
        skipped += 1;
      }
      finishLimitedBulkFlow(skippedSoFar + skipped, {
        flowToken,
        preserveStartNotification,
      });
    },
    [
      finishLimitedBulkFlow,
      getLatestItemById,
      isInspecting,
      isLimitedBulkInputTarget,
    ],
  );

  const commitLimitedDialogResult = useCallback(
    (baseItem: ShoppingItem, result: LimitedPurchaseDialogResult) => {
      if (isInspecting) {
        setNotification("内容確認中は限数を保存できません");
        return;
      }
      if (result.kind === "limited") {
        updateItemWithDeferredCleanup(
          applyLimitedPurchase(baseItem, {
            actual: result.actual,
            planned: result.planned,
          }),
        );
        return;
      }
      if (result.kind === "purchased") {
        updateItemWithDeferredCleanup(
          applyPurchasedFromLimitedInput(baseItem, result.planned),
        );
        return;
      }
      updateItemWithDeferredCleanup(
        applyLimitedPurchase(baseItem, { planned: result.planned }),
      );
    },
    [isInspecting, setNotification, updateItemWithDeferredCleanup],
  );

  const startLimitedBulkFlow = useCallback(
    (targetItems: ShoppingItem[]) => {
      if (isInspecting) {
        setLimitedBulkDialogContext(null);
        setNotification("内容確認中は限数を変更できません");
        return;
      }
      const allAlreadyLimited =
        targetItems.length > 0 &&
        targetItems.every((item) => item.purchaseStatus === "LimitedPurchase");
      const flowToken = Symbol("limited-bulk-flow");
      activeLimitedBulkFlowTokenRef.current = flowToken;

      if (allAlreadyLimited) {
        setLimitedBulkDialogContext(null);
        const missing = targetItems.filter(hasMissingLimitedPurchaseQuantity);
        if (missing.length === 0) {
          showLimitedBulkMessage("解除対象の限数未入力はありません", flowToken);
          activeLimitedBulkFlowTokenRef.current = null;
          return;
        }
        if (
          !window.confirm(
            "実購入数が未入力の限数だけ未購入に戻します。よろしいですか？",
          )
        ) {
          activeLimitedBulkFlowTokenRef.current = null;
          return;
        }
        clearLimitedBulkMessage();
        missing.forEach((item) => {
          updateItemWithDeferredCleanup(
            clearLimitedPurchase({ ...item, purchaseStatus: "None" }),
          );
        });
        activeLimitedBulkFlowTokenRef.current = null;
        return;
      }

      const { targets, singleQuantitySkippedCount, baseTargetCount } =
        getLimitedBulkInputTargets(targetItems, {
          skipLimitedPurchaseForSingleQuantity,
        });
      const queueIds = targets.map((item) => item.id);
      if (queueIds.length === 0) {
        setLimitedBulkDialogContext(null);
        clearLimitedBulkMessage();
        if (baseTargetCount > 0 && singleQuantitySkippedCount > 0) {
          showLimitedBulkMessage(
            `数量1のアイテム${singleQuantitySkippedCount}件を除外したため、変更対象はありません`,
            flowToken,
          );
          activeLimitedBulkFlowTokenRef.current = null;
          return;
        }
        showLimitedBulkMessage("変更対象のアイテムはありません", flowToken);
        activeLimitedBulkFlowTokenRef.current = null;
        return;
      }
      if (singleQuantitySkippedCount > 0) {
        showLimitedBulkMessage(
          `数量1のアイテムを${singleQuantitySkippedCount}件スキップしました`,
          flowToken,
        );
      } else {
        clearLimitedBulkMessage();
      }
      advanceLimitedBulkToNextTarget(
        queueIds,
        0,
        0,
        singleQuantitySkippedCount > 0,
        flowToken,
      );
    },
    [
      advanceLimitedBulkToNextTarget,
      clearLimitedBulkMessage,
      isInspecting,
      setNotification,
      showLimitedBulkMessage,
      skipLimitedPurchaseForSingleQuantity,
      updateItemWithDeferredCleanup,
    ],
  );

  const handleLimitedBulkSubmit = useCallback(
    (result: LimitedPurchaseDialogResult) => {
      if (isInspecting) {
        activeLimitedBulkFlowTokenRef.current = null;
        setLimitedBulkDialogContext(null);
        setNotification("内容確認中は限数を保存できません");
        return;
      }
      if (limitedBulkDialogContext === null) return;

      const latestItem = getLatestItemById(
        limitedBulkDialogContext.itemSnapshot.id,
      );
      const isActiveFlow = isActiveLimitedBulkFlow(
        limitedBulkDialogContext.flowToken,
      );
      const submitDecision =
        latestItem === undefined
          ? computeLimitedBulkSubmitDecision({
              context: limitedBulkDialogContext,
              latestItem: undefined,
              isActiveFlow,
            })
          : computeLimitedBulkSubmitDecision({
              context: limitedBulkDialogContext,
              latestItem,
              decision: getLimitedBulkInputTargetDecision(latestItem, {
                skipLimitedPurchaseForSingleQuantity,
              }),
              isActiveFlow,
            });

      switch (submitDecision.kind) {
        case "stale":
          setLimitedBulkDialogContext((current) =>
            current?.flowToken === submitDecision.flowToken ? null : current,
          );
          return;

        case "notFound":
        case "notTarget":
          setLimitedBulkDialogContext(null);
          advanceLimitedBulkToNextTarget(
            limitedBulkDialogContext.queueIds,
            submitDecision.nextIndex,
            submitDecision.nextSkippedCount,
            limitedBulkDialogContext.preserveStartNotification,
            submitDecision.flowToken,
          );
          return;

        case "commit":
          if (result.kind === "defer") {
            markLimitedPurchaseQuantityDeferred(
              getVisitKey(submitDecision.baseItem),
              submitDecision.baseItem.id,
            );
          }
          commitLimitedDialogResult(submitDecision.baseItem, result);
          setLimitedBulkDialogContext(null);
          advanceLimitedBulkToNextTarget(
            limitedBulkDialogContext.queueIds,
            submitDecision.nextIndex,
            submitDecision.nextSkippedCount,
            limitedBulkDialogContext.preserveStartNotification,
            submitDecision.flowToken,
          );
          return;

        default: {
          const _exhaustive: never = submitDecision;
          void _exhaustive;
        }
      }
    },
    [
      advanceLimitedBulkToNextTarget,
      commitLimitedDialogResult,
      getLatestItemById,
      isActiveLimitedBulkFlow,
      isInspecting,
      limitedBulkDialogContext,
      markLimitedPurchaseQuantityDeferred,
      setNotification,
      skipLimitedPurchaseForSingleQuantity,
    ],
  );

  const handleLimitedBulkCancel = useCallback(() => {
    if (limitedBulkDialogContext === null) return;

    const cancelDecision = computeLimitedBulkCancelDecision({
      context: limitedBulkDialogContext,
      isActiveFlow: isActiveLimitedBulkFlow(limitedBulkDialogContext.flowToken),
    });

    switch (cancelDecision.kind) {
      case "stale":
        setLimitedBulkDialogContext((current) =>
          current?.flowToken === cancelDecision.flowToken ? null : current,
        );
        return;

      case "finish":
        finishLimitedBulkFlow(cancelDecision.skippedCount, {
          flowToken: cancelDecision.flowToken,
          preserveStartNotification: cancelDecision.preserveStartNotification,
        });
        return;

      default: {
        const _exhaustive: never = cancelDecision;
        void _exhaustive;
      }
    }
  }, [
    finishLimitedBulkFlow,
    isActiveLimitedBulkFlow,
    limitedBulkDialogContext,
  ]);

  const limitedBulkDialogItemSnapshot = limitedBulkDialogContext?.itemSnapshot;

  const handleBulkStatusChange = useCallback(
    (targetStatus: PurchaseStatus) => {
      if (isInspecting) {
        setNotification("内容確認中は一括変更できません");
        return;
      }
      if (!currentVisit || currentVisitDisplayItems.length === 0) {
        clearAutoAdvanceTimer();
        return;
      }

      if (targetStatus === "LimitedPurchase") {
        startLimitedBulkFlow(currentVisitDisplayItems);
        clearAutoAdvanceTimer();
        return;
      }

      const allAlready = currentVisitDisplayItems.every(
        (item) => item.purchaseStatus === targetStatus,
      );
      const newStatus: PurchaseStatus = allAlready ? "None" : targetStatus;
      const targets = isSpaceAggregate
        ? currentVisitDisplayItems
        : currentVisitDisplayItems.filter(
            (item) => item.purchaseStatus !== "LimitedPurchase",
          );
      const changedItems = targets.filter(
        (item) => item.purchaseStatus !== newStatus,
      );

      if (changedItems.length === 0) {
        setNotification("変更対象のアイテムはありません");
        clearAutoAdvanceTimer();
        return;
      }

      setLastInteractedItemId(changedItems[changedItems.length - 1].id);
      if (!isTemporaryActive) {
        setLastPurchaseChangeAt({
          phase: currentPhase,
          phaseIndex: currentPhaseIndex,
          visitKey: currentVisit.key,
        });
      }

      changedItems.forEach((item) => {
        updateItemWithDeferredCleanup(
          clearLimitedPurchase({ ...item, purchaseStatus: newStatus }),
        );
      });

      if (targetStatus === "SoldOut" && newStatus === "SoldOut") {
        openPostEventDistributionCheck("bulk", targets);
      }

      clearAutoAdvanceTimer();
    },
    [
      currentVisit,
      currentVisitDisplayItems,
      currentPhase,
      currentPhaseIndex,
      clearAutoAdvanceTimer,
      isSpaceAggregate,
      isTemporaryActive,
      isInspecting,
      setNotification,
      startLimitedBulkFlow,
      updateItemWithDeferredCleanup,
      openPostEventDistributionCheck,
    ],
  );
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (
        layoutMode !== "smartphone" ||
        isNavigatorPickerOpen ||
        isInspecting
      ) {
        touchStartXRef.current = null;
        touchStartYRef.current = null;
        isSwipingRef.current = false;
        return;
      }
      const touch = e.touches[0];
      touchStartXRef.current = touch.clientX;
      touchStartYRef.current = touch.clientY;
      isSwipingRef.current = false;
    },
    [isInspecting, isNavigatorPickerOpen, layoutMode],
  );
  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (
        layoutMode !== "smartphone" ||
        isNavigatorPickerOpen ||
        isInspecting ||
        touchStartXRef.current === null ||
        touchStartYRef.current === null
      )
        return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchStartXRef.current;
      const deltaY = touch.clientY - touchStartYRef.current;
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
        isSwipingRef.current = true;
      }
    },
    [isInspecting, isNavigatorPickerOpen, layoutMode],
  );
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (
        layoutMode !== "smartphone" ||
        isNavigatorPickerOpen ||
        isInspecting ||
        touchStartXRef.current === null
      ) {
        touchStartXRef.current = null;
        touchStartYRef.current = null;
        isSwipingRef.current = false;
        return;
      }
      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartXRef.current;
      const deltaY = touch.clientY - (touchStartYRef.current || 0);
      if (
        Math.abs(deltaX) > Math.abs(deltaY) &&
        Math.abs(deltaX) > SWIPE_THRESHOLD
      ) {
        if (deltaX > 0) {
          // 右スワイプ → 前へ
          handlePrev();
        } else {
          // 左スワイプ → 次へ
          handleNext();
        }
      }
      touchStartXRef.current = null;
      touchStartYRef.current = null;
      isSwipingRef.current = false;
    },
    [handleNext, handlePrev, isInspecting, isNavigatorPickerOpen, layoutMode],
  );
  const handleModeChangeInternal = useCallback(
    (mode: "edit" | "execute") => {
      onModeChange(mode, lastInteractedItemId || undefined);
    },
    [onModeChange, lastInteractedItemId],
  );
  // マップ表示トグル
  const toggleMapVisibility = useCallback(() => {
    setIsMapVisible(!isMapVisible);
  }, [isMapVisible]);
  // スプリットドラッグ関連
  const handleSplitDragStart = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      splitDragRef.current = { startY: clientY, startRatio: splitRatio };
    },
    [splitRatio],
  );
  const handleSplitDragMove = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      if (!splitDragRef.current) return;
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      const deltaY = clientY - splitDragRef.current.startY;
      const viewportHeight = window.innerHeight;
      const deltaRatio = (deltaY / viewportHeight) * 100;
      const newRatio = Math.max(
        20,
        Math.min(80, splitDragRef.current.startRatio + deltaRatio),
      );
      setSplitRatio(newRatio);
    },
    [],
  );
  const handleSplitDragEnd = useCallback(() => {
    splitDragRef.current = null;
  }, []);
  // マップズームレベル変更
  const handleMapZoomChange = useCallback((newZoom: number) => {
    setMapZoomLevel(newZoom);
  }, []);
  const isAutoAdvancing = useAutoSkipEmptyVisit({
    paused: isNavigatorInteractionActive,
    isCompleted,
    allVisitsLength: allVisits.length,
    currentVisitDisplayItemsLength: formalCurrentVisitDisplayItems.length,
    currentPhaseVisits: formalPhaseVisits,
    currentPhaseIndex,
    currentPhase,
    postponedPhaseItemIds,
    latePhaseItemIds,
    executeItems,
    isResumeChoiceOpen: Boolean(resumeChoiceDialog?.isOpen),
    clearAutoAdvanceTimer,
    setPostponedPhaseItemIds,
    setLatePhaseItemIds,
    setNotification,
    setCurrentPhase,
    setCurrentPhaseIndex,
    setIsCompleted,
  });
  // ===== 以下のフックを早期returnの前に移動 =====
  // マップのセルクリックハンドラ
  const handleMapCellClick = useCallback(
    (blockName: string, number: number, matchingItems: ShoppingItem[]) => {
      if (isInspecting) return;
      const seenItemIds = new Set<string>();
      const scopedItems = matchingItems.filter((item) => {
        if (
          !executeModeItemIdSet.has(item.id) ||
          item.eventDate.trim() !== mapDayName ||
          seenItemIds.has(item.id)
        ) {
          return false;
        }
        seenItemIds.add(item.id);
        return true;
      });
      setCellPopupState({
        isOpen: true,
        blockName,
        number,
        items: scopedItems,
      });
    },
    [executeModeItemIdSet, isInspecting, mapDayName],
  );
  const cellTemporaryTargets = useMemo<CellTemporaryTarget[]>(() => {
    return groupCellItemsBySpace(cellPopupState.items).flatMap((group) => {
      const aggregate = aggregateNavigatorSpace(
        baseNavigatorEntries,
        group.spaceKey,
        { latestItemsById: itemsById },
      );
      if (!aggregate) return [];
      const target: CellTemporaryTarget = {
        visitId: aggregate.representativeVisitId,
        spaceKey: group.spaceKey,
        displayLabel: group.displayLabel,
        itemIds: [...aggregate.itemIds],
        itemCount: aggregate.itemIds.length,
        disabled: displayEntry?.spaceKey === group.spaceKey,
      };
      return [target];
    });
  }, [
    baseNavigatorEntries,
    cellPopupState.items,
    displayEntry?.spaceKey,
    itemsById,
  ]);
  const handleCellTemporaryMove = useCallback(
    async (target: CellTemporaryTarget): Promise<boolean> => {
      if (
        isInspecting ||
        !spaceNavigator ||
        spaceNavigator.registration?.id !== focusNavigatorRegistrationId
      ) {
        setNotification("一時移動を開始できませんでした");
        return false;
      }
      clearAutoAdvanceTimer();
      const payload: FocusSpaceAggregateNavigationPayload = {
        kind: "space-aggregate",
        spaceKey: target.spaceKey,
        representativeVisitId: target.visitId,
        displayLabel: target.displayLabel,
      };
      const result = await spaceNavigator.navigateByVisitId(
        target.visitId,
        "temporary",
        {
          confirmed: true,
          source: "map-cell",
          payload,
          expectedRegistrationId: focusNavigatorRegistrationId,
        },
      );
      if (!result.ok && result.message) {
        setNotification(result.message, result.tone);
      }
      return result.ok;
    },
    [
      clearAutoAdvanceTimer,
      focusNavigatorRegistrationId,
      isInspecting,
      spaceNavigator,
    ],
  );
  // セルポップアップを閉じる
  const closeCellPopup = useCallback(() => {
    setCellPopupState((prev) => ({ ...prev, isOpen: false }));
  }, []);
  const openAddItemDialog = useCallback(() => {
    if (!currentVisit || isInspecting) return;
    const firstItem = currentVisit.items[0];
    setAddItemDialog({
      isOpen: true,
      eventDate: firstItem?.eventDate || "",
      block: cellPopupState.blockName,
      number: String(cellPopupState.number),
    });
    setNewItemForm({
      circle: "",
      title: "",
      price: "",
      quantity: "1",
      remarks: "",
      url: "",
      purchaseStatus: "Purchased",
    });
    closeCellPopup();
  }, [currentVisit, cellPopupState, closeCellPopup, isInspecting]);
  const openAddItemDialogFromList = useCallback(() => {
    if (!currentVisit || isInspecting) return;
    const firstItem = currentVisit.items[0];
    const uniqueCircles = [
      ...new Set(currentVisit.items.map((item) => item.circle).filter(Boolean)),
    ];
    const defaultCircle = uniqueCircles.length === 1 ? uniqueCircles[0] : "";
    setAddItemDialog({
      isOpen: true,
      eventDate: firstItem?.eventDate || "",
      block: firstItem?.block || "",
      number: firstItem?.number || "",
    });
    setNewItemForm({
      circle: defaultCircle,
      title: "",
      price: "",
      quantity: "1",
      remarks: "",
      url: "",
      purchaseStatus: "Purchased",
    });
  }, [currentVisit, isInspecting]);
  // アイテム追加ダイアログを閉じる
  const closeAddItemDialog = useCallback(() => {
    setAddItemDialog((prev) => ({ ...prev, isOpen: false }));
  }, []);
  // アイテムを追加
  const handleAddNewItem = useCallback(() => {
    if (!onAddItem || isInspecting) return;
    const price =
      newItemForm.price === "" ? null : parseInt(newItemForm.price, 10) || 0;
    onAddItem({
      eventDate: addItemDialog.eventDate,
      block: addItemDialog.block,
      number: addItemDialog.number,
      circle: newItemForm.circle,
      title: newItemForm.title,
      price,
      quantity: parseInt(newItemForm.quantity, 10) || 1,
      remarks: newItemForm.remarks,
      url: newItemForm.url || undefined,
      purchaseStatus: newItemForm.purchaseStatus,
    });
    // 購入状態に応じたメッセージ
    const statusText =
      newItemForm.purchaseStatus === "Purchased"
        ? "候補リスト"
        : newItemForm.purchaseStatus === "Postpone"
          ? "後回しフェーズ"
          : "遅参フェーズ";
    setNotification(
      `${addItemDialog.block}-${addItemDialog.number} を${statusText}に追加しました`,
    );
    closeAddItemDialog();
  }, [onAddItem, addItemDialog, newItemForm, closeAddItemDialog, isInspecting]);
  // 価格のクイック選択オプション
  const priceOptions = useMemo(() => {
    const options: number[] = [0];
    for (let i = 100; i <= 15000; i += 100) {
      options.push(i);
    }
    return options;
  }, []);
  // 価格入力ハンドラ
  const handlePriceInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (isInspecting) return;
      const value = e.target.value.replace(/[^0-9]/g, "");
      setNewItemForm((prev) => ({ ...prev, price: value }));
    },
    [isInspecting],
  );
  // 価格選択ハンドラ
  const handlePriceSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      if (isInspecting) return;
      setNewItemForm((prev) => ({ ...prev, price: e.target.value }));
    },
    [isInspecting],
  );
  // ===== フックの移動ここまで =====
  const applyResumeChoice = useCallback(
    (choice: "lastChange" | "pointer" | "phaseStart" | "normalStart") => {
      if (!resumeChoiceDialog) return;
      const result = resolveResumeChoice(choice, resumeChoiceDialog);
      const nextPhase = result.phase ?? currentPhase;
      if (result.phase !== undefined) {
        setCurrentPhase(result.phase);
      }
      if (result.phaseIndex !== undefined) {
        const visits = visitsByPhase[nextPhase];
        const safeIndex =
          visits.length === 0
            ? 0
            : Math.min(Math.max(0, result.phaseIndex), visits.length - 1);
        setCurrentPhaseIndex(safeIndex);
      }
      if (result.isCompleted === true) {
        setIsCompleted(true);
      } else {
        setIsCompleted(false);
        setLastPurchaseChangeAt(null);
      }
      setResumeChoiceDialog(null);
      clearAutoAdvanceTimer();
      setIsNextButtonBlinking(false);
    },
    [
      resumeChoiceDialog,
      currentPhase,
      visitsByPhase,
      setResumeChoiceDialog,
      clearAutoAdvanceTimer,
    ],
  );
  const temporaryMovementPhaseChoices = useMemo<TemporaryPhaseChoice[]>(() => {
    const phaseLabels: Record<FocusPhase, string> = {
      normal: "通常",
      postponed: "後回し",
      late: "遅参",
    };
    return (["normal", "postponed", "late"] as const).map((phase) => {
      const candidate = initialPhaseCandidates[phase];
      const aggregate = candidate
        ? aggregateNavigatorSpace(baseNavigatorEntries, candidate.spaceKey, {
            latestItemsById: itemsById,
          })
        : null;
      const circleText = aggregate?.circles.slice(0, 2).join("・") || "";
      const extraCircleCount = Math.max(
        0,
        (aggregate?.circles.length ?? 0) - 2,
      );
      const targetText = aggregate
        ? `${aggregate.label}${circleText ? ` ${circleText}` : ""}${
            extraCircleCount > 0 ? ` ほか${extraCircleCount}件` : ""
          }（${aggregate.itemIds.length}件）`
        : aggregatePhasePresence[phase] && movementDirection === "next"
          ? "次のスペースはありません（残り一覧へ）"
          : "移動先なし";
      return {
        phase,
        label: phaseLabels[phase],
        detail: targetText,
        disabled:
          !aggregatePhasePresence[phase] ||
          (movementDirection === "previous" && !candidate),
      };
    });
  }, [
    aggregatePhasePresence,
    baseNavigatorEntries,
    initialPhaseCandidates,
    itemsById,
    movementDirection,
  ]);
  const temporaryPromotionPhaseChoices = useMemo<TemporaryPhaseChoice[]>(() => {
    const phaseLabels: Record<FocusPhase, string> = {
      normal: "通常",
      postponed: "後回し",
      late: "遅参",
    };
    const currentLabel =
      currentVisitDisplayItems[0] !== undefined
        ? getSpaceDisplayLabel(currentVisitDisplayItems[0])
        : "表示中のスペース";
    return (["normal", "postponed", "late"] as const).map((phase) => ({
      phase,
      label: phaseLabels[phase],
      detail: promotionPhasePresence[phase]
        ? `${currentLabel}を現在地にする`
        : "対象なし",
      disabled: !promotionPhasePresence[phase],
    }));
  }, [currentVisitDisplayItems, promotionPhasePresence]);
  const temporaryRemainingSections = useMemo<
    TemporaryRemainingSection[]
  >(() => {
    const configs: {
      phase: FocusPhase;
      label: string;
    }[] = [
      { phase: "normal", label: "通常の未購入" },
      { phase: "postponed", label: "後回し" },
      { phase: "late", label: "遅参" },
    ];
    return configs.map(({ phase, label }) => ({
      phase,
      label,
      entries: remainingSpaceLists[phase].map((entry) => ({
        visitId: entry.representativeVisitId,
        spaceKey: entry.spaceKey,
        label: entry.label,
        circles: [...entry.circles],
        itemCount: entry.itemIds.length,
        disabled: entry.isCurrent,
      })),
    }));
  }, [remainingSpaceLists]);
  const handleTemporaryMovementPhaseSelect = useCallback(
    (phase: FocusPhase) => {
      const result = selectMovementPhase(phase);
      if (!result.ok && result.message) {
        setNotification(result.message, result.tone);
      }
    },
    [selectMovementPhase],
  );
  const handleTemporaryRemainingSelect = useCallback(
    (phase: FocusPhase, visitId: string) => {
      const result = selectRemainingSpace(phase, visitId);
      if (!result.ok && result.message) {
        setNotification(result.message, result.tone);
      }
    },
    [selectRemainingSpace],
  );
  const handleTemporaryPromotionPhaseSelect = useCallback(
    (phase: FocusPhase) => {
      void confirmPromotionPhase(phase).then((result) => {
        if (!result.ok && result.message) {
          setNotification(result.message, result.tone);
        }
      });
    },
    [confirmPromotionPhase],
  );
  const handleTemporaryReturn = useCallback(() => {
    void spaceNavigator?.returnToPrevious();
  }, [spaceNavigator]);
  const handleTemporaryPromoteRequest = useCallback(() => {
    void spaceNavigator?.promoteTemporary();
  }, [spaceNavigator]);
  const resumeChoiceDialogJSX = resumeChoiceDialog?.isOpen ? (
    <ResumeChoiceDialogView
      dialog={resumeChoiceDialog}
      onChoice={applyResumeChoice}
    />
  ) : null;
  const limitedPurchaseDialogJSX = (
    <LimitedPurchaseDialog
      isOpen={limitedBulkDialogContext !== null}
      itemId={limitedBulkDialogItemSnapshot?.id}
      itemTitle={
        limitedBulkDialogItemSnapshot?.title ||
        limitedBulkDialogItemSnapshot?.circle
      }
      initialActual={
        limitedBulkDialogItemSnapshot
          ? getActualPurchasedQuantity(limitedBulkDialogItemSnapshot)
          : undefined
      }
      initialPlanned={
        limitedBulkDialogItemSnapshot
          ? getPlannedQuantity(limitedBulkDialogItemSnapshot)
          : 1
      }
      showDeferButton
      onSubmit={handleLimitedBulkSubmit}
      onCancel={handleLimitedBulkCancel}
    />
  );
  const postEventDistributionCheckDialogJSX = (
    <PostEventDistributionCheckDialog
      open={postEventDistributionCheckContext !== null}
      mode={postEventDistributionCheckContext?.mode ?? "single"}
      targets={postEventDistributionCheckContext?.targets ?? []}
      onCancel={handlePostEventDistributionCheckCancel}
      onApply={handlePostEventDistributionCheckApply}
    />
  );
  if (allVisits.length === 0) {
    return (
      <>
        <EmptyVisitStateView onEdit={() => handleModeChangeInternal("edit")} />
        {resumeChoiceDialogJSX}
      </>
    );
  }
  if (isSpaceAggregate && temporarySubview === "ended") {
    return (
      <>
        <TemporaryTourEndStateView
          executeItems={executeItems}
          onReturn={handleTemporaryReturn}
          onPromote={handleTemporaryPromoteRequest}
          onBackToRemaining={showRemainingSpaces}
        />
        <TemporaryPhaseChoiceDialog
          isOpen={promotionPhaseChoiceOpen}
          title="現在地にするフェーズを選択"
          description="全フェーズまとめ表示には単独のフェーズがないため、正式な巡回位置を選んでください。"
          choices={temporaryPromotionPhaseChoices}
          onSelect={handleTemporaryPromotionPhaseSelect}
          onCancel={cancelPromotionPhaseSelection}
        />
        {resumeChoiceDialogJSX}
      </>
    );
  }
  if (isCompleted) {
    return (
      <>
        {completionSubView === "limitedMissingList" ? (
          <LimitedPurchaseMissingListView
            items={executeItems}
            onUpdateItem={updateItemWithDeferredCleanup}
            onBack={() => setCompletionSubView("summary")}
          />
        ) : (
          <CompletionStateView
            executeItems={executeItems}
            layoutMode={layoutMode}
            onPrev={handlePrev}
            onModeChange={handleModeChangeInternal}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onLimitedMissingClick={() =>
              setCompletionSubView("limitedMissingList")
            }
            prevButtonStyle={completionPrevStyle}
          />
        )}
        {resumeChoiceDialogJSX}
      </>
    );
  }
  if (isAutoAdvancing) {
    return (
      <>
        <AutoAdvancingStateView />
        {resumeChoiceDialogJSX}
      </>
    );
  }
  const currentCircleNames = Array.from(
    new Set(
      currentVisitDisplayItems
        .map((item) => item.circle.trim())
        .filter((circle) => circle.length > 0),
    ),
  );
  const circleName =
    currentCircleNames.length > 2
      ? `${currentCircleNames.slice(0, 2).join("・")} ほか${currentCircleNames.length - 2}件`
      : currentCircleNames.join("・");
  const spaceInfo = currentVisitDisplayItems[0]
    ? getSpaceDisplayLabel(currentVisitDisplayItems[0])
    : "";
  const currentVisitKey = currentVisitDisplayItems[0]
    ? getMapVisitKey(currentVisitDisplayItems[0])
    : null;
  const formalMapEntry = baseNavigatorEntries[formalRouteIndex];
  const formalMapItem = formalMapEntry?.itemIds
    .map((itemId) => itemsById.get(itemId))
    .find((item): item is ShoppingItem => item !== undefined);
  const formalCurrentVisitKey = formalMapItem
    ? getMapVisitKey(formalMapItem)
    : null;
  const formalNextMapEntry = baseNavigatorEntries[formalRouteIndex + 1];
  const formalNextMapItem = formalNextMapEntry?.itemIds
    .map((itemId) => itemsById.get(itemId))
    .find((item): item is ShoppingItem => item !== undefined);
  const nextVisitKey = formalNextMapItem
    ? getMapVisitKey(formalNextMapItem)
    : null;
  const formalPrevMapEntry = baseNavigatorEntries[formalRouteIndex - 1];
  const formalPrevMapItem = formalPrevMapEntry?.itemIds
    .map((itemId) => itemsById.get(itemId))
    .find((item): item is ShoppingItem => item !== undefined);
  const prevVisitKey = formalPrevMapItem
    ? getMapVisitKey(formalPrevMapItem)
    : null;
  // App.tsx側で scale されるため、高さは逆補正して実表示高さを安定させる
  const footerOverlapGuardPx = 1;
  const visibleNotification = bulkLimitedMessage
    ? { message: bulkLimitedMessage.message, tone: "info" as const }
    : notification;
  const visibleNotificationColorClass =
    visibleNotification?.tone === "warning" ? "bg-red-600" : "bg-blue-600";
  // フェーズ切り替え確認ダイアログ
  const phaseChangeDialogJSX = (
    <PhaseChangeDialogView
      dialog={phaseChangeDialog}
      visitsByPhase={visitsByPhase}
      onStart={executePhaseChangeFromStart}
      onSaved={executePhaseChangeFromSaved}
      onCancel={cancelPhaseChange}
    />
  );
  const temporaryMovementPhaseDialogJSX = (
    <TemporaryPhaseChoiceDialog
      isOpen={movementPhaseSelectionOpen}
      title={`${movementDirection === "previous" ? "前" : "次"}へ進む基準フェーズを選択`}
      description="選択後は、そのフェーズを基準に前後移動します。表示する商品は引き続き全フェーズ分です。"
      choices={temporaryMovementPhaseChoices}
      onSelect={handleTemporaryMovementPhaseSelect}
      onCancel={cancelMovementPhaseSelection}
    />
  );
  const temporaryRemainingSpacesDialogJSX = (
    <TemporaryRemainingSpacesDialog
      isOpen={isSpaceAggregate && temporarySubview === "remaining"}
      sections={temporaryRemainingSections}
      onSelect={handleTemporaryRemainingSelect}
      onEnd={showTemporaryEnd}
      onCancel={closeRemainingSpaces}
    />
  );
  const temporaryPromotionPhaseDialogJSX = (
    <TemporaryPhaseChoiceDialog
      isOpen={promotionPhaseChoiceOpen}
      title="現在地にするフェーズを選択"
      description="選択したフェーズ内で、このスペースの最も早い訪問候補を正式な現在地にします。"
      choices={temporaryPromotionPhaseChoices}
      onSelect={handleTemporaryPromotionPhaseSelect}
      onCancel={cancelPromotionPhaseSelection}
    />
  );
  const cellItemPopupJSX = (
    <CellItemPopup
      state={cellPopupState}
      canAddItem={Boolean(onAddItem) && !isInspecting}
      temporaryTargets={cellTemporaryTargets}
      onAddItem={openAddItemDialog}
      onTemporaryMove={handleCellTemporaryMove}
      onClose={closeCellPopup}
    />
  );
  const addItemDialogJSX = (
    <AddItemDialogView
      dialog={addItemDialog}
      form={newItemForm}
      setDialog={setAddItemDialog}
      setForm={setNewItemForm}
      currentVisit={currentVisit ?? undefined}
      priceOptions={priceOptions}
      onPriceInputChange={handlePriceInputChange}
      onPriceSelectChange={handlePriceSelectChange}
      onClose={closeAddItemDialog}
      onSubmit={handleAddNewItem}
    />
  );
  if (
    layoutMode === "smartphone" &&
    isMapVisible &&
    currentMapData &&
    !isCompleted
  ) {
    const availableHeight = `calc((100dvh - ${measuredFooterHeight + footerOverlapGuardPx}px) / ${safeAppScale})`;
    return (
      <div
        className="relative flex flex-col"
        style={{ height: availableHeight }}
        data-focus-inspecting={isInspecting || undefined}
      >
        {visibleNotification && (
          <div
            className={`fixed top-4 left-1/2 transform -translate-x-1/2 z-50 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse ${visibleNotificationColorClass}`}
          >
            {visibleNotification.message}
          </div>
        )}
        <div
          style={{ height: `${splitRatio}%` }}
          className="relative flex flex-col min-h-0"
        >
          <FocusModeMapControls
            compact
            mapZoomLevel={mapZoomLevel}
            mapRotationAngle={mapRotationAngle}
            mapInitialRotationAngle={mapInitialRotationAngle}
            onMapRotationAngleChange={stableMapRotationHandler}
            mapCenteringMode={mapCenteringMode}
            onMapCenteringModeChange={setMapCenteringMode}
          />
          <div className="flex-grow relative overflow-hidden">
            <FocusModeMapCanvas
              mapData={currentMapData}
              mapName={currentMapName || ""}
              items={items}
              executeModeItemIds={executeModeItemIds}
              zoomLevel={mapZoomLevel}
              selectedHall={selectedHall}
              currentVisitKey={currentVisitKey}
              formalCurrentVisitKey={formalCurrentVisitKey}
              temporaryVisitKey={isTemporaryActive ? currentVisitKey : null}
              nextVisitKey={nextVisitKey}
              prevVisitKey={prevVisitKey}
              currentPhase={displayPhase}
              formalCurrentPhase={currentPhase}
              selectedHallMode={selectedHallId}
              onZoomChange={handleMapZoomChange}
              onCellClick={handleMapCellClick}
              appZoomLevel={appZoomLevel}
              hallDefinitions={hallDefinitions}
              rotationAngle={mapRotationAngle}
              onRotationAngleChange={onMapRotationAngleChange}
              allVisitKeys={allVisitKeys}
              currentPhaseIndex={displayPhaseIndex}
              formalCurrentPhaseIndex={currentPhaseIndex}
              currentRouteIndex={displayNavigatorIndex}
              formalCurrentRouteIndex={formalRouteIndex}
              recenterRevision={recenterRevision}
              onViewportSnapshotChange={handleMapViewportSnapshotChange}
              viewportRestoreRequest={mapViewportRestoreRequest}
              onViewportRestoreApplied={handleMapViewportRestoreApplied}
              numberCellOutlineStyle={numberCellOutlineStyle}
              mapCenteringMode={mapCenteringMode}
              precomputedVisitKeyCellMap={visitKeyCellMap}
              precomputedAllVisitCellCoords={precomputedAllVisitCellCoords}
              precomputedRouteSegments={precomputedRouteSegments}
              routeDiagnostics={routeDiagnostics}
            />
          </div>
        </div>
        <div
          className="h-3 bg-slate-300 dark:bg-slate-600 cursor-row-resize flex items-center justify-center touch-none flex-shrink-0"
          onTouchStart={handleSplitDragStart}
          onTouchMove={handleSplitDragMove}
          onTouchEnd={handleSplitDragEnd}
          onMouseDown={handleSplitDragStart}
          onMouseMove={handleSplitDragMove}
          onMouseUp={handleSplitDragEnd}
          onMouseLeave={handleSplitDragEnd}
        >
          <div className="w-12 h-1 bg-slate-500 dark:bg-slate-400 rounded-full" />
        </div>
        <div
          style={{ height: `${100 - splitRatio}%` }}
          className="overflow-y-auto min-h-0"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <FocusModeHeader
            layoutMode={layoutMode}
            isMapVisible={isMapVisible}
            spaceInfo={spaceInfo}
            circleName={circleName}
            currentVisitCheckedCount={currentVisitCheckedCount}
            currentVisitTotalCount={currentVisitTotalCount}
            currentVisitPriceInfo={currentVisitPriceInfo}
            currentPhase={displayPhase}
            isSpaceAggregate={isSpaceAggregate}
            movementBasisPhase={movementBasisPhase}
            onPhaseChangeRequest={handlePhaseChangeRequest}
            currentVisitItems={currentVisitDisplayItems}
            onBulkStatusChange={handleBulkStatusChange}
            readOnly={isInspecting}
            nextVisitInfo={nextVisitInfo}
          />
          <FocusModeItemList
            itemListRef={itemListRef}
            layoutMode={layoutMode}
            isMapVisible={isMapVisible}
            currentVisitDisplayItems={currentVisitDisplayItems}
            blinkingPriceItemIds={blinkingPriceItemIds}
            blinkingLimitedMissingItemIds={blinkingLimitedMissingItemIds}
            onUpdateItem={handleUpdateItem}
            onEditRequest={isInspecting ? undefined : onEditRequest}
            onDeleteRequest={isInspecting ? undefined : onDeleteRequest}
            onAddItem={
              onAddItem && !isInspecting ? openAddItemDialogFromList : undefined
            }
            getLatestItemById={getLatestItemById}
            onNotify={setNotification}
            purchaseStatusControlMode={purchaseStatusControlMode}
            skipLimitedPurchaseForSingleQuantity={
              skipLimitedPurchaseForSingleQuantity
            }
            readOnly={isInspecting}
            onLimitedPurchaseDefer={handleLimitedPurchaseDefer}
            onPostEventDistributionCheckRequest={(soldOutItem) =>
              openPostEventDistributionCheck("single", [soldOutItem])
            }
          />
        </div>
        <FocusModeFooterPortal
          compact
          layoutMode={layoutMode}
          phaseDisplayName={phaseDisplayName}
          currentPhaseIndex={currentPhaseIndex}
          currentPhaseVisitsLength={formalPhaseEntriesLength}
          currentVisitNumber={currentVisitNumber}
          totalVisits={totalVisits}
          purchasedCount={purchasedCount}
          executeItemsLength={executeItems.length}
          remainingCost={remainingCost}
          hasMapData={Boolean(currentMapData)}
          isMapVisible={isMapVisible}
          onToggleMapVisibility={toggleMapVisibility}
          onLayoutModeChange={onLayoutModeChange}
        />
        {phaseChangeDialogJSX}
        {temporaryMovementPhaseDialogJSX}
        {temporaryRemainingSpacesDialogJSX}
        {temporaryPromotionPhaseDialogJSX}
        {cellItemPopupJSX}
        {addItemDialogJSX}
        {limitedPurchaseDialogJSX}
        {postEventDistributionCheckDialogJSX}
        {resumeChoiceDialogJSX}
      </div>
    );
  }
  if (layoutMode === "pc" && isMapVisible && currentMapData && !isCompleted) {
    const availableHeight = `calc((100dvh - ${HEADER_HEIGHT + measuredFooterHeight + footerOverlapGuardPx}px) / ${safeAppScale})`;
    return (
      <div
        className="relative flex"
        style={{ height: availableHeight }}
        data-focus-inspecting={isInspecting || undefined}
      >
        {visibleNotification && (
          <div
            className={`fixed top-20 left-1/2 transform -translate-x-1/2 z-50 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse ${visibleNotificationColorClass}`}
          >
            {visibleNotification.message}
          </div>
        )}
        <div className="w-1/2 flex flex-col border-r border-slate-200 dark:border-slate-700">
          <FocusModeMapControls
            mapZoomLevel={mapZoomLevel}
            mapRotationAngle={mapRotationAngle}
            mapInitialRotationAngle={mapInitialRotationAngle}
            onMapRotationAngleChange={stableMapRotationHandler}
            mapCenteringMode={mapCenteringMode}
            onMapCenteringModeChange={setMapCenteringMode}
          />
          <div className="flex-grow relative overflow-hidden">
            <FocusModeMapCanvas
              mapData={currentMapData}
              mapName={currentMapName || ""}
              items={items}
              executeModeItemIds={executeModeItemIds}
              zoomLevel={mapZoomLevel}
              selectedHall={selectedHall}
              currentVisitKey={currentVisitKey}
              formalCurrentVisitKey={formalCurrentVisitKey}
              temporaryVisitKey={isTemporaryActive ? currentVisitKey : null}
              nextVisitKey={nextVisitKey}
              prevVisitKey={prevVisitKey}
              currentPhase={displayPhase}
              formalCurrentPhase={currentPhase}
              selectedHallMode={selectedHallId}
              onZoomChange={handleMapZoomChange}
              onCellClick={handleMapCellClick}
              appZoomLevel={appZoomLevel}
              hallDefinitions={hallDefinitions}
              rotationAngle={mapRotationAngle}
              onRotationAngleChange={onMapRotationAngleChange}
              allVisitKeys={allVisitKeys}
              currentPhaseIndex={displayPhaseIndex}
              formalCurrentPhaseIndex={currentPhaseIndex}
              currentRouteIndex={displayNavigatorIndex}
              formalCurrentRouteIndex={formalRouteIndex}
              recenterRevision={recenterRevision}
              onViewportSnapshotChange={handleMapViewportSnapshotChange}
              viewportRestoreRequest={mapViewportRestoreRequest}
              onViewportRestoreApplied={handleMapViewportRestoreApplied}
              numberCellOutlineStyle={numberCellOutlineStyle}
              mapCenteringMode={mapCenteringMode}
              precomputedVisitKeyCellMap={visitKeyCellMap}
              precomputedAllVisitCellCoords={precomputedAllVisitCellCoords}
              precomputedRouteSegments={precomputedRouteSegments}
              routeDiagnostics={routeDiagnostics}
            />
          </div>
        </div>
        <div className="w-1/2 flex flex-col overflow-y-auto pb-20">
          <FocusModeHeader
            layoutMode={layoutMode}
            isMapVisible={isMapVisible}
            spaceInfo={spaceInfo}
            circleName={circleName}
            currentVisitCheckedCount={currentVisitCheckedCount}
            currentVisitTotalCount={currentVisitTotalCount}
            currentVisitPriceInfo={currentVisitPriceInfo}
            currentPhase={displayPhase}
            isSpaceAggregate={isSpaceAggregate}
            movementBasisPhase={movementBasisPhase}
            onPhaseChangeRequest={handlePhaseChangeRequest}
            currentVisitItems={currentVisitDisplayItems}
            onBulkStatusChange={handleBulkStatusChange}
            readOnly={isInspecting}
            nextVisitInfo={nextVisitInfo}
          />
          <FocusModeItemList
            itemListRef={itemListRef}
            layoutMode={layoutMode}
            isMapVisible={isMapVisible}
            currentVisitDisplayItems={currentVisitDisplayItems}
            blinkingPriceItemIds={blinkingPriceItemIds}
            blinkingLimitedMissingItemIds={blinkingLimitedMissingItemIds}
            onUpdateItem={handleUpdateItem}
            onEditRequest={isInspecting ? undefined : onEditRequest}
            onDeleteRequest={isInspecting ? undefined : onDeleteRequest}
            onAddItem={
              onAddItem && !isInspecting ? openAddItemDialogFromList : undefined
            }
            getLatestItemById={getLatestItemById}
            onNotify={setNotification}
            purchaseStatusControlMode={purchaseStatusControlMode}
            skipLimitedPurchaseForSingleQuantity={
              skipLimitedPurchaseForSingleQuantity
            }
            readOnly={isInspecting}
            onLimitedPurchaseDefer={handleLimitedPurchaseDefer}
            onPostEventDistributionCheckRequest={(soldOutItem) =>
              openPostEventDistributionCheck("single", [soldOutItem])
            }
          />
        </div>
        <button
          onClick={handlePrev}
          className="fixed right-[calc(50%+16px)] top-1/2 transform -translate-y-1/2 w-12 h-12 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-xl z-40"
          title="前の訪問先"
        >
          ◀
        </button>
        <button
          onClick={handleNext}
          style={splitMapNextStyle}
          className={`fixed top-1/2 transform -translate-y-1/2 w-12 h-12 rounded-full shadow-lg flex items-center justify-center text-xl z-40 ${
            nextButtonBlockTone === "both" || nextButtonBlockTone === "price"
              ? "bg-red-500 hover:bg-red-600 text-white"
              : nextButtonBlockTone === "limited"
                ? "bg-orange-500 hover:bg-orange-600 text-white"
                : isNextButtonBlinking
                  ? "bg-green-500 hover:bg-green-600 text-white animate-pulse"
                  : "bg-blue-600 hover:bg-blue-700 text-white"
          }`}
          title="次の訪問先"
        >
          ▶
        </button>
        <FocusModeFooterPortal
          layoutMode={layoutMode}
          phaseDisplayName={phaseDisplayName}
          currentPhaseIndex={currentPhaseIndex}
          currentPhaseVisitsLength={formalPhaseEntriesLength}
          currentVisitNumber={currentVisitNumber}
          totalVisits={totalVisits}
          purchasedCount={purchasedCount}
          executeItemsLength={executeItems.length}
          remainingCost={remainingCost}
          hasMapData={Boolean(currentMapData)}
          isMapVisible={isMapVisible}
          onToggleMapVisibility={toggleMapVisibility}
          onLayoutModeChange={onLayoutModeChange}
        />
        {phaseChangeDialogJSX}
        {temporaryMovementPhaseDialogJSX}
        {temporaryRemainingSpacesDialogJSX}
        {temporaryPromotionPhaseDialogJSX}
        {cellItemPopupJSX}
        {addItemDialogJSX}
        {limitedPurchaseDialogJSX}
        {postEventDistributionCheckDialogJSX}
      </div>
    );
  }
  return (
    <div
      ref={swipeContainerRef}
      className="relative min-h-[calc(100vh-200px)] pb-20"
      data-focus-inspecting={isInspecting || undefined}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {visibleNotification && (
        <div
          className={`fixed top-20 left-1/2 transform -translate-x-1/2 z-50 text-white px-6 py-3 rounded-lg shadow-lg animate-pulse ${visibleNotificationColorClass}`}
        >
          {visibleNotification.message}
        </div>
      )}
      <FocusModeHeader
        layoutMode={layoutMode}
        isMapVisible={isMapVisible}
        containerClassName={headerContainerClass}
        size="expanded"
        spaceInfo={spaceInfo}
        circleName={circleName}
        currentVisitCheckedCount={currentVisitCheckedCount}
        currentVisitTotalCount={currentVisitTotalCount}
        currentVisitPriceInfo={currentVisitPriceInfo}
        currentPhase={displayPhase}
        isSpaceAggregate={isSpaceAggregate}
        movementBasisPhase={movementBasisPhase}
        onPhaseChangeRequest={handlePhaseChangeRequest}
        currentVisitItems={currentVisitDisplayItems}
        onBulkStatusChange={handleBulkStatusChange}
        readOnly={isInspecting}
        nextVisitInfo={nextVisitInfo}
      />
      <FocusModeItemList
        itemListRef={itemListRef}
        layoutMode={layoutMode}
        isMapVisible={isMapVisible}
        containerClassName={itemListContainerClass}
        currentVisitDisplayItems={currentVisitDisplayItems}
        blinkingPriceItemIds={blinkingPriceItemIds}
        blinkingLimitedMissingItemIds={blinkingLimitedMissingItemIds}
        onUpdateItem={handleUpdateItem}
        onEditRequest={isInspecting ? undefined : onEditRequest}
        onDeleteRequest={isInspecting ? undefined : onDeleteRequest}
        onAddItem={
          onAddItem && !isInspecting ? openAddItemDialogFromList : undefined
        }
        getLatestItemById={getLatestItemById}
        onNotify={setNotification}
        purchaseStatusControlMode={purchaseStatusControlMode}
        skipLimitedPurchaseForSingleQuantity={
          skipLimitedPurchaseForSingleQuantity
        }
        readOnly={isInspecting}
        onLimitedPurchaseDefer={handleLimitedPurchaseDefer}
        onPostEventDistributionCheckRequest={(soldOutItem) =>
          openPostEventDistributionCheck("single", [soldOutItem])
        }
      />
      {layoutMode === "pc" && (
        <>
          <button
            onClick={handlePrev}
            style={navPrevStyle}
            className="fixed top-1/2 transform -translate-y-1/2 w-14 h-14 bg-slate-600 hover:bg-slate-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl z-40"
            title="前の訪問先"
          >
            ◀
          </button>
          <button
            onClick={handleNext}
            style={navNextStyle}
            className={`fixed top-1/2 transform -translate-y-1/2 w-14 h-14 rounded-full shadow-lg flex items-center justify-center text-2xl z-40 ${
              nextButtonBlockTone === "both" || nextButtonBlockTone === "price"
                ? "bg-red-500 hover:bg-red-600 text-white"
                : nextButtonBlockTone === "limited"
                  ? "bg-orange-500 hover:bg-orange-600 text-white"
                  : isNextButtonBlinking
                    ? "bg-green-500 hover:bg-green-600 text-white animate-pulse"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
            }`}
            title="次の訪問先"
          >
            ▶
          </button>
        </>
      )}
      <FocusModeFooterPortal
        layoutMode={layoutMode}
        phaseDisplayName={phaseDisplayName}
        currentPhaseIndex={currentPhaseIndex}
        currentPhaseVisitsLength={formalPhaseEntriesLength}
        currentVisitNumber={currentVisitNumber}
        totalVisits={totalVisits}
        purchasedCount={purchasedCount}
        executeItemsLength={executeItems.length}
        remainingCost={remainingCost}
        hasMapData={Boolean(currentMapData)}
        isMapVisible={isMapVisible}
        onToggleMapVisibility={toggleMapVisibility}
        onLayoutModeChange={onLayoutModeChange}
      />
      {phaseChangeDialogJSX}
      {temporaryMovementPhaseDialogJSX}
      {temporaryRemainingSpacesDialogJSX}
      {temporaryPromotionPhaseDialogJSX}
      {cellItemPopupJSX}
      {addItemDialogJSX}
      {limitedPurchaseDialogJSX}
      {postEventDistributionCheckDialogJSX}
      {resumeChoiceDialogJSX}
    </div>
  );
};
export default React.memo(FocusMode);
