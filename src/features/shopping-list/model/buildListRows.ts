import type { ShoppingItem } from "../../../types/item";

export type ShoppingListColumn = "execute" | "candidate" | null;

export interface ShoppingListRowFlags {
  readonly selected: boolean;
  readonly duplicateCircle: boolean;
  readonly highlighted: boolean;
}

export interface ShoppingListItemRow {
  readonly kind: "item";
  readonly rowKey: string;
  readonly itemId: string;
  readonly item: ShoppingItem;
  readonly column: ShoppingListColumn;
  readonly accessibleName: string;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly groupKey: string | null;
  readonly flags: ShoppingListRowFlags;
}

export interface ShoppingListGroupRow {
  readonly kind: "group";
  readonly rowKey: string;
  readonly groupKey: string;
  readonly label: string;
  readonly collapsed: boolean;
  readonly itemCount: number;
  readonly accessibleName: string;
}

export type ShoppingListRow = ShoppingListItemRow | ShoppingListGroupRow;

export interface ShoppingListRowGroupInput {
  readonly key: string;
  readonly label: string;
  readonly items: readonly ShoppingItem[];
  readonly collapsed?: boolean;
}

export interface BuildListRowsInput {
  readonly items: readonly ShoppingItem[];
  readonly groups?: readonly ShoppingListRowGroupInput[];
  readonly column?: Exclude<ShoppingListColumn, null>;
  readonly selectedItemIds?: ReadonlySet<string>;
  readonly duplicateCircleItemIds?: ReadonlySet<string>;
  readonly highlightedItemId?: string | null;
}

export interface ShoppingListReadModel {
  readonly rows: readonly ShoppingListRow[];
  readonly itemRows: readonly ShoppingListItemRow[];
  readonly itemIds: readonly string[];
  readonly hasStableRowKeys: boolean;
}

const encodeRowKeyPart = (value: string): string => JSON.stringify(value);

const buildItemAccessibleName = (item: ShoppingItem): string => {
  const location = `${item.block}${item.number}`.trim();
  return [location, item.circle, item.title]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
};

interface PendingItemRow {
  readonly item: ShoppingItem;
  readonly groupKey: string | null;
}

export const buildListRows = ({
  items,
  groups,
  column,
  selectedItemIds = new Set<string>(),
  duplicateCircleItemIds = new Set<string>(),
  highlightedItemId = null,
}: BuildListRowsInput): ShoppingListReadModel => {
  const pendingRows: Array<
    | PendingItemRow
    | {
        readonly kind: "group";
        readonly group: ShoppingListRowGroupInput;
      }
  > = [];

  if (groups && groups.length > 0) {
    groups.forEach((group) => {
      pendingRows.push({ kind: "group", group });
      if (!group.collapsed) {
        group.items.forEach((item) => {
          pendingRows.push({ item, groupKey: group.key });
        });
      }
    });
  } else {
    items.forEach((item) => {
      pendingRows.push({ item, groupKey: null });
    });
  }

  const visibleItemCount = pendingRows.reduce(
    (count, row) => count + ("item" in row ? 1 : 0),
    0,
  );
  const rowKeyOccurrences = new Map<string, number>();
  let itemPosition = 0;
  let hasStableRowKeys = true;

  const rows: ShoppingListRow[] = pendingRows.map((pendingRow) => {
    if ("kind" in pendingRow) {
      const baseKey = `group:${encodeRowKeyPart(pendingRow.group.key)}`;
      const occurrence = rowKeyOccurrences.get(baseKey) ?? 0;
      rowKeyOccurrences.set(baseKey, occurrence + 1);
      if (occurrence > 0) hasStableRowKeys = false;
      const rowKey = occurrence === 0 ? baseKey : `${baseKey}:${occurrence}`;
      return {
        kind: "group",
        rowKey,
        groupKey: pendingRow.group.key,
        label: pendingRow.group.label,
        collapsed: pendingRow.group.collapsed === true,
        itemCount: pendingRow.group.items.length,
        accessibleName: `${pendingRow.group.label} ${pendingRow.group.items.length}件`,
      };
    }

    itemPosition += 1;
    const baseKey = `item:${encodeRowKeyPart(pendingRow.item.id)}`;
    const occurrence = rowKeyOccurrences.get(baseKey) ?? 0;
    rowKeyOccurrences.set(baseKey, occurrence + 1);
    if (occurrence > 0) hasStableRowKeys = false;
    const rowKey = occurrence === 0 ? baseKey : `${baseKey}:${occurrence}`;

    return {
      kind: "item",
      rowKey,
      itemId: pendingRow.item.id,
      item: pendingRow.item,
      column: column ?? null,
      accessibleName: buildItemAccessibleName(pendingRow.item),
      positionInSet: itemPosition,
      setSize: visibleItemCount,
      groupKey: pendingRow.groupKey,
      flags: {
        selected: selectedItemIds.has(pendingRow.item.id),
        duplicateCircle: duplicateCircleItemIds.has(pendingRow.item.id),
        highlighted: highlightedItemId === pendingRow.item.id,
      },
    };
  });
  const itemRows = rows.filter(
    (row): row is ShoppingListItemRow => row.kind === "item",
  );

  return {
    rows,
    itemRows,
    itemIds: itemRows.map((row) => row.itemId),
    hasStableRowKeys,
  };
};
