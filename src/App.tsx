import React, { useState, useCallback, useMemo } from 'react';
import { ShoppingItem, EventMetadata, DayModeState, ExecuteModeItems, MapDataStore, RouteSettingsStore, HallDefinitionsStore, HallRouteSettingsStore } from './types';
import ImportScreen from './components/ImportScreen';
import ShoppingList from './components/ShoppingList';
import SummaryBar from './components/SummaryBar';
import EventListScreen from './components/EventListScreen';
import ZoomControl from './components/ZoomControl';
import HeaderBar, { sortLabels } from './components/HeaderBar';
import EditModeContent from './components/EditModeContent';
import ModalLayer from './components/ModalLayer';
import { MapView } from './components/map';
import FocusMode from './components/FocusMode';
import { useTheme } from './hooks/useTheme';
import { useUIVisibility } from './hooks/useUIVisibility';
import { usePersistence } from './hooks/usePersistence';
import { useSearch } from './hooks/useSearch';
import { useVisitList } from './hooks/useVisitList';
import { useMapControls } from './hooks/useMapControls';
import { useItemSelection } from './hooks/useItemSelection';
import { useSorting } from './hooks/useSorting';
import { useExportImport } from './hooks/useExportImport';
import { useItemMovement } from './hooks/useItemMovement';
import { useHallUtils } from './hooks/useHallUtils';
import { useViewMode } from './hooks/useViewMode';
import { useColumnItems } from './hooks/useColumnItems';
import { useUpdateWorkflow } from './hooks/useUpdateWorkflow';
import { useMapItemOps } from './hooks/useMapItemOps';
import { useEventManagement, extractEventDates } from './hooks/useEventManagement';
import { useItemCrud } from './hooks/useItemCrud';

type ActiveTab = 'eventList' | 'import' | string;

