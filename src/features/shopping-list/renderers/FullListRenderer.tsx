import React from "react";
import type {
  ShoppingListGroupRow,
  ShoppingListItemRow,
  ShoppingListReadModel,
  ShoppingListRow,
} from "../model/buildListRows";
import { getShoppingListRowAccessibilityAttributes } from "./rowAccessibility";
import type { ListRendererSelectionReason } from "./rendererSelector";

interface FullListRendererCommonProps {
  readonly model: ShoppingListReadModel;
  readonly selectionReason?: ListRendererSelectionReason;
  readonly accessibleLabel: string;
  readonly beforeContent?: React.ReactNode;
  readonly afterContent?: React.ReactNode;
  readonly rootRef?: React.Ref<HTMLDivElement>;
  readonly focusedRowKey?: string | null;
  readonly rootProps?: Omit<
    React.HTMLAttributes<HTMLDivElement>,
    "children" | "role" | "aria-label"
  >;
}

export interface FullListRenderedItemRow {
  readonly row: ShoppingListItemRow;
  readonly index: number;
  readonly render: (content: React.ReactNode) => React.ReactElement;
}

interface FullListFlatRowsProps extends FullListRendererCommonProps {
  readonly renderRow: (row: ShoppingListRow, index: number) => React.ReactNode;
  readonly renderGroup?: never;
}

interface FullListGroupedRowsProps extends FullListRendererCommonProps {
  readonly renderRow?: never;
  readonly renderGroup: (
    row: ShoppingListGroupRow,
    renderedItemRows: readonly FullListRenderedItemRow[],
    index: number,
  ) => React.ReactNode;
}

export type FullListRendererProps =
  | FullListFlatRowsProps
  | FullListGroupedRowsProps;

export const getFullListRendererAttributes = (
  model: ShoppingListReadModel,
  selectionReason: ListRendererSelectionReason | undefined,
) => ({
  "data-list-renderer": "full",
  "data-list-renderer-reason": selectionReason,
  "data-list-row-count": model.rows.length,
  "data-list-row-keys-stable": model.hasStableRowKeys ? "true" : "false",
});

const renderAccessibleRow = (
  row: ShoppingListRow,
  content: React.ReactNode,
): React.ReactElement | null => {
  if (content === null || content === undefined) return null;

  const accessibilityAttributes =
    getShoppingListRowAccessibilityAttributes(row);
  if (
    React.isValidElement<Record<string, unknown>>(content) &&
    content.type !== React.Fragment
  ) {
    return React.cloneElement(content, {
      ...accessibilityAttributes,
      key: row.rowKey,
    });
  }

  return (
    <div key={row.rowKey} {...accessibilityAttributes}>
      {content}
    </div>
  );
};

const renderRequiredAccessibleRow = (
  row: ShoppingListRow,
  content: React.ReactNode,
): React.ReactElement => {
  const renderedRow = renderAccessibleRow(row, content);
  if (renderedRow === null) {
    throw new Error(
      `FullListRenderer invariant failed: canonical row ${row.rowKey} was not rendered`,
    );
  }
  return renderedRow;
};

const renderCanonicalRows = (
  props: FullListRendererProps,
): readonly (React.ReactElement | null)[] => {
  const renderedRows: React.ReactElement[] = [];

  for (let index = 0; index < props.model.rows.length; index += 1) {
    const row = props.model.rows[index];
    if (row.kind === "group" && props.renderGroup) {
      const renderedItemRows: FullListRenderedItemRow[] = [];
      const itemRowRenderCounts: number[] = [];
      let itemIndex = index + 1;
      while (itemIndex < props.model.rows.length) {
        const itemRow = props.model.rows[itemIndex];
        if (itemRow.kind !== "item" || itemRow.groupKey !== row.groupKey) break;
        const descriptorIndex = renderedItemRows.length;
        itemRowRenderCounts.push(0);
        renderedItemRows.push({
          row: itemRow,
          index: itemIndex,
          render: (content) => {
            if (itemRowRenderCounts[descriptorIndex] !== 0) {
              throw new Error(
                `FullListRenderer invariant failed: canonical row ${itemRow.rowKey} was rendered more than once`,
              );
            }
            itemRowRenderCounts[descriptorIndex] += 1;
            return renderRequiredAccessibleRow(itemRow, content);
          },
        });
        itemIndex += 1;
      }
      const groupContent = props.renderGroup(row, renderedItemRows, index);
      const missingItemRowIndex = itemRowRenderCounts.findIndex(
        (renderCount) => renderCount !== 1,
      );
      if (missingItemRowIndex !== -1) {
        throw new Error(
          `FullListRenderer invariant failed: canonical row ${renderedItemRows[missingItemRowIndex].row.rowKey} was not rendered exactly once`,
        );
      }
      renderedRows.push(renderRequiredAccessibleRow(row, groupContent));
      index = itemIndex - 1;
      continue;
    }

    if (props.renderRow) {
      renderedRows.push(
        renderRequiredAccessibleRow(row, props.renderRow(row, index)),
      );
      continue;
    }

    throw new Error(
      `FullListRenderer invariant failed: orphan item row ${row.rowKey} has no canonical group owner`,
    );
  }

  return renderedRows;
};

export const FullListRenderer = (
  props: FullListRendererProps,
): React.ReactElement => {
  return (
    <div
      {...props.rootProps}
      ref={props.rootRef}
      role="list"
      aria-label={props.accessibleLabel}
      data-list-controller="shared"
      data-list-focused-row-key={props.focusedRowKey ?? undefined}
      {...getFullListRendererAttributes(props.model, props.selectionReason)}
    >
      {props.beforeContent}
      {renderCanonicalRows(props)}
      {props.afterContent}
    </div>
  );
};
