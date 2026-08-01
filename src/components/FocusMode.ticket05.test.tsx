// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FocusMode from "./FocusMode";
import {
  completedFixture,
  minimalProps,
  singleVisitNoneItemFixture,
} from "./FocusMode.fixtures";

describe("FocusMode TICKET-05 resume completion semantics", () => {
  it("does not render the completion screen until the pointer resume choice is selected", async () => {
    render(
      <FocusMode
        {...minimalProps({
          resumeState: completedFixture,
          ...singleVisitNoneItemFixture,
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("全ての訪問先を確認しました")).toBeNull();
    });
  });
});
