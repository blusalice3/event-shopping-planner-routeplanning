import React from "react";
import {
  PurchaseStatus,
  PurchaseStatusControlMode,
  ShoppingItem,
} from "../../types/item";
import type { FocusMapCenteringMode, FocusPhase } from "../../types/focus";
import { hasMissingLimitedQuantity } from "../../features/space-navigation/domain/statusSegments";
import ShoppingItemCard from "../ShoppingItemCard";
import MapRotationControls from "../map/MapRotationControls";
import "./FocusModePanels.css";

interface FocusModeItemListProps {
  itemListRef: React.RefObject<HTMLDivElement>;
  layoutMode: "pc" | "smartphone";
  isMapVisible: boolean;
  containerClassName?: string;
  currentVisitDisplayItems: ShoppingItem[];
  blinkingPriceItemIds: Set<string>;
  blinkingLimitedMissingItemIds?: Set<string>;
  onUpdateItem: (item: ShoppingItem) => void;
  onEditRequest?: (item: ShoppingItem) => void;
  onDeleteRequest?: (item: ShoppingItem) => void;
  onAddItem?: () => void;
  getLatestItemById?: (itemId: string) => ShoppingItem | undefined;
  onNotify?: (message: string) => void;
  purchaseStatusControlMode?: PurchaseStatusControlMode;
  skipLimitedPurchaseForSingleQuantity: boolean;
  readOnly?: boolean;
  onLimitedPurchaseDefer?: (item: ShoppingItem) => void;
  onPostEventDistributionCheckRequest?: (item: ShoppingItem) => void;
}

interface FocusModeHeaderProps {
  layoutMode: "pc" | "smartphone";
  isMapVisible: boolean;
  containerClassName?: string;
  size?: "compact" | "expanded";
  spaceInfo: string;
  circleName: string;
  currentVisitCheckedCount: number;
  currentVisitTotalCount: number;
  currentVisitPriceInfo: {
    chargeableTotal: number;
    plannedTotal: number;
    priceMissingItemCount: number;
  };
  currentPhase: FocusPhase;
  onPhaseChangeRequest: (phase: FocusPhase) => void;
  currentVisitItems: ShoppingItem[];
  onBulkStatusChange: (targetStatus: PurchaseStatus) => void;
  readOnly?: boolean;
  isSpaceAggregate?: boolean;
  movementBasisPhase?: FocusPhase | null;
  nextVisitInfo: {
    spaceInfo: string;
    circleName: string;
  };
}

interface FocusModeMapControlsProps {
  compact?: boolean;
  mapZoomLevel: number;
  mapRotationAngle: number;
  mapInitialRotationAngle: number;
  onMapRotationAngleChange: (angle: number) => void;
  mapCenteringMode: FocusMapCenteringMode;
  onMapCenteringModeChange: (mode: FocusMapCenteringMode) => void;
}

const noopShoppingItemHandler = (_item: ShoppingItem) => {};
const noopSelectItem = (_itemId: string) => {};

const phaseDisplayNames: Record<FocusPhase, string> = {
  normal: "通常",
  postponed: "後回し",
  late: "遅参",
};

const HEADER_STATUS_ORDER = [
  "unvisited",
  "postponed",
  "late",
  "limited",
  "purchased",
  "soldOut",
  "absent",
] as const;
type HeaderStatusKind = (typeof HEADER_STATUS_ORDER)[number];

const HEADER_STATUS_COLORS: Record<HeaderStatusKind, string> = {
  unvisited: "#94a3b8",
  postponed: "#8b5cf6",
  late: "#3b82f6",
  limited: "#f97316",
  purchased: "#22c55e",
  soldOut: "#ef4444",
  absent: "#eab308",
};

const getHeaderStatusKind = (item: ShoppingItem): HeaderStatusKind => {
  switch (item.purchaseStatus) {
    case "None":
      return "unvisited";
    case "Postpone":
      return "postponed";
    case "Late":
      return "late";
    case "LimitedPurchase":
      return hasMissingLimitedQuantity(item) ? "limited" : "purchased";
    case "Purchased":
      return "purchased";
    case "SoldOut":
      return "soldOut";
    case "Absent":
      return "absent";
  }
};

