import * as React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SpaceNavigatorProvider,
  useSpaceNavigator,
} from "../features/space-navigation/SpaceNavigatorContext";
import type { FocusModeSessionState } from "../types/focus";
import type { ShoppingItem } from "../types/item";
import type { DayMapData } from "../types/map";
import { incompleteSessionFixture, minimalProps } from "./FocusMode.fixtures";
import { CompletionStateView } from "./focus/FocusModeStateViews";

const mapCanvasRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("./FocusModeMapCanvas", () => ({
  default: (props: unknown) => {
    mapCanvasRenderSpy(props);
    return <div data-testid="focus-map-canvas-mock" />;
  },
}));

import FocusMode from "./FocusMode";

const makeItem = (
  id: string,
  number: string,
  purchaseStatus: ShoppingItem["purchaseStatus"] = "None",
): ShoppingItem => ({
  id,
  eventDate: "2026-01-01",
  block: "A",
  number,
  circle: `サークル${number}`,
  title: `頒布物${number}`,
  price: 500,
  quantity: 1,
  purchaseStatus,
  priorityLevel: "none",
  remarks: "",
  url: "",
});

const makeSession = (
  overrides: Partial<FocusModeSessionState> = {},
): FocusModeSessionState => ({
  ...incompleteSessionFixture,
  ...overrides,
  savedPhaseIndices: {
    ...incompleteSessionFixture.savedPhaseIndices,
    ...overrides.savedPhaseIndices,
  },
  postponedItemIds: [...(overrides.postponedItemIds ?? [])],
  lateItemIds: [...(overrides.lateItemIds ?? [])],
  lastPurchaseChangeAt: overrides.lastPurchaseChangeAt ?? null,
});

const focusMap: DayMapData = {
  sheetName: "2026-01-01マップ",
  rows: 3,
  cols: 3,
  maxRow: 3,
  maxCol: 3,
  cells: [
    {
      row: 1,
      col: 1,
      value: 1,
      backgroundColor: "#fff",
      borders: { top: null, right: null, bottom: null, left: null },
    },
  ],
  mergedCells: [],
  blocks: [
    {
      name: "A",
      startRow: 1,
      startCol: 1,
      endRow: 3,
      endCol: 3,
      numberCells: [{ row: 1, col: 1, value: 1 }],
    },
  ],
};

function SpaceNavigatorProbe() {
  const navigator = useSpaceNavigator();
  const registration = navigator.registration;

  return (
    <section aria-label="space navigator test probe">
      <output data-testid="navigator-entry-count">
        {registration?.entries.length ?? 0}
      </output>
      <output data-testid="navigator-current-index">
        {registration?.currentIndex ?? -1}
      </output>
      <output data-testid="navigator-formal-index">
        {registration?.formalIndex ?? -1}
      </output>
      <output data-testid="navigator-current-id">
        {registration?.entries[registration.currentIndex]?.id ?? ""}
      </output>
      <output data-testid="navigator-formal-id">
        {registration?.entries[registration.formalIndex]?.id ?? ""}
      </output>
      <output data-testid="navigator-temporary-mode">
        {navigator.temporaryMode ?? "none"}
      </output>
      <output data-testid="navigator-history-length">
        {navigator.history.length}
      </output>
      <output data-testid="navigator-entry-ids">
        {registration?.entries.map((entry) => entry.id).join("|") ?? ""}
      </output>
      <button
        type="button"
        aria-label="navigator-side-left"
        onClick={() =>
          navigator.updateSettings({ railVisible: true, side: "left" })
        }
      />
      <button
        type="button"
        aria-label="navigator-side-right"
        onClick={() =>
          navigator.updateSettings({ railVisible: true, side: "right" })
        }
      />

      {registration?.entries.map((entry, index) => (
        <React.Fragment key={entry.id}>
          <button
            type="button"
            aria-label={`temporary:${entry.id}`}
            onClick={() => void navigator.navigate(index, "temporary", true)}
          />
          <button
            type="button"
            aria-label={`inspect:${entry.id}`}
            onClick={() => void navigator.navigate(index, "inspect", true)}
          />
        </React.Fragment>
      ))}

      <button
        type="button"
        aria-label="return-temporary-navigation"
        onClick={() => void navigator.returnToPrevious()}
      />
      <button
        type="button"
        aria-label="promote-temporary-navigation"
        onClick={() => void navigator.promoteTemporary()}
      />
    </section>
  );
}

