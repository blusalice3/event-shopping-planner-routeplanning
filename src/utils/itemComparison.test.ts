import { describe, expect, it } from "vitest";
import {
  getItemKey,
  getItemKeyWithoutTitle,
  insertItemSorted,
} from "./itemComparison";
import { ShoppingItem } from "../types/item";

const createItem = (
  id: string,
  overrides: Partial<ShoppingItem> = {},
): ShoppingItem => ({
  id,
  circle: "Circle",
  eventDate: "1日目",
  block: "A",
  number: "01a",
  title: `Title-${id}`,
  price: 100,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
  ...overrides,
});

describe("itemComparison utilities", () => {
  it("builds keys with and without title", () => {
    const item = createItem("1", {
      circle: "ABC",
      eventDate: "2日目",
      block: "B",
      number: "12a",
      title: "New Book",
    });

    expect(getItemKey(item)).toBe("ABC|2日目|B|12a|New Book");
    expect(getItemKeyWithoutTitle(item)).toBe("ABC|2日目|B|12a");
  });

  it("inserts within same-day block order using locale-aware numeric compare", () => {
    const items = [
      createItem("1", { eventDate: "1日目", block: "A", number: "10a" }),
      createItem("2", { eventDate: "1日目", block: "A", number: "12a" }),
      createItem("3", { eventDate: "2日目", block: "A", number: "01a" }),
    ];
    const newItem = createItem("new", {
      eventDate: "1日目",
      block: "A",
      number: "11a",
    });

    const result = insertItemSorted(items, newItem);

    expect(result.map((item) => item.id)).toEqual(["1", "new", "2", "3"]);
    expect(items.map((item) => item.id)).toEqual(["1", "2", "3"]);
  });

  it("appends to the end when the target day does not exist", () => {
    const items = [
      createItem("1", { eventDate: "1日目", block: "A", number: "01a" }),
      createItem("2", { eventDate: "2日目", block: "A", number: "01a" }),
    ];
    const newItem = createItem("new", {
      eventDate: "3日目",
      block: "A",
      number: "01a",
    });

    const result = insertItemSorted(items, newItem);

    expect(result.map((item) => item.id)).toEqual(["1", "2", "new"]);
  });
});
