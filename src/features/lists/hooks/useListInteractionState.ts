import { useCallback, useState } from "react";
import type { DayMapData, HallDefinition } from "../../../types/map";
import type { ShoppingItem } from "../../../types/item";
import { buildGroupId, getHallIdForItem } from "../../../utils/hallGrouping";
import { getSpaceKey } from "../../../utils/spaceGrouping";

export type ListColumnType = "execute" | "candidate";

export type ListRangeSelection = {
  itemId: string;
  columnType: ListColumnType;
  sourceType?: "item" | "spaceHeader";
} | null;

export const useListInteractionState = () => {
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    new Set(),
  );
  const [selectedBlockFilters, setSelectedBlockFilters] = useState<Set<string>>(
    new Set(),
  );
  const [rangeStart, setRangeStart] = useState<ListRangeSelection>(null);
  const [rangeEnd, setRangeEnd] = useState<ListRangeSelection>(null);
  const [spaceGroupingEnabled, setSpaceGroupingEnabled] = useState(false);
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(
    new Set(),
  );
  const [executeSpaceGroupingEnabled, setExecuteSpaceGroupingEnabled] =
    useState(true);
  const [executeCollapsedSpaces, setExecuteCollapsedSpaces] = useState<
    Set<string>
  >(new Set());

  const clearSelection = useCallback(() => {
    setSelectedItemIds(new Set());
    setRangeStart(null);
    setRangeEnd(null);
  }, []);

  const clearBlockFilters = useCallback(() => {
    setSelectedBlockFilters(new Set());
  }, []);

  const toggleBlockFilter = useCallback((block: string) => {
    setSelectedBlockFilters((prev) => {
      const next = new Set(prev);
      if (next.has(block)) {
        next.delete(block);
      } else {
        next.add(block);
      }
      return next;
    });
  }, []);

  const toggleCollapsedSpace = useCallback((spaceKey: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceKey)) {
        next.delete(spaceKey);
      } else {
        next.add(spaceKey);
      }
      return next;
    });
  }, []);

  const toggleExecuteCollapsedSpace = useCallback((spaceKey: string) => {
    setExecuteCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceKey)) {
        next.delete(spaceKey);
      } else {
        next.add(spaceKey);
      }
      return next;
    });
  }, []);

  const selectItemForRange = useCallback(
    (
      itemId: string,
      columnType: ListColumnType,
      currentItems: ShoppingItem[],
    ) => {
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        const wasSelected = next.has(itemId);

        if (wasSelected) {
          next.delete(itemId);
          if (
            rangeStart?.itemId === itemId &&
            rangeStart.columnType === columnType
          ) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (
            rangeEnd?.itemId === itemId &&
            rangeEnd.columnType === columnType
          ) {
            setRangeEnd(null);
          }
          return next;
        }

        next.add(itemId);

        if (
          !rangeStart ||
          rangeStart.columnType !== columnType ||
          rangeStart.sourceType === "spaceHeader"
        ) {
          setRangeStart({ itemId, columnType, sourceType: "item" });
          setRangeEnd(null);
          return next;
        }

        const startIndex = currentItems.findIndex(
          (item) => item.id === rangeStart.itemId,
        );
        const currentIndex = currentItems.findIndex(
          (item) => item.id === itemId,
        );
        if (startIndex !== -1 && currentIndex !== -1) {
          const isAdjacent = Math.abs(startIndex - currentIndex) === 1;
          setRangeEnd(
            isAdjacent ? null : { itemId, columnType, sourceType: "item" },
          );
        }

        return next;
      });
    },
    [rangeEnd, rangeStart],
  );

  const selectSpaceGroupForRange = useCallback(
    (
      firstItemId: string,
      allItemIds: string[],
      columnType: ListColumnType,
      currentItems: ShoppingItem[],
    ) => {
      const groupOrder: string[] = [];
      const groupFirstItemMap = new Map<string, string>();

      for (const item of currentItems) {
        const key = getSpaceKey(item.block, item.number);
        if (!groupFirstItemMap.has(key)) {
          groupOrder.push(key);
          groupFirstItemMap.set(key, item.id);
        }
      }

      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        const allSelected = allItemIds.every((id) => next.has(id));

        if (allSelected) {
          allItemIds.forEach((id) => next.delete(id));
          if (rangeStart && allItemIds.includes(rangeStart.itemId)) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (rangeEnd && allItemIds.includes(rangeEnd.itemId)) {
            setRangeEnd(null);
          }
          return next;
        }

        allItemIds.forEach((id) => next.add(id));

        if (
          !rangeStart ||
          rangeStart.columnType !== columnType ||
          rangeStart.sourceType === "item"
        ) {
          setRangeStart({
            itemId: firstItemId,
            columnType,
            sourceType: "spaceHeader",
          });
          setRangeEnd(null);
          return next;
        }

        const startItem = currentItems.find(
          (item) => item.id === rangeStart.itemId,
        );
        const currentItem = currentItems.find(
          (item) => item.id === firstItemId,
        );
        const startKey = startItem
          ? getSpaceKey(startItem.block, startItem.number)
          : null;
        const currentKey = currentItem
          ? getSpaceKey(currentItem.block, currentItem.number)
          : null;

        if (startKey && currentKey) {
          const startGroupIdx = groupOrder.indexOf(startKey);
          const currentGroupIdx = groupOrder.indexOf(currentKey);
          const isAdjacent =
            startGroupIdx !== -1 &&
            currentGroupIdx !== -1 &&
            Math.abs(startGroupIdx - currentGroupIdx) === 1;
          setRangeEnd(
            isAdjacent
              ? null
              : { itemId: firstItemId, columnType, sourceType: "spaceHeader" },
          );
        } else {
          setRangeEnd({
            itemId: firstItemId,
            columnType,
            sourceType: "spaceHeader",
          });
        }

        return next;
      });
    },
    [rangeEnd, rangeStart],
  );

  const toggleRangeItemsSelection = useCallback(
    (rangeItems: ShoppingItem[]) => {
      setSelectedItemIds((prev) => {
        const allSelected = rangeItems.every((item) => prev.has(item.id));
        const next = new Set(prev);
        if (allSelected) {
          rangeItems.forEach((item) => next.delete(item.id));
          setRangeStart(null);
          setRangeEnd(null);
        } else {
          rangeItems.forEach((item) => next.add(item.id));
        }
        return next;
      });
    },
    [],
  );

  const toggleCurrentRangeSelection = useCallback(
    (
      columnType: ListColumnType,
      currentItems: ShoppingItem[],
      options: {
        halls: HallDefinition[];
        currentMapData: DayMapData | null;
      },
    ) => {
      if (
        !rangeStart ||
        rangeStart.columnType !== columnType ||
        !rangeEnd ||
        rangeEnd.columnType !== columnType
      ) {
        return;
      }

      if (spaceGroupingEnabled) {
        const startItem = currentItems.find(
          (item) => item.id === rangeStart.itemId,
        );
        const endItem = currentItems.find(
          (item) => item.id === rangeEnd.itemId,
        );
        if (!startItem || !endItem) return;

        const startKey = getSpaceKey(startItem.block, startItem.number);
        const endKey = getSpaceKey(endItem.block, endItem.number);
        let rangeItems: ShoppingItem[];

        if (startKey === endKey) {
          const groupItems = currentItems.filter(
            (item) => getSpaceKey(item.block, item.number) === startKey,
          );
          const startIndex = groupItems.findIndex(
            (item) => item.id === rangeStart.itemId,
          );
          const endIndex = groupItems.findIndex(
            (item) => item.id === rangeEnd.itemId,
          );
          if (startIndex === -1 || endIndex === -1) return;
          rangeItems = groupItems.slice(
            Math.min(startIndex, endIndex),
            Math.max(startIndex, endIndex) + 1,
          );
        } else {
          const groupOrder: string[] = [];
          for (const item of currentItems) {
            const key = getSpaceKey(item.block, item.number);
            if (!groupOrder.includes(key)) {
              groupOrder.push(key);
            }
          }
          const startGrpIdx = groupOrder.indexOf(startKey);
          const endGrpIdx = groupOrder.indexOf(endKey);
          if (startGrpIdx === -1 || endGrpIdx === -1) return;
          const rangeSpaceKeys = new Set(
            groupOrder.slice(
              Math.min(startGrpIdx, endGrpIdx),
              Math.max(startGrpIdx, endGrpIdx) + 1,
            ),
          );
          rangeItems = currentItems.filter((item) =>
            rangeSpaceKeys.has(getSpaceKey(item.block, item.number)),
          );
        }

        toggleRangeItemsSelection(rangeItems);
        return;
      }

      const { halls, currentMapData } = options;
      if (halls.length > 0) {
        const getItemGroupId = (item: ShoppingItem): string | null =>
          buildGroupId(
            getHallIdForItem(item, currentMapData ?? null, halls),
            item.priorityLevel || "none",
          );

        const startItem = currentItems.find(
          (item) => item.id === rangeStart.itemId,
        );
        const endItem = currentItems.find(
          (item) => item.id === rangeEnd.itemId,
        );
        if (!startItem || !endItem) return;

        const startGroupId = getItemGroupId(startItem);
        const endGroupId = getItemGroupId(endItem);
        if (startGroupId !== endGroupId) return;

        const groupItems = currentItems.filter(
          (item) => getItemGroupId(item) === startGroupId,
        );
        const startIndex = groupItems.findIndex(
          (item) => item.id === rangeStart.itemId,
        );
        const endIndex = groupItems.findIndex(
          (item) => item.id === rangeEnd.itemId,
        );
        if (startIndex === -1 || endIndex === -1) return;

        toggleRangeItemsSelection(
          groupItems.slice(
            Math.min(startIndex, endIndex),
            Math.max(startIndex, endIndex) + 1,
          ),
        );
        return;
      }

      const startIndex = currentItems.findIndex(
        (item) => item.id === rangeStart.itemId,
      );
      const endIndex = currentItems.findIndex(
        (item) => item.id === rangeEnd.itemId,
      );
      if (startIndex === -1 || endIndex === -1) return;

      toggleRangeItemsSelection(
        currentItems.slice(
          Math.min(startIndex, endIndex),
          Math.max(startIndex, endIndex) + 1,
        ),
      );
    },
    [rangeEnd, rangeStart, spaceGroupingEnabled, toggleRangeItemsSelection],
  );

  return {
    selectedItemIds,
    setSelectedItemIds,
    selectedBlockFilters,
    setSelectedBlockFilters,
    rangeStart,
    setRangeStart,
    rangeEnd,
    setRangeEnd,
    spaceGroupingEnabled,
    setSpaceGroupingEnabled,
    collapsedSpaces,
    setCollapsedSpaces,
    executeSpaceGroupingEnabled,
    setExecuteSpaceGroupingEnabled,
    executeCollapsedSpaces,
    setExecuteCollapsedSpaces,
    clearSelection,
    clearBlockFilters,
    toggleBlockFilter,
    toggleCollapsedSpace,
    toggleExecuteCollapsedSpace,
    selectItemForRange,
    selectSpaceGroupForRange,
    toggleRangeItemsSelection,
    toggleCurrentRangeSelection,
  };
};
