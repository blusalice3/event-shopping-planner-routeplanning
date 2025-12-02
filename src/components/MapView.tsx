import React, { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { CellInfo } from '../types';

interface MapViewProps {
  mapData: CellInfo[][];
  zoomLevel?: number;
}

const MapView: React.FC<MapViewProps> = ({ mapData, zoomLevel = 100 }) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const rowHeightsRef = useRef<number[]>([]);

  // 各行の高さを計算してキャッシュ
  useEffect(() => {
    if (!mapData) return;
    rowHeightsRef.current = mapData.map((row) => {
      const rowHeight = row.find(cell => cell.height)?.height || 20;
      return rowHeight * (zoomLevel / 100);
    });
  }, [mapData, zoomLevel]);

  // スクロール位置から表示範囲を計算
  const updateVisibleRange = useCallback(() => {
    if (!scrollContainerRef.current || !mapData || mapData.length === 0) return;

    const scrollTop = scrollContainerRef.current.scrollTop;
    const containerHeight = scrollContainerRef.current.clientHeight;
    let accumulatedHeight = 0;
    let start = 0;
    let end = mapData.length - 1;

    // 開始行を検索
    for (let i = 0; i < mapData.length; i++) {
      const rowHeight = rowHeightsRef.current[i] || 20;
      if (accumulatedHeight + rowHeight > scrollTop) {
        start = Math.max(0, i - 2); // バッファを追加
        break;
      }
      accumulatedHeight += rowHeight;
    }

    // 終了行を検索
    accumulatedHeight = 0;
    for (let i = 0; i < mapData.length; i++) {
      const rowHeight = rowHeightsRef.current[i] || 20;
      accumulatedHeight += rowHeight;
      if (accumulatedHeight > scrollTop + containerHeight) {
        end = Math.min(mapData.length - 1, i + 2); // バッファを追加
        break;
      }
    }

    setVisibleRange({ start, end });
  }, [mapData]);

  // スクロールイベントハンドラ
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    updateVisibleRange();
    container.addEventListener('scroll', updateVisibleRange);
    return () => container.removeEventListener('scroll', updateVisibleRange);
  }, [updateVisibleRange]);

  // 初期表示範囲を設定
  useEffect(() => {
    if (mapData && mapData.length > 0) {
      const initialEnd = Math.min(20, mapData.length - 1);
      setVisibleRange({ start: 0, end: initialEnd });
    }
  }, [mapData]);

  // 罫線のスタイルを取得する関数（改善版）
  const getBorderStyle = useCallback((cell: CellInfo, side: 'top' | 'bottom' | 'left' | 'right') => {
    if (!cell.style?.border) {
      return 'none';
    }

    const border = cell.style.border[side];
    if (!border) {
      return 'none';
    }

    // borderオブジェクトからstyleとcolorを取得
    // xlsxReader.tsから取得したborderは { style, color } の形式
    const style = (border as any).style || 'thin';
    const color = (border as any).color || '#000000';
    
    // colorが既に文字列形式（#RRGGBB）の場合はそのまま使用
    const finalColor = typeof color === 'string' 
      ? (color.startsWith('#') ? color : `#${color}`)
      : '#000000';

    const width = style === 'thick' ? '3px' : style === 'medium' ? '2px' : '1px';
    return `${width} solid ${finalColor}`;
  }, []);

  // 背景色を取得する関数（改善版）
  const getBackgroundColor = useCallback((cell: CellInfo) => {
    let cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
    const isEmpty = cellValue.trim() === '';
    const isNumber = cell.isNumber && !isNaN(Number(cellValue));

    // 塗りつぶし色の処理を改善
    if (cell.style?.fill?.bgColor) {
      return cell.style.fill.bgColor;
    }
    if (cell.style?.fill?.fgColor) {
      return cell.style.fill.fgColor;
    }
    
    if (isEmpty) {
      return '#e5e7eb'; // 空のセルは灰色
    }
    if (isNumber) {
      return '#ffffff'; // 数値のセルは白色
    }
    return '#ffffff';
  }, []);

  // テーブルの総幅を計算
  const totalWidth = useMemo(() => {
    if (!mapData || mapData.length === 0) return 0;
    const firstRow = mapData[0];
    return firstRow.reduce((sum, cell) => {
      if (cell.isMerged) return sum;
      return sum + ((cell.width || 48) * (zoomLevel / 100));
    }, 0);
  }, [mapData, zoomLevel]);

  // 総高さを計算
  const totalHeight = useMemo(() => {
    return rowHeightsRef.current.reduce((sum, height) => sum + height, 0);
  }, [mapData, zoomLevel]);

  // 上部のオフセット高さを計算
  const offsetTop = useMemo(() => {
    let sum = 0;
    for (let i = 0; i < visibleRange.start; i++) {
      sum += rowHeightsRef.current[i] || 20;
    }
    return sum;
  }, [visibleRange.start]);

  if (!mapData || mapData.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        マップデータがありません
      </div>
    );
  }

  // 表示する行を取得
  const visibleRows = useMemo(() => {
    return mapData.slice(visibleRange.start, visibleRange.end + 1);
  }, [mapData, visibleRange]);

  return (
    <div 
      ref={scrollContainerRef}
      className="bg-gray-100 dark:bg-slate-900 rounded-lg shadow p-4 overflow-auto"
      style={{
        height: 'calc(100vh - 300px)',
        width: '100%',
      }}
    >
      <div style={{ width: `${totalWidth}px`, height: `${totalHeight}px`, position: 'relative' }}>
        <table 
          className="border-collapse"
          style={{
            width: '100%',
            tableLayout: 'fixed',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        >
          <tbody ref={tbodyRef}>
            {/* 上部のスペーサー */}
            {visibleRange.start > 0 && (
              <tr>
                <td colSpan={mapData[0]?.length || 1} style={{ height: `${offsetTop}px`, padding: 0 }} />
              </tr>
            )}
            
            {/* 表示する行 */}
            {visibleRows.map((row, relativeIndex) => {
              const rowIndex = visibleRange.start + relativeIndex;
              const rowHeight = rowHeightsRef.current[rowIndex] || 20;

              return (
                <tr key={rowIndex} style={{ height: `${rowHeight}px` }}>
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
                    const cellWidth = (cell.width || 48) * (zoomLevel / 100);
                    const cellHeight = (cell.height || 20) * (zoomLevel / 100);
                    const colSpan = cell.mergeInfo?.cs || 1;
                    const rowSpan = cell.mergeInfo?.rs || 1;
                    
                    // 背景色を決定
                    const backgroundColor = getBackgroundColor(cell);
                    
                    // 罫線を決定（改善版）
                    const borderTop = getBorderStyle(cell, 'top');
                    const borderBottom = getBorderStyle(cell, 'bottom');
                    const borderLeft = getBorderStyle(cell, 'left');
                    const borderRight = getBorderStyle(cell, 'right');
                    
                    // デフォルトの罫線（スタイル情報がない場合）
                    let finalBorderTop = borderTop;
                    let finalBorderBottom = borderBottom;
                    let finalBorderLeft = borderLeft;
                    let finalBorderRight = borderRight;
                    
                    if (borderTop === 'none' && borderBottom === 'none' && 
                        borderLeft === 'none' && borderRight === 'none') {
                      if (isNumber && !isEmpty) {
                        // 数値のセルは緑色の枠線（全方向）
                        finalBorderTop = '2px solid #86efac';
                        finalBorderBottom = '2px solid #86efac';
                        finalBorderLeft = '2px solid #86efac';
                        finalBorderRight = '2px solid #86efac';
                      } else if (!isEmpty) {
                        // その他は薄いグレーの枠線
                        finalBorderTop = '1px solid #d1d5db';
                        finalBorderBottom = '1px solid #d1d5db';
                        finalBorderLeft = '1px solid #d1d5db';
                        finalBorderRight = '1px solid #d1d5db';
                      }
                    }
                    
                    // セルのスタイルを決定
                    const cellStyle: React.CSSProperties = {
                      width: `${cellWidth}px`,
                      height: `${cellHeight}px`,
                      minWidth: `${cellWidth}px`,
                      minHeight: `${cellHeight}px`,
                      padding: '2px 4px',
                      fontSize: `${12 * (zoomLevel / 100)}px`,
                      fontWeight: isEmpty ? '400' : '500',
                      color: isEmpty ? '#9ca3af' : '#1f2937',
                      backgroundColor,
                      borderTop: finalBorderTop,
                      borderBottom: finalBorderBottom,
                      borderLeft: finalBorderLeft,
                      borderRight: finalBorderRight,
                      borderRadius: isNumber && !isEmpty ? `${8 * (zoomLevel / 100)}px` : `${4 * (zoomLevel / 100)}px`,
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
            
            {/* 下部のスペーサー */}
            {visibleRange.end < mapData.length - 1 && (() => {
              const visibleRowsHeight = visibleRows.reduce((sum, _, idx) => {
                return sum + (rowHeightsRef.current[visibleRange.start + idx] || 20);
              }, 0);
              const bottomSpacerHeight = totalHeight - offsetTop - visibleRowsHeight;
              return bottomSpacerHeight > 0 ? (
                <tr>
                  <td 
                    colSpan={mapData[0]?.length || 1} 
                    style={{ 
                      height: `${bottomSpacerHeight}px`, 
                      padding: 0 
                    }} 
                  />
                </tr>
              ) : null;
            })()}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MapView;
