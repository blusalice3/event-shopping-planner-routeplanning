import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../types/item";
import { applyEventUpdateToItems } from "./updateApply";
import type { EventUpdateDiff, SpreadsheetItemToAdd } from "./updateDiff";

const item = (overrides: Partial<ShoppingItem> = {}): ShoppingItem => ({
  id: "item-1",
  circle: "サークルA",
  eventDate: "1日目",
  block: "東A",
  number: "01a",
  title: "旧タイトル",
  price: 900,
  catalogPrice: 1000,
  purchaseStatus: "LimitedPurchase",
  quantity: 4,
  limitedPurchasedQuantity: 2,
  remarks: "利用者メモ",
  sheetRemarks: "旧シート備考",
  url: "https://old.example",
  source: "spreadsheet",
  protectionLevel: "deletable",
  assignedTo: "担当者",
  lastSyncedAt: "2026-01-01",
  orderIndex: 8,
  postponed: true,
  manualHallId: "hall-1",
  ...overrides,
});

const payload = (
  overrides: Partial<
    Pick<
      EventUpdateDiff,
      | "itemsToDelete"
      | "itemsToUpdate"
      | "itemsToAdd"
      | "pendingPurchasedQuantityChanges"
    >
  > = {},
) => ({
  itemsToDelete: [],
  itemsToUpdate: [],
  itemsToAdd: [],
  pendingPurchasedQuantityChanges: [],
  ...overrides,
});

describe("applyEventUpdateToItems allowlist", () => {
  it("同期対象外フィールドと別品目を、更新データに含まれていても変更しない", () => {
    const before = item();
    const untouched = item({ id: "item-2", number: "02a" });
    const hostileUpdate: ShoppingItem = {
      ...before,
      title: "新タイトル",
      quantity: 5,
      catalogPrice: 1200,
      sheetRemarks: "新シート備考",
      url: "https://new.example",
      price: 1,
      remarks: "上書きしてはいけない",
      purchaseStatus: "SoldOut",
      limitedPurchasedQuantity: 99,
      assignedTo: "別担当",
      orderIndex: 99,
      manualHallId: "hall-2",
    };

    const result = applyEventUpdateToItems(
      [before, untouched],
      payload({ itemsToUpdate: [hostileUpdate] }),
    );

    expect(result[0]).toEqual({
      ...before,
      title: "新タイトル",
      quantity: 5,
      catalogPrice: 1200,
      sheetRemarks: "新シート備考",
      url: "https://new.example",
    });
    expect(result[0]).toMatchObject({
      price: 900,
      remarks: "利用者メモ",
      purchaseStatus: "LimitedPurchase",
      limitedPurchasedQuantity: 2,
      assignedTo: "担当者",
      orderIndex: 8,
      manualHallId: "hall-1",
    });
    expect(result[1]).toBe(untouched);
  });

  it("購入済み予定数量は既定で維持し、明示許可時だけ反映する", () => {
    const before = item();
    const updateData = payload({
      pendingPurchasedQuantityChanges: [
        {
          itemId: before.id,
          circle: before.circle,
          eventDate: before.eventDate,
          block: before.block,
          number: before.number,
          title: before.title,
          purchaseStatus: "LimitedPurchase",
          currentQuantity: 4,
          nextQuantity: 5,
        },
      ],
    });

    expect(applyEventUpdateToItems([before], updateData)[0].quantity).toBe(4);

    const applied = applyEventUpdateToItems([before], updateData, {
      applyPurchasedQuantityChanges: true,
    })[0];
    expect(applied.quantity).toBe(5);
    expect(applied.purchaseStatus).toBe("LimitedPurchase");
    expect(applied.limitedPurchasedQuantity).toBe(2);
  });

  it("確認中に利用者が数量を変えた場合は、古い確認結果で上書きしない", () => {
    const changedWhileConfirming = item({ quantity: 6 });
    const result = applyEventUpdateToItems(
      [changedWhileConfirming],
      payload({
        pendingPurchasedQuantityChanges: [
          {
            itemId: changedWhileConfirming.id,
            circle: changedWhileConfirming.circle,
            eventDate: changedWhileConfirming.eventDate,
            block: changedWhileConfirming.block,
            number: changedWhileConfirming.number,
            title: changedWhileConfirming.title,
            purchaseStatus: "LimitedPurchase",
            currentQuantity: 4,
            nextQuantity: 5,
          },
        ],
      }),
      { applyPurchasedQuantityChanges: true },
    );

    expect(result[0].quantity).toBe(6);
  });

  it.each([3, 2])(
    "限数の実購入数3以上にならない予定数量%dは明示許可されても反映しない",
    (nextQuantity) => {
      const before = item({
        quantity: 5,
        limitedPurchasedQuantity: 3,
        protectionLevel: "none",
      });
      const result = applyEventUpdateToItems(
        [before],
        payload({
          pendingPurchasedQuantityChanges: [
            {
              itemId: before.id,
              circle: before.circle,
              eventDate: before.eventDate,
              block: before.block,
              number: before.number,
              title: before.title,
              purchaseStatus: "LimitedPurchase",
              currentQuantity: 5,
              nextQuantity,
            },
          ],
        }),
        { applyPurchasedQuantityChanges: true },
      );

      expect(result[0].quantity).toBe(5);
      expect(result[0].limitedPurchasedQuantity).toBe(3);
    },
  );

  it("限数の実購入数3より多い予定数量4は明示許可時に反映する", () => {
    const before = item({
      quantity: 5,
      limitedPurchasedQuantity: 3,
      protectionLevel: "none",
    });
    const result = applyEventUpdateToItems(
      [before],
      payload({
        pendingPurchasedQuantityChanges: [
          {
            itemId: before.id,
            circle: before.circle,
            eventDate: before.eventDate,
            block: before.block,
            number: before.number,
            title: before.title,
            purchaseStatus: "LimitedPurchase",
            currentQuantity: 5,
            nextQuantity: 4,
          },
        ],
      }),
      { applyPurchasedQuantityChanges: true },
    );

    expect(result[0].quantity).toBe(4);
    expect(result[0].limitedPurchasedQuantity).toBe(3);
  });

  it("新規シート品目は表示互換用と同期用の価格・備考を両方保持する", () => {
    const newItem: SpreadsheetItemToAdd = {
      circle: "サークルB",
      eventDate: "1日目",
      block: "東B",
      number: "03a",
      title: "新刊",
      price: 1300,
      catalogPrice: 1300,
      quantity: 2,
      remarks: "シート備考",
      sheetRemarks: "シート備考",
    };

    const result = applyEventUpdateToItems(
      [],
      payload({ itemsToAdd: [newItem] }),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      price: 1300,
      catalogPrice: 1300,
      remarks: "シート備考",
      sheetRemarks: "シート備考",
      purchaseStatus: "None",
      source: "spreadsheet",
      protectionLevel: "none",
    });
  });
});
