// @vitest-environment jsdom

import React, { useEffect, useMemo, useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusModeFooterPortal } from "../../../components/focus/FocusModeFooterPortal";
import SummaryBar from "../../../components/SummaryBar";
import {
  SpaceNavigatorProvider,
  useSpaceNavigator,
  type SpaceNavigatorRegistration,
} from "../SpaceNavigatorContext";
import { buildExecutionNavigatorEntries } from "../domain/buildNavigatorEntries";
import type { NavigatorItem } from "../types";
import { SpaceNavigatorActionDialog } from "./SpaceNavigatorActionDialog";
import { SpaceNavigatorFooterButton } from "./SpaceNavigatorFooterButton";
import { SpaceNavigatorHost } from "./SpaceNavigatorHost";
import { SpaceNavigatorPicker } from "./SpaceNavigatorPicker";
import { SpaceNavigatorRail } from "./SpaceNavigatorRail";

const entries = buildExecutionNavigatorEntries(
  Array.from(
    { length: 9 },
    (_, index): NavigatorItem => ({
      id: String(index + 1),
      circle: `サークル${index + 1}`,
      block: String.fromCharCode("A".charCodeAt(0) + index),
      number: `${String(index + 1).padStart(2, "0")}a`,
      purchaseStatus: "Purchased",
      price: 500,
      quantity: 1,
    }),
  ),
);

function StaticRegistration({
  layoutMode = "smartphone",
}: {
  layoutMode?: "pc" | "smartphone";
}) {
  const { register } = useSpaceNavigator();
  const registration = useMemo<SpaceNavigatorRegistration>(
    () => ({
      id: "common-ui-test",
      mode: "execute",
      entries,
      currentIndex: 0,
      formalIndex: 0,
      layoutMode,
      onNavigate: async () => ({ ok: true }),
    }),
    [layoutMode],
  );

  useEffect(() => register(registration), [register, registration]);
  return <SpaceNavigatorFooterButton />;
}

function MutableRegistration() {
  const navigator = useSpaceNavigator();
  const [registrationMounted, setRegistrationMounted] = useState(true);

  return (
    <>
      {registrationMounted && <StaticRegistration />}
      <button type="button" onClick={() => setRegistrationMounted(false)}>
        登録を解除
      </button>
      <button
        type="button"
        onClick={() => {
          if (!navigator.registration) return;
          navigator.updateRegistration({
            ...navigator.registration,
            entries: [],
          });
        }}
      >
        訪問先を0件にする
      </button>
    </>
  );
}

function NotificationTrigger() {
  const { notify } = useSpaceNavigator();
  return (
    <>
      <button type="button" onClick={() => notify("お知らせ")}>
        通知
      </button>
      <button type="button" onClick={() => notify("警告のお知らせ", "warning")}>
        警告通知
      </button>
    </>
  );
}

