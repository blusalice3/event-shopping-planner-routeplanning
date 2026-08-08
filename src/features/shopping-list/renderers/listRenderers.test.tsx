// @vitest-environment jsdom

import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import { buildListRows, type ShoppingListRow } from "../model/buildListRows";
import { FullListRenderer } from "./FullListRenderer";
import { getShoppingListRowAccessibilityAttributes } from "./rowAccessibility";
import {
  extractVirtualIndexesWithPinnedFocus,
  resolveVirtualScrollAnchorOffset,
  VirtualListRenderer,
} from "./VirtualListRenderer";

const item = (id: string): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate: "1日目",
  block: "東A",
  number: id,
  title: `新刊${id}`,
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

const renderRow = (row: ShoppingListRow) => (
  <div
    role="listitem"
    aria-label={row.accessibleName}
    data-row-key={row.rowKey}
  />
);

let scrollToSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  scrollToSpy.mockRestore();
});

describe("list renderer boundaries", () => {
  const model = buildListRows({ items: [item("1"), item("2"), item("3")] });

  it("marks the existing full DOM without adding a wrapper", () => {
    const { container } = render(
      <FullListRenderer model={model} selectionReason="virtual-ineligible">
        <section aria-label="既存リストDOM" />
      </FullListRenderer>,
    );

    expect(container.children).toHaveLength(1);
    expect(
      screen.getByLabelText("既存リストDOM").getAttribute("data-list-renderer"),
    ).toBe("full");
    expect(
      screen
        .getByLabelText("既存リストDOM")
        .getAttribute("data-list-row-count"),
    ).toBe("3");
  });

  it("uses the canonical accessible names in full and virtual windows", () => {
    const full = render(
      <FullListRenderer
        model={model}
        accessibleLabel="full"
        renderRow={renderRow}
      />,
    );
    expect(full.getByLabelText("東A1 サークル1 新刊1")).not.toBeNull();
    expect(full.getByLabelText("東A3 サークル3 新刊3")).not.toBeNull();
    full.unmount();

    render(
      <VirtualListRenderer
        model={model}
        accessibleLabel="virtual"
        window={{
          startIndex: 1,
          endIndexExclusive: 3,
          beforeSpacer: <div data-testid="before" />,
          afterSpacer: <div data-testid="after" />,
        }}
        renderRow={renderRow}
      />,
    );
    expect(screen.queryByLabelText("東A1 サークル1 新刊1")).toBeNull();
    expect(screen.getByLabelText("東A2 サークル2 新刊2")).not.toBeNull();
    expect(screen.getByLabelText("東A3 サークル3 新刊3")).not.toBeNull();
  });

  it("rejects an unsafe virtual window", () => {
    expect(() =>
      VirtualListRenderer({
        model,
        accessibleLabel: "virtual",
        window: {
          startIndex: 0,
          endIndexExclusive: 4,
          beforeSpacer: null,
          afterSpacer: null,
        },
        renderRow,
      }),
    ).toThrow(RangeError);
  });

  it("exposes the same list-item name and position metadata to both engines", () => {
    const row = model.itemRows[1];
    expect(getShoppingListRowAccessibilityAttributes(row)).toEqual({
      role: "listitem",
      "aria-label": "東A2 サークル2 新刊2",
      "aria-posinset": 2,
      "aria-setsize": 3,
      "data-row-key": row.rowKey,
    });
  });

  it("pins a focused row into the TanStack extraction range", () => {
    const range = {
      startIndex: 10,
      endIndex: 14,
      overscan: 2,
      count: 100,
    };
    const defaultIndexes = extractVirtualIndexesWithPinnedFocus(range, null);
    const pinnedIndexes = extractVirtualIndexesWithPinnedFocus(range, 72);

    expect(defaultIndexes).not.toContain(72);
    expect(pinnedIndexes).toContain(72);
    expect(pinnedIndexes).toEqual(
      [...new Set(pinnedIndexes)].sort((left, right) => left - right),
    );
  });

  it("restores a stable-key scroll anchor after rows are reordered", () => {
    const offset = resolveVirtualScrollAnchorOffset(
      { rowKey: "item:anchor", offsetWithinRow: 17 },
      new Map([
        ["item:other", 0],
        ["item:anchor", 4],
      ]),
      (index) => [index * 100, "start"],
    );

    expect(offset).toBe(417);
    expect(
      resolveVirtualScrollAnchorOffset(
        { rowKey: "item:removed", offsetWithinRow: 17 },
        new Map(),
        () => [0, "start"],
      ),
    ).toBeNull();
  });

  it("runs the measured TanStack window without element style attributes", async () => {
    const longItems = Array.from({ length: 100 }, (_, index) =>
      item(`${index + 1}`),
    );
    const longModel = buildListRows({ items: longItems });
    const view = render(
      <VirtualListRenderer
        model={longModel}
        accessibleLabel="runtime"
        estimateSizePx={96}
        overscan={6}
        renderRow={(row) => <button>{row.accessibleName}</button>}
      />,
    );
    const root = screen.getByRole("list", { name: "runtime" });

    await waitFor(() => {
      expect(root.querySelectorAll('[role="listitem"]').length).toBeGreaterThan(
        0,
      );
    });
    expect(root.getAttribute("data-list-renderer")).toBe("virtual");
    expect(root.querySelectorAll('[role="listitem"]').length).toBeLessThan(100);
    expect(view.container.querySelector("[style]")).toBeNull();

    const firstVirtualRow =
      root.querySelector<HTMLElement>('[role="listitem"]');
    expect(firstVirtualRow).toHaveAttribute("aria-posinset");
    expect(firstVirtualRow).toHaveAttribute("aria-setsize", "100");
    expect(firstVirtualRow).toHaveAttribute("data-row-key");

    const firstButton = firstVirtualRow?.querySelector("button");
    firstButton?.focus();
    expect(document.activeElement).toBe(firstButton);
    scrollToSpy.mockClear();

    view.rerender(
      <VirtualListRenderer
        model={buildListRows({
          items: [...longItems.slice(1), longItems[0]],
        })}
        accessibleLabel="runtime"
        estimateSizePx={96}
        overscan={6}
        renderRow={(row) => <button>{row.accessibleName}</button>}
      />,
    );

    await waitFor(() => {
      expect(document.activeElement).toHaveTextContent("東A1 サークル1 新刊1");
      expect(scrollToSpy).toHaveBeenCalled();
    });
  });
});
