// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RouteDiagnosticsOverlay from "./RouteDiagnosticsOverlay";

describe("RouteDiagnosticsOverlay", () => {
  it("stays hidden for a normal route", () => {
    const { container } = render(
      <RouteDiagnosticsOverlay
        diagnostics={{
          statuses: ["normal"],
          missingItemCount: 0,
          missingLocations: [],
          validLocationCount: 2,
        }}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows grouped missing locations and the no-partial-route explanation", () => {
    render(
      <RouteDiagnosticsOverlay
        diagnostics={{
          statuses: ["missing-location", "unreachable"],
          missingItemCount: 2,
          validLocationCount: 2,
          missingLocations: [
            {
              key: "a::12",
              label: "東A-12（2アイテム）",
              itemCount: 2,
              items: [
                { id: "a", circle: "Circle A", title: "Book A" },
                { id: "b", circle: "Circle B", title: "Book B" },
              ],
            },
          ],
        }}
      />,
    );

    expect(
      screen.getByText("経路を作成できません ／ 場所未確認 2アイテム"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "障害物を避けた経路が見つからないため、誤解を招く線は表示していません。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("東A-12（2アイテム）")).toBeInTheDocument();
  });
});
