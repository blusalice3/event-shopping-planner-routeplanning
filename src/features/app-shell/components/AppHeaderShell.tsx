import React from "react";
import BulkActionControls from "../../../components/BulkActionControls";
import SortAscendingIcon from "../../../components/icons/SortAscendingIcon";
import SortDescendingIcon from "../../../components/icons/SortDescendingIcon";
import SearchBar from "../../../components/SearchBar";
import MapRotationControls from "../../../components/map/MapRotationControls";
import { SpaceNavigatorSettingsPanel } from "../../space-navigation/components/SpaceNavigatorSettingsPanel";
import { useOptionalSpaceNavigator } from "../../space-navigation/SpaceNavigatorContext";
import {
  formatMovePlanCount,
  type MovePlan,
} from "../../lists/domain/movePlan";
import { acquireBodyScrollLock } from "../../../utils/bodyScrollLock";
import type { ThemeMode } from "../../../hooks/useThemeMode";
import type {
  UIVisibilityModeKey,
  UIVisibilitySettings,
} from "../../../hooks/useUIVisibilitySettings";
import type {
  DayMapData,
  DayMapRotationState,
  HallDefinition,
  NumberCellOutlineStyle,
} from "../../../types/map";
import type {
  PurchaseStatusControlMode,
  ShoppingItem,
  ViewMode,
} from "../../../types/item";
import type {
  ActiveTab,
  BlockSortDirection,
  BulkSortDirection,
  LayoutMode,
  MapTabMenuPosition,
  SmartInsertMode,
  SortState,
} from "../types";

const APP_ZOOM_OPTIONS = [15, 30, 50, 75, 100, 125, 150] as const;

type TabButtonProps = {
  tab: ActiveTab;
  label: string;
  count?: number;
  onClick?: () => void;
};

export type PurchaseStatusControlModeSettingsProps = {
  purchaseStatusControlMode: PurchaseStatusControlMode;
  setPurchaseStatusControlMode: React.Dispatch<
    React.SetStateAction<PurchaseStatusControlMode>
  >;
};

export const PurchaseStatusControlModeSettings: React.FC<
  PurchaseStatusControlModeSettingsProps
> = ({ purchaseStatusControlMode, setPurchaseStatusControlMode }) => (
  <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-700">
    <div className="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-2">
      購入状態ボタン
    </div>
    <div className="space-y-1">
      {(
        [
          ["cycle", "循環クリック", "クリックするたびに次の状態へ進みます"],
          [
            "radial",
            "放射状メニュー",
            "クリックで7状態を直接選べるメニューを開きます",
          ],
        ] as const
      ).map(([value, label, description]) => (
        <label
          key={value}
          className="flex items-start gap-2 cursor-pointer text-xs"
        >
          <input
            type="radio"
            name="purchaseStatusControlMode"
            value={value}
            checked={purchaseStatusControlMode === value}
            onChange={() => setPurchaseStatusControlMode(value)}
            className="mt-0.5 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
          />
          <span className="flex-1">
            <span className="block text-slate-700 dark:text-slate-300">
              {label}
            </span>
            <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
              {description}
            </span>
          </span>
        </label>
      ))}
    </div>
  </div>
);

export type DisplaySettingsResetButtonProps = {
  DEFAULT_OUTLINE_STYLE: NumberCellOutlineStyle;
  DEFAULT_PURCHASE_STATUS_CONTROL_MODE: PurchaseStatusControlMode;
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY: boolean;
  DEFAULT_UI_VISIBILITY: UIVisibilitySettings;
  setDisablePriceUndefinedCheck: React.Dispatch<React.SetStateAction<boolean>>;
  setDisableLimitedPurchaseQuantityCheck: React.Dispatch<
    React.SetStateAction<boolean>
  >;
  setSkipLimitedPurchaseForSingleQuantity: React.Dispatch<
    React.SetStateAction<boolean>
  >;
  setNumberCellOutlineStyle: React.Dispatch<
    React.SetStateAction<NumberCellOutlineStyle>
  >;
  setPurchaseStatusControlMode: React.Dispatch<
    React.SetStateAction<PurchaseStatusControlMode>
  >;
  setUiVisibilitySettings: React.Dispatch<
    React.SetStateAction<UIVisibilitySettings>
  >;
  setZoomLevel: (zoomLevel: number) => void;
};

export const DisplaySettingsResetButton: React.FC<
  DisplaySettingsResetButtonProps
> = ({
  DEFAULT_OUTLINE_STYLE,
  DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
  DEFAULT_UI_VISIBILITY,
  setDisablePriceUndefinedCheck,
  setDisableLimitedPurchaseQuantityCheck,
  setSkipLimitedPurchaseForSingleQuantity,
  setNumberCellOutlineStyle,
  setPurchaseStatusControlMode,
  setUiVisibilitySettings,
  setZoomLevel,
}) => {
  const spaceNavigator = useOptionalSpaceNavigator();
  return (
    <button
      onClick={() => {
        setUiVisibilitySettings(DEFAULT_UI_VISIBILITY);
        setZoomLevel(100);
        setNumberCellOutlineStyle(DEFAULT_OUTLINE_STYLE);
        setDisablePriceUndefinedCheck(false);
        setDisableLimitedPurchaseQuantityCheck(false);
        setSkipLimitedPurchaseForSingleQuantity(
          DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
        );
        setPurchaseStatusControlMode(DEFAULT_PURCHASE_STATUS_CONTROL_MODE);
        spaceNavigator?.resetSettings();
      }}
      className="w-full mt-1 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded transition-colors"
    >
      デフォルトに戻す
    </button>
  );
};

