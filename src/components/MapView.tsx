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
          {mapData.map((row, rowIndex) => {
            // 行の高さを取得（最初のセルの高さを使用）
            const rowHeight = row.find(cell => cell.height)?.height;
            
            return (
              <tr key={rowIndex} style={{ height: rowHeight ? `${rowHeight}px` : 'auto' }}>
                {row.map((cell, cellIndex) => {
                // マージされたセル（開始セル以外）は表示しない
                if (cell.isMerged) {
                  return null;
                }
                
                const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
                const isEmpty = cellValue.trim() === '';
                const isNumber = cell.isNumber && !isNaN(Number(cellValue));
                
                // セルの幅と高さを決定
                const cellWidth = cell.width || 48;
                const cellHeight = cell.height || 20;
                const colSpan = cell.mergeInfo?.cs || 1;
                const rowSpan = cell.mergeInfo?.rs || 1;
                
                // セルのスタイルを決定
                const cellStyle: React.CSSProperties = {
                  width: `${cellWidth}px`,
                  height: `${cellHeight}px`,
                  minWidth: `${cellWidth}px`,
                  minHeight: `${cellHeight}px`,
                  padding: '2px 4px',
                  fontSize: '12px',
                  fontWeight: isEmpty ? '400' : '500',
                  color: isEmpty ? '#9ca3af' : '#1f2937',
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
                };
                
                return (
                  <td
                    key={cellIndex}
                    style={cellStyle}
                    className="select-none"
                    colSpan={colSpan > 1 ? colSpan : undefined}
                    rowSpan={rowSpan > 1 ? rowSpan : undefined}
                  >
                    {cellValue}
                  </td>
                );
                })}
              </tr>
            );
          })}
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

