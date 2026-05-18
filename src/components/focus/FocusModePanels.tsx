import React from 'react';
import { PurchaseStatus, PurchaseStatusControlMode, ShoppingItem } from '../../types/item';
import { FocusMapCenteringMode } from '../../types/focus';
import ShoppingItemCard from '../ShoppingItemCard';
import MapRotationControls from '../map/MapRotationControls';

type FocusPhase = 'normal' | 'postponed' | 'late';

interface FocusModeItemListProps {
  itemListRef: React.RefObject<HTMLDivElement>;
  layoutMode: 'pc' | 'smartphone';
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
}

interface FocusModeHeaderProps {
  layoutMode: 'pc' | 'smartphone';
  isMapVisible: boolean;
  containerClassName?: string;
  size?: 'compact' | 'expanded';
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
  nextVisitInfo: {
    spaceInfo: string;
    circleName: string;
  };
}

interface FocusModeMapControlsProps {
  mapZoomLevel: number;
  mapRotationAngle: number;
  mapInitialRotationAngle: number;
  onMapRotationAngleChange: (angle: number) => void;
  mapCenteringMode: FocusMapCenteringMode;
  onMapCenteringModeChange: (mode: FocusMapCenteringMode) => void;
}

const noopShoppingItemHandler = (_item: ShoppingItem) => {};
const noopSelectItem = (_itemId: string) => {};

const bulkStatusOptions: {
  status: PurchaseStatus;
  label: string;
  activeColor: string;
  hoverColor: string;
}[] = [
  { status: 'Purchased', label: '全購入', activeColor: 'bg-green-600 text-white', hoverColor: 'hover:bg-white/20' },
  { status: 'SoldOut', label: '全売切', activeColor: 'bg-red-600 text-white', hoverColor: 'hover:bg-white/20' },
  { status: 'Absent', label: '全欠席', activeColor: 'bg-yellow-500 text-white', hoverColor: 'hover:bg-white/20' },
  { status: 'Postpone', label: '全後回', activeColor: 'bg-purple-700 text-white', hoverColor: 'hover:bg-white/20' },
  { status: 'Late', label: '全遅参', activeColor: 'bg-blue-700 text-white', hoverColor: 'hover:bg-white/20' },
  { status: 'LimitedPurchase', label: '全限数', activeColor: 'bg-orange-600 text-white', hoverColor: 'hover:bg-white/20' },
];

