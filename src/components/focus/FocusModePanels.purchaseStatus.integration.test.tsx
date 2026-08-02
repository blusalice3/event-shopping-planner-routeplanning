import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  FocusModeHeader,
  FocusModeItemList,
  FocusModeMapControls,
} from "./FocusModePanels";
import type { ShoppingItem } from "../../types/item";
import type { FocusPhase } from "../../types/focus";

const baseItem: ShoppingItem = {
  id: "item-1",
  circle: "Circle",
  eventDate: "Day1",
  block: "A",
  number: "01",
  title: "Title",
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
};

const makeItem = (
  id: string,
  purchaseStatus: ShoppingItem["purchaseStatus"],
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  ...baseItem,
  id,
  purchaseStatus,
  ...overrides,
});

const makeHeaderProps = (
  overrides: Partial<ComponentProps<typeof FocusModeHeader>> = {},
): ComponentProps<typeof FocusModeHeader> => ({
  layoutMode: "pc",
  isMapVisible: false,
  spaceInfo: "A-01a",
  circleName: "Circle",
  currentVisitCheckedCount: 1,
  currentVisitTotalCount: 2,
  currentVisitPriceInfo: {
    chargeableTotal: 1000,
    plannedTotal: 1500,
    priceMissingItemCount: 1,
  },
  currentPhase: "normal",
  onPhaseChangeRequest: vi.fn(),
  currentVisitItems: [baseItem],
  onBulkStatusChange: vi.fn(),
  nextVisitInfo: {
    spaceInfo: "A-02a",
    circleName: "Next Circle",
  },
  ...overrides,
});

const renderHeader = (
  overrides: Partial<ComponentProps<typeof FocusModeHeader>> = {},
) => {
  return render(<FocusModeHeader {...makeHeaderProps(overrides)} />);
};

describe("FocusModeItemList purchase status control mode", () => {
  it("passes radial purchase status control mode to item cards", () => {
    render(
      <FocusModeItemList
        itemListRef={{ current: null }}
        layoutMode="pc"
        isMapVisible={false}
        currentVisitDisplayItems={[baseItem]}
        blinkingPriceItemIds={new Set()}
        onUpdateItem={vi.fn()}
        skipLimitedPurchaseForSingleQuantity
        purchaseStatusControlMode="radial"
      />,
    );

    expect(
      screen.getByRole("button", { name: /Current status/i }),
    ).toHaveAttribute("aria-haspopup", "dialog");
  });
});

