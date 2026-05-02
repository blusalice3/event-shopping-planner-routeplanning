import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';

export interface Point {
  x: number;
  y: number;
}

export const normalizeRotationAngle = (angle: number): number => {
  const normalized = Math.round(angle) % 360;
  return normalized < 0 ? normalized + 360 : normalized;
};

export const rotatePointAroundCenter = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  angleRad: number,
): Point => {
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

interface UseCanvasViewportOptions {
  mapMaxCol: number;
  mapMaxRow: number;
  zoomLevel: number;
  rotationAngle?: number;
  baseCellSize: number;
  minZoom: number;
  maxZoom: number;
  initialOffset?: Point;
  offsetRef?: React.MutableRefObject<Point>;
  onZoomChange?: (newZoom: number) => void;
  onRotationAngleChange?: (newAngle: number) => void;
}

export const useCanvasViewport = ({
  mapMaxCol,
  mapMaxRow,
  zoomLevel,
  rotationAngle = 0,
  baseCellSize,
  minZoom,
  maxZoom,
  initialOffset,
  offsetRef: externalOffsetRef,
  onZoomChange,
  onRotationAngleChange,
}: UseCanvasViewportOptions) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [offset, setOffsetState] = useState<Point>(initialOffset ?? { x: 0, y: 0 });
  const internalOffsetRef = useRef(offset);
  const offsetRef = externalOffsetRef ?? internalOffsetRef;
  const zoomLevelRef = useRef(zoomLevel);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });
  const dragStartOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const rafPendingRef = useRef(false);
  const drawCanvasRef = useRef<(() => void) | null>(null);
  const activeTouchesRef = useRef<Map<number, Point>>(new Map());
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(zoomLevel);
  const pinchStartOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const isPinchGestureRef = useRef(false);
  const suppressClickUntilRef = useRef(0);
  const prevCellSizeRef = useRef(baseCellSize * (zoomLevel / 100));
  const [isRotationInteracting, setIsRotationInteracting] = useState(false);
  const rotationInteractionTimerRef = useRef<number | null>(null);

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scale = zoomLevel / 100;
  const cellSize = baseCellSize * scale;

  const setOffset = useCallback(
    (newOffset: Point) => {
      setOffsetState(newOffset);
      offsetRef.current = newOffset;
    },
    [offsetRef],
  );

  const normalizedRotationAngle = useMemo(
    () => normalizeRotationAngle(rotationAngle),
    [rotationAngle],
  );
  const rotationRadians = useMemo(
    () => (normalizedRotationAngle * Math.PI) / 180,
    [normalizedRotationAngle],
  );
  const mapCenterX = useMemo(() => (mapMaxCol * cellSize) / 2, [mapMaxCol, cellSize]);
  const mapCenterY = useMemo(() => (mapMaxRow * cellSize) / 2, [mapMaxRow, cellSize]);

  const toMapCoordinates = useCallback(
    (viewX: number, viewY: number, currentOffset?: Point) => {
      const ofs = currentOffset ?? offsetRef.current;
      const translatedX = viewX - ofs.x;
      const translatedY = viewY - ofs.y;
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
    [offsetRef, rotationRadians, mapCenterX, mapCenterY],
  );

  const rotateAroundMapCenter = useCallback(
    (x: number, y: number, angleRad = rotationRadians) =>
      rotatePointAroundCenter(x, y, mapCenterX, mapCenterY, angleRad),
    [mapCenterX, mapCenterY, rotationRadians],
  );

  const calculateOffsetForZoomPoint = useCallback(
    (
      viewX: number,
      viewY: number,
      newZoom: number,
      options?: {
        baseZoom?: number;
        baseOffset?: Point;
      },
    ) => {
      const baseZoom = options?.baseZoom ?? zoomLevelRef.current;
      const baseOffset = options?.baseOffset ?? offsetRef.current;
      const currentCellSize = baseCellSize * (baseZoom / 100);
      const newCellSize = baseCellSize * (newZoom / 100);
      const translatedX = viewX - baseOffset.x;
      const translatedY = viewY - baseOffset.y;
      let mapPointX = translatedX;
      let mapPointY = translatedY;

      if (rotationRadians !== 0) {
        const currentMapCenterX = (mapMaxCol * currentCellSize) / 2;
        const currentMapCenterY = (mapMaxRow * currentCellSize) / 2;
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
      const newMapCenterX = (mapMaxCol * newCellSize) / 2;
      const newMapCenterY = (mapMaxRow * newCellSize) / 2;
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
    [baseCellSize, mapMaxCol, mapMaxRow, offsetRef, rotationRadians],
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

  useEffect(() => {
    offsetRef.current = offset;
  }, [offset, offsetRef]);

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
      const viewX = e.clientX - rect.left;
      const viewY = e.clientY - rect.top;
      const currentZoom = zoomLevelRef.current;
      const zoomDelta = -e.deltaY * 0.1;
      const newZoom = Math.round(Math.max(minZoom, Math.min(maxZoom, currentZoom + zoomDelta)));

      if (newZoom === currentZoom) return;

      const newOffset = calculateOffsetForZoomPoint(viewX, viewY, newZoom, {
        baseZoom: currentZoom,
        baseOffset: offsetRef.current,
      });
      const newCellSize = baseCellSize * (newZoom / 100);

      setOffset(newOffset);
      prevCellSizeRef.current = newCellSize;
      zoomLevelRef.current = newZoom;
      onZoomChange(newZoom);
    },
    [
      baseCellSize,
      calculateOffsetForZoomPoint,
      maxZoom,
      minZoom,
      offsetRef,
      onRotationAngleChange,
      onZoomChange,
      rotationAngle,
      setOffset,
    ],
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        activeTouchesRef.current.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }

      if (activeTouchesRef.current.size === 2) {
        isPinchGestureRef.current = true;
        isDraggingRef.current = false;
        setIsDragging(false);
        e.preventDefault();
        const touches = Array.from(activeTouchesRef.current.values());
        const dx = touches[1].x - touches[0].x;
        const dy = touches[1].y - touches[0].y;
        pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoomRef.current = zoomLevelRef.current;
        pinchStartOffsetRef.current = { ...offsetRef.current };
      }
    },
    [offsetRef],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        activeTouchesRef.current.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
      }

      if (activeTouchesRef.current.size === 2 && onZoomChange) {
        isPinchGestureRef.current = true;
        e.preventDefault();
        const touches = Array.from(activeTouchesRef.current.values());
        const dx = touches[1].x - touches[0].x;
        const dy = touches[1].y - touches[0].y;
        const currentDist = Math.sqrt(dx * dx + dy * dy);

        if (pinchStartDistRef.current === 0) return;

        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const midX = (touches[0].x + touches[1].x) / 2 - rect.left;
        const midY = (touches[0].y + touches[1].y) / 2 - rect.top;
        const scaleRatio = currentDist / pinchStartDistRef.current;
        const newZoom = Math.round(
          Math.max(minZoom, Math.min(maxZoom, pinchStartZoomRef.current * scaleRatio)),
        );

        if (newZoom === zoomLevelRef.current) return;

        const newOffset = calculateOffsetForZoomPoint(midX, midY, newZoom, {
          baseZoom: pinchStartZoomRef.current,
          baseOffset: pinchStartOffsetRef.current,
        });
        const newCellSize = baseCellSize * (newZoom / 100);

        setOffset(newOffset);
        prevCellSizeRef.current = newCellSize;
        zoomLevelRef.current = newZoom;
        onZoomChange(newZoom);
      }
    },
    [
      baseCellSize,
      calculateOffsetForZoomPoint,
      maxZoom,
      minZoom,
      offsetRef,
      onZoomChange,
      setOffset,
    ],
  );

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      for (let i = 0; i < e.changedTouches.length; i++) {
        activeTouchesRef.current.delete(e.changedTouches[i].identifier);
      }

      if (activeTouchesRef.current.size < 2) {
        pinchStartDistRef.current = 0;
        isPinchGestureRef.current = false;
        isDraggingRef.current = false;
        setIsDragging(false);

        if (activeTouchesRef.current.size === 1) {
          const remainingTouch = Array.from(activeTouchesRef.current.values())[0];
          dragStartRef.current = { x: remainingTouch.x, y: remainingTouch.y };
          dragStartOffsetRef.current = { ...offsetRef.current };
        }
      }
    },
    [offsetRef],
  );

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

  return {
    activeTouchesRef,
    calculateOffsetForZoomPoint,
    canvasRef,
    cellSize,
    containerRef,
    dpr,
    dragStartOffsetRef,
    dragStartRef,
    drawCanvasRef,
    getPointerViewMetrics,
    isDragging,
    isDraggingRef,
    isPinchGestureRef,
    isRotationInteracting,
    mapCenterX,
    mapCenterY,
    normalizedRotationAngle,
    offset,
    offsetRef,
    prevCellSizeRef,
    rafPendingRef,
    rotateAroundMapCenter,
    rotationRadians,
    setIsDragging,
    setOffset,
    setOffsetState,
    suppressClickUntilRef,
    toMapCoordinates,
    zoomLevelRef,
  };
};
