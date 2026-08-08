import type { ShoppingListReadModel } from "../model/buildListRows";

export type ListScrollAlignment = "start" | "center" | "end" | "nearest";

export interface ListScrollRequest {
  readonly requestId: number;
  readonly rowKey: string;
  readonly alignment: ListScrollAlignment;
}

export interface ShoppingListControllerState {
  readonly selectedItemIds: readonly string[];
  readonly focusedRowKey: string | null;
  readonly scrollRequest: ListScrollRequest | null;
  readonly nextRequestId: number;
}

export type ShoppingListControllerCommand =
  | {
      type: "replace-selection";
      itemIds: readonly string[];
    }
  | {
      type: "toggle-selection";
      itemId: string;
    }
  | {
      type: "focus-row";
      rowKey: string | null;
    }
  | {
      type: "request-scroll";
      rowKey: string;
      alignment?: ListScrollAlignment;
    }
  | {
      type: "consume-scroll";
      requestId: number;
    }
  | {
      type: "reconcile-model";
    };

export const createShoppingListControllerState = (
  selectedItemIds: readonly string[] = [],
): ShoppingListControllerState => ({
  selectedItemIds: Array.from(new Set(selectedItemIds)),
  focusedRowKey: null,
  scrollRequest: null,
  nextRequestId: 1,
});

const itemIdSet = (model: ShoppingListReadModel): ReadonlySet<string> =>
  new Set(model.itemIds);

const rowKeySet = (model: ShoppingListReadModel): ReadonlySet<string> =>
  new Set(model.rows.map((row) => row.rowKey));

export const shoppingListControllerReducer = (
  model: ShoppingListReadModel,
  state: ShoppingListControllerState,
  command: ShoppingListControllerCommand,
): ShoppingListControllerState => {
  switch (command.type) {
    case "replace-selection": {
      const availableItemIds = itemIdSet(model);
      return {
        ...state,
        selectedItemIds: Array.from(new Set(command.itemIds)).filter((itemId) =>
          availableItemIds.has(itemId),
        ),
      };
    }

    case "toggle-selection": {
      if (!itemIdSet(model).has(command.itemId)) return state;
      const selected = new Set(state.selectedItemIds);
      if (selected.has(command.itemId)) {
        selected.delete(command.itemId);
      } else {
        selected.add(command.itemId);
      }
      return { ...state, selectedItemIds: Array.from(selected) };
    }

    case "focus-row":
      if (command.rowKey !== null && !rowKeySet(model).has(command.rowKey)) {
        return state;
      }
      return { ...state, focusedRowKey: command.rowKey };

    case "request-scroll":
      if (!rowKeySet(model).has(command.rowKey)) return state;
      return {
        ...state,
        scrollRequest: {
          requestId: state.nextRequestId,
          rowKey: command.rowKey,
          alignment: command.alignment ?? "nearest",
        },
        nextRequestId: state.nextRequestId + 1,
      };

    case "consume-scroll":
      if (state.scrollRequest?.requestId !== command.requestId) return state;
      return { ...state, scrollRequest: null };

    case "reconcile-model": {
      const availableItemIds = itemIdSet(model);
      const availableRowKeys = rowKeySet(model);
      const selectedItemIds = state.selectedItemIds.filter((itemId) =>
        availableItemIds.has(itemId),
      );
      const focusedRowKey =
        state.focusedRowKey && availableRowKeys.has(state.focusedRowKey)
          ? state.focusedRowKey
          : null;
      const scrollRequest =
        state.scrollRequest && availableRowKeys.has(state.scrollRequest.rowKey)
          ? state.scrollRequest
          : null;
      return {
        ...state,
        selectedItemIds,
        focusedRowKey,
        scrollRequest,
      };
    }

    default:
      return state;
  }
};

export const shoppingListCommand = {
  replaceSelection(itemIds: readonly string[]): ShoppingListControllerCommand {
    return { type: "replace-selection", itemIds };
  },
  toggleSelection(itemId: string): ShoppingListControllerCommand {
    return { type: "toggle-selection", itemId };
  },
  focusRow(rowKey: string | null): ShoppingListControllerCommand {
    return { type: "focus-row", rowKey };
  },
  requestScroll(
    rowKey: string,
    alignment: ListScrollAlignment = "nearest",
  ): ShoppingListControllerCommand {
    return { type: "request-scroll", rowKey, alignment };
  },
  consumeScroll(requestId: number): ShoppingListControllerCommand {
    return { type: "consume-scroll", requestId };
  },
  reconcileModel(): ShoppingListControllerCommand {
    return { type: "reconcile-model" };
  },
} as const;
