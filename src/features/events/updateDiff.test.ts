import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../types/item";
import { createEventUpdateDiff, type SheetItem } from "./updateDiff";

const currentItem = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "item-1",
  circle: "サークルA",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊",
  price: 900,
  catalogPrice: 1000,
  purchaseStatus: "None",
  quantity: 2,
  remarks: "利用者メモ",
  sheetRemarks: "旧シート備考",
  url: "https://old.example",
  source: "spreadsheet",
  protectionLevel: "none",
  assignedTo: "担当者",
  orderIndex: 7,
  ...overrides,
});

const sheetItem = (overrides: Partial<SheetItem> = {}): SheetItem => ({
  circle: "サークルA",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "新刊",
  price: 1200,
  quantity: 3,
  remarks: "新シート備考",
  url: "https://new.example",
  ...overrides,
});

describe("createEventUpdateDiff quantity and field allowlist", () => {
  it("通常品目は数量・カタログ価格・シート備考・URLだけを同期する", () => {
    const before = currentItem({
      limitedPurchasedQuantity: 1,
      lastSyncedAt: "2026-01-01",
    });
    const diff = createEventUpdateDiff([before], [sheetItem()]);

    expect(diff.itemsToUpdate).toHaveLength(1);
    expect(diff.itemsToUpdate[0]).toMatchObject({
      quantity: 3,
      catalogPrice: 1200,
      sheetRemarks: "新シート備考",
      url: "https://new.example",
      price: 900,
      remarks: "利用者メモ",
      purchaseStatus: "None",
      limitedPurchasedQuantity: 1,
      assignedTo: "担当者",
      orderIndex: 7,
      lastSyncedAt: "2026-01-01",
    });
    expect(diff.quantityWarnings).toEqual([]);
    expect(diff.pendingPurchasedQuantityChanges).toEqual([]);
  });

  it("既存品目の空欄と旧データの数量21超をそのまま維持する", () => {
    const before = currentItem({ quantity: 25 });
    const diff = createEventUpdateDiff(
      [before],
      [
        sheetItem({
          price: 1000,
          remarks: "旧シート備考",
          url: "https://old.example",
          rawQuantity: "",
        }),
      ],
    );

    expect(diff.itemsToUpdate).toEqual([]);
    expect(diff.quantityWarnings).toEqual([]);
    expect(before.quantity).toBe(25);
  });

  it("既存品目の不正数量を警告し、数量は変更しない", () => {
    const before = currentItem();
    const diff = createEventUpdateDiff(
      [before],
      [
        sheetItem({
          price: 1000,
          remarks: "旧シート備考",
          url: "https://old.example",
          rawQuantity: "21",
        }),
      ],
    );

    expect(diff.itemsToUpdate).toEqual([]);
    expect(diff.quantityWarnings).toEqual([
      expect.objectContaining({
        kind: "existing-quantity-not-updated",
        receivedValue: "21",
      }),
    ]);
  });

  it("新規品目の空欄は数量1で追加し、不正数量の行は品目ごと追加しない", () => {
    const diff = createEventUpdateDiff(
      [],
      [
        sheetItem({ number: "01a", rawQuantity: "" }),
        sheetItem({ number: "02a", rawQuantity: "0" }),
      ],
    );

    expect(diff.itemsToAdd).toEqual([
      expect.objectContaining({
        number: "01a",
        quantity: 1,
        price: 1200,
        catalogPrice: 1200,
        remarks: "新シート備考",
        sheetRemarks: "新シート備考",
      }),
    ]);
    expect(diff.quantityWarnings).toEqual([
      expect.objectContaining({
        kind: "new-item-skipped",
        number: "02a",
        receivedValue: "0",
      }),
    ]);
  });

  it("購入済みと限定購入の予定数量変更を、明示確認待ちとして分離する", () => {
    const purchased = currentItem({
      id: "purchased",
      purchaseStatus: "Purchased",
      quantity: 2,
    });
    const limited = currentItem({
      id: "limited",
      number: "02a",
      purchaseStatus: "LimitedPurchase",
      quantity: 4,
      limitedPurchasedQuantity: 2,
    });
    const diff = createEventUpdateDiff(
      [purchased, limited],
      [
        sheetItem({
          price: 1000,
          remarks: "旧シート備考",
          url: "https://old.example",
          rawQuantity: "3",
        }),
        sheetItem({
          number: "02a",
          price: 1000,
          remarks: "旧シート備考",
          url: "https://old.example",
          rawQuantity: "5",
        }),
      ],
    );

    expect(diff.itemsToUpdate).toEqual([]);
    expect(diff.pendingPurchasedQuantityChanges).toEqual([
      expect.objectContaining({
        itemId: "purchased",
        purchaseStatus: "Purchased",
        currentQuantity: 2,
        nextQuantity: 3,
      }),
      expect.objectContaining({
        itemId: "limited",
        purchaseStatus: "LimitedPurchase",
        currentQuantity: 4,
        nextQuantity: 5,
      }),
    ]);
  });

  it("限数の予定数量が実購入数以下なら警告へ分離し、有効な増加だけ確認候補にする", () => {
    const sameAsActual = currentItem({
      id: "same-as-actual",
      number: "01a",
      purchaseStatus: "LimitedPurchase",
      quantity: 5,
      limitedPurchasedQuantity: 3,
    });
    const belowActual = currentItem({
      id: "below-actual",
      number: "02a",
      purchaseStatus: "LimitedPurchase",
      quantity: 5,
      limitedPurchasedQuantity: 3,
    });
    const aboveActual = currentItem({
      id: "above-actual",
      number: "03a",
      purchaseStatus: "LimitedPurchase",
      quantity: 5,
      limitedPurchasedQuantity: 3,
    });

    const diff = createEventUpdateDiff(
      [sameAsActual, belowActual, aboveActual],
      [
        sheetItem({ number: "01a", rawQuantity: "3" }),
        sheetItem({ number: "02a", rawQuantity: "2" }),
        sheetItem({ number: "03a", rawQuantity: "4" }),
      ],
    );

    expect(diff.limitedPurchaseQuantityConflicts).toEqual([
      expect.objectContaining({
        itemId: "same-as-actual",
        actualPurchasedQuantity: 3,
        currentQuantity: 5,
        nextQuantity: 3,
      }),
      expect.objectContaining({
        itemId: "below-actual",
        actualPurchasedQuantity: 3,
        currentQuantity: 5,
        nextQuantity: 2,
      }),
    ]);
    expect(diff.pendingPurchasedQuantityChanges).toEqual([
      expect.objectContaining({
        itemId: "above-actual",
        currentQuantity: 5,
        nextQuantity: 4,
      }),
    ]);
  });

  it("更新保護された購入済み品目は予定数量の確認候補にも入れない", () => {
    const protectedItem = currentItem({
      purchaseStatus: "Purchased",
      protectionLevel: "deletable",
      quantity: 2,
    });

    const diff = createEventUpdateDiff(
      [protectedItem],
      [
        sheetItem({
          price: 1000,
          remarks: "旧シート備考",
          url: "https://old.example",
          rawQuantity: "3",
        }),
      ],
    );

    expect(diff.itemsToUpdate).toEqual([]);
    expect(diff.pendingPurchasedQuantityChanges).toEqual([]);
    expect(diff.protectedFromUpdate).toBe(1);
  });
});
