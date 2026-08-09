import { useCallback, useEffect } from "react";
import type { ActiveTab } from "../../features/app-shell/types";
import type { ShoppingItem } from "../../types/item";
import type { PersistenceSnapshot } from "../ports/PersistenceCommandPort";

type ExecuteModeItemsStore = PersistenceSnapshot["executeModeItems"];
type ExecuteModeItemsUpdater = (
  current: ExecuteModeItemsStore,
) => ExecuteModeItemsStore;

export interface MapVisitListStatePort {
  readonly activeEventName: string | null;
  readonly activeEventDate: string;
  readonly isMapTab: boolean;
  readonly currentMapTabName: string | null;
  readonly executeModeItems: ExecuteModeItemsStore;
  readonly panelOpen: boolean;
  readonly panelMapTab: string | null;
  readonly hasUnsavedChanges: boolean;
  readonly originalOrder: readonly string[];
  readonly confirmDialogOpen: boolean;
  readonly pendingTabChange: ActiveTab | null;
}

export interface MapVisitListActionPort {
  updateExecuteModeItems(updater: ExecuteModeItemsUpdater): void;
  openPanel(mapTab: string, originalOrder: readonly string[]): void;
  setUnsaved(hasUnsavedChanges: boolean): void;
  requestConfirmClose(pendingTabChange: ActiveTab | null): void;
  closePanel(): void;
  confirmClose(): void;
  discardClose(): void;
}

export interface MapVisitListNavigationPort {
  navigateToTab(tab: ActiveTab): void;
}

export interface MapVisitListCommandPorts {
  readonly state: MapVisitListStatePort;
  readonly actions: MapVisitListActionPort;
  readonly navigation: MapVisitListNavigationPort;
}

export type MapVisitListTransitionResult =
  | "ignored"
  | "confirmation"
  | "navigated";

export interface MapVisitListCommands {
  openPanel(mapTab: string): void;
  updateOrder(items: readonly ShoppingItem[]): void;
  saveChanges(): void;
  discardChanges(): void;
  requestClose(): MapVisitListTransitionResult;
  requestTabChange(tab: ActiveTab): MapVisitListTransitionResult;
  confirmPendingTransition(): void;
  discardPendingTransition(): void;
}

const getMapTabDay = (mapTab: string | null): string | null => {
  if (!mapTab) return null;
  const match = mapTab.match(/^(.+)マップ$/);
  return match?.[1] || null;
};

/**
 * Owns the optimistic visit-list transaction.
 *
 * updateExecuteModeItems is the application committed-state port monitored by
 * useIndexedDbPersistence. Save accepts the optimistic value; discard applies
 * one compensating committed update. Calling PersistenceCommandPort directly
 * here would create a second writer outside that coordinator.
 */
