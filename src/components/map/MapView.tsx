import React, { useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  ShoppingItem,
  ZoomLevel,
  HallDefinition,
  HallRouteSettings,
  BlockDefinition,
  CellGroup,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../types';
import MapCanvas from './MapCanvas';
import CellItemsPopup from './CellItemsPopup';
import VisitListPanel from './VisitListPanel';
import HallOrderPanel from './HallOrderPanel';
import InsertPositionDialog, { InsertPosition, SmartInsertMode } from './InsertPositionDialog';
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
  onAddNewItem?: (eventDate: string, block: string, number: string) => void;  // 新規アイテム追加（タブ遷移方式、互換用）
  onAddItem?: (item: Omit<ShoppingItem, 'id'> & { purchaseStatus?: import('../../types').PurchaseStatus }) => void;  // 新規アイテム直接追加（ポップアップ方式）
  // 訪問先リストへの位置指定追加
  onAddToExecuteListAtPosition?: (itemId: string, referenceItemId: string, position: 'before' | 'after') => void;
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
    type: string;
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
  smartInsertEnabled?: boolean;
  smartInsertMode?: SmartInsertMode;
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
  onAddItem,
  onAddToExecuteListAtPosition,
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
  smartInsertEnabled = true,
  smartInsertMode = 'card',
}) => {
  void _onMoveToFirst;
  void _onMoveToLast;
  
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [internalIsRouteVisible, setInternalIsRouteVisible] = useState(true);
  const [isVisitListOpen, setIsVisitListOpen] = useState(false);
  const [internalIsHallOrderOpen, setInternalIsHallOrderOpen] = useState(false);
  const [internalSelectedHallId, setInternalSelectedHallId] = useState<string>('all');
  
  // 追加位置選択ダイアログの状態
  const [insertDialogState, setInsertDialogState] = useState<{
    isOpen: boolean;
    item: ShoppingItem | null;
  }>({ isOpen: false, item: null });
  
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
        // 壁ブロックも含めて全てのブロックを処理
        
        // ブロック範囲内かチェック（cellGroups対応）
        if (isCellInBlock(row, col, block)) {
          // ブロック名セルならスキップ（クリックしてもポップアップを出さない）
          if (block.nameCells && block.nameCells.some(nc => nc.row === row && nc.col === col)) {
            continue;
          }
          
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
  
  // ホールの訪問先リストにアイテムを追加するヘルパー
  const addToHallVisitList = useCallback(
    (itemId: string) => {
      const item = items.find(i => i.id === itemId);
      if (!item) return;

      const hallId = getItemHallId(item);
      if (!hallId) return;

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
    },
    [items, getItemHallId, hallRouteSettings, onUpdateHallRouteSettings]
  );

  // 訪問先に追加（近接アイテムがある場合はダイアログ表示）
  const handleAddToVisitList = useCallback(
    (itemId: string) => {
      const item = items.find(i => i.id === itemId);
      if (!item) return;

      // 同ブロック±3以内で訪問先リストに存在するアイテムを検索
      const itemNum = extractNumberFromItemNumber(item.number);
      if (!itemNum) {
        // ナンバー解析できない場合はデフォルト動作
        onAddToExecuteList(itemId);
        addToHallVisitList(itemId);
        return;
      }

      const numValue = parseInt(itemNum, 10);
      const itemBlock = item.block?.trim().toLowerCase() || '';

      const nearbyVisitItems: { item: ShoppingItem; visitIndex: number }[] = [];
      executeModeItemIds.forEach((eid, idx) => {
        const existingItem = items.find(i => i.id === eid);
        if (!existingItem) return;
        const existingBlock = existingItem.block?.trim().toLowerCase() || '';
        if (existingBlock !== itemBlock) return;
        const existingNum = extractNumberFromItemNumber(existingItem.number);
        if (!existingNum) return;
        const existingNumValue = parseInt(existingNum, 10);
        if (Math.abs(existingNumValue - numValue) <= 3) {
          nearbyVisitItems.push({ item: existingItem, visitIndex: idx });
        }
      });

      if (nearbyVisitItems.length === 0 || !onAddToExecuteListAtPosition || !smartInsertEnabled) {
        // 近接アイテムなし or 位置指定コールバック未提供 or スマート挿入OFF → デフォルト動作
        onAddToExecuteList(itemId);
        addToHallVisitList(itemId);
        return;
      }

      // ダイアログを表示
      setInsertDialogState({ isOpen: true, item });
    },
    [onAddToExecuteList, onAddToExecuteListAtPosition, items, executeModeItemIds, addToHallVisitList, smartInsertEnabled]
  );

  // ダイアログからの位置選択を処理
  const handleInsertPositionSelect = useCallback(
    (position: InsertPosition) => {
      const item = insertDialogState.item;
      if (!item) return;

      if (position.type === 'before' || position.type === 'after') {
        if (onAddToExecuteListAtPosition) {
          onAddToExecuteListAtPosition(item.id, position.referenceItemId, position.type);
          addToHallVisitList(item.id);
        }
      } else {
        // hallEnd / listEnd → デフォルト動作（App.tsx側のホール位置計算に任せる）
        // listEnd の場合は末尾追加のための特別処理が必要
        if (position.type === 'listEnd' && onAddToExecuteListAtPosition) {
          // 末尾に追加: 最後のアイテムの after として追加
          if (executeModeItemIds.length > 0) {
            onAddToExecuteListAtPosition(item.id, executeModeItemIds[executeModeItemIds.length - 1], 'after');
          } else {
            onAddToExecuteList(item.id);
          }
          addToHallVisitList(item.id);
        } else {
          onAddToExecuteList(item.id);
          addToHallVisitList(item.id);
        }
      }

      setInsertDialogState({ isOpen: false, item: null });
    },
    [insertDialogState.item, onAddToExecuteList, onAddToExecuteListAtPosition, executeModeItemIds, addToHallVisitList]
  );

  // ダイアログ用の近接アイテムデータを計算
  const insertDialogNearbyItems = useMemo(() => {
    const item = insertDialogState.item;
    if (!item) return [];

    const itemNum = extractNumberFromItemNumber(item.number);
    if (!itemNum) return [];

    const numValue = parseInt(itemNum, 10);
    const itemBlock = item.block?.trim().toLowerCase() || '';

    const result: { item: ShoppingItem; visitIndex: number }[] = [];
    executeModeItemIds.forEach((eid, idx) => {
      const existingItem = items.find(i => i.id === eid);
      if (!existingItem) return;
      const existingBlock = existingItem.block?.trim().toLowerCase() || '';
      if (existingBlock !== itemBlock) return;
      const existingNum = extractNumberFromItemNumber(existingItem.number);
      if (!existingNum) return;
      const existingNumValue = parseInt(existingNum, 10);
      if (Math.abs(existingNumValue - numValue) <= 3) {
        result.push({ item: existingItem, visitIndex: idx });
      }
    });

    return result;
  }, [insertDialogState.item, items, executeModeItemIds]);

  // ダイアログ用のホール定義有無
  const insertDialogHasHall = useMemo(() => {
    const item = insertDialogState.item;
    if (!item) return false;
    return getItemHallId(item) !== null;
  }, [insertDialogState.item, getItemHallId]);

  // ダイアログ用の訪問先リスト全体（preview モード用）
  const insertDialogAllVisitItems = useMemo(() => {
    if (smartInsertMode !== 'preview') return [];
    return executeModeItemIds
      .map((eid, idx) => {
        const item = items.find(i => i.id === eid);
        return item ? { item, visitIndex: idx } : null;
      })
      .filter((v): v is { item: ShoppingItem; visitIndex: number } => v !== null);
  }, [smartInsertMode, executeModeItemIds, items]);
  
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
      
      {/* ズーム率表示ラベル - MapView内左下に固定 */}
      <div className="absolute bottom-4 left-4 z-10">
        <div className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md text-slate-700 dark:text-slate-300 select-none">
          {zoomLevel}%
        </div>
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
        cellSelectionMode={cellSelectionMode}
        highlightedCell={highlightedCell}
        onZoomChange={setZoomLevel}
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
        onAddItem={onAddItem}
        eventDate={mapName.replace(/マップ$/, '')}
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

      {/* 追加位置選択ダイアログ */}
      {insertDialogState.item && (
        <InsertPositionDialog
          isOpen={insertDialogState.isOpen}
          addingItem={insertDialogState.item}
          nearbyVisitItems={insertDialogNearbyItems}
          allVisitItems={insertDialogAllVisitItems}
          hasHallDefinition={insertDialogHasHall}
          mode={smartInsertMode}
          onSelect={handleInsertPositionSelect}
          onCancel={() => setInsertDialogState({ isOpen: false, item: null })}
        />
      )}
    </div>
  );
};

export default MapView;
