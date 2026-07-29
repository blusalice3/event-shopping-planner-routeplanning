// @vitest-environment jsdom

import React, { useEffect, useMemo, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function StaticRegistration() {
  const { register } = useSpaceNavigator();
  const registration = useMemo<SpaceNavigatorRegistration>(
    () => ({
      id: "common-ui-test",
      mode: "execute",
      entries,
      currentIndex: 0,
      formalIndex: 0,
      layoutMode: "smartphone",
      onNavigate: async () => ({ ok: true }),
    }),
    [],
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
    <button type="button" onClick={() => notify("お知らせ")}>
      通知
    </button>
  );
}

const dispatchPointer = (
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientY: number,
) => {
  const event = new MouseEvent(type, { bubbles: true, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
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
  });

  it("uses five fully shared rows on a 360x640-class viewport and keeps the candidate centered", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 360,
    });
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        side="left"
        onCandidateChange={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const windowElement = screen.getByTestId("space-navigator-window");
    expect(windowElement).toHaveAttribute("data-visible-row-count", "5");
    expect(windowElement).toHaveStyle({
      gridTemplateRows: "repeat(5, minmax(0, 1fr))",
    });
    expect(
      windowElement.querySelector('[aria-current="true"]'),
    ).toHaveTextContent(entries[4].label);
    expect(screen.getByRole("dialog", { name: "スペース一覧" })).toHaveStyle({
      bottom: "var(--footer-height, 0px)",
    });
  });

  it("moves only one row on an adjacent short tap", () => {
    const onCandidateChange = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
        side="left"
        onCandidateChange={onCandidateChange}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(entries[2].label) }),
    );
    expect(onCandidateChange).toHaveBeenCalledWith(3);
  });

  it("updates only the candidate during a drag and does not select on pointer release", () => {
    const onCandidateChange = vi.fn();
    const onSelect = vi.fn();
    render(
      <SpaceNavigatorPicker
        entries={entries}
        candidateIndex={4}
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
    dispatchPointer(windowElement, "pointermove", 7, 90);
    dispatchPointer(windowElement, "pointerup", 7, 90);

    expect(onCandidateChange).toHaveBeenCalledWith(5);
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

describe("SpaceNavigatorHost and footer visibility", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehavior = "contain";
  });

  afterEach(() => {
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
    expect(
      document.documentElement.style.getPropertyValue("--footer-height"),
    ).toBe("123px");
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

  it("positions host notifications above the measured footer without adding safe-area twice", () => {
    render(
      <SpaceNavigatorProvider>
        <StaticRegistration />
        <NotificationTrigger />
        <SpaceNavigatorHost />
      </SpaceNavigatorProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    expect(screen.getByRole("status")).toHaveStyle({
      bottom: "calc(var(--footer-height, 0px) + .75rem)",
    });
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
      expect(document.body.style.overflow).toBe("hidden");
      expect(document.body.style.overscrollBehavior).toBe("none");

      fireEvent.click(
        screen.getByRole("button", { name: invalidateRegistrationLabel }),
      );

      await waitFor(() => {
        expect(screen.queryAllByRole("dialog")).toHaveLength(0);
        expect(document.body.style.overflow).toBe("auto");
        expect(document.body.style.overscrollBehavior).toBe("contain");
      });
    },
  );
});
