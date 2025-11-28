import React from 'react';
import { MapData, RoutePoint, MapCell } from '../types';

interface MapGridProps {
  mapData: MapData;
  routePoints: RoutePoint[];
  selectedCell: { row: number; col: number } | null;
  zoomLevel: number;
  isBlockDefinitionMode: boolean;
  selectedCells: { row: number; col: number }[];
  onCellClick: (row: number, col: number) => void;
}

const MapGrid: React.FC<MapGridProps> = ({
  mapData,
  routePoints,
  selectedCell,
  zoomLevel,
  isBlockDefinitionMode,
  selectedCells,
  onCellClick,
}) => {
  const cellSize = mapData.cellSize * (zoomLevel / 100);

  const isVisitedCell = (row: number, col: number): boolean => {
    return routePoints.some(point => point.row === row && point.col === col);
  };

  const isSelectedCell = (row: number, col: number): boolean => {
    if (isBlockDefinitionMode) {
      return selectedCells.some(c => c.row === row && c.col === col);
    }
    return selectedCell?.row === row && selectedCell?.col === col;
  };

  const getCellStyle = (cell: { backgroundColor?: string; borders?: any; isMerged: boolean }, row: number, col: number): React.CSSProperties => {
    const style: React.CSSProperties = {
      width: `${cellSize}px`,
      height: `${cellSize}px`,
      position: 'absolute',
      left: `${col * cellSize}px`,
      top: `${row * cellSize}px`,
      border: '1px solid #ccc',
      boxSizing: 'border-box',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: `${cellSize * 0.4}px`,
      cursor: 'pointer',
      userSelect: 'none',
    };

    // 背景色
    if (cell.backgroundColor) {
      style.backgroundColor = cell.backgroundColor;
    }

    // 訪問先セルのグラデーション
    if (isVisitedCell(row, col)) {
      style.background = 'radial-gradient(circle, rgba(255,0,0,0.8) 0%, rgba(255,0,0,0) 100%)';
      if (cell.backgroundColor) {
        style.background = `radial-gradient(circle, rgba(255,0,0,0.8) 0%, ${cell.backgroundColor} 100%)`;
      }
    }

    // 選択セルのハイライト
    if (isSelectedCell(row, col)) {
      style.border = '3px solid #3B82F6';
      style.zIndex = 10;
    }

    // ブロック定義モードでの選択セル
    if (isBlockDefinitionMode && isSelectedCell(row, col)) {
      style.backgroundColor = 'rgba(59, 130, 246, 0.3)';
    }

    // 罫線の太さ
    if (cell.borders) {
      if (cell.borders.top && cell.borders.top.width > 1) {
        style.borderTopWidth = `${cell.borders.top.width}px`;
        style.borderTopColor = cell.borders.top.color;
        style.borderTopStyle = cell.borders.top.style;
      }
      if (cell.borders.bottom && cell.borders.bottom.width > 1) {
        style.borderBottomWidth = `${cell.borders.bottom.width}px`;
        style.borderBottomColor = cell.borders.bottom.color;
        style.borderBottomStyle = cell.borders.bottom.style;
      }
      if (cell.borders.left && cell.borders.left.width > 1) {
        style.borderLeftWidth = `${cell.borders.left.width}px`;
        style.borderLeftColor = cell.borders.left.color;
        style.borderLeftStyle = cell.borders.left.style;
      }
      if (cell.borders.right && cell.borders.right.width > 1) {
        style.borderRightWidth = `${cell.borders.right.width}px`;
        style.borderRightColor = cell.borders.right.color;
        style.borderRightStyle = cell.borders.right.style;
      }
    }

    return style;
  };

  return (
    <div className="map-grid relative">
      {mapData.cells.map((row: MapCell[], rowIndex: number) =>
        row.map((cell: MapCell, colIndex: number) => {
          // 結合セルの場合は、結合範囲の最初のセルのみを描画
          if (cell.isMerged && cell.mergedRange) {
            if (
              rowIndex !== cell.mergedRange.startRow ||
              colIndex !== cell.mergedRange.startCol
            ) {
              return null;
            }
            // 結合セルのサイズを計算
            const mergedWidth = (cell.mergedRange.endCol - cell.mergedRange.startCol + 1) * cellSize;
            const mergedHeight = (cell.mergedRange.endRow - cell.mergedRange.startRow + 1) * cellSize;
            const mergedStyle = {
              ...getCellStyle(cell, rowIndex, colIndex),
              width: `${mergedWidth}px`,
              height: `${mergedHeight}px`,
            };
            return (
              <div
                key={`${rowIndex}-${colIndex}`}
                style={mergedStyle}
                onClick={() => onCellClick(rowIndex, colIndex)}
                className="map-cell"
              >
                {cell.value}
              </div>
            );
          }

          return (
            <div
              key={`${rowIndex}-${colIndex}`}
              style={getCellStyle(cell, rowIndex, colIndex)}
              onClick={() => onCellClick(rowIndex, colIndex)}
              className="map-cell"
            >
              {cell.value}
            </div>
          );
        })
      )}
    </div>
  );
};

export default MapGrid;

