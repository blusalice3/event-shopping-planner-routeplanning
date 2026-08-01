import { useCallback, useState } from "react";
import {
  resolveRangeSelection,
  toggleRangeSelection,
  type RangeEndpoint,
  type RangePresentation,
} from "../domain/rangeSelection";

export type ListRangeSelection = RangeEndpoint | null;

const isSameEndpoint = (
  endpoint: RangeEndpoint | null,
  candidate: RangeEndpoint,
): boolean => {
  if (!endpoint) return false;
  if (endpoint.kind === "item" && candidate.kind === "item") {
    return endpoint.itemId === candidate.itemId;
  }
  if (endpoint.kind === "group" && candidate.kind === "group") {
    return endpoint.groupKey === candidate.groupKey;
  }
  return false;
};

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

  const clearRangeSelection = useCallback(() => {
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
    (itemId: string, presentation: RangePresentation) => {
      const endpoint: RangeEndpoint = {
        kind: "item",
        itemId,
        scopeKey: presentation.scopeKey,
      };

      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        const wasSelected = next.has(itemId);

        if (wasSelected) {
          next.delete(itemId);
          if (isSameEndpoint(rangeStart, endpoint)) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (isSameEndpoint(rangeEnd, endpoint)) {
            setRangeEnd(null);
          }
          return next;
        }

        next.add(itemId);

        if (
          !rangeStart ||
          rangeStart.scopeKey !== presentation.scopeKey ||
          rangeStart.kind !== endpoint.kind
        ) {
          setRangeStart(endpoint);
          setRangeEnd(null);
          return next;
        }

        const resolution = resolveRangeSelection(
          presentation,
          rangeStart,
          endpoint,
        );
        if (resolution.valid) {
          setRangeEnd(endpoint);
        } else if (
          resolution.reason === "adjacent" ||
          resolution.reason === "same-endpoint"
        ) {
          setRangeEnd(null);
        } else {
          setRangeStart(endpoint);
          setRangeEnd(null);
        }

        return next;
      });
    },
    [rangeEnd, rangeStart],
  );

  const selectSpaceGroupForRange = useCallback(
    (
      groupKey: string,
      allItemIds: readonly string[],
      presentation: RangePresentation,
    ) => {
      const endpoint: RangeEndpoint = {
        kind: "group",
        groupKey,
        scopeKey: presentation.scopeKey,
      };

      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        const allSelected = allItemIds.every((id) => next.has(id));

        if (allSelected) {
          allItemIds.forEach((id) => next.delete(id));
          if (isSameEndpoint(rangeStart, endpoint)) {
            setRangeStart(null);
            setRangeEnd(null);
          } else if (isSameEndpoint(rangeEnd, endpoint)) {
            setRangeEnd(null);
          }
          return next;
        }

        allItemIds.forEach((id) => next.add(id));

        if (
          !rangeStart ||
          rangeStart.scopeKey !== presentation.scopeKey ||
          rangeStart.kind !== endpoint.kind
        ) {
          setRangeStart(endpoint);
          setRangeEnd(null);
          return next;
        }

        const resolution = resolveRangeSelection(
          presentation,
          rangeStart,
          endpoint,
        );
        if (resolution.valid) {
          setRangeEnd(endpoint);
        } else if (
          resolution.reason === "adjacent" ||
          resolution.reason === "same-endpoint"
        ) {
          setRangeEnd(null);
        } else {
          setRangeStart(endpoint);
          setRangeEnd(null);
        }

        return next;
      });
    },
    [rangeEnd, rangeStart],
  );

  const toggleRangeItemIdsSelection = useCallback(
    (rangeItemIds: readonly string[]) => {
      setSelectedItemIds((prev) => {
        const result = toggleRangeSelection(prev, rangeItemIds);
        if (result.operation === "deselect") {
          clearRangeSelection();
        }
        return result.selectedItemIds;
      });
    },
    [clearRangeSelection],
  );

  return {
    selectedItemIds,
    selectedBlockFilters,
    setSelectedBlockFilters,
    rangeStart,
    rangeEnd,
    spaceGroupingEnabled,
    setSpaceGroupingEnabled,
    collapsedSpaces,
    setCollapsedSpaces,
    executeSpaceGroupingEnabled,
    setExecuteSpaceGroupingEnabled,
    executeCollapsedSpaces,
    setExecuteCollapsedSpaces,
    clearSelection,
    clearRangeSelection,
    clearBlockFilters,
    toggleBlockFilter,
    toggleCollapsedSpace,
    toggleExecuteCollapsedSpace,
    selectItemForRange,
    selectSpaceGroupForRange,
    toggleRangeItemIdsSelection,
  };
};
