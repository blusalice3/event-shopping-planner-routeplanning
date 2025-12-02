import React, { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { CellInfo, ShoppingItem } from '../types';
import CellEditDialog from './CellEditDialog';

interface MapViewProps {
  mapData: CellInfo[][];
  zoomLevel?: number;
  mapKey?: string; // 例: "1日目マップ"
  eventDate?: string; // 例: "1日目"
  items?: ShoppingItem[]; // 関連アイテム
  onCellSave?: (eventDate: string, number: string, block: string | undefined, side: 'A' | 'B', data: {
    circle: string;
    title: string;
    price: number | null;
  }) => void;
}

const MapView: React.FC<MapViewProps> = ({ mapData, zoomLevel = 100, eventDate, items = [], onCellSave }) => {
  // mapKeyは将来ブロック定義で使用する予定
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [selectedCell, setSelectedCell] = useState<{ 
    cell: CellInfo; 
    row: number; 
    col: number; 
    address: string;
    number: string;
    block?: string;
  } | null>(null);
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

  // セルアドレスを生成（例: "ク-19a"）
  const getCellAddress = useCallback((cell: CellInfo) => {
    // セルの値からアドレスを生成
    const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
    if (cellValue.trim()) {
      return cellValue;
    }
    // デフォルトのアドレス生成
    return `${cell.row}-${cell.col}`;
  }, []);

  // セルに関連するアイテムを取得
  const getRelatedItems = useCallback((cell: CellInfo, number: string, block: string | undefined) => {
    const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
    if (!cellValue.trim()) {
      return [];
    }
    
    // 数値セルの場合、eventDateとnumberでフィルタリング
    const isNumber = cell.isNumber && !isNaN(Number(cellValue));
    if (isNumber && eventDate) {
      return items.filter(item => {
        // eventDateとnumberが一致するアイテムを検索
        const matchesEventDate = item.eventDate === eventDate;
        const matchesNumber = item.number === number;
        // ブロック値が設定されている場合は、それも一致させる（のちに実装）
        const matchesBlock = !block || item.block === block;
        return matchesEventDate && matchesNumber && matchesBlock;
      });
    }
    
    // テキストセルの場合、セルの値と一致するアイテムを検索
    return items.filter(item => {
      return item.block === cellValue || item.number === cellValue || item.circle === cellValue;
    });
  }, [items, eventDate]);

  // セルクリックハンドラ
  const handleCellClick = useCallback((cell: CellInfo, row: number, col: number) => {
    // 空のセルやマージされたセルはクリック不可
    const cellValue = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
    const isEmpty = cellValue.trim() === '';
    
    if (cell.isMerged || isEmpty) {
      return;
    }

    // 数値セルの場合のみモーダルを表示
    const isNumber = cell.isNumber && !isNaN(Number(cellValue));
    if (!isNumber) {
      return;
    }

    // セルの数値をナンバーとして使用
    const number = cellValue;
    // ブロック値はのちに実装（暫定的にundefined）
    const block = undefined;
    
    const address = getCellAddress(cell);
    setSelectedCell({ 
      cell, 
      row, 
      col, 
      address,
      number,
      block,
    });
  }, [getCellAddress]);

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
                    
                    // 数値セルの場合は罫線を適用しない（円形枠を使用）
                    if (isNumber && !isEmpty) {
                      finalBorderTop = 'none';
                      finalBorderBottom = 'none';
                      finalBorderLeft = 'none';
                      finalBorderRight = 'none';
                    } else if (borderTop === 'none' && borderBottom === 'none' && 
                        borderLeft === 'none' && borderRight === 'none') {
                      if (!isEmpty) {
                        // その他は薄いグレーの枠線
                        finalBorderTop = '1px solid #d1d5db';
                        finalBorderBottom = '1px solid #d1d5db';
                        finalBorderLeft = '1px solid #d1d5db';
                        finalBorderRight = '1px solid #d1d5db';
                      }
                    }
                    
                    // セルのスタイルを決定
                    const isClickable = !isEmpty && !cell.isMerged;
                    const cellStyle: React.CSSProperties = {
                      width: `${cellWidth}px`,
                      height: `${cellHeight}px`,
                      minWidth: `${cellWidth}px`,
                      minHeight: `${cellHeight}px`,
                      padding: isNumber && !isEmpty ? '0' : '2px 4px',
                      fontSize: `${12 * (zoomLevel / 100)}px`,
                      fontWeight: isEmpty ? '400' : '500',
                      color: isEmpty ? '#9ca3af' : '#1f2937',
                      backgroundColor: isNumber && !isEmpty ? 'transparent' : backgroundColor,
                      borderTop: isNumber && !isEmpty ? 'none' : finalBorderTop,
                      borderBottom: isNumber && !isEmpty ? 'none' : finalBorderBottom,
                      borderLeft: isNumber && !isEmpty ? 'none' : finalBorderLeft,
                      borderRight: isNumber && !isEmpty ? 'none' : finalBorderRight,
                      borderRadius: isNumber && !isEmpty ? '0' : `${4 * (zoomLevel / 100)}px`,
                      whiteSpace: 'nowrap',
                      textAlign: 'center',
                      verticalAlign: 'middle',
                      boxSizing: 'border-box',
                      userSelect: 'none',
                      cursor: isClickable ? 'pointer' : 'default',
                      transition: 'all 0.2s ease',
                      position: 'relative',
                    };
                    
                    // 数値セルの場合、緑色の円形枠を追加
                    const circleSize = Math.min(cellWidth * 0.8, cellHeight * 0.8);
                    const numberCellStyle: React.CSSProperties = isNumber && !isEmpty ? {
                      border: '2px solid #86efac',
                      borderRadius: '50%',
                      width: `${circleSize}px`,
                      height: `${circleSize}px`,
                      minWidth: `${circleSize}px`,
                      minHeight: `${circleSize}px`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      margin: '0 auto',
                      backgroundColor: '#ffffff',
                      lineHeight: 1,
                    } : {};
                    
                    return (
                      <td
                        key={cellIndex}
                        style={cellStyle}
                        className={`select-none ${isClickable ? 'hover:opacity-80 hover:shadow-md' : ''}`}
                        colSpan={colSpan > 1 ? colSpan : undefined}
                        rowSpan={rowSpan > 1 ? rowSpan : undefined}
                        onClick={() => handleCellClick(cell, rowIndex, cellIndex)}
                      >
                        {isNumber && !isEmpty ? (
                          <div style={numberCellStyle}>
                            {cellValue}
                          </div>
                        ) : (
                          cellValue
                        )}
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

      {/* セル編集モーダル */}
      {selectedCell && eventDate && (
        <CellEditDialog
          cellAddress={selectedCell.address}
          eventDate={eventDate}
          number={selectedCell.number}
          block={selectedCell.block}
          items={getRelatedItems(selectedCell.cell, selectedCell.number, selectedCell.block)}
          onSave={(eventDate, number, block, side, data) => {
            if (onCellSave) {
              onCellSave(eventDate, number, block, side, data);
            }
          }}
          onCancel={() => setSelectedCell(null)}
        />
      )}
    </div>
  );
};

export default MapView;
