import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UI_VISIBILITY } from "../../../hooks/useUIVisibilitySettings";
import AppHeaderShell, {
  DisplaySettingsResetButton,
  PurchaseStatusControlModeSettings,
  type DisplaySettingsResetButtonProps,
  type PurchaseStatusControlModeSettingsProps,
} from "./AppHeaderShell";

const renderSettings = (
  overrides: Partial<PurchaseStatusControlModeSettingsProps> = {},
) => {
  const setPurchaseStatusControlMode = vi.fn();
  const props: PurchaseStatusControlModeSettingsProps = {
    purchaseStatusControlMode: "cycle",
    setPurchaseStatusControlMode,
    ...overrides,
  };

  render(<PurchaseStatusControlModeSettings {...props} />);

  return { setPurchaseStatusControlMode };
};

const minimalAppHeaderShellProps = (): ComponentProps<
  typeof AppHeaderShell
> => ({
  activeEventDate: "Day1",
  activeEventName: "Event",
  activeTab: "Day1",
  blockSortDirection: null,
  currentHalls: [],
  currentMapData: null,
  currentMapTabName: null,
  currentMapTabRotationState: {
    initialAngle: 0,
    mapTabAngle: 0,
    focusModeAngle: 0,
  },
  currentMode: "execute",
  currentSearchIndex: -1,
  DEFAULT_OUTLINE_STYLE: "rounded",
  DEFAULT_PURCHASE_STATUS_CONTROL_MODE: "cycle",
  DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY: true,
  DEFAULT_UI_VISIBILITY,
  disablePriceUndefinedCheck: false,
  disableLimitedPurchaseQuantityCheck: false,
  skipLimitedPurchaseForSingleQuantity: true,
  postEventDistributionCheckEnabled: true,
  eventDates: ["Day1"],
  executeSpaceGroupingEnabled: false,
  getHallExecuteCount: vi.fn(() => 0),
  getHallTotalItemCount: vi.fn(() => 0),
  getMapTabForDate: vi.fn(() => null),
  globalHallOrderHalls: [],
  globalHallOrderMapTabName: null,
  handleBlockSortToggle: vi.fn(),
  handleBlockSortToggleCandidate: vi.fn(),
  handleBulkSort: vi.fn(),
  handleClearRangeSelection: vi.fn(),
  handleClearSelection: vi.fn(),
  handleMapTabRotationAngleChange: vi.fn(),
  handleMoveToExecuteColumn: vi.fn(),
  handleRemoveFromExecuteColumn: vi.fn(),
  handleSearchNext: vi.fn(),
  handleSetViewMode: vi.fn(),
  handleSortToggle: vi.fn(),
  handleZoomChange: vi.fn(),
  hasCandidateSelection: false,
  hasExecuteSelection: false,
  candidateMovePlan: {
    requested: [],
    effective: [],
    implicit: [],
    excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
  },
  executeMovePlan: {
    requested: [],
    effective: [],
    implicit: [],
    excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
  },
  hasUndefinedPriorityItems: false,
  isMapTab: false,
  items: [],
  itemToEdit: null,
  layoutMode: "pc",
  mainContentVisible: true,
  mapHallSelectorOpen: false,
  mapIsRouteVisible: false,
  mapSelectedHallId: "all",
  mapSmartInsertEnabled: false,
  mapSmartInsertMode: "map",
  mapTabMenuOpen: null,
  mapTabMenuPosition: { left: 0, top: 0 },
  mapToggleButtonRef: { current: null },
  mapToggleLongPressFiredRef: { current: false },
  mapToggleLongPressRef: { current: null },
  mapToggleMenuRef: { current: null },
  mapViewActive: false,
  numberCellOutlineStyle: "rounded",
  openVisitListPanel: vi.fn(),
  onCloseUiSettingsPanel: vi.fn(),
  onToggleUiSettingsPanel: vi.fn(),
  purchaseStatusControlMode: "cycle",
  searchKeyword: "",
  selectedItemIds: new Set(),
  onShowEventList: vi.fn(),
  onShowImport: vi.fn(),
  onToggleEventSurface: vi.fn(),
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
  setDisablePriceUndefinedCheck: vi.fn(),
  setDisableLimitedPurchaseQuantityCheck: vi.fn(),
  setSkipLimitedPurchaseForSingleQuantity: vi.fn(),
  setPostEventDistributionCheckEnabled: vi.fn(),
  setNumberCellOutlineStyle: vi.fn(),
  setPurchaseStatusControlMode: vi.fn(),
  setSearchKeyword: vi.fn(),
  setSelectedBlockFilters: vi.fn(),
  setSimpleHallDefinitionMode: vi.fn(),
  setThemeMode: vi.fn(),
  setUiVisibilitySettings: vi.fn(),
  showHeaderBar: true,
  showMoveButtons: false,
  showSmartInsertToast: vi.fn(),
  showTabBar: false,
  smartInsertLongPressRef: { current: null },
  smartInsertLongPressTriggeredRef: { current: false },
  sortLabels: {
    Manual: "Manual",
    Postpone: "Postpone",
    Late: "Late",
    Absent: "Absent",
    SoldOut: "SoldOut",
    None: "None",
    Purchased: "Purchased",
    LimitedPurchase: "LimitedPurchase",
  },
  sortDisplayLabel: "Manual",
  sortState: "Manual",
  TabButton: ({ label }) => <button>{label}</button>,
  themeMode: "system",
  uiSettingsPanelOpen: true,
  uiVisibilitySettings: DEFAULT_UI_VISIBILITY,
  updateUIVisibilityConfig: vi.fn(),
  visibleSearchMatches: [],
  zoomLevel: 100,
});

