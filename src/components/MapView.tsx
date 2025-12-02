import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';

interface MapViewProps {
  mapData: any[][];
}

const CELL_WIDTH = 50;
const CELL_HEIGHT = 40;

const MapView: React.FC<MapViewProps> = ({ mapData }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [visibleRange, setVisibleRange] = useState({ startRow: 0, endRow: 0 });

  // コンテナサイズを監視
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({
          width: rect.width - 32, // padding分を引く (p-4 = 16px * 2)
          height: rect.height - 32, // padding分を引く
        });
      }
    };

    // 初期サイズを設定
    updateSize();
    
    // ResizeObserverを使用してコンテナサイズの変更を監視
    const resizeObserver = new ResizeObserver(updateSize);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    
    window.addEventListener('resize', updateSize);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  // 行数と列数を計算
  const rowCount = mapData?.length || 0;
  const columnCount = useMemo(() => {
    if (!mapData || mapData.length === 0) return 0;
    return Math.max(...mapData.map(row => row?.length || 0));
  }, [mapData]);

  // スクロール位置に基づいて表示範囲を計算
  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    
    const scrollTop = containerRef.current.scrollTop;
    const containerHeight = containerRef.current.clientHeight;
    
    const startRow = Math.max(0, Math.floor(scrollTop / CELL_HEIGHT) - 2); // 2行余分に表示
    const endRow = Math.min(
      rowCount - 1,
      Math.ceil((scrollTop + containerHeight) / CELL_HEIGHT) + 2 // 2行余分に表示
    );
    
    setVisibleRange({ startRow, endRow });
  }, [rowCount]);

  // 初期表示範囲を設定
  useEffect(() => {
    if (containerSize.height > 0) {
      const startRow = 0;
      const endRow = Math.min(
        rowCount - 1,
        Math.ceil(containerSize.height / CELL_HEIGHT) + 4
      );
      setVisibleRange({ startRow, endRow });
    }
  }, [containerSize.height, rowCount]);

  // スクロールイベントリスナーを設定
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    
    container.addEventListener('scroll', handleScroll);
    handleScroll(); // 初期表示
    
    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll]);

  if (!mapData || mapData.length === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        マップデータがありません
      </div>
    );
  }

  if (rowCount === 0 || columnCount === 0) {
    return (
      <div className="text-center py-12 text-slate-500 dark:text-slate-400">
        マップデータがありません
      </div>
    );
  }

  // 表示する行を計算
  const visibleRows = [];
  for (let i = visibleRange.startRow; i <= visibleRange.endRow && i < rowCount; i++) {
    visibleRows.push(i);
  }

  // テーブルの総高さを計算（スクロールバーのために必要）
  const totalHeight = rowCount * CELL_HEIGHT;
  const totalWidth = columnCount * CELL_WIDTH;

  return (
    <div 
      ref={containerRef}
      className="bg-white dark:bg-slate-800 rounded-lg shadow p-4 overflow-auto"
      style={{ height: 'calc(100vh - 300px)' }}
    >
      <div style={{ height: totalHeight, width: Math.max(totalWidth, containerSize.width || totalWidth), position: 'relative' }}>
        <table 
          ref={tableRef}
          className="border-collapse border border-slate-300 dark:border-slate-600 w-full"
          style={{ 
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%'
          }}
        >
          <tbody>
            {/* 上部のスペーサー */}
            {visibleRange.startRow > 0 && (
              <tr>
                <td 
                  colSpan={columnCount}
                  style={{ height: visibleRange.startRow * CELL_HEIGHT, padding: 0 }}
                />
              </tr>
            )}
            {/* 表示する行 */}
            {visibleRows.map((rowIndex) => {
              const row = mapData[rowIndex];
              return (
                <tr key={rowIndex}>
                  {Array.from({ length: columnCount }, (_, cellIndex) => {
                    const cell = row?.[cellIndex];
                    const cellValue = cell !== null && cell !== undefined ? String(cell) : '';
                    const isEmpty = cellValue.trim() === '';
                    
                    return (
                      <td
                        key={cellIndex}
                        className={`border border-slate-300 dark:border-slate-600 p-2 text-sm ${
                          isEmpty 
                            ? 'bg-slate-50 dark:bg-slate-900' 
                            : 'bg-white dark:bg-slate-800'
                        }`}
                        style={{ 
                          minWidth: `${CELL_WIDTH}px`,
                          width: `${CELL_WIDTH}px`,
                          height: `${CELL_HEIGHT}px`,
                          whiteSpace: 'pre-wrap'
                        }}
                      >
                        {cellValue}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {/* 下部のスペーサー */}
            {visibleRange.endRow < rowCount - 1 && (
              <tr>
                <td 
                  colSpan={columnCount}
                  style={{ 
                    height: (rowCount - visibleRange.endRow - 1) * CELL_HEIGHT, 
                    padding: 0 
                  }}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default MapView;