describe("FocusModeHeader responsive layout", () => {
  it("uses smartphone-specific compact layout and horizontal bulk status row", () => {
    renderHeader({ layoutMode: "smartphone" });

    expect(screen.getByTestId("focus-header-smartphone-main")).toHaveClass(
      "grid",
      "grid-cols-[minmax(0,1fr)_auto]",
    );
    expect(screen.getByTestId("focus-header-smartphone-payment")).toHaveClass(
      "border-t",
      "items-center",
    );
    expect(screen.getByTestId("focus-header-bulk-scroll")).toHaveClass(
      "overflow-x-auto",
    );
    expect(screen.getByTestId("focus-header-bulk-row")).toHaveClass(
      "flex-nowrap",
      "w-max",
    );
    expect(screen.getByTestId("focus-header-next-visit")).toHaveAttribute(
      "title",
      "A-02a Next Circle",
    );
    expect(screen.getByRole("combobox", { name: "phase" })).toBeInTheDocument();
  });

  it("keeps the smartphone phase select compact", () => {
    renderHeader({ layoutMode: "smartphone" });

    expect(screen.getByRole("combobox", { name: "phase" })).toHaveClass(
      "h-8",
      "w-full",
      "max-w-[6.75rem]",
    );
  });

  it("keeps desktop layout without smartphone-only scroll containers on pc", () => {
    renderHeader({ layoutMode: "pc" });

    expect(
      screen.queryByTestId("focus-header-smartphone-main"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("focus-header-smartphone-payment"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("focus-header-bulk-scroll"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "phase" })).toBeInTheDocument();
  });

  it("uses dash fallback for empty next visit info on smartphone", () => {
    renderHeader({
      layoutMode: "smartphone",
      nextVisitInfo: {
        spaceInfo: "",
        circleName: "",
      },
    });

    const nextVisit = screen.getByTestId("focus-header-next-visit");
    expect(nextVisit).toHaveAttribute("title", "-");
    expect(nextVisit).toHaveTextContent("-");
  });

  it("falls back to dash when next visit info contains only whitespace on smartphone", () => {
    renderHeader({
      layoutMode: "smartphone",
      nextVisitInfo: {
        spaceInfo: "   ",
        circleName: "\t",
      },
    });

    const nextVisit = screen.getByTestId("focus-header-next-visit");
    expect(nextVisit).toHaveAttribute("title", "-");
    expect(nextVisit).toHaveTextContent("-");
  });

  it("invokes onBulkStatusChange when the first (Purchased) bulk status button is clicked on smartphone", () => {
    const onBulkStatusChange = vi.fn();
    renderHeader({
      layoutMode: "smartphone",
      onBulkStatusChange,
    });

    const buttons = within(
      screen.getByTestId("focus-header-bulk-row"),
    ).getAllByRole("button");
    fireEvent.click(buttons[0]);

    expect(onBulkStatusChange).toHaveBeenCalledTimes(1);
    expect(onBulkStatusChange).toHaveBeenCalledWith("Purchased");
  });

  it("keeps title attributes on smartphone bulk status buttons", () => {
    renderHeader({ layoutMode: "smartphone" });

    const buttons = within(
      screen.getByTestId("focus-header-bulk-row"),
    ).getAllByRole("button");

    buttons.forEach((button) => {
      expect(button).toHaveAttribute("title");
      expect(button.getAttribute("title")).not.toBe("");
    });
  });

  it("invokes onPhaseChangeRequest when phase is changed on smartphone", () => {
    const onPhaseChangeRequest = vi.fn();
    renderHeader({
      layoutMode: "smartphone",
      onPhaseChangeRequest,
    });

    fireEvent.change(screen.getByRole("combobox", { name: "phase" }), {
      target: { value: "late" },
    });

    expect(onPhaseChangeRequest).toHaveBeenCalledWith("late");
  });
});

describe("FocusModeMapControls responsive layout", () => {
  const renderControls = (
    overrides: Partial<ComponentProps<typeof FocusModeMapControls>> = {},
  ) => {
    const onMapCenteringModeChange = vi.fn();
    const onMapRotationAngleChange = vi.fn();
    render(
      <FocusModeMapControls
        mapZoomLevel={84}
        mapRotationAngle={0}
        mapInitialRotationAngle={30}
        onMapRotationAngleChange={onMapRotationAngleChange}
        mapCenteringMode="prevToCurrent"
        onMapCenteringModeChange={onMapCenteringModeChange}
        {...overrides}
      />,
    );
    return { onMapCenteringModeChange, onMapRotationAngleChange };
  };

  it("keeps compact smartphone controls in a single non-wrapping row", () => {
    renderControls({ compact: true });

    const controls = screen.getByTestId("focus-map-controls");
    const routeButton = screen.getByRole("button", {
      name: "前の訪問先から現在地までのルートを表示",
    });
    const zoomLevel = screen.getByLabelText("マップ倍率 84パーセント");
    const rotationControls = screen.getByTestId("map-rotation-compact");

    expect(controls).toHaveClass("flex-nowrap", "py-0");
    expect(controls).not.toHaveClass("flex-wrap");
    expect(routeButton).toHaveClass("h-full", "leading-none");
    expect(routeButton).toHaveTextContent("前→現");
    expect(zoomLevel).toHaveClass("h-7", "leading-none");
    expect(zoomLevel).toHaveTextContent("84%");
    expect(rotationControls).toHaveClass("h-7");
  });

  it("exposes selected centering state and invokes the compact switch", () => {
    const { onMapCenteringModeChange } = renderControls({ compact: true });
    const routeButton = screen.getByRole("button", {
      name: "前の訪問先から現在地までのルートを表示",
    });
    const currentButton = screen.getByRole("button", {
      name: "現在地だけを中央表示",
    });

    expect(routeButton).toHaveAttribute("aria-pressed", "true");
    expect(currentButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(currentButton);

    expect(onMapCenteringModeChange).toHaveBeenCalledWith("currentOnly");
  });

  it("opens compact rotation controls as an overlay without changing the toolbar structure", () => {
    const { onMapRotationAngleChange } = renderControls({ compact: true });
    const rotationButton = screen.getByRole("button", { name: "回転 0°" });

    expect(
      screen.queryByTestId("map-rotation-popover"),
    ).not.toBeInTheDocument();
    fireEvent.click(rotationButton);

    expect(screen.getByTestId("map-rotation-popover")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("slider", { name: "マップの回転角度" }), {
      target: { value: "120" },
    });
    fireEvent.click(screen.getByTitle("+15° (時計回り)"));
    fireEvent.click(screen.getByTitle("初期角度(30°)に戻す"));

    expect(onMapRotationAngleChange).toHaveBeenNthCalledWith(1, 120);
    expect(onMapRotationAngleChange).toHaveBeenNthCalledWith(2, 15);
    expect(onMapRotationAngleChange).toHaveBeenNthCalledWith(3, 30);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByTestId("map-rotation-popover"),
    ).not.toBeInTheDocument();
    expect(rotationButton).toHaveFocus();
  });

  it("preserves the full inline labels outside compact mode", () => {
    renderControls();

    expect(screen.getByTestId("focus-map-controls")).toHaveClass("flex-wrap");
    expect(screen.getByText("前→現ルート")).toBeInTheDocument();
    expect(
      screen.queryByTestId("map-rotation-compact"),
    ).not.toBeInTheDocument();
  });
});

describe("FocusModeHeader purchase-aware background", () => {
  const getBackgroundImage = () =>
    screen.getByTestId("focus-mode-header").style.backgroundImage;

  it("uses equal-width segments even when item counts are nine to one", () => {
    const items = [
      ...Array.from({ length: 9 }, (_, index) =>
        makeItem(`none-${index}`, "None"),
      ),
      makeItem("completed", "Purchased"),
    ];

    renderHeader({ currentVisitItems: items });

    const backgroundImage = getBackgroundImage();
    expect(backgroundImage).toContain("#94a3b8 0%");
    expect(backgroundImage).toContain("#94a3b8 50%");
    expect(backgroundImage).toContain("#22c55e 50%");
    expect(backgroundImage).toContain("#22c55e 100%");
    expect(backgroundImage).toContain("rgba(15, 23, 42, 0.28)");
  });

  it("keeps the fixed unvisited, postponed, late, limited, completed order", () => {
    renderHeader({
      currentVisitItems: [
        makeItem("completed", "Purchased"),
        makeItem("late", "Late"),
        makeItem("limited", "LimitedPurchase", { quantity: 3 }),
        makeItem("unvisited", "None"),
        makeItem("postponed", "Postpone"),
      ],
    });

    const backgroundImage = getBackgroundImage();
    const colorPositions = [
      "#94a3b8",
      "#8b5cf6",
      "#3b82f6",
      "#f97316",
      "#22c55e",
    ].map((color) => backgroundImage.indexOf(color));

    expect(colorPositions.every((position) => position >= 0)).toBe(true);
    expect(colorPositions).toEqual([...colorPositions].sort((a, b) => a - b));
  });

  it("uses a full green background when every item is complete", () => {
    renderHeader({
      currentVisitItems: [
        makeItem("purchased", "Purchased"),
        makeItem("sold-out", "SoldOut"),
        makeItem("absent", "Absent"),
        makeItem("limited-complete", "LimitedPurchase", {
          quantity: 3,
          limitedPurchasedQuantity: 2,
        }),
      ],
    });

    const backgroundImage = getBackgroundImage();
    expect(backgroundImage).toContain("#22c55e 0%");
    expect(backgroundImage).toContain("#22c55e 100%");
    expect(backgroundImage).not.toContain("#94a3b8");
    expect(backgroundImage).not.toContain("#f97316");
  });

  it("separates missing and entered limited quantities into orange and green", () => {
    renderHeader({
      currentVisitItems: [
        makeItem("limited-missing", "LimitedPurchase", { quantity: 3 }),
        makeItem("limited-complete", "LimitedPurchase", {
          quantity: 3,
          limitedPurchasedQuantity: 1,
        }),
      ],
    });

    const backgroundImage = getBackgroundImage();
    expect(backgroundImage).toContain("#f97316 0%");
    expect(backgroundImage).toContain("#f97316 50%");
    expect(backgroundImage).toContain("#22c55e 50%");
    expect(backgroundImage).toContain("#22c55e 100%");
  });

  it("does not let an undefined price change the status classification", () => {
    const pricedItems = [
      makeItem("unvisited", "None", { price: 100 }),
      makeItem("completed", "Purchased", { price: 100 }),
    ];
    const undefinedPriceItems = pricedItems.map((item) => ({
      ...item,
      price: null,
    }));
    const view = renderHeader({ currentVisitItems: pricedItems });
    const pricedBackground = getBackgroundImage();

    view.rerender(
      <FocusModeHeader
        {...makeHeaderProps({ currentVisitItems: undefinedPriceItems })}
      />,
    );

    expect(getBackgroundImage()).toBe(pricedBackground);
  });

  it("applies the same status background to smartphone and desktop roots", () => {
    const items = [
      makeItem("unvisited", "None"),
      makeItem("completed", "Purchased"),
    ];
    const view = renderHeader({
      layoutMode: "pc",
      currentVisitItems: items,
    });
    const desktopBackground = getBackgroundImage();

    view.rerender(
      <FocusModeHeader
        {...makeHeaderProps({
          layoutMode: "smartphone",
          currentVisitItems: items,
        })}
      />,
    );

    expect(getBackgroundImage()).toBe(desktopBackground);
  });
});

describe("FocusModeHeader aggregate phase label", () => {
  it.each<{
    movementBasisPhase: FocusPhase | null | undefined;
    expected: string;
  }>([
    { movementBasisPhase: undefined, expected: "未選択" },
    { movementBasisPhase: null, expected: "未選択" },
    { movementBasisPhase: "normal", expected: "通常" },
    { movementBasisPhase: "postponed", expected: "後回し" },
    { movementBasisPhase: "late", expected: "遅参" },
  ])(
    "shows a static all-phase label for movement basis $expected",
    ({ movementBasisPhase, expected }) => {
      renderHeader({
        isSpaceAggregate: true,
        movementBasisPhase,
      });

      expect(screen.queryByRole("combobox", { name: "phase" })).toBeNull();
      const phaseLabel = screen.getByTestId("focus-header-aggregate-phase");
      expect(phaseLabel).toHaveTextContent("一時表示・全フェーズ");
      expect(phaseLabel).toHaveTextContent(`移動基準：${expected}`);
    },
  );
});