export const useMapVisitListCommands = ({
  state,
  actions,
  navigation,
}: MapVisitListCommandPorts): MapVisitListCommands => {
  const {
    activeEventName,
    activeEventDate,
    isMapTab,
    currentMapTabName,
    executeModeItems,
    panelOpen,
    panelMapTab,
    hasUnsavedChanges,
    originalOrder,
    confirmDialogOpen,
    pendingTabChange,
  } = state;
  const {
    updateExecuteModeItems,
    openPanel: openPanelOverlay,
    setUnsaved,
    requestConfirmClose,
    closePanel,
    confirmClose,
    discardClose,
  } = actions;
  const { navigateToTab } = navigation;

  const openPanel = useCallback(
    (mapTab: string) => {
      if (!activeEventName) return;
      const dayName = getMapTabDay(mapTab);
      if (!dayName) return;

      const executeIds = executeModeItems[activeEventName]?.[dayName] || [];
      openPanelOverlay(mapTab, executeIds);
    },
    [activeEventName, executeModeItems, openPanelOverlay],
  );

  useEffect(() => {
    if (
      !panelOpen ||
      !isMapTab ||
      !activeEventName ||
      !currentMapTabName ||
      panelMapTab === currentMapTabName
    ) {
      return;
    }

    if (hasUnsavedChanges) {
      if (!confirmDialogOpen) {
        requestConfirmClose(activeEventDate || null);
      }
      return;
    }

    if (!activeEventDate) return;
    const executeIds =
      executeModeItems[activeEventName]?.[activeEventDate] || [];
    closePanel();
    openPanelOverlay(currentMapTabName, executeIds);
  }, [
    activeEventDate,
    activeEventName,
    confirmDialogOpen,
    currentMapTabName,
    executeModeItems,
    hasUnsavedChanges,
    isMapTab,
    panelMapTab,
    panelOpen,
    closePanel,
    openPanelOverlay,
    requestConfirmClose,
  ]);

  const updateOrder = useCallback(
    (items: readonly ShoppingItem[]) => {
      if (!activeEventName) return;
      const dayName = getMapTabDay(panelMapTab);
      if (!dayName) return;
      const itemIds = items.map((item) => item.id);

      updateExecuteModeItems((current) => ({
        ...current,
        [activeEventName]: {
          ...current[activeEventName],
          [dayName]: itemIds,
        },
      }));
      setUnsaved(true);
    },
    [activeEventName, panelMapTab, setUnsaved, updateExecuteModeItems],
  );

  const saveChanges = useCallback(() => {
    if (!panelOpen) return;
    setUnsaved(false);
  }, [panelOpen, setUnsaved]);

  const discardChanges = useCallback(() => {
    if (!panelOpen || !activeEventName) return;
    const dayName = getMapTabDay(panelMapTab);
    if (!dayName) return;

    updateExecuteModeItems((current) => ({
      ...current,
      [activeEventName]: {
        ...current[activeEventName],
        [dayName]: [...originalOrder],
      },
    }));
    setUnsaved(false);
  }, [
    activeEventName,
    originalOrder,
    panelMapTab,
    panelOpen,
    setUnsaved,
    updateExecuteModeItems,
  ]);

  const requestClose = useCallback((): MapVisitListTransitionResult => {
    if (!panelOpen || confirmDialogOpen) return "ignored";
    if (hasUnsavedChanges) {
      requestConfirmClose(null);
      return "confirmation";
    }
    closePanel();
    return "navigated";
  }, [
    confirmDialogOpen,
    hasUnsavedChanges,
    panelOpen,
    closePanel,
    requestConfirmClose,
  ]);

  const requestTabChange = useCallback(
    (tab: ActiveTab): MapVisitListTransitionResult => {
      if (confirmDialogOpen) return "ignored";
      if (panelOpen && hasUnsavedChanges) {
        requestConfirmClose(tab);
        return "confirmation";
      }
      if (panelOpen) closePanel();
      navigateToTab(tab);
      return "navigated";
    },
    [
      confirmDialogOpen,
      hasUnsavedChanges,
      navigateToTab,
      panelOpen,
      closePanel,
      requestConfirmClose,
    ],
  );

  const confirmPendingTransition = useCallback(() => {
    if (!confirmDialogOpen) return;
    saveChanges();
    confirmClose();
    if (pendingTabChange !== null) navigateToTab(pendingTabChange);
  }, [
    confirmClose,
    confirmDialogOpen,
    navigateToTab,
    pendingTabChange,
    saveChanges,
  ]);

  const discardPendingTransition = useCallback(() => {
    if (!confirmDialogOpen) return;
    discardChanges();
    discardClose();
    if (pendingTabChange !== null) navigateToTab(pendingTabChange);
  }, [
    confirmDialogOpen,
    discardChanges,
    discardClose,
    navigateToTab,
    pendingTabChange,
  ]);

  return {
    openPanel,
    updateOrder,
    saveChanges,
    discardChanges,
    requestClose,
    requestTabChange,
    confirmPendingTransition,
    discardPendingTransition,
  };
};