const App: React.FC = () => {
  const [eventLists, setEventLists] = useState<Record<string, ShoppingItem[]>>({});
  const [eventMetadata, setEventMetadata] = useState<Record<string, EventMetadata>>({});
  const [executeModeItems, setExecuteModeItems] = useState<Record<string, ExecuteModeItems>>({});
  const [dayModes, setDayModes] = useState<Record<string, DayModeState>>({});
  
  const [activeEventName, setActiveEventName] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('eventList');
  const [zoomLevel, setZoomLevel] = useState(100);
  const [newItemDefaults, setNewItemDefaults] = useState<{ eventDate: string; block: string; number: string } | null>(null);

  const [layoutMode, setLayoutMode] = useState<'pc' | 'smartphone'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'smartphone' : 'pc'
  );
  const [focusModeMapVisible, setFocusModeMapVisible] = useState(false);
  
  const { themeMode, cycleTheme } = useTheme();

  const [mapData, setMapData] = useState<MapDataStore>({});
  const [routeSettings, setRouteSettings] = useState<RouteSettingsStore>({});
  const [hallDefinitions, setHallDefinitions] = useState<HallDefinitionsStore>({});
  const [hallRouteSettings, setHallRouteSettings] = useState<HallRouteSettingsStore>({});

  const isInitialized = usePersistence(
    { eventLists, eventMetadata, executeModeItems, dayModes, mapData, routeSettings, hallDefinitions, hallRouteSettings },
    { setEventLists, setEventMetadata, setExecuteModeItems, setDayModes, setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings },
  );

  const items = useMemo(() => activeEventName ? eventLists[activeEventName] || [] : [], [activeEventName, eventLists]);
  const eventDates = useMemo(() => extractEventDates(items), [items]);
  
  const mapTabs = useMemo(() => {
    if (!activeEventName || !mapData[activeEventName]) return [];
    return Object.keys(mapData[activeEventName]).sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)?.[0] || '0', 10);
      const numB = parseInt(b.match(/\d+/)?.[0] || '0', 10);
      return numA - numB;
    });
  }, [activeEventName, mapData]);
  
  const isMapTab = useMemo(() => activeTab.endsWith('マップ'), [activeTab]);
  
  const {
    currentMapData, currentHalls, currentHallRouteSettings,
    getHallExecuteCount, getHallTotalItemCount,
    getHallsForDate, getMapDataForDate, getHallOrderForDate,
    areItemsInSameHall,
  } = useHallUtils({
    activeEventName, activeTab, isMapTab, items,
    executeModeItems, mapData, hallDefinitions, hallRouteSettings,
  });
  
  const currentMode = useMemo(() => {
    if (!activeEventName) return 'execute';
    if (isMapTab) return 'edit';
    const modes = dayModes[activeEventName];
    if (!modes) return 'edit';
    if (eventDates.includes(activeTab)) {
      return modes[activeTab] || 'edit';
    }
    return 'edit';
  }, [activeEventName, dayModes, activeTab, eventDates, isMapTab]);

  const {
    uiVisibilitySettings, setUiVisibilitySettings,
    uiVisibilityOverride, setUiVisibilityOverride,
    uiSettingsPanelOpen, setUiSettingsPanelOpen,
    showHeaderBar, showTabBar, rawHideSomething,
  } = useUIVisibility(activeEventName, currentMode, layoutMode, focusModeMapVisible);

  // アイテム選択
  const {
    selectedItemIds, setSelectedItemIds,
    selectedBlockFilters, setSelectedBlockFilters,
    recentlyChangedItemIds, setRecentlyChangedItemIds,
    rangeStart, setRangeStart,
    rangeEnd, setRangeEnd,
    handleSelectItem: handleSelectItemRaw,
    handleToggleBlockFilter,
    handleClearBlockFilters,
    handleClearSelection,
    handleToggleRangeSelection,
  } = useItemSelection({
    items, activeEventName, activeTab, eventDates, executeModeItems,
    getHallsForDate, getMapDataForDate,
  });

  // アイテムCRUD
  const {
    itemToEdit, setItemToEdit,
    itemToDelete, setItemToDelete,
    handleUpdateItem,
    handleEditRequest: handleEditRequestRaw,
    handleDeleteRequest,
    handleConfirmDelete,
    handleDoneEditing: handleDoneEditingRaw,
  } = useItemCrud({
    activeEventName, activeTab, eventDates, dayModes,
    setEventLists, setExecuteModeItems, setRecentlyChangedItemIds,
  });

  const handleEditRequest = useCallback((item: ShoppingItem) => {
    handleEditRequestRaw(item);
    setActiveTab('import');
  }, [handleEditRequestRaw]);

  const handleDoneEditing = useCallback(() => {
    const targetDate = handleDoneEditingRaw();
    if (targetDate) {
      setActiveTab(targetDate);
    } else if (eventDates.length > 0) {
      setActiveTab(eventDates[0]);
    }
  }, [handleDoneEditingRaw, eventDates]);

  // ソート
  const {
    sortState,
    blockSortDirection,
    candidateNumberSortDirection, setCandidateNumberSortDirection,
    handleSortToggle,
    handleBlockSortToggle,
    handleBlockSortToggleCandidate,
    handleCandidateNumberSort,
    handleBulkSort,
    resetSort,
  } = useSorting({
    activeEventName, activeTab, eventDates, items, executeModeItems, dayModes,
    selectedItemIds, selectedBlockFilters,
    setEventLists, setExecuteModeItems,
    resetSelection: handleClearSelection,
    resetRecentlyChanged: () => setRecentlyChangedItemIds(new Set()),
  });

  const handleSelectItem = useCallback((itemId: string, columnType?: 'execute' | 'candidate') => {
    resetSort();
    handleSelectItemRaw(itemId, columnType);
  }, [resetSort, handleSelectItemRaw]);

  // エクスポート/インポート
  const {
    showExportOptions, setShowExportOptions,
    exportEventName, setExportEventName,
    mapImportDialogOpen,
    mapImportPendingFile,
    mapImportPendingEventName,
    mapFileInputRef,
    exportFileInputRef,
    handleExportEvent,
    handleConfirmExport,
    handleExportFileImport,
    handleImportMapData,
    handleMapFileChange,
    handleMapImportConfirm,
    handleMapImportClose,
  } = useExportImport({
    eventLists, eventMetadata, executeModeItems, dayModes,
    mapData, routeSettings, hallDefinitions, hallRouteSettings,
    setEventLists, setEventMetadata, setExecuteModeItems, setDayModes,
    setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings,
    setActiveEventName, setActiveTab,
  });

  // アイテム移動
  const {
    handleMoveItem,
    handleMoveItemUp,
    handleMoveItemDown,
    handleMoveToExecuteColumn,
    handleRemoveFromExecuteColumn,
  } = useItemMovement({
    activeEventName, activeTab, eventDates, dayModes, executeModeItems, items,
    selectedItemIds, selectedBlockFilters, rangeStart, rangeEnd,
    areItemsInSameHall,
    setEventLists, setExecuteModeItems, setSelectedItemIds, setRangeStart, setRangeEnd,
    resetSort,
  });

  // イベント管理
  const {
    showRenameDialog, setShowRenameDialog,
    eventToRename, setEventToRename,
    handleSelectEvent,
    handleDeleteEvent,
    handleRenameEvent,
    handleConfirmRename,
    handleBulkAdd,
  } = useEventManagement({
    eventLists, eventMetadata, activeEventName,
    setEventLists, setEventMetadata, setExecuteModeItems, setDayModes,
    setMapData, setRouteSettings, setHallDefinitions, setHallRouteSettings,
    setActiveEventName, setActiveTab, setSelectedItemIds, setSelectedBlockFilters,
    setItemToEdit,
  });

  // モード管理
  const {
    handleToggleMode,
    handleSetViewMode,
  } = useViewMode({
    activeEventName, activeTab, eventDates, dayModes,
    setDayModes, setSelectedItemIds, setCandidateNumberSortDirection,
    setFocusModeMapVisible, setUiVisibilityOverride, setUiSettingsPanelOpen,
  });

  // 更新ワークフロー
  const {
    showUpdateConfirmation, setShowUpdateConfirmation,
    updateData, setUpdateData,
    updateEventName, setUpdateEventName,
    showUrlUpdateDialog, setShowUrlUpdateDialog,
    pendingUpdateEventName, setPendingUpdateEventName,
    handleUpdateEvent,
    handleConfirmUpdate,
    handleUrlUpdate,
  } = useUpdateWorkflow({
    eventLists, eventMetadata,
    setEventLists, setExecuteModeItems, setEventMetadata,
  });

  // マップコントロール
  const mapControls = useMapControls();
  const {
    mapTabMenuOpen, setMapTabMenuOpen,
    mapTabMenuPosition, setMapTabMenuPosition,
    blockDefinitionMode, setBlockDefinitionMode,
    hallDefinitionMode, setHallDefinitionMode,
    mapSelectedHallId, setMapSelectedHallId,
    mapIsRouteVisible, setMapIsRouteVisible,
    mapIsHallOrderOpen, setMapIsHallOrderOpen,
    mapHallSelectorOpen, setMapHallSelectorOpen,
    mapSmartInsertEnabled, setMapSmartInsertEnabled,
    mapSmartInsertMode, setMapSmartInsertMode,
    smartInsertToast, setSmartInsertToast,
    smartInsertLongPressRef, smartInsertLongPressTriggeredRef,
    cellSelectionMode,
    pendingCellSelection, setPendingCellSelection,
    handleStartCellSelection,
    handleConfirmCellSelection,
    handleCancelCellSelection,
    vertexSelectionMode,
    pendingVertexSelection, setPendingVertexSelection,
    handleStartVertexSelection,
    handleConfirmVertexSelection,
    handleCancelVertexSelection,
  } = mapControls;

  // 訪問先リスト
  const visitList = useVisitList(
    activeEventName, activeTab, isMapTab, items, executeModeItems, setExecuteModeItems,
    hallDefinitions, hallRouteSettings,
  );
  const {
    visitListPanelOpen,
    visitListPanelMapTab,
    visitListHasUnsavedChanges,
    highlightedMapCell,
    showVisitListConfirmDialog,
    visitListItems,
    visitListHallOrder,
    openVisitListPanel,
    handleVisitListOrderUpdate,
    handleVisitListConfirm,
    handleVisitListCancel,
    handleVisitListClose,
    handleHighlightMapCell,
    handleClearMapCellHighlight,
    handleVisitListDialogConfirm: visitListDialogConfirmRaw,
    handleVisitListDialogCancel: visitListDialogCancelRaw,
  } = visitList;

  const handleVisitListDialogConfirm = useCallback(() => {
    const newTab = visitListDialogConfirmRaw();
    if (newTab) setActiveTab(newTab as ActiveTab);
  }, [visitListDialogConfirmRaw]);

  const handleVisitListDialogCancel = useCallback(() => {
    const newTab = visitListDialogCancelRaw();
    if (newTab) setActiveTab(newTab as ActiveTab);
  }, [visitListDialogCancelRaw]);

  // マップアイテム操作
  const {
    handleAddToExecuteListFromMap,
    handleAddToExecuteListFromMapAtPosition,
    handleRemoveFromExecuteListFromMap,
    handleAddNewItemFromMap,
    handleAddItemFromFocusMode,
    handleMoveToFirstFromMap,
    handleMoveToLastFromMap,
    currentMapExecuteItemIds,
    handleUpdateItemPriority,
    handleUpdateBlocks,
    handleUpdateHalls,
    handleUpdateHallRouteSettings,
    handleReorderExecuteListByHallOrder,
  } = useMapItemOps({
    activeEventName, activeTab, isMapTab, items, eventLists,
    executeModeItems, mapData, hallDefinitions, hallRouteSettings,
    currentMapData, currentHalls, currentHallRouteSettings,
    visitListPanelMapTab,
    setEventLists, setExecuteModeItems, setMapData, setHallDefinitions, setHallRouteSettings,
    setItemToEdit, setNewItemDefaults, setActiveTab,
  });

  // カラムアイテム計算
  const {
    currentTabItems,
    executeColumnItems,
    visibleItems,
    duplicateCircleItemIds,
    availableBlocks,
    candidateColumnItems,
    blocksWithPriorityRemarks,
    hasCandidateSelection,
    hasExecuteSelection,
    showMoveButtons,
  } = useColumnItems({
    activeEventName, activeTab, eventDates, items,
    executeModeItems, dayModes, sortState,
    selectedBlockFilters, selectedItemIds, recentlyChangedItemIds,
    currentMode,
  });

  // 検索機能
  const {
    searchKeyword, setSearchKeyword,
    currentSearchIndex,
    highlightedItemId,
    visibleSearchMatches,
    handleSearchNext,
  } = useSearch(
    activeEventName, activeTab, eventDates, currentTabItems,
    visibleItems, executeColumnItems, candidateColumnItems, dayModes,
  );
  
  if (!isInitialized) {
    return null;
  }

  const mainContentVisible = eventDates.includes(activeTab);
  
  const handleZoomChange = (newZoom: number) => {
    setZoomLevel(Math.max(30, Math.min(150, newZoom)));
  };

  const handleTabChange = (tab: string) => {
    setItemToEdit(null);
    setSelectedItemIds(new Set());
    setSelectedBlockFilters(new Set());
    setCandidateNumberSortDirection(null);
    setActiveTab(tab);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-900 dark:text-slate-200 font-sans">
      {(showHeaderBar || showTabBar) && (
        <HeaderBar
          showHeaderBar={showHeaderBar}
          showTabBar={showTabBar}
          activeEventName={activeEventName}
          activeTab={activeTab}
          mainContentVisible={mainContentVisible}
          items={items}
          eventDates={eventDates}
          mapTabs={mapTabs}
          isMapTab={isMapTab}
          currentMode={currentMode}
          themeMode={themeMode}
          cycleTheme={cycleTheme}
          uiSettingsPanelOpen={uiSettingsPanelOpen}
          setUiSettingsPanelOpen={setUiSettingsPanelOpen}
          uiVisibilitySettings={uiVisibilitySettings}
          setUiVisibilitySettings={setUiVisibilitySettings}
          handleSetViewMode={handleSetViewMode}
          blockSortDirection={blockSortDirection}
          handleBlockSortToggle={handleBlockSortToggle}
          handleBlockSortToggleCandidate={handleBlockSortToggleCandidate}
          sortState={sortState}
          handleSortToggle={handleSortToggle}
          handleBulkSort={handleBulkSort}
          selectedItemIds={selectedItemIds}
          handleClearSelection={handleClearSelection}
          showMoveButtons={showMoveButtons}
          hasCandidateSelection={hasCandidateSelection}
          hasExecuteSelection={hasExecuteSelection}
          handleMoveToExecuteColumn={handleMoveToExecuteColumn}
          handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
          currentMapData={currentMapData}
          currentHalls={currentHalls}
          mapHallSelectorOpen={mapHallSelectorOpen}
          setMapHallSelectorOpen={setMapHallSelectorOpen}
          mapSelectedHallId={mapSelectedHallId}
          setMapSelectedHallId={setMapSelectedHallId}
          getHallExecuteCount={getHallExecuteCount}
          getHallTotalItemCount={getHallTotalItemCount}
          mapIsHallOrderOpen={mapIsHallOrderOpen}
          setMapIsHallOrderOpen={setMapIsHallOrderOpen}
          mapIsRouteVisible={mapIsRouteVisible}
          setMapIsRouteVisible={setMapIsRouteVisible}
          mapSmartInsertEnabled={mapSmartInsertEnabled}
          setMapSmartInsertEnabled={setMapSmartInsertEnabled}
          mapSmartInsertMode={mapSmartInsertMode}
          setMapSmartInsertMode={setMapSmartInsertMode}
          smartInsertLongPressRef={smartInsertLongPressRef}
          smartInsertLongPressTriggeredRef={smartInsertLongPressTriggeredRef}
          smartInsertToast={smartInsertToast}
          setSmartInsertToast={setSmartInsertToast}
          mapTabMenuOpen={mapTabMenuOpen}
          setMapTabMenuOpen={setMapTabMenuOpen}
          setMapTabMenuPosition={setMapTabMenuPosition}
          onToggleMode={handleToggleMode}
          onTabChange={handleTabChange}
          openVisitListPanel={openVisitListPanel}
          setBlockDefinitionMode={setBlockDefinitionMode}
          setHallDefinitionMode={setHallDefinitionMode}
          searchKeyword={searchKeyword}
          setSearchKeyword={setSearchKeyword}
          handleSearchNext={handleSearchNext}
          visibleSearchMatches={visibleSearchMatches}
          currentSearchIndex={currentSearchIndex}
          itemToEdit={itemToEdit}
          setItemToEdit={setItemToEdit}
          setSelectedItemIds={setSelectedItemIds}
          setSelectedBlockFilters={setSelectedBlockFilters}
          setCandidateNumberSortDirection={setCandidateNumberSortDirection}
          setActiveEventName={setActiveEventName}
          setActiveTab={setActiveTab}
        />
      )}

      {/* フローティング全表示ボタン */}
      {rawHideSomething && activeEventName && (currentMode === 'focus' || currentMode === 'execute') && (
        <button
          onClick={() => { setUiVisibilityOverride(prev => !prev); setUiSettingsPanelOpen(false); }}
          className={`fixed left-3 top-3 z-20 w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-all touch-manipulation select-none ${
            uiVisibilityOverride
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-white/80 dark:bg-slate-700/80 text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-600 backdrop-blur-sm border border-slate-200 dark:border-slate-600'
          }`}
          title={uiVisibilityOverride ? '設定通りに戻す' : '全表示'}
          style={{ WebkitTapHighlightColor: 'transparent' }}
          type="button"
        >
          {uiVisibilityOverride ? (
            <svg className="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" /></svg>
          ) : (
            <svg className="w-5 h-5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
          )}
        </button>
      )}

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
        {activeTab === 'eventList' && (
          <EventListScreen 
            eventNames={Object.keys(eventLists).sort()}
            onSelect={handleSelectEvent}
            onDelete={handleDeleteEvent}
            onExport={handleExportEvent}
            onUpdate={handleUpdateEvent}
            onRename={handleRenameEvent}
            onImportMap={handleImportMapData}
            onImportExportFile={() => exportFileInputRef.current?.click()}
          />
        )}
        {activeTab === 'import' && (
          <ImportScreen
            onBulkAdd={handleBulkAdd}
            activeEventName={activeEventName}
            itemToEdit={itemToEdit}
            onUpdateItem={handleUpdateItem}
            onDoneEditing={handleDoneEditing}
            newItemDefaults={newItemDefaults}
            onClearNewItemDefaults={() => setNewItemDefaults(null)}
          />
        )}
        {activeEventName && isMapTab && currentMapData && (
          <MapView
            mapData={currentMapData} mapName={activeTab} items={items}
            executeModeItemIds={currentMapExecuteItemIds}
            onAddToExecuteList={handleAddToExecuteListFromMap}
            onAddToExecuteListAtPosition={handleAddToExecuteListFromMapAtPosition}
            onRemoveFromExecuteList={handleRemoveFromExecuteListFromMap}
            onMoveToFirst={handleMoveToFirstFromMap}
            onMoveToLast={handleMoveToLastFromMap}
            onUpdateItem={handleUpdateItem}
            onDeleteItem={(itemId) => { const item = items.find(i => i.id === itemId); if (item) handleDeleteRequest(item); }}
            onAddNewItem={handleAddNewItemFromMap}
            onAddItem={handleAddItemFromFocusMode}
            halls={currentHalls} hallRouteSettings={currentHallRouteSettings}
            onUpdateHallRouteSettings={handleUpdateHallRouteSettings}
            onReorderExecuteList={handleReorderExecuteListByHallOrder}
            vertexSelectionMode={vertexSelectionMode} cellSelectionMode={cellSelectionMode}
            highlightedCell={visitListPanelOpen ? highlightedMapCell : null}
            externalSelectedHallId={mapSelectedHallId} onSelectedHallIdChange={setMapSelectedHallId}
            externalIsRouteVisible={mapIsRouteVisible} onRouteVisibleChange={setMapIsRouteVisible}
            externalIsHallOrderOpen={mapIsHallOrderOpen} onHallOrderOpenChange={setMapIsHallOrderOpen}
            hideInternalControls={true}
            smartInsertEnabled={mapSmartInsertEnabled} smartInsertMode={mapSmartInsertMode}
          />
        )}
        {activeEventName && mainContentVisible && (
          <div style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top left', width: `${100 * (100 / zoomLevel)}%` }}>
            {currentMode === 'edit' ? (
              <EditModeContent
                executeColumnItems={executeColumnItems} candidateColumnItems={candidateColumnItems}
                items={items} activeTab={activeTab} eventDates={eventDates}
                selectedItemIds={selectedItemIds} selectedBlockFilters={selectedBlockFilters}
                availableBlocks={availableBlocks} blocksWithPriorityRemarks={blocksWithPriorityRemarks}
                candidateNumberSortDirection={candidateNumberSortDirection}
                duplicateCircleItemIds={duplicateCircleItemIds} highlightedItemId={highlightedItemId}
                layoutMode={layoutMode} rangeStart={rangeStart} rangeEnd={rangeEnd}
                handleUpdateItem={handleUpdateItem} handleMoveItem={handleMoveItem}
                handleEditRequest={handleEditRequest} handleDeleteRequest={handleDeleteRequest}
                handleSelectItem={handleSelectItem}
                handleMoveToExecuteColumn={handleMoveToExecuteColumn}
                handleRemoveFromExecuteColumn={handleRemoveFromExecuteColumn}
                handleMoveItemUp={handleMoveItemUp} handleMoveItemDown={handleMoveItemDown}
                handleToggleRangeSelection={handleToggleRangeSelection}
                handleToggleBlockFilter={handleToggleBlockFilter}
                handleClearBlockFilters={handleClearBlockFilters}
                handleCandidateNumberSort={handleCandidateNumberSort}
                getHallsForDate={getHallsForDate} getHallOrderForDate={getHallOrderForDate}
                getMapDataForDate={getMapDataForDate}
              />
            ) : currentMode === 'focus' ? (
              <FocusMode
                items={items}
                executeModeItemIds={executeModeItems[activeEventName]?.[eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')] || []}
                onUpdateItem={handleUpdateItem}
                onModeChange={(mode, lastItemId) => handleSetViewMode(mode, lastItemId)}
                layoutMode={layoutMode} onLayoutModeChange={setLayoutMode}
                mapData={activeEventName ? mapData[activeEventName] : undefined}
                hallDefinitions={activeEventName && activeTab ? hallDefinitions[activeEventName]?.[`${eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}マップ`] : undefined}
                onMapVisibilityChange={setFocusModeMapVisible}
                onAddItem={handleAddItemFromFocusMode}
                onEditRequest={handleEditRequest} onDeleteRequest={handleDeleteRequest}
                appZoomLevel={zoomLevel}
              />
            ) : (
              <ShoppingList
                items={visibleItems} onUpdateItem={handleUpdateItem}
                onMoveItem={(dragId, hoverId, targetColumn) => handleMoveItem(dragId, hoverId, targetColumn)}
                onEditRequest={handleEditRequest} onDeleteRequest={handleDeleteRequest}
                selectedItemIds={selectedItemIds} onSelectItem={handleSelectItem}
                columnType="execute" currentDay={eventDates.includes(activeTab) ? activeTab : (eventDates[0] || '')}
                onMoveItemUp={handleMoveItemUp} onMoveItemDown={handleMoveItemDown}
                rangeStart={rangeStart} rangeEnd={rangeEnd} onToggleRangeSelection={handleToggleRangeSelection}
                duplicateCircleItemIds={duplicateCircleItemIds} highlightedItemId={highlightedItemId} layoutMode={layoutMode}
              />
            )}
          </div>
        )}
      </main>
      
      <ModalLayer
        itemToDelete={itemToDelete} handleConfirmDelete={handleConfirmDelete} setItemToDelete={setItemToDelete}
        showUpdateConfirmation={showUpdateConfirmation} updateData={updateData}
        handleConfirmUpdate={handleConfirmUpdate} setShowUpdateConfirmation={setShowUpdateConfirmation}
        setUpdateData={setUpdateData} setUpdateEventName={setUpdateEventName}
        showUrlUpdateDialog={showUrlUpdateDialog} pendingUpdateEventName={pendingUpdateEventName}
        eventMetadata={eventMetadata} handleUrlUpdate={handleUrlUpdate}
        setShowUrlUpdateDialog={setShowUrlUpdateDialog} setPendingUpdateEventName={setPendingUpdateEventName}
        showRenameDialog={showRenameDialog} eventToRename={eventToRename}
        handleConfirmRename={handleConfirmRename} setShowRenameDialog={setShowRenameDialog} setEventToRename={setEventToRename}
        showExportOptions={showExportOptions} exportEventName={exportEventName} mapData={mapData}
        handleConfirmExport={handleConfirmExport} setShowExportOptions={setShowExportOptions} setExportEventName={setExportEventName}
        blockDefinitionMode={blockDefinitionMode} setBlockDefinitionMode={setBlockDefinitionMode}
        currentMapData={currentMapData} handleUpdateBlocks={handleUpdateBlocks}
        handleStartCellSelection={handleStartCellSelection} pendingCellSelection={pendingCellSelection} setPendingCellSelection={setPendingCellSelection}
        cellSelectionMode={cellSelectionMode} handleConfirmCellSelection={handleConfirmCellSelection} handleCancelCellSelection={handleCancelCellSelection}
        hallDefinitionMode={hallDefinitionMode} setHallDefinitionMode={setHallDefinitionMode}
        currentHalls={currentHalls} handleUpdateHalls={handleUpdateHalls}
        handleStartVertexSelection={handleStartVertexSelection} pendingVertexSelection={pendingVertexSelection} setPendingVertexSelection={setPendingVertexSelection}
        vertexSelectionMode={vertexSelectionMode} handleConfirmVertexSelection={handleConfirmVertexSelection} handleCancelVertexSelection={handleCancelVertexSelection}
        visitListPanelOpen={visitListPanelOpen} handleVisitListClose={handleVisitListClose}
        visitListItems={visitListItems} handleVisitListOrderUpdate={handleVisitListOrderUpdate}
        visitListHallOrder={visitListHallOrder} layoutMode={layoutMode}
        handleHighlightMapCell={handleHighlightMapCell} handleClearMapCellHighlight={handleClearMapCellHighlight}
        visitListHasUnsavedChanges={visitListHasUnsavedChanges}
        handleVisitListConfirm={handleVisitListConfirm} handleVisitListCancel={handleVisitListCancel}
        handleUpdateItemPriority={handleUpdateItemPriority}
        showVisitListConfirmDialog={showVisitListConfirmDialog}
        handleVisitListDialogConfirm={handleVisitListDialogConfirm} handleVisitListDialogCancel={handleVisitListDialogCancel}
        mapImportDialogOpen={mapImportDialogOpen} mapImportPendingFile={mapImportPendingFile}
        mapImportPendingEventName={mapImportPendingEventName}
        handleMapImportConfirm={handleMapImportConfirm} handleMapImportClose={handleMapImportClose}
        mapFileInputRef={mapFileInputRef} handleMapFileChange={handleMapFileChange}
        exportFileInputRef={exportFileInputRef} handleExportFileImport={handleExportFileImport}
        smartInsertToast={smartInsertToast}
      />

      {activeEventName && items.length > 0 && mainContentVisible && currentMode === 'execute' && (
        <SummaryBar items={visibleItems} layoutMode={layoutMode} onLayoutModeChange={setLayoutMode}
          filterLabel={!showHeaderBar ? sortLabels[sortState] : undefined}
          onFilterToggle={!showHeaderBar ? handleSortToggle : undefined} />
      )}
      {activeEventName && items.length > 0 && mainContentVisible && (
        <ZoomControl zoomLevel={zoomLevel} onZoomChange={handleZoomChange} />
      )}
    </div>
  );
};

export default App;
