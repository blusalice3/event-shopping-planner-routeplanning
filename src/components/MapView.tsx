import React, { useMemo, useCallback, useRef, useEffect, useState } from 'react';
import { Grid } from 'react-window';

interface MapViewProps {
  mapData: any[][];
}

const CELL_WIDTH = 50;
const CELL_HEIGHT = 40;
const CELL_PADDING = 8;

const MapView: React.FC<MapViewProps> = ({ mapData }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

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

  // セルコンポーネント
  const Cell = useCallback(({ columnIndex, rowIndex, style, ariaAttributes }: { 
    columnIndex: number; 
    rowIndex: number; 
    style: React.CSSProperties;
    ariaAttributes: { "aria-colindex": number; role: "gridcell" };
  }) => {
    const row = mapData[rowIndex];
    const cell = row?.[columnIndex];
    const cellValue = cell !== null && cell !== undefined ? String(cell) : '';
    const isEmpty = cellValue.trim() === '';

    return (
      <div
        {...ariaAttributes}
        style={{
          ...style,
          border: '1px solid rgb(203 213 225)', // border-slate-300
          padding: `${CELL_PADDING}px`,
          display: 'flex',
          alignItems: 'center',
          fontSize: '0.875rem', // text-sm
          whiteSpace: 'pre-wrap',
          minWidth: `${CELL_WIDTH}px`,
          backgroundColor: isEmpty 
            ? 'rgb(248 250 252)' // bg-slate-50
            : 'rgb(255 255 255)', // bg-white
        }}
        className={`dark:border-slate-600 ${
          isEmpty 
            ? 'dark:bg-slate-900' 
            : 'dark:bg-slate-800'
        }`}
      >
        {cellValue}
      </div>
    );
  }, [mapData]);

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

  // グリッドの幅を計算（必要な最小幅）
  const gridWidth = columnCount * CELL_WIDTH;
  const gridHeight = containerSize.height || window.innerHeight - 300;

  return (
    <div 
      ref={containerRef}
      className="bg-white dark:bg-slate-800 rounded-lg shadow p-4"
      style={{ height: 'calc(100vh - 300px)', overflow: 'auto' }}
    >
      <Grid
        cellComponent={Cell}
        cellProps={{} as Record<string, never>}
        columnCount={columnCount}
        columnWidth={CELL_WIDTH}
        defaultHeight={gridHeight}
        defaultWidth={gridWidth}
        rowCount={rowCount}
        rowHeight={CELL_HEIGHT}
        style={{ 
          height: gridHeight,
          width: Math.max(gridWidth, containerSize.width || gridWidth)
        }}
      />
    </div>
  );
};

export default MapView;

