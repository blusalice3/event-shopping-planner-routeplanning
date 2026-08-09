// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ResumeChoiceDialogView } from "./FocusModeStateViews";

describe("focus mode accessible white-text backgrounds", () => {
  it("uses opaque white copy on AA resume backgrounds", () => {
    render(
      <ResumeChoiceDialogView
        dialog={{
          isOpen: true,
          lastSpaceLabel: "A-01 Circle",
          lastPhase: "normal",
          lastIndex: 0,
          pointerPhase: "normal",
          pointerIndex: 0,
          phaseStartPhase: "normal",
          lastChangeEnabled: true,
          phaseStartEnabled: true,
          normalStartEnabled: true,
          wasCompleted: false,
        }}
        onChoice={vi.fn()}
      />,
    );

    const heading = screen.getByRole("heading", {
      name: "集中モードを再開しますか？",
    });
    expect(heading.parentElement).toHaveClass(
      "from-teal-700",
      "to-indigo-600",
      "text-white",
    );
    expect(
      screen.getByText("どこから再開するか選んでください"),
    ).not.toHaveClass("text-white/85", "opacity-85");

    const lastChangeButton = screen.getByRole("button", {
      name: /最後に購入状態を変更したスペース/,
    });
    expect(lastChangeButton).toHaveClass(
      "bg-teal-700",
      "hover:bg-teal-800",
      "text-white",
    );
    expect(within(lastChangeButton).getByText(/A-01 Circle/)).not.toHaveClass(
      "text-white/85",
      "opacity-85",
    );
  });
});