export const FocusModeItemList: React.FC<FocusModeItemListProps> = React.memo(({
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
  purchaseStatusControlMode = 'cycle',
  skipLimitedPurchaseForSingleQuantity,
}) => (
  <div
    ref={itemListRef}
    className={
      containerClassName ||
      `space-y-4 pb-24 ${
        layoutMode === 'smartphone' && isMapVisible
          ? 'px-2'
          : layoutMode === 'smartphone'
            ? 'mx-2'
            : 'mx-4'
      }`
    }
  >
    {currentVisitDisplayItems.map((item, index) => (
      <div
        key={item.id}
        data-item-id={item.id}
        className={`relative ${
          blinkingPriceItemIds.has(item.id)
            ? 'animate-pulse ring-2 ring-red-500 rounded-lg'
            : blinkingLimitedMissingItemIds.has(item.id)
              ? 'animate-pulse ring-2 ring-orange-500 rounded-lg'
              : ''
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
          skipLimitedPurchaseForSingleQuantity={skipLimitedPurchaseForSingleQuantity}
          highlightLimitedMissing={blinkingLimitedMissingItemIds.has(item.id)}
          getLatestItemById={getLatestItemById}
          onNotify={onNotify}
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
));

export const FocusModeHeader: React.FC<FocusModeHeaderProps> = React.memo(({
  layoutMode,
  isMapVisible,
  containerClassName,
  size = 'compact',
  spaceInfo,
  circleName,
  currentVisitCheckedCount,
  currentVisitTotalCount,
  currentVisitPriceInfo,
  currentPhase,
  onPhaseChangeRequest,
  currentVisitItems,
  onBulkStatusChange,
  nextVisitInfo,
}) => {
  const rootClassName = containerClassName
    ? `bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-lg shadow-lg ${containerClassName}`
    : `bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-3 rounded-lg shadow-lg ${
        layoutMode === 'smartphone' && isMapVisible ? 'mx-2' : ''
      }`;
  const labelClassName = size === 'expanded' ? 'text-sm opacity-80' : 'text-xs opacity-80';
  const titleClassName = size === 'expanded' ? 'text-2xl font-bold' : 'text-xl font-bold';
  const circleClassName = size === 'expanded' ? 'text-lg' : 'text-sm';
  const totalClassName = size === 'expanded' ? 'text-xl font-bold' : 'text-lg font-bold';
  const selectClassName =
    size === 'expanded'
      ? 'text-xl font-bold bg-white/20 hover:bg-white/30 rounded-md py-1 px-2 text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors'
      : 'text-lg font-bold bg-white/20 hover:bg-white/30 rounded-md py-1 px-2 text-white appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/50 transition-colors';
  const nextClassName = size === 'expanded' ? 'text-sm opacity-80 mt-1' : 'text-xs opacity-80 mt-1';

  return (
    <div className={rootClassName}>
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
              <span>¥{currentVisitPriceInfo.chargeableTotal.toLocaleString()}</span>
              {currentVisitPriceInfo.plannedTotal !== currentVisitPriceInfo.chargeableTotal && (
                <span className="block text-xs opacity-80">
                  予定額 ¥{currentVisitPriceInfo.plannedTotal.toLocaleString()}
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
          <div className={labelClassName}>フェーズ</div>
          <select
            value={currentPhase}
            onChange={(e) => onPhaseChangeRequest(e.target.value as FocusPhase)}
            className={selectClassName}
            style={{
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='white'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E\")",
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'right 4px center',
              backgroundSize: '16px',
              paddingRight: '24px',
            }}
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
          <div className={nextClassName}>
            次: {nextVisitInfo.spaceInfo} {nextVisitInfo.circleName}
          </div>
        </div>
      </div>
      {currentVisitItems.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-end gap-1.5">
          {bulkStatusOptions.map(({ status, label, activeColor, hoverColor }) => {
            const allMatch = currentVisitItems.every((item) => item.purchaseStatus === status);
            return (
              <button
                key={status}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onBulkStatusChange(status);
                }}
                className={`${layoutMode === 'smartphone' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs'} flex-shrink-0 whitespace-nowrap font-medium rounded transition-colors ${
                  allMatch ? activeColor : `bg-white/10 text-white ${hoverColor}`
                }`}
                title={`${label}に一括変更${allMatch ? '（もう一度押すと未購入に戻す）' : ''}`}
                aria-pressed={allMatch}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

export const FocusModeMapControls: React.FC<FocusModeMapControlsProps> = React.memo(({
  mapZoomLevel,
  mapRotationAngle,
  mapInitialRotationAngle,
  onMapRotationAngleChange,
  mapCenteringMode,
  onMapCenteringModeChange,
}) => (
  <div className="flex items-center gap-2 p-2 bg-white/90 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700 flex-wrap">
    <div className="flex rounded-md overflow-hidden border border-slate-300 dark:border-slate-600">
      <button
        onClick={() => onMapCenteringModeChange('prevToCurrent')}
        className={`text-xs px-2 py-1 ${
          mapCenteringMode === 'prevToCurrent'
            ? 'bg-blue-500 text-white'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
        }`}
      >
        前→現ルート
      </button>
      <button
        onClick={() => onMapCenteringModeChange('currentOnly')}
        className={`text-xs px-2 py-1 ${
          mapCenteringMode === 'currentOnly'
            ? 'bg-blue-500 text-white'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
        }`}
      >
        現在地
      </button>
    </div>

    <div className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-3 text-slate-700 dark:text-slate-300">
      {Math.round(mapZoomLevel)}%
    </div>
    <MapRotationControls
      angle={mapRotationAngle}
      initialAngle={mapInitialRotationAngle}
      onAngleChange={onMapRotationAngleChange}
      showHint={true}
    />
  </div>
));