interface StatefulFocusHarnessProps {
  initialItems: ShoppingItem[];
  resumeState?: FocusModeSessionState | null;
  layoutMode?: "pc" | "smartphone";
  mapData?: Record<string, DayMapData>;
  onItemUpdate: (item: ShoppingItem) => void;
  onSessionStateChange: (state: FocusModeSessionState) => void;
}

function StatefulFocusHarness({
  initialItems,
  resumeState = null,
  layoutMode = "pc",
  mapData,
  onItemUpdate,
  onSessionStateChange,
}: StatefulFocusHarnessProps) {
  const [items, setItems] = React.useState(initialItems);
  const handleUpdateItem = React.useCallback(
    (updatedItem: ShoppingItem) => {
      onItemUpdate(updatedItem);
      setItems((current) =>
        current.map((item) =>
          item.id === updatedItem.id ? updatedItem : item,
        ),
      );
    },
    [onItemUpdate],
  );

  return (
    <FocusMode
      {...minimalProps({
        items,
        executeModeItemIds: initialItems.map((item) => item.id),
        onUpdateItem: handleUpdateItem,
        resumeState,
        onSessionStateChange,
      })}
      layoutMode={layoutMode}
      mapData={mapData}
    />
  );
}

const renderFocusNavigator = ({
  items,
  resumeState = null,
  layoutMode = "pc",
  mapData,
}: {
  items: ShoppingItem[];
  resumeState?: FocusModeSessionState | null;
  layoutMode?: "pc" | "smartphone";
  mapData?: Record<string, DayMapData>;
}) => {
  const onItemUpdate = vi.fn<(item: ShoppingItem) => void>();
  const onSessionStateChange = vi.fn<(state: FocusModeSessionState) => void>();
  const view = render(
    <SpaceNavigatorProvider>
      <StatefulFocusHarness
        initialItems={items}
        resumeState={resumeState}
        layoutMode={layoutMode}
        mapData={mapData}
        onItemUpdate={onItemUpdate}
        onSessionStateChange={onSessionStateChange}
      />
      <SpaceNavigatorProbe />
    </SpaceNavigatorProvider>,
  );

  return { ...view, onItemUpdate, onSessionStateChange };
};

const expectNavigatorPosition = async ({
  current,
  formal,
  mode,
  history,
}: {
  current: number;
  formal: number;
  mode: "none" | "temporary" | "inspect";
  history: number;
}) => {
  await waitFor(() => {
    expect(screen.getByTestId("navigator-current-index")).toHaveTextContent(
      String(current),
    );
    expect(screen.getByTestId("navigator-formal-index")).toHaveTextContent(
      String(formal),
    );
    expect(screen.getByTestId("navigator-temporary-mode")).toHaveTextContent(
      mode,
    );
    expect(screen.getByTestId("navigator-history-length")).toHaveTextContent(
      String(history),
    );
  });
};

const getLatestSession = (
  callback: ReturnType<typeof vi.fn<(state: FocusModeSessionState) => void>>,
) => callback.mock.calls.at(-1)?.[0];

const expectLatestSession = async (
  callback: ReturnType<typeof vi.fn<(state: FocusModeSessionState) => void>>,
  expected: Partial<FocusModeSessionState>,
) => {
  await waitFor(() => {
    expect(getLatestSession(callback)).toMatchObject(expected);
  });
};

const getLatestMapProps = () =>
  mapCanvasRenderSpy.mock.calls.at(-1)?.[0] as
    | {
        currentPhase?: string;
        currentVisitKey?: string | null;
        recenterRevision?: number;
        precomputedVisitKeyCellMap?: Map<
          string,
          { row: number; col: number; key: string }
        >;
      }
    | undefined;

