import React, { useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  ShoppingItem,
  ZoomLevel,
  ZOOM_LEVELS,
  HallDefinition,
  HallRouteSettings,
} from '../../types';
import MapCanvas from './MapCanvas';
import CellItemsPopup from './CellItemsPopup';
import VisitListPanel from './VisitListPanel';
import HallOrderPanel from './HallOrderPanel';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';
import { isPointInPolygon } from './HallDefinitionPanel';

interface MapViewProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  onAddToExecuteList: (itemId: string) => void;
  onRemoveFromExecuteList: (itemId: string) => void;
  onMoveToFirst: (itemId: string) => void;
  onMoveToLast: (itemId: string) => void;
  onUpdateItem?: (item: ShoppingItem) => void;
  onDeleteItem?: (itemId: string) => void;
  // ホール関連
  halls: HallDefinition[];
  hallRouteSettings: HallRouteSettings;
  onUpdateHallRouteSettings: (settings: HallRouteSettings) => void;
  // ホール頂点選択モード
  vertexSelectionMode?: {
    clickedVertices: { row: number; col: number }[];
  } | null;
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
  onUpdateItem,
  onDeleteItem,
  halls,
  hallRouteSettings,
  onUpdateHallRouteSettings,
  vertexSelectionMode,
}) => {
  void _onMoveToFirst;
  void _onMoveToLast;
  
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(100);
  const [isRouteVisible, setIsRouteVisible] = useState(true);
  const [isVisitListOpen, setIsVisitListOpen] = useState(false);
  const [isHallOrderOpen, setIsHallOrderOpen] = useState(false);
  const [selectedHallId, setSelectedHallId] = useState<string>('all'); // 'all' または ホールID
  
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

  // ブロックがどのホールに属するか判定
  const blockToHallMap = useMemo(() => {
    const map = new Map<string, string>(); // blockName -> hallId
    
    mapData.blocks.forEach(block => {
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;
      
      for (const hall of halls) {
        if (hall.vertices.length >= 4 && isPointInPolygon(centerRow, centerCol, hall.vertices)) {
          map.set(block.name, hall.id);
          break;
        }
      }
    });
    
    return map;
  }, [mapData.blocks, halls]);

  // アイテムがどのホールに属するか判定
  const getItemHallId = useCallback((item: ShoppingItem): string | null => {
    return blockToHallMap.get(item.block) || null;
  }, [blockToHallMap]);

  // ホールごとの訪問先アイテム数を取得
  const getItemCountInHall = useCallback((hallId: string): number => {
    return executeModeItemIds.filter(itemId => {
      const item = items.find(i => i.id === itemId);
      if (!item) return false;
      return getItemHallId(item) === hallId;
    }).length;
  }, [executeModeItemIds, items, getItemHallId]);

  // 選択中のホールに表示するマップデータをフィルタ
  const filteredMapData = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return mapData;
    }
    
    const selectedHall = halls.find(h => h.id === selectedHallId);
    if (!selectedHall || selectedHall.vertices.length < 4) {
      return mapData;
    }
    
    // 選択ホール内のセルのみをフィルタ
    const filteredCells = mapData.cells.filter(cell => {
      return isPointInPolygon(cell.row, cell.col, selectedHall.vertices);
    });
    
    // 選択ホール内のブロックのみをフィルタ
    const filteredBlocks = mapData.blocks.filter(block => {
      const centerRow = (block.startRow + block.endRow) / 2;
      const centerCol = (block.startCol + block.endCol) / 2;
      return isPointInPolygon(centerRow, centerCol, selectedHall.vertices);
    });
    
    // 範囲を再計算
    let minRow = Infinity, maxRow = 0, minCol = Infinity, maxCol = 0;
    filteredCells.forEach(cell => {
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minCol = Math.min(minCol, cell.col);
      maxCol = Math.max(maxCol, cell.col);
    });
    
    return {
      ...mapData,
      cells: filteredCells,
      blocks: filteredBlocks,
      maxRow: maxRow > 0 ? maxRow : mapData.maxRow,
      maxCol: maxCol > 0 ? maxCol : mapData.maxCol,
    };
  }, [mapData, selectedHallId, halls]);

  // 選択中のホール内のアイテムのみをフィルタ
  const filteredItems = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return items;
    }
    
    return items.filter(item => getItemHallId(item) === selectedHallId);
  }, [items, selectedHallId, halls, getItemHallId]);

  // 選択中のホール内の訪問先IDのみをフィルタ
  const filteredExecuteModeItemIds = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return executeModeItemIds;
    }
    
    return executeModeItemIds.filter(itemId => {
      const item = items.find(i => i.id === itemId);
      if (!item) return false;
      return getItemHallId(item) === selectedHallId;
    });
  }, [executeModeItemIds, items, selectedHallId, halls, getItemHallId]);

  // セルクリック時のハンドラ
  const handleCellClick = useCallback(
    (row: number, col: number, matchingItems: ShoppingItem[]) => {
      if (matchingItems.length === 0) return;
      
      const firstItem = matchingItems[0];
      const block = mapData.blocks.find((b) => b.name === firstItem.block);
      if (!block) return;
      
      const numStr = extractNumberFromItemNumber(firstItem.number);
      const numValue = numStr ? parseInt(numStr, 10) : 0;
      
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
  
  // 訪問先に追加（ホールの訪問先リストにも追加）
  const handleAddToVisitList = useCallback(
    (itemId: string) => {
      onAddToExecuteList(itemId);
      
      // ホールの訪問先リストにも追加
      const item = items.find(i => i.id === itemId);
      if (item) {
        const hallId = getItemHallId(item);
        if (hallId) {
          const updatedHallVisitLists = [...hallRouteSettings.hallVisitLists];
          const hallListIndex = updatedHallVisitLists.findIndex(l => l.hallId === hallId);
          
          if (hallListIndex >= 0) {
            if (!updatedHallVisitLists[hallListIndex].itemIds.includes(itemId)) {
              updatedHallVisitLists[hallListIndex] = {
                ...updatedHallVisitLists[hallListIndex],
                itemIds: [...updatedHallVisitLists[hallListIndex].itemIds, itemId],
              };
            }
          } else {
            updatedHallVisitLists.push({ hallId, itemIds: [itemId] });
          }
          
          onUpdateHallRouteSettings({
            ...hallRouteSettings,
            hallVisitLists: updatedHallVisitLists,
          });
        }
      }
    },
    [onAddToExecuteList, items, getItemHallId, hallRouteSettings, onUpdateHallRouteSettings]
  );
  
  // 訪問先から除外
  const handleRemoveFromVisitList = useCallback(
    (itemId: string) => {
      onRemoveFromExecuteList(itemId);
      
      // ホールの訪問先リストからも削除
      const updatedHallVisitLists = hallRouteSettings.hallVisitLists.map(list => ({
        ...list,
        itemIds: list.itemIds.filter(id => id !== itemId),
      }));
      
      onUpdateHallRouteSettings({
        ...hallRouteSettings,
        hallVisitLists: updatedHallVisitLists,
      });
    },
    [onRemoveFromExecuteList, hallRouteSettings, onUpdateHallRouteSettings]
  );
  
  const handleJumpToCell = useCallback((_row: number, _col: number) => {
    void _row;
    void _col;
    setIsVisitListOpen(false);
  }, []);
  
  return (
    <div 
      className="relative bg-slate-100 dark:bg-slate-900 overflow-hidden"
      style={{ height: 'calc(100vh - 140px)' }}
    >
      {/* ツールバー - MapView内に固定 */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-3">
        {/* ホール選択ドロップダウン */}
        {halls.length > 0 && (
          <select
            value={selectedHallId}
            onChange={(e) => setSelectedHallId(e.target.value)}
            className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">全ホール</option>
            {halls.map((hall) => (
              <option key={hall.id} value={hall.id}>
                {hall.name} ({getItemCountInHall(hall.id)}件)
              </option>
            ))}
          </select>
        )}
        
        {/* ホール順序設定ボタン */}
        {halls.length > 0 && (
          <button
            onClick={() => setIsHallOrderOpen(true)}
            className="bg-white dark:bg-slate-800 px-3 py-2 rounded-lg shadow-md border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
          >
            🔄 ホール順序
          </button>
        )}
        
        {/* ルート表示トグル */}
        <label className="flex items-center gap-2 bg-white dark:bg-slate-800 px-3 py-2 rounded-lg shadow-md border border-slate-200 dark:border-slate-700">
          <span className="text-sm text-slate-700 dark:text-slate-300">ルート表示</span>
          <button
            onClick={() => setIsRouteVisible(!isRouteVisible)}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              isRouteVisible ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-600'
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
      
      {/* ズームコントロール - MapView内左下に固定 */}
      <div className="absolute bottom-4 left-4 z-10">
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
        mapData={filteredMapData}
        mapName={mapName}
        items={filteredItems}
        executeModeItemIds={filteredExecuteModeItemIds}
        zoomLevel={zoomLevel}
        isRouteVisible={isRouteVisible && (halls.length === 0 || selectedHallId !== 'all')}
        onCellClick={handleCellClick}
        selectedHall={selectedHallId !== 'all' ? halls.find(h => h.id === selectedHallId) : undefined}
        vertexSelectionMode={vertexSelectionMode}
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
        onUpdateItem={onUpdateItem}
        onDeleteItem={onDeleteItem}
        position={popupState.position}
      />
      
      {/* 訪問先リストパネル */}
      <VisitListPanel
        isOpen={isVisitListOpen}
        onClose={() => setIsVisitListOpen(false)}
        items={filteredItems}
        executeModeItemIds={filteredExecuteModeItemIds}
        blocks={filteredMapData.blocks}
        onJumpToCell={handleJumpToCell}
      />
      
      {/* ホール順序設定パネル */}
      <HallOrderPanel
        isOpen={isHallOrderOpen}
        onClose={() => setIsHallOrderOpen(false)}
        halls={halls}
        hallRouteSettings={hallRouteSettings}
        onUpdateHallRouteSettings={onUpdateHallRouteSettings}
        getItemCountInHall={getItemCountInHall}
      />
    </div>
  );
};

export default MapView;
