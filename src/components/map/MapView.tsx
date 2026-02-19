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

const normalizeDisplayText = (value: string | null | undefined): string => {
  return (value || '').replace(/\u3000/g, ' ').trim();
};

const extractDayNameFromMapName = (mapName: string): string => {
  const normalizedMapName = normalizeDisplayText(mapName);
  const dayMatch = normalizedMapName.match(/^(.+)マップ$/);
  return dayMatch ? normalizeDisplayText(dayMatch[1]) : '';
};

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
  onAddNewItem?: (eventDate: string, block: string, number: string) => void;
  onAddItem?: (
    item: Omit<ShoppingItem, 'id'> & { purchaseStatus?: import('../../types').PurchaseStatus },
  ) => void;
  onAddToExecuteListAtPosition?: (
    itemId: string,
    referenceItemId: string,
    position: 'before' | 'after',
  ) => void;

  // ホール定義と訪問順設定
  halls: HallDefinition[];
  hallRouteSettings: HallRouteSettings;
  onUpdateHallRouteSettings: (settings: HallRouteSettings) => void;
  onReorderExecuteList?: (hallOrder: string[]) => void;

  // ホール頂点選択モード（ホール定義パネル連携）
  vertexSelectionMode?: {
    clickedVertices: { row: number; col: number }[];
  } | null;

  // セル選択モード（ブロック定義パネル連携）
  cellSelectionMode?: {
    type: string;
    clickedCells: { row: number; col: number }[];
  } | null;

  // 外部から指定された強調セル（訪問リストとの連携）
  highlightedCell?: { row: number; col: number } | null;

  // 親コンポーネントから制御するための外部状態
  externalSelectedHallId?: string;
  onSelectedHallIdChange?: (hallId: string) => void;
  externalIsRouteVisible?: boolean;
  onRouteVisibleChange?: (visible: boolean) => void;
  externalIsHallOrderOpen?: boolean;
  onHallOrderOpenChange?: (open: boolean) => void;
  hideInternalControls?: boolean;
  smartInsertEnabled?: boolean;
  smartInsertMode?: SmartInsertMode;
  rotationAngle?: number;
  onRotationAngleChange?: (newAngle: number) => void;
  selectionGuideOptions?: {
    showGrid: boolean;
    showRuler: boolean;
  };
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
  rotationAngle = 0,
  onRotationAngleChange,
  selectionGuideOptions,
}) => {
  void _onMoveToFirst;
  void _onMoveToLast;

  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [internalIsRouteVisible, setInternalIsRouteVisible] = useState(true);
  const [isVisitListOpen, setIsVisitListOpen] = useState(false);
  const [internalIsHallOrderOpen, setInternalIsHallOrderOpen] = useState(false);
  const [internalSelectedHallId, setInternalSelectedHallId] = useState<string>('all');

  // 追加位置選択ダイアログの表示状態
  const [insertDialogState, setInsertDialogState] = useState<{
    isOpen: boolean;
    item: ShoppingItem | null;
  }>({ isOpen: false, item: null });

  // 外部制御が渡されていればそれを優先し、未指定時は内部 state を使う
  const selectedHallId =
    externalSelectedHallId !== undefined ? externalSelectedHallId : internalSelectedHallId;
  const setSelectedHallId = onSelectedHallIdChange || setInternalSelectedHallId;
  const isRouteVisible =
    externalIsRouteVisible !== undefined ? externalIsRouteVisible : internalIsRouteVisible;
  const setIsRouteVisible = onRouteVisibleChange || setInternalIsRouteVisible;
  const isHallOrderOpen =
    externalIsHallOrderOpen !== undefined ? externalIsHallOrderOpen : internalIsHallOrderOpen;
  const setIsHallOrderOpen = onHallOrderOpenChange || setInternalIsHallOrderOpen;

  // セルクリック時に表示するポップアップの状態
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

  const executeModeItemIdsSet = useMemo(() => new Set(executeModeItemIds), [executeModeItemIds]);
  const mapDayName = useMemo(() => extractDayNameFromMapName(mapName), [mapName]);

  // 指定セルが属するホールIDをすべて取得する（重なり・境界を考慮）
  const getHallIdsByCellPosition = useCallback(
    (row: number, col: number): string[] => {
      const ids: string[] = [];
      for (const hall of halls) {
        if (hall.vertices.length >= 4 && isPointInPolygon(row, col, hall.vertices)) {
          ids.push(hall.id);
        }
      }
      return ids;
    },
    [halls],
  );

  // アイテムの block 名に対応するブロック候補を取得する
  const getCandidateBlocksForItem = useCallback(
    (itemBlockName: string): BlockDefinition[] => {
      if (!itemBlockName) return [];

      const exactMatches = mapData.blocks.filter((block) => block.name === itemBlockName);
      if (exactMatches.length > 0) {
        return exactMatches;
      }

      const normalizedBlockName = itemBlockName.toLowerCase();
      return mapData.blocks.filter((block) => block.name.toLowerCase() === normalizedBlockName);
    },
    [mapData.blocks],
  );

  // アイテムが属し得るホールID候補を取得する
  const getHallCandidatesForItem = useCallback(
    (item: ShoppingItem): Set<string> => {
      const hallIds = new Set<string>();
      const itemBlockName = item.block?.trim() || '';
      const candidateBlocks = getCandidateBlocksForItem(itemBlockName);
      if (candidateBlocks.length === 0) return hallIds;

      const numStr = extractNumberFromItemNumber(item.number);
      if (numStr) {
        const numValue = parseInt(numStr, 10);
        candidateBlocks.forEach((block) => {
          block.numberCells.forEach((numberCell) => {
            if (numberCell.value !== numValue) return;
            const matchedHallIds = getHallIdsByCellPosition(numberCell.row, numberCell.col);
            matchedHallIds.forEach((matchedHallId) => hallIds.add(matchedHallId));
          });
        });
      }

      if (hallIds.size > 0) {
        return hallIds;
      }

      // 番号セル単体で判定できない場合、ブロック全体の番号セルからホールを一意推定する
      candidateBlocks.forEach((block) => {
        const blockHallIds = new Set<string>();
        block.numberCells.forEach((numberCell) => {
          const matchedHallIds = getHallIdsByCellPosition(numberCell.row, numberCell.col);
          matchedHallIds.forEach((matchedHallId) => blockHallIds.add(matchedHallId));
        });

        if (blockHallIds.size === 1) {
          blockHallIds.forEach((hallId) => hallIds.add(hallId));
        }
      });

      if (hallIds.size > 0) {
        return hallIds;
      }

      // 数値セルから判定できない場合のみ中心座標でフォールバック
      candidateBlocks.forEach((block) => {
        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;
        const matchedHallIds = getHallIdsByCellPosition(centerRow, centerCol);
        matchedHallIds.forEach((matchedHallId) => hallIds.add(matchedHallId));
      });

      return hallIds;
    },
    [getCandidateBlocksForItem, getHallIdsByCellPosition],
  );

  // アイテムが指定ホールに属するか（候補が複数でも true を返す）
  const isItemInHall = useCallback(
    (item: ShoppingItem, hallId: string): boolean => {
      return getHallCandidatesForItem(item).has(hallId);
    },
    [getHallCandidatesForItem],
  );

  // アイテムが属するホールを判定する
  // 1. block + number の実セル座標で判定
  // 2. 判定不能時のみ中心座標でフォールバック
  const getItemHallId = useCallback(
    (item: ShoppingItem): string | null => {
      const hallCandidates = getHallCandidatesForItem(item);
      if (hallCandidates.size === 1) {
        return Array.from(hallCandidates)[0];
      }
      if (hallCandidates.size > 1 && selectedHallId !== 'all' && hallCandidates.has(selectedHallId)) {
        return selectedHallId;
      }
      return null;
    },
    [getHallCandidatesForItem, selectedHallId],
  );

  // ホールIDと優先度をまとめた groupId を分解する
  const parseGroupId = useCallback(
    (
      groupId: string | null,
    ): { hallId: string | null; priority: 'none' | 'priority' | 'highest' } => {
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
    },
    [],
  );

  // 指定グループ（ホール + 優先度）に属する訪問先件数
  const getItemCountInHall = useCallback(
    (groupId: string): number => {
      const { hallId, priority } = parseGroupId(groupId);

      return executeModeItemIds.filter((itemId) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return false;

        const belongsToHall =
          hallId === null ? getItemHallId(item) === null : isItemInHall(item, hallId);
        if (!belongsToHall) return false;

        const itemPriority = item.priorityLevel || 'none';
        return itemPriority === priority;
      }).length;
    },
    [executeModeItemIds, items, getItemHallId, isItemInHall, parseGroupId],
  );

  // ホール内の訪問先件数（優先度を問わない）
  const getHallTotalExecuteCount = useCallback(
    (hallId: string): number => {
      return executeModeItemIds.filter((itemId) => {
        const item = items.find((i) => i.id === itemId);
        if (!item) return false;

        return isItemInHall(item, hallId);
      }).length;
    },
    [executeModeItemIds, items, isItemInHall],
  );

  // 現在日付タブにおけるホール内の総アイテム件数
  const getTotalItemCountInHall = useCallback(
    (hallId: string): number => {
      return items.filter((item) => {
        if (mapDayName && normalizeDisplayText(item.eventDate) !== mapDayName) return false;
        return isItemInHall(item, hallId);
      }).length;
    },
    [items, mapDayName, isItemInHall],
  );

  // 選択中ホールに合わせて表示用マップを絞り込む
  // blocks はマッチング互換のため残しつつ、numberCells はホール内優先で絞る
  const filteredMapData = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return mapData;
    }

    const selectedHall = halls.find((h) => h.id === selectedHallId);
    if (!selectedHall || selectedHall.vertices.length < 4) {
      return mapData;
    }

    const filteredCells = mapData.cells.filter((cell) => {
      return isPointInPolygon(cell.row, cell.col, selectedHall.vertices);
    });
    const filteredBlocks = mapData.blocks.map((block) => {
      const filteredNumberCells = block.numberCells.filter((nc) => {
        return isPointInPolygon(nc.row, nc.col, selectedHall.vertices);
      });

      return {
        ...block,
        numberCells: filteredNumberCells.length > 0 ? filteredNumberCells : block.numberCells,
      };
    });

    let minRow = Infinity,
      maxRow = 0,
      minCol = Infinity,
      maxCol = 0;
    filteredCells.forEach((cell) => {
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

  // 選択中ホールに属するアイテムだけを表示対象にする
  const filteredItems = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return items;
    }

    return items.filter((item) => isItemInHall(item, selectedHallId));
  }, [items, selectedHallId, halls, isItemInHall]);

  // 実行列IDも選択中ホールに合わせて絞り込む
  const filteredExecuteModeItemIds = useMemo(() => {
    if (selectedHallId === 'all' || halls.length === 0) {
      return executeModeItemIds;
    }

    return executeModeItemIds.filter((itemId) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return false;
      return isItemInHall(item, selectedHallId);
    });
  }, [executeModeItemIds, items, selectedHallId, halls, isItemInHall]);

  // セルがブロック範囲内か判定する（cellGroups 対応）
  const isCellInBlock = useCallback((row: number, col: number, block: BlockDefinition): boolean => {

    if (block.cellGroups && block.cellGroups.length > 0) {
      return block.cellGroups.some((group) => {
        if (group.type === 'range') {
          return (
            row >= (group.startRow || 0) &&
            row <= (group.endRow || 0) &&
            col >= (group.startCol || 0) &&
            col <= (group.endCol || 0)
          );
        } else if (group.type === 'individual' && group.cells) {
          return group.cells.some((c) => c.row === row && c.col === col);
        }
        return false;
      });
    }

    return (
      row >= block.startRow && row <= block.endRow && col >= block.startCol && col <= block.endCol
    );
  }, []);

  // セルクリック時: 対象ブロックと番号を解決してポップアップを開く
  const handleCellClick = useCallback(
    (row: number, col: number, matchingItems: ShoppingItem[]) => {

      if (vertexSelectionMode || cellSelectionMode) return;

      let foundBlock: { name: string; number: number } | null = null;

      for (const block of mapData.blocks) {
        if (isCellInBlock(row, col, block)) {

          if (block.nameCells && block.nameCells.some((nc) => nc.row === row && nc.col === col)) {
            continue;
          }

          const numberCell = block.numberCells.find((nc) => nc.row === row && nc.col === col);
          if (numberCell) {
            foundBlock = { name: block.name, number: numberCell.value };
            break;
          }

          if (!foundBlock) {

            let cell = mapData.cells.find((c) => c.row === row && c.col === col);

            if (!cell) {

              for (const merge of mapData.mergedCells) {
                if (
                  row >= merge.startRow &&
                  row <= merge.endRow &&
                  col >= merge.startCol &&
                  col <= merge.endCol
                ) {
                  cell = mapData.cells.find(
                    (c) => c.row === merge.startRow && c.col === merge.startCol,
                  );
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

      if (!foundBlock && matchingItems.length === 0) return;

      const position = {
        x: window.innerWidth / 2 - 160,
        y: window.innerHeight / 3,
      };

      if (foundBlock) {
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
    [
      mapData.blocks,
      mapData.cells,
      mapData.mergedCells,
      vertexSelectionMode,
      cellSelectionMode,
      isCellInBlock,
    ],
  );

  const handleClosePopup = useCallback(() => {
    setPopupState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // ホール別訪問リストへアイテムIDを同期する
  const addToHallVisitList = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const hallId = getItemHallId(item);
      if (!hallId) return;

      const updatedHallVisitLists = [...hallRouteSettings.hallVisitLists];
      const hallListIndex = updatedHallVisitLists.findIndex((l) => l.hallId === hallId);

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
    [items, getItemHallId, hallRouteSettings, onUpdateHallRouteSettings],
  );

  const handleAddToVisitList = useCallback(
    (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      if (!item) return;

      const itemNum = extractNumberFromItemNumber(item.number);
      if (!itemNum) {
        onAddToExecuteList(itemId);
        addToHallVisitList(itemId);
        return;
      }

      const numValue = parseInt(itemNum, 10);
      const itemBlock = item.block?.trim().toLowerCase() || '';

      const nearbyVisitItems: { item: ShoppingItem; visitIndex: number }[] = [];
      executeModeItemIds.forEach((eid, idx) => {
        const existingItem = items.find((i) => i.id === eid);
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
        onAddToExecuteList(itemId);
        addToHallVisitList(itemId);
        return;
      }
      setInsertDialogState({ isOpen: true, item });
    },
    [
      onAddToExecuteList,
      onAddToExecuteListAtPosition,
      items,
      executeModeItemIds,
      addToHallVisitList,
      smartInsertEnabled,
    ],
  );

  // スマート挿入ダイアログの選択結果を適用する
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
        if (position.type === 'listEnd' && onAddToExecuteListAtPosition) {

          if (executeModeItemIds.length > 0) {
            onAddToExecuteListAtPosition(
              item.id,
              executeModeItemIds[executeModeItemIds.length - 1],
              'after',
            );
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
    [
      insertDialogState.item,
      onAddToExecuteList,
      onAddToExecuteListAtPosition,
      executeModeItemIds,
      addToHallVisitList,
    ],
  );

  const insertDialogNearbyItems = useMemo(() => {
    const item = insertDialogState.item;
    if (!item) return [];

    const itemNum = extractNumberFromItemNumber(item.number);
    if (!itemNum) return [];

    const numValue = parseInt(itemNum, 10);
    const itemBlock = item.block?.trim().toLowerCase() || '';

    const result: { item: ShoppingItem; visitIndex: number }[] = [];
    executeModeItemIds.forEach((eid, idx) => {
      const existingItem = items.find((i) => i.id === eid);
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

  // 追加対象アイテムがホール判定可能かどうか
  const insertDialogHasHall = useMemo(() => {
    const item = insertDialogState.item;
    if (!item) return false;
    return getHallCandidatesForItem(item).size > 0;
  }, [insertDialogState.item, getHallCandidatesForItem]);

  // preview モード時のみ、実行列全体をダイアログ表示用に渡す
  const insertDialogAllVisitItems = useMemo(() => {
    if (smartInsertMode !== 'preview') return [];
    return executeModeItemIds
      .map((eid, idx) => {
        const item = items.find((i) => i.id === eid);
        return item ? { item, visitIndex: idx } : null;
      })
      .filter((v): v is { item: ShoppingItem; visitIndex: number } => v !== null);
  }, [smartInsertMode, executeModeItemIds, items]);

  // 実行列から削除したアイテムをホール別訪問リストからも除去する
  const handleRemoveFromVisitList = useCallback(
    (itemId: string) => {
      onRemoveFromExecuteList(itemId);

      const updatedHallVisitLists = hallRouteSettings.hallVisitLists.map((list) => ({
        ...list,
        itemIds: list.itemIds.filter((id) => id !== itemId),
      }));

      onUpdateHallRouteSettings({
        ...hallRouteSettings,
        hallVisitLists: updatedHallVisitLists,
      });
    },
    [onRemoveFromExecuteList, hallRouteSettings, onUpdateHallRouteSettings],
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
      {/* 右上コントロール: ホール選択 / ホール順序 / ルート表示 */}
      {!hideInternalControls && (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-3">
          {halls.length > 0 && (
            <select
              value={selectedHallId}
              onChange={(e) => setSelectedHallId(e.target.value)}
              className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">全ホール</option>
              {halls.map((hall) => (
                <option key={hall.id} value={hall.id}>
                  {hall.name} ({getHallTotalExecuteCount(hall.id)}/
                  {getTotalItemCountInHall(hall.id)}件)
                </option>
              ))}
            </select>
          )}
          {halls.length > 0 && (
            <button
              onClick={() => setIsHallOrderOpen(true)}
              className="bg-white dark:bg-slate-800 px-3 py-2 rounded-lg shadow-md border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              ホール順序
            </button>
          )}
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
      {/* 左下ズーム表示 */}
      <div className="absolute bottom-4 left-4 z-10">
        <div className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md text-slate-700 dark:text-slate-300 select-none">
          {zoomLevel}%
        </div>
      </div>
      {/* マップ本体 */}
      <MapCanvas
        mapData={filteredMapData}
        mapName={mapName}
        items={filteredItems}
        executeModeItemIds={filteredExecuteModeItemIds}
        zoomLevel={zoomLevel}
        isRouteVisible={isRouteVisible && (halls.length === 0 || selectedHallId !== 'all')}
        onCellClick={handleCellClick}
        selectedHall={
          selectedHallId !== 'all' ? halls.find((h) => h.id === selectedHallId) : undefined
        }
        vertexSelectionMode={vertexSelectionMode}
        cellSelectionMode={cellSelectionMode}
        highlightedCell={highlightedCell}
        onZoomChange={setZoomLevel}
        rotationAngle={rotationAngle}
        onRotationAngleChange={onRotationAngleChange}
        selectionGuideOptions={selectionGuideOptions}
      />
      {/* セル詳細ポップアップ */}
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
        eventDate={mapDayName || normalizeDisplayText(mapName)}
        position={popupState.position}
      />
      {/* 訪問リストパネル */}
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
      {/* スマート挿入ダイアログ */}
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