describe("FocusMode Space Navigator integration", () => {
  beforeEach(() => {
    localStorage.clear();
    mapCanvasRenderSpy.mockClear();
  });

  it("keeps full and split-PC navigation buttons outside the active rail hit area", async () => {
    renderFocusNavigator({
      items: [makeItem("normal-1", "01a"), makeItem("normal-2", "02a")],
      mapData: { "2026-01-01マップ": focusMap },
    });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    await waitFor(() => {
      expect(screen.getByTitle("前の訪問先")).toHaveStyle({ left: "32px" });
      expect(screen.getByTitle("次の訪問先")).toHaveStyle({ right: "16px" });
    });

    fireEvent.click(
      screen.getByRole("button", { name: "navigator-side-right" }),
    );
    await waitFor(() => {
      expect(screen.getByTitle("前の訪問先")).toHaveStyle({ left: "16px" });
      expect(screen.getByTitle("次の訪問先")).toHaveStyle({ right: "32px" });
    });

    fireEvent.click(screen.getByTitle("マップを表示"));
    await waitFor(() =>
      expect(screen.getByTestId("focus-map-canvas-mock")).toBeInTheDocument(),
    );
    expect(screen.getByTitle("次の訪問先")).toHaveStyle({ right: "32px" });
  });

  it("applies the rail-aware offset to the completion view previous button", () => {
    render(
      <CompletionStateView
        executeItems={[makeItem("completed", "01a", "Purchased")]}
        layoutMode="pc"
        onPrev={vi.fn()}
        onModeChange={vi.fn()}
        onTouchStart={vi.fn()}
        onTouchMove={vi.fn()}
        onTouchEnd={vi.fn()}
        prevButtonStyle={{ left: "32px" }}
      />,
    );

    expect(screen.getByTitle("前の訪問先")).toHaveStyle({ left: "32px" });
  });

  it("keeps the formal session pointer unchanged while a temporary visit is displayed", async () => {
    const items = [
      makeItem("normal-1", "01a"),
      makeItem("normal-2", "02a"),
      makeItem("normal-3", "03a"),
    ];
    const { container, onSessionStateChange } = renderFocusNavigator({ items });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    await waitFor(() => expect(onSessionStateChange).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: "temporary:normal:A-02a:none" }),
    );

    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "temporary",
      history: 1,
    });
    expect(
      container.querySelector('[data-item-id="normal-2"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-item-id="normal-1"]'),
    ).not.toBeInTheDocument();
    await expectLatestSession(onSessionStateChange, {
      phase: "normal",
      phaseIndex: 0,
    });
  });

  it("uses the display pointer for temporary next/prev and returns to the original formal visit", async () => {
    const items = [
      makeItem("normal-1", "01a"),
      makeItem("normal-2", "02a"),
      makeItem("normal-3", "03a"),
    ];
    const { container, onSessionStateChange } = renderFocusNavigator({ items });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "temporary:normal:A-02a:none" }),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "temporary",
      history: 1,
    });

    fireEvent.click(screen.getByTitle("次の訪問先"));
    await expectNavigatorPosition({
      current: 2,
      formal: 0,
      mode: "temporary",
      history: 1,
    });
    expect(
      container.querySelector('[data-item-id="normal-3"]'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("前の訪問先"));
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "temporary",
      history: 1,
    });
    expect(
      container.querySelector('[data-item-id="normal-2"]'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "return-temporary-navigation" }),
    );
    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    expect(
      container.querySelector('[data-item-id="normal-1"]'),
    ).toBeInTheDocument();
    await expectLatestSession(onSessionStateChange, {
      phase: "normal",
      phaseIndex: 0,
    });
    expect(
      onSessionStateChange.mock.calls.every(
        ([state]) => state.phase === "normal" && state.phaseIndex === 0,
      ),
    ).toBe(true);
  });

  it("clamps an out-of-range formal phase index to the last remaining visit", async () => {
    const items = [
      makeItem("normal-1", "01a"),
      makeItem("normal-2", "02a"),
      makeItem("normal-3", "03a"),
    ];
    const resumeState = makeSession({
      phase: "normal",
      phaseIndex: 2,
      savedPhaseIndices: { normal: 2, postponed: 0, late: 0 },
    });
    const onItemUpdate = vi.fn<(item: ShoppingItem) => void>();
    const onSessionStateChange =
      vi.fn<(state: FocusModeSessionState) => void>();
    const renderTree = (visibleItems: ShoppingItem[]) => (
      <SpaceNavigatorProvider>
        <FocusMode
          {...minimalProps({
            items: visibleItems,
            executeModeItemIds: visibleItems.map((item) => item.id),
            onUpdateItem: onItemUpdate,
            resumeState,
            onSessionStateChange,
          })}
        />
        <SpaceNavigatorProbe />
      </SpaceNavigatorProvider>
    );
    const view = render(renderTree(items));

    await expectNavigatorPosition({
      current: 2,
      formal: 2,
      mode: "none",
      history: 0,
    });
    expect(
      view.container.querySelector('[data-item-id="normal-3"]'),
    ).toBeInTheDocument();

    view.rerender(renderTree(items.slice(0, 2)));

    await waitFor(() =>
      expect(screen.getByTestId("navigator-entry-count")).toHaveTextContent(
        "2",
      ),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 1,
      mode: "none",
      history: 0,
    });
    expect(
      view.container.querySelector('[data-item-id="normal-2"]'),
    ).toBeInTheDocument();
    expect(
      view.container.querySelector('[data-item-id="normal-1"]'),
    ).not.toBeInTheDocument();
  });

  it("blocks editing and previous/next buttons while inspecting a visit", async () => {
    const items = [
      makeItem("normal-1", "01a"),
      makeItem("normal-2", "02a"),
      makeItem("normal-3", "03a"),
    ];
    const { container, onItemUpdate, onSessionStateChange } =
      renderFocusNavigator({ items });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "inspect:normal:A-02a:none" }),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });

    const statusButton = screen.getByRole("button", {
      name: /Current status:/,
    });
    const bulkPurchaseButton = screen.getByRole("button", { name: "全購入" });
    expect(statusButton).toBeDisabled();
    expect(bulkPurchaseButton).toBeDisabled();

    fireEvent.click(statusButton);
    fireEvent.click(bulkPurchaseButton);
    fireEvent.click(screen.getByTitle("次の訪問先"));
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });

    fireEvent.click(screen.getByTitle("前の訪問先"));
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(onItemUpdate).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-item-id="normal-2"]'),
    ).toBeInTheDocument();
    await expectLatestSession(onSessionStateChange, {
      phase: "normal",
      phaseIndex: 0,
    });
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });
  });

  it("closes editable phase and limited-purchase dialogs when inspection begins", async () => {
    const firstItem = {
      ...makeItem("normal-1", "01a"),
      quantity: 2,
    };
    const postponedItem = makeItem("postponed-1", "02a", "Postpone");
    const { onItemUpdate } = renderFocusNavigator({
      items: [firstItem, postponedItem],
    });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });

    fireEvent.change(screen.getByLabelText("phase"), {
      target: { value: "postponed" },
    });
    expect(
      screen.getByRole("heading", { name: "フェーズを切り替えますか？" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "inspect:normal:A-02a:none",
      }),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", {
          name: "フェーズを切り替えますか？",
        }),
      ).not.toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "return-temporary-navigation" }),
    );
    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });

    fireEvent.click(screen.getByRole("button", { name: "全限数" }));
    expect(
      screen.getByRole("dialog", { name: "限数購入の数量" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "inspect:normal:A-02a:none",
      }),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "限数購入の数量" }),
      ).not.toBeInTheDocument(),
    );
    expect(onItemUpdate).not.toHaveBeenCalled();
  });

  it("keeps links and truncated text expansion available while inspecting", async () => {
    const originalScrollWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollWidth",
    );
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get: () => 240,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 80,
    });

    try {
      const longTitle =
        "内容確認中にも全文を開いて読めることを検証する十分に長いタイトル";
      const targetItem = {
        ...makeItem("normal-2", "02a"),
        title: longTitle,
        url: "https://example.com/inspect-item",
      };
      const { container, onItemUpdate } = renderFocusNavigator({
        items: [makeItem("normal-1", "01a"), targetItem],
      });

      await expectNavigatorPosition({
        current: 0,
        formal: 0,
        mode: "none",
        history: 0,
      });
      fireEvent.click(
        screen.getByRole("button", { name: "inspect:normal:A-02a:none" }),
      );
      await expectNavigatorPosition({
        current: 1,
        formal: 0,
        mode: "inspect",
        history: 1,
      });

      const itemContainer = container.querySelector(
        '[data-item-id="normal-2"]',
      );
      expect(itemContainer).not.toBeNull();
      const card = itemContainer as HTMLElement;

      const link = within(card).getByRole("link", { name: "URLを開く" });
      expect(link).toHaveAttribute("href", "https://example.com/inspect-item");
      const onLinkClick = vi.fn((event: Event) => event.preventDefault());
      link.addEventListener("click", onLinkClick);
      fireEvent.click(link);
      expect(onLinkClick).toHaveBeenCalledOnce();

      const titleButton = within(card).getByRole("button", {
        name: longTitle,
      });
      await waitFor(() =>
        expect(titleButton).toHaveAttribute("aria-expanded", "false"),
      );
      fireEvent.click(titleButton);
      await waitFor(() =>
        expect(titleButton).toHaveAttribute("aria-expanded", "true"),
      );
      expect(onItemUpdate).not.toHaveBeenCalled();
    } finally {
      if (originalScrollWidth) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollWidth",
          originalScrollWidth,
        );
      } else {
        delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
      }
      if (originalClientWidth) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientWidth",
          originalClientWidth,
        );
      } else {
        delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      }
    }
  });

  it("blocks smartphone swipe navigation while inspecting a visit", async () => {
    const items = [
      makeItem("normal-1", "01a"),
      makeItem("normal-2", "02a"),
      makeItem("normal-3", "03a"),
    ];
    const { container } = renderFocusNavigator({
      items,
      layoutMode: "smartphone",
    });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "inspect:normal:A-02a:none" }),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });

    const swipeTarget = container.firstElementChild;
    expect(swipeTarget).not.toBeNull();
    fireEvent.touchStart(swipeTarget!, {
      touches: [{ clientX: 160, clientY: 100 }],
    });
    fireEvent.touchMove(swipeTarget!, {
      touches: [{ clientX: 60, clientY: 100 }],
    });
    fireEvent.touchEnd(swipeTarget!, {
      changedTouches: [{ clientX: 60, clientY: 100 }],
    });

    await act(async () => {
      await Promise.resolve();
    });
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "inspect",
      history: 1,
    });
  });

  it("pauses empty-visit auto skip during temporary editing and promotes a vanished phase entry via its normal fallback", async () => {
    const postponed = makeItem("postponed-1", "01a", "Postpone");
    const nextPostponed = makeItem("postponed-2", "02a", "Postpone");
    const session = makeSession({
      phase: "normal",
      phaseIndex: 1,
      savedPhaseIndices: { normal: 1, postponed: 0, late: 0 },
      postponedItemIds: [postponed.id, nextPostponed.id],
    });
    const { container, onItemUpdate, onSessionStateChange } =
      renderFocusNavigator({
        items: [postponed, nextPostponed],
        resumeState: session,
      });

    await expectNavigatorPosition({
      current: 1,
      formal: 1,
      mode: "none",
      history: 0,
    });
    expect(screen.getByTestId("navigator-entry-count")).toHaveTextContent("4");

    fireEvent.click(
      screen.getByRole("button", { name: "temporary:postponed:A-01a:none" }),
    );
    await expectNavigatorPosition({
      current: 2,
      formal: 1,
      mode: "temporary",
      history: 1,
    });
    expect(
      container.querySelector('[data-item-id="postponed-1"]'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "全購入" }));
    await waitFor(() => {
      expect(onItemUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "postponed-1",
          purchaseStatus: "Purchased",
        }),
      );
      expect(
        screen.getByRole("button", {
          name: /Current status: 購入済/,
        }),
      ).toBeInTheDocument();
      expect(screen.getByTestId("navigator-entry-count")).toHaveTextContent(
        "4",
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-item-id="postponed-1"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-item-id="postponed-2"]'),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("navigator-temporary-mode")).toHaveTextContent(
      "temporary",
    );
    expect(screen.getByTestId("navigator-history-length")).toHaveTextContent(
      "1",
    );
    await expectLatestSession(onSessionStateChange, {
      phase: "normal",
      phaseIndex: 1,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "promote-temporary-navigation" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("navigator-temporary-mode")).toHaveTextContent(
        "none",
      );
      expect(screen.getByTestId("navigator-history-length")).toHaveTextContent(
        "0",
      );
      expect(screen.getByTestId("navigator-formal-id")).toHaveTextContent(
        "normal:A-01a:none",
      );
    });
    await expectLatestSession(onSessionStateChange, {
      phase: "normal",
      phaseIndex: 0,
    });
  });

  it("increments map recenter revision for same-space phase navigation and return", async () => {
    const postponed = makeItem("postponed-1", "01a", "Postpone");
    renderFocusNavigator({
      items: [postponed],
      mapData: { "2026-01-01マップ": focusMap },
    });

    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    fireEvent.click(screen.getByTitle("マップを表示"));
    await waitFor(() =>
      expect(screen.getByTestId("focus-map-canvas-mock")).toBeInTheDocument(),
    );

    const initialMapProps = getLatestMapProps();
    expect(initialMapProps).toMatchObject({
      currentPhase: "normal",
      currentVisitKey: "2026-01-01-A-01a",
    });
    const initialRevision = initialMapProps?.recenterRevision ?? 0;

    fireEvent.click(
      screen.getByRole("button", { name: "temporary:postponed:A-01a:none" }),
    );
    await expectNavigatorPosition({
      current: 1,
      formal: 0,
      mode: "temporary",
      history: 1,
    });
    await waitFor(() => {
      expect(getLatestMapProps()?.currentPhase).toBe("postponed");
      expect(getLatestMapProps()?.recenterRevision).toBeGreaterThan(
        initialRevision,
      );
    });

    const temporaryMapProps = getLatestMapProps();
    expect(temporaryMapProps?.currentVisitKey).toBe(
      initialMapProps?.currentVisitKey,
    );
    const temporaryRevision =
      temporaryMapProps?.recenterRevision ?? initialRevision;

    fireEvent.click(
      screen.getByRole("button", { name: "return-temporary-navigation" }),
    );
    await expectNavigatorPosition({
      current: 0,
      formal: 0,
      mode: "none",
      history: 0,
    });
    await waitFor(() => {
      expect(getLatestMapProps()?.currentPhase).toBe("normal");
      expect(getLatestMapProps()?.currentVisitKey).toBe(
        initialMapProps?.currentVisitKey,
      );
      expect(getLatestMapProps()?.recenterRevision).toBeGreaterThan(
        temporaryRevision,
      );
    });
  });

  it("normalizes multi-letter, full-width, and spaced booth aliases for visits and map keys", async () => {
    const fullWidthAlias = {
      ...makeItem("alias-full-width", " ０１Ａ２ "),
      block: " Ａ ",
    };
    const asciiAlias = makeItem("alias-ascii", "01a9");
    const multiLetter = makeItem("multi-letter", "01Ab12");

    renderFocusNavigator({
      items: [fullWidthAlias, asciiAlias, multiLetter],
      mapData: { "2026-01-01マップ": focusMap },
    });

    await waitFor(() => {
      expect(screen.getByTestId("navigator-entry-count")).toHaveTextContent(
        "2",
      );
      expect(screen.getByTestId("navigator-entry-ids")).toHaveTextContent(
        "normal:A-01a:none|normal:A-01ab:none",
      );
    });

    fireEvent.click(screen.getByTitle("マップを表示"));
    await waitFor(() =>
      expect(screen.getByTestId("focus-map-canvas-mock")).toBeInTheDocument(),
    );

    await waitFor(() => {
      const mapProps = getLatestMapProps();
      expect(mapProps?.currentVisitKey).toBe("2026-01-01-A-01a");
      expect(
        mapProps?.precomputedVisitKeyCellMap?.get("2026-01-01-A-01a-none"),
      ).toEqual({ row: 1, col: 1, key: "1-1" });
    });
  });
});
