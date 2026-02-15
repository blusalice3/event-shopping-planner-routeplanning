import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  DayMapData,
  CellData,
  ShoppingItem,
  ZoomLevel,
  MergedCellInfo,
  MapCellStateDetail,
  HallDefinition,
  MIN_ZOOM,
  MAX_ZOOM,
} from '../../types';
import { extractNumberFromItemNumber } from '../../utils/xlsxMapParser';
import { generateRouteSegments, simplifyPath } from '../../utils/pathfinding';
import MapCanvasPresentation from './MapCanvasPresentation';

interface MapCanvasProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[]; // 実行モード中の訪問済みID
  zoomLevel: ZoomLevel;
  rotationAngle?: number;
  isRouteVisible: boolean;
  onCellClick: (row: number, col: number, matchingItems: ShoppingItem[]) => void;
  selectedHall?: HallDefinition;
  vertexSelectionMode?: {
    clickedVertices: { row: number; col: number }[];
  } | null;
  cellSelectionMode?: {
    type: string;
    clickedCells: { row: number; col: number }[];
  } | null;
  highlightedCell?: { row: number; col: number } | null;
  onZoomChange?: (newZoom: number) => void;
  onRotationAngleChange?: (newAngle: number) => void;
  selectionGuideOptions?: {
    showGrid: boolean;
    showRuler: boolean;
  };
}

const BASE_CELL_SIZE = 28; // 基本セルサイズ
const SCROLL_MARGIN = 5; // スクロール余白（行/列数）
const FILLED_SCROLL_MARGIN = 15; // 入力済みセル境界からの追加余白（行/列数）
const hasCellInputValue = (value: string | number | null): boolean => {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

const TAP_ASSIST_DURATION_MS = 900;

interface HoverGuideState {
  row: number;
  col: number;
  viewX: number;
  viewY: number;
}

interface TapAssistState {
  row: number;
  col: number;
  viewX: number;
  viewY: number;
}

const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

const rotatePointAroundCenter = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  angleRad: number,
): { x: number; y: number } => {
  if (angleRad === 0) return { x, y };
  const dx = x - centerX;
  const dy = y - centerY;
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return {
    x: dx * cos - dy * sin + centerX,
    y: dx * sin + dy * cos + centerY,
  };
};

type RgbColor = { r: number; g: number; b: number };

const parseCssColorToRgb = (color: string): RgbColor | null => {
  const normalized = color.trim().toLowerCase();
  if (normalized === 'white') return { r: 255, g: 255, b: 255 };
  if (normalized === 'black') return { r: 0, g: 0, b: 0 };

  const hexMatch = normalized.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  const rgbMatch = normalized.match(
    /^rgba?\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[\d.]+)?\)$/,
  );
  if (!rgbMatch) return null;

  return {
    r: Math.min(255, Math.max(0, parseInt(rgbMatch[1], 10))),
    g: Math.min(255, Math.max(0, parseInt(rgbMatch[2], 10))),
    b: Math.min(255, Math.max(0, parseInt(rgbMatch[3], 10))),
  };
};

const isWhiteLikeColor = (color: string | null | undefined): boolean => {
  if (!color) return false;
  const rgb = parseCssColorToRgb(color);
  if (!rgb) return false;
  return rgb.r >= 245 && rgb.g >= 245 && rgb.b >= 245;
};

const isDarkLikeColor = (color: string): boolean => {
  const rgb = parseCssColorToRgb(color);
  if (!rgb) return false;
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return luminance <= 64;
};

const resolveMapTextColorForTheme = (
  color: string | null | undefined,
  isDarkMode: boolean,
  fallback = '#333333',
): string => {
  const baseColor = color?.trim() || fallback;
  if (!isDarkMode) return baseColor;
  if (isWhiteLikeColor(baseColor)) return baseColor;
  return isDarkLikeColor(baseColor) ? '#FFFFFF' : baseColor;
};

const isNumberLikeCellValue = (value: string | number | null): boolean => {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  return /^\d+$/.test(value.trim());
};