describe("PurchaseStatusControlModeSettings", () => {
  it("checks cycle by default", () => {
    renderSettings();

    expect(screen.getByRole("radio", { name: /循環クリック/ })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /放射状メニュー/ }),
    ).not.toBeChecked();
  });

  it("calls setter when radial is selected", () => {
    const { setPurchaseStatusControlMode } = renderSettings();

    fireEvent.click(screen.getByRole("radio", { name: /放射状メニュー/ }));

    expect(setPurchaseStatusControlMode).toHaveBeenCalledWith("radial");
  });

  it("resets purchase status control mode to the default mode", () => {
    const props: DisplaySettingsResetButtonProps = {
      DEFAULT_OUTLINE_STYLE: "none",
      DEFAULT_PURCHASE_STATUS_CONTROL_MODE: "cycle",
      DEFAULT_SKIP_LIMITED_PURCHASE_FOR_SINGLE_QUANTITY: true,
      DEFAULT_UI_VISIBILITY,
      setDisablePriceUndefinedCheck: vi.fn(),
      setDisableLimitedPurchaseQuantityCheck: vi.fn(),
      setSkipLimitedPurchaseForSingleQuantity: vi.fn(),
      setNumberCellOutlineStyle: vi.fn(),
      setPurchaseStatusControlMode: vi.fn(),
      setUiVisibilitySettings: vi.fn(),
      setZoomLevel: vi.fn(),
    };

    render(<DisplaySettingsResetButton {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "デフォルトに戻す" }));

    expect(props.setPurchaseStatusControlMode).toHaveBeenCalledWith("cycle");
    expect(props.setDisablePriceUndefinedCheck).toHaveBeenCalledWith(false);
    expect(props.setDisableLimitedPurchaseQuantityCheck).toHaveBeenCalledWith(
      false,
    );
    expect(props.setZoomLevel).toHaveBeenCalledWith(100);
    expect(props.setUiVisibilitySettings).toHaveBeenCalledWith(
      expect.objectContaining({ showPersistenceStatus: true }),
    );
  });
});

describe("AppHeaderShell purchase status settings integration", () => {
  it("renders purchase status control settings inside the real settings panel", () => {
    render(<AppHeaderShell {...minimalAppHeaderShellProps()} />);

    expect(screen.getByRole("radio", { name: /循環クリック/ })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /放射状メニュー/ }),
    ).toBeInTheDocument();
  });

  it("changes the app zoom from the real settings panel", () => {
    const props = minimalAppHeaderShellProps();
    render(<AppHeaderShell {...props} />);

    const zoomSelect = screen.getByRole("combobox", {
      name: "画面の表示倍率",
    });
    expect(zoomSelect).toHaveValue("100");

    fireEvent.change(zoomSelect, { target: { value: "125" } });

    expect(props.handleZoomChange).toHaveBeenCalledWith(125);
  });

  it("changes the persistence status visibility in the draft settings", () => {
    const props = minimalAppHeaderShellProps();
    render(<AppHeaderShell {...props} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /保存状態を表示/ }));

    expect(props.setUiVisibilitySettings).toHaveBeenCalledOnce();
    const update = vi.mocked(props.setUiVisibilitySettings).mock.calls[0][0];
    expect(typeof update).toBe("function");
    if (typeof update === "function") {
      expect(update(DEFAULT_UI_VISIBILITY)).toEqual(
        expect.objectContaining({ showPersistenceStatus: false }),
      );
    }
  });

  it("keeps visibility edits in the draft until the panel close callback", () => {
    const props = minimalAppHeaderShellProps();
    render(<AppHeaderShell {...props} />);

    fireEvent.click(
      screen.getAllByRole("checkbox", {
        name: "ヘッダー",
      })[0],
    );

    expect(props.updateUIVisibilityConfig).toHaveBeenCalledWith(
      "focus_sp_mapOn",
      "header",
      true,
    );
    expect(props.setUiVisibilitySettings).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector(".fixed.inset-0.z-40")!);
    expect(props.onCloseUiSettingsPanel).toHaveBeenCalledOnce();
  });
});

