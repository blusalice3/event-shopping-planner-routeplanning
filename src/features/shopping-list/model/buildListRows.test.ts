import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import { buildListRows } from "./buildListRows";

const item = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: `新刊${id}`,
  price: 1000,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

describe("buildListRows", () => {
  it("builds stable flat item rows with shared semantics", () => {
    const first = item("1");
    const second = item("2", { block: "西B", number: "02b" });
    const model = buildListRows({
      items: [first, second],
      column: "execute",
      selectedItemIds: new Set(["2"]),
      duplicateCircleItemIds: new Set(["1"]),
      highlightedItemId: "2",
    });

    expect(model.hasStableRowKeys).toBe(true);
    expect(model.itemIds).toEqual(["1", "2"]);
    expect(model.itemRows).toEqual([
      expect.objectContaining({
        kind: "item",
        itemId: "1",
        column: "execute",
        accessibleName: "東A01a サークル1 新刊1",
        positionInSet: 1,
        setSize: 2,
        flags: {
          selected: false,
          duplicateCircle: true,
          highlighted: false,
        },
      }),
      expect.objectContaining({
        kind: "item",
        itemId: "2",
        accessibleName: "西B02b サークル2 新刊2",
        positionInSet: 2,
        setSize: 2,
        flags: {
          selected: true,
          duplicateCircle: false,
          highlighted: true,
        },
      }),
    ]);
  });

  it("uses the same grouped model for full and virtual renderers", () => {
    const first = item("1");
    const second = item("2");
    const model = buildListRows({
      items: [first, second],
      groups: [
        {
          key: "東A01",
          label: "東A01",
          items: [first],
        },
        {
          key: "東A02",
          label: "東A02",
          items: [second],
          collapsed: true,
        },
      ],
    });

    expect(model.rows.map((row) => row.kind)).toEqual([
      "group",
      "item",
      "group",
    ]);
    expect(model.itemIds).toEqual(["1"]);
    expect(model.rows[2]).toMatchObject({
      kind: "group",
      collapsed: true,
      itemCount: 1,
      accessibleName: "東A02 1件",
    });
  });

  it("keeps React keys unique but makes duplicate source IDs ineligible", () => {
    const model = buildListRows({
      items: [item("duplicate"), item("duplicate")],
    });

    expect(new Set(model.rows.map((row) => row.rowKey)).size).toBe(2);
    expect(model.hasStableRowKeys).toBe(false);
  });
});