const getHeaderStatusKinds = (
  items: readonly ShoppingItem[],
): HeaderStatusKind[] => {
  const presentKinds = new Set(items.map(getHeaderStatusKind));
  return HEADER_STATUS_ORDER.filter((kind) => presentKinds.has(kind));
};

const bulkStatusOptions: {
  status: PurchaseStatus;
  label: string;
  activeColor: string;
  hoverColor: string;
}[] = [
  {
    status: "Purchased",
    label: "全購入",
    activeColor: "bg-green-600 text-white",
    hoverColor: "hover:bg-white/20",
  },
  {
    status: "SoldOut",
    label: "全売切",
    activeColor: "bg-red-600 text-white",
    hoverColor: "hover:bg-white/20",
  },
  {
    status: "Absent",
    label: "全欠席",
    activeColor: "bg-yellow-500 text-white",
    hoverColor: "hover:bg-white/20",
  },
  {
    status: "Postpone",
    label: "全後回",
    activeColor: "bg-purple-700 text-white",
    hoverColor: "hover:bg-white/20",
  },
  {
    status: "Late",
    label: "全遅参",
    activeColor: "bg-blue-700 text-white",
    hoverColor: "hover:bg-white/20",
  },
  {
    status: "LimitedPurchase",
    label: "全限数",
    activeColor: "bg-orange-600 text-white",
    hoverColor: "hover:bg-white/20",
  },
];

export const FocusModeItemList: React.FC<FocusModeItemListProps> = React.memo(
  ({
    itemListRef,
    layoutMode,
    isMapVisible,
    containerClassName,
    currentVisitDisplayItems,
    blinkingPriceItemIds,
    blinkingLimitedMissingItemIds = new Set(),
    onUpdateItem,
    onEditRequest,
    onDeleteRequest,
    onAddItem,
    getLatestItemById,
    onNotify,
    purchaseStatusControlMode = "cycle",
    skipLimitedPurchaseForSingleQuantity,
    readOnly = false,
    onLimitedPurchaseDefer,
    onPostEventDistributionCheckRequest,
  }) => (
    <div
      ref={itemListRef}
      className={
        containerClassName ||
        `${layoutMode === "smartphone" ? "space-y-2" : "space-y-4"} pb-24 ${
          layoutMode === "smartphone" && isMapVisible
            ? "px-2"
            : layoutMode === "smartphone"
              ? "mx-2"
              : "mx-4"
        }`
      }
    >
      {currentVisitDisplayItems.map((item, index) => (
        <div
          key={item.id}
          data-item-id={item.id}
          className={`relative ${
            blinkingPriceItemIds.has(item.id)
              ? "animate-pulse ring-2 ring-red-500 rounded-lg"
              : blinkingLimitedMissingItemIds.has(item.id)
                ? "animate-pulse ring-2 ring-orange-500 rounded-lg"
                : ""
          }`}
        >
          <ShoppingItemCard
            item={item}
            onUpdate={onUpdateItem}
            isStriped={index % 2 === 1}
            onEditRequest={onEditRequest || noopShoppingItemHandler}
            onDeleteRequest={onDeleteRequest || noopShoppingItemHandler}
            isSelected={false}
            onSelectItem={noopSelectItem}
            layoutMode={layoutMode}
            viewMode="focus"
            purchaseStatusControlMode={purchaseStatusControlMode}
            skipLimitedPurchaseForSingleQuantity={
              skipLimitedPurchaseForSingleQuantity
            }
            readOnly={readOnly}
            highlightLimitedMissing={blinkingLimitedMissingItemIds.has(item.id)}
            getLatestItemById={getLatestItemById}
            onNotify={onNotify}
            onLimitedPurchaseDefer={onLimitedPurchaseDefer}
            onPostEventDistributionCheckRequest={
              onPostEventDistributionCheckRequest
            }
          />
        </div>
      ))}
      {onAddItem && (
        <div className="flex justify-center py-4">
          <button
            onClick={onAddItem}
            className="w-12 h-12 bg-green-600 hover:bg-green-700 text-white rounded-full shadow-lg flex items-center justify-center text-2xl transition-colors"
            title="新規アイテム追加"
          >
            +
          </button>
        </div>
      )}
    </div>
  ),
);

