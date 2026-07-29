import { describe, expect, it } from "vitest";
import { extractEventDates } from "./eventDates";
import { ShoppingItem } from "../types/item";

const createItem = (eventDate: string, id: string): ShoppingItem => ({
  id,
  circle: `circle-${id}`,
  eventDate,
  block: "A",
  number: "01a",
  title: `title-${id}`,
  price: 100,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

describe("extractEventDates", () => {
  it("deduplicates and sorts dates after trimming", () => {
    const items: ShoppingItem[] = [
      createItem(" 2日目 ", "1"),
      createItem("1日目", "2"),
      createItem("10日目", "3"),
      createItem("1日目", "4"),
      createItem("", "5"),
      createItem("  ", "6"),
      createItem("A日目", "7"),
      createItem("B日目", "8"),
    ];

    expect(extractEventDates(items)).toEqual([
      "A日目",
      "B日目",
      "1日目",
      "2日目",
      "10日目",
    ]);
  });

  it("returns an empty array when all dates are empty", () => {
    const items: ShoppingItem[] = [createItem("", "1"), createItem("  ", "2")];
    expect(extractEventDates(items)).toEqual([]);
  });
});