type AppHeaderShellProps = {
  activeEventDate: string;
  activeEventName: string | null;
  activeTab: ActiveTab;
  blockSortDirection: BlockSortDirection | null;
  currentHalls: HallDefinition[];
  currentMapData: DayMapData | null;
  currentMapTabName: string | null;
  currentMapTabRotationState: DayMapRotationState;
  currentMode: ViewMode;
  currentSearchIndex: number;
  DEFAULT_OUTLINE_STYLE: NumberCellOutlineStyle;
  DEFAULT_PURCHASE_STATUS_CONTROL_MODE: PurchaseStatusControlMode;
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY: boolean;
  DEFAULT_UI_VISIBILITY: UIVisibilitySettings;
  disablePriceUndefinedCheck: boolean;
  disableLimitedPurchaseQuantityCheck: boolean;
  skipLimitedPurchaseForSingleQuantity: boolean;
  postEventDistributionCheckEnabled: boolean;
  eventDates: string[];
  getHallExecuteCount: (hallId: string) => number;
  getHallTotalItemCount: (hallId: string) => number;
  getMapTabForDate: (eventDate: string) => string | null;
  globalHallOrderHalls: HallDefinition[];
  globalHallOrderMapTabName: string | null;
  handleBlockSortToggle: () => void;
  handleBlockSortToggleCandidate: () => void;
  handleBulkSort: (direction: BulkSortDirection) => void;
  handleClearRangeSelection: () => void;
  handleClearSelection: () => void;
  handleMapTabRotationAngleChange: (angle: number) => void;
  handleMoveToExecuteColumn: (itemIds: string[]) => void;
  handleRemoveFromExecuteColumn: (itemIds: string[]) => void;
  handleSearchNext: () => void;
  handleSetViewMode: (mode: ViewMode, scrollToItemId?: string) => void;
  handleSortToggle: () => void;
  handleZoomChange: (newZoom: number) => void;
  hasCandidateSelection: boolean;
  hasExecuteSelection: boolean;
  candidateMovePlan: MovePlan;
  executeMovePlan: MovePlan;
  hasUndefinedPriorityItems: boolean;
  isMapTab: boolean;
  items: ShoppingItem[];
  itemToEdit: ShoppingItem | null;
  layoutMode: LayoutMode;
  mainContentVisible: boolean;
  mapHallSelectorOpen: boolean;
  mapIsRouteVisible: boolean;
  mapSelectedHallId: string;
  mapSmartInsertEnabled: boolean;
  mapSmartInsertMode: SmartInsertMode;
  mapTabMenuOpen: string | null;
  mapTabMenuPosition: MapTabMenuPosition;
  mapToggleButtonRef: React.MutableRefObject<HTMLButtonElement | null>;
  mapToggleLongPressFiredRef: React.MutableRefObject<boolean>;
  mapToggleLongPressRef: React.MutableRefObject<number | null>;
  mapToggleMenuRef: React.MutableRefObject<HTMLDivElement | null>;
  mapViewActive: boolean;
  numberCellOutlineStyle: NumberCellOutlineStyle;
  openVisitListPanel: (mapTab: string) => void;
  onCloseUiSettingsPanel: () => void;
  onToggleUiSettingsPanel: () => void;
  purchaseStatusControlMode: PurchaseStatusControlMode;
  searchKeyword: string;
  selectedItemIds: Set<string>;
  executeSpaceGroupingEnabled: boolean;
  onShowEventList: () => void;
  onShowImport: (eventName: string | null) => void;
  onToggleEventSurface: () => void;
  setBlockDefinitionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setExecuteCollapsedSpaces: React.Dispatch<React.SetStateAction<Set<string>>>;
  setExecuteSpaceGroupingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setGlobalHallOrderPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setHallDefinitionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setItemToEdit: React.Dispatch<React.SetStateAction<ShoppingItem | null>>;
  setLayoutMode: React.Dispatch<React.SetStateAction<LayoutMode>>;
  setMapHallSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMapIsHallOrderOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMapIsRouteVisible: React.Dispatch<React.SetStateAction<boolean>>;
  setMapSelectedHallId: React.Dispatch<React.SetStateAction<string>>;
  setMapSmartInsertEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setMapSmartInsertMode: React.Dispatch<React.SetStateAction<SmartInsertMode>>;
  setMapTabMenuOpen: React.Dispatch<React.SetStateAction<string | null>>;
  setMapTabMenuPosition: React.Dispatch<
    React.SetStateAction<MapTabMenuPosition>
  >;
  setDisablePriceUndefinedCheck: React.Dispatch<React.SetStateAction<boolean>>;
  setDisableLimitedPurchaseQuantityCheck: React.Dispatch<
    React.SetStateAction<boolean>
  >;
  setSkipLimitedPurchaseForSingleQuantity: React.Dispatch<
    React.SetStateAction<boolean>
  >;
  setPostEventDistributionCheckEnabled: React.Dispatch<
    React.SetStateAction<boolean>
  >;
  setNumberCellOutlineStyle: React.Dispatch<
    React.SetStateAction<NumberCellOutlineStyle>
  >;
  setPurchaseStatusControlMode: React.Dispatch<
    React.SetStateAction<PurchaseStatusControlMode>
  >;
  setSearchKeyword: React.Dispatch<React.SetStateAction<string>>;
  setSelectedBlockFilters: React.Dispatch<React.SetStateAction<Set<string>>>;
  setSimpleHallDefinitionMode: React.Dispatch<React.SetStateAction<boolean>>;
  setThemeMode: React.Dispatch<React.SetStateAction<ThemeMode>>;
  setUiVisibilitySettings: React.Dispatch<
    React.SetStateAction<UIVisibilitySettings>
  >;
  showHeaderBar: boolean;
  showMoveButtons: boolean;
  showSmartInsertToast: (message: string, type?: "success" | "error") => void;
  showTabBar: boolean;
  smartInsertLongPressRef: React.MutableRefObject<ReturnType<
    typeof setTimeout
  > | null>;
  smartInsertLongPressTriggeredRef: React.MutableRefObject<boolean>;
  sortLabels: Record<SortState, string>;
  sortDisplayLabel: string;
  sortState: SortState;
  TabButton: React.FC<TabButtonProps>;
  themeMode: ThemeMode;
  uiSettingsPanelOpen: boolean;
  uiVisibilitySettings: UIVisibilitySettings;
  updateUIVisibilityConfig: (
    key: UIVisibilityModeKey,
    field: "header" | "tabBar",
    value: boolean,
  ) => void;
  visibleSearchMatches: string[];
  zoomLevel: number;
};

