import React, { useState, useCallback, useMemo } from 'react';
import { ShoppingItem, MapData, RoutePoint } from '../types';
import MapGrid from './MapGrid';
import RouteCanvas from './RouteCanvas';
import ItemListModal from './ItemListModal';

interface MapViewProps {
  eventName: string;
  eventDate: string;
  items: ShoppingItem[];
  mapData: MapData | null;
  routePoints: RoutePoint[];
  onCellClick: (row: number, col: number) => void;
  onRoutePointAdd: (point: RoutePoint) => void;
  onRoutePointRemove: (pointId: string) => void;
  onRoutePointReorder: (pointIds: string[]) => void;
  onBlockDefine: (block: { name: string; cells: { row: number; col: number }[]; isWallSide: boolean }) => void;
  isBlockDefinitionMode: boolean;
  onToggleBlockDefinitionMode: () => void;
  zoomLevel: number;
}

const MapView: React.FC<MapViewProps> = ({
  eventName,
  eventDate,
  items,
  mapData,
  routePoints,
  onCellClick,
  onRoutePointAdd,
  onRoutePointRemove,
  onRoutePointReorder,
  onBlockDefine,
  isBlockDefinitionMode,
  onToggleBlockDefinitionMode,
  zoomLevel,
}) => {
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [showItemListModal, setShowItemListModal] = useState(false);
  const [selectedCells, setSelectedCells] = useState<{ row: number; col: number }[]>([]);

  const handleCellClick = useCallback((row: number, col: number) => {
    if (isBlockDefinitionMode) {
      // ブロック定義モード: セル選択
      setSelectedCells(prev => {
        const exists = prev.some(c => c.row === row && c.col === col);
        if (exists) {
          return prev.filter(c => !(c.row === row && c.col === col));
        } else {
          return [...prev, { row, col }];
        }
      });
    } else {
      // 通常モード: セルクリックでアイテムリスト表示
      setSelectedCell({ row, col });
      setShowItemListModal(true);
      onCellClick(row, col);
    }
  }, [isBlockDefinitionMode, onCellClick]);

  const handleItemListClose = useCallback(() => {
    setShowItemListModal(false);
    setSelectedCell(null);
  }, []);

  const handleItemSelect = useCallback((item: ShoppingItem, isVisiting: boolean) => {
    if (!selectedCell || !mapData) return;

    // セルの位置情報を取得
    const cell = mapData.cells[selectedCell.row]?.[selectedCell.col];
    if (!cell) return;

    // ブロック名とナンバーを取得（ブロック定義から）
    const block = getBlockForCell(mapData, selectedCell.row, selectedCell.col);
    const number = extractNumberFromCell(cell);

    if (isVisiting) {
      // 訪問先に追加
      const routePoint: RoutePoint = {
        id: crypto.randomUUID(),
        eventDate,
        block: block || '',
        number: number || '',
        row: selectedCell.row,
        col: selectedCell.col,
        itemIds: [item.id],
        order: routePoints.length,
      };
      onRoutePointAdd(routePoint);
    } else {
      // 訪問先から除外
      const point = routePoints.find(p => 
        p.row === selectedCell.row && 
        p.col === selectedCell.col &&
        p.itemIds.includes(item.id)
      );
      if (point) {
        onRoutePointRemove(point.id);
      }
    }
  }, [selectedCell, mapData, eventDate, routePoints, onRoutePointAdd, onRoutePointRemove]);

  const matchingItems = useMemo(() => {
    if (!selectedCell || !mapData) return [];

    const cell = mapData.cells[selectedCell.row]?.[selectedCell.col];
    if (!cell) return [];

    const block = getBlockForCell(mapData, selectedCell.row, selectedCell.col);
    const number = extractNumberFromCell(cell);

    return items.filter(item => {
      if (item.eventDate !== eventDate) return false;
      if (block && item.block !== block) return false;
      if (number) {
        const itemNumberNumeric = extractNumericPart(item.number);
        return itemNumberNumeric === number;
      }
      return false;
    });
  }, [selectedCell, mapData, eventDate, items]);

  if (!mapData) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-slate-600 dark:text-slate-400">マップデータが読み込まれていません</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div className="absolute inset-0 overflow-auto">
        <div 
          className="relative"
          style={{
            width: `${mapData.colCount * mapData.cellSize * (zoomLevel / 100)}px`,
            height: `${mapData.rowCount * mapData.cellSize * (zoomLevel / 100)}px`,
          }}
        >
          <MapGrid
            mapData={mapData}
            routePoints={routePoints}
            selectedCell={selectedCell}
            zoomLevel={zoomLevel}
            isBlockDefinitionMode={isBlockDefinitionMode}
            selectedCells={selectedCells}
            onCellClick={handleCellClick}
          />
          <RouteCanvas
            mapData={mapData}
            routePoints={routePoints}
            cellSize={mapData.cellSize}
            zoomLevel={zoomLevel}
          />
        </div>
      </div>

      {showItemListModal && selectedCell && (
        <ItemListModal
          items={matchingItems}
          cellInfo={{
            row: selectedCell.row,
            col: selectedCell.col,
            eventDate,
            block: getBlockForCell(mapData, selectedCell.row, selectedCell.col) || '',
            number: extractNumberFromCell(mapData.cells[selectedCell.row]?.[selectedCell.col]) || '',
          }}
          routePoints={routePoints}
          onItemSelect={handleItemSelect}
          onClose={handleItemListClose}
        />
      )}
    </div>
  );
};

// ヘルパー関数
function getBlockForCell(mapData: MapData, row: number, col: number): string | null {
  for (const block of mapData.blocks) {
    if (block.cells.some(c => c.row === row && c.col === col)) {
      return block.name;
    }
  }
  return null;
}

function extractNumberFromCell(cell: { value: string } | undefined): string | null {
  if (!cell || !cell.value) return null;
  const match = cell.value.match(/^(\d+)/);
  return match ? match[1] : null;
}

function extractNumericPart(number: string): string {
  const match = number.match(/^(\d+)/);
  return match ? match[1] : '';
}

export default MapView;