const MapCanvas: React.FC<MapCanvasProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds,
  zoomLevel,
  rotationAngle = 0,
  isRouteVisible,
  onCellClick,
  selectedHall,
  vertexSelectionMode,
  cellSelectionMode,
  highlightedCell,
  onZoomChange,
  onRotationAngleChange,
  selectionGuideOptions,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  const [hoverGuide, setHoverGuide] = useState<HoverGuideState | null>(null);
  const [tapAssist, setTapAssist] = useState<TapAssistState | null>(null);
  const lastPointerTypeRef = useRef<string>('mouse');
  const tapAssistTimerRef = useRef<number | null>(null);

  // 繝・ヰ繧､繧ｹ繝斐け繧ｻ繝ｫ豈・
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // 繧ｹ繧ｱ繝ｼ繝ｫ險育ｮ・
  const scale = zoomLevel / 100;
  const cellSize = BASE_CELL_SIZE * scale;
  const isDarkMode =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  // 蟶ｸ縺ｫ100%譎ゅ→蜷檎ｭ峨・諠・ｱ驥上ｒ陦ｨ遉ｺ・医ぜ繝ｼ繝繝ｬ繝吶Ν縺ｫ髢｢菫ゅ↑縺丞・諠・ｱ繧呈緒逕ｻ・・
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;

  // 蜑榊屓縺ｮ繧ｻ繝ｫ繧ｵ繧､繧ｺ繧定ｨ俶・
  const prevCellSizeRef = useRef<number>(cellSize);
  const initializedRef = useRef<boolean>(false);

  // 繝斐Φ繝√ぜ繝ｼ繝逕ｨ縺ｮ迥ｶ諷・
  const pinchStartDistRef = useRef<number>(0);
  const pinchStartZoomRef = useRef<number>(zoomLevel);
  const pinchCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const [isRotationInteracting, setIsRotationInteracting] = useState(false);
  const rotationInteractionTimerRef = useRef<number | null>(null);

  const normalizedRotationAngle = useMemo(
    () => normalizeRotationAngle(rotationAngle),
    [rotationAngle],
  );
  const rotationRadians = useMemo(
    () => (normalizedRotationAngle * Math.PI) / 180,
    [normalizedRotationAngle],
  );
  const mapCenterX = useMemo(() => (mapData.maxCol * cellSize) / 2, [mapData.maxCol, cellSize]);
  const mapCenterY = useMemo(() => (mapData.maxRow * cellSize) / 2, [mapData.maxRow, cellSize]);
  const showSelectionGrid = selectionGuideOptions?.showGrid ?? false;
  const showSelectionRuler = selectionGuideOptions?.showRuler ?? false;

  const toMapCoordinates = useCallback(
    (viewX: number, viewY: number, currentOffset = offset) => {
      const translatedX = viewX - currentOffset.x;
      const translatedY = viewY - currentOffset.y;
      if (rotationRadians === 0) return { x: translatedX, y: translatedY };

      const dx = translatedX - mapCenterX;
      const dy = translatedY - mapCenterY;
      const cos = Math.cos(rotationRadians);
      const sin = Math.sin(rotationRadians);

      return {
        x: dx * cos + dy * sin + mapCenterX,
        y: -dx * sin + dy * cos + mapCenterY,
      };
    },
    [offset, rotationRadians, mapCenterX, mapCenterY],
  );

  const rotateAroundMapCenter = useCallback(
    (x: number, y: number, angleRad = rotationRadians) => {
      if (angleRad === 0) return { x, y };
      const dx = x - mapCenterX;
      const dy = y - mapCenterY;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      return {
        x: dx * cos - dy * sin + mapCenterX,
        y: dx * sin + dy * cos + mapCenterY,
      };
    },
    [mapCenterX, mapCenterY, rotationRadians],
  );

  const calculateOffsetForZoomPoint = useCallback(
    (viewX: number, viewY: number, newZoom: number, currentOffset = offset) => {
      const currentCellSize = BASE_CELL_SIZE * (zoomLevel / 100);
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const mapPoint = toMapCoordinates(viewX, viewY, currentOffset);
      const normalizedMapX = mapPoint.x / currentCellSize;
      const normalizedMapY = mapPoint.y / currentCellSize;
      const scaledMapX = normalizedMapX * newCellSize;
      const scaledMapY = normalizedMapY * newCellSize;
      const newMapCenterX = (mapData.maxCol * newCellSize) / 2;
      const newMapCenterY = (mapData.maxRow * newCellSize) / 2;
      const rotatedPoint = rotatePointAroundCenter(
        scaledMapX,
        scaledMapY,
        newMapCenterX,
        newMapCenterY,
        rotationRadians,
      );
      return {
        x: viewX - rotatedPoint.x,
        y: viewY - rotatedPoint.y,
      };
    },
    [offset, zoomLevel, toMapCoordinates, mapData.maxCol, mapData.maxRow, rotationRadians],
  );

  const getPointerViewMetrics = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / dpr / rect.width;
      const scaleY = canvas.height / dpr / rect.height;

      return {
        viewX: (clientX - rect.left) * scaleX,
        viewY: (clientY - rect.top) * scaleY,
      };
    },
    [dpr],
  );

  const showTapAssist = useCallback((next: TapAssistState) => {
    setTapAssist(next);
    if (tapAssistTimerRef.current !== null) {
      clearTimeout(tapAssistTimerRef.current);
    }
    tapAssistTimerRef.current = window.setTimeout(() => {
      setTapAssist(null);
      tapAssistTimerRef.current = null;
    }, TAP_ASSIST_DURATION_MS);
  }, []);

  useEffect(() => {
    setIsRotationInteracting(true);
    if (rotationInteractionTimerRef.current !== null) {
      clearTimeout(rotationInteractionTimerRef.current);
    }
    rotationInteractionTimerRef.current = window.setTimeout(() => {
      setIsRotationInteracting(false);
      rotationInteractionTimerRef.current = null;
    }, 150);

    return () => {
      if (rotationInteractionTimerRef.current !== null) {
        clearTimeout(rotationInteractionTimerRef.current);
      }
    };
  }, [normalizedRotationAngle]);

  useEffect(() => {
    return () => {
      if (tapAssistTimerRef.current !== null) {
        clearTimeout(tapAssistTimerRef.current);
      }
    };
  }, []);

  // 繧ｺ繝ｼ繝繝ｬ繝吶Ν螟画峩譎ゅ↓隕也せ繧堤ｶｭ謖√☆繧九が繝輔そ繝・ヨ隱ｿ謨ｴ・亥､夜Κ縺九ｉ縺ｮ繧ｺ繝ｼ繝螟画峩縺ｫ蟇ｾ蠢懶ｼ・
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prevCellSize = prevCellSizeRef.current;

    // 蛻晏屓縺ｾ縺溘・繧ｻ繝ｫ繧ｵ繧､繧ｺ縺悟､峨ｏ縺｣縺ｦ縺・↑縺・ｴ蜷医・繧ｹ繧ｭ繝・・
    if (!initializedRef.current || prevCellSize === cellSize) {
      prevCellSizeRef.current = cellSize;
      initializedRef.current = true;
      return;
    }

    // 繧ｳ繝ｳ繝・リ縺ｮ荳ｭ螟ｮ蠎ｧ讓吶ｒ蝓ｺ貅悶↓繧ｺ繝ｼ繝・亥､夜Κ螟画峩縺ｮ蝣ｴ蜷医・繝輔か繝ｼ繝ｫ繝舌ャ繧ｯ・・
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const centerX = containerWidth / 2;
    const centerY = containerHeight / 2;

    const mapCenterX = (centerX - offset.x) / prevCellSize;
    const mapCenterY = (centerY - offset.y) / prevCellSize;

    const newOffsetX = centerX - mapCenterX * cellSize;
    const newOffsetY = centerY - mapCenterY * cellSize;

    setOffset({ x: newOffsetX, y: newOffsetY });
    prevCellSizeRef.current = cellSize;
  }, [cellSize, offset.x, offset.y]);

  // 繝帙う繝ｼ繝ｫ繧ｺ繝ｼ繝蜃ｦ逅・ｼ・C繝悶Λ繧ｦ繧ｶ: 繝槭え繧ｹ繧ｫ繝ｼ繧ｽ繝ｫ菴咲ｽｮ繧剃ｸｭ蠢・↓繧ｺ繝ｼ繝・・
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      if (e.shiftKey && onRotationAngleChange) {
        const delta = e.deltaY < 0 ? -15 : 15;
        onRotationAngleChange(normalizeRotationAngle(rotationAngle + delta));
        return;
      }
      if (!onZoomChange) return;

      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      // 繝槭え繧ｹ菴咲ｽｮ・医さ繝ｳ繝・リ蜀・ｺｧ讓呻ｼ・
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // 迴ｾ蝨ｨ縺ｮ繧ｺ繝ｼ繝繝ｬ繝吶Ν
      const currentZoom = zoomLevel;
      // 繧ｺ繝ｼ繝驥擾ｼ医せ繧ｯ繝ｭ繝ｼ繝ｫ驥上↓蠢懊§縺ｦ・・
      const zoomDelta = -e.deltaY * 0.1;
      const newZoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom + zoomDelta)));

      if (newZoom === currentZoom) return;

      const newOffset = calculateOffsetForZoomPoint(mouseX, mouseY, newZoom);
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);

      setOffset(newOffset);
      prevCellSizeRef.current = newCellSize;
      onZoomChange(newZoom);
    },
    [
      zoomLevel,
      onZoomChange,
      onRotationAngleChange,
      rotationAngle,
      calculateOffsetForZoomPoint,
    ],
  );

  // 繝斐Φ繝√ぜ繝ｼ繝蜃ｦ逅・ｼ医せ繝槭・繝医ヵ繧ｩ繝ｳ/繧ｿ繝悶Ξ繝・ヨ: 繝斐Φ繝∽ｸｭ蠢・ｒ蝓ｺ貅悶↓繧ｺ繝ｼ繝・・
  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      // 繧ｿ繝・メ繝昴う繝ｳ繝医ｒ險倬鹸
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        activeTouchesRef.current.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }

      if (activeTouchesRef.current.size === 2) {
        e.preventDefault();
        const touches = Array.from(activeTouchesRef.current.values());
        const dx = touches[1].x - touches[0].x;
        const dy = touches[1].y - touches[0].y;
        pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoomRef.current = zoomLevel;

        // 繝斐Φ繝∽ｸｭ蠢・ｼ医さ繝ｳ繝・リ蜀・ｺｧ讓呻ｼ・
        const container = containerRef.current;
        if (container) {
          const rect = container.getBoundingClientRect();
          pinchCenterRef.current = {
            x: (touches[0].x + touches[1].x) / 2 - rect.left,
            y: (touches[0].y + touches[1].y) / 2 - rect.top,
          };
        }
      }
    },
    [zoomLevel],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      // 繧ｿ繝・メ繝昴う繝ｳ繝医ｒ譖ｴ譁ｰ
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        activeTouchesRef.current.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }

      if (activeTouchesRef.current.size === 2 && onZoomChange) {
        e.preventDefault();
        const touches = Array.from(activeTouchesRef.current.values());
        const dx = touches[1].x - touches[0].x;
        const dy = touches[1].y - touches[0].y;
        const currentDist = Math.sqrt(dx * dx + dy * dy);

        if (pinchStartDistRef.current === 0) return;

        const scaleRatio = currentDist / pinchStartDistRef.current;
        const newZoom = Math.round(
          Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoomRef.current * scaleRatio)),
        );

        if (newZoom === zoomLevel) return;

        const cx = pinchCenterRef.current.x;
        const cy = pinchCenterRef.current.y;
        const newOffset = calculateOffsetForZoomPoint(cx, cy, newZoom);
        const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
        setOffset(newOffset);
        prevCellSizeRef.current = newCellSize;
        onZoomChange(newZoom);
      }
    },
    [zoomLevel, onZoomChange, calculateOffsetForZoomPoint],
  );

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouchesRef.current.delete(e.changedTouches[i].identifier);
    }
    if (activeTouchesRef.current.size < 2) {
      pinchStartDistRef.current = 0;
    }
  }, []);

  // 繝帙う繝ｼ繝ｫ繝ｻ繧ｿ繝・メ繧､繝吶Φ繝医・逋ｻ骭ｲ
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });
    container.addEventListener('touchstart', handleTouchStart, { passive: false });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', handleTouchEnd);
    container.addEventListener('touchcancel', handleTouchEnd);

    return () => {
      container.removeEventListener('wheel', handleWheel);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
      container.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleWheel, handleTouchStart, handleTouchMove, handleTouchEnd]);

  // 繝帙・繝ｫ驕ｸ謚樊凾縺ｫ繧ｪ繝輔そ繝・ヨ繧定・蜍戊ｪｿ謨ｴ縺励※繝帙・繝ｫ繧堤判髱｢蜀・↓驟咲ｽｮ
  // selectedHall縺悟､画峩縺輔ｌ縺滓凾縺ｮ縺ｿ螳溯｡鯉ｼ医ぜ繝ｼ繝螟画峩譎ゅ・螳溯｡後＠縺ｪ縺・ｼ・
  const prevSelectedHallRef = useRef<HallDefinition | undefined>(undefined);

  useEffect(() => {
    // selectedHall縺悟､峨ｏ縺｣縺ｦ縺・↑縺・ｴ蜷医・繧ｹ繧ｭ繝・・
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;

    if (selectedHall && selectedHall.vertices.length >= 4) {
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      // 繝帙・繝ｫ縺ｮ遽・峇繧定ｨ育ｮ暦ｼ医・繝ｼ繧ｸ繝ｳ霎ｼ縺ｿ・・
      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      const minRow = Math.max(1, Math.min(...rows) - SCROLL_MARGIN);
      const maxRow = Math.max(...rows) + SCROLL_MARGIN;
      const minCol = Math.max(1, Math.min(...cols) - SCROLL_MARGIN);
      const maxCol = Math.max(...cols) + SCROLL_MARGIN;

      // 繝帙・繝ｫ遽・峇縺ｮ繝斐け繧ｻ繝ｫ蠎ｧ讓・
      const hallLeft = (minCol - 1) * cellSize;
      const hallRight = maxCol * cellSize;
      const hallTop = (minRow - 1) * cellSize;
      const hallBottom = maxRow * cellSize;
      const hallWidth = hallRight - hallLeft;
      const hallHeight = hallBottom - hallTop;

      let newOffsetX: number;
      let newOffsetY: number;

      // 繝帙・繝ｫ縺檎判髱｢縺ｫ蜿弱∪繧句ｴ蜷医・荳ｭ螟ｮ縺ｫ驟咲ｽｮ縲∝庶縺ｾ繧峨↑縺・ｴ蜷医・蟾ｦ荳翫ｒ蝓ｺ貅悶↓
      if (hallWidth <= containerWidth) {
        // 繝帙・繝ｫ繧呈ｰｴ蟷ｳ譁ｹ蜷台ｸｭ螟ｮ縺ｫ
        newOffsetX = (containerWidth - hallWidth) / 2 - hallLeft;
      } else {
        // 繝帙・繝ｫ蟾ｦ遶ｯ繧堤判髱｢蟾ｦ遶ｯ縺ｫ蜷医ｏ縺帙ｋ
        newOffsetX = -hallLeft;
      }

      if (hallHeight <= containerHeight) {
        // 繝帙・繝ｫ繧貞桙逶ｴ譁ｹ蜷台ｸｭ螟ｮ縺ｫ
        newOffsetY = (containerHeight - hallHeight) / 2 - hallTop;
      } else {
        // 繝帙・繝ｫ荳顔ｫｯ繧堤判髱｢荳顔ｫｯ縺ｫ蜷医ｏ縺帙ｋ
        newOffsetY = -hallTop;
      }

      setOffset({ x: newOffsetX, y: newOffsetY });
    } else if (!selectedHall) {
      // 繝帙・繝ｫ譛ｪ驕ｸ謚槭↓謌ｻ縺｣縺滓凾縺ｯ繧ｪ繝輔そ繝・ヨ繧偵Μ繧ｻ繝・ヨ
      setOffset({ x: 0, y: 0 });
    }
  }, [selectedHall, cellSize]);

  // 繧ｻ繝ｫ繝槭ャ繝励ｒ菴懈・
  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  // 邨仙粋繧ｻ繝ｫ縺ｮ繝槭ャ繝励ｒ菴懈・
  const mergedCellsMap = useMemo(() => {
    const map = new Map<string, MergedCellInfo>();
    mapData.mergedCells.forEach((merge) => {
      map.set(`${merge.startRow}-${merge.startCol}`, merge);
    });
    return map;
  }, [mapData.mergedCells]);

  // executeModeItemIds繧担et縺ｫ螟画鋤・育憾諷玖ｨ育ｮ礼畑・・
  const executeModeItemIdsSet = useMemo(() => {
    return new Set(executeModeItemIds);
  }, [executeModeItemIds]);

  // 繧ｻ繝ｫ縺後い繧､繝・Β繧呈戟縺､縺九←縺・°縺ｮ迥ｶ諷九ｒ險育ｮ・
  const cellStates = useMemo(() => {
    const states = new Map<string, MapCellStateDetail>();

    const dayMatch = mapName.match(/^(.+)繝槭ャ繝・/);
    if (!dayMatch) return states;
    const dayName = dayMatch[1].trim();

    // 蜆ｪ蜈医い繧､繝・Β縺九←縺・°繧貞愛螳壹☆繧矩未謨ｰ
    const isPriorityItem = (item: (typeof items)[number]) => {
      const remarks = item.remarks?.toLowerCase() || '';
      return remarks.includes('優先') || remarks.includes('最優先');
    };

    items.forEach((item) => {
      // 譌･莉倥・豈碑ｼ・ｼ医ヨ繝ｪ繝貂医∩・・
      const itemEventDate = item.eventDate?.trim() || '';
      if (itemEventDate !== dayName) return;

      // 繝悶Ο繝・け蜷阪・豈碑ｼ・      // 縺ｾ縺壼ｮ悟・荳閾ｴ繧定ｩｦ縺ｿ縲∬ｦ九▽縺九ｉ縺ｪ縺・ｴ蜷医・縺ｿ螟ｧ譁・ｭ・蟆乗枚蟄礼┌隕・
      const itemBlockName = item.block?.trim() || '';
      let block = mapData.blocks.find((b) => b.name === itemBlockName);

      // 螳悟・荳閾ｴ縺後↑縺・ｴ蜷医∝､ｧ譁・ｭ・蟆乗枚蟄励ｒ辟｡隕悶＠縺ｦ讀懃ｴ｢・医◆縺縺怜酔蜷阪ヶ繝ｭ繝・け縺瑚､・焚縺ゅｋ蝣ｴ蜷医・髯､縺擾ｼ・
      if (!block) {
        const candidates = mapData.blocks.filter(
          (b) => b.name.toLowerCase() === itemBlockName.toLowerCase(),
        );
        // 蛟呵｣懊′1縺､縺縺代↑繧画治逕ｨ・郁､・焚縺ゅｋ蝣ｴ蜷医・譖匁乂縺ｪ縺ｮ縺ｧ謗｡逕ｨ縺励↑縺・ｼ・
        if (candidates.length === 1) {
          block = candidates[0];
        }
      }

      if (!block) return;

      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;

      const num = parseInt(numStr, 10);
      const cell = block.numberCells.find((nc) => nc.value === num);
      if (!cell) return;

      const key = `${cell.row}-${cell.col}`;
      const existing = states.get(key) || {
        hasItems: false,
        itemCount: 0,
        isVisited: false,
        isFullyVisited: false,
        items: [],
        hasPriorityItem: false,
        hasPriorityUnvisited: false,
      };

      existing.hasItems = true;
      existing.itemCount++;
      existing.items.push(item);

      // 蜆ｪ蜈医い繧､繝・Β縺九←縺・°繧偵メ繧ｧ繝・け
      if (isPriorityItem(item)) {
        existing.hasPriorityItem = true;
        // 險ｪ蝠丞・縺ｫ譛ｪ謖・ｮ壹・蜆ｪ蜈医い繧､繝・Β縺後≠繧九°繝√ぉ繝・け
        if (!executeModeItemIdsSet.has(item.id)) {
          existing.hasPriorityUnvisited = true;
        }
      }

      if (executeModeItemIdsSet.has(item.id)) {
        existing.isVisited = true;
      }

      states.set(key, existing);
    });

    states.forEach((state) => {
      if (state.items.length > 0) {
        const allVisited = state.items.every((item) => executeModeItemIdsSet.has(item.id));
        state.isFullyVisited = allVisited;
      }
    });

    return states;
  }, [mapData.blocks, items, mapName, executeModeItemIdsSet]);

  // 繝ｫ繝ｼ繝育函謌撰ｼ亥━蜈亥ｺｦ諠・ｱ莉倥″・・
  const routePoints = useMemo(() => {
    if (!isRouteVisible) return [];

    const dayMatch = mapName.match(/^(.+)繝槭ャ繝・/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    // executeModeItemIds縺ｮ鬆・ｺ上ｒ邯ｭ謖√☆繧九◆繧√↓縲！D縺ｮ驟榊・鬆・↓繧｢繧､繝・Β繧貞叙蠕・
    const itemsMap = new Map(items.map((item) => [item.id, item]));
    const executeModeItemIdsArray = Array.from(executeModeItemIds);

    const visitItems = executeModeItemIdsArray
      .map((id) => itemsMap.get(id))
      .filter(
        (item): item is (typeof items)[number] => item !== undefined && item.eventDate === dayName,
      );

    const points: Array<{
      row: number;
      col: number;
      order: number;
      priorityLevel: 'none' | 'priority' | 'highest';
    }> = [];

    visitItems.forEach((item, index) => {
      const itemBlockName = item.block?.trim() || '';

      // 螳悟・荳閾ｴ蜆ｪ蜈医〒繝悶Ο繝・け繧呈､懃ｴ｢
      let block = mapData.blocks.find((b) => b.name === itemBlockName);
      if (!block) {
        const candidates = mapData.blocks.filter(
          (b) => b.name.toLowerCase() === itemBlockName.toLowerCase(),
        );
        if (candidates.length === 1) {
          block = candidates[0];
        }
      }
      if (!block) return;

      const numStr = extractNumberFromItemNumber(item.number);
      if (!numStr) return;

      const num = parseInt(numStr, 10);
      const cell = block.numberCells.find((nc) => nc.value === num);
      if (cell) {
        points.push({
          row: cell.row,
          col: cell.col,
          order: index,
          priorityLevel: item.priorityLevel || 'none',
        });
      }
    });

    return points;
  }, [mapData.blocks, items, mapName, executeModeItemIds, isRouteVisible]);

  // 繝ｫ繝ｼ繝医そ繧ｰ繝｡繝ｳ繝・
  const routeSegments = useMemo(() => {
    if (!isRouteVisible || routePoints.length < 2) return [];

    const blockNameCells = new Set<string>();
    mapData.blocks.forEach((block) => {
      for (let r = block.startRow; r <= block.endRow; r++) {
        for (let c = block.startCol; c <= block.endCol; c++) {
          const cell = cellsMap.get(`${r}-${c}`);
          if (cell && cell.value !== null && typeof cell.value === 'string') {
            blockNameCells.add(`${r}-${c}`);
          }
        }
      }
    });

    const segments = generateRouteSegments(mapData, routePoints, blockNameCells);
    return segments.map((seg) => ({
      ...seg,
      path: simplifyPath(seg.path),
    }));
  }, [isRouteVisible, routePoints, mapData, cellsMap]);

  // 謠冗判
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 繧ｭ繝｣繝ｳ繝舌せ繧ｵ繧､繧ｺ繧偵さ繝ｳ繝・リ・医ン繝･繝ｼ繝昴・繝茨ｼ峨し繧､繧ｺ縺ｫ險ｭ螳夲ｼ磯ｫ倩ｧ｣蜒丞ｺｦ蟇ｾ蠢懶ｼ・
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;
    canvas.width = containerWidth * dpr;
    canvas.height = containerHeight * dpr;

    // 繧ｹ繧ｱ繝ｼ繝ｫ隱ｿ謨ｴ
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 繧ｯ繝ｪ繧｢
    ctx.clearRect(0, 0, containerWidth, containerHeight);

    // 繧ｪ繝輔そ繝・ヨ縺ｨ蝗櫁ｻ｢繧帝←逕ｨ・井ｻ･髯阪・謠冗判縺ｯ繝槭ャ繝怜ｺｧ讓咏ｳｻ縺ｧ陦後≧・・
    ctx.save();
    ctx.translate(offset.x, offset.y);
    if (rotationRadians !== 0) {
      ctx.translate(mapCenterX, mapCenterY);
      ctx.rotate(rotationRadians);
      ctx.translate(-mapCenterX, -mapCenterY);
    }

    const viewportCorners = [
      toMapCoordinates(0, 0),
      toMapCoordinates(containerWidth, 0),
      toMapCoordinates(0, containerHeight),
      toMapCoordinates(containerWidth, containerHeight),
    ];
    const visibleMinX = Math.min(...viewportCorners.map((p) => p.x)) - cellSize * 2;
    const visibleMaxX = Math.max(...viewportCorners.map((p) => p.x)) + cellSize * 2;
    const visibleMinY = Math.min(...viewportCorners.map((p) => p.y)) - cellSize * 2;
    const visibleMaxY = Math.max(...viewportCorners.map((p) => p.y)) + cellSize * 2;

    // 蜿ｯ隕悶そ繝ｫ遽・峇繧定ｨ育ｮ暦ｼ域緒逕ｻ譛驕ｩ蛹厄ｼ・
    const visMinCol = Math.max(1, Math.floor(visibleMinX / cellSize) + 1);
    const visMaxCol = Math.min(mapData.maxCol, Math.ceil(visibleMaxX / cellSize) + 1);
    const visMinRow = Math.max(1, Math.floor(visibleMinY / cellSize) + 1);
    const visMaxRow = Math.min(mapData.maxRow, Math.ceil(visibleMaxY / cellSize) + 1);

    // 繧ｻ繝ｫ縺悟庄隕也ｯ・峇蜀・°繝√ぉ繝・け縺吶ｋ繝倥Ν繝代・
    const isCellVisible = (row: number, col: number, spanRows = 1, spanCols = 1): boolean => {
      return (
        col + spanCols - 1 >= visMinCol &&
        col <= visMaxCol &&
        row + spanRows - 1 >= visMinRow &&
        row <= visMaxRow
      );
    };

    // 繧｢繝ｳ繝√お繧､繝ｪ繧｢繧ｹ險ｭ螳・
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const drawUprightText = (text: string, x: number, y: number) => {
      if (rotationRadians === 0) {
        ctx.fillText(text, x, y);
        return;
      }
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-rotationRadians);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };

    const splitTokenByWidth = (token: string, maxLineWidth: number): string[] => {
      const chunks: string[] = [];
      let current = '';

      Array.from(token).forEach((char) => {
        const next = current + char;
        if (current.length > 0 && ctx.measureText(next).width > maxLineWidth) {
          chunks.push(current);
          current = char;
        } else {
          current = next;
        }
      });

      if (current.length > 0) {
        chunks.push(current);
      }
      return chunks.length > 0 ? chunks : [''];
    };

    const tokenizeLineForWrap = (line: string): string[] => {
      const tokens: string[] = [];
      let currentAsciiWord = '';

      const flushAsciiWord = () => {
        if (currentAsciiWord.length === 0) return;
        tokens.push(currentAsciiWord);
        currentAsciiWord = '';
      };

      Array.from(line).forEach((char) => {
        if (/\s/.test(char)) {
          flushAsciiWord();
          tokens.push(char);
          return;
        }
        if (/[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/.test(char)) {
          currentAsciiWord += char;
          return;
        }
        flushAsciiWord();
        tokens.push(char);
      });
      flushAsciiWord();

      return tokens.length > 0 ? tokens : [''];
    };

    const splitTextByWidth = (sourceText: string, maxLineWidth: number): string[] => {
      const rawLines = sourceText.split('\n');
      const wrappedLines: string[] = [];

      rawLines.forEach((rawLine) => {
        if (rawLine.length === 0) {
          wrappedLines.push('');
          return;
        }

        const tokens = tokenizeLineForWrap(rawLine);
        let current = '';

        tokens.forEach((token) => {
          const next = current + token;
          if (current.length > 0 && ctx.measureText(next).width > maxLineWidth) {
            wrappedLines.push(current.trimEnd());

            const normalizedToken = token.trimStart();
            if (normalizedToken.length === 0) {
              current = '';
              return;
            }

            if (ctx.measureText(normalizedToken).width > maxLineWidth) {
              const chunks = splitTokenByWidth(normalizedToken, maxLineWidth);
              wrappedLines.push(...chunks.slice(0, -1));
              current = chunks[chunks.length - 1];
            } else {
              current = normalizedToken;
            }
          } else {
            current = next;
          }
        });

        wrappedLines.push(current.trimEnd());
      });

      return wrappedLines.length > 0 ? wrappedLines : [''];
    };

    const trimLineToWidth = (line: string, maxLineWidth: number): string => {
      let next = line;
      while (next.length > 0 && ctx.measureText(`${next}窶ｦ`).width > maxLineWidth) {
        next = next.slice(0, -1);
      }
      return next.length > 0 ? `${next}窶ｦ` : '窶ｦ';
    };

    const drawFittedHorizontalTextInCell = (
      sourceText: string,
      x: number,
      y: number,
      width: number,
      height: number,
      preferredFontSize: number,
    ) => {
      const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const minFontSize = 6;
      const innerPaddingX = Math.max(1, preferredFontSize * 0.2);
      const innerPaddingY = Math.max(1, preferredFontSize * 0.2);
      const maxLineWidth = Math.max(1, width - innerPaddingX * 2);
      const maxTextHeight = Math.max(1, height - innerPaddingY * 2);

      let resolvedFontSize = Math.max(minFontSize, Math.floor(preferredFontSize));
      let resolvedLineHeight = resolvedFontSize * 1.15;
      let resolvedLines = splitTextByWidth(sourceText, maxLineWidth);

      for (let size = Math.max(minFontSize, Math.floor(preferredFontSize)); size >= minFontSize; size--) {
        ctx.font = `${size}px ${fontFamily}`;
        const candidateLines = splitTextByWidth(sourceText, maxLineWidth);
        const candidateLineHeight = size * 1.15;
        if (candidateLines.length * candidateLineHeight <= maxTextHeight) {
          resolvedFontSize = size;
          resolvedLineHeight = candidateLineHeight;
          resolvedLines = candidateLines;
          break;
        }
      }

      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      const maxLines = Math.max(1, Math.floor(maxTextHeight / resolvedLineHeight));
      if (resolvedLines.length > maxLines) {
        const clamped = resolvedLines.slice(0, maxLines);
        clamped[maxLines - 1] = trimLineToWidth(clamped[maxLines - 1], maxLineWidth);
        resolvedLines = clamped;
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const totalTextHeight = resolvedLines.length * resolvedLineHeight;
      const startY = y + (height - totalTextHeight) / 2 + resolvedLineHeight / 2;
      const centerX = x + width / 2;

      resolvedLines.forEach((line, lineIndex) => {
        const lineY = startY + lineIndex * resolvedLineHeight;
        drawUprightText(line, centerX, lineY);
      });

      ctx.restore();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };

    const drawFittedVerticalTextInCell = (
      sourceText: string,
      x: number,
      y: number,
      width: number,
      height: number,
      preferredFontSize: number,
    ) => {
      const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const minFontSize = 6;
      const columns = sourceText.split(/\n/).map((line) => line || ' ');
      const innerPaddingX = Math.max(1, preferredFontSize * 0.2);
      const innerPaddingY = Math.max(1, preferredFontSize * 0.2);
      const maxTextWidth = Math.max(1, width - innerPaddingX * 2);
      const maxTextHeight = Math.max(1, height - innerPaddingY * 2);

      const canFitVerticalText = (fontSize: number): boolean => {
        const columnSpacing = fontSize * 1.2;
        const rowSpacing = fontSize * 1.1;
        const requiredWidth = columns.length * columnSpacing;
        const requiredHeight = Math.max(...columns.map((column) => Array.from(column).length)) * rowSpacing;
        return requiredWidth <= maxTextWidth && requiredHeight <= maxTextHeight;
      };

      let resolvedFontSize = Math.max(minFontSize, Math.floor(preferredFontSize));
      for (let size = Math.max(minFontSize, Math.floor(preferredFontSize)); size >= minFontSize; size--) {
        if (canFitVerticalText(size)) {
          resolvedFontSize = size;
          break;
        }
      }

      const columnSpacing = resolvedFontSize * 1.2;
      const rowSpacing = resolvedFontSize * 1.1;
      const maxColumns = Math.max(1, Math.floor(maxTextWidth / columnSpacing));
      const maxRows = Math.max(1, Math.floor(maxTextHeight / rowSpacing));

      let drawableColumns = columns.slice(0, maxColumns).map((column) => Array.from(column));
      const hadHiddenColumns = columns.length > maxColumns;

      drawableColumns = drawableColumns.map((chars) => {
        if (chars.length <= maxRows) return chars;
        const trimmed = chars.slice(0, maxRows);
        trimmed[maxRows - 1] = '窶ｦ';
        return trimmed;
      });

      if (hadHiddenColumns) {
        const lastColumnIndex = drawableColumns.length - 1;
        const lastColumn = drawableColumns[lastColumnIndex];
        if (lastColumn.length < maxRows) {
          lastColumn.push('窶ｦ');
        } else {
          lastColumn[lastColumn.length - 1] = '窶ｦ';
        }
      }

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.font = `${resolvedFontSize}px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const totalWidth = drawableColumns.length * columnSpacing;
      const startX = x + width / 2 + (totalWidth - columnSpacing) / 2;

      drawableColumns.forEach((chars, columnIndex) => {
        const totalHeight = chars.length * rowSpacing;
        const startY = y + (height - totalHeight) / 2 + rowSpacing / 2;
        const columnX = startX - columnIndex * columnSpacing;

        chars.forEach((char, charIndex) => {
          const charY = startY + charIndex * rowSpacing;
          drawUprightText(char, columnX, charY);
        });
      });

      ctx.restore();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    };

    // 鮟・牡縺ｨ鮟偵・譁懊ａ繧ｹ繝医Λ繧､繝励ヱ繧ｿ繝ｼ繝ｳ繧剃ｽ懈・
    const createWarningStripePattern = () => {
      if (isRotationInteracting) return null;
      const patternCanvas = document.createElement('canvas');
      const stripeSize = Math.max(8, cellSize * 0.4); // 繧ｹ繝医Λ繧､繝励・螟ｪ縺・
      patternCanvas.width = stripeSize * 2;
      patternCanvas.height = stripeSize * 2;
      const patternCtx = patternCanvas.getContext('2d');
      if (!patternCtx) return null;

      // 閭梧勹繧帝ｻ・牡縺ｧ蝪励ｊ縺､縺ｶ縺・
      patternCtx.fillStyle = '#FFD600';
      patternCtx.fillRect(0, 0, stripeSize * 2, stripeSize * 2);

      // 鮟偵・譁懊ａ繧ｹ繝医Λ繧､繝励ｒ謠冗判
      patternCtx.fillStyle = '#212121';
      patternCtx.beginPath();
      // 蟾ｦ荳九°繧牙承荳翫∈縺ｮ譁懊ａ邱夲ｼ医ヱ繧ｿ繝ｼ繝ｳ縺ｨ縺励※郢ｰ繧願ｿ斐＆繧後ｋ・・
      patternCtx.moveTo(0, stripeSize * 2);
      patternCtx.lineTo(stripeSize, stripeSize * 2);
      patternCtx.lineTo(stripeSize * 2, stripeSize);
      patternCtx.lineTo(stripeSize * 2, 0);
      patternCtx.lineTo(stripeSize, 0);
      patternCtx.lineTo(0, stripeSize);
      patternCtx.closePath();
      patternCtx.fill();

      return ctx.createPattern(patternCanvas, 'repeat');
    };

    const warningPattern = createWarningStripePattern();

    if (!isRotationInteracting && vertexSelectionMode && (showSelectionGrid || showSelectionRuler)) {
      if (showSelectionGrid) {
        ctx.save();
        ctx.strokeStyle = isDarkMode ? 'rgba(148, 163, 184, 0.22)' : 'rgba(59, 130, 246, 0.2)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);

        for (let row = visMinRow; row <= visMaxRow + 1; row++) {
          const y = (row - 1) * cellSize;
          ctx.beginPath();
          ctx.moveTo((visMinCol - 1) * cellSize, y);
          ctx.lineTo(visMaxCol * cellSize, y);
          ctx.stroke();
        }

        for (let col = visMinCol; col <= visMaxCol + 1; col++) {
          const x = (col - 1) * cellSize;
          ctx.beginPath();
          ctx.moveTo(x, (visMinRow - 1) * cellSize);
          ctx.lineTo(x, visMaxRow * cellSize);
          ctx.stroke();
        }

        ctx.setLineDash([]);
        ctx.restore();
      }

      if (showSelectionRuler) {
        const labelFontSize = Math.max(8, Math.min(11, cellSize * 0.38));
        const topLabelHeight = Math.max(12, cellSize * 0.42);
        const leftLabelWidth = Math.max(18, cellSize * 0.55);
        const labelBg = isDarkMode ? 'rgba(15, 23, 42, 0.78)' : 'rgba(255, 255, 255, 0.82)';
        const labelText = isDarkMode ? '#E2E8F0' : '#1E293B';

        ctx.save();
        ctx.font = `${labelFontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = labelBg;

        for (let col = visMinCol; col <= visMaxCol; col++) {
          const x = (col - 1) * cellSize;
          const y = (visMinRow - 1) * cellSize;
          ctx.fillRect(x, y, cellSize, topLabelHeight);
        }

        for (let row = visMinRow; row <= visMaxRow; row++) {
          const x = (visMinCol - 1) * cellSize;
          const y = (row - 1) * cellSize;
          ctx.fillRect(x, y, leftLabelWidth, cellSize);
        }

        ctx.fillStyle = labelText;
        for (let col = visMinCol; col <= visMaxCol; col++) {
          const x = (col - 0.5) * cellSize;
          const y = (visMinRow - 1) * cellSize + topLabelHeight / 2;
          drawUprightText(String(col), x, y);
        }
        for (let row = visMinRow; row <= visMaxRow; row++) {
          const x = (visMinCol - 1) * cellSize + leftLabelWidth / 2;
          const y = (row - 0.5) * cellSize;
          drawUprightText(String(row), x, y);
        }
        ctx.restore();
      }
    }

    // 1. 閭梧勹繧呈緒逕ｻ
    mapData.cells.forEach((cell) => {
      if (cell.isMerged) return;

      const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
      const spanCols = merge ? merge.endCol - merge.startCol + 1 : 1;
      const spanRows = merge ? merge.endRow - merge.startRow + 1 : 1;
      if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;

      const x = (cell.col - 1) * cellSize;
      const y = (cell.row - 1) * cellSize;

      const width = spanCols * cellSize;
      const height = spanRows * cellSize;

      // 閭梧勹濶ｲ
      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }

      // 繧ｻ繝ｫ迥ｶ諷九↓蠢懊§縺溯レ譎ｯ
      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state) {
        if (state.isFullyVisited) {
          ctx.fillStyle = 'rgba(239, 83, 80, 0.5)'; // 襍､・壼・險ｪ蝠乗ｸ医∩
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPriorityUnvisited && warningPattern) {
          // 鮟・牡縺ｨ鮟偵・譁懊ａ繧ｹ繝医Λ繧､繝暦ｼ壼━蜈・蟋碑ｨ礼┌縺ｮ譛ｪ險ｪ蝠上い繧､繝・Β縺ゅｊ・井ｸ驛ｨ險ｪ蝠上ｈ繧雁━蜈茨ｼ・
          ctx.fillStyle = warningPattern;
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPriorityUnvisited) {
          // 蝗櫁ｻ｢謫堺ｽ應ｸｭ縺ｯ蜊倩牡縺ｧ邁｡逡･陦ｨ遉ｺ
          ctx.fillStyle = 'rgba(255, 214, 0, 0.45)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          ctx.fillStyle = 'rgba(255, 238, 88, 0.5)'; // 鮟・ｼ壻ｸ驛ｨ險ｪ蝠乗ｸ医∩・亥━蜈医い繧､繝・Β縺ｯ險ｪ蝠乗ｸ医∩・・
          ctx.fillRect(x, y, width, height);
        } else if (state.hasItems) {
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)'; // 髱抵ｼ夐壼ｸｸ縺ｮ譛ｪ險ｪ蝠上い繧､繝・Β縺ゅｊ
          ctx.fillRect(x, y, width, height);
        }
      }
    });

    // 2. 鄂ｫ邱壹ｒ謠冗判・医ぜ繝ｼ繝繝ｬ繝吶Ν縺ｫ蠢懊§縺ｦ・・
    if (showBorders && !isRotationInteracting) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const spanCols = merge ? merge.endCol - merge.startCol + 1 : 1;
        const spanRows = merge ? merge.endRow - merge.startRow + 1 : 1;
        if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const width = spanCols * cellSize;
        const height = spanRows * cellSize;

        const { borders } = cell;

        const drawBorder = (
          startX: number,
          startY: number,
          endX: number,
          endY: number,
          border: typeof borders.top,
        ) => {
          if (!border) return;

          ctx.beginPath();
          ctx.strokeStyle = border.color || '#000000'; // 繝・ヵ繧ｩ繝ｫ繝郁牡繧帝ｻ偵↓螟画峩

          let lineWidth = 1;
          switch (border.style) {
            case 'thin':
              lineWidth = 1;
              break;
            case 'medium':
              lineWidth = 2;
              break;
            case 'thick':
              lineWidth = 3;
              break;
            default:
              lineWidth = 1;
          }
          ctx.lineWidth = lineWidth;

          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
        };

        if (borders.top) drawBorder(x, y, x + width, y, borders.top);
        if (borders.right) drawBorder(x + width, y, x + width, y + height, borders.right);
        if (borders.bottom) drawBorder(x, y + height, x + width, y + height, borders.bottom);
        if (borders.left) drawBorder(x, y, x, y + height, borders.left);

        // 数字セルの罫線は背景塗りのみで表示する
      });
    }

    // 3. 繝・く繧ｹ繝医ｒ謠冗判・医ぜ繝ｼ繝繝ｬ繝吶Ν縺ｫ蠢懊§縺ｦ・・
    if (showNumbers) {
      mapData.cells.forEach((cell) => {
        if (cell.isMerged || cell.value === null) return;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const spanCols = merge ? merge.endCol - merge.startCol + 1 : 1;
        const spanRows = merge ? merge.endRow - merge.startRow + 1 : 1;
        if (!isCellVisible(cell.row, cell.col, spanRows, spanCols)) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const width = spanCols * cellSize;
        const height = spanRows * cellSize;

        const text = String(cell.value);
        const isVertical = cell.isVerticalText;

        // 繝輔か繝ｳ繝医し繧､繧ｺ繧定ｨ育ｮ・
        let fontSize: number;
        if (merge) {
          // 邨仙粋繧ｻ繝ｫ縺ｯ螟ｧ縺阪ａ
          if (isVertical) {
            // 邵ｦ譖ｸ縺阪・蝣ｴ蜷医・鬮倥＆縺ｫ蝓ｺ縺･縺・※繧ｵ繧､繧ｺ繧定ｪｿ謨ｴ
            const charCount = text.replace(/\n/g, '').length;
            fontSize = Math.min(width * 0.6, (height / (charCount + 1)) * 0.9, 16);
          } else {
            fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
          }
        } else if (typeof cell.value === 'number') {
          // 謨ｰ蛟､繧ｻ繝ｫ
          fontSize = Math.min(cellSize * 0.45, 14);
        } else {
          // 繝・く繧ｹ繝医そ繝ｫ
          fontSize = Math.min(cellSize * 0.4, 12);
        }

        fontSize = Math.max(fontSize, 8); // 譛蟆上し繧､繧ｺ

        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 繝・く繧ｹ繝郁牡縺ｨ繧ｹ繧ｿ繧､繝ｫ
        const state = cellStates.get(`${cell.row}-${cell.col}`);
        const explicitFontColor = cell.fontColor?.trim();
        const enforceBlackNumberTextInDarkMode =
          isDarkMode && Boolean(state?.hasItems) && isNumberLikeCellValue(cell.value);

        // 蜆ｪ蜈医い繧､繝・Β・磯ｻ・ｻ偵せ繝医Λ繧､繝苓レ譎ｯ・峨・蝣ｴ蜷医・逋ｽ閭梧勹繧呈緒逕ｻ
        if (state?.hasPriorityUnvisited && typeof cell.value === 'number') {
          const textMetrics = ctx.measureText(text);
          const textWidth = textMetrics.width;
          const textHeight = fontSize;
          const padding = fontSize * 0.3;

          // 隗剃ｸｸ縺ｮ逋ｽ閭梧勹繧呈緒逕ｻ
          const bgX = x + width / 2 - textWidth / 2 - padding;
          const bgY = y + height / 2 - textHeight / 2 - padding * 0.5;
          const bgWidth = textWidth + padding * 2;
          const bgHeight = textHeight + padding;
          const radius = Math.min(padding, bgHeight / 2);

          ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
          ctx.beginPath();
          ctx.roundRect(bgX, bgY, bgWidth, bgHeight, radius);
          ctx.fill();

          if (enforceBlackNumberTextInDarkMode && !isWhiteLikeColor(explicitFontColor)) {
            ctx.fillStyle = '#111111';
          } else if (explicitFontColor) {
            ctx.fillStyle = resolveMapTextColorForTheme(explicitFontColor, isDarkMode, '#212121');
          } else {
            // 繝・く繧ｹ繝郁牡縺ｯ鮟偵〒逶ｮ遶九◆縺帙ｋ
            ctx.fillStyle = '#212121';
          }
        } else if (enforceBlackNumberTextInDarkMode && !isWhiteLikeColor(explicitFontColor)) {
          ctx.fillStyle = '#111111';
        } else if (explicitFontColor) {
          ctx.fillStyle = resolveMapTextColorForTheme(explicitFontColor, isDarkMode);
        } else if (state?.isFullyVisited) {
          ctx.fillStyle = '#B71C1C'; // 豼・＞襍､・壼・險ｪ蝠乗ｸ医∩
        } else if (state?.isVisited) {
          ctx.fillStyle = '#F57F17'; // 繧ｪ繝ｬ繝ｳ繧ｸ・壻ｸ驛ｨ險ｪ蝠乗ｸ医∩
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0'; // 髱抵ｼ夐壼ｸｸ縺ｮ譛ｪ險ｪ蝠上い繧､繝・Β縺ゅｊ
        } else {
          ctx.fillStyle = resolveMapTextColorForTheme(cell.fontColor, isDarkMode);
        }

        // 邵ｦ譖ｸ縺阪・蝣ｴ蜷・
        if (isVertical) {
          if (rotationRadians !== 0) {
            drawFittedVerticalTextInCell(text, x, y, width, height, fontSize);
          } else {
            // 謾ｹ陦後〒蛻・牡縺輔ｌ縺ｦ縺・ｋ蝣ｴ蜷医・蜷・｡後ｒ蛻･縲・↓謠冗判
            const lines = text.split(/\n/);
            const lineSpacing = fontSize * 1.2;
            const totalWidth = lines.length * lineSpacing;
            const startX = x + width / 2 + (totalWidth - lineSpacing) / 2;

            lines.forEach((line, lineIndex) => {
              const chars = line.split('');
              const totalHeight = chars.length * fontSize * 1.1;
              const startY = y + (height - totalHeight) / 2 + fontSize / 2;
              const lineX = startX - lineIndex * lineSpacing;

              chars.forEach((char, charIndex) => {
                const charY = startY + charIndex * fontSize * 1.1;
                drawUprightText(char, lineX, charY);
              });
            });
          }
        } else if (rotationRadians !== 0) {
          drawFittedHorizontalTextInCell(text, x, y, width, height, fontSize);
        } else {
          drawUprightText(text, x + width / 2, y + height / 2);
        }
      });
    } else {
      // 邵ｮ蟆乗凾縺ｯ謨ｰ蛟､繧ｻ繝ｫ縺ｮ縺ｿ繝峨ャ繝郁｡ｨ遉ｺ
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        if (!state?.hasItems) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

        // 繝峨ャ繝郁｡ｨ遉ｺ
        const dotSize = Math.max(cellSize * 0.4, 4);
        ctx.beginPath();

        if (state.isFullyVisited) {
          ctx.fillStyle = '#EF5350'; // 襍､・壼・險ｪ蝠乗ｸ医∩
        } else if (state.hasPriorityUnvisited) {
          // 鮟・ｻ偵・隴ｦ蜻願牡・医ラ繝・ヨ縺ｧ縺ｯ鮟・牡縺ｫ鮟呈棧・・ 荳驛ｨ險ｪ蝠上ｈ繧雁━蜈・
          ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#FFD600';
          ctx.fill();
          ctx.strokeStyle = '#212121';
          ctx.lineWidth = Math.max(1, dotSize * 0.2);
          ctx.stroke();
          return; // 既に描画済みなのでここで終了
        } else if (state.isVisited) {
          ctx.fillStyle = '#FFEE58'; // 鮟・ｼ壻ｸ驛ｨ險ｪ蝠乗ｸ医∩
        } else {
          ctx.fillStyle = '#42A5F5'; // 髱抵ｼ夐壼ｸｸ縺ｮ譛ｪ險ｪ蝠上い繧､繝・Β縺ゅｊ
        }

        ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 4. 繝ｫ繝ｼ繝医ｒ謠冗判・亥━蜈亥ｺｦ縺ｧ濶ｲ蛻・￠縲・㍾隍・Κ蛻・・蟷ｳ陦檎ｷ夲ｼ・
    if (!isRotationInteracting && isRouteVisible && routeSegments.length > 0) {
      // 蜆ｪ蜈亥ｺｦ縺斐→縺ｮ濶ｲ繧貞ｮ夂ｾｩ
      const getPriorityColor = (priority: 'none' | 'priority' | 'highest' | undefined): string => {
        switch (priority) {
          case 'highest':
            return '#EF4444'; // 襍､
          case 'priority':
            return '#F97316'; // 繧ｪ繝ｬ繝ｳ繧ｸ
          default:
            return '#1976D2'; // 青
        }
      };

      // 繧ｰ繝ｫ繝ｼ繝鈴俣謗･邯壹°縺ｩ縺・°繧貞愛螳・
      const isGroupTransition = (
        fromPriority: string | undefined,
        toPriority: string | undefined,
      ): boolean => {
        const from = fromPriority || 'none';
        const to = toPriority || 'none';
        return from !== to;
      };

      // 繧ｨ繝・ず縺斐→縺ｮ騾夐℃諠・ｱ繧貞庶髮・ｼ磯㍾隍・､懷・逕ｨ・・      // 繧ｭ繝ｼ: "row1,col1-row2,col2"・亥ｰ上＆縺・ｺｧ讓吶ｒ蜈医↓・・
      const edgeUsage = new Map<string, Set<'none' | 'priority' | 'highest'>>();

      const getEdgeKey = (r1: number, c1: number, r2: number, c2: number): string => {
        // 蟶ｸ縺ｫ蟆上＆縺・ｺｧ讓吶ｒ蜈医↓縺励※豁｣隕丞喧
        if (r1 < r2 || (r1 === r2 && c1 < c2)) {
          return `${r1},${c1}-${r2},${c2}`;
        }
        return `${r2},${c2}-${r1},${c1}`;
      };

      // 蜈ｨ繧ｻ繧ｰ繝｡繝ｳ繝医・繧ｨ繝・ず繧貞庶髮・
      routeSegments.forEach((segment) => {
        if (segment.path.length < 2) return;

        // 繧ｰ繝ｫ繝ｼ繝鈴俣謗･邯壹・繧ｰ繝ｬ繝ｼ縺ｪ縺ｮ縺ｧ驥崎､・き繧ｦ繝ｳ繝医↓蜷ｫ繧√↑縺・
        if (isGroupTransition(segment.fromPriority, segment.toPriority)) return;

        const priority = segment.fromPriority || 'none';

        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];
          const key = getEdgeKey(p1.row, p1.col, p2.row, p2.col);

          if (!edgeUsage.has(key)) {
            edgeUsage.set(key, new Set());
          }
          edgeUsage.get(key)!.add(priority);
        }
      });

      // 繧ｻ繧ｰ繝｡繝ｳ繝医ｒ謠冗判
      const lineWidth = Math.max(2, cellSize * 0.08); // 蟆代＠邏ｰ縺・
      // 蟷ｳ陦檎ｷ壹・繧ｪ繝輔そ繝・ヨ驥上ｒ險育ｮ暦ｼ医そ繝ｫ繧ｵ繧､繧ｺ縺ｫ蠢懊§縺ｦ隱ｿ謨ｴ・・
      const parallelOffset = Math.max(3, cellSize * 0.12);

      // 邱壹ｒ繧ｪ繝輔そ繝・ヨ縺吶ｋ髢｢謨ｰ
      const getOffsetPoints = (
        px1: number,
        py1: number,
        px2: number,
        py2: number,
        offset: number,
      ): { x1: number; y1: number; x2: number; y2: number } => {
        // 邱壹・譁ｹ蜷代・繧ｯ繝医Ν
        const dx = px2 - px1;
        const dy = py2 - py1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return { x1: px1, y1: py1, x2: px2, y2: py2 };

        // 豕慕ｷ壹・繧ｯ繝医Ν・・0蠎ｦ蝗櫁ｻ｢・・
        const nx = -dy / len;
        const ny = dx / len;

        return {
          x1: px1 + nx * offset,
          y1: py1 + ny * offset,
          x2: px2 + nx * offset,
          y2: py2 + ny * offset,
        };
      };

      routeSegments.forEach((segment) => {
        if (segment.path.length < 2) return;

        const isTransition = isGroupTransition(segment.fromPriority, segment.toPriority);
        const segmentPriority = segment.fromPriority || 'none';

        // 繧ｰ繝ｫ繝ｼ繝鈴俣謗･邯壹・繧ｰ繝ｬ繝ｼ
        const baseColor = isTransition ? '#9CA3AF' : getPriorityColor(segment.fromPriority);

        // 繝代せ繧剃ｸ蠎ｦ縺ｫ謠冗判縺吶ｋ縺ｮ縺ｧ縺ｯ縺ｪ縺上√お繝・ず縺斐→縺ｫ謠冗判
        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];
          const edgeKey = getEdgeKey(p1.row, p1.col, p2.row, p2.col);

          const px1 = (p1.col - 0.5) * cellSize;
          const py1 = (p1.row - 0.5) * cellSize;
          const px2 = (p2.col - 0.5) * cellSize;
          const py2 = (p2.row - 0.5) * cellSize;

          // 繧ｰ繝ｫ繝ｼ繝鈴俣謗･邯壹・驥崎､・メ繧ｧ繝・け荳崎ｦ・ｼ井ｸｭ螟ｮ縺ｫ謠冗判・・
          if (isTransition) {
            ctx.beginPath();
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(px1, py1);
            ctx.lineTo(px2, py2);
            ctx.stroke();
            continue;
          }

          // 驥崎､・＠縺ｦ縺・ｋ繧ｨ繝・ず縺九←縺・°繧堤｢ｺ隱・
          const usedPriorities = edgeUsage.get(edgeKey);
          const isOverlapping = usedPriorities && usedPriorities.size > 1;

          if (isOverlapping) {
            // 驥崎､・お繝・ず・壼ｹｳ陦檎ｷ壹〒謠冗判
            const priorities = Array.from(usedPriorities!).sort((a, b) => {
              const order = { highest: 0, priority: 1, none: 2 };
              return order[a] - order[b];
            });

            // 縺薙・繧ｻ繧ｰ繝｡繝ｳ繝医・蜆ｪ蜈亥ｺｦ縺ｮ繧､繝ｳ繝・ャ繧ｯ繧ｹ繧貞叙蠕・
            const priorityIndex = priorities.indexOf(segmentPriority);
            if (priorityIndex === -1) continue;

            // 繧ｪ繝輔そ繝・ヨ驥上ｒ險育ｮ暦ｼ井ｸｭ螟ｮ繧貞渕貅悶↓蝮・ｭ峨↓驟咲ｽｮ・・
            const totalLines = priorities.length;
            const offsetIndex = priorityIndex - (totalLines - 1) / 2;
            const offset = offsetIndex * parallelOffset;

            // 繧ｪ繝輔そ繝・ヨ縺励◆蠎ｧ讓吶ｒ險育ｮ・
            const offsetted = getOffsetPoints(px1, py1, px2, py2, offset);

            ctx.beginPath();
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(offsetted.x1, offsetted.y1);
            ctx.lineTo(offsetted.x2, offsetted.y2);
            ctx.stroke();
          } else {
            // 驥崎､・↑縺暦ｼ夐壼ｸｸ縺ｮ螳溽ｷ・
            ctx.beginPath();
            ctx.strokeStyle = baseColor;
            ctx.lineWidth = lineWidth;
            ctx.lineCap = 'round';
            ctx.setLineDash([]);
            ctx.moveTo(px1, py1);
            ctx.lineTo(px2, py2);
            ctx.stroke();
          }
        }

        // 遏｢蜊ｰ・医そ繧ｰ繝｡繝ｳ繝育ｵらせ縺ｫ謠冗判・・
        if (segment.path.length >= 2) {
          const last = segment.path[segment.path.length - 1];
          const prev = segment.path[segment.path.length - 2];

          const endX = (last.col - 0.5) * cellSize;
          const endY = (last.row - 0.5) * cellSize;
          const angle = Math.atan2(
            (last.row - prev.row) * cellSize,
            (last.col - prev.col) * cellSize,
          );

          const arrowSize = Math.max(6, cellSize * 0.25);
          ctx.beginPath();
          ctx.fillStyle = baseColor;
          ctx.moveTo(endX, endY);
          ctx.lineTo(
            endX - arrowSize * Math.cos(angle - Math.PI / 6),
            endY - arrowSize * Math.sin(angle - Math.PI / 6),
          );
          ctx.lineTo(
            endX - arrowSize * Math.cos(angle + Math.PI / 6),
            endY - arrowSize * Math.sin(angle + Math.PI / 6),
          );
          ctx.closePath();
          ctx.fill();
        }
      });

      // setLineDash繧偵Μ繧ｻ繝・ヨ
      ctx.setLineDash([]);

      // 險ｪ蝠城・分蜿ｷ・亥━蜈亥ｺｦ縺ｧ濶ｲ蛻・￠・・
      if (isDetailedView) {
        routePoints.forEach((point) => {
          const px = (point.col - 0.5) * cellSize;
          const py = (point.row - 0.5) * cellSize;

          const circleSize = Math.max(12, cellSize * 0.5);
          const pointColor = getPriorityColor(point.priorityLevel);

          ctx.beginPath();
          ctx.fillStyle = pointColor;
          ctx.arc(px, py, circleSize / 2, 0, Math.PI * 2);
          ctx.fill();

          ctx.font = `bold ${Math.max(8, circleSize * 0.6)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#FFFFFF';
          drawUprightText(String(point.order + 1), px, py);
        });
      }
    }

    // 5. 險ｪ蝠丞・繝ｪ繧ｹ繝医°繧峨・繧ｻ繝ｫ繝上う繝ｩ繧､繝・
    if (!isRotationInteracting && highlightedCell) {
      const x = (highlightedCell.col - 1) * cellSize;
      const y = (highlightedCell.row - 1) * cellSize;

      // 繝代Ν繧ｹ繧｢繝九Γ繝ｼ繧ｷ繝ｧ繝ｳ鬚ｨ縺ｮ繝上う繝ｩ繧､繝・
      ctx.save();

      // 螟門・縺ｮ繝ｪ繝ｳ繧ｰ
      ctx.strokeStyle = '#FF6B00';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);

      // 蜀・・縺ｮ繝ｪ繝ｳ繧ｰ
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);

      ctx.restore();
    }

    // 6. 繝帙・繝ｫ鬆らせ驕ｸ謚槭・繝ｬ繝薙Η繝ｼ・亥､夊ｧ貞ｽ｢繧ｪ繝ｼ繝舌・繝ｬ繧､・・
    if (!isRotationInteracting && vertexSelectionMode && hoverGuide) {
      const hoverCellX = (hoverGuide.col - 1) * cellSize;
      const hoverCellY = (hoverGuide.row - 1) * cellSize;
      const hoverCenterX = (hoverGuide.col - 0.5) * cellSize;
      const hoverCenterY = (hoverGuide.row - 0.5) * cellSize;

      ctx.save();
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.strokeRect(hoverCellX + 1, hoverCellY + 1, cellSize - 2, cellSize - 2);

      if (vertexSelectionMode.clickedVertices.length > 0) {
        const lastVertex =
          vertexSelectionMode.clickedVertices[vertexSelectionMode.clickedVertices.length - 1];
        const lastX = (lastVertex.col - 0.5) * cellSize;
        const lastY = (lastVertex.row - 0.5) * cellSize;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(14, 165, 233, 0.85)';
        ctx.lineWidth = Math.max(2, cellSize * 0.08);
        ctx.setLineDash([6, 4]);
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(hoverCenterX, hoverCenterY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const label = `(${hoverGuide.row},${hoverGuide.col})`;
      ctx.font = `${Math.max(10, cellSize * 0.33)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelPaddingX = 7;
      const labelWidth = ctx.measureText(label).width + labelPaddingX * 2;
      const labelHeight = Math.max(18, cellSize * 0.46);
      const labelX = hoverCenterX + labelWidth / 2 + 6;
      const labelY = hoverCenterY - labelHeight / 2 - 6;

      ctx.fillStyle = isDarkMode ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)';
      ctx.fillRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.fillStyle = isDarkMode ? '#E2E8F0' : '#0F172A';
      drawUprightText(label, labelX, labelY);
      ctx.restore();
    }

    if (!isRotationInteracting && vertexSelectionMode && vertexSelectionMode.clickedVertices.length >= 3) {
      const vertices = vertexSelectionMode.clickedVertices;

      // 繝励Ξ繝薙Η繝ｼ逕ｨ縺ｫ驥榊ｿ・ｧ貞ｺｦ繧ｽ繝ｼ繝医＠縺ｦ霎ｺ莠､蟾ｮ繧帝亟豁｢
      const centroidRow = vertices.reduce((s, v) => s + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((s, v) => s + v.col, 0) / vertices.length;
      const sortedVertices = [...vertices].sort((a, b) => {
        return (
          Math.atan2(a.row - centroidRow, a.col - centroidCol) -
          Math.atan2(b.row - centroidRow, b.col - centroidCol)
        );
      });

      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.4)'; // 荳埼乗・蠎ｦ40%縺ｮ襍､

      sortedVertices.forEach((vertex, i) => {
        // 繧ｻ繝ｫ縺ｮ荳ｭ蠢・ｺｧ讓・
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        if (i === 0) {
          ctx.moveTo(px, py);
        } else {
          ctx.lineTo(px, py);
        }
      });

      ctx.closePath();
      ctx.fill();

      // 鬆らせ繝槭・繧ｫ繝ｼ縺ｨ逡ｪ蜿ｷ繧呈緒逕ｻ・医け繝ｪ繝・け鬆・〒陦ｨ遉ｺ・・
      vertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        // 鬆らせ繝槭・繧ｫ繝ｼ・育區縺・・・・
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 逡ｪ蜿ｷ
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF0000';
        drawUprightText(String(i + 1), px, py);
      });
    } else if (!isRotationInteracting && vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
      // 3轤ｹ譛ｪ貅縺ｮ蝣ｴ蜷医・轤ｹ縺ｨ邱壹・縺ｿ陦ｨ遉ｺ
      const vertices = vertexSelectionMode.clickedVertices;

      // 邱壹ｒ謠冗判・・轤ｹ莉･荳翫・蝣ｴ蜷茨ｼ・
      if (vertices.length >= 2) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.6)';
        ctx.lineWidth = Math.max(2, cellSize * 0.08);

        vertices.forEach((vertex, i) => {
          const px = (vertex.col - 0.5) * cellSize;
          const py = (vertex.row - 0.5) * cellSize;

          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        });

        ctx.stroke();
      }

      // 鬆らせ繝槭・繧ｫ繝ｼ縺ｨ逡ｪ蜿ｷ繧呈緒逕ｻ
      vertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF0000';
        drawUprightText(String(i + 1), px, py);
      });
    }

    // 7. 繝悶Ο繝・け螳夂ｾｩ繧ｻ繝ｫ驕ｸ謚槭・繝ｼ繧ｫ繝ｼ + 遽・峇繝励Ξ繝薙Η繝ｼ
    if (!isRotationInteracting && cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
      const clickedCells = cellSelectionMode.clickedCells;
      const selType = cellSelectionMode.type;

      // Phase 3: 阮・ｷ題牡縺ｮ遽・峇繝励Ξ繝薙Η繝ｼ・・轤ｹ莉･荳奇ｼ・
      if (clickedCells.length >= 2) {
        if (selType === 'individual') {
          // 蛟句挨繝｢繝ｼ繝・ 蜷・そ繝ｫ繧貞句挨縺ｫ阮・ｷ代〒繝上う繝ｩ繧､繝・
          clickedCells.forEach((cell) => {
            // 邨仙粋繧ｻ繝ｫ蟇ｾ蠢・
            const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
            const cx = mergeInfo ? (mergeInfo.startCol - 1) * cellSize : (cell.col - 1) * cellSize;
            const cy = mergeInfo ? (mergeInfo.startRow - 1) * cellSize : (cell.row - 1) * cellSize;
            const cw = mergeInfo
              ? (mergeInfo.endCol - mergeInfo.startCol + 1) * cellSize
              : cellSize;
            const ch = mergeInfo
              ? (mergeInfo.endRow - mergeInfo.startRow + 1) * cellSize
              : cellSize;
            ctx.fillStyle = 'rgba(144, 238, 144, 0.35)';
            ctx.fillRect(cx, cy, cw, ch);
          });
        } else {
          // corner/multiCorner/rangeStart: 繝舌え繝ｳ繝・ぅ繝ｳ繧ｰ繝懊ャ繧ｯ繧ｹ繧定埋邱代〒繝上う繝ｩ繧､繝・
          const rows = clickedCells.map((c) => c.row);
          const cols = clickedCells.map((c) => c.col);
          const minRow = Math.min(...rows);
          const maxRow = Math.max(...rows);
          const minCol = Math.min(...cols);
          const maxCol = Math.max(...cols);

          // 邨仙粋繧ｻ繝ｫ繧定・・縺励※螳滄圀縺ｮ陦ｨ遉ｺ遽・峇繧呈僑蠑ｵ
          let displayMaxRow = maxRow;
          let displayMaxCol = maxCol;
          clickedCells.forEach((cell) => {
            const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
            if (mergeInfo) {
              displayMaxRow = Math.max(displayMaxRow, mergeInfo.endRow);
              displayMaxCol = Math.max(displayMaxCol, mergeInfo.endCol);
            }
          });

          const rx = (minCol - 1) * cellSize;
          const ry = (minRow - 1) * cellSize;
          const rw = (displayMaxCol - minCol + 1) * cellSize;
          const rh = (displayMaxRow - minRow + 1) * cellSize;
          ctx.fillStyle = 'rgba(144, 238, 144, 0.35)';
          ctx.fillRect(rx, ry, rw, rh);
          // 譫邱・
          ctx.strokeStyle = 'rgba(76, 175, 80, 0.7)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 3]);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
        }
      }

      // Phase 2: 髱定牡繝槭・繧ｫ繝ｼ繧呈緒逕ｻ
      clickedCells.forEach((cell, i) => {
        // 邨仙粋繧ｻ繝ｫ縺ｮ蝣ｴ蜷医・邨仙粋遽・峇縺ｮ荳ｭ蠢・↓繝槭・繧ｫ繝ｼ繧定｡ｨ遉ｺ
        const mergeInfo = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        let px: number, py: number;
        if (mergeInfo) {
          px =
            (mergeInfo.startCol - 1 + (mergeInfo.endCol - mergeInfo.startCol + 1) / 2) * cellSize;
          py =
            (mergeInfo.startRow - 1 + (mergeInfo.endRow - mergeInfo.startRow + 1) / 2) * cellSize;
        } else {
          px = (cell.col - 0.5) * cellSize;
          py = (cell.row - 0.5) * cellSize;
        }

        // 繝槭・繧ｫ繝ｼ・育區縺・・・矩搨譫・・
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 逡ｪ蜿ｷ
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#2196F3';
        drawUprightText(String(i + 1), px, py);
      });
    }

    // ctx.translate 繧定ｧ｣髯､
    ctx.restore();

    if ((vertexSelectionMode || cellSelectionMode) && tapAssist) {
      const lensRadius = Math.max(36, Math.min(64, cellSize * 1.4));
      const lensDiameter = lensRadius * 2;
      const sourceSize = Math.max(24, cellSize * 1.8);
      const srcX = Math.max(
        0,
        Math.min(containerWidth - sourceSize, tapAssist.viewX - sourceSize / 2),
      );
      const srcY = Math.max(
        0,
        Math.min(containerHeight - sourceSize, tapAssist.viewY - sourceSize / 2),
      );
      const lensCenterX = Math.max(
        lensRadius + 8,
        Math.min(containerWidth - lensRadius - 8, tapAssist.viewX),
      );
      const lensCenterY = Math.max(
        lensRadius + 8,
        Math.min(containerHeight - lensRadius - 8, tapAssist.viewY - lensRadius - 20),
      );

      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(lensCenterX, lensCenterY, lensRadius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.fill();
      ctx.clip();
      ctx.drawImage(
        canvas,
        srcX * dpr,
        srcY * dpr,
        sourceSize * dpr,
        sourceSize * dpr,
        lensCenterX - lensRadius,
        lensCenterY - lensRadius,
        lensDiameter,
        lensDiameter,
      );
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(lensCenterX - 10, lensCenterY);
      ctx.lineTo(lensCenterX + 10, lensCenterY);
      ctx.moveTo(lensCenterX, lensCenterY - 10);
      ctx.lineTo(lensCenterX, lensCenterY + 10);
      ctx.strokeStyle = 'rgba(14, 165, 233, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      const label = `(${tapAssist.row}, ${tapAssist.col})`;
      const labelPaddingX = 7;
      const labelPaddingY = 4;
      const labelY = lensCenterY + lensRadius + 12;
      ctx.save();
      ctx.font = `${Math.max(10, cellSize * 0.34)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelWidth = ctx.measureText(label).width + labelPaddingX * 2;
      const labelHeight = Math.max(18, cellSize * 0.45) + labelPaddingY;
      const labelX = Math.max(
        labelWidth / 2 + 8,
        Math.min(containerWidth - labelWidth / 2 - 8, lensCenterX),
      );
      ctx.fillStyle = isDarkMode ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.94)';
      ctx.fillRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.strokeStyle = '#0EA5E9';
      ctx.lineWidth = 1;
      ctx.strokeRect(labelX - labelWidth / 2, labelY - labelHeight / 2, labelWidth, labelHeight);
      ctx.fillStyle = isDarkMode ? '#E2E8F0' : '#0F172A';
      ctx.fillText(label, labelX, labelY);
      ctx.restore();
    }
  }, [
    mapData,
    cellSize,
    cellStates,
    mergedCellsMap,
    isRouteVisible,
    routeSegments,
    routePoints,
    dpr,
    isDetailedView,
    showNumbers,
    showBorders,
    showSelectionGrid,
    showSelectionRuler,
    vertexSelectionMode,
    cellSelectionMode,
    highlightedCell,
    hoverGuide,
    tapAssist,
    isDarkMode,
    isRotationInteracting,
    rotationRadians,
    mapCenterX,
    mapCenterY,
    toMapCoordinates,
    offset,
  ]);

  // 繧ｯ繝ｪ繝・け蜃ｦ逅・
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDragging) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      // Canvas陦ｨ遉ｺ繧ｵ繧､繧ｺ縺ｫ蟇ｾ縺吶ｋ繧ｯ繝ｪ繝・け菴咲ｽｮ繧定ｨ育ｮ・
      const scaleX = canvas.width / dpr / rect.width;
      const scaleY = canvas.height / dpr / rect.height;

      // 繝薙Η繝ｼ繝昴・繝亥ｺｧ讓・竊・繝槭ャ繝怜ｺｧ讓呻ｼ医が繝輔そ繝・ヨ繧貞ｼ輔￥・・
      const viewX = (e.clientX - rect.left) * scaleX;
      const viewY = (e.clientY - rect.top) * scaleY;
      const { x, y } = toMapCoordinates(viewX, viewY);

      // 鬆らせ驕ｸ謚槭Δ繝ｼ繝我ｸｭ縺ｯ縲√∪縺夐らせ繝槭・繧ｫ繝ｼ縺ｮ繧ｯ繝ｪ繝・け繧偵メ繧ｧ繝・け
      if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize; // 繧ｯ繝ｪ繝・け蛻､螳壹ｒ蟆代＠蠎・ａ縺ｫ

        for (const vertex of vertexSelectionMode.clickedVertices) {
          const markerX = (vertex.col - 0.5) * cellSize;
          const markerY = (vertex.row - 0.5) * cellSize;
          const distance = Math.sqrt(Math.pow(x - markerX, 2) + Math.pow(y - markerY, 2));

          if (distance <= clickRadius) {
            // 鬆らせ繝槭・繧ｫ繝ｼ縺後け繝ｪ繝・け縺輔ｌ縺・竊・縺昴・鬆らせ縺ｮ繧ｻ繝ｫ蠎ｧ讓吶〒繧､繝吶Φ繝育匱轣ｫ
            window.dispatchEvent(
              new CustomEvent('mapCellClick', {
                detail: { row: vertex.row, col: vertex.col },
              }),
            );
            return; // 鬆らせ繧ｯ繝ｪ繝・け縺ｮ蝣ｴ蜷医・騾壼ｸｸ縺ｮ繧ｻ繝ｫ繧ｯ繝ｪ繝・け蜃ｦ逅・ｒ繧ｹ繧ｭ繝・・
          }
        }
      }

      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;

      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }

      // 繧ｻ繝ｫ驕ｸ謚槭Δ繝ｼ繝我ｸｭ・夐搨繝槭・繧ｫ繝ｼ縺ｮ繧ｯ繝ｪ繝・け讀懷・
      if (cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize;

        for (const cell of cellSelectionMode.clickedCells) {
          const mi = mergedCellsMap.get(`${cell.row}-${cell.col}`);
          let mx: number, my: number;
          if (mi) {
            mx = (mi.startCol - 1 + (mi.endCol - mi.startCol + 1) / 2) * cellSize;
            my = (mi.startRow - 1 + (mi.endRow - mi.startRow + 1) / 2) * cellSize;
          } else {
            mx = (cell.col - 0.5) * cellSize;
            my = (cell.row - 0.5) * cellSize;
          }
          const distance = Math.sqrt(Math.pow(x - mx, 2) + Math.pow(y - my, 2));
          if (distance <= clickRadius) {
            // 繝槭・繧ｫ繝ｼ繧ｯ繝ｪ繝・け 竊・縺昴・繧ｻ繝ｫ蠎ｧ讓吶〒繧､繝吶Φ繝育匱轣ｫ・郁ｧ｣髯､縺輔ｌ繧具ｼ・
            window.dispatchEvent(
              new CustomEvent('mapCellClick', {
                detail: { row: cell.row, col: cell.col },
              }),
            );
            return;
          }
        }
      }

      // 繧ｻ繝ｫ驕ｸ謚槭Δ繝ｼ繝我ｸｭ・夂ｵ仙粋繧ｻ繝ｫ繧帝幕蟋九そ繝ｫ縺ｫ隗｣豎ｺ
      let resolvedRow = row;
      let resolvedCol = col;
      if (cellSelectionMode) {
        for (const merge of mapData.mergedCells) {
          if (
            row >= merge.startRow &&
            row <= merge.endRow &&
            col >= merge.startCol &&
            col <= merge.endCol
          ) {
            resolvedRow = merge.startRow;
            resolvedCol = merge.startCol;
            break;
          }
        }
      }

      // 繝悶Ο繝・け螳夂ｾｩ繝代ロ繝ｫ逕ｨ縺ｮ繧ｫ繧ｹ繧ｿ繝繧､繝吶Φ繝医ｒ逋ｺ轣ｫ
      const shouldShowTapAssist =
        (vertexSelectionMode || cellSelectionMode) &&
        (lastPointerTypeRef.current === 'touch' || lastPointerTypeRef.current === 'pen');
      if (shouldShowTapAssist) {
        showTapAssist({
          row: resolvedRow,
          col: resolvedCol,
          viewX,
          viewY,
        });
      }

      window.dispatchEvent(
        new CustomEvent('mapCellClick', {
          detail: { row: resolvedRow, col: resolvedCol },
        }),
      );

      const state = cellStates.get(`${row}-${col}`);
      const matchingItems = state?.items || [];

      onCellClick(row, col, matchingItems);
    },
    [
      cellSize,
      mapData.maxRow,
      mapData.maxCol,
      mapData.mergedCells,
      cellStates,
      onCellClick,
      isDragging,
      dpr,
      vertexSelectionMode,
      cellSelectionMode,
      showTapAssist,
      mergedCellsMap,
      offset,
      toMapCoordinates,
    ],
  );

  // 繝帙・繝ｫ縺ｮ繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ遽・峇繧定ｨ育ｮ・
  const hallScrollBounds = useMemo(() => {
    if (selectedHall && selectedHall.vertices.length >= 4) {
      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      return {
        minRow: Math.max(1, Math.min(...rows) - SCROLL_MARGIN),
        maxRow: Math.max(...rows) + SCROLL_MARGIN,
        minCol: Math.max(1, Math.min(...cols) - SCROLL_MARGIN),
        maxCol: Math.max(...cols) + SCROLL_MARGIN,
      };
    }
    return null;
  }, [selectedHall]);

  const filledCellScrollBounds = useMemo(() => {
    let minRow = Number.POSITIVE_INFINITY;
    let maxRow = Number.NEGATIVE_INFINITY;
    let minCol = Number.POSITIVE_INFINITY;
    let maxCol = Number.NEGATIVE_INFINITY;
    let hasBounds = false;

    mapData.cells.forEach((cell) => {
      if (!hasCellInputValue(cell.value)) return;
      hasBounds = true;
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minCol = Math.min(minCol, cell.col);
      maxCol = Math.max(maxCol, cell.col);
    });

    mapData.mergedCells.forEach((merge) => {
      if (!hasCellInputValue(merge.value)) return;
      hasBounds = true;
      minRow = Math.min(minRow, merge.startRow);
      maxRow = Math.max(maxRow, merge.endRow);
      minCol = Math.min(minCol, merge.startCol);
      maxCol = Math.max(maxCol, merge.endCol);
    });

    if (!hasBounds) return null;
    return {
      minRow: minRow - FILLED_SCROLL_MARGIN,
      maxRow: maxRow + FILLED_SCROLL_MARGIN,
      minCol: minCol - FILLED_SCROLL_MARGIN,
      maxCol: maxCol + FILLED_SCROLL_MARGIN,
    };
  }, [mapData.cells, mapData.mergedCells]);

  const activeScrollBounds = useMemo(
    () => filledCellScrollBounds || hallScrollBounds,
    [filledCellScrollBounds, hallScrollBounds],
  );

  // 繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ蛻ｶ髯舌ｒ險育ｮ励☆繧矩未謨ｰ
  const calculateScrollLimits = useCallback(() => {
    if (!activeScrollBounds) return null;
    const container = containerRef.current;
    if (!container) return null;

    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    const boundsLeft = (activeScrollBounds.minCol - 1) * cellSize;
    const boundsRight = activeScrollBounds.maxCol * cellSize;
    const boundsTop = (activeScrollBounds.minRow - 1) * cellSize;
    const boundsBottom = activeScrollBounds.maxRow * cellSize;

    const rotatedCorners = [
      rotateAroundMapCenter(boundsLeft, boundsTop),
      rotateAroundMapCenter(boundsRight, boundsTop),
      rotateAroundMapCenter(boundsLeft, boundsBottom),
      rotateAroundMapCenter(boundsRight, boundsBottom),
    ];

    const rotatedMinX = Math.min(...rotatedCorners.map((point) => point.x));
    const rotatedMaxX = Math.max(...rotatedCorners.map((point) => point.x));
    const rotatedMinY = Math.min(...rotatedCorners.map((point) => point.y));
    const rotatedMaxY = Math.max(...rotatedCorners.map((point) => point.y));

    return {
      minX: containerWidth - rotatedMaxX,
      maxX: -rotatedMinX,
      minY: containerHeight - rotatedMaxY,
      maxY: -rotatedMinY,
    };
  }, [activeScrollBounds, cellSize, rotateAroundMapCenter]);

  useEffect(() => {
    if (!vertexSelectionMode) {
      setHoverGuide(null);
    }
  }, [vertexSelectionMode]);

  const updateHoverGuideFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const metrics = getPointerViewMetrics(clientX, clientY);
      if (!metrics) {
        setHoverGuide(null);
        return;
      }

      const { viewX, viewY } = metrics;
      const { x, y } = toMapCoordinates(viewX, viewY);
      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;

      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        setHoverGuide(null);
        return;
      }

      setHoverGuide((prev) => {
        if (prev && prev.row === row && prev.col === col) {
          return prev;
        }
        return { row, col, viewX, viewY };
      });
    },
    [cellSize, getPointerViewMetrics, mapData.maxRow, mapData.maxCol, toMapCoordinates],
  );

  // 繝峨Λ繝・げ蜃ｦ逅・
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      // 繝斐Φ繝√ぜ繝ｼ繝荳ｭ縺ｯ繝峨Λ繝・げ繧堤┌隕・
      if (activeTouchesRef.current.size >= 2) return;
      setIsDragging(false);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragStartOffset({ ...offset });
    },
    [offset],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      if (e.pointerType === 'mouse' && vertexSelectionMode) {
        updateHoverGuideFromPointer(e.clientX, e.clientY);
      } else if (e.pointerType !== 'mouse' && hoverGuide) {
        setHoverGuide(null);
      }

      if (e.buttons !== 1) return;
      // 繝斐Φ繝√ぜ繝ｼ繝荳ｭ縺ｯ繝峨Λ繝・げ繧堤┌隕・
      if (activeTouchesRef.current.size >= 2) return;

      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        setIsDragging(true);
      }

      // 譁ｰ縺励＞繧ｪ繝輔そ繝・ヨ繧定ｨ育ｮ・
      let newX = dragStartOffset.x + dx;
      let newY = dragStartOffset.y + dy;

      // 繝帙・繝ｫ驕ｸ謚樊凾縺ｯ繧ｹ繧ｯ繝ｭ繝ｼ繝ｫ遽・峇繧貞宛髯・
      const limits = calculateScrollLimits();
      if (limits) {
        newX = Math.max(limits.minX, Math.min(limits.maxX, newX));
        newY = Math.max(limits.minY, Math.min(limits.maxY, newY));
      }

      setOffset({
        x: newX,
        y: newY,
      });
    },
    [
      dragStart,
      dragStartOffset,
      calculateScrollLimits,
      hoverGuide,
      updateHoverGuideFromPointer,
      vertexSelectionMode,
    ],
  );

  const handlePointerUp = useCallback(() => {
    setTimeout(() => {
      setIsDragging(false);
    }, 100);
  }, []);

  const handlePointerLeave = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      setHoverGuide(null);
      handlePointerUp();
    },
    [handlePointerUp],
  );

  return (
    <MapCanvasPresentation
      containerRef={containerRef}
      canvasRef={canvasRef}
      isDragging={isDragging}
      onCanvasClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
    />
  );
};

export default MapCanvas;