const dispatchPointer = (
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointerleave",
  pointerId: number,
  clientY: number,
  pointerType = "touch",
  buttons = type === "pointerup" ? 0 : 1,
) => {
  const event = new MouseEvent(type, { bubbles: true, buttons, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(element, event);
};

describe("SpaceNavigatorPicker", () => {
  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 640,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders every smartphone entry in a native vertical scroller", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 360,
    });
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="smartphone"
        side="left"
        onCandidateChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    expect(windowElement).toHaveAttribute("data-visible-row-count", "9");
    expect(windowElement).toHaveAttribute("data-scroll-mode", "native");
    expect(windowElement.querySelectorAll("button")).toHaveLength(
      entries.length,
    );
    expect(windowElement).not.toHaveAttribute("style");
    expect(windowElement).toHaveClass(
      "flex-1",
      "touch-pan-y",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(windowElement).not.toHaveClass("overflow-hidden");
    expect(
      windowElement.querySelector('[aria-current="true"]'),
    ).toHaveTextContent(entries[4].label);
    expect(windowElement.querySelector('[aria-current="true"]')).toHaveClass(
      "min-h-[68px]",
      "bg-indigo-100/70",
    );
    expect(
      screen.queryByTestId("space-navigator-selection"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "スペース一覧" })).toHaveClass(
      "bottom-[var(--footer-height,0px)]",
    );
    expect(
      screen.getByRole("dialog", { name: "スペース一覧" }),
    ).not.toHaveAttribute("style");
    expect(
      screen.getByText(
        "一覧を上下にスクロールして、移動先のスペースをタップしてください。",
      ),
    ).toBeInTheDocument();
  });

  it("uses the measured list height to show more rows while keeping the candidate centered", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class ResizeObserverMock {
      readonly disconnect = disconnect;
      readonly observe = observe;
      readonly unobserve = vi.fn();

      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    Object.assign(windowElement, {
      getBoundingClientRect: () => ({
        bottom: 612,
        height: 612,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });
    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(observe).toHaveBeenCalledWith(windowElement);
    expect(windowElement).toHaveAttribute("data-visible-row-count", "9");
    expect(windowElement.querySelectorAll("button")).toHaveLength(9);
    expect(
      windowElement.querySelector('[aria-current="true"]'),
    ).toHaveTextContent(entries[4].label);
    expect(windowElement.querySelector('[aria-current="true"]')).toBe(
      windowElement.querySelectorAll("button")[4],
    );
    expect(screen.getByTestId("space-navigator-selection")).toBe(
      windowElement.querySelector('[aria-current="true"]'),
    );
    expect(screen.getByTestId("space-navigator-selection")).toHaveClass(
      "border-y-2",
      "border-indigo-500",
    );
  });

  it("shifts the window at the end and leaves no blank rows", () => {
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={entries.length - 1}
        layoutMode="pc"
        side="left"
        onCandidateChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const visibleButtons = windowElement.querySelectorAll("button");
    expect(windowElement).toHaveAttribute("data-visible-row-count", "5");
    expect(visibleButtons).toHaveLength(5);
    expect(visibleButtons[0]).toHaveTextContent(entries[4].label);
    expect(visibleButtons[4]).toHaveTextContent(entries[8].label);
    expect(screen.getByTestId("space-navigator-selection")).toBe(
      visibleButtons[4],
    );
  });

  it("uses only real rows when fewer entries exist than the available window", () => {
    const shortEntries = entries.slice(0, 3);
    render(
      <SpaceNavigatorPicker
        entries={shortEntries}
        candidateIndex={2}
        layoutMode="smartphone"
        side="left"
        onCandidateChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    expect(windowElement).toHaveAttribute("data-visible-row-count", "3");
    expect(windowElement.querySelectorAll("button")).toHaveLength(3);
    expect(
      screen.queryByTestId("space-navigator-selection"),
    ).not.toBeInTheDocument();
  });

  it("opens a non-central tapped space directly on a smartphone", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="smartphone"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(entries[2].label) }),
    );
    expect(onCandidateChange).toHaveBeenCalledWith(2);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("opens the clicked space directly on PC", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(entries[2].label) }),
    );
    expect(onCandidateChange).toHaveBeenCalledWith(2);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("moves the PC candidate from the latest wheel position and clamps at the boundary", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    const view = render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const wheelDown = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 100,
    });
    fireEvent(windowElement, wheelDown);
    expect(onCandidateChange).toHaveBeenLastCalledWith(5);

    const secondWheelDown = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 100,
    });
    fireEvent(windowElement, secondWheelDown);
    expect(onCandidateChange).toHaveBeenLastCalledWith(6);

    const wheelUp = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -100,
    });
    fireEvent(windowElement, wheelUp);
    expect(onCandidateChange).toHaveBeenLastCalledWith(5);
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.wheel(windowElement, { deltaX: 100, deltaY: 0 });
    expect(onCandidateChange).toHaveBeenCalledTimes(3);

    view.rerender(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={entries.length - 1}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.wheel(windowElement, { deltaY: 100 });
    expect(onCandidateChange).toHaveBeenLastCalledWith(entries.length - 1);
  });

  it("leaves smartphone wheel input to the native scroller", () => {
    const onCandidateChange = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="smartphone"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const wheelEvent = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 100,
    });
    fireEvent(windowElement, wheelEvent);

    expect(onCandidateChange).not.toHaveBeenCalled();
    expect(wheelEvent.defaultPrevented).toBe(false);
  });

  it("does not capture a smartphone pointer drag inside a space row", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="smartphone"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const setPointerCapture = vi.fn();
    Object.assign(windowElement, {
      setPointerCapture,
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    const row = screen.getByRole("button", {
      name: new RegExp(entries[4].label),
    });

    dispatchPointer(row, "pointerdown", 17, 260);
    dispatchPointer(row, "pointermove", 17, 120);
    dispatchPointer(row, "pointerup", 17, 120);

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(onCandidateChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("accumulates small PC trackpad deltas before advancing one space", () => {
    const onCandidateChange = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    fireEvent.wheel(windowElement, { deltaY: 10 });
    fireEvent.wheel(windowElement, { deltaY: 10 });
    fireEvent.wheel(windowElement, { deltaY: 10 });
    expect(onCandidateChange).not.toHaveBeenCalled();

    fireEvent.wheel(windowElement, { deltaY: 10 });
    expect(onCandidateChange).toHaveBeenCalledOnce();
    expect(onCandidateChange).toHaveBeenCalledWith(5);
  });

  it("updates only the candidate during a drag and does not select on pointer release", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const capturedPointers = new Set<number>();
    Object.assign(windowElement, {
      setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId),
      hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
      releasePointerCapture: (pointerId: number) =>
        capturedPointers.delete(pointerId),
      getBoundingClientRect: () => ({
        bottom: 340,
        height: 340,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    dispatchPointer(windowElement, "pointerdown", 7, 170);
    expect(capturedPointers.size).toBe(0);
    dispatchPointer(windowElement, "pointermove", 7, 90);
    expect(capturedPointers.has(7)).toBe(true);
    dispatchPointer(windowElement, "pointerup", 7, 90);

    expect(onCandidateChange).toHaveBeenCalledWith(5);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(entries[4].label) }),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("consumes a captured grid click after drag so the next row click works", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const capturedPointers = new Set<number>();
    Object.assign(windowElement, {
      setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId),
      hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
      releasePointerCapture: (pointerId: number) =>
        capturedPointers.delete(pointerId),
      getBoundingClientRect: () => ({
        bottom: 340,
        height: 340,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    dispatchPointer(windowElement, "pointerdown", 9, 170);
    dispatchPointer(windowElement, "pointermove", 9, 90);
    dispatchPointer(windowElement, "pointerup", 9, 90);
    fireEvent.click(windowElement);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(entries[4].label) }),
    );

    expect(onSelect).toHaveBeenCalledWith(4);
  });

  it("clears an uncaptured mouse drag when the pointer leaves the list", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        layoutMode="pc"
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    const setPointerCapture = vi.fn();
    Object.assign(windowElement, {
      setPointerCapture,
      hasPointerCapture: () => false,
      releasePointerCapture: vi.fn(),
      getBoundingClientRect: () => ({
        bottom: 340,
        height: 340,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => undefined,
      }),
    });

    dispatchPointer(windowElement, "pointerdown", 8, 170, "mouse", 1);
    dispatchPointer(windowElement, "pointerleave", 8, 160, "mouse", 1);
    dispatchPointer(windowElement, "pointermove", 8, 90, "mouse", 0);

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(onCandidateChange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("SpaceNavigatorRail", () => {
  it("reflects the candidate in ARIA and opens the picker for arrow, Home, and End keys", () => {
    const onCandidateChange = vi.fn();
    const onOpen = vi.fn();
    const view = render(
      <SpaceNavigatorRail
        entries={entries}
        currentIndex={0}
        formalIndex={0}
        candidateIndex={1}
        side="left"
        onCandidateChange={onCandidateChange}
        onOpen={onOpen}
      />,
    );

    const slider = screen.getByRole("slider", { name: "スペースナビ" });
    expect(slider).toHaveAttribute("aria-valuenow", "2");
    expect(slider).toHaveAttribute("aria-valuetext", entries[1].label);
    expect(slider.parentElement).toHaveClass("z-[45]");
    expect(slider).toHaveClass("w-4");
    expect(slider.parentElement).toHaveClass("w-4");
    expect(slider).not.toHaveAttribute("style");

    fireEvent.keyDown(slider, { key: "ArrowDown" });
    expect(onCandidateChange).toHaveBeenLastCalledWith(2);
    expect(onOpen).toHaveBeenCalledTimes(1);

    view.rerender(
      <SpaceNavigatorRail
        entries={entries}
        currentIndex={0}
        formalIndex={0}
        candidateIndex={2}
        side="left"
        onCandidateChange={onCandidateChange}
        onOpen={onOpen}
      />,
    );
    fireEvent.keyDown(slider, { key: "ArrowUp" });
    expect(onCandidateChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(slider, { key: "Home" });
    expect(onCandidateChange).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(slider, { key: "End" });
    expect(onCandidateChange).toHaveBeenLastCalledWith(entries.length - 1);
    expect(onOpen).toHaveBeenCalledTimes(4);
  });
});

describe("SpaceNavigatorActionDialog", () => {
  it("renders a blocking warning with the red warning palette", () => {
    render(
      <SpaceNavigatorActionDialog
        entry={entries[1]}
        result={{
          ok: false,
          message: "価格を入力してください",
          tone: "warning",
        }}
        pendingIntent="set-current"
        busy={false}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveClass(
      "border-red-300",
      "bg-red-50",
      "text-red-900",
    );
  });

  it("renders an unvisited advisory and its confirmation action in red", () => {
    render(
      <SpaceNavigatorActionDialog
        entry={entries[1]}
        result={{
          ok: false,
          message: "未購入のアイテムがあります",
          requiresConfirmation: true,
        }}
        pendingIntent="temporary"
        busy={false}
        onChoose={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveClass(
      "border-red-300",
      "bg-red-50",
      "text-red-900",
    );
    expect(
      screen.getByRole("button", { name: "警告を確認して移動" }),
    ).toHaveClass("bg-red-600", "hover:bg-red-700");
  });
});

describe("SpaceNavigatorHost and footer visibility", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehavior = "contain";
  });

  afterEach(() => {
    document.body.className = "";
    document.body.style.overflow = "";
    document.body.style.overscrollBehavior = "";
    vi.restoreAllMocks();
  });

  it("renders neither entry point when rail and footer button are both disabled", () => {
    localStorage.setItem(
      "spaceNavigatorSettings",
      JSON.stringify({ railVisible: false, footerButtonVisible: false }),
    );
    render(
      <SpaceNavigatorProvider>
        <StaticRegistration />
        <SpaceNavigatorHost />
      </SpaceNavigatorProvider>,
    );

    expect(
      screen.queryByRole("slider", { name: "スペースナビ" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "スペース一覧を開く" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the traditional footer padding when only the rail is enabled", () => {
    const dynamicRegistry = document.createElement("style");
    dynamicRegistry.textContent = ".esp-dynamic-css-registry {}";
    document.head.appendChild(dynamicRegistry);
    localStorage.setItem(
      "spaceNavigatorSettings",
      JSON.stringify({ railVisible: true, footerButtonVisible: false }),
    );
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(123);
    render(
      <SpaceNavigatorProvider>
        <StaticRegistration />
        <SummaryBar items={[]} />
        <FocusModeFooterPortal
          layoutMode="smartphone"
          phaseDisplayName="通常"
          currentPhaseIndex={0}
          currentPhaseVisitsLength={1}
          currentVisitNumber={1}
          totalVisits={1}
          purchasedCount={0}
          executeItemsLength={0}
          remainingCost={0}
          hasMapData={false}
          isMapVisible={false}
          onToggleMapVisibility={vi.fn()}
          onLayoutModeChange={vi.fn()}
        />
        <SpaceNavigatorHost />
      </SpaceNavigatorProvider>,
    );

    expect(
      screen.getByRole("slider", { name: "スペースナビ" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "スペース一覧を開く" }),
    ).not.toBeInTheDocument();
    const summaryFooter = screen.getByText("残りの合計").closest(".fixed");
    expect((summaryFooter as HTMLElement).style.paddingBottom).toBe("");
    expect(
      (document.getElementById("focus-mode-footer") as HTMLElement).style
        .paddingBottom,
    ).toBe("");
    const footerHeightRule = Array.from(document.styleSheets)
      .flatMap((styleSheet) => Array.from(styleSheet.cssRules))
      .find(
        (rule) =>
          rule.type === CSSRule.STYLE_RULE &&
          (rule as CSSStyleRule).selectorText ===
            ":root:where(:not(.esp-dynamic-css-disabled))",
      ) as CSSStyleRule | undefined;
    expect(footerHeightRule?.style.getPropertyValue("--footer-height")).toBe(
      "123px",
    );
    expect(
      document.documentElement.style.getPropertyValue("--footer-height"),
    ).toBe("");
    dynamicRegistry.remove();
    offsetHeight.mockRestore();
  });

  it("opens the picker from the footer button when the rail is disabled", () => {
    localStorage.setItem(
      "spaceNavigatorSettings",
      JSON.stringify({ railVisible: false, footerButtonVisible: true }),
    );
    render(
      <SpaceNavigatorProvider>
        <StaticRegistration />
        <SpaceNavigatorHost />
      </SpaceNavigatorProvider>,
    );

    expect(
      screen.queryByRole("slider", { name: "スペースナビ" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "スペース一覧を開く" }));
    expect(
      screen.getByRole("dialog", { name: "スペース一覧" }),
    ).toBeInTheDocument();
  });

  it.each(["pc", "smartphone"] as const)(
    "opens a non-central clicked space action dialog directly in %s layout",
    (layoutMode) => {
      render(
        <SpaceNavigatorProvider>
          <StaticRegistration layoutMode={layoutMode} />
          <SpaceNavigatorHost />
        </SpaceNavigatorProvider>,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "スペース一覧を開く" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: new RegExp(entries[2].label) }),
      );

      expect(
        screen.getByRole("dialog", { name: entries[2].label }),
      ).toBeInTheDocument();
    },
  );

  it("positions host notifications above the measured footer without adding safe-area twice", () => {
    render(
      <SpaceNavigatorProvider>
        <StaticRegistration />
        <NotificationTrigger />
        <SpaceNavigatorHost />
      </SpaceNavigatorProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getByRole("status")).toHaveClass(
      "bottom-[calc(var(--footer-height,0px)+0.75rem)]",
    );
    expect(screen.getByRole("status")).not.toHaveAttribute("style");
  });

  it("keeps information notifications slate and renders warnings in red", () => {
    render(
      <SpaceNavigatorProvider>
        <StaticRegistration />
        <NotificationTrigger />
        <SpaceNavigatorHost />
      </SpaceNavigatorProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getByRole("status")).toHaveClass(
      "bg-slate-950",
      "dark:bg-slate-100",
    );
    expect(screen.getByRole("status")).not.toHaveClass("bg-red-600");

    fireEvent.click(screen.getByRole("button", { name: "警告通知" }));
    expect(screen.getByRole("status")).toHaveClass(
      "bg-red-600",
      "dark:bg-red-700",
    );
    expect(screen.getByRole("status")).not.toHaveClass("bg-slate-950");
  });

  it.each([
    ["the registration disappears", "登録を解除"],
    ["the registration has no entries", "訪問先を0件にする"],
  ])(
    "closes action dialogs and releases the body scroll lock when %s",
    async (_caseName, invalidateRegistrationLabel) => {
      render(
        <SpaceNavigatorProvider>
          <MutableRegistration />
          <SpaceNavigatorHost />
        </SpaceNavigatorProvider>,
      );

      fireEvent.click(
        screen.getByRole("button", { name: "スペース一覧を開く" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: new RegExp(entries[0].label) }),
      );

      expect(
        screen.getByRole("dialog", { name: entries[0].label }),
      ).toBeInTheDocument();
      expect(document.body).toHaveClass(
        "esp-body-scroll-lock",
        "esp-body-overscroll-lock",
      );

      fireEvent.click(
        screen.getByRole("button", { name: invalidateRegistrationLabel }),
      );

      await waitFor(() => {
        expect(screen.queryAllByRole("dialog")).toHaveLength(0);
        expect(document.body).not.toHaveClass(
          "esp-body-scroll-lock",
          "esp-body-overscroll-lock",
        );
        expect(document.body.style.overflow).toBe("auto");
        expect(document.body.style.overscrollBehavior).toBe("contain");
      });
    },
  );
});
