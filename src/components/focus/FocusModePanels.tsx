import React from 'react';
import { HallDefinition, ShoppingItem } from '../../types';
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
  onUpdateItem: (item: ShoppingItem) => void;
  onEditRequest?: (item: ShoppingItem) => void;
  onDeleteRequest?: (item: ShoppingItem) => void;
  onAddItem?: () => void;
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
    allUndefined: boolean;
    undefinedCount: number;
    totalPrice: number;
  };
  currentPhase: FocusPhase;
  onPhaseChangeRequest: (phase: FocusPhase) => void;
  nextVisitInfo: {
    spaceInfo: string;
    circleName: string;
  };
}

interface FocusModeMapControlsProps {
  selectedHallId: string | 'follow';
  onSelectedHallIdChange: (value: string | 'follow') => void;
  hallDefinitions?: HallDefinition[];
  mapZoomLevel: number;
  mapRotationAngle: number;
  mapInitialRotationAngle: number;
  onMapRotationAngleChange: (angle: number) => void;
}

export const FocusModeItemList: React.FC<FocusModeItemListProps> = React.memo(({
  itemListRef,
  layoutMode,
  isMapVisible,
  containerClassName,
  currentVisitDisplayItems,
  blinkingPriceItemIds,
  onUpdateItem,
  onEditRequest,
  onDeleteRequest,
  onAddItem,
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
        className={`relative ${blinkingPriceItemIds.has(item.id) ? 'animate-pulse ring-2 ring-red-500 rounded-lg' : ''}`}
      >
        <ShoppingItemCard
          item={item}
          onUpdate={onUpdateItem}
          isStriped={index % 2 === 1}
          onEditRequest={onEditRequest || (() => {})}
          onDeleteRequest={onDeleteRequest || (() => {})}
          isSelected={false}
          onSelectItem={() => {}}
          layoutMode={layoutMode}
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
            <div className={labelClassName}>総額</div>
            <div className={totalClassName}>
              {currentVisitPriceInfo.allUndefined ? (
                <span className="text-red-400">価格未定</span>
              ) : currentVisitPriceInfo.undefinedCount > 0 ? (
                <>
                  <span>¥{currentVisitPriceInfo.totalPrice.toLocaleString()}</span>
                  <span className="text-red-400">
                    +未定{currentVisitPriceInfo.undefinedCount}件
                  </span>
                </>
              ) : (
                <span>¥{currentVisitPriceInfo.totalPrice.toLocaleString()}</span>
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
    </div>
  );
});

export const FocusModeMapControls: React.FC<FocusModeMapControlsProps> = React.memo(({
  selectedHallId,
  onSelectedHallIdChange,
  hallDefinitions,
  mapZoomLevel,
  mapRotationAngle,
  mapInitialRotationAngle,
  onMapRotationAngleChange,
}) => (
  <div className="flex items-center gap-2 p-2 bg-white/90 dark:bg-slate-800/90 border-b border-slate-200 dark:border-slate-700 flex-wrap">
    <select
      value={selectedHallId}
      onChange={(e) => onSelectedHallIdChange(e.target.value as string | 'follow')}
      className="text-sm bg-slate-100 dark:bg-slate-700 rounded-md py-1 px-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
    >
      <option value="follow">追随モードON</option>
      {hallDefinitions?.map((hall) => (
        <option key={hall.id} value={hall.id}>
          {hall.name}
        </option>
      ))}
    </select>

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
