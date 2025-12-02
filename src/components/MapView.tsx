import React, { useMemo } from 'react';
import { CellInfo } from '../types';

interface MapViewProps {
  mapData: CellInfo[][];
}

const MapView: React.FC<MapViewProps> = ({ mapData }) => {
  const renderedCells = useMemo(() => {
    if (!mapData || mapData.length === 0) {
      return null;
    }

    return mapData.map((row, rowIndex) => {
      // 行に有効なセルがあるかチェック
      const hasContent = row.some(cell => {
        const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
        return cellValue.trim() !== '';
      });
      
      if (!hasContent) {
        return null; // 空の行は表示しない
      }

      return (
        <div key={rowIndex} className="flex flex-wrap gap-1.5 mb-1.5">
          {row.map((cell, cellIndex) => {
            const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
            const isEmpty = cellValue.trim() === '';
            const isNumber = cell.isNumber && !isNaN(Number(cellValue));
            
            // 空のセルで、前後のセルも空の場合は表示しない
            if (isEmpty) {
              const prevCell = cellIndex > 0 ? row[cellIndex - 1] : null;
              const nextCell = cellIndex < row.length - 1 ? row[cellIndex + 1] : null;
              const prevValue = prevCell ? (prevCell.value !== null && prevCell.value !== undefined ? String(prevCell.value) : '') : '';
              const nextValue = nextCell ? (nextCell.value !== null && nextCell.value !== undefined ? String(nextCell.value) : '') : '';
              
              if (prevValue.trim() === '' && nextValue.trim() === '') {
                return null;
              }
            }
            
            // セルのスタイルを決定
            const cellStyle: React.CSSProperties = {
              minWidth: '48px',
              minHeight: '48px',
              padding: '8px 12px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '15px',
              fontWeight: '500',
              color: '#1f2937',
              backgroundColor: isEmpty 
                ? '#f3f4f6' // 空のセルは薄い灰色
                : isNumber 
                  ? '#ffffff' // 数値のセルは白色
                  : '#ffffff',
              border: isNumber && !isEmpty
                ? '2px solid #86efac' // 数値のセルは緑色の枠線（ライムグリーン）
                : isEmpty
                  ? 'none' // 空のセルは枠線なし
                  : '1px solid #e5e7eb', // その他は薄いグレーの枠線
              borderRadius: '8px',
              whiteSpace: 'nowrap',
              textAlign: 'center',
              boxSizing: 'border-box',
              userSelect: 'none',
            };
            
            return (
              <div
                key={cellIndex}
                style={cellStyle}
                className="select-none"
              >
                {cellValue}
              </div>
            );
          })}
        </div>
      );
    });
  }, [mapData]);

  if (!mapData || mapData.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        マップデータがありません
      </div>
    );
  }

  return (
    <div className="overflow-auto max-h-[calc(100vh-300px)] bg-gray-100 dark:bg-slate-900 rounded-lg shadow p-4">
      <div className="inline-block min-w-full">
        {renderedCells}
      </div>
    </div>
  );
};

export default MapView;

