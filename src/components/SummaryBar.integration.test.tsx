import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SummaryBar from "./SummaryBar";

vi.mock(
  "../features/space-navigation/components/SpaceNavigatorFooterButton",
  () => ({
    SpaceNavigatorFooterButton: ({ compact }: { compact?: boolean }) => (
      <button type="button" data-compact={String(Boolean(compact))}>
        ナビ
      </button>
    ),
  }),
);

vi.mock("../features/space-navigation/SpaceNavigatorContext", () => ({
  useOptionalSpaceNavigator: () => null,
}));

describe("SummaryBar layout", () => {
  it("groups summaries and actions into two compact columns in smartphone mode", () => {
    const onFilterToggle = vi.fn();

    render(
      <SummaryBar
        items={[]}
        layoutMode="smartphone"
        filterLabel="巡回順"
        onFilterToggle={onFilterToggle}
      />,
    );

    const purchasedSummary = screen.getByText(/件購入済み/);
    const remainingSummary = screen.getByText("残りの合計").parentElement;
    const filterButton = screen.getByRole("button", {
      name: "購入状態フィルタ切替（現在: 巡回順）",
    });
    const navigatorButton = screen.getByRole("button", { name: "ナビ" });

    expect(purchasedSummary.parentElement).toBe(
      remainingSummary?.parentElement,
    );
    expect(filterButton.parentElement).toBe(navigatorButton.parentElement);
    expect(purchasedSummary.parentElement).toHaveClass("basis-32", "flex-1");
    expect(filterButton.parentElement).toHaveClass("shrink-0", "empty:hidden");
    expect(navigatorButton).toHaveAttribute("data-compact", "true");

    fireEvent.click(filterButton);
    expect(onFilterToggle).toHaveBeenCalledOnce();
  });

  it("keeps the existing item order and full-size navigator in PC mode", () => {
    render(
      <SummaryBar
        items={[]}
        layoutMode="pc"
        filterLabel="巡回順"
        onFilterToggle={vi.fn()}
      />,
    );

    const purchasedSummary = screen.getByText(/件購入済み/);
    const filterButton = screen.getByRole("button", {
      name: "購入状態フィルタ切替（現在: 巡回順）",
    });
    const navigatorButton = screen.getByRole("button", { name: "ナビ" });
    const remainingSummary = screen.getByText("残りの合計").parentElement;
    const layout = purchasedSummary.parentElement;

    expect(layout).toHaveClass("flex-col", "sm:flex-row");
    expect(Array.from(layout?.children ?? [])).toEqual([
      purchasedSummary,
      filterButton,
      navigatorButton,
      remainingSummary,
    ]);
    expect(navigatorButton).toHaveAttribute("data-compact", "false");
  });
});
