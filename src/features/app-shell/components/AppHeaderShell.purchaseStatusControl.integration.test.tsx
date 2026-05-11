import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_UI_VISIBILITY } from '../../../hooks/useUIVisibilitySettings';
import AppHeaderShell, {
  DisplaySettingsResetButton,
  PurchaseStatusControlModeSettings,
  type DisplaySettingsResetButtonProps,
  type PurchaseStatusControlModeSettingsProps,
} from './AppHeaderShell';

const renderSettings = (
  overrides: Partial<PurchaseStatusControlModeSettingsProps> = {},
) => {
  const setPurchaseStatusControlMode = vi.fn();
  const props: PurchaseStatusControlModeSettingsProps = {
    purchaseStatusControlMode: 'cycle',
    setPurchaseStatusControlMode,
    ...overrides,
  };

  render(<PurchaseStatusControlModeSettings {...props} />);

  return { setPurchaseStatusControlMode };
};

const minimalAppHeaderShellProps = (): ComponentProps<typeof AppHeaderShell> => ({
  activeEventDate: 'Day1',
  activeEventName: 'Event',
  activeTab: 'Day1',
  blockSortDirection: null,
  currentHalls: [],
  currentMapData: null,
  currentMapTabName: null,
  currentMapTabRotationState: { initialAngle: 0, mapTabAngle: 0, focusModeAngle: 0 },
  currentMode: 'execute',
  currentSearchIndex: -1,
  DEFAULT_OUTLINE_STYLE: 'rounded',
  DEFAULT_PURCHASE_STATUS_CONTROL_MODE: 'cycle',
  DEFAULT_UI_VISIBILITY,
  disablePriceUndefinedCheck: false,
  eventDates: ['Day1'],
  executeSpaceGroupingEnabled: false,
  getHallExecuteCount: vi.fn(() => 0),
  getHallTotalItemCount: vi.fn(() => 0),
  getMapTabForDate: vi.fn(() => null),
  globalHallOrderHalls: [],
  globalHallOrderMapTabName: null,
  handleBlockSortToggle: vi.fn(),
  handleBlockSortToggleCandidate: vi.fn(),
  handleBulkSort: vi.fn(),
  handleClearSelection: vi.fn(),
  handleMapTabRotationAngleChange: vi.fn(),
  handleMoveToExecuteColumn: vi.fn(),
  handleRemoveFromExecuteColumn: vi.fn(),
  handleSearchNext: vi.fn(),
  handleSetViewMode: vi.fn(),
  handleSortToggle: vi.fn(),
  hasCandidateSelection: false,
  hasExecuteSelection: false,
  hasUndefinedPriorityItems: false,
  isMapTab: false,
  items: [],
  itemToEdit: null,
  layoutMode: 'pc',
  mainContentVisible: true,
  mapHallSelectorOpen: false,
  mapIsRouteVisible: false,
  mapSelectedHallId: 'all',
  mapSmartInsertEnabled: false,
  mapSmartInsertMode: 'map',
  mapTabMenuOpen: null,
  mapTabMenuPosition: { left: 0, top: 0 },
  mapToggleButtonRef: { current: null },
  mapToggleLongPressFiredRef: { current: false },
  mapToggleLongPressRef: { current: null },
  mapToggleMenuRef: { current: null },
  mapViewActive: false,
  numberCellOutlineStyle: 'rounded',
  openVisitListPanel: vi.fn(),
  purchaseStatusControlMode: 'cycle',
  searchKeyword: '',
  selectedItemIds: new Set(),
  setActiveEventName: vi.fn(),
  setActiveTab: vi.fn(),
  setBlockDefinitionMode: vi.fn(),
  setExecuteCollapsedSpaces: vi.fn(),
  setExecuteSpaceGroupingEnabled: vi.fn(),
  setGlobalHallOrderPanelOpen: vi.fn(),
  setHallDefinitionMode: vi.fn(),
  setItemToEdit: vi.fn(),
  setLayoutMode: vi.fn(),
  setMapHallSelectorOpen: vi.fn(),
  setMapIsHallOrderOpen: vi.fn(),
  setMapIsRouteVisible: vi.fn(),
  setMapSelectedHallId: vi.fn(),
  setMapSmartInsertEnabled: vi.fn(),
  setMapSmartInsertMode: vi.fn(),
  setMapTabMenuOpen: vi.fn(),
  setMapTabMenuPosition: vi.fn(),
  setMapViewActive: vi.fn(),
  setDisablePriceUndefinedCheck: vi.fn(),
  setNumberCellOutlineStyle: vi.fn(),
  setPurchaseStatusControlMode: vi.fn(),
  setSearchKeyword: vi.fn(),
  setSelectedBlockFilters: vi.fn(),
  setSelectedItemIds: vi.fn(),
  setSimpleHallDefinitionMode: vi.fn(),
  setThemeMode: vi.fn(),
  setUiSettingsPanelOpen: vi.fn(),
  setUiVisibilityOverride: vi.fn(),
  setUiVisibilitySettings: vi.fn(),
  showHeaderBar: true,
  showMoveButtons: false,
  showSmartInsertToast: vi.fn(),
  showTabBar: false,
  smartInsertLongPressRef: { current: null },
  smartInsertLongPressTriggeredRef: { current: false },
  sortLabels: {
    Manual: 'Manual',
    Postpone: 'Postpone',
    Late: 'Late',
    Absent: 'Absent',
    SoldOut: 'SoldOut',
    None: 'None',
    Purchased: 'Purchased',
  },
  sortState: 'Manual',
  TabButton: ({ label }) => <button>{label}</button>,
  themeMode: 'system',
  uiSettingsPanelOpen: true,
  uiVisibilitySettings: DEFAULT_UI_VISIBILITY,
  updateUIVisibilityConfig: vi.fn(),
  visibleSearchMatches: [],
});

describe('PurchaseStatusControlModeSettings', () => {
  it('checks cycle by default', () => {
    renderSettings();

    expect(screen.getByRole('radio', { name: /循環クリック/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /放射状メニュー/ })).not.toBeChecked();
  });

  it('calls setter when radial is selected', () => {
    const { setPurchaseStatusControlMode } = renderSettings();

    fireEvent.click(screen.getByRole('radio', { name: /放射状メニュー/ }));

    expect(setPurchaseStatusControlMode).toHaveBeenCalledWith('radial');
  });

  it('resets purchase status control mode to the default mode', () => {
    const props: DisplaySettingsResetButtonProps = {
      DEFAULT_OUTLINE_STYLE: 'none',
      DEFAULT_PURCHASE_STATUS_CONTROL_MODE: 'cycle',
      DEFAULT_UI_VISIBILITY,
      setDisablePriceUndefinedCheck: vi.fn(),
      setNumberCellOutlineStyle: vi.fn(),
      setPurchaseStatusControlMode: vi.fn(),
      setUiVisibilityOverride: vi.fn(),
      setUiVisibilitySettings: vi.fn(),
    };

    render(<DisplaySettingsResetButton {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'デフォルトに戻す' }));

    expect(props.setPurchaseStatusControlMode).toHaveBeenCalledWith('cycle');
    expect(props.setDisablePriceUndefinedCheck).toHaveBeenCalledWith(false);
    expect(props.setUiVisibilityOverride).toHaveBeenCalledWith(false);
  });
});

describe('AppHeaderShell purchase status settings integration', () => {
  it('renders purchase status control settings inside the real settings panel', () => {
    render(<AppHeaderShell {...minimalAppHeaderShellProps()} />);

    expect(screen.getByRole('radio', { name: /循環クリック/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /放射状メニュー/ })).toBeInTheDocument();
  });
});
