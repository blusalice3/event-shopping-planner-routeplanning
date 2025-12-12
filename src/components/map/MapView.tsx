import React, { useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  ShoppingItem,
  ZoomLevel,
  ZOOM_LEVELS,
} from '../../types';
import MapCanvas from './MapCanvas';
import CellItemsPopup from './CellItemsPopup';
import VisitListPanel from './VisitListPanel';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';

interface MapViewProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  onAddToExecuteList: (itemId: string) => void;
  onRemoveFromExecuteList: (itemId: string) => void;
  onMoveToFirst: (itemId: string) => void;
  onMoveToLast: (itemId: string) => void;
}

const MapView: React.FC<MapViewProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds,
  onAddToExecuteList,
  onRemoveFromExecuteList,
  onMoveToFirst: _onMoveToFirst,
  onMoveToLast: _onMoveToLast,
}) => {
  // 将来の機能のために保持: _onMoveToFirst, _onMoveToLast
  void _onMoveToFirst;
  void _onMoveToLast;
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(100);
  const [isRouteVisible, setIsRouteVisible] = useState(true);
  const [isVisitListOpen, setIsVisitListOpen] = useState(false);
  
  // ポップアップの状態
  const [popupState, setPopupState] = useState<{
    isOpen: boolean;
    row: number;
    col: number;
    blockName: string;
    number: number;
    items: ShoppingItem[];
    position: { x: number; y: number };
  }>({
    isOpen: false,
    row: 0,
    col: 0,
    blockName: '',
    number: 0,
    items: [],
    position: { x: 0, y: 0 },
  });
  
  const executeModeItemIdsSet = useMemo(
    () => new Set(executeModeItemIds),
    [executeModeItemIds]
  );
  
  // セルクリック時のハンドラ
  const handleCellClick = useCallback(
    (row: number, col: number, matchingItems: ShoppingItem[]) => {
      if (matchingItems.length === 0) return;
      
      // ブロック名とナンバーを取得
      const firstItem = matchingItems[0];
      const block = mapData.blocks.find((b) => b.name === firstItem.block);
      if (!block) return;
      
      const numStr = extractNumberFromItemNumber(firstItem.number);
      const numValue = parseInt(numStr, 10);
      
      // クリック位置を取得（簡易的にウィンドウ中央付近に表示）
      const position = {
        x: window.innerWidth / 2 - 160,
        y: window.innerHeight / 3,
      };
      
      setPopupState({
        isOpen: true,
        row,
        col,
        blockName: firstItem.block,
        number: numValue,
        items: matchingItems,
        position,
      });
    },
    [mapData.blocks]
  );
  
  const handleClosePopup = useCallback(() => {
    setPopupState((prev) => ({ ...prev, isOpen: false }));
  }, []);
  
  const handleAddToVisitList = useCallback(
    (itemId: string) => {
      onAddToExecuteList(itemId);
    },
    [onAddToExecuteList]
  );
  
  const handleRemoveFromVisitList = useCallback(
    (itemId: string) => {
      onRemoveFromExecuteList(itemId);
    },
    [onRemoveFromExecuteList]
  );
  
  const handleJumpToCell = useCallback((_row: number, _col: number) => {
    // TODO: マップをスクロールしてセルにジャンプ
    // _row, _col は将来の実装で使用予定
    void _row;
    void _col;
    setIsVisitListOpen(false);
  }, []);
  
  return (
    <div className="relative h-full">
      {/* ツールバー */}
      <div className="absolute top-4 right-4 z-30 flex items-center gap-3">
        {/* ルート表示トグル */}
        <label className="flex items-center gap-2 bg-white dark:bg-slate-800 px-3 py-2 rounded-lg shadow-md">
          <span className="text-sm text-slate-700 dark:text-slate-300">ルート表示</span>
          <button
            onClick={() => setIsRouteVisible(!isRouteVisible)}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              isRouteVisible ? 'bg-red-500' : 'bg-slate-300 dark:bg-slate-600'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                isRouteVisible ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </label>
      </div>
      
      {/* ズームコントロール（左下） */}
      <div className="absolute bottom-4 left-4 z-30">
        <select
          value={zoomLevel}
          onChange={(e) => setZoomLevel(Number(e.target.value) as ZoomLevel)}
          className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {ZOOM_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}%
            </option>
          ))}
        </select>
      </div>
      
      {/* マップキャンバス */}
      <MapCanvas
        mapData={mapData}
        mapName={mapName}
        items={items}
        executeModeItemIds={executeModeItemIdsSet}
        zoomLevel={zoomLevel}
        isRouteVisible={isRouteVisible}
        onCellClick={handleCellClick}
      />
      
      {/* セルアイテムポップアップ */}
      <CellItemsPopup
        isOpen={popupState.isOpen}
        onClose={handleClosePopup}
        blockName={popupState.blockName}
        number={popupState.number}
        items={popupState.items}
        executeModeItemIds={executeModeItemIdsSet}
        onAddToVisitList={handleAddToVisitList}
        onRemoveFromVisitList={handleRemoveFromVisitList}
        position={popupState.position}
      />
      
      {/* 訪問先リストパネル */}
      <VisitListPanel
        isOpen={isVisitListOpen}
        onClose={() => setIsVisitListOpen(false)}
        items={items}
        executeModeItemIds={executeModeItemIds}
        blocks={mapData.blocks}
        onJumpToCell={handleJumpToCell}
      />
    </div>
  );
};

export default MapView;
