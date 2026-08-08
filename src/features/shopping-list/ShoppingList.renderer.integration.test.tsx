import React from "react";
import { fireEvent, render } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import ShoppingList from "../../components/ShoppingList";
import type { ShoppingItem } from "../../types/item";
import type {
  ListRendererPreferencePort,
  ListRendererPreferenceReadResult,
} from "./preference/ListRendererPreferencePort";

const preferencePort = (
  result: ListRendererPreferenceReadResult,
): ListRendererPreferencePort => ({
  read: () => result,
  write: vi.fn(() => true),
});

const originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "visualViewport",
);
let scrollToSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

const setViewportScale = (scale: number): void => {
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      scale,
    } as unknown as VisualViewport,
  });
};

afterAll(() => {
  scrollToSpy.mockRestore();
  if (originalVisualViewportDescriptor) {
    Object.defineProperty(
      window,
      "visualViewport",
      originalVisualViewportDescriptor,
    );
  } else {
    Reflect.deleteProperty(window, "visualViewport");
  }
});

const item = (index: number): ShoppingItem => ({
  id: `item-${index}`,
  circle: `サークル${index}`,
  eventDate: "1日目",
  block: "東A",
  number: String(index),
  title: `新刊${index}`,
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

const longItems = Array.from({ length: 100 }, (_, index) => item(index + 1));

const renderEmptyList = (
  port: ListRendererPreferencePort,
  forceFullListRenderer = false,
) =>
  render(
    <ShoppingList
      items={[]}
      onUpdateItem={vi.fn()}
      onMoveItem={vi.fn()}
      onEditRequest={vi.fn()}
      onDeleteRequest={vi.fn()}
      selectedItemIds={new Set()}
      onSelectItem={vi.fn()}
      skipLimitedPurchaseForSingleQuantity={false}
      listRendererPreferencePort={port}
      forceFullListRenderer={forceFullListRenderer}
    />,
  );

const renderLongList = ({
  port = preferencePort({ status: "ok", value: "auto" }),
  layoutMode = "smartphone",
  recoveryActive = false,
}: {
  port?: ListRendererPreferencePort;
  layoutMode?: "pc" | "smartphone";
  recoveryActive?: boolean | null;
} = {}) =>
  render(
    <ShoppingList
      items={longItems}
      onUpdateItem={vi.fn()}
      onMoveItem={vi.fn()}
      onEditRequest={vi.fn()}
      onDeleteRequest={vi.fn()}
      selectedItemIds={new Set()}
      onSelectItem={vi.fn()}
      skipLimitedPurchaseForSingleQuantity={false}
      listRendererPreferencePort={port}
      layoutMode={layoutMode}
      recoveryActive={recoveryActive}
    />,
  );

describe("ShoppingList renderer integration", () => {
  it("defaults a missing preference to auto and fails closed to the full DOM", () => {
    const view = renderEmptyList(preferencePort({ status: "missing" }));
    const root = view.container.firstElementChild;

    expect(root?.getAttribute("data-list-renderer")).toBe("full");
    expect(root?.getAttribute("data-list-renderer-reason")).toBe(
      "virtual-ineligible",
    );
    expect(root?.getAttribute("data-list-row-count")).toBe("0");
  });

  it("uses full for corrupt preferences and a force-full QA policy", () => {
    const corrupt = renderEmptyList(preferencePort({ status: "invalid" }));
    expect(
      corrupt.container.firstElementChild?.getAttribute(
        "data-list-renderer-reason",
      ),
    ).toBe("preference-full");
    corrupt.unmount();

    const forced = renderEmptyList(
      preferencePort({ status: "ok", value: "auto" }),
      true,
    );
    expect(
      forced.container.firstElementChild?.getAttribute(
        "data-list-renderer-reason",
      ),
    ).toBe("force-full");
  });

  it("uses the TanStack runtime for an eligible long single-column list", () => {
    setViewportScale(1);
    const view = renderLongList();
    const root = view.container.firstElementChild;
    const renderedRows = root?.querySelectorAll('[role="listitem"]') ?? [];

    expect(root?.getAttribute("data-list-renderer")).toBe("virtual");
    expect(root?.getAttribute("data-list-row-count")).toBe("100");
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThan(100);
    expect(root?.querySelector("[style]")).toBeNull();
    expect(renderedRows[0]).toHaveAttribute("aria-posinset");
    expect(renderedRows[0]).toHaveAttribute("aria-setsize", "100");
  });

  it("fails closed for unsupported zoom, multiple columns, and recovery", () => {
    setViewportScale(1.25);
    const zoomed = renderLongList();
    expect(
      zoomed.container.firstElementChild?.getAttribute("data-list-renderer"),
    ).toBe("full");
    zoomed.unmount();

    setViewportScale(1);
    const multipleColumns = renderLongList({ layoutMode: "pc" });
    expect(
      multipleColumns.container.firstElementChild?.getAttribute(
        "data-list-renderer",
      ),
    ).toBe("full");
    multipleColumns.unmount();

    const recovery = renderLongList({ recoveryActive: true });
    expect(
      recovery.container.firstElementChild?.getAttribute("data-list-renderer"),
    ).toBe("full");
  }, 20_000);

  it("keeps a corrupt preference and the QA policy on the full long-list path", () => {
    setViewportScale(1);
    const corrupt = renderLongList({
      port: preferencePort({ status: "invalid" }),
    });
    expect(
      corrupt.container.firstElementChild?.getAttribute(
        "data-list-renderer-reason",
      ),
    ).toBe("preference-full");
    corrupt.unmount();

    const failedRead = renderLongList({
      port: {
        read: () => {
          throw new Error("storage unavailable");
        },
        write: vi.fn(() => false),
      },
    });
    expect(
      failedRead.container.firstElementChild?.getAttribute(
        "data-list-renderer-reason",
      ),
    ).toBe("preference-full");
    failedRead.unmount();

    const forced = render(
      <ShoppingList
        items={longItems}
        onUpdateItem={vi.fn()}
        onMoveItem={vi.fn()}
        onEditRequest={vi.fn()}
        onDeleteRequest={vi.fn()}
        selectedItemIds={new Set()}
        onSelectItem={vi.fn()}
        skipLimitedPurchaseForSingleQuantity={false}
        listRendererPreferencePort={preferencePort({
          status: "ok",
          value: "auto",
        })}
        layoutMode="smartphone"
        forceFullListRenderer
      />,
    );
    expect(
      forced.container.firstElementChild?.getAttribute(
        "data-list-renderer-reason",
      ),
    ).toBe("force-full");
  }, 20_000);

  it("switches to the full renderer before processing an active drag", () => {
    setViewportScale(1);
    const view = renderLongList();
    const source = view.container.querySelector<HTMLElement>(
      '[data-item-id="item-1"]',
    );
    expect(source).not.toBeNull();

    fireEvent.dragStart(source!, {
      dataTransfer: { setData: vi.fn() },
    });

    expect(
      view.container.firstElementChild?.getAttribute("data-list-renderer"),
    ).toBe("full");
    expect(
      view.container.firstElementChild?.getAttribute(
        "data-list-renderer-reason",
      ),
    ).toBe("virtual-ineligible");
  });
});
