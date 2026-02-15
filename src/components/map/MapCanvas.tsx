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
  executeModeItemIds: string[]; // 螳溯｡後Δ繝ｼ繝我ｸｭ縺ｮ險ｪ蝠乗ｸ医∩ID
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
const FILLED_SCROLL_MARGIN = 25; // 入力済みセル境界からの追加余白（行/列数）
const getDragPanMultiplier = (zoom: number): number => {
  if (zoom < 70) return 2.0;
  if (zoom < 120) return 1.6;
  return 1.3;
};
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
  const offsetRef = useRef(offset);
  const zoomLevelRef = useRef(zoomLevel);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragStartOffset, setDragStartOffset] = useState({ x: 0, y: 0 });
  const [hoverGuide, setHoverGuide] = useState<HoverGuideState | null>(null);
  const [tapAssist, setTapAssist] = useState<TapAssistState | null>(null);
  const lastPointerTypeRef = useRef<string>('mouse');
  const tapAssistTimerRef = useRef<number | null>(null);

  // 郢昴・繝ｰ郢ｧ・､郢ｧ・ｹ郢晄鱒縺醍ｹｧ・ｻ郢晢ｽｫ雎医・
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // 郢ｧ・ｹ郢ｧ・ｱ郢晢ｽｼ郢晢ｽｫ髫ｪ閧ｲ・ｮ繝ｻ
  const scale = zoomLevel / 100;
  const cellSize = BASE_CELL_SIZE * scale;
  const isDarkMode =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

  // 陝ｶ・ｸ邵ｺ・ｫ100%隴弱ｅ竊定惺讙趣ｽｭ蟲ｨ繝ｻ隲繝ｻ・ｰ・ｱ鬩･荳奇ｽ帝勗・ｨ驕会ｽｺ繝ｻ蛹ｻ縺懃ｹ晢ｽｼ郢晢｣ｰ郢晢ｽｬ郢晏生ﾎ晉ｸｺ・ｫ鬮｢・｢闖ｫ繧・・邵ｺ荳槭・隲繝ｻ・ｰ・ｱ郢ｧ蜻育ｷ帝包ｽｻ繝ｻ繝ｻ
  const isDetailedView = true;
  const showNumbers = true;
  const showBorders = true;

  // 陷第ｦ雁ｱ鍋ｸｺ・ｮ郢ｧ・ｻ郢晢ｽｫ郢ｧ・ｵ郢ｧ・､郢ｧ・ｺ郢ｧ螳夲ｽｨ菫ｶ繝ｻ
  const prevCellSizeRef = useRef<number>(cellSize);
  const initializedRef = useRef<boolean>(false);

  // 郢晄鱒ﾎｦ郢昶・縺懃ｹ晢ｽｼ郢晢｣ｰ騾包ｽｨ邵ｺ・ｮ霑･・ｶ隲ｷ繝ｻ
  const pinchStartDistRef = useRef<number>(0);
  const pinchStartZoomRef = useRef<number>(zoomLevel);
  const pinchStartOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
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
    (
      viewX: number,
      viewY: number,
      newZoom: number,
      options?: {
        baseZoom?: number;
        baseOffset?: { x: number; y: number };
      },
    ) => {
      const baseZoom = options?.baseZoom ?? zoomLevel;
      const baseOffset = options?.baseOffset ?? offset;
      const currentCellSize = BASE_CELL_SIZE * (baseZoom / 100);
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
      const translatedX = viewX - baseOffset.x;
      const translatedY = viewY - baseOffset.y;
      let mapPointX = translatedX;
      let mapPointY = translatedY;

      if (rotationRadians !== 0) {
        const currentMapCenterX = (mapData.maxCol * currentCellSize) / 2;
        const currentMapCenterY = (mapData.maxRow * currentCellSize) / 2;
        const dx = translatedX - currentMapCenterX;
        const dy = translatedY - currentMapCenterY;
        const cos = Math.cos(rotationRadians);
        const sin = Math.sin(rotationRadians);
        mapPointX = dx * cos + dy * sin + currentMapCenterX;
        mapPointY = -dx * sin + dy * cos + currentMapCenterY;
      }

      const normalizedMapX = mapPointX / currentCellSize;
      const normalizedMapY = mapPointY / currentCellSize;
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
    [offset, zoomLevel, mapData.maxCol, mapData.maxRow, rotationRadians],
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
    offsetRef.current = offset;
  }, [offset]);

  useEffect(() => {
    zoomLevelRef.current = zoomLevel;
  }, [zoomLevel]);

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

  // 郢ｧ・ｺ郢晢ｽｼ郢晢｣ｰ郢晢ｽｬ郢晏生ﾎ晁棔逕ｻ蟲ｩ隴弱ｅ竊馴囎荵溘○郢ｧ蝣､・ｶ・ｭ隰問・笘・ｹｧ荵昴′郢晁ｼ斐◎郢昴・繝ｨ髫ｱ・ｿ隰ｨ・ｴ繝ｻ莠･・､螟慚夂ｸｺ荵晢ｽ臥ｸｺ・ｮ郢ｧ・ｺ郢晢ｽｼ郢晢｣ｰ陞溽判蟲ｩ邵ｺ・ｫ陝・ｽｾ陟｢諛ｶ・ｼ繝ｻ
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const prevCellSize = prevCellSizeRef.current;

    // 陋ｻ譎丞ｱ鍋ｸｺ・ｾ邵ｺ貅倥・郢ｧ・ｻ郢晢ｽｫ郢ｧ・ｵ郢ｧ・､郢ｧ・ｺ邵ｺ謔滂ｽ､蟲ｨ・冗ｸｺ・｣邵ｺ・ｦ邵ｺ繝ｻ竊醍ｸｺ繝ｻ・ｰ・ｴ陷ｷ蛹ｻ繝ｻ郢ｧ・ｹ郢ｧ・ｭ郢昴・繝ｻ
    if (!initializedRef.current || prevCellSize === cellSize) {
      prevCellSizeRef.current = cellSize;
      initializedRef.current = true;
      return;
    }

    // 郢ｧ・ｳ郢晢ｽｳ郢昴・繝ｪ邵ｺ・ｮ闕ｳ・ｭ陞滂ｽｮ陟趣ｽｧ隶灘生・定搏・ｺ雋・じ竊鍋ｹｧ・ｺ郢晢ｽｼ郢晢｣ｰ繝ｻ莠･・､螟慚夊棔逕ｻ蟲ｩ邵ｺ・ｮ陜｣・ｴ陷ｷ蛹ｻ繝ｻ郢晁ｼ斐°郢晢ｽｼ郢晢ｽｫ郢晁・繝｣郢ｧ・ｯ繝ｻ繝ｻ
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

  // 郢晏ｸ吶≧郢晢ｽｼ郢晢ｽｫ郢ｧ・ｺ郢晢ｽｼ郢晢｣ｰ陷・ｽｦ騾・・・ｼ繝ｻC郢晄じﾎ帷ｹｧ・ｦ郢ｧ・ｶ: 郢晄ｧｭ縺育ｹｧ・ｹ郢ｧ・ｫ郢晢ｽｼ郢ｧ・ｽ郢晢ｽｫ闖ｴ蜥ｲ・ｽ・ｮ郢ｧ蜑・ｽｸ・ｭ陟｢繝ｻ竊鍋ｹｧ・ｺ郢晢ｽｼ郢晢｣ｰ繝ｻ繝ｻ
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
      // 郢晄ｧｭ縺育ｹｧ・ｹ闖ｴ蜥ｲ・ｽ・ｮ繝ｻ蛹ｻ縺慕ｹ晢ｽｳ郢昴・繝ｪ陷繝ｻ・ｺ・ｧ隶灘遜・ｼ繝ｻ
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // 霑ｴ・ｾ陜ｨ・ｨ邵ｺ・ｮ郢ｧ・ｺ郢晢ｽｼ郢晢｣ｰ郢晢ｽｬ郢晏生ﾎ・
      const currentZoom = zoomLevelRef.current;
      // 郢ｧ・ｺ郢晢ｽｼ郢晢｣ｰ鬩･謫ｾ・ｼ蛹ｻ縺帷ｹｧ・ｯ郢晢ｽｭ郢晢ｽｼ郢晢ｽｫ鬩･荳岩・陟｢諛環ｧ邵ｺ・ｦ繝ｻ繝ｻ
      const zoomDelta = -e.deltaY * 0.1;
      const newZoom = Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, currentZoom + zoomDelta)));

      if (newZoom === currentZoom) return;

      const newOffset = calculateOffsetForZoomPoint(mouseX, mouseY, newZoom, {
        baseZoom: currentZoom,
        baseOffset: offsetRef.current,
      });
      const newCellSize = BASE_CELL_SIZE * (newZoom / 100);

      setOffset(newOffset);
      offsetRef.current = newOffset;
      prevCellSizeRef.current = newCellSize;
      zoomLevelRef.current = newZoom;
      onZoomChange(newZoom);
    },
    [
      onZoomChange,
      onRotationAngleChange,
      rotationAngle,
      calculateOffsetForZoomPoint,
    ],
  );

  // 郢晄鱒ﾎｦ郢昶・縺懃ｹ晢ｽｼ郢晢｣ｰ陷・ｽｦ騾・・・ｼ蛹ｻ縺帷ｹ晄ｧｭ繝ｻ郢晏現繝ｵ郢ｧ・ｩ郢晢ｽｳ/郢ｧ・ｿ郢晄じﾎ樒ｹ昴・繝ｨ: 郢晄鱒ﾎｦ郢昶或・ｸ・ｭ陟｢繝ｻ・定搏・ｺ雋・じ竊鍋ｹｧ・ｺ郢晢ｽｼ郢晢｣ｰ繝ｻ繝ｻ
  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      // 郢ｧ・ｿ郢昴・繝｡郢晄亢縺・ｹ晢ｽｳ郢晏現・帝坎蛟ｬ鮖ｸ
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
        pinchStartZoomRef.current = zoomLevelRef.current;
        pinchStartOffsetRef.current = { ...offsetRef.current };
      }
    },
    [],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      // 郢ｧ・ｿ郢昴・繝｡郢晄亢縺・ｹ晢ｽｳ郢晏現・定ｭ厄ｽｴ隴・ｽｰ
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

        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const midX = (touches[0].x + touches[1].x) / 2 - rect.left;
        const midY = (touches[0].y + touches[1].y) / 2 - rect.top;

        if (newZoom === zoomLevelRef.current) return;

        const newOffset = calculateOffsetForZoomPoint(midX, midY, newZoom, {
          baseZoom: pinchStartZoomRef.current,
          baseOffset: pinchStartOffsetRef.current,
        });
        const newCellSize = BASE_CELL_SIZE * (newZoom / 100);
        setOffset(newOffset);
        offsetRef.current = newOffset;
        prevCellSizeRef.current = newCellSize;
        zoomLevelRef.current = newZoom;
        onZoomChange(newZoom);
      }
    },
    [onZoomChange, calculateOffsetForZoomPoint],
  );

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      activeTouchesRef.current.delete(e.changedTouches[i].identifier);
    }
    if (activeTouchesRef.current.size < 2) {
      pinchStartDistRef.current = 0;
    }
  }, []);

  // 郢晏ｸ吶≧郢晢ｽｼ郢晢ｽｫ郢晢ｽｻ郢ｧ・ｿ郢昴・繝｡郢ｧ・､郢晏生ﾎｦ郢晏現繝ｻ騾具ｽｻ鬪ｭ・ｲ
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

  // 郢晏ｸ吶・郢晢ｽｫ鬩包ｽｸ隰壽ｨ雁・邵ｺ・ｫ郢ｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ郢ｧ螳壹・陷肴・・ｪ・ｿ隰ｨ・ｴ邵ｺ蜉ｱ窶ｻ郢晏ｸ吶・郢晢ｽｫ郢ｧ蝣､蛻､鬮ｱ・｢陷繝ｻ竊馴ｩ溷調・ｽ・ｮ
  // selectedHall邵ｺ謔滂ｽ､逕ｻ蟲ｩ邵ｺ霈費ｽ檎ｸｺ貊灘・邵ｺ・ｮ邵ｺ・ｿ陞ｳ貅ｯ・｡魃会ｽｼ蛹ｻ縺懃ｹ晢ｽｼ郢晢｣ｰ陞溽判蟲ｩ隴弱ｅ繝ｻ陞ｳ貅ｯ・｡蠕鯉ｼ邵ｺ・ｪ邵ｺ繝ｻ・ｼ繝ｻ
  const prevSelectedHallRef = useRef<HallDefinition | undefined>(undefined);

  useEffect(() => {
    // selectedHall邵ｺ謔滂ｽ､蟲ｨ・冗ｸｺ・｣邵ｺ・ｦ邵ｺ繝ｻ竊醍ｸｺ繝ｻ・ｰ・ｴ陷ｷ蛹ｻ繝ｻ郢ｧ・ｹ郢ｧ・ｭ郢昴・繝ｻ
    if (prevSelectedHallRef.current?.id === selectedHall?.id) {
      return;
    }
    prevSelectedHallRef.current = selectedHall;

    if (selectedHall && selectedHall.vertices.length >= 4) {
      const container = containerRef.current;
      if (!container) return;

      const containerWidth = container.clientWidth;
      const containerHeight = container.clientHeight;

      // 郢晏ｸ吶・郢晢ｽｫ邵ｺ・ｮ驕ｽ繝ｻ蟲・ｹｧ螳夲ｽｨ閧ｲ・ｮ證ｦ・ｼ蛹ｻ繝ｻ郢晢ｽｼ郢ｧ・ｸ郢晢ｽｳ髴趣ｽｼ邵ｺ・ｿ繝ｻ繝ｻ
      const rows = selectedHall.vertices.map((v) => v.row);
      const cols = selectedHall.vertices.map((v) => v.col);
      const minRow = Math.max(1, Math.min(...rows) - SCROLL_MARGIN);
      const maxRow = Math.max(...rows) + SCROLL_MARGIN;
      const minCol = Math.max(1, Math.min(...cols) - SCROLL_MARGIN);
      const maxCol = Math.max(...cols) + SCROLL_MARGIN;

      // 郢晏ｸ吶・郢晢ｽｫ驕ｽ繝ｻ蟲・ｸｺ・ｮ郢晄鱒縺醍ｹｧ・ｻ郢晢ｽｫ陟趣ｽｧ隶薙・
      const hallLeft = (minCol - 1) * cellSize;
      const hallRight = maxCol * cellSize;
      const hallTop = (minRow - 1) * cellSize;
      const hallBottom = maxRow * cellSize;
      const hallWidth = hallRight - hallLeft;
      const hallHeight = hallBottom - hallTop;

      let newOffsetX: number;
      let newOffsetY: number;

      // 郢晏ｸ吶・郢晢ｽｫ邵ｺ讙主愛鬮ｱ・｢邵ｺ・ｫ陷ｿ蠑ｱ竏ｪ郢ｧ蜿･・ｰ・ｴ陷ｷ蛹ｻ繝ｻ闕ｳ・ｭ陞滂ｽｮ邵ｺ・ｫ鬩溷調・ｽ・ｮ邵ｲ竏晏ｺｶ邵ｺ・ｾ郢ｧ蟲ｨ竊醍ｸｺ繝ｻ・ｰ・ｴ陷ｷ蛹ｻ繝ｻ陝ｾ・ｦ闕ｳ鄙ｫ・定搏・ｺ雋・じ竊・
      if (hallWidth <= containerWidth) {
        // 郢晏ｸ吶・郢晢ｽｫ郢ｧ蜻茨ｽｰ・ｴ陝ｷ・ｳ隴・ｽｹ陷ｷ蜿ｰ・ｸ・ｭ陞滂ｽｮ邵ｺ・ｫ
        newOffsetX = (containerWidth - hallWidth) / 2 - hallLeft;
      } else {
        // 郢晏ｸ吶・郢晢ｽｫ陝ｾ・ｦ驕ｶ・ｯ郢ｧ蝣､蛻､鬮ｱ・｢陝ｾ・ｦ驕ｶ・ｯ邵ｺ・ｫ陷ｷ蛹ｻ・冗ｸｺ蟶呻ｽ・
        newOffsetX = -hallLeft;
      }

      if (hallHeight <= containerHeight) {
        // 郢晏ｸ吶・郢晢ｽｫ郢ｧ雋樊｡咎ｶ・ｴ隴・ｽｹ陷ｷ蜿ｰ・ｸ・ｭ陞滂ｽｮ邵ｺ・ｫ
        newOffsetY = (containerHeight - hallHeight) / 2 - hallTop;
      } else {
        // 郢晏ｸ吶・郢晢ｽｫ闕ｳ鬘費ｽｫ・ｯ郢ｧ蝣､蛻､鬮ｱ・｢闕ｳ鬘費ｽｫ・ｯ邵ｺ・ｫ陷ｷ蛹ｻ・冗ｸｺ蟶呻ｽ・
        newOffsetY = -hallTop;
      }

      setOffset({ x: newOffsetX, y: newOffsetY });
    } else if (!selectedHall) {
      // 郢晏ｸ吶・郢晢ｽｫ隴幢ｽｪ鬩包ｽｸ隰壽ｧｭ竊楢ｬ鯉ｽｻ邵ｺ・｣邵ｺ貊灘・邵ｺ・ｯ郢ｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ郢ｧ蛛ｵﾎ懃ｹｧ・ｻ郢昴・繝ｨ
      setOffset({ x: 0, y: 0 });
    }
  }, [selectedHall, cellSize]);

  // 郢ｧ・ｻ郢晢ｽｫ郢晄ｧｭ繝｣郢晏干・定抄諛医・
  const cellsMap = useMemo(() => {
    const map = new Map<string, CellData>();
    mapData.cells.forEach((cell) => {
      map.set(`${cell.row}-${cell.col}`, cell);
    });
    return map;
  }, [mapData.cells]);

  // 驍ｨ莉咏ｲ狗ｹｧ・ｻ郢晢ｽｫ邵ｺ・ｮ郢晄ｧｭ繝｣郢晏干・定抄諛医・
  const mergedCellsMap = useMemo(() => {
    const map = new Map<string, MergedCellInfo>();
    mapData.mergedCells.forEach((merge) => {
      map.set(`${merge.startRow}-${merge.startCol}`, merge);
    });
    return map;
  }, [mapData.mergedCells]);

  // executeModeItemIds郢ｧ諡・t邵ｺ・ｫ陞溽判驪､繝ｻ閧ｲ諞ｾ隲ｷ邇厄ｽｨ閧ｲ・ｮ遉ｼ逡代・繝ｻ
  const executeModeItemIdsSet = useMemo(() => {
    return new Set(executeModeItemIds);
  }, [executeModeItemIds]);

  // 郢ｧ・ｻ郢晢ｽｫ邵ｺ蠕後＞郢ｧ・､郢昴・ﾎ堤ｹｧ蜻域亜邵ｺ・､邵ｺ荵昶・邵ｺ繝ｻﾂｰ邵ｺ・ｮ霑･・ｶ隲ｷ荵晢ｽ帝坎閧ｲ・ｮ繝ｻ
  const cellStates = useMemo(() => {
    const states = new Map<string, MapCellStateDetail>();

    const dayMatch = mapName.match(/^(.+)郢晄ｧｭ繝｣郢昴・/);
    if (!dayMatch) return states;
    const dayName = dayMatch[1].trim();

    // 陷・ｽｪ陷亥現縺・ｹｧ・､郢昴・ﾎ堤ｸｺ荵昶・邵ｺ繝ｻﾂｰ郢ｧ雋樊・陞ｳ螢ｹ笘・ｹｧ遏ｩ譛ｪ隰ｨ・ｰ
    const isPriorityItem = (item: (typeof items)[number]) => {
      const remarks = item.remarks?.toLowerCase() || '';
      return remarks.includes('優先') || remarks.includes('最優先');
    };

    items.forEach((item) => {
      // 隴鯉ｽ･闔牙･繝ｻ雎育｢托ｽｼ繝ｻ・ｼ蛹ｻ繝ｨ郢晢ｽｪ郢晢｣ｰ雋ょ現竏ｩ繝ｻ繝ｻ
      const itemEventDate = item.eventDate?.trim() || '';
      if (itemEventDate !== dayName) return;

      // 郢晄じﾎ溽ｹ昴・縺題惺髦ｪ繝ｻ雎育｢托ｽｼ繝ｻ      // 邵ｺ・ｾ邵ｺ螢ｼ・ｮ謔溘・闕ｳﾂ髢ｾ・ｴ郢ｧ螳夲ｽｩ・ｦ邵ｺ・ｿ邵ｲ竏ｬ・ｦ荵昶命邵ｺ荵晢ｽ臥ｸｺ・ｪ邵ｺ繝ｻ・ｰ・ｴ陷ｷ蛹ｻ繝ｻ邵ｺ・ｿ陞滂ｽｧ隴√・・ｭ繝ｻ陝・ｹ玲椢陝・､ｼ笏碁囎繝ｻ
      const itemBlockName = item.block?.trim() || '';
      let block = mapData.blocks.find((b) => b.name === itemBlockName);

      // 陞ｳ謔溘・闕ｳﾂ髢ｾ・ｴ邵ｺ蠕娯・邵ｺ繝ｻ・ｰ・ｴ陷ｷ蛹ｻﾂ竏晢ｽ､・ｧ隴√・・ｭ繝ｻ陝・ｹ玲椢陝・干・定ｾ滂ｽ｡髫墓じ・邵ｺ・ｦ隶諛・ｽｴ・｢繝ｻ蛹ｻ笳・ｸｺ・ｰ邵ｺ諤憺・陷ｷ髦ｪ繝ｶ郢晢ｽｭ郢昴・縺醍ｸｺ迹夲ｽ､繝ｻ辟夂ｸｺ繧・ｽ玖撻・ｴ陷ｷ蛹ｻ繝ｻ鬮ｯ・､邵ｺ謫ｾ・ｼ繝ｻ
      if (!block) {
        const candidates = mapData.blocks.filter(
          (b) => b.name.toLowerCase() === itemBlockName.toLowerCase(),
        );
        // 陋溷揃・｣諛岩ｲ1邵ｺ・､邵ｺ・ｰ邵ｺ莉｣竊醍ｹｧ逕ｻ豐ｻ騾包ｽｨ繝ｻ驛・ｽ､繝ｻ辟夂ｸｺ繧・ｽ玖撻・ｴ陷ｷ蛹ｻ繝ｻ隴門戟荵らｸｺ・ｪ邵ｺ・ｮ邵ｺ・ｧ隰暦ｽ｡騾包ｽｨ邵ｺ蜉ｱ竊醍ｸｺ繝ｻ・ｼ繝ｻ
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

      // 陷・ｽｪ陷亥現縺・ｹｧ・､郢昴・ﾎ堤ｸｺ荵昶・邵ｺ繝ｻﾂｰ郢ｧ蛛ｵ繝｡郢ｧ・ｧ郢昴・縺・
      if (isPriorityItem(item)) {
        existing.hasPriorityItem = true;
        // 髫ｪ・ｪ陜荳槭・邵ｺ・ｫ隴幢ｽｪ隰悶・・ｮ螢ｹ繝ｻ陷・ｽｪ陷亥現縺・ｹｧ・､郢昴・ﾎ堤ｸｺ蠕娯旺郢ｧ荵敖ｰ郢昶・縺臥ｹ昴・縺・
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

  // 郢晢ｽｫ郢晢ｽｼ郢晁ご蜃ｽ隰梧腸・ｼ莠･笏∬怦莠･・ｺ・ｦ隲繝ｻ・ｰ・ｱ闔牙･窶ｳ繝ｻ繝ｻ
  const routePoints = useMemo(() => {
    if (!isRouteVisible) return [];

    const dayMatch = mapName.match(/^(.+)郢晄ｧｭ繝｣郢昴・/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    // executeModeItemIds邵ｺ・ｮ鬯・・・ｺ荳奇ｽ帝け・ｭ隰問・笘・ｹｧ荵昶螺郢ｧ竏壺・邵ｲ・．邵ｺ・ｮ鬩滓ｦ翫・鬯・・竊鍋ｹｧ・｢郢ｧ・､郢昴・ﾎ堤ｹｧ雋槫徐陟輔・
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

      // 陞ｳ謔溘・闕ｳﾂ髢ｾ・ｴ陷・ｽｪ陷亥現縲堤ｹ晄じﾎ溽ｹ昴・縺醍ｹｧ蜻茨ｽ､諛・ｽｴ・｢
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

  // 郢晢ｽｫ郢晢ｽｼ郢晏現縺晉ｹｧ・ｰ郢晢ｽ｡郢晢ｽｳ郢昴・
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

  // 隰蜀怜愛
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 郢ｧ・ｭ郢晢ｽ｣郢晢ｽｳ郢晁・縺帷ｹｧ・ｵ郢ｧ・､郢ｧ・ｺ郢ｧ蛛ｵ縺慕ｹ晢ｽｳ郢昴・繝ｪ繝ｻ蛹ｻ繝ｳ郢晢ｽ･郢晢ｽｼ郢晄亢繝ｻ郢晁肩・ｼ蟲ｨ縺礼ｹｧ・､郢ｧ・ｺ邵ｺ・ｫ髫ｪ・ｭ陞ｳ螟ｲ・ｼ逎ｯ・ｫ蛟ｩ・ｧ・｣陷剃ｸ橸ｽｺ・ｦ陝・ｽｾ陟｢諛ｶ・ｼ繝ｻ
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;

    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;
    canvas.width = containerWidth * dpr;
    canvas.height = containerHeight * dpr;

    // 郢ｧ・ｹ郢ｧ・ｱ郢晢ｽｼ郢晢ｽｫ髫ｱ・ｿ隰ｨ・ｴ
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 郢ｧ・ｯ郢晢ｽｪ郢ｧ・｢
    ctx.clearRect(0, 0, containerWidth, containerHeight);

    // 郢ｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ邵ｺ・ｨ陜玲ｫ・ｽｻ・｢郢ｧ蟶昶・騾包ｽｨ繝ｻ莠包ｽｻ・･鬮ｯ髦ｪ繝ｻ隰蜀怜愛邵ｺ・ｯ郢晄ｧｭ繝｣郢晄懶ｽｺ・ｧ隶灘衷・ｳ・ｻ邵ｺ・ｧ髯ｦ蠕娯鴬繝ｻ繝ｻ
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

    // 陷ｿ・ｯ髫墓じ縺晉ｹ晢ｽｫ驕ｽ繝ｻ蟲・ｹｧ螳夲ｽｨ閧ｲ・ｮ證ｦ・ｼ蝓溽ｷ帝包ｽｻ隴崢鬩包ｽｩ陋ｹ蜴・ｽｼ繝ｻ
    const visMinCol = Math.max(1, Math.floor(visibleMinX / cellSize) + 1);
    const visMaxCol = Math.min(mapData.maxCol, Math.ceil(visibleMaxX / cellSize) + 1);
    const visMinRow = Math.max(1, Math.floor(visibleMinY / cellSize) + 1);
    const visMaxRow = Math.min(mapData.maxRow, Math.ceil(visibleMaxY / cellSize) + 1);

    // 郢ｧ・ｻ郢晢ｽｫ邵ｺ謔溷ｺ・囎荵滂ｽｯ繝ｻ蟲・怙繝ｻﾂｰ郢昶・縺臥ｹ昴・縺醍ｸｺ蜷ｶ・狗ｹ晏･ﾎ晉ｹ昜ｻ｣繝ｻ
    const isCellVisible = (row: number, col: number, spanRows = 1, spanCols = 1): boolean => {
      return (
        col + spanCols - 1 >= visMinCol &&
        col <= visMaxCol &&
        row + spanRows - 1 >= visMinRow &&
        row <= visMaxRow
      );
    };

    // 郢ｧ・｢郢晢ｽｳ郢昶・縺顔ｹｧ・､郢晢ｽｪ郢ｧ・｢郢ｧ・ｹ髫ｪ・ｭ陞ｳ繝ｻ
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
        if (/[0-9A-Za-z._-]/.test(char)) {
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
      while (next.length > 0 && ctx.measureText(`${next}遯ｶ・ｦ`).width > maxLineWidth) {
        next = next.slice(0, -1);
      }
      return next.length > 0 ? `${next}遯ｶ・ｦ` : '遯ｶ・ｦ';
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
        trimmed[maxRows - 1] = '遯ｶ・ｦ';
        return trimmed;
      });

      if (hadHiddenColumns) {
        const lastColumnIndex = drawableColumns.length - 1;
        const lastColumn = drawableColumns[lastColumnIndex];
        if (lastColumn.length < maxRows) {
          lastColumn.push('遯ｶ・ｦ');
        } else {
          lastColumn[lastColumn.length - 1] = '遯ｶ・ｦ';
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

    // 魄溘・迚｡邵ｺ・ｨ魄溷・繝ｻ隴∵㈱・∫ｹｧ・ｹ郢晏現ﾎ帷ｹｧ・､郢晏干繝ｱ郢ｧ・ｿ郢晢ｽｼ郢晢ｽｳ郢ｧ蜑・ｽｽ諛医・
    const createWarningStripePattern = () => {
      if (isRotationInteracting) return null;
      const patternCanvas = document.createElement('canvas');
      const stripeSize = Math.max(8, cellSize * 0.4); // 郢ｧ・ｹ郢晏現ﾎ帷ｹｧ・､郢晏干繝ｻ陞滂ｽｪ邵ｺ繝ｻ
      patternCanvas.width = stripeSize * 2;
      patternCanvas.height = stripeSize * 2;
      const patternCtx = patternCanvas.getContext('2d');
      if (!patternCtx) return null;

      // 髢ｭ譴ｧ蜍ｹ郢ｧ蟶晢ｽｻ繝ｻ迚｡邵ｺ・ｧ陜ｪ蜉ｱ・顔ｸｺ・､邵ｺ・ｶ邵ｺ繝ｻ
      patternCtx.fillStyle = '#FFD600';
      patternCtx.fillRect(0, 0, stripeSize * 2, stripeSize * 2);

      // 魄溷・繝ｻ隴∵㈱・∫ｹｧ・ｹ郢晏現ﾎ帷ｹｧ・､郢晏干・定ｬ蜀怜愛
      patternCtx.fillStyle = '#212121';
      patternCtx.beginPath();
      // 陝ｾ・ｦ闕ｳ荵敖ｰ郢ｧ迚呎価闕ｳ鄙ｫ竏育ｸｺ・ｮ隴∵㈱・・こ螟ｲ・ｼ蛹ｻ繝ｱ郢ｧ・ｿ郢晢ｽｼ郢晢ｽｳ邵ｺ・ｨ邵ｺ蜉ｱ窶ｻ驛｢・ｰ郢ｧ鬘假ｽｿ譁撰ｼ・ｹｧ蠕鯉ｽ九・繝ｻ
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

    // 1. 髢ｭ譴ｧ蜍ｹ郢ｧ蜻育ｷ帝包ｽｻ
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

      // 髢ｭ譴ｧ蜍ｹ豼ｶ・ｲ
      if (cell.backgroundColor) {
        ctx.fillStyle = cell.backgroundColor;
        ctx.fillRect(x, y, width, height);
      }

      // 郢ｧ・ｻ郢晢ｽｫ霑･・ｶ隲ｷ荵昶・陟｢諛環ｧ邵ｺ貅ｯ繝ｬ隴趣ｽｯ
      const state = cellStates.get(`${cell.row}-${cell.col}`);
      if (state) {
        if (state.isFullyVisited) {
          ctx.fillStyle = 'rgba(239, 83, 80, 0.5)'; // 隘搾ｽ､繝ｻ螢ｼ繝ｻ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPriorityUnvisited && warningPattern) {
          // 魄溘・迚｡邵ｺ・ｨ魄溷・繝ｻ隴∵㈱・∫ｹｧ・ｹ郢晏現ﾎ帷ｹｧ・､郢晄圜・ｼ螢ｼ笏∬怦繝ｻ陝狗｢托ｽｨ遉ｼ笏檎ｸｺ・ｮ隴幢ｽｪ髫ｪ・ｪ陜荳翫＞郢ｧ・､郢昴・ﾎ堤ｸｺ繧・ｽ翫・莠包ｽｸﾂ鬩幢ｽｨ髫ｪ・ｪ陜荳奇ｽ育ｹｧ髮≫煤陷郁肩・ｼ繝ｻ
          ctx.fillStyle = warningPattern;
          ctx.fillRect(x, y, width, height);
        } else if (state.hasPriorityUnvisited) {
          // 陜玲ｫ・ｽｻ・｢隰ｫ蝣ｺ・ｽ諛会ｽｸ・ｭ邵ｺ・ｯ陷雁ｩ迚｡邵ｺ・ｧ驍・ｽ｡騾｡・･髯ｦ・ｨ驕会ｽｺ
          ctx.fillStyle = 'rgba(255, 214, 0, 0.45)';
          ctx.fillRect(x, y, width, height);
        } else if (state.isVisited) {
          ctx.fillStyle = 'rgba(255, 238, 88, 0.5)'; // 魄溘・・ｼ螢ｻ・ｸﾂ鬩幢ｽｨ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ繝ｻ莠･笏∬怦蛹ｻ縺・ｹｧ・､郢昴・ﾎ堤ｸｺ・ｯ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ繝ｻ繝ｻ
          ctx.fillRect(x, y, width, height);
        } else if (state.hasItems) {
          ctx.fillStyle = 'rgba(66, 165, 245, 0.3)'; // 鬮ｱ謚ｵ・ｼ螟青螢ｼ・ｸ・ｸ邵ｺ・ｮ隴幢ｽｪ髫ｪ・ｪ陜荳翫＞郢ｧ・､郢昴・ﾎ堤ｸｺ繧・ｽ・
          ctx.fillRect(x, y, width, height);
        }
      }
    });

    // 2. 驗ゑｽｫ驍ｱ螢ｹ・定ｬ蜀怜愛繝ｻ蛹ｻ縺懃ｹ晢ｽｼ郢晢｣ｰ郢晢ｽｬ郢晏生ﾎ晉ｸｺ・ｫ陟｢諛環ｧ邵ｺ・ｦ繝ｻ繝ｻ
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
          ctx.strokeStyle = border.color || '#000000'; // 郢昴・繝ｵ郢ｧ・ｩ郢晢ｽｫ郢晞メ迚｡郢ｧ蟶晢ｽｻ蛛ｵ竊楢棔逕ｻ蟲ｩ

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

        // 謨ｰ蟄励そ繝ｫ縺ｮ鄂ｫ邱壹・閭梧勹蝪励ｊ縺ｮ縺ｿ縺ｧ陦ｨ遉ｺ縺吶ｋ
      });
    }

    // 3. 郢昴・縺冗ｹｧ・ｹ郢晏現・定ｬ蜀怜愛繝ｻ蛹ｻ縺懃ｹ晢ｽｼ郢晢｣ｰ郢晢ｽｬ郢晏生ﾎ晉ｸｺ・ｫ陟｢諛環ｧ邵ｺ・ｦ繝ｻ繝ｻ
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

        // 郢晁ｼ斐°郢晢ｽｳ郢晏現縺礼ｹｧ・､郢ｧ・ｺ郢ｧ螳夲ｽｨ閧ｲ・ｮ繝ｻ
        let fontSize: number;
        if (merge) {
          // 驍ｨ莉咏ｲ狗ｹｧ・ｻ郢晢ｽｫ邵ｺ・ｯ陞滂ｽｧ邵ｺ髦ｪ・・
          if (isVertical) {
            // 驍ｵ・ｦ隴厄ｽｸ邵ｺ髦ｪ繝ｻ陜｣・ｴ陷ｷ蛹ｻ繝ｻ鬯ｮ蛟･・・ｸｺ・ｫ陜難ｽｺ邵ｺ・･邵ｺ繝ｻ窶ｻ郢ｧ・ｵ郢ｧ・､郢ｧ・ｺ郢ｧ螳夲ｽｪ・ｿ隰ｨ・ｴ
            const charCount = text.replace(/\n/g, '').length;
            fontSize = Math.min(width * 0.6, (height / (charCount + 1)) * 0.9, 16);
          } else {
            fontSize = Math.min(width, height) * (isDetailedView ? 0.5 : 0.4);
          }
        } else if (typeof cell.value === 'number') {
          // 隰ｨ・ｰ陋滂ｽ､郢ｧ・ｻ郢晢ｽｫ
          fontSize = Math.min(cellSize * 0.45, 14);
        } else {
          // 郢昴・縺冗ｹｧ・ｹ郢晏現縺晉ｹ晢ｽｫ
          fontSize = Math.min(cellSize * 0.4, 12);
        }

        fontSize = Math.max(fontSize, 8); // 隴崢陝・ｸ翫＠郢ｧ・､郢ｧ・ｺ

        ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 郢昴・縺冗ｹｧ・ｹ郢晞メ迚｡邵ｺ・ｨ郢ｧ・ｹ郢ｧ・ｿ郢ｧ・､郢晢ｽｫ
        const state = cellStates.get(`${cell.row}-${cell.col}`);
        const explicitFontColor = cell.fontColor?.trim();
        const enforceBlackNumberTextInDarkMode =
          isDarkMode && Boolean(state?.hasItems) && isNumberLikeCellValue(cell.value);

        // 陷・ｽｪ陷亥現縺・ｹｧ・､郢昴・ﾎ偵・逎ｯ・ｻ繝ｻ・ｻ蛛ｵ縺帷ｹ晏現ﾎ帷ｹｧ・､郢晁挙繝ｬ隴趣ｽｯ繝ｻ蟲ｨ繝ｻ陜｣・ｴ陷ｷ蛹ｻ繝ｻ騾具ｽｽ髢ｭ譴ｧ蜍ｹ郢ｧ蜻育ｷ帝包ｽｻ
        if (state?.hasPriorityUnvisited && typeof cell.value === 'number') {
          const textMetrics = ctx.measureText(text);
          const textWidth = textMetrics.width;
          const textHeight = fontSize;
          const padding = fontSize * 0.3;

          // 髫怜宴・ｸ・ｸ邵ｺ・ｮ騾具ｽｽ髢ｭ譴ｧ蜍ｹ郢ｧ蜻育ｷ帝包ｽｻ
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
            // 郢昴・縺冗ｹｧ・ｹ郢晞メ迚｡邵ｺ・ｯ魄溷・縲帝ｶ・ｮ驕ｶ荵昶螺邵ｺ蟶呻ｽ・
            ctx.fillStyle = '#212121';
          }
        } else if (enforceBlackNumberTextInDarkMode && !isWhiteLikeColor(explicitFontColor)) {
          ctx.fillStyle = '#111111';
        } else if (explicitFontColor) {
          ctx.fillStyle = resolveMapTextColorForTheme(explicitFontColor, isDarkMode);
        } else if (state?.isFullyVisited) {
          ctx.fillStyle = '#B71C1C'; // 雎ｼ繝ｻ・櫁･搾ｽ､繝ｻ螢ｼ繝ｻ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ
        } else if (state?.isVisited) {
          ctx.fillStyle = '#F57F17'; // 郢ｧ・ｪ郢晢ｽｬ郢晢ｽｳ郢ｧ・ｸ繝ｻ螢ｻ・ｸﾂ鬩幢ｽｨ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ
        } else if (state?.hasItems) {
          ctx.fillStyle = '#1565C0'; // 鬮ｱ謚ｵ・ｼ螟青螢ｼ・ｸ・ｸ邵ｺ・ｮ隴幢ｽｪ髫ｪ・ｪ陜荳翫＞郢ｧ・､郢昴・ﾎ堤ｸｺ繧・ｽ・
        } else {
          ctx.fillStyle = resolveMapTextColorForTheme(cell.fontColor, isDarkMode);
        }

        // 驍ｵ・ｦ隴厄ｽｸ邵ｺ髦ｪ繝ｻ陜｣・ｴ陷ｷ繝ｻ
        if (isVertical) {
          if (rotationRadians !== 0) {
            drawFittedVerticalTextInCell(text, x, y, width, height, fontSize);
          } else {
            // 隰ｾ・ｹ髯ｦ蠕後定崕繝ｻ迚｡邵ｺ霈費ｽ檎ｸｺ・ｦ邵ｺ繝ｻ・玖撻・ｴ陷ｷ蛹ｻ繝ｻ陷ｷ繝ｻ・｡蠕鯉ｽ定崕・･邵ｲ繝ｻ竊楢ｬ蜀怜愛
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
      // 驍ｵ・ｮ陝・ｹ怜・邵ｺ・ｯ隰ｨ・ｰ陋滂ｽ､郢ｧ・ｻ郢晢ｽｫ邵ｺ・ｮ邵ｺ・ｿ郢晏ｳｨ繝｣郢晞メ・｡・ｨ驕会ｽｺ
      mapData.cells.forEach((cell) => {
        if (cell.isMerged) return;

        const state = cellStates.get(`${cell.row}-${cell.col}`);
        if (!state?.hasItems) return;

        const x = (cell.col - 1) * cellSize;
        const y = (cell.row - 1) * cellSize;

        const merge = mergedCellsMap.get(`${cell.row}-${cell.col}`);
        const width = merge ? (merge.endCol - merge.startCol + 1) * cellSize : cellSize;
        const height = merge ? (merge.endRow - merge.startRow + 1) * cellSize : cellSize;

        // 郢晏ｳｨ繝｣郢晞メ・｡・ｨ驕会ｽｺ
        const dotSize = Math.max(cellSize * 0.4, 4);
        ctx.beginPath();

        if (state.isFullyVisited) {
          ctx.fillStyle = '#EF5350'; // 隘搾ｽ､繝ｻ螢ｼ繝ｻ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ
        } else if (state.hasPriorityUnvisited) {
          // 魄溘・・ｻ蛛ｵ繝ｻ髫ｴ・ｦ陷ｻ鬘倡横繝ｻ蛹ｻ繝ｩ郢昴・繝ｨ邵ｺ・ｧ邵ｺ・ｯ魄溘・迚｡邵ｺ・ｫ魄溷争譽ｧ繝ｻ繝ｻ 闕ｳﾂ鬩幢ｽｨ髫ｪ・ｪ陜荳奇ｽ育ｹｧ髮≫煤陷医・
          ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#FFD600';
          ctx.fill();
          ctx.strokeStyle = '#212121';
          ctx.lineWidth = Math.max(1, dotSize * 0.2);
          ctx.stroke();
          return; // 譌｢縺ｫ謠冗判貂医∩縺ｪ縺ｮ縺ｧ縺薙％縺ｧ邨ゆｺ・
        } else if (state.isVisited) {
          ctx.fillStyle = '#FFEE58'; // 魄溘・・ｼ螢ｻ・ｸﾂ鬩幢ｽｨ髫ｪ・ｪ陜荵暦ｽｸ蛹ｻ竏ｩ
        } else {
          ctx.fillStyle = '#42A5F5'; // 鬮ｱ謚ｵ・ｼ螟青螢ｼ・ｸ・ｸ邵ｺ・ｮ隴幢ｽｪ髫ｪ・ｪ陜荳翫＞郢ｧ・､郢昴・ﾎ堤ｸｺ繧・ｽ・
        }

        ctx.arc(x + width / 2, y + height / 2, dotSize / 2, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 4. 郢晢ｽｫ郢晢ｽｼ郢晏現・定ｬ蜀怜愛繝ｻ莠･笏∬怦莠･・ｺ・ｦ邵ｺ・ｧ豼ｶ・ｲ陋ｻ繝ｻ・邵ｲ繝ｻ纃ｾ髫阪・ﾎ夊崕繝ｻ繝ｻ陝ｷ・ｳ髯ｦ讙趣ｽｷ螟ｲ・ｼ繝ｻ
    if (!isRotationInteracting && isRouteVisible && routeSegments.length > 0) {
      // 陷・ｽｪ陷井ｺ･・ｺ・ｦ邵ｺ譁絶・邵ｺ・ｮ豼ｶ・ｲ郢ｧ雋橸ｽｮ螟ゑｽｾ・ｩ
      const getPriorityColor = (priority: 'none' | 'priority' | 'highest' | undefined): string => {
        switch (priority) {
          case 'highest':
            return '#EF4444'; // 隘搾ｽ､
          case 'priority':
            return '#F97316'; // 郢ｧ・ｪ郢晢ｽｬ郢晢ｽｳ郢ｧ・ｸ
          default:
            return '#1976D2'; // 髱・
        }
      };

      // 郢ｧ・ｰ郢晢ｽｫ郢晢ｽｼ郢晞斡菫｣隰暦ｽ･驍ｯ螢ｹﾂｰ邵ｺ・ｩ邵ｺ繝ｻﾂｰ郢ｧ雋樊・陞ｳ繝ｻ
      const isGroupTransition = (
        fromPriority: string | undefined,
        toPriority: string | undefined,
      ): boolean => {
        const from = fromPriority || 'none';
        const to = toPriority || 'none';
        return from !== to;
      };

      // 郢ｧ・ｨ郢昴・縺夂ｸｺ譁絶・邵ｺ・ｮ鬨ｾ螟絶с隲繝ｻ・ｰ・ｱ郢ｧ雋槫ｺｶ鬮ｮ繝ｻ・ｼ逎ｯ纃ｾ髫阪・・､諛ｷ繝ｻ騾包ｽｨ繝ｻ繝ｻ      // 郢ｧ・ｭ郢晢ｽｼ: "row1,col1-row2,col2"繝ｻ莠･・ｰ荳奇ｼ・ｸｺ繝ｻ・ｺ・ｧ隶灘生・定怦蛹ｻ竊薙・繝ｻ
      const edgeUsage = new Map<string, Set<'none' | 'priority' | 'highest'>>();

      const getEdgeKey = (r1: number, c1: number, r2: number, c2: number): string => {
        // 陝ｶ・ｸ邵ｺ・ｫ陝・ｸ奇ｼ・ｸｺ繝ｻ・ｺ・ｧ隶灘生・定怦蛹ｻ竊鍋ｸｺ蜉ｱ窶ｻ雎・ｽ｣髫穂ｸ槫密
        if (r1 < r2 || (r1 === r2 && c1 < c2)) {
          return `${r1},${c1}-${r2},${c2}`;
        }
        return `${r2},${c2}-${r1},${c1}`;
      };

      // 陷茨ｽｨ郢ｧ・ｻ郢ｧ・ｰ郢晢ｽ｡郢晢ｽｳ郢晏現繝ｻ郢ｧ・ｨ郢昴・縺夂ｹｧ雋槫ｺｶ鬮ｮ繝ｻ
      routeSegments.forEach((segment) => {
        if (segment.path.length < 2) return;

        // 郢ｧ・ｰ郢晢ｽｫ郢晢ｽｼ郢晞斡菫｣隰暦ｽ･驍ｯ螢ｹ繝ｻ郢ｧ・ｰ郢晢ｽｬ郢晢ｽｼ邵ｺ・ｪ邵ｺ・ｮ邵ｺ・ｧ鬩･蟠趣ｽ､繝ｻ縺咲ｹｧ・ｦ郢晢ｽｳ郢晏現竊楢惺・ｫ郢ｧ竏壺・邵ｺ繝ｻ
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

      // 郢ｧ・ｻ郢ｧ・ｰ郢晢ｽ｡郢晢ｽｳ郢晏現・定ｬ蜀怜愛
      const lineWidth = Math.max(2, cellSize * 0.08); // 陝・ｻ｣・驍擾ｽｰ邵ｺ繝ｻ
      // 陝ｷ・ｳ髯ｦ讙趣ｽｷ螢ｹ繝ｻ郢ｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ鬩･荳奇ｽ帝坎閧ｲ・ｮ證ｦ・ｼ蛹ｻ縺晉ｹ晢ｽｫ郢ｧ・ｵ郢ｧ・､郢ｧ・ｺ邵ｺ・ｫ陟｢諛環ｧ邵ｺ・ｦ髫ｱ・ｿ隰ｨ・ｴ繝ｻ繝ｻ
      const parallelOffset = Math.max(3, cellSize * 0.12);

      // 驍ｱ螢ｹ・堤ｹｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ邵ｺ蜷ｶ・矩ｫ｢・｢隰ｨ・ｰ
      const getOffsetPoints = (
        px1: number,
        py1: number,
        px2: number,
        py2: number,
        offset: number,
      ): { x1: number; y1: number; x2: number; y2: number } => {
        // 驍ｱ螢ｹ繝ｻ隴・ｽｹ陷ｷ莉｣繝ｻ郢ｧ・ｯ郢晏現ﾎ・
        const dx = px2 - px1;
        const dy = py2 - py1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return { x1: px1, y1: py1, x2: px2, y2: py2 };

        // 雎墓・・ｷ螢ｹ繝ｻ郢ｧ・ｯ郢晏現ﾎ昴・繝ｻ0陟趣ｽｦ陜玲ｫ・ｽｻ・｢繝ｻ繝ｻ
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

        // 郢ｧ・ｰ郢晢ｽｫ郢晢ｽｼ郢晞斡菫｣隰暦ｽ･驍ｯ螢ｹ繝ｻ郢ｧ・ｰ郢晢ｽｬ郢晢ｽｼ
        const baseColor = isTransition ? '#9CA3AF' : getPriorityColor(segment.fromPriority);

        // 郢昜ｻ｣縺帷ｹｧ蜑・ｽｸﾂ陟趣ｽｦ邵ｺ・ｫ隰蜀怜愛邵ｺ蜷ｶ・狗ｸｺ・ｮ邵ｺ・ｧ邵ｺ・ｯ邵ｺ・ｪ邵ｺ荳環竏壹♀郢昴・縺夂ｸｺ譁絶・邵ｺ・ｫ隰蜀怜愛
        for (let i = 0; i < segment.path.length - 1; i++) {
          const p1 = segment.path[i];
          const p2 = segment.path[i + 1];
          const edgeKey = getEdgeKey(p1.row, p1.col, p2.row, p2.col);

          const px1 = (p1.col - 0.5) * cellSize;
          const py1 = (p1.row - 0.5) * cellSize;
          const px2 = (p2.col - 0.5) * cellSize;
          const py2 = (p2.row - 0.5) * cellSize;

          // 郢ｧ・ｰ郢晢ｽｫ郢晢ｽｼ郢晞斡菫｣隰暦ｽ･驍ｯ螢ｹ繝ｻ鬩･蟠趣ｽ､繝ｻ繝｡郢ｧ・ｧ郢昴・縺題叉蟠趣ｽｦ繝ｻ・ｼ莠包ｽｸ・ｭ陞滂ｽｮ邵ｺ・ｫ隰蜀怜愛繝ｻ繝ｻ
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

          // 鬩･蟠趣ｽ､繝ｻ・邵ｺ・ｦ邵ｺ繝ｻ・狗ｹｧ・ｨ郢昴・縺夂ｸｺ荵昶・邵ｺ繝ｻﾂｰ郢ｧ蝣､・｢・ｺ髫ｱ繝ｻ
          const usedPriorities = edgeUsage.get(edgeKey);
          const isOverlapping = usedPriorities && usedPriorities.size > 1;

          if (isOverlapping) {
            // 鬩･蟠趣ｽ､繝ｻ縺顔ｹ昴・縺壹・螢ｼ・ｹ・ｳ髯ｦ讙趣ｽｷ螢ｹ縲定ｬ蜀怜愛
            const priorities = Array.from(usedPriorities!).sort((a, b) => {
              const order = { highest: 0, priority: 1, none: 2 };
              return order[a] - order[b];
            });

            // 邵ｺ阮吶・郢ｧ・ｻ郢ｧ・ｰ郢晢ｽ｡郢晢ｽｳ郢晏現繝ｻ陷・ｽｪ陷井ｺ･・ｺ・ｦ邵ｺ・ｮ郢ｧ・､郢晢ｽｳ郢昴・繝｣郢ｧ・ｯ郢ｧ・ｹ郢ｧ雋槫徐陟輔・
            const priorityIndex = priorities.indexOf(segmentPriority);
            if (priorityIndex === -1) continue;

            // 郢ｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ鬩･荳奇ｽ帝坎閧ｲ・ｮ證ｦ・ｼ莠包ｽｸ・ｭ陞滂ｽｮ郢ｧ雋樊ｸ戊ｲ・じ竊楢攬繝ｻ・ｭ蟲ｨ竊馴ｩ溷調・ｽ・ｮ繝ｻ繝ｻ
            const totalLines = priorities.length;
            const offsetIndex = priorityIndex - (totalLines - 1) / 2;
            const offset = offsetIndex * parallelOffset;

            // 郢ｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ邵ｺ蜉ｱ笳・趣ｽｧ隶灘生・帝坎閧ｲ・ｮ繝ｻ
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
            // 鬩･蟠趣ｽ､繝ｻ竊醍ｸｺ證ｦ・ｼ螟青螢ｼ・ｸ・ｸ邵ｺ・ｮ陞ｳ貅ｽ・ｷ繝ｻ
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

        // 驕擾ｽ｢陷奇ｽｰ繝ｻ蛹ｻ縺晉ｹｧ・ｰ郢晢ｽ｡郢晢ｽｳ郢晁ご・ｵ繧峨○邵ｺ・ｫ隰蜀怜愛繝ｻ繝ｻ
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

      // setLineDash郢ｧ蛛ｵﾎ懃ｹｧ・ｻ郢昴・繝ｨ
      ctx.setLineDash([]);

      // 髫ｪ・ｪ陜蝓趣｣ｰ繝ｻ蛻・愾・ｷ繝ｻ莠･笏∬怦莠･・ｺ・ｦ邵ｺ・ｧ豼ｶ・ｲ陋ｻ繝ｻ・繝ｻ繝ｻ
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

    // 5. 髫ｪ・ｪ陜荳槭・郢晢ｽｪ郢ｧ・ｹ郢晏現ﾂｰ郢ｧ蟲ｨ繝ｻ郢ｧ・ｻ郢晢ｽｫ郢昜ｸ翫≧郢晢ｽｩ郢ｧ・､郢昴・
    if (!isRotationInteracting && highlightedCell) {
      const x = (highlightedCell.col - 1) * cellSize;
      const y = (highlightedCell.row - 1) * cellSize;

      // 郢昜ｻ｣ﾎ晉ｹｧ・ｹ郢ｧ・｢郢昜ｹ斟鍋ｹ晢ｽｼ郢ｧ・ｷ郢晢ｽｧ郢晢ｽｳ鬯夲ｽｨ邵ｺ・ｮ郢昜ｸ翫≧郢晢ｽｩ郢ｧ・､郢昴・
      ctx.save();

      // 陞滄摩繝ｻ邵ｺ・ｮ郢晢ｽｪ郢晢ｽｳ郢ｧ・ｰ
      ctx.strokeStyle = '#FF6B00';
      ctx.lineWidth = Math.max(4, cellSize * 0.15);
      ctx.strokeRect(x - 2, y - 2, cellSize + 4, cellSize + 4);

      // 陷繝ｻ繝ｻ邵ｺ・ｮ郢晢ｽｪ郢晢ｽｳ郢ｧ・ｰ
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = Math.max(2, cellSize * 0.08);
      ctx.strokeRect(x + 2, y + 2, cellSize - 4, cellSize - 4);

      ctx.restore();
    }

    // 6. 郢晏ｸ吶・郢晢ｽｫ鬯・ｉ縺幃ｩ包ｽｸ隰壽ｧｭ繝ｻ郢晢ｽｬ郢晁侭ﾎ礼ｹ晢ｽｼ繝ｻ莠･・､螟奇ｽｧ雋橸ｽｽ・｢郢ｧ・ｪ郢晢ｽｼ郢晁・繝ｻ郢晢ｽｬ郢ｧ・､繝ｻ繝ｻ
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

      // 郢晏干ﾎ樒ｹ晁侭ﾎ礼ｹ晢ｽｼ騾包ｽｨ邵ｺ・ｫ鬩･讎奇ｽｿ繝ｻ・ｧ雋橸ｽｺ・ｦ郢ｧ・ｽ郢晢ｽｼ郢晏現・邵ｺ・ｦ髴趣ｽｺ闔・､陝ｾ・ｮ郢ｧ蟶昜ｺ溯ｱ・ｽ｢
      const centroidRow = vertices.reduce((s, v) => s + v.row, 0) / vertices.length;
      const centroidCol = vertices.reduce((s, v) => s + v.col, 0) / vertices.length;
      const sortedVertices = [...vertices].sort((a, b) => {
        return (
          Math.atan2(a.row - centroidRow, a.col - centroidCol) -
          Math.atan2(b.row - centroidRow, b.col - centroidCol)
        );
      });

      ctx.beginPath();
      ctx.fillStyle = 'rgba(255, 0, 0, 0.4)'; // 闕ｳ蝓ｼﾂ荵励・陟趣ｽｦ40%邵ｺ・ｮ隘搾ｽ､

      sortedVertices.forEach((vertex, i) => {
        // 郢ｧ・ｻ郢晢ｽｫ邵ｺ・ｮ闕ｳ・ｭ陟｢繝ｻ・ｺ・ｧ隶薙・
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

      // 鬯・ｉ縺帷ｹ晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ邵ｺ・ｨ騾｡・ｪ陷ｿ・ｷ郢ｧ蜻育ｷ帝包ｽｻ繝ｻ蛹ｻ縺醍ｹ晢ｽｪ郢昴・縺鷹ｬ・・縲帝勗・ｨ驕会ｽｺ繝ｻ繝ｻ
      vertices.forEach((vertex, i) => {
        const px = (vertex.col - 0.5) * cellSize;
        const py = (vertex.row - 0.5) * cellSize;

        // 鬯・ｉ縺帷ｹ晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ繝ｻ閧ｲ蜊邵ｺ繝ｻ繝ｻ繝ｻ繝ｻ
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#FF0000';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 騾｡・ｪ陷ｿ・ｷ
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FF0000';
        drawUprightText(String(i + 1), px, py);
      });
    } else if (!isRotationInteracting && vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
      // 3霓､・ｹ隴幢ｽｪ雋・邵ｺ・ｮ陜｣・ｴ陷ｷ蛹ｻ繝ｻ霓､・ｹ邵ｺ・ｨ驍ｱ螢ｹ繝ｻ邵ｺ・ｿ髯ｦ・ｨ驕会ｽｺ
      const vertices = vertexSelectionMode.clickedVertices;

      // 驍ｱ螢ｹ・定ｬ蜀怜愛繝ｻ繝ｻ霓､・ｹ闔会ｽ･闕ｳ鄙ｫ繝ｻ陜｣・ｴ陷ｷ闌ｨ・ｼ繝ｻ
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

      // 鬯・ｉ縺帷ｹ晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ邵ｺ・ｨ騾｡・ｪ陷ｿ・ｷ郢ｧ蜻育ｷ帝包ｽｻ
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

    // 7. 郢晄じﾎ溽ｹ昴・縺題楜螟ゑｽｾ・ｩ郢ｧ・ｻ郢晢ｽｫ鬩包ｽｸ隰壽ｧｭ繝ｻ郢晢ｽｼ郢ｧ・ｫ郢晢ｽｼ + 驕ｽ繝ｻ蟲・ｹ晏干ﾎ樒ｹ晁侭ﾎ礼ｹ晢ｽｼ
    if (!isRotationInteracting && cellSelectionMode && cellSelectionMode.clickedCells.length > 0) {
      const clickedCells = cellSelectionMode.clickedCells;
      const selType = cellSelectionMode.type;

      // Phase 3: 髦ｮ繝ｻ・ｷ鬘檎横邵ｺ・ｮ驕ｽ繝ｻ蟲・ｹ晏干ﾎ樒ｹ晁侭ﾎ礼ｹ晢ｽｼ繝ｻ繝ｻ霓､・ｹ闔会ｽ･闕ｳ螂・ｽｼ繝ｻ
      if (clickedCells.length >= 2) {
        if (selType === 'individual') {
          // 陋溷唱謖ｨ郢晢ｽ｢郢晢ｽｼ郢昴・ 陷ｷ繝ｻ縺晉ｹ晢ｽｫ郢ｧ雋楪蜿･謖ｨ邵ｺ・ｫ髦ｮ繝ｻ・ｷ莉｣縲堤ｹ昜ｸ翫≧郢晢ｽｩ郢ｧ・､郢昴・
          clickedCells.forEach((cell) => {
            // 驍ｨ莉咏ｲ狗ｹｧ・ｻ郢晢ｽｫ陝・ｽｾ陟｢繝ｻ
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
          // corner/multiCorner/rangeStart: 郢晁・縺育ｹ晢ｽｳ郢昴・縺・ｹ晢ｽｳ郢ｧ・ｰ郢晄㈱繝｣郢ｧ・ｯ郢ｧ・ｹ郢ｧ螳壼沂驍ｱ莉｣縲堤ｹ昜ｸ翫≧郢晢ｽｩ郢ｧ・､郢昴・
          const rows = clickedCells.map((c) => c.row);
          const cols = clickedCells.map((c) => c.col);
          const minRow = Math.min(...rows);
          const maxRow = Math.max(...rows);
          const minCol = Math.min(...cols);
          const maxCol = Math.max(...cols);

          // 驍ｨ莉咏ｲ狗ｹｧ・ｻ郢晢ｽｫ郢ｧ螳堋繝ｻ繝ｻ邵ｺ蜉ｱ窶ｻ陞ｳ貊・怙邵ｺ・ｮ髯ｦ・ｨ驕会ｽｺ驕ｽ繝ｻ蟲・ｹｧ蜻亥ヱ陟托ｽｵ
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
          // 隴ｫ・ｰ驍ｱ繝ｻ
          ctx.strokeStyle = 'rgba(76, 175, 80, 0.7)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 3]);
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.setLineDash([]);
        }
      }

      // Phase 2: 鬮ｱ螳夂横郢晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ郢ｧ蜻育ｷ帝包ｽｻ
      clickedCells.forEach((cell, i) => {
        // 驍ｨ莉咏ｲ狗ｹｧ・ｻ郢晢ｽｫ邵ｺ・ｮ陜｣・ｴ陷ｷ蛹ｻ繝ｻ驍ｨ莉咏ｲ矩⊃繝ｻ蟲・ｸｺ・ｮ闕ｳ・ｭ陟｢繝ｻ竊鍋ｹ晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ郢ｧ螳夲ｽ｡・ｨ驕会ｽｺ
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

        // 郢晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ繝ｻ閧ｲ蜊邵ｺ繝ｻ繝ｻ繝ｻ遏ｩ謳ｨ隴ｫ・ｰ繝ｻ繝ｻ
        ctx.beginPath();
        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = '#2196F3';
        ctx.lineWidth = 2;
        const markerSize = Math.max(10, cellSize * 0.4);
        ctx.arc(px, py, markerSize / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // 騾｡・ｪ陷ｿ・ｷ
        ctx.font = `bold ${Math.max(8, markerSize * 0.7)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#2196F3';
        drawUprightText(String(i + 1), px, py);
      });
    }

    // ctx.translate 郢ｧ螳夲ｽｧ・｣鬮ｯ・､
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

  // 郢ｧ・ｯ郢晢ｽｪ郢昴・縺題怎・ｦ騾・・
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (isDragging) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      // Canvas髯ｦ・ｨ驕会ｽｺ郢ｧ・ｵ郢ｧ・､郢ｧ・ｺ邵ｺ・ｫ陝・ｽｾ邵ｺ蜷ｶ・狗ｹｧ・ｯ郢晢ｽｪ郢昴・縺題抄蜥ｲ・ｽ・ｮ郢ｧ螳夲ｽｨ閧ｲ・ｮ繝ｻ
      const scaleX = canvas.width / dpr / rect.width;
      const scaleY = canvas.height / dpr / rect.height;

      // 郢晁侭ﾎ礼ｹ晢ｽｼ郢晄亢繝ｻ郢昜ｺ･・ｺ・ｧ隶薙・遶翫・郢晄ｧｭ繝｣郢晄懶ｽｺ・ｧ隶灘遜・ｼ蛹ｻ縺檎ｹ晁ｼ斐◎郢昴・繝ｨ郢ｧ雋橸ｽｼ霈費ｿ･繝ｻ繝ｻ
      const viewX = (e.clientX - rect.left) * scaleX;
      const viewY = (e.clientY - rect.top) * scaleY;
      const { x, y } = toMapCoordinates(viewX, viewY);

      // 鬯・ｉ縺幃ｩ包ｽｸ隰壽ｧｭﾎ皮ｹ晢ｽｼ郢晄・・ｸ・ｭ邵ｺ・ｯ邵ｲ竏壺穐邵ｺ螟撰｣ｰ繧峨○郢晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ邵ｺ・ｮ郢ｧ・ｯ郢晢ｽｪ郢昴・縺醍ｹｧ蛛ｵ繝｡郢ｧ・ｧ郢昴・縺・
      if (vertexSelectionMode && vertexSelectionMode.clickedVertices.length > 0) {
        const markerSize = Math.max(10, cellSize * 0.4);
        const clickRadius = markerSize; // 郢ｧ・ｯ郢晢ｽｪ郢昴・縺題崕・､陞ｳ螢ｹ・定氣莉｣・陟弱・・∫ｸｺ・ｫ

        for (const vertex of vertexSelectionMode.clickedVertices) {
          const markerX = (vertex.col - 0.5) * cellSize;
          const markerY = (vertex.row - 0.5) * cellSize;
          const distance = Math.sqrt(Math.pow(x - markerX, 2) + Math.pow(y - markerY, 2));

          if (distance <= clickRadius) {
            // 鬯・ｉ縺帷ｹ晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ邵ｺ蠕後￠郢晢ｽｪ郢昴・縺醍ｸｺ霈費ｽ檎ｸｺ繝ｻ遶翫・邵ｺ譏ｴ繝ｻ鬯・ｉ縺帷ｸｺ・ｮ郢ｧ・ｻ郢晢ｽｫ陟趣ｽｧ隶灘生縲堤ｹｧ・､郢晏生ﾎｦ郢晁ご蛹ｱ霓｣・ｫ
            window.dispatchEvent(
              new CustomEvent('mapCellClick', {
                detail: { row: vertex.row, col: vertex.col },
              }),
            );
            return; // 鬯・ｉ縺帷ｹｧ・ｯ郢晢ｽｪ郢昴・縺醍ｸｺ・ｮ陜｣・ｴ陷ｷ蛹ｻ繝ｻ鬨ｾ螢ｼ・ｸ・ｸ邵ｺ・ｮ郢ｧ・ｻ郢晢ｽｫ郢ｧ・ｯ郢晢ｽｪ郢昴・縺題怎・ｦ騾・・・堤ｹｧ・ｹ郢ｧ・ｭ郢昴・繝ｻ
          }
        }
      }

      const col = Math.floor(x / cellSize) + 1;
      const row = Math.floor(y / cellSize) + 1;

      if (row < 1 || row > mapData.maxRow || col < 1 || col > mapData.maxCol) {
        return;
      }

      // 郢ｧ・ｻ郢晢ｽｫ鬩包ｽｸ隰壽ｧｭﾎ皮ｹ晢ｽｼ郢晄・・ｸ・ｭ繝ｻ螟先勢郢晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ邵ｺ・ｮ郢ｧ・ｯ郢晢ｽｪ郢昴・縺題ｮ諛ｷ繝ｻ
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
            // 郢晄ｧｭ繝ｻ郢ｧ・ｫ郢晢ｽｼ郢ｧ・ｯ郢晢ｽｪ郢昴・縺・遶翫・邵ｺ譏ｴ繝ｻ郢ｧ・ｻ郢晢ｽｫ陟趣ｽｧ隶灘生縲堤ｹｧ・､郢晏生ﾎｦ郢晁ご蛹ｱ霓｣・ｫ繝ｻ驛・ｽｧ・｣鬮ｯ・､邵ｺ霈費ｽ檎ｹｧ蜈ｷ・ｼ繝ｻ
            window.dispatchEvent(
              new CustomEvent('mapCellClick', {
                detail: { row: cell.row, col: cell.col },
              }),
            );
            return;
          }
        }
      }

      // 郢ｧ・ｻ郢晢ｽｫ鬩包ｽｸ隰壽ｧｭﾎ皮ｹ晢ｽｼ郢晄・・ｸ・ｭ繝ｻ螟ゑｽｵ莉咏ｲ狗ｹｧ・ｻ郢晢ｽｫ郢ｧ蟶晏ｹ戊沂荵昴◎郢晢ｽｫ邵ｺ・ｫ髫暦ｽ｣雎趣ｽｺ
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

      // 郢晄じﾎ溽ｹ昴・縺題楜螟ゑｽｾ・ｩ郢昜ｻ｣繝ｭ郢晢ｽｫ騾包ｽｨ邵ｺ・ｮ郢ｧ・ｫ郢ｧ・ｹ郢ｧ・ｿ郢晢｣ｰ郢ｧ・､郢晏生ﾎｦ郢晏現・帝具ｽｺ霓｣・ｫ
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

  // 郢晏ｸ吶・郢晢ｽｫ邵ｺ・ｮ郢ｧ・ｹ郢ｧ・ｯ郢晢ｽｭ郢晢ｽｼ郢晢ｽｫ驕ｽ繝ｻ蟲・ｹｧ螳夲ｽｨ閧ｲ・ｮ繝ｻ
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

  // 郢ｧ・ｹ郢ｧ・ｯ郢晢ｽｭ郢晢ｽｼ郢晢ｽｫ陋ｻ・ｶ鬮ｯ闊鯉ｽ帝坎閧ｲ・ｮ蜉ｱ笘・ｹｧ遏ｩ譛ｪ隰ｨ・ｰ
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

  // 郢晏ｳｨﾎ帷ｹ昴・縺定怎・ｦ騾・・
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      lastPointerTypeRef.current = e.pointerType;
      // 郢晄鱒ﾎｦ郢昶・縺懃ｹ晢ｽｼ郢晢｣ｰ闕ｳ・ｭ邵ｺ・ｯ郢晏ｳｨﾎ帷ｹ昴・縺堤ｹｧ蝣､笏碁囎繝ｻ
      if (activeTouchesRef.current.size >= 2) return;
      setIsDragging(false);
      setDragStart({ x: e.clientX, y: e.clientY });
      setDragStartOffset({ ...offsetRef.current });
    },
    [],
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
      // 郢晄鱒ﾎｦ郢昶・縺懃ｹ晢ｽｼ郢晢｣ｰ闕ｳ・ｭ邵ｺ・ｯ郢晏ｳｨﾎ帷ｹ昴・縺堤ｹｧ蝣､笏碁囎繝ｻ
      if (activeTouchesRef.current.size >= 2) return;

      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;

      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
        setIsDragging(true);
      }

      // 隴・ｽｰ邵ｺ蜉ｱ・樒ｹｧ・ｪ郢晁ｼ斐◎郢昴・繝ｨ郢ｧ螳夲ｽｨ閧ｲ・ｮ繝ｻ
      const dragPanMultiplier = getDragPanMultiplier(zoomLevelRef.current);
      let newX = dragStartOffset.x + dx * dragPanMultiplier;
      let newY = dragStartOffset.y + dy * dragPanMultiplier;

      // 郢晏ｸ吶・郢晢ｽｫ鬩包ｽｸ隰壽ｨ雁・邵ｺ・ｯ郢ｧ・ｹ郢ｧ・ｯ郢晢ｽｭ郢晢ｽｼ郢晢ｽｫ驕ｽ繝ｻ蟲・ｹｧ雋槫ｮ幃ｫｯ繝ｻ
      const limits = calculateScrollLimits();
      if (limits) {
        newX = Math.max(limits.minX, Math.min(limits.maxX, newX));
        newY = Math.max(limits.minY, Math.min(limits.maxY, newY));
      }

      const nextOffset = {
        x: newX,
        y: newY,
      };
      setOffset(nextOffset);
      offsetRef.current = nextOffset;
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