export const FocusModeHeader: React.FC<FocusModeHeaderProps> = React.memo(
  ({
    layoutMode,
    isMapVisible,
    containerClassName,
    size = "compact",
    spaceInfo,
    circleName,
    currentVisitCheckedCount,
    currentVisitTotalCount,
    currentVisitPriceInfo,
    currentPhase,
    onPhaseChangeRequest,
    currentVisitItems,
    onBulkStatusChange,
    readOnly = false,
    isSpaceAggregate = false,
    movementBasisPhase = null,
    nextVisitInfo,
  }) => {
    const isSmartphone = layoutMode === "smartphone";
    const rootClassName = containerClassName
      ? `text-white rounded-lg shadow-lg ${containerClassName}`
      : `text-white rounded-lg shadow-lg ${
          isSmartphone ? `px-2 py-1 ${isMapVisible ? "mx-2" : ""}` : "px-3 py-1"
        }`;
    const headerStatusKinds = getHeaderStatusKinds(currentVisitItems);
    const labelClassName =
      size === "expanded" ? "text-sm opacity-80" : "text-xs opacity-80";
    const titleClassName =
      size === "expanded" ? "text-2xl font-bold" : "text-xl font-bold";
    const circleClassName = size === "expanded" ? "text-lg" : "text-sm";
    const totalClassName =
      size === "expanded" ? "text-xl font-bold" : "text-lg font-bold";
    const selectClassName =
      size === "expanded"
        ? "text-xl font-bold bg-white/20 hover:bg-white/30 rounded-md py-1 px-2 text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors"
        : "text-lg font-bold bg-white/20 hover:bg-white/30 rounded-md py-1 px-2 text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors";
    const nextClassName =
      size === "expanded"
        ? "text-sm opacity-80 mt-1"
        : "text-xs opacity-80 mt-1";
    const hasPlannedDiff =
      currentVisitPriceInfo.plannedTotal !==
      currentVisitPriceInfo.chargeableTotal;
    const nextVisitText = [nextVisitInfo.spaceInfo, nextVisitInfo.circleName]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ");
    const nextVisitDisplayText = nextVisitText || "-";
    const smartphoneSelectClassName =
      "h-8 w-full max-w-[6.75rem] rounded-md bg-white/20 py-0.5 pl-2 pr-6 text-sm font-bold text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors";
    const bulkStatusButtonClassName =
      "inline-flex h-auto min-h-0 flex-shrink-0 items-center whitespace-nowrap rounded px-2 py-px text-xs font-medium leading-none transition-colors";
    const smartphoneBulkStatusButtonClassName =
      "inline-flex h-auto min-h-0 flex-shrink-0 items-center whitespace-nowrap rounded px-1.5 py-px text-[10px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";

    const renderPhaseSelect = (className: string) => (
      <select
        value={currentPhase}
        disabled={readOnly}
        onChange={(e) => onPhaseChangeRequest(e.target.value as FocusPhase)}
        className={`focus-mode-phase-select ${className}`}
        aria-label="phase"
      >
        <option value="normal" className="text-slate-900">
          通常
        </option>
        <option value="postponed" className="text-slate-900">
          後回し
        </option>
        <option value="late" className="text-slate-900">
          遅参
        </option>
      </select>
    );

    const renderPhaseControl = (selectClass: string) => {
      if (!isSpaceAggregate) return renderPhaseSelect(selectClass);

      return (
        <div
          className="rounded-md bg-black/10 px-2 py-1 text-right"
          data-testid="focus-header-aggregate-phase"
        >
          <div className="whitespace-nowrap text-sm font-bold leading-tight">
            一時表示・全フェーズ
          </div>
          <div className="mt-1 whitespace-nowrap text-xs opacity-85">
            移動基準：
            {movementBasisPhase
              ? phaseDisplayNames[movementBasisPhase]
              : "未選択"}
          </div>
        </div>
      );
    };

    const renderBulkStatusButtons = (buttonClassName: string) =>
      bulkStatusOptions.map(({ status, label, activeColor, hoverColor }) => {
        const allMatch = currentVisitItems.every(
          (item) => item.purchaseStatus === status,
        );
        return (
          <button
            key={status}
            type="button"
            disabled={readOnly}
            onClick={(e) => {
              e.stopPropagation();
              onBulkStatusChange(status);
            }}
            className={`${buttonClassName} ${
              allMatch ? activeColor : `bg-white/10 text-white ${hoverColor}`
            }`}
            title={`${label}に一括変更${allMatch ? "（もう一度押すと未購入に戻す）" : ""}`}
            aria-pressed={allMatch}
          >
            {label}
          </button>
        );
      });

    const headerContent = isSmartphone ? (
      <>
        <div
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
          data-testid="focus-header-smartphone-main"
        >
          <div className="min-w-0">
            <div
              className="truncate text-lg font-bold leading-tight"
              title={spaceInfo}
            >
              {spaceInfo}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate text-xs leading-snug"
                title={circleName}
              >
                {circleName}
              </span>
              <span className="inline-flex flex-shrink-0 rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                {currentVisitCheckedCount}/{currentVisitTotalCount}
              </span>
            </div>
          </div>

          <div
            className={`text-right ${
              isSpaceAggregate ? "min-w-[8.5rem]" : "min-w-[6.75rem]"
            }`}
          >
            {renderPhaseControl(smartphoneSelectClassName)}
            {!isSpaceAggregate && (
              <div
                className="mt-0.5 max-w-[8rem] truncate text-[10px] opacity-80"
                title={nextVisitDisplayText}
                data-testid="focus-header-next-visit"
              >
                次: {nextVisitDisplayText}
              </div>
            )}
          </div>
        </div>

        <div
          className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-white/20 pt-0.5"
          data-testid="focus-header-smartphone-payment"
        >
          <span className="text-[10px] leading-none opacity-80">支払額</span>
          <span className="text-lg font-bold leading-none tabular-nums">
            ¥{currentVisitPriceInfo.chargeableTotal.toLocaleString()}
          </span>
          {hasPlannedDiff && (
            <span className="text-[10px] font-semibold leading-none opacity-85">
              予定額 ¥{currentVisitPriceInfo.plannedTotal.toLocaleString()}
            </span>
          )}
          {currentVisitPriceInfo.priceMissingItemCount > 0 && (
            <span className="text-[10px] font-semibold leading-none text-red-200">
              価格未定 {currentVisitPriceInfo.priceMissingItemCount}件
            </span>
          )}
        </div>

        {currentVisitItems.length > 0 && (
          <div
            className="-mx-1 mt-px overflow-x-auto overflow-y-hidden px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            data-testid="focus-header-bulk-scroll"
          >
            <div
              className="ml-auto flex w-max max-w-none flex-nowrap justify-end gap-1.5"
              data-testid="focus-header-bulk-row"
            >
              {renderBulkStatusButtons(smartphoneBulkStatusButtonClassName)}
            </div>
          </div>
        )}
      </>
    ) : (
      <>
        <div className="flex justify-between items-start">
          <div>
            <div className={labelClassName}>訪問先</div>
            <div className={titleClassName}>{spaceInfo}</div>
            <div className="flex items-center gap-2">
              <span className={circleClassName}>{circleName}</span>
              <span className="bg-white/20 px-2 py-0.5 rounded text-sm">
                {currentVisitCheckedCount}/{currentVisitTotalCount}
              </span>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className={labelClassName}>この訪問の支払額</div>
              <div className={totalClassName}>
                <span>
                  ¥{currentVisitPriceInfo.chargeableTotal.toLocaleString()}
                </span>
                {currentVisitPriceInfo.plannedTotal !==
                  currentVisitPriceInfo.chargeableTotal && (
                  <span className="block text-xs opacity-80">
                    予定額 ¥
                    {currentVisitPriceInfo.plannedTotal.toLocaleString()}
                  </span>
                )}
                {currentVisitPriceInfo.priceMissingItemCount > 0 && (
                  <span className="block text-xs text-red-300">
                    価格未定 {currentVisitPriceInfo.priceMissingItemCount}件
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-right">
            {!isSpaceAggregate && (
              <div className={labelClassName}>フェーズ</div>
            )}
            {renderPhaseControl(selectClassName)}
            {!isSpaceAggregate && (
              <div className={nextClassName}>
                次: {nextVisitInfo.spaceInfo} {nextVisitInfo.circleName}
              </div>
            )}
          </div>
        </div>
        {currentVisitItems.length > 0 && (
          <div
            className="mt-0.5 flex flex-wrap justify-end gap-x-1.5 gap-y-0.5"
            data-testid="focus-header-desktop-bulk-row"
          >
            {renderBulkStatusButtons(bulkStatusButtonClassName)}
          </div>
        )}
      </>
    );

    return (
      <div
        className={`relative overflow-hidden ${rootClassName}`}
        data-testid="focus-mode-header"
      >
        <svg
          aria-hidden="true"
          className="absolute inset-0 h-full w-full pointer-events-none"
          preserveAspectRatio="none"
          shapeRendering="crispEdges"
          viewBox="0 0 100 100"
        >
          {headerStatusKinds.length > 0 ? (
            headerStatusKinds.map((kind, index) => (
              <rect
                key={kind}
                data-header-status={kind}
                fill={HEADER_STATUS_COLORS[kind]}
                height="100"
                width={100 / headerStatusKinds.length}
                x={(index * 100) / headerStatusKinds.length}
              />
            ))
          ) : (
            <>
              <rect
                data-header-status="fallback-start"
                fill="#6366f1"
                height="100"
                width="50"
              />
              <rect
                data-header-status="fallback-end"
                fill="#9333ea"
                height="100"
                width="50"
                x="50"
              />
            </>
          )}
          <rect
            data-header-overlay
            fill="rgba(15, 23, 42, 0.28)"
            height="100"
            width="100"
          />
        </svg>
        <div className="relative">{headerContent}</div>
      </div>
    );
  },
);

export const FocusModeMapControls: React.FC<FocusModeMapControlsProps> =
  React.memo(
    ({
      mapZoomLevel,
      mapRotationAngle,
      mapInitialRotationAngle,
      onMapRotationAngleChange,
      mapCenteringMode,
      onMapCenteringModeChange,
      compact = false,
    }) => (
      <div
        className={
          compact
            ? "relative z-20 flex flex-nowrap items-center gap-1 overflow-visible border-b border-slate-200 bg-white/90 px-0.5 py-0 dark:border-slate-700 dark:bg-slate-800/90"
            : "flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/90 p-2 dark:border-slate-700 dark:bg-slate-800/90"
        }
        data-testid="focus-map-controls"
      >
        <div
          className={`flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-600 ${
            compact ? "h-7 min-w-0 flex-1" : ""
          }`}
          role="group"
          aria-label="マップの表示範囲"
        >
          <button
            type="button"
            onClick={() => onMapCenteringModeChange("prevToCurrent")}
            className={`${compact ? "h-full min-w-0 flex-1 px-1 text-[11px] leading-none" : "px-2 py-1 text-xs"} whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300 ${
              mapCenteringMode === "prevToCurrent"
                ? "bg-blue-600 text-white"
                : "bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
            }`}
            aria-label="前の訪問先から現在地までのルートを表示"
            aria-pressed={mapCenteringMode === "prevToCurrent"}
          >
            {compact ? "前→現" : "前→現ルート"}
          </button>
          <button
            type="button"
            onClick={() => onMapCenteringModeChange("currentOnly")}
            className={`${compact ? "h-full min-w-0 flex-1 px-1 text-[11px] leading-none" : "px-2 py-1 text-xs"} whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300 ${
              mapCenteringMode === "currentOnly"
                ? "bg-blue-600 text-white"
                : "bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300"
            }`}
            aria-label="現在地だけを中央表示"
            aria-pressed={mapCenteringMode === "currentOnly"}
          >
            現在地
          </button>
        </div>

        <div
          className={`flex flex-none items-center justify-center rounded-md bg-slate-100 font-semibold tabular-nums text-slate-700 dark:bg-slate-700 dark:text-slate-300 ${
            compact
              ? "h-7 min-w-[3.25rem] px-1.5 text-xs leading-none"
              : "px-3 py-1 text-sm"
          }`}
          aria-label={`マップ倍率 ${Math.round(mapZoomLevel)}パーセント`}
        >
          {Math.round(mapZoomLevel)}%
        </div>
        <MapRotationControls
          angle={mapRotationAngle}
          initialAngle={mapInitialRotationAngle}
          onAngleChange={onMapRotationAngleChange}
          showHint={!compact}
          compact={compact}
        />
      </div>
    ),
  );
