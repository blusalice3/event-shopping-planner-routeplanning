import { useState, useMemo, useEffect, useCallback } from 'react';
import { ShoppingItem, ViewMode, DayModeState } from '../types';

export function useSearch(
  activeEventName: string | null,
  activeTab: string,
  eventDates: string[],
  currentTabItems: ShoppingItem[],
  visibleItems: ShoppingItem[],
  executeColumnItems: ShoppingItem[],
  candidateColumnItems: ShoppingItem[],
  dayModes: Record<string, DayModeState>,
) {
  const [searchKeyword, setSearchKeyword] = useState('');
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);

  // Search matches across all items in current tab
  const searchMatches = useMemo(() => {
    if (!searchKeyword.trim() || !activeEventName || !eventDates.includes(activeTab)) {
      return [];
    }

    const keyword = searchKeyword.trim().toLowerCase();
    const matches: string[] = [];

    currentTabItems.forEach(item => {
      const circleMatch = item.circle.toLowerCase().includes(keyword);
      const titleMatch = item.title.toLowerCase().includes(keyword);
      const remarksMatch = item.remarks.toLowerCase().includes(keyword);

      if (circleMatch || titleMatch || remarksMatch) {
        matches.push(item.id);
      }
    });

    return matches;
  }, [searchKeyword, activeEventName, activeTab, currentTabItems, eventDates]);

  // Filter to only visible items
  const visibleSearchMatches = useMemo(() => {
    if (searchMatches.length === 0) return [];

    const currentEventDate = eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '');
    const mode = dayModes[activeEventName || '']?.[currentEventDate] || 'edit';

    let visibleItemIds: Set<string>;

    if (mode === 'execute') {
      visibleItemIds = new Set(visibleItems.map(item => item.id));
    } else {
      visibleItemIds = new Set([
        ...executeColumnItems.map(item => item.id),
        ...candidateColumnItems.map(item => item.id),
      ]);
    }

    return searchMatches.filter(id => visibleItemIds.has(id));
  }, [searchMatches, activeEventName, activeTab, eventDates, dayModes, visibleItems, executeColumnItems, candidateColumnItems]);

  // Reset search index when keyword or matches change
  useEffect(() => {
    if (searchKeyword.trim()) {
      if (searchMatches.length > 0) {
        setCurrentSearchIndex(0);
      } else {
        setCurrentSearchIndex(-1);
        setHighlightedItemId(null);
      }
    } else {
      setCurrentSearchIndex(-1);
      setHighlightedItemId(null);
    }
  }, [searchKeyword, searchMatches]);

  // Reset search on tab change
  useEffect(() => {
    setCurrentSearchIndex(-1);
    setHighlightedItemId(null);
  }, [activeTab]);

  // Navigate to next search result
  const handleSearchNext = useCallback(() => {
    if (!searchKeyword.trim() || visibleSearchMatches.length === 0) {
      if (searchMatches.length > 0 && visibleSearchMatches.length === 0) {
        alert('フィルタされています');
      }
      return;
    }

    const startIndex = currentSearchIndex === -1 ? -1 : currentSearchIndex;
    const nextIndex = (startIndex + 1) % visibleSearchMatches.length;
    setCurrentSearchIndex(nextIndex);

    const nextItemId = visibleSearchMatches[nextIndex];
    setHighlightedItemId(nextItemId);

    setTimeout(() => {
      const element = document.querySelector(`[data-item-id="${nextItemId}"]`);
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }, [searchKeyword, visibleSearchMatches, currentSearchIndex, searchMatches]);

  return {
    searchKeyword,
    setSearchKeyword,
    currentSearchIndex,
    highlightedItemId,
    visibleSearchMatches,
    handleSearchNext,
  };
}