const AppHeaderShell: React.FC<AppHeaderShellProps> = (props) => {
  const {
    activeEventDate,
    activeEventName,
    activeTab,
    blockSortDirection,
    currentHalls,
    currentMapData,
    currentMapTabName,
    currentMapTabRotationState,
    currentMode,
    currentSearchIndex,
    DEFAULT_OUTLINE_STYLE,
    DEFAULT_PURCHASE_STATUS_CONTROL_MODE,
    DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY,
    DEFAULT_UI_VISIBILITY,
    disablePriceUndefinedCheck,
    disableLimitedPurchaseQuantityCheck,
    skipLimitedPurchaseForSingleQuantity,
    postEventDistributionCheckEnabled,
    eventDates,
    getHallExecuteCount,
    getHallTotalItemCount,
    getMapTabForDate,
    globalHallOrderHalls,
    globalHallOrderMapTabName,
    handleBlockSortToggle,
    handleBlockSortToggleCandidate,
    handleBulkSort,
    handleClearRangeSelection,
    handleClearSelection,
    handleMapTabRotationAngleChange,
    handleMoveToExecuteColumn,
    handleRemoveFromExecuteColumn,
    handleSearchNext,
    handleSetViewMode,
    handleSortToggle,
    handleZoomChange,
    hasCandidateSelection,
    hasExecuteSelection,
    candidateMovePlan,
    executeMovePlan,
    hasUndefinedPriorityItems,
    isMapTab,
    items,
    layoutMode,
    mainContentVisible,
    mapHallSelectorOpen,
    mapIsRouteVisible,
    mapSelectedHallId,
    mapSmartInsertEnabled,
    mapSmartInsertMode,
    mapTabMenuOpen,
    mapToggleButtonRef,
    mapToggleLongPressFiredRef,
    mapToggleLongPressRef,
    mapToggleMenuRef,
    mapViewActive,
    numberCellOutlineStyle,
    openVisitListPanel,
    onCloseUiSettingsPanel,
    onToggleUiSettingsPanel,
    purchaseStatusControlMode,
    searchKeyword,
    selectedItemIds,
    executeSpaceGroupingEnabled,
    onShowEventList,
    onShowImport,
    onToggleEventSurface,
    setBlockDefinitionMode,
    setExecuteCollapsedSpaces,
    setExecuteSpaceGroupingEnabled,
    setGlobalHallOrderPanelOpen,
    setHallDefinitionMode,
    setItemToEdit,
    setLayoutMode,
    setMapHallSelectorOpen,
    setMapIsHallOrderOpen,
    setMapIsRouteVisible,
    setMapSelectedHallId,
    setMapSmartInsertEnabled,
    setMapSmartInsertMode,
    setMapTabMenuOpen,
    setDisablePriceUndefinedCheck,
    setDisableLimitedPurchaseQuantityCheck,
    setSkipLimitedPurchaseForSingleQuantity,
    setPostEventDistributionCheckEnabled,
    setNumberCellOutlineStyle,
    setPurchaseStatusControlMode,
    setSearchKeyword,
    setSelectedBlockFilters,
    setSimpleHallDefinitionMode,
    setThemeMode,
    setUiVisibilitySettings,
    showHeaderBar,
    showMoveButtons,
    showSmartInsertToast,
    showTabBar,
    smartInsertLongPressRef,
    smartInsertLongPressTriggeredRef,
    sortDisplayLabel,
    TabButton,
    themeMode,
    uiSettingsPanelOpen,
    uiVisibilitySettings,
    updateUIVisibilityConfig,
    visibleSearchMatches,
    zoomLevel,
  } = props;

  React.useEffect(() => {
    if (!uiSettingsPanelOpen) return;
    return acquireBodyScrollLock({ lockTouchAction: true });
  }, [uiSettingsPanelOpen]);

  const stopUiSettingsBackgroundScroll = (
    e: React.WheelEvent | React.TouchEvent,
  ) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const stopUiSettingsPanelPropagation = (
    e: React.WheelEvent | React.TouchEvent | React.MouseEvent,
  ) => {
    e.stopPropagation();
  };

  return (
    <>
      {(showHeaderBar || showTabBar) && (
        <header
          className={`bg-white dark:bg-slate-800 shadow-sm sticky top-0 ${
            uiSettingsPanelOpen ? "z-[80]" : "z-10"
          }`}
        >
          {showHeaderBar && (
            <div className="max-w-7xl mx-auto py-2 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-lg font-bold text-slate-900 dark:text-white truncate max-w-[200px]">
                    {activeEventName || "即売会購入巡回表"}
                  </h1>
                  {activeEventName &&
                    mainContentVisible &&
                    items.length > 0 &&
                    currentMode === "execute" && (
                      <button
                        onClick={handleBlockSortToggle}
                        className={`p-2 rounded-md transition-colors duration-200 ${
                          blockSortDirection
                            ? "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300"
                            : "bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400"
                        }`}
                        title={
                          blockSortDirection === "desc"
                            ? "ブロックを降順で並べ替え"
                            : blockSortDirection === "asc"
                              ? "ブロックを昇順で並べ替え"
                              : "ブロック番号で並べ替え"
                        }
                      >
                        {blockSortDirection === "desc" ? (
                          <SortDescendingIcon className="w-5 h-5" />
                        ) : (
                          <SortAscendingIcon className="w-5 h-5" />
                        )}
                      </button>
                    )}
                  {activeEventName &&
                    mainContentVisible &&
                    items.length > 0 &&
                    currentMode === "edit" && (
                      <button
                        onClick={handleBlockSortToggleCandidate}
                        className={`p-2 rounded-md transition-colors duration-200 ${
                          blockSortDirection
                            ? "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300"
                            : "bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400"
                        }`}
                        title={
                          blockSortDirection === "desc"
                            ? "候補ブロックを降順で並べ替え"
                            : blockSortDirection === "asc"
                              ? "候補ブロックを昇順で並べ替え"
                              : "候補ブロックを番号で並べ替え"
                        }
                      >
                        {blockSortDirection === "desc" ? (
                          <SortDescendingIcon className="w-5 h-5" />
                        ) : (
                          <SortAscendingIcon className="w-5 h-5" />
                        )}
                      </button>
                    )}
                  {activeEventName &&
                    mainContentVisible &&
                    !globalHallOrderMapTabName && (
                      <button
                        onClick={() => setSimpleHallDefinitionMode(true)}
                        className="p-2 rounded-md bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400 transition-colors duration-200"
                        title="ホール定義（ブロック割当）"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M2 12L12 6l10 6M4 12v6h16v-6"
                          />
                        </svg>
                      </button>
                    )}
                  {activeEventName &&
                    mainContentVisible &&
                    !mapViewActive &&
                    (globalHallOrderMapTabName ||
                      globalHallOrderHalls.length > 0 ||
                      hasUndefinedPriorityItems) && (
                      <button
                        onClick={() => setGlobalHallOrderPanelOpen(true)}
                        className="p-2 rounded-md bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400 transition-colors duration-200"
                        title="ホール間移動順序"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          className="w-5 h-5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        </svg>
                      </button>
                    )}
                  {activeEventName &&
                    mainContentVisible &&
                    getMapTabForDate(activeEventDate || "") && (
                      <div className="relative">
                        <button
                          ref={mapToggleButtonRef}
                          onClick={() => {
                            if (mapToggleLongPressFiredRef.current) {
                              mapToggleLongPressFiredRef.current = false;
                              return;
                            }
                            onToggleEventSurface();
                          }}
                          onPointerDown={() => {
                            if (!mapViewActive) return;
                            mapToggleLongPressRef.current = window.setTimeout(
                              () => {
                                mapToggleLongPressFiredRef.current = true;
                                setMapTabMenuOpen("mapToggle");
                                mapToggleLongPressRef.current = null;
                              },
                              500,
                            );
                          }}
                          onPointerUp={() => {
                            if (mapToggleLongPressRef.current) {
                              clearTimeout(mapToggleLongPressRef.current);
                              mapToggleLongPressRef.current = null;
                            }
                          }}
                          onPointerCancel={() => {
                            if (mapToggleLongPressRef.current) {
                              clearTimeout(mapToggleLongPressRef.current);
                              mapToggleLongPressRef.current = null;
                            }
                          }}
                          className={`p-2 rounded-md transition-colors duration-200 ${
                            mapViewActive
                              ? "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300"
                              : "bg-white dark:bg-slate-700 hover:bg-slate-100 dark:hover:bg-slate-600 text-slate-500 dark:text-slate-400"
                          }`}
                          title={
                            mapViewActive
                              ? "リスト表示に切り替え"
                              : "マップ表示に切り替え"
                          }
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l5.447 2.724A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"
                            />
                          </svg>
                        </button>
                        {mapTabMenuOpen === "mapToggle" && (
                          <div
                            ref={mapToggleMenuRef}
                            className="absolute left-1/2 top-[calc(100%+0.25rem)] z-50 min-w-[160px] -translate-x-1/2 rounded-lg border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-800"
                          >
                            <div className="py-1">
                              <button
                                onClick={() => {
                                  setMapTabMenuOpen(null);
                                  if (currentMapTabName)
                                    openVisitListPanel(currentMapTabName);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                              >
                                <span>📍</span> 訪問リスト
                              </button>
                              <button
                                onClick={() => {
                                  setMapTabMenuOpen(null);
                                  setBlockDefinitionMode(true);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                              >
                                <span>🔲</span> ブロック定義
                              </button>
                              <button
                                onClick={() => {
                                  setMapTabMenuOpen(null);
                                  setHallDefinitionMode(true);
                                }}
                                className="w-full text-left px-4 py-2 text-sm text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 flex items-center gap-2"
                              >
                                <span>🏛️</span> ホール定義
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  {/* 表示処理の補足 */}
                  <div className="relative">
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleUiSettingsPanel();
                      }}
                      className={`min-h-11 min-w-11 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                        uiSettingsPanelOpen
                          ? "bg-slate-200 dark:bg-slate-700"
                          : "hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600"
                      }`}
                      title="表示項目の設定"
                      type="button"
                    >
                      <svg
                        className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                    </button>

                    {/* 表示処理の補足 */}
                    {uiSettingsPanelOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={onCloseUiSettingsPanel}
                          onTouchMove={stopUiSettingsBackgroundScroll}
                          onWheel={stopUiSettingsBackgroundScroll}
                        />
                        <div
                          className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] left-3 right-3 top-[calc(env(safe-area-inset-top)+4.5rem)] z-50 overflow-y-auto overscroll-contain rounded-lg border border-slate-200 bg-white p-4 shadow-lg dark:border-slate-700 dark:bg-slate-800 sm:absolute sm:bottom-auto sm:left-0 sm:right-auto sm:top-full sm:mt-1 sm:max-h-[70vh] sm:min-w-[320px]"
                          onClick={stopUiSettingsPanelPropagation}
                          onTouchMove={stopUiSettingsPanelPropagation}
                          onWheel={stopUiSettingsPanelPropagation}
                        >
                          {/* テーマ切替 */}
                          <div className="mb-3 flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                              テーマ
                            </span>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setThemeMode((prev) => {
                                  const next =
                                    prev === "system"
                                      ? "light"
                                      : prev === "light"
                                        ? "dark"
                                        : "system";
                                  return next;
                                });
                              }}
                              className="touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors hover:bg-slate-200 active:bg-slate-300 dark:hover:bg-slate-700 dark:active:bg-slate-600"
                              title={
                                themeMode === "system"
                                  ? "システム設定 → ライトモードへ"
                                  : themeMode === "light"
                                    ? "ライトモード → ダークモードへ"
                                    : "ダークモード → システム設定へ"
                              }
                              type="button"
                            >
                              {themeMode === "system" ? (
                                <svg
                                  className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                                  />
                                </svg>
                              ) : themeMode === "light" ? (
                                <svg
                                  className="w-5 h-5 text-amber-500 pointer-events-none"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                                  />
                                </svg>
                              ) : (
                                <svg
                                  className="w-5 h-5 text-indigo-400 pointer-events-none"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                                  />
                                </svg>
                              )}
                            </button>
                          </div>

                          {/* レイアウト切替 */}
                          <div className="mb-3 pb-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                              レイアウト
                            </span>
                            <button
                              onClick={() =>
                                setLayoutMode(
                                  layoutMode === "pc" ? "smartphone" : "pc",
                                )
                              }
                              className={`touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                                layoutMode === "smartphone"
                                  ? "bg-blue-600 text-white"
                                  : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
                              }`}
                              title={
                                layoutMode === "pc"
                                  ? "スマートフォンモードに切替"
                                  : "タブレット/PCモードに切替"
                              }
                              type="button"
                            >
                              {layoutMode === "smartphone" ? (
                                <svg
                                  className="w-5 h-5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"
                                  />
                                </svg>
                              ) : (
                                <svg
                                  className="w-5 h-5"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                                  />
                                </svg>
                              )}
                            </button>
                          </div>

                          <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-3 dark:border-slate-700">
                            <label
                              htmlFor="app-display-zoom"
                              className="text-xs font-semibold text-slate-700 dark:text-slate-300"
                            >
                              画面の表示倍率
                            </label>
                            <select
                              id="app-display-zoom"
                              value={zoomLevel}
                              onChange={(event) =>
                                handleZoomChange(Number(event.target.value))
                              }
                              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
                            >
                              {APP_ZOOM_OPTIONS.map((zoom) => (
                                <option key={zoom} value={zoom}>
                                  {zoom}%
                                </option>
                              ))}
                            </select>
                          </div>

                          <div className="mb-3 border-b border-slate-200 pb-3 dark:border-slate-700">
                            <label className="flex cursor-pointer items-start gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={
                                  uiVisibilitySettings.showPersistenceStatus
                                }
                                onChange={(event) => {
                                  const { checked } = event.target;
                                  setUiVisibilitySettings((previous) => ({
                                    ...previous,
                                    showPersistenceStatus: checked,
                                  }));
                                }}
                                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                              />
                              <span className="flex-1">
                                <span className="block font-semibold text-slate-700 dark:text-slate-300">
                                  保存状態を表示
                                </span>
                                <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-400">
                                  右下に「未保存」「保存中」「保存済み」を表示します（保存失敗は常に表示）
                                </span>
                              </span>
                            </label>
                          </div>

                          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-3">
                            ヘッダー/タブバー表示設定
                          </h3>

                          {/* 表示処理の補足 */}
                          <div className="mb-3">
                            <h4 className="text-xs font-semibold text-purple-600 dark:text-purple-400 mb-2">
                              集中モード
                            </h4>
                            <div className="space-y-2">
                              {(
                                [
                                  ["focus_sp_mapOn", "スマホ・マップ表示"],
                                  ["focus_sp_mapOff", "スマホ・マップ非表示"],
                                  ["focus_pc_mapOn", "パソコン・マップ表示"],
                                  ["focus_pc_mapOff", "パソコン・マップ非表示"],
                                ] as [UIVisibilityModeKey, string][]
                              ).map(([key, label]) => (
                                <div
                                  key={String(key)}
                                  className="flex items-center justify-between text-xs"
                                >
                                  <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">
                                    {label}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={
                                          uiVisibilitySettings[key].header
                                        }
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(
                                            key,
                                            "header",
                                            e.target.checked,
                                          )
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        ヘッダー
                                      </span>
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={
                                          uiVisibilitySettings[key].tabBar
                                        }
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(
                                            key,
                                            "tabBar",
                                            e.target.checked,
                                          )
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        タブバー
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* 表示処理の補足 */}
                          <div className="mb-3">
                            <h4 className="text-xs font-semibold text-green-600 dark:text-green-400 mb-2">
                              実行モード
                            </h4>
                            <div className="space-y-2">
                              {(
                                [
                                  ["execute_sp", "スマートフォン"],
                                  ["execute_pc", "パソコン / タブレット"],
                                ] as [UIVisibilityModeKey, string][]
                              ).map(([key, label]) => (
                                <div
                                  key={String(key)}
                                  className="flex items-center justify-between text-xs"
                                >
                                  <span className="text-slate-600 dark:text-slate-400 min-w-[110px]">
                                    {label}
                                  </span>
                                  <div className="flex items-center gap-3">
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={
                                          uiVisibilitySettings[key].header
                                        }
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(
                                            key,
                                            "header",
                                            e.target.checked,
                                          )
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        ヘッダー
                                      </span>
                                    </label>
                                    <label className="flex items-center gap-1 cursor-pointer">
                                      <input
                                        type="checkbox"
                                        checked={
                                          uiVisibilitySettings[key].tabBar
                                        }
                                        onChange={(e) =>
                                          updateUIVisibilityConfig(
                                            key,
                                            "tabBar",
                                            e.target.checked,
                                          )
                                        }
                                        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                      />
                                      <span className="text-slate-500 dark:text-slate-400">
                                        タブバー
                                      </span>
                                    </label>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* セル輪郭スタイル */}
                          <div className="mb-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                            <h4 className="text-xs font-semibold text-orange-600 dark:text-orange-400 mb-2">
                              セル輪郭スタイル
                            </h4>
                            <div className="space-y-1">
                              {(
                                [
                                  ["rounded", "角丸（デフォルト）"],
                                  ["square", "直角"],
                                  ["dashed", "破線"],
                                  ["none", "輪郭なし"],
                                ] as [NumberCellOutlineStyle, string][]
                              ).map(([value, label]) => (
                                <label
                                  key={value}
                                  className="flex items-center gap-2 cursor-pointer text-xs"
                                >
                                  <input
                                    type="radio"
                                    name="numberCellOutlineStyle"
                                    value={value}
                                    checked={numberCellOutlineStyle === value}
                                    onChange={() =>
                                      setNumberCellOutlineStyle(value)
                                    }
                                    className="text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                                  />
                                  <span className="text-slate-600 dark:text-slate-400">
                                    {label}
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>

                          {/* 購入管理 */}
                          <div className="mb-3 pt-3 border-t border-slate-200 dark:border-slate-700">
                            <h4 className="text-xs font-semibold text-rose-600 dark:text-rose-400 mb-2">
                              購入管理
                            </h4>
                            <label className="flex items-start gap-2 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={disablePriceUndefinedCheck}
                                onChange={(e) =>
                                  setDisablePriceUndefinedCheck(
                                    e.target.checked,
                                  )
                                }
                                className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                              />
                              <span className="flex-1">
                                <span className="block text-slate-700 dark:text-slate-300">
                                  価格未定チェックを無効化
                                </span>
                                <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                                  ON
                                  にすると、購入済みで価格未定のアイテムがあっても次のスペースへ進めます（視覚警告は表示）
                                </span>
                              </span>
                            </label>
                            <label className="mt-2 flex items-start gap-2 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={disableLimitedPurchaseQuantityCheck}
                                onChange={(e) =>
                                  setDisableLimitedPurchaseQuantityCheck(
                                    e.target.checked,
                                  )
                                }
                                className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                              />
                              <span className="flex-1">
                                <span className="block text-slate-700 dark:text-slate-300">
                                  限数未入力チェックを無効化
                                </span>
                                <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                                  ON
                                  にすると、限数の実購入数が未入力でも次のスペースへ進めます
                                </span>
                              </span>
                            </label>
                            <label className="mt-2 flex items-start gap-2 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={skipLimitedPurchaseForSingleQuantity}
                                onChange={(e) =>
                                  setSkipLimitedPurchaseForSingleQuantity(
                                    e.target.checked,
                                  )
                                }
                                className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                              />
                              <span className="flex-1">
                                <span className="block text-slate-700 dark:text-slate-300">
                                  数量1の限数スキップを有効化
                                </span>
                                <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                                  ON
                                  にすると、数量1の新規限数入力を購入済み扱いの導線に寄せます
                                </span>
                              </span>
                            </label>
                            <label className="mt-2 flex items-start gap-2 cursor-pointer text-xs">
                              <input
                                type="checkbox"
                                checked={postEventDistributionCheckEnabled}
                                onChange={(e) =>
                                  setPostEventDistributionCheckEnabled(
                                    e.target.checked,
                                  )
                                }
                                className="mt-0.5 rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                              />
                              <span className="flex-1">
                                <span className="block text-slate-700 dark:text-slate-300">
                                  事後通販･頒布可否確認を有効化
                                </span>
                                <span className="block text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                                  ON
                                  にすると、売切へ変更した時に確認結果を備考へ記録できます
                                </span>
                              </span>
                            </label>
                            <PurchaseStatusControlModeSettings
                              purchaseStatusControlMode={
                                purchaseStatusControlMode
                              }
                              setPurchaseStatusControlMode={
                                setPurchaseStatusControlMode
                              }
                            />
                          </div>

                          <SpaceNavigatorSettingsPanel />

                          {/* 表示処理の補足 */}
                          <DisplaySettingsResetButton
                            DEFAULT_OUTLINE_STYLE={DEFAULT_OUTLINE_STYLE}
                            DEFAULT_PURCHASE_STATUS_CONTROL_MODE={
                              DEFAULT_PURCHASE_STATUS_CONTROL_MODE
                            }
                            DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY={
                              DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY
                            }
                            DEFAULT_UI_VISIBILITY={DEFAULT_UI_VISIBILITY}
                            setDisablePriceUndefinedCheck={
                              setDisablePriceUndefinedCheck
                            }
                            setDisableLimitedPurchaseQuantityCheck={
                              setDisableLimitedPurchaseQuantityCheck
                            }
                            setSkipLimitedPurchaseForSingleQuantity={
                              setSkipLimitedPurchaseForSingleQuantity
                            }
                            setNumberCellOutlineStyle={
                              setNumberCellOutlineStyle
                            }
                            setPurchaseStatusControlMode={
                              setPurchaseStatusControlMode
                            }
                            setUiVisibilitySettings={setUiVisibilitySettings}
                            setZoomLevel={handleZoomChange}
                          />
                        </div>
                      </>
                    )}
                  </div>

                  {/* 表示処理の補足 */}
                  {activeEventName && mainContentVisible && !mapViewActive && (
                    <div className="flex items-center gap-1 ml-2 border-l border-slate-300 dark:border-slate-600 pl-2">
                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => handleSetViewMode("edit")}
                        className={`min-h-10 min-w-10 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                          currentMode === "edit"
                            ? "bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-400"
                            : "hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400"
                        }`}
                        title="編集モード"
                        type="button"
                      >
                        <span className="text-lg">📝</span>
                      </button>

                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => handleSetViewMode("execute")}
                        className={`min-h-10 min-w-10 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                          currentMode === "execute"
                            ? "bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400"
                            : "hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400"
                        }`}
                        title="実行モード"
                        type="button"
                      >
                        <span className="text-lg">🏃‍♂️</span>
                      </button>

                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => handleSetViewMode("focus")}
                        className={`min-h-10 min-w-10 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                          currentMode === "focus"
                            ? "bg-purple-100 dark:bg-purple-900/50 text-purple-600 dark:text-purple-400"
                            : "hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400"
                        }`}
                        title="集中モード"
                        type="button"
                      >
                        <span className="text-lg">🔍</span>
                      </button>
                    </div>
                  )}

                  {/* 表示処理の補足 */}
                  {activeEventName && isMapTab && currentMapData && (
                    <>
                      {currentHalls.length > 0 && (
                        <>
                          {/* 表示処理の補足 */}
                          <div className="relative">
                            <button
                              onClick={() =>
                                setMapHallSelectorOpen(!mapHallSelectorOpen)
                              }
                              className={`min-h-11 min-w-11 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                                mapHallSelectorOpen
                                  ? "bg-slate-200 dark:bg-slate-700"
                                  : "hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600"
                              }`}
                              title={`表示ホール: ${mapSelectedHallId === "all" ? "全ホール" : currentHalls.find((h) => h.id === mapSelectedHallId)?.name || ""}`}
                              type="button"
                            >
                              {/* 表示処理の補足 */}
                              <svg
                                className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                              >
                                <path d="M2 18h3v-4h2v4h2v-6H7l-2-4-2 4H2v6zm5-8h2V8h2V6h2v2h2v2h2v8h-3v-4h-2v4h-3v-8z" />
                                <path d="M14 10h2v2h-2zM14 14h2v2h-2zM18 10h2v2h-2zM18 14h2v2h-2z" />
                              </svg>
                            </button>
                            {mapSelectedHallId !== "all" && (
                              <span className="absolute -top-1 -right-1 w-3 h-3 bg-blue-500 rounded-full"></span>
                            )}

                            {/* 表示処理の補足 */}
                            {mapHallSelectorOpen && (
                              <>
                                {/* 表示処理の補足 */}
                                <div
                                  className="fixed inset-0 z-40"
                                  onClick={() => setMapHallSelectorOpen(false)}
                                />
                                <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-slate-800 rounded-lg shadow-lg border border-slate-200 dark:border-slate-700 py-1 min-w-[200px]">
                                  <button
                                    onClick={() => {
                                      setMapSelectedHallId("all");
                                      setMapHallSelectorOpen(false);
                                    }}
                                    className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                                      mapSelectedHallId === "all"
                                        ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                                        : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                                    }`}
                                  >
                                    全ホール
                                  </button>
                                  {currentHalls.map((hall) => {
                                    const executeCount = getHallExecuteCount(
                                      hall.id,
                                    );
                                    const totalCount = getHallTotalItemCount(
                                      hall.id,
                                    );
                                    return (
                                      <button
                                        key={hall.id}
                                        onClick={() => {
                                          setMapSelectedHallId(hall.id);
                                          setMapHallSelectorOpen(false);
                                        }}
                                        className={`w-full px-4 py-2 text-left text-sm transition-colors flex justify-between items-center ${
                                          mapSelectedHallId === hall.id
                                            ? "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300"
                                            : "text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
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

                          {/* 表示処理の補足 */}
                          <button
                            onClick={() => setMapIsHallOrderOpen(true)}
                            className="min-h-11 min-w-11 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors hover:bg-slate-200 active:bg-slate-300 dark:hover:bg-slate-700 dark:active:bg-slate-600"
                            title="ホール順を編集"
                            type="button"
                          >
                            <svg
                              className="w-5 h-5 text-slate-600 dark:text-slate-400 pointer-events-none"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                              />
                            </svg>
                          </button>
                        </>
                      )}

                      {/* 表示処理の補足 */}
                      <button
                        onClick={() => setMapIsRouteVisible(!mapIsRouteVisible)}
                        className={`min-h-11 min-w-11 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                          mapIsRouteVisible
                            ? "bg-blue-100 dark:bg-blue-900/50 hover:bg-blue-200 dark:hover:bg-blue-800"
                            : "hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600"
                        }`}
                        title={
                          mapIsRouteVisible
                            ? "ルート表示: 有効"
                            : "ルート表示: 無効"
                        }
                        type="button"
                      >
                        {/* 表示処理の補足 */}
                        <svg
                          className={`w-5 h-5 pointer-events-none ${mapIsRouteVisible ? "text-blue-600 dark:text-blue-400" : "text-slate-600 dark:text-slate-400"}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <circle cx="6" cy="6" r="2" strokeWidth={2} />
                          <circle cx="18" cy="18" r="2" strokeWidth={2} />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 8v4a4 4 0 004 4h4M14 12l4 4m0 0l-4 4"
                          />
                        </svg>
                      </button>

                      {/* 表示処理の補足 */}
                      <button
                        onPointerDown={() => {
                          smartInsertLongPressTriggeredRef.current = false;
                          smartInsertLongPressRef.current = setTimeout(() => {
                            smartInsertLongPressTriggeredRef.current = true;
                            const newMode =
                              mapSmartInsertMode === "map" ? "preview" : "map";
                            setMapSmartInsertMode(newMode);
                            showSmartInsertToast(
                              newMode === "preview"
                                ? "プレビューモードに切り替え"
                                : "マップ選択モードに切り替え",
                            );
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
                        className={`relative min-h-11 min-w-11 touch-manipulation select-none rounded-md p-2 [-webkit-tap-highlight-color:transparent] transition-colors ${
                          mapSmartInsertEnabled
                            ? "bg-green-100 dark:bg-green-900/50 hover:bg-green-200 dark:hover:bg-green-800"
                            : "hover:bg-slate-200 dark:hover:bg-slate-700 active:bg-slate-300 dark:active:bg-slate-600"
                        }`}
                        title={`スマート挿入: ${mapSmartInsertEnabled ? "有効" : "無効"}（${mapSmartInsertMode === "map" ? "マップ" : "プレビュー"}）`}
                        type="button"
                      >
                        <svg
                          className={`w-5 h-5 pointer-events-none ${mapSmartInsertEnabled ? "text-green-600 dark:text-green-400" : "text-slate-600 dark:text-slate-400"}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 4v16m0-8l-4-4m4 4l4-4"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 12h14"
                          />
                        </svg>
                        {/* 表示処理の補足 */}
                        {mapSmartInsertEnabled && (
                          <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 text-[8px] font-bold leading-none text-green-600 dark:text-green-400">
                            {mapSmartInsertMode === "preview" ? "P" : "M"}
                          </div>
                        )}
                      </button>
                    </>
                  )}
                  {activeEventName && isMapTab && currentMapData && (
                    <MapRotationControls
                      angle={currentMapTabRotationState.mapTabAngle}
                      initialAngle={currentMapTabRotationState.initialAngle}
                      onAngleChange={handleMapTabRotationAngleChange}
                      showHint={true}
                    />
                  )}
                </div>
              </div>
              <div className="flex items-center gap-4">
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  layoutMode !== "smartphone" &&
                  selectedItemIds.size > 0 && (
                    <>
                      <BulkActionControls
                        onSort={handleBulkSort}
                        onClear={handleClearSelection}
                      />
                      {showMoveButtons && hasCandidateSelection && (
                        <button
                          onClick={() =>
                            handleMoveToExecuteColumn(
                              candidateMovePlan.requested,
                            )
                          }
                          className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                        >
                          選択したアイテムを実行列に移動 (
                          {formatMovePlanCount(candidateMovePlan)})
                        </button>
                      )}
                      {showMoveButtons && hasExecuteSelection && (
                        <button
                          onClick={() =>
                            handleRemoveFromExecuteColumn(
                              executeMovePlan.requested,
                            )
                          }
                          className="px-3 py-1.5 text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 transition-colors flex-shrink-0"
                        >
                          選択したアイテムを実行列から戻す (
                          {formatMovePlanCount(executeMovePlan)})
                        </button>
                      )}
                    </>
                  )}
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  currentMode === "execute" && (
                    <button
                      onClick={handleSortToggle}
                      className="px-3 py-1.5 text-sm font-medium rounded-md transition-colors duration-200 text-blue-600 bg-blue-100 hover:bg-blue-200 dark:text-blue-300 dark:bg-blue-900/50 dark:hover:bg-blue-900 flex-shrink-0"
                    >
                      {sortDisplayLabel}
                    </button>
                  )}
                {activeEventName &&
                  mainContentVisible &&
                  items.length > 0 &&
                  currentMode === "execute" &&
                  layoutMode !== "smartphone" && (
                    <button
                      onClick={() => {
                        setExecuteSpaceGroupingEnabled((prev) => !prev);
                        setExecuteCollapsedSpaces(new Set());
                        handleClearRangeSelection();
                      }}
                      className={`px-2 py-1 text-xs font-medium rounded transition-colors flex-shrink-0 ${
                        executeSpaceGroupingEnabled
                          ? "bg-blue-600 text-white dark:bg-blue-600"
                          : "bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600"
                      }`}
                    >
                      スペース別
                    </button>
                  )}
              </div>
            </div>
          )}
          {showTabBar && (
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-slate-200 dark:border-slate-700">
              <div className="flex space-x-2 pt-2 pb-2 overflow-x-auto">
                <TabButton
                  tab="eventList"
                  label="イベント一覧"
                  onClick={() => {
                    setItemToEdit(null);
                    handleClearSelection();
                    setSelectedBlockFilters(new Set());
                    onShowEventList();
                  }}
                />
                {activeEventName ? (
                  <>
                    {eventDates.map((eventDate) => {
                      const count = items.filter(
                        (item) => item.eventDate === eventDate,
                      ).length;
                      return (
                        <React.Fragment key={eventDate}>
                          <TabButton
                            tab={eventDate}
                            label={eventDate}
                            count={count}
                          />
                        </React.Fragment>
                      );
                    })}
                    <TabButton tab="import" label={"アイテム追加"} />
                    {activeEventName && (mainContentVisible || isMapTab) && (
                      <SearchBar
                        searchKeyword={searchKeyword}
                        onSearchKeywordChange={setSearchKeyword}
                        onSearchNext={handleSearchNext}
                        matchCount={visibleSearchMatches.length}
                        currentMatchIndex={currentSearchIndex}
                      />
                    )}
                    {activeEventName &&
                      mainContentVisible &&
                      currentMode === "execute" &&
                      layoutMode === "smartphone" && (
                        <button
                          onClick={() => {
                            setExecuteSpaceGroupingEnabled((prev) => !prev);
                            setExecuteCollapsedSpaces(new Set());
                            handleClearRangeSelection();
                          }}
                          className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap flex-shrink-0 ${
                            executeSpaceGroupingEnabled
                              ? "bg-blue-600 text-white dark:bg-blue-600"
                              : "bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-600 border border-slate-300 dark:border-slate-600"
                          }`}
                        >
                          スペース別
                        </button>
                      )}
                  </>
                ) : (
                  <button
                    onClick={() => {
                      setItemToEdit(null);
                      onShowImport(activeEventName);
                    }}
                    className={`px-4 py-2 text-sm font-medium rounded-md transition-colors duration-200 whitespace-nowrap ${
                      activeTab === "import"
                        ? "bg-blue-600 text-white"
                        : "text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                    }`}
                  >
                    新規リスト作成
                  </button>
                )}
              </div>
            </div>
          )}
        </header>
      )}

      {/* 表示処理の補足 */}
    </>
  );
};

export default AppHeaderShell;