describe("AppHeaderShell move plan integration", () => {
  it("shows selected and effective candidate counts and submits explicit IDs", () => {
    const props = minimalAppHeaderShellProps();
    props.currentMode = "edit";
    props.uiSettingsPanelOpen = false;
    props.showMoveButtons = true;
    props.hasCandidateSelection = true;
    props.selectedItemIds = new Set(["a", "b"]);
    props.items = [
      {
        id: "a",
        circle: "A",
        eventDate: "Day1",
        block: "A",
        number: "01",
        title: "",
        price: null,
        purchaseStatus: "None",
        quantity: 1,
        remarks: "",
      },
    ];
    props.candidateMovePlan = {
      requested: ["a", "b"],
      effective: ["a", "b", "c"],
      implicit: ["c"],
      excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
    };

    render(<AppHeaderShell {...props} />);

    const moveButton = screen.getByRole("button", {
      name: "選択したアイテムを実行列に移動 (選択2件（移動3件）)",
    });
    fireEvent.click(moveButton);

    expect(props.handleMoveToExecuteColumn).toHaveBeenCalledWith(["a", "b"]);
  });

  it("keeps the concise count when the move plan has no implicit additions", () => {
    const props = minimalAppHeaderShellProps();
    props.currentMode = "edit";
    props.uiSettingsPanelOpen = false;
    props.showMoveButtons = true;
    props.hasExecuteSelection = true;
    props.selectedItemIds = new Set(["a", "b"]);
    props.items = [
      {
        id: "a",
        circle: "A",
        eventDate: "Day1",
        block: "A",
        number: "01",
        title: "",
        price: null,
        purchaseStatus: "None",
        quantity: 1,
        remarks: "",
      },
    ];
    props.executeMovePlan = {
      requested: ["a", "b"],
      effective: ["a", "b"],
      implicit: [],
      excluded: { missing: [], wrongDate: [], notInSourceColumn: [] },
    };

    render(<AppHeaderShell {...props} />);

    expect(
      screen.getByRole("button", {
        name: "選択したアイテムを実行列から戻す (2件)",
      }),
    ).toBeInTheDocument();
  });
});

describe("AppHeaderShell range reset integration", () => {
  it("clears range endpoints when execute grouping changes", () => {
    const props = minimalAppHeaderShellProps();
    props.uiSettingsPanelOpen = false;
    props.items = [
      {
        id: "a",
        circle: "A",
        eventDate: "Day1",
        block: "A",
        number: "01",
        title: "",
        price: null,
        purchaseStatus: "None",
        quantity: 1,
        remarks: "",
      },
    ];

    render(<AppHeaderShell {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "スペース別" }));

    expect(props.handleClearRangeSelection).toHaveBeenCalledOnce();
    expect(props.setExecuteCollapsedSpaces).toHaveBeenCalledWith(new Set());
  });
});

describe("AppHeaderShell typed navigation integration", () => {
  it("routes event-list and map actions through navigation commands", () => {
    const props = minimalAppHeaderShellProps();
    props.uiSettingsPanelOpen = false;
    props.showTabBar = true;
    props.getMapTabForDate = vi.fn(() => "Day1Map");
    props.TabButton = ({ label, onClick }) => (
      <button onClick={onClick}>{label}</button>
    );

    render(<AppHeaderShell {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "イベント一覧" }));
    expect(props.onShowEventList).toHaveBeenCalledOnce();

    fireEvent.click(
      screen.getByRole("button", { name: "マップ表示に切り替え" }),
    );
    expect(props.onToggleEventSurface).toHaveBeenCalledOnce();
  });

  it("routes new-list creation through the typed import command", () => {
    const props = minimalAppHeaderShellProps();
    props.activeEventName = null;
    props.activeTab = "eventList";
    props.mainContentVisible = false;
    props.uiSettingsPanelOpen = false;
    props.showTabBar = true;

    render(<AppHeaderShell {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "新規リスト作成" }));

    expect(props.onShowImport).toHaveBeenCalledWith(null);
  });
});
