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
                
                let cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
                const isEmpty = cellValue.trim() === '';
                const isNumber = cell.isNumber && !isNaN(Number(cellValue));
                
                // 数値が1桁の場合は2桁表示にする
                if (isNumber && !isEmpty) {
                  const numValue = Number(cellValue);
                  if (numValue >= 1 && numValue <= 9) {
                    cellValue = String(numValue).padStart(2, '0');
                  }
                }
                
                // セルの幅と高さを決定
                const cellWidth = cell.width || 48;
                const cellHeight = cell.height || 20;
                const colSpan = cell.mergeInfo?.cs || 1;
                const rowSpan = cell.mergeInfo?.rs || 1;
                
                // 背景色を決定
                let backgroundColor = '#ffffff';
                if (isEmpty) {
                  backgroundColor = '#e5e7eb'; // 空のセルは灰色
                } else if (cell.style?.fill?.bgColor) {
                  backgroundColor = cell.style.fill.bgColor; // xlsxファイルの塗りつぶし色
                } else if (isNumber) {
                  backgroundColor = '#ffffff'; // 数値のセルは白色
                }
                
                // 罫線を決定
                let borderTop = 'none';
                let borderBottom = 'none';
                let borderLeft = 'none';
                let borderRight = 'none';
                
                if (cell.style?.border) {
                  const border = cell.style.border;
                  if (border.top) {
                    const style = (border.top as any).style || 'thin';
                    const colorObj = (border.top as any).color;
                    const color = colorObj?.rgb ? `#${colorObj.rgb}` : '#000000';
                    const width = style === 'thick' ? '3px' : style === 'medium' ? '2px' : '1px';
                    borderTop = `${width} solid ${color}`;
                  }
                  if (border.bottom) {
                    const style = (border.bottom as any).style || 'thin';
                    const colorObj = (border.bottom as any).color;
                    const color = colorObj?.rgb ? `#${colorObj.rgb}` : '#000000';
                    const width = style === 'thick' ? '3px' : style === 'medium' ? '2px' : '1px';
                    borderBottom = `${width} solid ${color}`;
                  }
                  if (border.left) {
                    const style = (border.left as any).style || 'thin';
                    const colorObj = (border.left as any).color;
                    const color = colorObj?.rgb ? `#${colorObj.rgb}` : '#000000';
                    const width = style === 'thick' ? '3px' : style === 'medium' ? '2px' : '1px';
                    borderLeft = `${width} solid ${color}`;
                  }
                  if (border.right) {
                    const style = (border.right as any).style || 'thin';
                    const colorObj = (border.right as any).color;
                    const color = colorObj?.rgb ? `#${colorObj.rgb}` : '#000000';
                    const width = style === 'thick' ? '3px' : style === 'medium' ? '2px' : '1px';
                    borderRight = `${width} solid ${color}`;
                  }
                } else if (isNumber && !isEmpty) {
                  // 数値のセルは緑色の枠線（全方向）
                  borderTop = '2px solid #86efac';
                  borderBottom = '2px solid #86efac';
                  borderLeft = '2px solid #86efac';
                  borderRight = '2px solid #86efac';
                } else if (!isEmpty) {
                  // その他は薄いグレーの枠線
                  borderTop = '1px solid #d1d5db';
                  borderBottom = '1px solid #d1d5db';
                  borderLeft = '1px solid #d1d5db';
                  borderRight = '1px solid #d1d5db';
                }
                
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
                  backgroundColor,
                  borderTop,
                  borderBottom,
                  borderLeft,
                  borderRight,
                  borderRadius: isNumber && !isEmpty ? '8px' : '4px', // 数値のセルは丸くする
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

