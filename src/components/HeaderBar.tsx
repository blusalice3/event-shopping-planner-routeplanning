import React from 'react';
import { ShoppingItem, HallDefinition, ViewMode } from '../types';
import SortAscendingIcon from './icons/SortAscendingIcon';
import SortDescendingIcon from './icons/SortDescendingIcon';
import SearchBar from './SearchBar';
import BulkActionControls from './BulkActionControls';
import TabButton from './TabButton';
import { DEFAULT_UI_VISIBILITY } from '../hooks/useUIVisibility';
import type { SortState } from '../hooks/useSorting';

type ActiveTab = 'eventList' | 'import' | string;
export type BulkSortDirection = 'asc' | 'desc';

const sortLabels: Record<SortState, string> = {
  Manual: '巡回順',
  Postpone: '後回し',
  Late: '遅参',
  Absent: '欠席',
  SoldOut: '売切',
  None: '未購入',
  Purchased: '購入済',
};

interface MapCellCoord { row: number; col: number }

interface HeaderBarProps {
  // Visibility
  showHeaderBar: boolean;
  showTabBar: boolean;

  // Event/tab state
  activeEventName: string | null;
  activeTab: ActiveTab;
  mainContentVisible: boolean;
  items: ShoppingItem[];
  eventDates: string[];
  mapTabs: string[];
  isMapTab: boolean;
  currentMode: string;

  // Theme
  themeMode: string;
  cycleTheme: () => void;

  // UI visibility settings
  uiSettingsPanelOpen: boolean;
  setUiSettingsPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  uiVisibilitySettings: any;
  setUiVisibilitySettings: React.Dispatch<React.SetStateAction<any>>;

  // Mode switching
  handleSetViewMode: (mode: ViewMode, lastItemId?: string) => void;

  // Sort
  blockSortDirection: BulkSortDirection | null;
  handleBlockSortToggle: () => void;
  handleBlockSortToggleCandidate: () => void;
  sortState: SortState;
  handleSortToggle: () => void;
  handleBulkSort: (direction: BulkSortDirection) => void;

  // Selection
  selectedItemIds: Set<string>;
  handleClearSelection: () => void;
  showMoveButtons: boolean;
  hasCandidateSelection: boolean;
  hasExecuteSelection: boolean;
  handleMoveToExecuteColumn: (ids: string[]) => void;
  handleRemoveFromExecuteColumn: (ids: string[]) => void;

  // Map controls
  currentMapData: any;
  currentHalls: HallDefinition[];
  mapHallSelectorOpen: boolean;
  setMapHallSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mapSelectedHallId: string;
  setMapSelectedHallId: React.Dispatch<React.SetStateAction<string>>;
  getHallExecuteCount: (hallId: string) => number;
  getHallTotalItemCount: (hallId: string) => number;
  mapIsHallOrderOpen: boolean;
  setMapIsHallOrderOpen: React.Dispatch<React.SetStateAction<boolean>>;
  mapIsRouteVisible: boolean;
  setMapIsRouteVisible: React.Dispatch<React.SetStateAction<boolean>>;
  mapSmartInsertEnabled: boolean;
  setMapSmartInsertEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  mapSmartInsertMode: string;
  setMapSmartInsertMode: React.Dispatch<React.SetStateAction<'card' | 'preview'>>;
  smartInsertLongPressRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  smartInsertLongPressTriggeredRef: React.MutableRefObject<boolean>;
  smartInsertToast: string | null;
  setSmartInsertToast: React.Dispatch<React.SetStateAction<string | null>>;

  // TabButton dependencies
  mapTabMenuOpen: string | null;
  setMapTabMenuOpen: React.Dispatch<React.SetStateAction<string | null>>;
  setMapTabMenuPosition: React.Dispatch<React.SetStateAction<{ left: number; top: number }>>;
  onToggleMode: () => void;
  onTabChange: (tab: ActiveTab) => void;
  openVisitListPanel: (tab: string) => void;
  setBlockDefinitionMode: (v: boolean) => void;
  setHallDefinitionMode: (v: boolean) => void;

  // Search
  searchKeyword: string;
  setSearchKeyword: React.Dispatch<React.SetStateAction<string>>;
  handleSearchNext: () => void;
  visibleSearchMatches: any[];
  currentSearchIndex: number;

