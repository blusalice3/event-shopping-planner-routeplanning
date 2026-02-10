import { useState, useCallback, useEffect } from 'react';
import React from 'react';

export function useMapControls() {
  // Map tab context menu
  const [mapTabMenuOpen, setMapTabMenuOpen] = useState<string | null>(null);
  const [mapTabMenuPosition, setMapTabMenuPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  // Block/hall definition modes
  const [blockDefinitionMode, setBlockDefinitionMode] = useState(false);
  const [hallDefinitionMode, setHallDefinitionMode] = useState(false);

  // Map view controls (header-driven)
  const [mapSelectedHallId, setMapSelectedHallId] = useState<string>('all');
  const [mapIsRouteVisible, setMapIsRouteVisible] = useState(true);
  const [mapIsHallOrderOpen, setMapIsHallOrderOpen] = useState(false);
  const [mapHallSelectorOpen, setMapHallSelectorOpen] = useState(false);

  // Smart insert settings
  const [mapSmartInsertEnabled, setMapSmartInsertEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertEnabled');
      return saved !== null ? saved === 'true' : true;
    } catch { return true; }
  });
  const [mapSmartInsertMode, setMapSmartInsertMode] = useState<'card' | 'preview'>(() => {
    try {
      const saved = localStorage.getItem('mapSmartInsertMode');
      return (saved === 'card' || saved === 'preview') ? saved : 'card';
    } catch { return 'card'; }
  });
  const [smartInsertToast, setSmartInsertToast] = useState<string | null>(null);
  const smartInsertLongPressRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const smartInsertLongPressTriggeredRef = React.useRef(false);

  // Persist smart insert settings
  React.useEffect(() => {
    try { localStorage.setItem('mapSmartInsertEnabled', String(mapSmartInsertEnabled)); } catch {}
  }, [mapSmartInsertEnabled]);

  React.useEffect(() => {
    try { localStorage.setItem('mapSmartInsertMode', mapSmartInsertMode); } catch {}
  }, [mapSmartInsertMode]);

  // Auto-hide toast
  React.useEffect(() => {
    if (smartInsertToast) {
      const timer = setTimeout(() => setSmartInsertToast(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [smartInsertToast]);

  // Cell selection mode (for block definition)
  const [cellSelectionMode, setCellSelectionMode] = useState<{
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual';
    clickedCells: { row: number; col: number }[];
    editingBlockData?: unknown;
  } | null>(null);

  const [pendingCellSelection, setPendingCellSelection] = useState<{
    type: string;
    cells: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // Vertex selection mode (for hall definition)
  const [vertexSelectionMode, setVertexSelectionMode] = useState<{
    clickedVertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  const [pendingVertexSelection, setPendingVertexSelection] = useState<{
    vertices: { row: number; col: number }[];
    editingData?: unknown;
  } | null>(null);

  // Start cell selection
  const handleStartCellSelection = useCallback((
    type: 'corner' | 'multiCorner' | 'rangeStart' | 'individual',
    editingData?: unknown
  ) => {
    setCellSelectionMode({ type, clickedCells: [], editingBlockData: editingData });
    setBlockDefinitionMode(false);
  }, []);

  // Confirm cell selection
  const handleConfirmCellSelection = useCallback(() => {
    if (cellSelectionMode) {
      setPendingCellSelection({
        type: cellSelectionMode.type,
        cells: cellSelectionMode.clickedCells,
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true);
  }, [cellSelectionMode]);

  // Cancel cell selection
  const handleCancelCellSelection = useCallback(() => {
    if (cellSelectionMode?.editingBlockData) {
      setPendingCellSelection({
        type: 'cancelled',
        cells: [],
        editingData: cellSelectionMode.editingBlockData,
      });
    }
    setCellSelectionMode(null);
    setBlockDefinitionMode(true);
  }, [cellSelectionMode]);

  // Listen for map cell clicks for cell selection
  useEffect(() => {
    const handleMapCellClick = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!cellSelectionMode) return;

      const { row, col } = e.detail;

      setCellSelectionMode(prev => {
        if (!prev) return prev;

        const existingIndex = prev.clickedCells.findIndex(c => c.row === row && c.col === col);
        if (existingIndex >= 0) {
          return {
            ...prev,
            clickedCells: prev.clickedCells.filter((_, i) => i !== existingIndex),
          };
        }

        return {
          ...prev,
          clickedCells: [...prev.clickedCells, { row, col }],
        };
      });
    };

    window.addEventListener('mapCellClick', handleMapCellClick as EventListener);
    return () => window.removeEventListener('mapCellClick', handleMapCellClick as EventListener);
  }, [cellSelectionMode]);

  // Start vertex selection
  const handleStartVertexSelection = useCallback((editingData?: unknown) => {
    setVertexSelectionMode({ clickedVertices: [], editingData });
    setHallDefinitionMode(false);
  }, []);

  // Sort vertices to form non-crossing polygon
  const sortVerticesNonCrossing = useCallback((vertices: { row: number; col: number }[]): { row: number; col: number }[] => {
    if (vertices.length <= 2) return vertices;

    const centroidRow = vertices.reduce((sum, v) => sum + v.row, 0) / vertices.length;
    const centroidCol = vertices.reduce((sum, v) => sum + v.col, 0) / vertices.length;

    return [...vertices].sort((a, b) => {
      const angleA = Math.atan2(a.row - centroidRow, a.col - centroidCol);
      const angleB = Math.atan2(b.row - centroidRow, b.col - centroidCol);
      return angleA - angleB;
    });
  }, []);

  // Confirm vertex selection
  const handleConfirmVertexSelection = useCallback(() => {
    if (vertexSelectionMode) {
      const sorted = sortVerticesNonCrossing(vertexSelectionMode.clickedVertices);
      setPendingVertexSelection({
        vertices: sorted,
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [vertexSelectionMode, sortVerticesNonCrossing]);

  // Cancel vertex selection
  const handleCancelVertexSelection = useCallback(() => {
    if (vertexSelectionMode?.editingData) {
      setPendingVertexSelection({
        vertices: [],
        editingData: vertexSelectionMode.editingData,
      });
    }
    setVertexSelectionMode(null);
    setHallDefinitionMode(true);
  }, [vertexSelectionMode]);

  // Listen for map cell clicks for vertex selection
  useEffect(() => {
    const handleMapCellClickForVertex = (e: CustomEvent<{ row: number; col: number }>) => {
      if (!vertexSelectionMode) return;

      const { row, col } = e.detail;

      setVertexSelectionMode(prev => {
        if (!prev) return prev;

        const existingIndex = prev.clickedVertices.findIndex(v => v.row === row && v.col === col);
        if (existingIndex !== -1) {
          return {
            ...prev,
            clickedVertices: prev.clickedVertices.filter((_, i) => i !== existingIndex),
          };
        }

        if (prev.clickedVertices.length >= 6) {
          return prev;
        }

        return {
          ...prev,
          clickedVertices: [...prev.clickedVertices, { row, col }],
        };
      });
    };

    window.addEventListener('mapCellClick', handleMapCellClickForVertex as EventListener);
    return () => {
      window.removeEventListener('mapCellClick', handleMapCellClickForVertex as EventListener);
    };
  }, [vertexSelectionMode]);

  return {
    // Map tab menu
    mapTabMenuOpen, setMapTabMenuOpen,
    mapTabMenuPosition, setMapTabMenuPosition,

    // Definition modes
    blockDefinitionMode, setBlockDefinitionMode,
    hallDefinitionMode, setHallDefinitionMode,

    // Map view controls
    mapSelectedHallId, setMapSelectedHallId,
    mapIsRouteVisible, setMapIsRouteVisible,
    mapIsHallOrderOpen, setMapIsHallOrderOpen,
    mapHallSelectorOpen, setMapHallSelectorOpen,

    // Smart insert
    mapSmartInsertEnabled, setMapSmartInsertEnabled,
    mapSmartInsertMode, setMapSmartInsertMode,
    smartInsertToast, setSmartInsertToast,
    smartInsertLongPressRef, smartInsertLongPressTriggeredRef,

    // Cell selection
    cellSelectionMode, setCellSelectionMode,
    pendingCellSelection, setPendingCellSelection,
    handleStartCellSelection,
    handleConfirmCellSelection,
    handleCancelCellSelection,

    // Vertex selection
    vertexSelectionMode, setVertexSelectionMode,
    pendingVertexSelection, setPendingVertexSelection,
    handleStartVertexSelection,
    handleConfirmVertexSelection,
    handleCancelVertexSelection,
  };
}
