import { useState, useMemo, useCallback, useEffect } from 'react';
import React from 'react';
import { ShoppingItem, ExecuteModeItems, HallDefinitionsStore, HallRouteSettingsStore } from '../types';

type ActiveTab = string;

export function useVisitList(
  activeEventName: string | null,
  activeTab: ActiveTab,
  isMapTab: boolean,
  items: ShoppingItem[],
  executeModeItems: Record<string, ExecuteModeItems>,
  setExecuteModeItems: React.Dispatch<React.SetStateAction<Record<string, ExecuteModeItems>>>,
  hallDefinitions: HallDefinitionsStore,
  hallRouteSettings: HallRouteSettingsStore,
) {
  const [visitListPanelOpen, setVisitListPanelOpen] = useState(false);
  const [visitListPanelMapTab, setVisitListPanelMapTab] = useState<string | null>(null);
  const [visitListHasUnsavedChanges, setVisitListHasUnsavedChanges] = useState(false);
  const [visitListOriginalOrder, setVisitListOriginalOrder] = useState<string[]>([]);
  const [highlightedMapCell, setHighlightedMapCell] = useState<{ row: number; col: number } | null>(null);
  const [showVisitListConfirmDialog, setShowVisitListConfirmDialog] = useState(false);
  const [pendingTabChange, setPendingTabChange] = useState<string | null>(null);

  // Open visit list panel
  const openVisitListPanel = useCallback((mapTab: string) => {
    if (!activeEventName) return;

    const dayMatch = mapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];

    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
    setVisitListOriginalOrder([...executeIds]);
    setVisitListPanelMapTab(mapTab);
    setVisitListHasUnsavedChanges(false);
    setVisitListPanelOpen(true);
  }, [activeEventName, executeModeItems]);

  // Auto-switch when map tab changes while panel is open
  useEffect(() => {
    if (!visitListPanelOpen || !isMapTab || !activeEventName) return;
    if (visitListPanelMapTab !== activeTab) {
      if (visitListHasUnsavedChanges) {
        setVisitListHasUnsavedChanges(false);
      }
      const dayMatch = activeTab.match(/^(.+)マップ$/);
      if (!dayMatch) return;
      const dayName = dayMatch[1];
      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
      setVisitListOriginalOrder([...executeIds]);
      setVisitListPanelMapTab(activeTab);
      setVisitListHasUnsavedChanges(false);
    }
  }, [activeTab, isMapTab, activeEventName, visitListPanelOpen, visitListPanelMapTab, visitListHasUnsavedChanges, executeModeItems]);

  // Update visit list order
  const handleVisitListOrderUpdate = useCallback((newOrderItems: ShoppingItem[]) => {
    if (!visitListPanelMapTab || !activeEventName) return;

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];

    const newIds = newOrderItems.map(item => item.id);

    setExecuteModeItems(prev => ({
      ...prev,
      [activeEventName]: {
        ...prev[activeEventName],
        [dayName]: newIds,
      },
    }));
    setVisitListHasUnsavedChanges(true);
  }, [visitListPanelMapTab, activeEventName, setExecuteModeItems]);

  // Confirm changes
  const handleVisitListConfirm = useCallback(() => {
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, []);

  // Cancel and restore original order
  const handleVisitListCancel = useCallback(() => {
    if (!visitListPanelMapTab || !activeEventName) return;

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return;
    const dayName = dayMatch[1];

    if (visitListOriginalOrder.length > 0) {
      setExecuteModeItems(prev => ({
        ...prev,
        [activeEventName]: {
          ...prev[activeEventName],
          [dayName]: [...visitListOriginalOrder],
        },
      }));
    }
    setVisitListHasUnsavedChanges(false);
    setVisitListOriginalOrder([]);
  }, [visitListOriginalOrder, visitListPanelMapTab, activeEventName, setExecuteModeItems]);

  // Close panel (keep changes)
  const handleVisitListClose = useCallback(() => {
    setVisitListPanelOpen(false);
  }, []);

  // Highlight map cell
  const handleHighlightMapCell = useCallback((row: number, col: number) => {
    setHighlightedMapCell({ row, col });
  }, []);

  const handleClearMapCellHighlight = useCallback(() => {
    setHighlightedMapCell(null);
  }, []);

  // Confirm dialog handlers
  const handleVisitListDialogConfirm = useCallback(() => {
    handleVisitListConfirm();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setPendingTabChange(null);
    }
    return pendingTabChange;
  }, [handleVisitListConfirm, pendingTabChange]);

  const handleVisitListDialogCancel = useCallback(() => {
    handleVisitListCancel();
    setShowVisitListConfirmDialog(false);
    setVisitListPanelOpen(false);
    if (pendingTabChange) {
      setPendingTabChange(null);
    }
    return pendingTabChange;
  }, [handleVisitListCancel, pendingTabChange]);

  // Visit list items (execute column items in order)
  const visitListItems = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const dayMatch = visitListPanelMapTab.match(/^(.+)マップ$/);
    if (!dayMatch) return [];
    const dayName = dayMatch[1];

    const dayItems = items.filter(item => item.eventDate === dayName);
    const executeIds = executeModeItems[activeEventName]?.[dayName] || [];

    return executeIds
      .filter((id: string) => dayItems.some(item => item.id === id))
      .map((id: string) => dayItems.find(item => item.id === id)!)
      .filter(Boolean);
  }, [visitListPanelMapTab, activeEventName, items, executeModeItems]);

  // Visit list hall order
  const visitListHallOrder = useMemo(() => {
    if (!visitListPanelMapTab || !activeEventName) return [];

    const halls = hallDefinitions[activeEventName]?.[visitListPanelMapTab] || [];
    const routeSettingsData = hallRouteSettings[activeEventName]?.[visitListPanelMapTab];

    if (routeSettingsData?.hallOrder && routeSettingsData.hallOrder.length > 0) {
      return routeSettingsData.hallOrder;
    }

    return halls.map(h => h.id);
  }, [visitListPanelMapTab, activeEventName, hallDefinitions, hallRouteSettings]);

  return {
    visitListPanelOpen,
    setVisitListPanelOpen,
    visitListPanelMapTab,
    visitListHasUnsavedChanges,
    highlightedMapCell,
    showVisitListConfirmDialog,
    setShowVisitListConfirmDialog,
    pendingTabChange,
    setPendingTabChange,
    visitListItems,
    visitListHallOrder,
    openVisitListPanel,
    handleVisitListOrderUpdate,
    handleVisitListConfirm,
    handleVisitListCancel,
    handleVisitListClose,
    handleHighlightMapCell,
    handleClearMapCellHighlight,
    handleVisitListDialogConfirm,
    handleVisitListDialogCancel,
  };
}
