import React, { useMemo } from 'react';
import { MapData, RoutePoint } from '../types';

interface RouteCanvasProps {
  mapData: MapData;
  routePoints: RoutePoint[];
  cellSize: number;
  zoomLevel: number;
}

const RouteCanvas: React.FC<RouteCanvasProps> = ({
  mapData,
  routePoints,
  cellSize,
  zoomLevel,
}) => {
  const scaledCellSize = cellSize * (zoomLevel / 100);

  const routePath = useMemo(() => {
    if (routePoints.length < 2) {
      return '';
    }

    // 訪問順序に従ってソート
    const sortedPoints = [...routePoints].sort((a, b) => a.order - b.order);

    // 各ポイントの中心座標を計算
    const points = sortedPoints.map(point => ({
      x: (point.col + 0.5) * scaledCellSize,
      y: (point.row + 0.5) * scaledCellSize,
    }));

    // SVGパスを生成（直線で繋ぐ）
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      path += ` L ${points[i].x} ${points[i].y}`;
    }

    return path;
  }, [routePoints, scaledCellSize]);

  if (routePoints.length < 2) {
    return null;
  }

  const sortedPoints = [...routePoints].sort((a, b) => a.order - b.order);

  return (
    <svg
      className="route-canvas absolute inset-0 pointer-events-none"
      style={{
        width: `${mapData.colCount * scaledCellSize}px`,
        height: `${mapData.rowCount * scaledCellSize}px`,
      }}
    >
      <path
        d={routePath}
        stroke="#FF0000"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {sortedPoints.map((point, index) => {
        const x = (point.col + 0.5) * scaledCellSize;
        const y = (point.row + 0.5) * scaledCellSize;
        return (
          <g key={point.id}>
            <circle
              cx={x}
              cy={y}
              r="5"
              fill="#FF0000"
            />
            <text
              x={x}
              y={y - 10}
              fontSize="12"
              fill="#FF0000"
              textAnchor="middle"
              fontWeight="bold"
            >
              {index + 1}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

export default RouteCanvas;