  // Item editing
  itemToEdit: ShoppingItem | null;
  setItemToEdit: React.Dispatch<React.SetStateAction<ShoppingItem | null>>;
  setSelectedItemIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSelectedBlockFilters: React.Dispatch<React.SetStateAction<Set<string>>>;
  setCandidateNumberSortDirection: React.Dispatch<React.SetStateAction<BulkSortDirection | null>>;
  setActiveEventName: React.Dispatch<React.SetStateAction<string | null>>;
  setActiveTab: React.Dispatch<React.SetStateAction<ActiveTab>>;
}

const HeaderBar: React.FC<HeaderBarProps> = (props) => {
  const {
    showHeaderBar, showTabBar,
    activeEventName, activeTab, mainContentVisible, items, eventDates, mapTabs, isMapTab, currentMode,
    themeMode, cycleTheme,
    uiSettingsPanelOpen, setUiSettingsPanelOpen, uiVisibilitySettings, setUiVisibilitySettings,
    handleSetViewMode,
    blockSortDirection, handleBlockSortToggle, handleBlockSortToggleCandidate,
    sortState, handleSortToggle, handleBulkSort,
    selectedItemIds, handleClearSelection, showMoveButtons, hasCandidateSelection, hasExecuteSelection,
    handleMoveToExecuteColumn, handleRemoveFromExecuteColumn,
    currentMapData, currentHalls,
    mapHallSelectorOpen, setMapHallSelectorOpen, mapSelectedHallId, setMapSelectedHallId,
    getHallExecuteCount, getHallTotalItemCount,
    mapIsHallOrderOpen, setMapIsHallOrderOpen,
    mapIsRouteVisible, setMapIsRouteVisible,
    mapSmartInsertEnabled, setMapSmartInsertEnabled,
    mapSmartInsertMode, setMapSmartInsertMode,
    smartInsertLongPressRef, smartInsertLongPressTriggeredRef,
    mapTabMenuOpen, setMapTabMenuOpen, setMapTabMenuPosition,
    onToggleMode, onTabChange, openVisitListPanel,
    setBlockDefinitionMode, setHallDefinitionMode,
    searchKeyword, setSearchKeyword, handleSearchNext, visibleSearchMatches, currentSearchIndex,
    itemToEdit, setItemToEdit, setSelectedItemIds, setSelectedBlockFilters, setCandidateNumberSortDirection,
    setActiveEventName, setActiveTab,
  } = props;

  const tabButtonProps = {
    activeTab,
    activeEventName,
    eventDates,
    mapTabMenuOpen,
    setMapTabMenuOpen,
    setMapTabMenuPosition,
    onToggleMode,
    onTabChange,
    onOpenVisitListPanel: openVisitListPanel,
    onSetBlockDefinitionMode: setBlockDefinitionMode,
    onSetHallDefinitionMode: setHallDefinitionMode,
  };

  return (
    <header className="bg-white dark:bg-slate-800 shadow-sm sticky top-0 z-10">
      {showHeaderBar && (
      <div className="max-w-7xl mx-auto py-4 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-slate-900 dark:text-white">即売会 購入巡回表</h1>
            {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'execute' && (
              <button
                onClick={handleBlockSortToggle}
                className={`p-2 rounded-md transition-colors duration-200 ${
                  blockSortDirection
                    ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                    : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                }`}
                title={blockSortDirection === 'desc' ? "ブロック降順 (昇順へ)" : blockSortDirection === 'asc' ? "ブロック昇順 (降順へ)" : "ブロック昇順でソート"}
              >
                {blockSortDirection === 'desc' ? <SortDescendingIcon className="w-5 h-5" /> : <SortAscendingIcon className="w-5 h-5" />}
              </button>
            )}
            {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'edit' && (
              <button
                onClick={handleBlockSortToggleCandidate}
                className={`p-2 rounded-md transition-colors duration-200 ${
                  blockSortDirection
                    ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300'
                    : 'bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400'
                }`}
                title={blockSortDirection === 'desc' ? "候補リスト ブロック降順 (昇順へ)" : blockSortDirection === 'asc' ? "候補リスト ブロック昇順 (降順へ)" : "候補リスト ブロック昇順でソート"}
              >
                {blockSortDirection === 'desc' ? <SortDescendingIcon className="w-5 h-5" /> : <SortAscendingIcon className="w-5 h-5" />}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 mt-1">
            {activeEventName && <h2 className="text-sm text-blue-600 dark:text-blue-400 font-semibold">{activeEventName}</h2>}
            {/* テーマ切り替えトグル */}
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                cycleTheme();
              }}
              className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
              title={themeMode === 'system' ? 'システム設定 → ライトモードへ' : themeMode === 'light' ? 'ライトモード → ダークモードへ' : 'ダークモード → システム設定へ'}
              style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
              type="button"
            >
              {themeMode === 'system' ? (
                <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              ) : themeMode === 'light' ? (
                <svg className="w-5 h-5 text-amber-500 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-indigo-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
            
            {/* UI表示設定（歯車アイコン） */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setUiSettingsPanelOpen(!uiSettingsPanelOpen);
                }}
                className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                  uiSettingsPanelOpen
                    ? 'bg-slate-200 dark:bg-slate-700'
                    : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                }`}
                title="表示設定"
                style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                type="button"
              >
                <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              
              {/* UI表示設定パネル */}
              {uiSettingsPanelOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-40"
                    onClick={() => setUiSettingsPanelOpen(false)}
                  />
                  <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 p-4 min-w-[320px] max-h-[70vh] overflow-y-auto">
                    <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">ヘッダー/タブバー表示設定</h3>
                    
                    {/* 集中モード設定 */}
                    <div className="mb-3">
                      <h4 className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">🔍 集中モード</h4>
                      <div className="space-y-2">
                        {([
                          ['focus_sp_mapOn', 'SP・マップON'],
                          ['focus_sp_mapOff', 'SP・マップOFF'],
                          ['focus_pc_mapOn', 'PC・マップON'],
                          ['focus_pc_mapOff', 'PC・マップOFF'],
                        ] as [string, string][]).map(([key, label]) => (
                          <div key={key} className="flex items-center justify-between text-xs">
                            <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">{label}</span>
                            <div className="flex items-center gap-3">
                              <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={uiVisibilitySettings[key].header}
                                  onChange={(e) => setUiVisibilitySettings((prev: any) => ({
                                    ...prev,
                                    [key]: { ...prev[key], header: e.target.checked }
                                  }))}
                                  className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                />
                                <span className="text-slate-500 dark:text-slate-400">ヘッダー</span>
                              </label>
                              <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={uiVisibilitySettings[key].tabBar}
                                  onChange={(e) => setUiVisibilitySettings((prev: any) => ({
                                    ...prev,
                                    [key]: { ...prev[key], tabBar: e.target.checked }
                                  }))}
                                  className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                />
                                <span className="text-slate-500 dark:text-slate-400">タブバー</span>
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    
                    {/* 実行モード設定 */}
                    <div className="mb-3">
                      <h4 className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2">🏃 実行モード</h4>
                      <div className="space-y-2">
                        {([
                          ['execute_sp', 'スマートフォン'],
                          ['execute_pc', 'PC / タブレット'],
                        ] as [string, string][]).map(([key, label]) => (
                          <div key={key} className="flex items-center justify-between text-xs">
                            <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">{label}</span>
                            <div className="flex items-center gap-3">
                              <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={uiVisibilitySettings[key].header}
                                  onChange={(e) => setUiVisibilitySettings((prev: any) => ({
                                    ...prev,
                                    [key]: { ...prev[key], header: e.target.checked }
                                  }))}
                                  className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                />
                                <span className="text-slate-500 dark:text-slate-400">ヘッダー</span>
                              </label>
                              <label className="flex items-center gap-1 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={uiVisibilitySettings[key].tabBar}
                                  onChange={(e) => setUiVisibilitySettings((prev: any) => ({
                                    ...prev,
                                    [key]: { ...prev[key], tabBar: e.target.checked }
                                  }))}
                                  className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                />
                                <span className="text-slate-500 dark:text-slate-400">タブバー</span>
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                    
                    {/* リセットボタン */}
                    <button
                      onClick={() => setUiVisibilitySettings(DEFAULT_UI_VISIBILITY)}
                      className="w-full mt-1 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
                    >
                      デフォルトに戻す
                    </button>
                  </div>
                </>
              )}
            </div>
            
            {/* モード切替アイコン（日付タブ表示時のみ） */}
            {activeEventName && mainContentVisible && (
              <div className="flex items-center gap-1 ml-2 border-l border-slate-300 dark:border-slate-600 pl-2">
                <button
                  onClick={() => handleSetViewMode('edit')}
                  className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                    currentMode === 'edit'
                      ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400'
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                  title="編集モード"
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '40px', minHeight: '40px' }}
                  type="button"
                >
                  <span className="text-lg">📝</span>
                </button>
                
                <button
                  onClick={() => handleSetViewMode('execute')}
                  className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                    currentMode === 'execute'
                      ? 'bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400'
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                  title="実行モード"
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '40px', minHeight: '40px' }}
                  type="button"
                >
                  <span className="text-lg">🏃</span>
                </button>
                
                <button
                  onClick={() => handleSetViewMode('focus')}
                  className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                    currentMode === 'focus'
                      ? 'bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400'
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400'
                  }`}
                  title="集中モード"
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '40px', minHeight: '40px' }}
                  type="button"
                >
                  <span className="text-lg">🔍</span>
                </button>
              </div>
            )}
            
            {/* マップコントロール（マップタブ表示時のみ） */}
            {activeEventName && isMapTab && currentMapData && currentHalls.length > 0 && (
              <>
                {/* ホール選択 */}
                <div className="relative">
                  <button
                    onClick={() => setMapHallSelectorOpen(!mapHallSelectorOpen)}
                    className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                      mapHallSelectorOpen 
                        ? 'bg-slate-200 dark:bg-slate-700' 
                        : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                    }`}
                    title={`表示ホール: ${mapSelectedHallId === 'all' ? '全ホール' : currentHalls.find(h => h.id === mapSelectedHallId)?.name || ''}`}
                    style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                    type="button"
                  >
                    <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M2 18h3v-4h2v4h2v-6H7l-2-4-2 4H2v6zm5-8h2V8h2V6h2v2h2v2h2v8h-3v-4h-2v4h-3v-8z"/>
                      <path d="M14 10h2v2h-2zM14 14h2v2h-2zM18 10h2v2h-2zM18 14h2v2h-2z"/>
                    </svg>
                  </button>
                  {mapSelectedHallId !== 'all' && (
                    <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full"></span>
                  )}
                  
                  {mapHallSelectorOpen && (
                    <>
                      <div 
                        className="fixed inset-0 z-40"
                        onClick={() => setMapHallSelectorOpen(false)}
                      />
                      <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 min-w-[200px]">
                        <button
                          onClick={() => {
                            setMapSelectedHallId('all');
                            setMapHallSelectorOpen(false);
                          }}
                          className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                            mapSelectedHallId === 'all'
                              ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                          }`}
                        >
                          全ホール
                        </button>
                        {currentHalls.map((hall) => {
                          const executeCount = getHallExecuteCount(hall.id);
                          const totalCount = getHallTotalItemCount(hall.id);
                          return (
                            <button
                              key={hall.id}
                              onClick={() => {
                                setMapSelectedHallId(hall.id);
                                setMapHallSelectorOpen(false);
                              }}
                              className={`w-full px-4 py-2 text-left text-sm transition-colors flex justify-between items-center ${
                                mapSelectedHallId === hall.id
                                  ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                              }`}
                            >
                              <span>{hall.name}</span>
                              <span className="text-xs text-slate-500 dark:text-slate-400 ml-2">
                                ({executeCount}/{totalCount}件)
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
                
                {/* ホール順序 */}
                <button
                  onClick={() => setMapIsHallOrderOpen(true)}
                  className="p-2 rounded-md transition-colors hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600 touch-manipulation select-none"
                  title="ホール順序を編集"
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                  type="button"
                >
                  <svg className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                </button>
                
                {/* ルート表示ON/OFF */}
                <button
                  onClick={() => setMapIsRouteVisible(!mapIsRouteVisible)}
                  className={`p-2 rounded-md transition-colors touch-manipulation select-none ${
                    mapIsRouteVisible 
                      ? 'bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-800' 
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                  }`}
                  title={mapIsRouteVisible ? 'ルート表示ON' : 'ルート表示OFF'}
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                  type="button"
                >
                  <svg className={`w-5 h-5 pointer-events-none ${mapIsRouteVisible ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="6" cy="6" r="2" strokeWidth={2} />
                    <circle cx="18" cy="18" r="2" strokeWidth={2} />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 8v4a4 4 0 004 4h4M14 12l4 4m0 0l-4 4" />
                  </svg>
                </button>
                
                {/* スマート位置選択ON/OFF */}
                <button
                  onPointerDown={() => {
                    smartInsertLongPressTriggeredRef.current = false;
                    smartInsertLongPressRef.current = setTimeout(() => {
                      smartInsertLongPressTriggeredRef.current = true;
                      const newMode = mapSmartInsertMode === 'card' ? 'preview' : 'card';
                      setMapSmartInsertMode(newMode);
                      props.setSmartInsertToast(newMode === 'preview' ? 'プレビューモードに切替' : 'カードモードに切替');
                    }, 500);
                  }}
                  onPointerUp={() => {
                    if (smartInsertLongPressRef.current) {
                      clearTimeout(smartInsertLongPressRef.current);
                      smartInsertLongPressRef.current = null;
                    }
                  }}
                  onPointerLeave={() => {
                    if (smartInsertLongPressRef.current) {
                      clearTimeout(smartInsertLongPressRef.current);
                      smartInsertLongPressRef.current = null;
                    }
                  }}
                  onClick={() => {
                    if (smartInsertLongPressTriggeredRef.current) {
                      smartInsertLongPressTriggeredRef.current = false;
                      return;
                    }
                    setMapSmartInsertEnabled(!mapSmartInsertEnabled);
                  }}
                  className={`relative p-2 rounded-md transition-colors touch-manipulation select-none ${
                    mapSmartInsertEnabled 
                      ? 'bg-green-100 dark:bg-green-900/50 hover:bg-green-200 dark:hover:bg-green-800' 
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600'
                  }`}
                  title={`スマート追加${mapSmartInsertEnabled ? 'ON' : 'OFF'} (${mapSmartInsertMode === 'card' ? 'カード' : 'プレビュー'}) 長押しでモード切替`}
                  style={{ WebkitTapHighlightColor: 'transparent', minWidth: '44px', minHeight: '44px' }}
                  type="button"
                >
                  <svg className={`w-5 h-5 pointer-events-none ${mapSmartInsertEnabled ? 'text-green-600 dark:text-green-400' : 'text-slate-600 dark:text-slate-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m0-8l-4-4m4 4l4-4" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
                  </svg>
                  {mapSmartInsertEnabled && (
                    <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-bold leading-none text-green-600 dark:text-green-400">
                      {mapSmartInsertMode === 'preview' ? 'P' : 'C'}
                    </div>
                  )}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {activeEventName && mainContentVisible && items.length > 0 && selectedItemIds.size > 0 && (
            <>
              <BulkActionControls
                onSort={handleBulkSort}
                onClear={handleClearSelection}
              />
              {showMoveButtons && hasCandidateSelection && (
                <button
                  onClick={() => handleMoveToExecuteColumn(Array.from(selectedItemIds))}
                  className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                >
                  選択したアイテムを左列に移動 ({selectedItemIds.size}件)
                </button>
              )}
              {showMoveButtons && hasExecuteSelection && (
                <button
                  onClick={() => handleRemoveFromExecuteColumn(Array.from(selectedItemIds))}
                  className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                >
                  選択したアイテムを右列に移動 ({selectedItemIds.size}件)
                </button>
              )}
            </>
          )}
          {activeEventName && mainContentVisible && items.length > 0 && currentMode === 'execute' && (
            <button
              onClick={handleSortToggle}
              className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-200 text-blue-600 bg-blue-100 hover:bg-blue-200 dark:text-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-900 flex-shrink-0"
            >
              {sortLabels[sortState]}
            </button>
          )}
        </div>
      </div>
      )}
      {showTabBar && (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-slate-200 dark:border-slate-700">
        <div className="flex space-x-2 pt-2 pb-2 overflow-x-auto">
          <TabButton {...tabButtonProps} tab="eventList" label="即売会リスト" onClick={() => { setActiveEventName(null); setItemToEdit(null); setSelectedItemIds(new Set()); setSelectedBlockFilters(new Set()); setActiveTab('eventList'); }}/>
          {activeEventName ? (
            <>
              {eventDates.map(eventDate => {
                const count = items.filter(item => item.eventDate === eventDate).length;
                const mapTabName = `${eventDate}マップ`;
                const hasMapData = mapTabs.includes(mapTabName);
                return (
                  <React.Fragment key={eventDate}>
                    <TabButton 
                      {...tabButtonProps}
                      tab={eventDate} 
                      label={eventDate} 
                      count={count} 
                    />
                    {hasMapData && (
                      <TabButton 
                        {...tabButtonProps}
                        tab={mapTabName} 
                        label={`${eventDate}マップ`}
                        isMapTab={true}
                      />
                    )}
                  </React.Fragment>
                );
              })}
              <TabButton {...tabButtonProps} tab="import" label={itemToEdit ? "アイテム編集" : "アイテム追加"} />
              {activeEventName && (mainContentVisible || isMapTab) && (
                <SearchBar
                  searchKeyword={searchKeyword}
                  onSearchKeywordChange={setSearchKeyword}
                  onSearchNext={handleSearchNext}
                  matchCount={visibleSearchMatches.length}
                  currentMatchIndex={currentSearchIndex}
                />
              )}
            </>
          ) : (
            <button
              onClick={() => { setItemToEdit(null); setActiveTab('import'); }}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
                activeTab === 'import'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              新規リスト作成
            </button>
          )}
        </div>
      </div>
      )}
    </header>
  );
};

export default HeaderBar;
export { sortLabels };
