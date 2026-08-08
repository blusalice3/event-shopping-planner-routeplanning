import { describe, expect, it } from "vitest";
import type { ShoppingItem } from "../../../types/item";
import { buildListRows } from "../model/buildListRows";
import {
  createShoppingListControllerState,
  shoppingListCommand,
  shoppingListControllerReducer,
} from "./listController";

const item = (id: string): ShoppingItem => ({
  id,
  circle: `サークル${id}`,
  eventDate: "1日目",
  block: "東A",
  number: id,
  title: "",
  price: null,
  purchaseStatus: "None",
  quantity: 1,
  remarks: "",
});

describe("shoppingListControllerReducer", () => {
  it("coordinates selection, focus, and scroll requests against canonical rows", () => {
    const model = buildListRows({ items: [item("1"), item("2")] });
    let state = createShoppingListControllerState(["missing", "1"]);

    state = shoppingListControllerReducer(
      model,
      state,
      shoppingListCommand.reconcileModel(),
    );
    expect(state.selectedItemIds).toEqual(["1"]);

    state = shoppingListControllerReducer(
      model,
      state,
      shoppingListCommand.toggleSelection("2"),
    );
    expect(state.selectedItemIds).toEqual(["1", "2"]);

    const secondRowKey = model.itemRows[1].rowKey;
    state = shoppingListControllerReducer(
      model,
      state,
      shoppingListCommand.focusRow(secondRowKey),
    );
    state = shoppingListControllerReducer(
      model,
      state,
      shoppingListCommand.requestScroll(secondRowKey, "center"),
    );
    expect(state.focusedRowKey).toBe(secondRowKey);
    expect(state.scrollRequest).toEqual({
      requestId: 1,
      rowKey: secondRowKey,
      alignment: "center",
    });

    state = shoppingListControllerReducer(
      model,
      state,
      shoppingListCommand.consumeScroll(1),
    );
    expect(state.scrollRequest).toBeNull();
  });

  it("does not target missing items or rows", () => {
    const model = buildListRows({ items: [item("1")] });
    const state = createShoppingListControllerState();

    expect(
      shoppingListControllerReducer(
        model,
        state,
        shoppingListCommand.toggleSelection("missing"),
      ),
    ).toBe(state);
    expect(
      shoppingListControllerReducer(
        model,
        state,
        shoppingListCommand.focusRow("missing"),
      ),
    ).toBe(state);
    expect(
      shoppingListControllerReducer(model, state, {
        type: "unknown-command",
      } as never),
    ).toBe(state);
  });
});
