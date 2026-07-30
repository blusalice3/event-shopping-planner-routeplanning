import React, {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
} from "react";
import {
  DayMapData,
  ZoomLevel,
  HallDefinition,
  HallRouteSettings,
  BlockDefinition,
  CellGroup,
  MapViewportState,
  RouteSegment,
  MIN_ZOOM,
  MAX_ZOOM,
} from "../../types/map";
import { ShoppingItem } from "../../types/item";
import MapCanvas from "./MapCanvas";
import CellItemsPopup from "./CellItemsPopup";
import MapVisitListPanel from "./MapVisitListPanel";
import HallOrderPanel from "./HallOrderPanel";
import InsertPositionDialog, { InsertPosition } from "./InsertPositionDialog";
import type { SmartInsertMode } from "../../features/app-shell/types";
import {
  extractNumberFromItemNumber,
  extractNumberAlphaPrefix,
} from "../../utils/xlsxMapParser";
import {
  resolveHallByBlockName,
  resolveManualHallId,
} from "../../utils/hallFallback";
import {
  buildMapRouteExecuteItemIds,
  normalizeMapRouteDayText,
  resolveMapRouteHallOrder,
} from "../../utils/mapRouteOrder";
import { isPointInPolygon } from "./HallDefinitionPanel";
import {
  isManualHallCompatibleForMapRoute,
  resolveMapRouteCellForItem,
} from "../../utils/hallGrouping";
import {
  resolveMapRoutePoints,
  type MapRoutePoint,
} from "../../utils/mapRoutePoints";
import { buildSelectedHallRouteMapData } from "../../utils/mapRouteMapData";
import {
  calculateRouteSegmentsPair,
  createRouteInsertMapSnapshots,
} from "./mapViewRouteCalculations";
import { validateMapSmartInsert } from "../../utils/mapSmartInsert";
import type { MapRouteHitResult } from "../../utils/mapRouteHitTest";
import { expandSameSpacePriorityItemIds } from "../../features/events/itemOps";

const normalizeDisplayText = (value: string | null | undefined): string => {
  return (value || "").replace(/\u3000/g, " ").trim();
};

const extractDayNameFromMapName = (mapName: string): string => {
  const normalizedMapName = normalizeDisplayText(mapName);
  const dayMatch = normalizedMapName.match(/^(.+)マップ$/);
  return dayMatch ? normalizeDisplayText(dayMatch[1]) : "";
};

type RouteInsertAnchorCandidate = {
  itemId: string;
  order: number;
  label: string;
};

type PendingHallVisitEntry = {
  itemId: string;
  hallId: string | null;
};

type MapRouteInsertPendingState = {
  itemIds: string[];
  representativeItem: ShoppingItem;
  existingRoutePointsAtStart: MapRoutePoint[];
  existingRouteSegmentsAtStart: RouteSegment[];
  canvasMapDataAtStart: DayMapData;
  routeInsertMissMapDataAtStart: DayMapData;
  pendingMapPoints: MapRoutePoint[];
  validationPoints: MapRoutePoint[];
  pendingHallVisitEntries: PendingHallVisitEntry[];
  message: string;
  errorMessage: string | null;
  duplicateCandidates: RouteInsertAnchorCandidate[];
} | null;

interface MapViewProps {
  mapData: DayMapData;
  mapName: string;
  items: ShoppingItem[];
  executeModeItemIds: string[];
  routeHallOrder?: string[];
  onAddToExecuteList: (itemId: string) => string[] | void;
  onRemoveFromExecuteList: (itemId: string) => string[] | void;
  onMoveToFirst: (itemId: string) => void;
  onMoveToLast: (itemId: string) => void;
  onUpdateItem?: (item: ShoppingItem) => void;
  onUpdateItemPriority?: (
    itemId: string,
    level: "none" | "priority" | "highest",
  ) => void;
  onDeleteItem?: (itemId: string) => void;
  onEditRequest?: (item: ShoppingItem) => void;
  onAddNewItem?: (eventDate: string, block: string, number: string) => void;
  onAddItem?: (
    item: Omit<ShoppingItem, "id"> & {
      purchaseStatus?: import("../../types/item").PurchaseStatus;
    },
  ) => void;
  onAddToExecuteListAtPosition?: (
    itemId: string,
    referenceItemId: string,
    position: "before" | "after",
  ) => string[] | boolean;
  onBatchAddToExecuteList?: (itemIds: string[]) => string[] | void;
  onBatchAddToExecuteListAtPosition?: (
    itemIds: string[],
    referenceItemId: string,
    position: "before" | "after",
  ) => string[] | boolean;
  onBatchRemoveFromExecuteList?: (itemIds: string[]) => string[] | void;

  halls: HallDefinition[];
  hallRouteSettings: HallRouteSettings;
  onUpdateHallRouteSettings: (settings: HallRouteSettings) => void;
  onReorderExecuteList?: (hallOrder: string[]) => void;

  vertexSelectionMode?: {
    clickedVertices: { row: number; col: number }[];
  } | null;

  cellSelectionMode?: {
    type: string;
    clickedCells: { row: number; col: number }[];
  } | null;

  highlightedCell?: { row: number; col: number } | null;

  externalSelectedHallId?: string;
  onSelectedHallIdChange?: (hallId: string) => void;
  externalIsRouteVisible?: boolean;
  onRouteVisibleChange?: (visible: boolean) => void;
  externalIsHallOrderOpen?: boolean;
  onHallOrderOpenChange?: (open: boolean) => void;
  hideInternalControls?: boolean;
  smartInsertEnabled?: boolean;
  smartInsertMode?: SmartInsertMode;
  rotationAngle?: number;
  onRotationAngleChange?: (newAngle: number) => void;
  selectionGuideOptions?: {
    showGrid: boolean;
    showRuler: boolean;
  };
  initialViewport?: MapViewportState;
  onViewportChange?: (viewport: MapViewportState) => void;
  numberCellOutlineStyle?: import("../../types/map").NumberCellOutlineStyle;
}

