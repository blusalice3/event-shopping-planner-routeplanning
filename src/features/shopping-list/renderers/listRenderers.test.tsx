// @vitest-environment jsdom

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import { buildListRows, type ShoppingListRow } from "../model/buildListRows";
import {
  FullListRenderer,
  type FullListRenderedItemRow,
} from "./FullListRenderer";
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

  it("owns the full root and renders only canonical model rows", () => {
    const renderCanonicalRow = vi.fn(renderRow);
    const { container } = render(
      <FullListRenderer
        model={model}
        selectionReason="virtual-ineligible"
        accessibleLabel="既存リストDOM"
        beforeContent={<span data-testid="before-content" />}
        afterContent={<span data-testid="after-content" />}
        renderRow={renderCanonicalRow}
      />,
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
    expect(renderCanonicalRow).toHaveBeenCalledTimes(3);
    expect(renderCanonicalRow.mock.calls.map(([row]) => row.rowKey)).toEqual(
      model.rows.map((row) => row.rowKey),
    );
    expect(screen.getByTestId("before-content")).not.toBeNull();
    expect(screen.getByTestId("after-content")).not.toBeNull();
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

  it("segments grouped rows and decorates every canonical group and item row", () => {
    const groupedModel = buildListRows({
      items: [item("1"), item("2"), item("3")],
      groups: [
        {
          key: "first",
          label: "第1グループ",
          items: [item("1"), item("2")],
        },
        { key: "second", label: "第2グループ", items: [item("3")] },
      ],
    });
    const renderGroup = vi.fn(
      (
        row: Extract<ShoppingListRow, { kind: "group" }>,
        renderedItemRows: readonly FullListRenderedItemRow[],
      ) => (
        <section>
          <span>{row.label}</span>
          <div role="list" aria-label={`${row.label}の項目`}>
            {renderedItemRows.map((renderedItemRow) =>
              renderedItemRow.render(
                <button>{renderedItemRow.row.accessibleName}</button>,
              ),
            )}
          </div>
        </section>
      ),
    );

    const view = render(
      <FullListRenderer
        model={groupedModel}
        accessibleLabel="grouped"
        renderGroup={renderGroup}
      />,
    );
    const renderedKeys = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-row-key]"),
      (element) => element.dataset.rowKey,
    );

    expect(renderedKeys).toEqual(groupedModel.rows.map((row) => row.rowKey));
    expect(new Set(renderedKeys).size).toBe(groupedModel.rows.length);
    expect(renderGroup).toHaveBeenCalledTimes(2);
    expect(renderGroup.mock.calls.map((call) => call[1].length)).toEqual([
      2, 1,
    ]);
    expect(screen.getByLabelText("第1グループ 2件")).toHaveAttribute(
      "role",
      "listitem",
    );
    expect(screen.getByLabelText("東A2 サークル2 新刊2")).toHaveAttribute(
      "aria-posinset",
      "2",
    );
    expect(screen.getByLabelText("東A3 サークル3 新刊3")).toHaveAttribute(
      "aria-setsize",
      "3",
    );
  });

  it("fails closed when grouped rendering omits a canonical row", () => {
    const groupedModel = buildListRows({
      items: [item("1")],
      groups: [{ key: "first", label: "第1グループ", items: [item("1")] }],
    });

    expect(() =>
      renderToStaticMarkup(
        <FullListRenderer
          model={groupedModel}
          accessibleLabel="grouped"
          renderGroup={() => <section>canonical item omitted</section>}
        />,
      ),
    ).toThrow(/canonical row .* was not rendered exactly once/);
  });

  it("fails closed when grouped rendering receives an orphan item row", () => {
    expect(() =>
      renderToStaticMarkup(
        <FullListRenderer
          model={model}
          accessibleLabel="grouped"
          renderGroup={() => <section />}
        />,
      ),
    ).toThrow(/orphan item row/);
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
