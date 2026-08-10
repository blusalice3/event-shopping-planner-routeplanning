import type { ShoppingListRow } from "../model/buildListRows";

export interface ShoppingListRowAccessibilityAttributes {
  readonly role: "listitem";
  readonly "aria-label": string;
  readonly "aria-posinset"?: number;
  readonly "aria-setsize"?: number;
  readonly "data-row-key": string;
}

export const getShoppingListRowAccessibilityAttributes = (
  row: ShoppingListRow,
): ShoppingListRowAccessibilityAttributes =>
  row.kind === "item"
    ? {
        role: "listitem",
        "aria-label": row.accessibleName,
        "aria-posinset": row.positionInSet,
        "aria-setsize": row.setSize,
        "data-row-key": row.rowKey,
      }
    : {
        role: "listitem",
        "aria-label": row.accessibleName,
        "data-row-key": row.rowKey,
      };
