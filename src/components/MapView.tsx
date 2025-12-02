import React, { useMemo } from 'react';
import { CellInfo } from '../types';

interface MapViewProps {
  mapData: CellInfo[][];
  zoomLevel?: number;
}

const MapView: React.FC<MapViewProps> = ({ mapData, zoomLevel = 100 }) => {
  const renderedTable = useMemo(() => {
    if (!mapData || mapData.length === 0) {
      return null;
    }

    // すべての行とセルを表示（空のセルも含む）
    return (
      <table 
        className="border-collapse"
        style={{
          transform: `scale(${zoomLevel / 100})`,
          transformOrigin: 'top left',
        }}
      >
        <tbody>
          {mapData.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => {
                const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
                const isEmpty = cellValue.trim() === '';
                const isNumber = cell.isNumber && !isNaN(Number(cellValue));
                
                // セルのスタイルを決定
                const cellStyle: React.CSSProperties = {
                  width: '48px',
                  height: '48px',
                  padding: '6px 8px',
                  fontSize: '14px',
                  fontWeight: '500',
                  color: '#1f2937',
                  backgroundColor: isEmpty 
                    ? '#e5e7eb' // 空のセルは灰色
                    : isNumber 
                      ? '#ffffff' // 数値のセルは白色
                      : '#ffffff',
                  border: isNumber && !isEmpty
                    ? '2px solid #86efac' // 数値のセルは緑色の枠線（ライムグリーン）
                    : isEmpty
                      ? 'none' // 空のセルは枠線なし
                      : '1px solid #d1d5db', // その他は薄いグレーの枠線
                  borderRadius: '4px',
                  whiteSpace: 'nowrap',
                  textAlign: 'center',
                  verticalAlign: 'middle',
                  boxSizing: 'border-box',
                  userSelect: 'none',
                  minWidth: '48px',
                  minHeight: '48px',
                };
                
                return (
                  <td
                    key={cellIndex}
                    style={cellStyle}
                    className="select-none"
                  >
                    {cellValue}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }, [mapData, zoomLevel]);

  if (!mapData || mapData.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        マップデータがありません
      </div>
    );
  }

  return (
    <div 
      className="overflow-auto bg-gray-100 dark:bg-slate-900 rounded-lg shadow p-4"
      style={{
        height: 'calc(100vh - 300px)',
        width: '100%',
      }}
    >
      <div className="inline-block">
        {renderedTable}
      </div>
    </div>
  );
};

export default MapView;