const MapView: React.FC<MapViewProps> = ({
  mapData,
  mapName,
  items,
  executeModeItemIds,
  routeHallOrder,
  onAddToExecuteList,
  onRemoveFromExecuteList,
  onMoveToFirst: _onMoveToFirst,
  onMoveToLast: _onMoveToLast,
  onUpdateItem,
  onUpdateItemPriority,
  onDeleteItem,
  onEditRequest,
  onAddNewItem,
  onAddItem,
  onAddToExecuteListAtPosition,
  onBatchAddToExecuteList,
  onBatchAddToExecuteListAtPosition,
  onBatchRemoveFromExecuteList,
  halls,
  hallRouteSettings,
  onUpdateHallRouteSettings,
  onReorderExecuteList,
  vertexSelectionMode,
  cellSelectionMode,
  highlightedCell,
  externalSelectedHallId,
  onSelectedHallIdChange,
  externalIsRouteVisible,
  onRouteVisibleChange,
  externalIsHallOrderOpen,
  onHallOrderOpenChange,
  hideInternalControls = false,
  smartInsertEnabled = true,
  smartInsertMode = "map",
  rotationAngle = 0,
  onRotationAngleChange,
  selectionGuideOptions,
  initialViewport,
  onViewportChange,
  numberCellOutlineStyle = "rounded",
}) => {
  void _onMoveToFirst;
  void _onMoveToLast;

  const [zoomLevel, setZoomLevelState] = useState<number>(
    initialViewport?.zoomLevel ?? 100,
  );
  const zoomLevelRef = useRef(zoomLevel);
  const canvasOffsetRef = useRef<{ x: number; y: number }>(
    initialViewport
      ? { x: initialViewport.offsetX, y: initialViewport.offsetY }
      : { x: 0, y: 0 },
  );
  const onViewportChangeRef = useRef(onViewportChange);
  onViewportChangeRef.current = onViewportChange;

  const setZoomLevel = useCallback((newZoom: number) => {
    zoomLevelRef.current = newZoom;
    setZoomLevelState(newZoom);
  }, []);

  useEffect(() => {
    return () => {
      onViewportChangeRef.current?.({
        zoomLevel: zoomLevelRef.current,
        offsetX: canvasOffsetRef.current.x,
        offsetY: canvasOffsetRef.current.y,
      });
    };
  }, []);
  const [internalIsRouteVisible, setInternalIsRouteVisible] = useState(true);
  const [isVisitListOpen, setIsVisitListOpen] = useState(false);
  const [internalIsHallOrderOpen, setInternalIsHallOrderOpen] = useState(false);
  const [internalSelectedHallId, setInternalSelectedHallId] =
    useState<string>("all");

  const [insertDialogState, setInsertDialogState] = useState<{
    isOpen: boolean;
    item: ShoppingItem | null;
  }>({ isOpen: false, item: null });

  const [batchInsertPendingIds, setBatchInsertPendingIds] = useState<
    string[] | null
  >(null);
  const [mapRouteInsertPending, setMapRouteInsertPending] =
    useState<MapRouteInsertPendingState>(null);
  const mapRouteInsertPendingRef = useRef<MapRouteInsertPendingState>(null);

  useEffect(() => {
    mapRouteInsertPendingRef.current = mapRouteInsertPending;
  }, [mapRouteInsertPending]);

  const selectedHallId =
    externalSelectedHallId !== undefined
      ? externalSelectedHallId
      : internalSelectedHallId;
  const setSelectedHallId = onSelectedHallIdChange || setInternalSelectedHallId;
  const isRouteVisible =
    externalIsRouteVisible !== undefined
      ? externalIsRouteVisible
      : internalIsRouteVisible;
  const setIsRouteVisible = onRouteVisibleChange || setInternalIsRouteVisible;
  const isHallOrderOpen =
    externalIsHallOrderOpen !== undefined
      ? externalIsHallOrderOpen
      : internalIsHallOrderOpen;
  const setIsHallOrderOpen =
    onHallOrderOpenChange || setInternalIsHallOrderOpen;

  const [popupState, setPopupState] = useState<{
    isOpen: boolean;
    row: number;
    col: number;
    blockName: string;
    number: number;
    items: ShoppingItem[];
    position: { x: number; y: number };
  }>({
    isOpen: false,
    row: 0,
    col: 0,
    blockName: "",
    number: 0,
    items: [],
    position: { x: 0, y: 0 },
  });

  const executeModeItemIdsSet = useMemo(
    () => new Set(executeModeItemIds),
    [executeModeItemIds],
  );
  const itemsById = useMemo(() => {
    const indexedItems = new Map<string, ShoppingItem>();
    for (const item of items) {
      // Array.findと同じく、重複IDがあっても先頭のアイテムを優先する。
      if (!indexedItems.has(item.id)) indexedItems.set(item.id, item);
    }
    return indexedItems;
  }, [items]);
  const mapDayName = useMemo(
    () => extractDayNameFromMapName(mapName),
    [mapName],
  );

  const getHallIdsByCellPosition = useCallback(
    (row: number, col: number): string[] => {
      const ids: string[] = [];
      for (const hall of halls) {
        if (
          hall.vertices.length >= 4 &&
          isPointInPolygon(row, col, hall.vertices)
        ) {
          ids.push(hall.id);
        }
      }
      return ids;
    },
    [halls],
  );

  const getCandidateBlocksForItem = useCallback(
    (itemBlockName: string): BlockDefinition[] => {
      if (!itemBlockName) return [];

      const exactMatches = mapData.blocks.filter(
        (block) => block.name === itemBlockName,
      );
      if (exactMatches.length > 0) {
        return exactMatches;
      }

      const normalizedBlockName = itemBlockName.toLowerCase();
      return mapData.blocks.filter(
        (block) => block.name.toLowerCase() === normalizedBlockName,
      );
    },
    [mapData.blocks],
  );

  const getHallCandidatesForItem = useCallback(
    (item: ShoppingItem): Set<string> => {
      const hallIds = new Set<string>();

      const manual = resolveManualHallId(item.manualHallId, halls);
      if (manual) {
        hallIds.add(manual);
        return hallIds;
      }

      const itemBlockName = item.block?.trim() || "";
      const candidateBlocks = getCandidateBlocksForItem(itemBlockName);
      if (candidateBlocks.length === 0) {
        const fallback = resolveHallByBlockName(item.block, halls);
        if (fallback) hallIds.add(fallback);
        return hallIds;
      }

      const numStr = extractNumberFromItemNumber(item.number);
      if (numStr) {
        const numValue = parseInt(numStr, 10);
        candidateBlocks.forEach((block) => {
          block.numberCells.forEach((numberCell) => {
            if (numberCell.value !== numValue) return;
            const matchedHallIds = getHallIdsByCellPosition(
              numberCell.row,
              numberCell.col,
            );
            matchedHallIds.forEach((matchedHallId) =>
              hallIds.add(matchedHallId),
            );
          });
        });
      }

      if (hallIds.size > 0) {
        return hallIds;
      }

      const blockHallIds = new Set<string>();
      candidateBlocks.forEach((block) => {
        block.numberCells.forEach((numberCell) => {
          const matchedHallIds = getHallIdsByCellPosition(
            numberCell.row,
            numberCell.col,
          );
          matchedHallIds.forEach((matchedHallId) =>
            blockHallIds.add(matchedHallId),
          );
        });

        if (blockHallIds.size === 1) {
          blockHallIds.forEach((hallId) => hallIds.add(hallId));
        }
      });

      if (hallIds.size > 0) {
        return hallIds;
      }

      candidateBlocks.forEach((block) => {
        const centerRow = (block.startRow + block.endRow) / 2;
        const centerCol = (block.startCol + block.endCol) / 2;
        const matchedHallIds = getHallIdsByCellPosition(centerRow, centerCol);
        matchedHallIds.forEach((matchedHallId) => hallIds.add(matchedHallId));
      });

      if (hallIds.size === 0) {
        const fallback = resolveHallByBlockName(item.block, halls);
        if (fallback) hallIds.add(fallback);
      }

      return hallIds;
    },
    [getCandidateBlocksForItem, getHallIdsByCellPosition, halls],
  );

  const isItemInHall = useCallback(
    (item: ShoppingItem, hallId: string): boolean => {
      return getHallCandidatesForItem(item).has(hallId);
    },
    [getHallCandidatesForItem],
  );

  const getItemHallId = useCallback(
    (item: ShoppingItem): string | null => {
      const hallCandidates = getHallCandidatesForItem(item);
      if (hallCandidates.size === 1) {
        return Array.from(hallCandidates)[0];
      }
      if (
        hallCandidates.size > 1 &&
        selectedHallId !== "all" &&
        hallCandidates.has(selectedHallId)
      ) {
        return selectedHallId;
      }
      return null;
    },
    [getHallCandidatesForItem, selectedHallId],
  );

  const parseGroupId = useCallback(
    (
      groupId: string | null,
    ): { hallId: string | null; priority: "none" | "priority" | "highest" } => {
      if (groupId === null) return { hallId: null, priority: "none" };
      if (groupId === "undefined:highest")
        return { hallId: null, priority: "highest" };
      if (groupId === "undefined:priority")
        return { hallId: null, priority: "priority" };
      if (groupId.endsWith(":highest")) {
        return { hallId: groupId.replace(":highest", ""), priority: "highest" };
      }
      if (groupId.endsWith(":priority")) {
        return {
          hallId: groupId.replace(":priority", ""),
          priority: "priority",
        };
      }
      return { hallId: groupId, priority: "none" };
    },
    [],
  );

  const getItemCountInHall = useCallback(
    (groupId: string): number => {
      const { hallId, priority } = parseGroupId(groupId);

      return executeModeItemIds.filter((itemId) => {
        const item = itemsById.get(itemId);
        if (!item) return false;

        const belongsToHall =
          hallId === null
            ? getItemHallId(item) === null
            : isItemInHall(item, hallId);
        if (!belongsToHall) return false;

        const itemPriority = item.priorityLevel || "none";
        return itemPriority === priority;
      }).length;
    },
    [executeModeItemIds, itemsById, getItemHallId, isItemInHall, parseGroupId],
  );

  const getHallTotalExecuteCount = useCallback(
    (hallId: string): number => {
      return executeModeItemIds.filter((itemId) => {
        const item = itemsById.get(itemId);
        if (!item) return false;

        return isItemInHall(item, hallId);
      }).length;
    },
    [executeModeItemIds, itemsById, isItemInHall],
  );

  const getTotalItemCountInHall = useCallback(
    (hallId: string): number => {
      return items.filter((item) => {
        if (mapDayName && normalizeDisplayText(item.eventDate) !== mapDayName)
          return false;
        return isItemInHall(item, hallId);
      }).length;
    },
    [items, mapDayName, isItemInHall],
  );

  // Filter display map data to the selected hall while preserving display compatibility.
  const filteredMapData = useMemo(() => {
    if (selectedHallId === "all" || halls.length === 0) {
      return mapData;
    }

    const selectedHall = halls.find((h) => h.id === selectedHallId);
    if (!selectedHall || selectedHall.vertices.length < 4) {
      return mapData;
    }

    const filteredCells = mapData.cells.filter((cell) => {
      return isPointInPolygon(cell.row, cell.col, selectedHall.vertices);
    });
    const filteredBlocks = mapData.blocks.map((block) => {
      const filteredNumberCells = block.numberCells.filter((nc) => {
        return isPointInPolygon(nc.row, nc.col, selectedHall.vertices);
      });

      return {
        ...block,
        numberCells:
          filteredNumberCells.length > 0
            ? filteredNumberCells
            : block.numberCells,
      };
    });

    let minRow = Infinity,
      maxRow = 0,
      minCol = Infinity,
      maxCol = 0;
    filteredCells.forEach((cell) => {
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minCol = Math.min(minCol, cell.col);
      maxCol = Math.max(maxCol, cell.col);
    });

    return {
      ...mapData,
      cells: filteredCells,
      blocks: filteredBlocks,
      maxRow: maxRow > 0 ? maxRow : mapData.maxRow,
      maxCol: maxCol > 0 ? maxCol : mapData.maxCol,
    };
  }, [mapData, selectedHallId, halls]);

  const filteredItems = useMemo(() => {
    if (selectedHallId === "all" || halls.length === 0) {
      return items;
    }

    return items.filter((item) => isItemInHall(item, selectedHallId));
  }, [items, selectedHallId, halls, isItemInHall]);

  const filteredExecuteModeItemIds = useMemo(() => {
    if (selectedHallId === "all" || halls.length === 0) {
      return executeModeItemIds;
    }

    return executeModeItemIds.filter((itemId) => {
      const item = itemsById.get(itemId);
      if (!item) return false;
      return isItemInHall(item, selectedHallId);
    });
  }, [executeModeItemIds, itemsById, selectedHallId, halls, isItemInHall]);

  const effectiveRouteHallOrder = useMemo(
    () => resolveMapRouteHallOrder(routeHallOrder, hallRouteSettings.hallOrder),
    [routeHallOrder, hallRouteSettings.hallOrder],
  );

  const selectedHallRouteMapData = useMemo(() => {
    if (selectedHallId === "all" || halls.length === 0) return null;
    return buildSelectedHallRouteMapData(
      mapData,
      halls.find((hall) => hall.id === selectedHallId),
    );
  }, [mapData, selectedHallId, halls]);

  const strictFilteredMapData =
    selectedHallRouteMapData?.strictFilteredMapData ?? null;
  const hallConstrainedPathfindingMapData =
    selectedHallRouteMapData?.hallConstrainedPathfindingMapData ?? null;
  const selectedHallRoutePathConstraint =
    selectedHallRouteMapData?.routePathConstraint ?? undefined;
  const hasValidSelectedHallRouteContext =
    selectedHallId === "all" ||
    halls.length === 0 ||
    selectedHallRouteMapData !== null;

  const routeResolutionMapData =
    selectedHallId === "all" || halls.length === 0
      ? mapData
      : strictFilteredMapData;

  const displayRouteExecuteModeItemIds = useMemo(() => {
    return buildMapRouteExecuteItemIds({
      executeModeItemIds: filteredExecuteModeItemIds,
      items: filteredItems,
      mapData: filteredMapData,
      hallDefinitions: halls,
      hallOrder: effectiveRouteHallOrder,
      dayName: mapDayName || normalizeDisplayText(mapName),
    });
  }, [
    filteredExecuteModeItemIds,
    filteredItems,
    filteredMapData,
    halls,
    effectiveRouteHallOrder,
    mapDayName,
    mapName,
  ]);

  const mapRouteResolutionItems = useMemo(() => {
    const normalizedDayName = normalizeMapRouteDayText(
      mapDayName || normalizeDisplayText(mapName),
    );
    return items.filter(
      (item) => normalizeMapRouteDayText(item.eventDate) === normalizedDayName,
    );
  }, [items, mapDayName, mapName]);

  const mapRouteExecuteCandidateItemIds = useMemo(() => {
    if (selectedHallId === "all" || halls.length === 0)
      return executeModeItemIds;
    if (!routeResolutionMapData) return [];

    const itemsById = new Map(
      mapRouteResolutionItems.map((item) => [item.id, item]),
    );
    return executeModeItemIds.filter((itemId) => {
      const item = itemsById.get(itemId);
      if (!item) return false;
      if (
        !isManualHallCompatibleForMapRoute({
          item,
          hallDefinitions: halls,
          selectedHallId,
        })
      ) {
        return false;
      }
      return (
        resolveMapRouteCellForItem({
          mapData: routeResolutionMapData,
          item,
          requireCellInMap: true,
        }) !== null
      );
    });
  }, [
    executeModeItemIds,
    mapRouteResolutionItems,
    routeResolutionMapData,
    selectedHallId,
    halls,
  ]);

  const mapInsertRouteExecuteModeItemIds = useMemo(() => {
    if (!hasValidSelectedHallRouteContext) return [];
    return buildMapRouteExecuteItemIds({
      executeModeItemIds: mapRouteExecuteCandidateItemIds,
      items: mapRouteResolutionItems,
      mapData:
        selectedHallId === "all" || halls.length === 0
          ? mapData
          : strictFilteredMapData,
      hallDefinitions: halls,
      hallOrder: effectiveRouteHallOrder,
      dayName: mapDayName || normalizeDisplayText(mapName),
      selectedHallId,
    });
  }, [
    hasValidSelectedHallRouteContext,
    mapRouteExecuteCandidateItemIds,
    mapRouteResolutionItems,
    selectedHallId,
    halls,
    mapData,
    strictFilteredMapData,
    effectiveRouteHallOrder,
    mapDayName,
    mapName,
  ]);

  const displayRoutePoints = useMemo(
    () =>
      resolveMapRoutePoints({
        itemIds: displayRouteExecuteModeItemIds,
        items: filteredItems,
        mapData: filteredMapData,
        hallDefinitions: halls,
        dayName: mapDayName || normalizeDisplayText(mapName),
        selectedHallId,
        requireCellInMap: false,
        respectManualHallMismatch: false,
      }).routePoints,
    [
      displayRouteExecuteModeItemIds,
      filteredItems,
      filteredMapData,
      halls,
      mapDayName,
      mapName,
      selectedHallId,
    ],
  );

  const mapInsertRoutePointsResult = useMemo(() => {
    if (!routeResolutionMapData) {
      return {
        routePoints: [],
        missingItemIds: mapInsertRouteExecuteModeItemIds,
      };
    }
    return resolveMapRoutePoints({
      itemIds: mapInsertRouteExecuteModeItemIds,
      items: mapRouteResolutionItems,
      mapData: routeResolutionMapData,
      hallDefinitions: halls,
      dayName: mapDayName || normalizeDisplayText(mapName),
      selectedHallId,
      requireCellInMap: selectedHallId !== "all" && halls.length > 0,
      respectManualHallMismatch: true,
    });
  }, [
    routeResolutionMapData,
    mapInsertRouteExecuteModeItemIds,
    mapRouteResolutionItems,
    halls,
    mapDayName,
    mapName,
    selectedHallId,
  ]);
  const mapInsertRoutePoints = mapInsertRoutePointsResult.routePoints;

  const displayRoutePathfindingMapData =
    selectedHallId === "all" || halls.length === 0 ? mapData : filteredMapData;
  const mapInsertRoutePathfindingMapData =
    selectedHallId === "all" || halls.length === 0
      ? mapData
      : hallConstrainedPathfindingMapData;
  const mapInsertRoutePathConstraint =
    selectedHallId === "all" || halls.length === 0
      ? undefined
      : selectedHallRoutePathConstraint;
  const includeDisplayRoute =
    isRouteVisible && (halls.length === 0 || selectedHallId !== "all");
  const includeMapInsertRoute = smartInsertEnabled && smartInsertMode === "map";
  const { displayRouteSegments, mapInsertRouteSegments } = useMemo(
    () =>
      calculateRouteSegmentsPair({
        displayMapData: displayRoutePathfindingMapData,
        displayRoutePoints,
        mapInsertMapData: mapInsertRoutePathfindingMapData,
        mapInsertRoutePoints,
        mapInsertPathConstraint: mapInsertRoutePathConstraint,
        includeDisplayRoute,
        includeMapInsertRoute,
      }),
    [
      displayRoutePathfindingMapData,
      displayRoutePoints,
      mapInsertRoutePathfindingMapData,
      mapInsertRoutePoints,
      mapInsertRoutePathConstraint,
      includeDisplayRoute,
      includeMapInsertRoute,
    ],
  );

  const routeExecuteModeItemIds = displayRouteExecuteModeItemIds;

  const isCellInBlock = useCallback(
    (row: number, col: number, block: BlockDefinition): boolean => {
      if (block.cellGroups && block.cellGroups.length > 0) {
        return block.cellGroups.some((group) => {
          if (group.type === "range") {
            return (
              row >= (group.startRow || 0) &&
              row <= (group.endRow || 0) &&
              col >= (group.startCol || 0) &&
              col <= (group.endCol || 0)
            );
          } else if (group.type === "individual" && group.cells) {
            return group.cells.some((c) => c.row === row && c.col === col);
          }
          return false;
        });
      }

      return (
        row >= block.startRow &&
        row <= block.endRow &&
        col >= block.startCol &&
        col <= block.endCol
      );
    },
    [],
  );

  const handleCellClick = useCallback(
    (row: number, col: number, matchingItems: ShoppingItem[]) => {
      if (vertexSelectionMode || cellSelectionMode) return;

      let foundBlock: { name: string; number: number } | null = null;

      let resolvedRow = row;
      let resolvedCol = col;
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

      for (const block of mapData.blocks) {
        if (isCellInBlock(resolvedRow, resolvedCol, block)) {
          if (
            block.nameCells &&
            block.nameCells.some(
              (nc) => nc.row === resolvedRow && nc.col === resolvedCol,
            )
          ) {
            continue;
          }

          const numberCell = block.numberCells.find(
            (nc) => nc.row === resolvedRow && nc.col === resolvedCol,
          );
          if (numberCell) {
            foundBlock = { name: block.name, number: numberCell.value };
            break;
          }

          if (!foundBlock) {
            const cell = mapData.cells.find(
              (c) => c.row === resolvedRow && c.col === resolvedCol,
            );

            if (cell && cell.value !== null && cell.value !== undefined) {
              const cellValue = String(cell.value).trim();
              if (cellValue === block.name) continue;
              const numMatch = cellValue.match(/^(\d+)/);
              if (numMatch) {
                foundBlock = {
                  name: block.name,
                  number: parseInt(numMatch[1], 10),
                };
                break;
              }
            }
          }
        }
      }

      if (!foundBlock && matchingItems.length === 0) return;

      const position = {
        x: window.innerWidth / 2 - 160,
        y: window.innerHeight / 3,
      };

      if (foundBlock) {
        setPopupState({
          isOpen: true,
          row,
          col,
          blockName: foundBlock.name,
          number: foundBlock.number,
          items: matchingItems,
          position,
        });
      } else if (matchingItems.length > 0) {
        const firstItem = matchingItems[0];
        const numStr = extractNumberFromItemNumber(firstItem.number);
        const numValue = numStr ? parseInt(numStr, 10) : 0;

        setPopupState({
          isOpen: true,
          row,
          col,
          blockName: firstItem.block,
          number: numValue,
          items: matchingItems,
          position,
        });
      }
    },
    [
      mapData.blocks,
      mapData.cells,
      mapData.mergedCells,
      vertexSelectionMode,
      cellSelectionMode,
      isCellInBlock,
    ],
  );

  const handleClosePopup = useCallback(() => {
    setPopupState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const normalizeInsertedItemIds = useCallback(
    (
      result: string[] | boolean | void,
      fallbackIds: string[],
    ): string[] | null => {
      if (Array.isArray(result)) return result.length > 0 ? result : null;
      if (result === false) return null;
      return fallbackIds;
    },
    [],
  );

  const normalizeAffectedItemIds = useCallback(
    (result: string[] | void, fallbackIds: string[]): string[] => {
      if (Array.isArray(result)) return result.length > 0 ? result : [];
      return fallbackIds;
    },
    [],
  );

  const expandUninsertedMapSiblingIds = useCallback(
    (itemIds: string[]): string[] => {
      const dayName = mapDayName || normalizeDisplayText(mapName);
      return expandSameSpacePriorityItemIds(itemIds, items, {
        dayName,
        excludedIds: new Set(executeModeItemIds),
        excludeSeedIdsFromSiblingExpansion: true,
      });
    },
    [executeModeItemIds, items, mapDayName, mapName],
  );

  const batchAddToHallVisitList = useCallback(
    (itemIds: string[]) => {
      let updatedHallVisitLists = [...hallRouteSettings.hallVisitLists];
      for (const itemId of itemIds) {
        const item = itemsById.get(itemId);
        if (!item) continue;
        const hallId = getItemHallId(item);
        if (!hallId) continue;
        const hallListIndex = updatedHallVisitLists.findIndex(
          (l) => l.hallId === hallId,
        );
        if (hallListIndex >= 0) {
          if (!updatedHallVisitLists[hallListIndex].itemIds.includes(itemId)) {
            updatedHallVisitLists[hallListIndex] = {
              ...updatedHallVisitLists[hallListIndex],
              itemIds: [
                ...updatedHallVisitLists[hallListIndex].itemIds,
                itemId,
              ],
            };
          }
        } else {
          updatedHallVisitLists.push({ hallId, itemIds: [itemId] });
        }
      }
      onUpdateHallRouteSettings({
        ...hallRouteSettings,
        hallVisitLists: updatedHallVisitLists,
      });
    },
    [itemsById, getItemHallId, hallRouteSettings, onUpdateHallRouteSettings],
  );

  const hallRouteSettingsRef = useRef(hallRouteSettings);
  useEffect(() => {
    hallRouteSettingsRef.current = hallRouteSettings;
  }, [hallRouteSettings]);

  const applyPendingHallVisitEntries = useCallback(
    (entries: PendingHallVisitEntry[]) => {
      const latestHallRouteSettings = hallRouteSettingsRef.current;
      let updatedHallVisitLists = [...latestHallRouteSettings.hallVisitLists];

      for (const { itemId, hallId } of entries) {
        if (!hallId) continue;
        const hallListIndex = updatedHallVisitLists.findIndex(
          (list) => list.hallId === hallId,
        );
        if (hallListIndex >= 0) {
          if (!updatedHallVisitLists[hallListIndex].itemIds.includes(itemId)) {
            updatedHallVisitLists[hallListIndex] = {
              ...updatedHallVisitLists[hallListIndex],
              itemIds: [
                ...updatedHallVisitLists[hallListIndex].itemIds,
                itemId,
              ],
            };
          }
        } else {
          updatedHallVisitLists.push({ hallId, itemIds: [itemId] });
        }
      }

      onUpdateHallRouteSettings({
        ...latestHallRouteSettings,
        hallVisitLists: updatedHallVisitLists,
      });
    },
    [onUpdateHallRouteSettings],
  );

  const tryStartMapRouteInsertSelection = useCallback(
    (itemIds: string[], representativeItem: ShoppingItem): boolean => {
      if (vertexSelectionMode || cellSelectionMode) return false;
      if (!hasValidSelectedHallRouteContext) return false;
      if (!routeResolutionMapData) return false;
      if (!mapInsertRoutePathfindingMapData) return false;
      if (mapInsertRoutePoints.length < 2) return false;
      if (mapInsertRouteSegments.length === 0) return false;

      const canInsertAtPosition =
        itemIds.length === 1
          ? Boolean(onAddToExecuteListAtPosition)
          : Boolean(onBatchAddToExecuteListAtPosition);
      if (!canInsertAtPosition) return false;

      const pendingResult = resolveMapRoutePoints({
        itemIds,
        items: mapRouteResolutionItems,
        mapData: routeResolutionMapData,
        hallDefinitions: halls,
        dayName: mapDayName || normalizeDisplayText(mapName),
        selectedHallId,
        orderOffset: mapInsertRoutePoints.length,
        requireCellInMap: selectedHallId !== "all" && halls.length > 0,
        respectManualHallMismatch: true,
      });
      if (pendingResult.missingItemIds.length > 0) return false;

      const existingRoutePointsAtStart = mapInsertRoutePoints.map((point) => ({
        ...point,
      }));
      const existingRouteSegmentsAtStart = mapInsertRouteSegments.map(
        (segment) => ({
          ...segment,
          path: segment.path.map((point) => ({ ...point })),
        }),
      );
      const pendingMapPointsAtStart = pendingResult.routePoints.map(
        (point) => ({ ...point }),
      );
      const validationPointsAtStart = [
        ...existingRoutePointsAtStart,
        ...pendingMapPointsAtStart,
      ];
      const pendingHallVisitEntriesAtStart = pendingMapPointsAtStart.map(
        (point) => ({
          itemId: point.itemId,
          hallId: point.hallId,
        }),
      );

      setPopupState((prev) => ({ ...prev, isOpen: false }));
      setInsertDialogState({ isOpen: false, item: null });
      setBatchInsertPendingIds(null);
      const routeInsertMapSnapshots = createRouteInsertMapSnapshots(
        filteredMapData,
        routeResolutionMapData,
      );
      const nextPending: MapRouteInsertPendingState = {
        itemIds: [...itemIds],
        representativeItem: { ...representativeItem },
        existingRoutePointsAtStart,
        existingRouteSegmentsAtStart,
        ...routeInsertMapSnapshots,
        pendingMapPoints: pendingMapPointsAtStart,
        validationPoints: validationPointsAtStart,
        pendingHallVisitEntries: pendingHallVisitEntriesAtStart,
        message: "ルート線または番号をクリックしてください",
        errorMessage: null,
        duplicateCandidates: [],
      };
      mapRouteInsertPendingRef.current = nextPending;
      setMapRouteInsertPending(nextPending);
      return true;
    },
    [
      vertexSelectionMode,
      cellSelectionMode,
      hasValidSelectedHallRouteContext,
      routeResolutionMapData,
      mapInsertRoutePathfindingMapData,
      mapInsertRoutePoints,
      mapInsertRouteSegments,
      onAddToExecuteListAtPosition,
      onBatchAddToExecuteListAtPosition,
      mapRouteResolutionItems,
      halls,
      mapDayName,
      mapName,
      selectedHallId,
      filteredMapData,
    ],
  );

  const handleAddToVisitList = useCallback(
    (itemId: string) => {
      const item = itemsById.get(itemId);
      if (!item) return;

      const newItemPrefix = extractNumberAlphaPrefix(item.number);
      if (newItemPrefix && onAddToExecuteListAtPosition) {
        const itemBlock = item.block?.trim() || "";
        let lastMatchId: string | null = null;

        executeModeItemIds.forEach((eid) => {
          const existingItem = itemsById.get(eid);
          if (!existingItem) return;
          const existingBlock = existingItem.block?.trim() || "";
          if (existingBlock !== itemBlock) return;
          const existingPrefix = extractNumberAlphaPrefix(existingItem.number);
          if (existingPrefix === newItemPrefix) {
            lastMatchId = eid;
          }
        });

        if (lastMatchId) {
          const insertedIds = normalizeInsertedItemIds(
            onAddToExecuteListAtPosition(itemId, lastMatchId, "after"),
            [itemId],
          );
          if (insertedIds) {
            batchAddToHallVisitList(insertedIds);
            return;
          }
          if (smartInsertEnabled && smartInsertMode === "map") {
            const pendingIds = expandUninsertedMapSiblingIds([itemId]);
            const started =
              pendingIds.length > 0 &&
              tryStartMapRouteInsertSelection(pendingIds, item);
            if (started) return;
          } else if (smartInsertEnabled && smartInsertMode === "preview") {
            setInsertDialogState({ isOpen: true, item });
            return;
          }
        }
      }

      const itemNum = extractNumberFromItemNumber(item.number);
      if (!itemNum) {
        const insertedIds = normalizeInsertedItemIds(
          onAddToExecuteList(itemId),
          [itemId],
        );
        if (insertedIds) batchAddToHallVisitList(insertedIds);
        return;
      }

      const numValue = parseInt(itemNum, 10);
      const itemBlock = item.block?.trim().toLowerCase() || "";

      if (smartInsertEnabled && smartInsertMode === "map") {
        const pendingIds = expandUninsertedMapSiblingIds([itemId]);
        const started =
          pendingIds.length > 0 &&
          tryStartMapRouteInsertSelection(pendingIds, item);
        if (started) return;
        const insertedIds = normalizeInsertedItemIds(
          onAddToExecuteList(itemId),
          [itemId],
        );
        if (insertedIds) batchAddToHallVisitList(insertedIds);
        return;
      }

      const nearbyVisitItems: { item: ShoppingItem; visitIndex: number }[] = [];
      executeModeItemIds.forEach((eid, idx) => {
        const existingItem = itemsById.get(eid);
        if (!existingItem) return;
        const existingBlock = existingItem.block?.trim().toLowerCase() || "";
        if (existingBlock !== itemBlock) return;
        const existingNum = extractNumberFromItemNumber(existingItem.number);
        if (!existingNum) return;
        const existingNumValue = parseInt(existingNum, 10);
        if (Math.abs(existingNumValue - numValue) <= 3) {
          nearbyVisitItems.push({ item: existingItem, visitIndex: idx });
        }
      });

      if (
        smartInsertMode !== "preview" ||
        nearbyVisitItems.length === 0 ||
        !onAddToExecuteListAtPosition ||
        !smartInsertEnabled
      ) {
        const insertedIds = normalizeInsertedItemIds(
          onAddToExecuteList(itemId),
          [itemId],
        );
        if (insertedIds) batchAddToHallVisitList(insertedIds);
        return;
      }
      setInsertDialogState({ isOpen: true, item });
    },
    [
      onAddToExecuteList,
      onAddToExecuteListAtPosition,
      itemsById,
      executeModeItemIds,
      batchAddToHallVisitList,
      normalizeInsertedItemIds,
      expandUninsertedMapSiblingIds,
      smartInsertEnabled,
      smartInsertMode,
      tryStartMapRouteInsertSelection,
    ],
  );

  const handleInsertPositionSelect = useCallback(
    (position: InsertPosition) => {
      const item = insertDialogState.item;
      if (!item) return;

      const isBatch =
        batchInsertPendingIds !== null && batchInsertPendingIds.length > 0;
      const idsToInsert = isBatch ? batchInsertPendingIds : [item.id];

      const addBatchNormally = () => {
        let insertedIds: string[] | null = null;
        if (onBatchAddToExecuteList) {
          insertedIds = normalizeInsertedItemIds(
            onBatchAddToExecuteList(idsToInsert),
            idsToInsert,
          );
        } else {
          const collectedIds: string[] = [];
          for (const id of idsToInsert) {
            const resultIds = normalizeInsertedItemIds(onAddToExecuteList(id), [
              id,
            ]);
            if (resultIds) collectedIds.push(...resultIds);
          }
          insertedIds = collectedIds.length > 0 ? collectedIds : null;
        }
        if (insertedIds) batchAddToHallVisitList(insertedIds);
        return insertedIds;
      };

      if (position.type === "before" || position.type === "after") {
        if (isBatch && onBatchAddToExecuteListAtPosition) {
          const insertedIds = normalizeInsertedItemIds(
            onBatchAddToExecuteListAtPosition(
              idsToInsert,
              position.referenceItemId,
              position.type,
            ),
            idsToInsert,
          );
          if (!insertedIds) return;
          batchAddToHallVisitList(insertedIds);
        } else if (isBatch) {
          if (!addBatchNormally()) return;
        } else if (onAddToExecuteListAtPosition) {
          let insertedIds: string[] | null = null;
          if (position.type === "before") {
            insertedIds = normalizeInsertedItemIds(
              onAddToExecuteListAtPosition(
                idsToInsert[0],
                position.referenceItemId,
                "before",
              ),
              [idsToInsert[0]],
            );
          } else {
            insertedIds = normalizeInsertedItemIds(
              onAddToExecuteListAtPosition(
                idsToInsert[0],
                position.referenceItemId,
                "after",
              ),
              [idsToInsert[0]],
            );
          }
          if (!insertedIds) return;
          batchAddToHallVisitList(insertedIds);
        } else {
          return;
        }
      } else {
        if (position.type === "listEnd") {
          if (isBatch && onBatchAddToExecuteListAtPosition) {
            const lastId =
              executeModeItemIds.length > 0
                ? executeModeItemIds[executeModeItemIds.length - 1]
                : null;
            if (lastId) {
              const insertedIds = normalizeInsertedItemIds(
                onBatchAddToExecuteListAtPosition(idsToInsert, lastId, "after"),
                idsToInsert,
              );
              if (!insertedIds) return;
              batchAddToHallVisitList(insertedIds);
            } else if (onBatchAddToExecuteList) {
              const insertedIds = normalizeInsertedItemIds(
                onBatchAddToExecuteList(idsToInsert),
                idsToInsert,
              );
              if (!insertedIds) return;
              batchAddToHallVisitList(insertedIds);
            } else {
              const collectedIds: string[] = [];
              for (const id of idsToInsert) {
                const insertedIds = normalizeInsertedItemIds(
                  onAddToExecuteList(id),
                  [id],
                );
                if (insertedIds) collectedIds.push(...insertedIds);
              }
              if (collectedIds.length === 0) return;
              batchAddToHallVisitList(collectedIds);
            }
          } else if (onAddToExecuteListAtPosition) {
            if (isBatch) {
              if (!addBatchNormally()) return;
              setBatchInsertPendingIds(null);
              setInsertDialogState({ isOpen: false, item: null });
              return;
            }
            let insertAfter =
              executeModeItemIds.length > 0
                ? executeModeItemIds[executeModeItemIds.length - 1]
                : null;
            const collectedIds: string[] = [];
            for (const id of idsToInsert) {
              if (insertAfter) {
                const insertedIds = normalizeInsertedItemIds(
                  onAddToExecuteListAtPosition(id, insertAfter, "after"),
                  [id],
                );
                if (!insertedIds) return;
                collectedIds.push(...insertedIds);
              } else {
                const insertedIds = normalizeInsertedItemIds(
                  onAddToExecuteList(id),
                  [id],
                );
                if (!insertedIds) return;
                collectedIds.push(...insertedIds);
              }
              insertAfter = id;
            }
            batchAddToHallVisitList(collectedIds);
          } else {
            const collectedIds: string[] = [];
            for (const id of idsToInsert) {
              const insertedIds = normalizeInsertedItemIds(
                onAddToExecuteList(id),
                [id],
              );
              if (insertedIds) collectedIds.push(...insertedIds);
            }
            if (collectedIds.length === 0) return;
            batchAddToHallVisitList(collectedIds);
          }
        } else {
          if (isBatch && onBatchAddToExecuteList) {
            const insertedIds = normalizeInsertedItemIds(
              onBatchAddToExecuteList(idsToInsert),
              idsToInsert,
            );
            if (!insertedIds) return;
            batchAddToHallVisitList(insertedIds);
          } else {
            const collectedIds: string[] = [];
            for (const id of idsToInsert) {
              const insertedIds = normalizeInsertedItemIds(
                onAddToExecuteList(id),
                [id],
              );
              if (insertedIds) collectedIds.push(...insertedIds);
            }
            if (collectedIds.length === 0) return;
            batchAddToHallVisitList(collectedIds);
          }
        }
      }

      setBatchInsertPendingIds(null);
      setInsertDialogState({ isOpen: false, item: null });
    },
    [
      insertDialogState.item,
      batchInsertPendingIds,
      onAddToExecuteList,
      onAddToExecuteListAtPosition,
      onBatchAddToExecuteList,
      onBatchAddToExecuteListAtPosition,
      executeModeItemIds,
      batchAddToHallVisitList,
      normalizeInsertedItemIds,
    ],
  );

  const insertDialogNearbyItems = useMemo(() => {
    const item = insertDialogState.item;
    if (!item) return [];

    const itemNum = extractNumberFromItemNumber(item.number);
    if (!itemNum) return [];

    const numValue = parseInt(itemNum, 10);
    const itemBlock = item.block?.trim().toLowerCase() || "";

    const result: { item: ShoppingItem; visitIndex: number }[] = [];
    executeModeItemIds.forEach((eid, idx) => {
      const existingItem = itemsById.get(eid);
      if (!existingItem) return;
      const existingBlock = existingItem.block?.trim().toLowerCase() || "";
      if (existingBlock !== itemBlock) return;
      const existingNum = extractNumberFromItemNumber(existingItem.number);
      if (!existingNum) return;
      const existingNumValue = parseInt(existingNum, 10);
      if (Math.abs(existingNumValue - numValue) <= 3) {
        result.push({ item: existingItem, visitIndex: idx });
      }
    });

    return result;
  }, [insertDialogState.item, itemsById, executeModeItemIds]);

  const insertDialogHasHall = useMemo(() => {
    const item = insertDialogState.item;
    if (!item) return false;
    return getHallCandidatesForItem(item).size > 0;
  }, [insertDialogState.item, getHallCandidatesForItem]);

  const insertDialogAllVisitItems = useMemo(() => {
    if (smartInsertMode !== "preview") return [];
    return executeModeItemIds
      .map((eid, idx) => {
        const item = itemsById.get(eid);
        return item ? { item, visitIndex: idx } : null;
      })
      .filter(
        (v): v is { item: ShoppingItem; visitIndex: number } => v !== null,
      );
  }, [smartInsertMode, executeModeItemIds, itemsById]);

  const handleRemoveFromVisitList = useCallback(
    (itemId: string) => {
      const removedIds = normalizeAffectedItemIds(
        onRemoveFromExecuteList(itemId),
        [itemId],
      );

      const updatedHallVisitLists = hallRouteSettings.hallVisitLists.map(
        (list) => ({
          ...list,
          itemIds: list.itemIds.filter((id) => !removedIds.includes(id)),
        }),
      );

      onUpdateHallRouteSettings({
        ...hallRouteSettings,
        hallVisitLists: updatedHallVisitLists,
      });
    },
    [
      onRemoveFromExecuteList,
      hallRouteSettings,
      onUpdateHallRouteSettings,
      normalizeAffectedItemIds,
    ],
  );

  const handleBatchAddToVisitList = useCallback(
    (itemIds: string[]) => {
      if (itemIds.length === 0) return;

      const sortedIds = [...itemIds].sort((aId, bId) => {
        const a = itemsById.get(aId);
        const b = itemsById.get(bId);
        if (!a || !b) return 0;
        const suffixA = a.number.replace(/^\d+/, "");
        const suffixB = b.number.replace(/^\d+/, "");
        const parseA = suffixA.match(/^([a-zA-Z]*)(\d*)$/);
        const parseB = suffixB.match(/^([a-zA-Z]*)(\d*)$/);
        const alphaA = parseA ? parseA[1].toLowerCase() : "";
        const alphaB = parseB ? parseB[1].toLowerCase() : "";
        if (alphaA !== alphaB) return alphaA.localeCompare(alphaB);
        const numA = parseA && parseA[2] ? parseInt(parseA[2], 10) : 0;
        const numB = parseB && parseB[2] ? parseInt(parseB[2], 10) : 0;
        return numA - numB;
      });

      const firstItem = itemsById.get(sortedIds[0]);
      if (!firstItem) return;

      const newItemPrefix = extractNumberAlphaPrefix(firstItem.number);
      const itemBlock = firstItem.block?.trim() || "";

      if (newItemPrefix && onBatchAddToExecuteListAtPosition) {
        let lastMatchId: string | null = null;
        executeModeItemIds.forEach((eid) => {
          const existingItem = itemsById.get(eid);
          if (!existingItem) return;
          const existingBlock = existingItem.block?.trim() || "";
          if (existingBlock !== itemBlock) return;
          const existingPrefix = extractNumberAlphaPrefix(existingItem.number);
          if (existingPrefix === newItemPrefix) {
            lastMatchId = eid;
          }
        });

        if (lastMatchId) {
          const insertedIds = normalizeInsertedItemIds(
            onBatchAddToExecuteListAtPosition(sortedIds, lastMatchId, "after"),
            sortedIds,
          );
          if (insertedIds) {
            batchAddToHallVisitList(insertedIds);
            return;
          }
        }
      }

      if (smartInsertEnabled && smartInsertMode === "map") {
        const pendingIds = expandUninsertedMapSiblingIds(sortedIds);
        const started =
          pendingIds.length > 0 &&
          tryStartMapRouteInsertSelection(pendingIds, firstItem);
        if (started) return;

        if (onBatchAddToExecuteList) {
          const insertedIds = normalizeInsertedItemIds(
            onBatchAddToExecuteList(sortedIds),
            sortedIds,
          );
          if (insertedIds) batchAddToHallVisitList(insertedIds);
        } else {
          const collectedIds: string[] = [];
          for (const id of sortedIds) {
            const insertedIds = normalizeInsertedItemIds(
              onAddToExecuteList(id),
              [id],
            );
            if (insertedIds) collectedIds.push(...insertedIds);
          }
          if (collectedIds.length > 0) batchAddToHallVisitList(collectedIds);
        }
        return;
      }

      const itemNum = extractNumberFromItemNumber(firstItem.number);
      if (itemNum && smartInsertEnabled && smartInsertMode === "preview") {
        const numValue = parseInt(itemNum, 10);
        const itemBlockLower = itemBlock.toLowerCase();
        const nearbyVisitItems: { item: ShoppingItem; visitIndex: number }[] =
          [];
        executeModeItemIds.forEach((eid, idx) => {
          const existingItem = itemsById.get(eid);
          if (!existingItem) return;
          const existingBlock = existingItem.block?.trim().toLowerCase() || "";
          if (existingBlock !== itemBlockLower) return;
          const existingNum = extractNumberFromItemNumber(existingItem.number);
          if (!existingNum) return;
          const existingNumValue = parseInt(existingNum, 10);
          if (Math.abs(existingNumValue - numValue) <= 3) {
            nearbyVisitItems.push({ item: existingItem, visitIndex: idx });
          }
        });

        if (nearbyVisitItems.length > 0) {
          setBatchInsertPendingIds(sortedIds);
          setInsertDialogState({ isOpen: true, item: firstItem });
          return;
        }
      }

      if (onBatchAddToExecuteList) {
        const insertedIds = normalizeInsertedItemIds(
          onBatchAddToExecuteList(sortedIds),
          sortedIds,
        );
        if (insertedIds) batchAddToHallVisitList(insertedIds);
      } else {
        const collectedIds: string[] = [];
        for (const id of sortedIds) {
          const insertedIds = normalizeInsertedItemIds(onAddToExecuteList(id), [
            id,
          ]);
          if (insertedIds) collectedIds.push(...insertedIds);
        }
        if (collectedIds.length > 0) batchAddToHallVisitList(collectedIds);
      }
    },
    [
      itemsById,
      executeModeItemIds,
      onAddToExecuteList,
      onAddToExecuteListAtPosition,
      onBatchAddToExecuteList,
      onBatchAddToExecuteListAtPosition,
      batchAddToHallVisitList,
      normalizeInsertedItemIds,
      expandUninsertedMapSiblingIds,
      smartInsertEnabled,
      smartInsertMode,
      tryStartMapRouteInsertSelection,
    ],
  );

  const handleBatchRemoveFromVisitList = useCallback(
    (itemIds: string[]) => {
      const removedIds = onBatchRemoveFromExecuteList
        ? normalizeAffectedItemIds(
            onBatchRemoveFromExecuteList(itemIds),
            itemIds,
          )
        : itemIds.flatMap((id) =>
            normalizeAffectedItemIds(onRemoveFromExecuteList(id), [id]),
          );
      const removedSet = new Set(removedIds);
      const updatedHallVisitLists = hallRouteSettings.hallVisitLists.map(
        (list) => ({
          ...list,
          itemIds: list.itemIds.filter((id) => !removedSet.has(id)),
        }),
      );
      onUpdateHallRouteSettings({
        ...hallRouteSettings,
        hallVisitLists: updatedHallVisitLists,
      });
    },
    [
      onRemoveFromExecuteList,
      onBatchRemoveFromExecuteList,
      hallRouteSettings,
      onUpdateHallRouteSettings,
      normalizeAffectedItemIds,
    ],
  );

  const handleJumpToCell = useCallback((_row: number, _col: number) => {
    void _row;
    void _col;
    setIsVisitListOpen(false);
  }, []);

  const insertPendingItemsAfterAnchor = useCallback(
    (itemIds: string[], anchorItemId: string): boolean => {
      if (itemIds.length > 1) {
        if (!onBatchAddToExecuteListAtPosition) return false;
        return (
          normalizeInsertedItemIds(
            onBatchAddToExecuteListAtPosition(itemIds, anchorItemId, "after"),
            itemIds,
          ) !== null
        );
      }

      const itemId = itemIds[0];
      if (!itemId || !onAddToExecuteListAtPosition) return false;
      return (
        normalizeInsertedItemIds(
          onAddToExecuteListAtPosition(itemId, anchorItemId, "after"),
          [itemId],
        ) !== null
      );
    },
    [
      normalizeInsertedItemIds,
      onAddToExecuteListAtPosition,
      onBatchAddToExecuteListAtPosition,
    ],
  );

  const applyMapRouteInsertAfter = useCallback(
    (anchorItemId: string) => {
      const pending = mapRouteInsertPendingRef.current;
      if (!pending) return;

      if (!executeModeItemIds.includes(anchorItemId)) {
        setMapRouteInsertPending((prev) =>
          prev
            ? {
                ...prev,
                errorMessage:
                  "選択した基準アイテムが現在の実行リストにありません。別のルート線または番号を選んでください。",
                duplicateCandidates: [],
              }
            : prev,
        );
        return;
      }

      const alreadyInsertedPendingIds = pending.itemIds.filter((id) =>
        executeModeItemIds.includes(id),
      );
      if (alreadyInsertedPendingIds.length > 0) {
        setMapRouteInsertPending((prev) =>
          prev
            ? {
                ...prev,
                errorMessage:
                  "追加対象が現在の実行リストに既にあります。キャンセルして最新の状態からやり直してください。",
                duplicateCandidates: [],
              }
            : prev,
        );
        return;
      }

      const validation = validateMapSmartInsert({
        anchorItemId,
        pendingItemIds: pending.itemIds,
        routePoints: pending.validationPoints,
      });
      if (!validation.ok) {
        setMapRouteInsertPending((prev) =>
          prev
            ? {
                ...prev,
                errorMessage: validation.message,
                duplicateCandidates: [],
              }
            : prev,
        );
        return;
      }

      const inserted = insertPendingItemsAfterAnchor(
        pending.itemIds,
        anchorItemId,
      );
      if (!inserted) {
        setMapRouteInsertPending((prev) =>
          prev
            ? {
                ...prev,
                errorMessage:
                  "位置指定追加が現在利用できません。キャンセルして最新の状態からやり直してください。",
                duplicateCandidates: [],
              }
            : prev,
        );
        return;
      }

      applyPendingHallVisitEntries(pending.pendingHallVisitEntries);
      mapRouteInsertPendingRef.current = null;
      setMapRouteInsertPending(null);
    },
    [
      applyPendingHallVisitEntries,
      executeModeItemIds,
      insertPendingItemsAfterAnchor,
    ],
  );

  const buildDuplicateAnchorCandidates = useCallback(
    (
      hitCandidates: Array<{ itemId: string; order: number }>,
      routePointsAtStart: MapRoutePoint[],
    ): RouteInsertAnchorCandidate[] => {
      const pointByItemId = new Map(
        routePointsAtStart.map((point) => [point.itemId, point]),
      );
      return hitCandidates.map((candidate) => {
        const point = pointByItemId.get(candidate.itemId);
        return {
          itemId: candidate.itemId,
          order: candidate.order,
          label:
            point?.anchorLabel ??
            `${candidate.order + 1}. ${candidate.itemId} の後`,
        };
      });
    },
    [],
  );

  const handleRouteInsertHit = useCallback(
    (hit: MapRouteHitResult) => {
      if (!mapRouteInsertPendingRef.current) return;

      if (hit.type === "marker" && hit.duplicateCandidates.length > 1) {
        setMapRouteInsertPending((prev) =>
          prev
            ? {
                ...prev,
                errorMessage: null,
                duplicateCandidates: buildDuplicateAnchorCandidates(
                  hit.duplicateCandidates,
                  prev.existingRoutePointsAtStart,
                ),
              }
            : prev,
        );
        return;
      }

      applyMapRouteInsertAfter(
        hit.type === "marker" ? hit.itemId : hit.fromItemId,
      );
    },
    [applyMapRouteInsertAfter, buildDuplicateAnchorCandidates],
  );

  const handleRouteInsertMiss = useCallback(
    (miss: { kind: "cell" | "blank" }) => {
      if (miss.kind === "blank") return;

      setMapRouteInsertPending((prev) =>
        prev
          ? {
              ...prev,
              errorMessage: null,
              duplicateCandidates: [],
              message: "ルート線または番号をクリックしてください",
            }
          : prev,
      );
    },
    [],
  );

  const cancelMapRouteInsertSelection = useCallback(() => {
    mapRouteInsertPendingRef.current = null;
    setMapRouteInsertPending(null);
  }, []);

  const routePointsForCanvas =
    mapRouteInsertPending?.existingRoutePointsAtStart ?? displayRoutePoints;
  const routeSegmentsForCanvas =
    mapRouteInsertPending?.existingRouteSegmentsAtStart ?? displayRouteSegments;
  const mapDataForCanvas =
    mapRouteInsertPending?.canvasMapDataAtStart ?? filteredMapData;
  const routeInsertMissMapDataForCanvas =
    mapRouteInsertPending?.routeInsertMissMapDataAtStart;

  return (
    <div
      className="relative bg-slate-100 dark:bg-slate-900 overflow-hidden"
      style={{ height: "calc(100vh - 140px)" }}
    >
      {/* Top-right controls: hall selection, hall order, route visibility. */}
      {!hideInternalControls && (
        <div className="absolute top-4 right-4 z-10 flex items-center gap-3">
          {halls.length > 0 && (
            <select
              value={selectedHallId}
              onChange={(e) => setSelectedHallId(e.target.value)}
              className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">全ホール</option>
              {halls.map((hall) => (
                <option key={hall.id} value={hall.id}>
                  {hall.name} ({getHallTotalExecuteCount(hall.id)}/
                  {getTotalItemCountInHall(hall.id)}件)
                </option>
              ))}
            </select>
          )}
          {halls.length > 0 && (
            <button
              onClick={() => setIsHallOrderOpen(true)}
              className="bg-white dark:bg-slate-800 px-3 py-2 rounded-lg shadow-md border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700"
            >
              ホール順序
            </button>
          )}
          <label className="flex items-center gap-2 bg-white dark:bg-slate-800 px-3 py-2 rounded-lg shadow-md border border-slate-200 dark:border-slate-700">
            <span className="text-sm text-slate-700 dark:text-slate-300">
              ルート表示
            </span>
            <button
              onClick={() => setIsRouteVisible(!isRouteVisible)}
              className={`relative w-10 h-5 rounded-full transition-colors ${
                isRouteVisible
                  ? "bg-blue-500"
                  : "bg-slate-300 dark:bg-slate-600"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${
                  isRouteVisible ? "translate-x-5" : ""
                }`}
              />
            </button>
          </label>
        </div>
      )}
      <div className="absolute bottom-4 left-4 z-10">
        <div className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-2 text-sm shadow-md text-slate-700 dark:text-slate-300 select-none">
          {zoomLevel}%
        </div>
      </div>
      {mapRouteInsertPending && (
        <div className="absolute left-4 top-4 z-20 max-w-sm rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-800">
          <div className="font-medium text-slate-900 dark:text-slate-100">
            {mapRouteInsertPending.message}
          </div>
          {mapRouteInsertPending.errorMessage && (
            <div className="mt-2 text-red-600 dark:text-red-400">
              {mapRouteInsertPending.errorMessage}
            </div>
          )}
          <button
            type="button"
            onClick={cancelMapRouteInsertSelection}
            className="mt-3 rounded bg-slate-100 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200"
          >
            キャンセル
          </button>
        </div>
      )}
      {mapRouteInsertPending &&
        mapRouteInsertPending.duplicateCandidates.length > 0 && (
          <div className="absolute left-4 top-28 z-20 max-w-sm rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-800">
            {mapRouteInsertPending.duplicateCandidates.map((candidate) => (
              <button
                key={`${candidate.itemId}-${candidate.order}`}
                type="button"
                onClick={() => applyMapRouteInsertAfter(candidate.itemId)}
                className="block w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {candidate.label}
              </button>
            ))}
          </div>
        )}
      {/* Map canvas */}
      <MapCanvas
        mapData={mapDataForCanvas}
        mapName={mapName}
        items={filteredItems}
        executeModeItemIds={routeExecuteModeItemIds}
        zoomLevel={zoomLevel}
        isRouteVisible={
          isRouteVisible && (halls.length === 0 || selectedHallId !== "all")
        }
        routePointsOverride={routePointsForCanvas}
        routeSegmentsOverride={routeSegmentsForCanvas}
        routeInsertMissMapDataOverride={routeInsertMissMapDataForCanvas}
        forceRouteVisible={mapRouteInsertPending !== null}
        routeInsertSelectionActive={mapRouteInsertPending !== null}
        onRouteInsertHit={handleRouteInsertHit}
        onRouteInsertMiss={handleRouteInsertMiss}
        onCellClick={handleCellClick}
        selectedHall={
          selectedHallId !== "all"
            ? halls.find((h) => h.id === selectedHallId)
            : undefined
        }
        vertexSelectionMode={vertexSelectionMode}
        cellSelectionMode={cellSelectionMode}
        highlightedCell={highlightedCell}
        onZoomChange={setZoomLevel}
        rotationAngle={rotationAngle}
        onRotationAngleChange={onRotationAngleChange}
        selectionGuideOptions={selectionGuideOptions}
        initialOffset={
          initialViewport
            ? { x: initialViewport.offsetX, y: initialViewport.offsetY }
            : undefined
        }
        offsetRef={canvasOffsetRef}
        numberCellOutlineStyle={numberCellOutlineStyle}
      />
      {/* Cell detail popup */}
      <CellItemsPopup
        isOpen={popupState.isOpen}
        onClose={handleClosePopup}
        blockName={popupState.blockName}
        number={popupState.number}
        items={popupState.items}
        executeModeItemIds={executeModeItemIdsSet}
        onAddToVisitList={handleAddToVisitList}
        onRemoveFromVisitList={handleRemoveFromVisitList}
        onBatchAddToVisitList={handleBatchAddToVisitList}
        onBatchRemoveFromVisitList={handleBatchRemoveFromVisitList}
        onUpdateItem={onUpdateItem}
        onUpdateItemPriority={onUpdateItemPriority}
        onDeleteItem={onDeleteItem}
        onAddItem={onAddItem}
        onEditRequest={onEditRequest}
        eventDate={mapDayName || normalizeDisplayText(mapName)}
        position={popupState.position}
      />
      {/* Visit list panel */}
      <MapVisitListPanel
        isOpen={isVisitListOpen}
        onClose={() => setIsVisitListOpen(false)}
        items={filteredItems}
        executeModeItemIds={routeExecuteModeItemIds}
        blocks={filteredMapData.blocks}
        onJumpToCell={handleJumpToCell}
      />
      {/* Hall order settings panel */}
      <HallOrderPanel
        isOpen={isHallOrderOpen}
        onClose={() => setIsHallOrderOpen(false)}
        halls={halls}
        hallRouteSettings={hallRouteSettings}
        onUpdateHallRouteSettings={onUpdateHallRouteSettings}
        getItemCountInHall={getItemCountInHall}
        onReorderExecuteList={onReorderExecuteList}
      />
      {insertDialogState.item && (
        <InsertPositionDialog
          isOpen={insertDialogState.isOpen}
          addingItem={insertDialogState.item}
          nearbyVisitItems={insertDialogNearbyItems}
          allVisitItems={insertDialogAllVisitItems}
          hasHallDefinition={insertDialogHasHall}
          onSelect={handleInsertPositionSelect}
          onCancel={() => {
            setBatchInsertPendingIds(null);
            setInsertDialogState({ isOpen: false, item: null });
          }}
        />
      )}
    </div>
  );
};

export default React.memo(MapView);
