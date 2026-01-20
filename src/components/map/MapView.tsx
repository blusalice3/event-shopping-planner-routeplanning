import React, { useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  ShoppingItem,
  ZoomLevel,
  ZOOM_LEVELS,
  HallDefinition,
  HallRouteSettings,
  BlockDefinition,
  CellGroup,
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
  onAddNewItem?: (eventDate: string, block: string, number: string) => void;  // 新規アイテム追加
  // ホール関連
  halls: HallDefinition[];
  hallRouteSettings: HallRouteSettings;
  onUpdateHallRouteSettings: (settings: HallRouteSettings) => void;
  onReorderExecuteList?: (hallOrder: string[]) => void;
  // ホール頂点選択モード
  vertexSelectionMode?: {
    clickedVertices: { row: number; col: number }[];
  } | null;
  // ブロック定義用セル選択モード
  cellSelectionMode?: {
    clickedCells: { row: number; col: number }[];
  } | null;
  // 訪問先リストからのハイライト
  highlightedCell?: { row: number; col: number } | null;
  // 外部制御用props（ヘッダーから制御する場合）
  externalSelectedHallId?: string;
  onSelectedHallIdChange?: (hallId: string) => void;
  externalIsRouteVisible?: boolean;
  onRouteVisibleChange?: (visible: boolean) => void;
  externalIsHallOrderOpen?: boolean;
  onHallOrderOpenChange?: (open: boolean) => void;
  hideInternalControls?: boolean;
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
  onAddNewItem,
  halls,
  hallRouteSettings,
  onUpdateHallRouteSettings,
  onReorderExecuteList,
  vertexSelectionMode,
  cellSelectionMode,
  highlightedCell,
  externalSelectedHallId,
  onSelectedHallIdChange,
  externalIsRouteVisible,
  onRouteVisibleChange,
  externalIsHallOrderOpen,
  onHallOrderOpenChange,
  hideInternalControls = false,
}) => {
  void _onMoveToFirst;
  void _onMoveToLast;
  
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>(100);
  const [internalIsRouteVisible, setInternalIsRouteVisible] = useState(true);
  const [isVisitListOpen, setIsVisitListOpen] = useState(false);
  const [internalIsHallOrderOpen, setInternalIsHallOrderOpen] = useState(false);
  const [internalSelectedHallId, setInternalSelectedHallId] = useState<string>('all');
  
  // 外部制御か内部制御かを判定
  const selectedHallId = externalSelectedHallId !== undefined ? externalSelectedHallId : internalSelectedHallId;
  const setSelectedHallId = onSelectedHallIdChange || setInternalSelectedHallId;
  const isRouteVisible = externalIsRouteVisible !== undefined ? externalIsRouteVisible : internalIsRouteVisible;
  const setIsRouteVisible = onRouteVisibleChange || setInternalIsRouteVisible;
  const isHallOrderOpen = externalIsHallOrderOpen !== undefined ? externalIsHallOrderOpen : internalIsHallOrderOpen;
  const setIsHallOrderOpen = onHallOrderOpenChange || setInternalIsHallOrderOpen;
  
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
    const itemBlockName = item.block?.trim() || '';
    
    // まず完全一致を試みる
    const exactMatch = blockToHallMap.get(itemBlockName);
    if (exactMatch) return exactMatch;
    
    // 完全一致がない場合、大文字/小文字を無視して検索（候補が1つの場合のみ）
    const candidates: string[] = [];
    blockToHallMap.forEach((hallId, blockName) => {
      if (blockName.toLowerCase() === itemBlockName.toLowerCase()) {
        candidates.push(hallId);
      }
    });
    
    if (candidates.length === 1) {
      return candidates[0];
    }
    
    return null;
  }, [blockToHallMap]);

  // グループIDからホールIDと優先度を分離するヘルパー
  const parseGroupId = useCallback((groupId: string | null): { hallId: string | null; priority: 'none' | 'priority' | 'highest' } => {
    if (groupId === null) return { hallId: null, priority: 'none' };
    if (groupId === 'undefined:highest') return { hallId: null, priority: 'highest' };
    if (groupId === 'undefined:priority') return { hallId: null, priority: 'priority' };
    if (groupId.endsWith(':highest')) {
      return { hallId: groupId.replace(':highest', ''), priority: 'highest' };
    }
    if (groupId.endsWith(':priority')) {
      return { hallId: groupId.replace(':priority', ''), priority: 'priority' };
    }
    return { hallId: groupId, priority: 'none' };
  }, []);

  // グループごとの訪問先アイテム数を取得（優先度対応）
  const getItemCountInHall = useCallback((groupId: string): number => {
    const { hallId, priority } = parseGroupId(groupId);
    
    return executeModeItemIds.filter(itemId => {
      const item = items.find(i => i.id === itemId);
      if (!item) return false;
      
      // ホールIDの一致を確認
      const itemHallId = getItemHallId(item);
      if (itemHallId !== hallId) return false;
      
      // 優先度の一致を確認
      const itemPriority = item.priorityLevel || 'none';
      return itemPriority === priority;
    }).length;
  }, [executeModeItemIds, items, getItemHallId, parseGroupId]);

  // ホール内の全優先度の訪問先アイテム数を取得（プルダウン用）
  const getHallTotalExecuteCount = useCallback((hallId: string): number => {
    return executeModeItemIds.filter(itemId => {
      const item = items.find(i => i.id === itemId);
      if (!item) return false;
      
      // ホールIDの一致を確認（優先度は問わない）
      const itemHallId = getItemHallId(item);
      return itemHallId === hallId;
    }).length;
  }, [executeModeItemIds, items, getItemHallId]);

  // ホールごとの全アイテム数を取得
  const getTotalItemCountInHall = useCallback((hallId: string): number => {
    // マップ名から日付を取得
    const dayMatch = mapName.match(/^(.+)マップ$/);
    if (!dayMatch) return 0;
    const dayName = dayMatch[1];
    
    return items.filter(item => {
      if (item.eventDate !== dayName) return false;
      return getItemHallId(item) === hallId;
    }).length;
  }, [items, mapName, getItemHallId]);

  // 選択中のホールに表示するマップデータをフィルタ
  const filteredMapData = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return mapData;
    }
    
    const selectedHall = halls.find(h => h.id === selectedHallId);
    if (!selectedHall || selectedHall.vertices.length < 4) {
      return mapData;
    }
    
    // 選択ホール内のセルのみをフィルタ（表示用）
    const filteredCells = mapData.cells.filter(cell => {
      return isPointInPolygon(cell.row, cell.col, selectedHall.vertices);
    });
    
    // ブロックは全て保持する（アイテムマッチング用）
    // ただし、numberCellsはホール内のセルのみにフィルタ
    const filteredBlocks = mapData.blocks.map(block => {
      const filteredNumberCells = block.numberCells.filter(nc => {
        return isPointInPolygon(nc.row, nc.col, selectedHall.vertices);
      });
      
      // ホール内にセルがないブロックはスキップしない（他の処理のため保持）
      return {
        ...block,
        numberCells: filteredNumberCells.length > 0 ? filteredNumberCells : block.numberCells,
      };
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

  // セルがブロックの範囲内にあるかチェック（cellGroups対応）
  const isCellInBlock = useCallback((row: number, col: number, block: BlockDefinition): boolean => {
    // cellGroupsがある場合（複数範囲ブロックや壁ブロック）
    if (block.cellGroups && block.cellGroups.length > 0) {
      return block.cellGroups.some(group => {
        if (group.type === 'range') {
          return row >= (group.startRow || 0) && row <= (group.endRow || 0) &&
                 col >= (group.startCol || 0) && col <= (group.endCol || 0);
        } else if (group.type === 'individual' && group.cells) {
          return group.cells.some(c => c.row === row && c.col === col);
        }
        return false;
      });
    }
    // 通常の矩形ブロック
    return row >= block.startRow && row <= block.endRow &&
           col >= block.startCol && col <= block.endCol;
  }, []);

  // セルクリック時のハンドラ
  const handleCellClick = useCallback(
    (row: number, col: number, matchingItems: ShoppingItem[]) => {
      // ブロック定義・ホール定義モード中はアイテムポップアップを表示しない
      if (vertexSelectionMode || cellSelectionMode) return;
      
      // セルがブロック定義内にあるかチェック
      let foundBlock: { name: string; number: number } | null = null;
      
      for (const block of mapData.blocks) {
        if (block.isWallBlock) continue;
        
        // ブロック範囲内かチェック（cellGroups対応）
        if (isCellInBlock(row, col, block)) {
          // 数値セルを探す（numberCells配列から）
          const numberCell = block.numberCells.find(nc => nc.row === row && nc.col === col);
          if (numberCell) {
            foundBlock = { name: block.name, number: numberCell.value };
            break;
          }
          
          // numberCellsに見つからない場合、セルの内容が数値かチェック（ユーザー定義ブロック対応）
          if (!foundBlock) {
            // まずクリック位置のセルを探す
            let cell = mapData.cells.find(c => c.row === row && c.col === col);
            
            // セルが見つからない場合、結合セル内かチェック
            if (!cell) {
              // 結合セルの開始位置を探す
              for (const merge of mapData.mergedCells) {
                if (row >= merge.startRow && row <= merge.endRow &&
                    col >= merge.startCol && col <= merge.endCol) {
                  cell = mapData.cells.find(c => c.row === merge.startRow && c.col === merge.startCol);
                  break;
                }
              }
            }
            
            if (cell && cell.value !== null && cell.value !== undefined) {
              const cellValue = String(cell.value).trim();
              const numMatch = cellValue.match(/^(\d+)/);
              if (numMatch) {
                foundBlock = { name: block.name, number: parseInt(numMatch[1], 10) };
                break;
              }
            }
          }
        }
      }
      
      // ブロック定義内でない場合かつアイテムもない場合は何もしない
      if (!foundBlock && matchingItems.length === 0) return;
      
      const position = {
        x: window.innerWidth / 2 - 160,
        y: window.innerHeight / 3,
      };
      
      if (foundBlock) {
        // ブロック定義内のセル
        setPopupState({
          isOpen: true,
          row,
          col,
          blockName: foundBlock.name,
          number: foundBlock.number,
          items: matchingItems,
          position,
        });
      } else if (matchingItems.length > 0) {
        // ブロック定義外だがアイテムがある場合（既存動作）
        const firstItem = matchingItems[0];
        const numStr = extractNumberFromItemNumber(firstItem.number);
        const numValue = numStr ? parseInt(numStr, 10) : 0;
        
        setPopupState({
          isOpen: true,
          row,
          col,
          blockName: firstItem.block,
          number: numValue,
          items: matchingItems,
          position,
        });
      }
    },
    [mapData.blocks, mapData.cells, mapData.mergedCells, vertexSelectionMode, cellSelectionMode, isCellInBlock]
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
      {/* ツールバー - MapView内に固定（外部制御時は非表示） */}
      {!hideInternalControls && (
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
                  {hall.name} ({getHallTotalExecuteCount(hall.id)}/{getTotalItemCountInHall(hall.id)}件)
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
      )}
      
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
        highlightedCell={highlightedCell}
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
        onAddNewItem={onAddNewItem ? () => {
          // マップ名から参加日を抽出（例: "1日目マップ" -> "1日目"）
          const eventDate = mapName.replace(/マップ$/, '');
          onAddNewItem(eventDate, popupState.blockName, String(popupState.number));
        } : undefined}
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
        onReorderExecuteList={onReorderExecuteList}
      />
    </div>
  );
};

export default MapView;
