import React from "react";
import type {
  ShoppingListReadModel,
  ShoppingListRow,
} from "../model/buildListRows";
import { getShoppingListRowAccessibilityAttributes } from "./rowAccessibility";
import type { ListRendererSelectionReason } from "./rendererSelector";

interface FullListRendererBoundaryProps {
  readonly model: ShoppingListReadModel;
  readonly selectionReason?: ListRendererSelectionReason;
  readonly children: React.ReactElement<Record<string, unknown>>;
  readonly renderRow?: never;
  readonly accessibleLabel?: never;
}

interface FullListRendererRowsProps {
  readonly model: ShoppingListReadModel;
  readonly selectionReason?: ListRendererSelectionReason;
  readonly children?: never;
  readonly renderRow: (row: ShoppingListRow) => React.ReactNode;
  readonly accessibleLabel: string;
}

export type FullListRendererProps =
  | FullListRendererBoundaryProps
  | FullListRendererRowsProps;

export const getFullListRendererAttributes = (
  model: ShoppingListReadModel,
  selectionReason: ListRendererSelectionReason | undefined,
) => ({
  "data-list-renderer": "full",
  "data-list-renderer-reason": selectionReason,
  "data-list-row-count": model.rows.length,
  "data-list-row-keys-stable": model.hasStableRowKeys ? "true" : "false",
});

export const FullListRenderer = (
  props: FullListRendererProps,
): React.ReactElement => {
  if (props.children) {
    return React.cloneElement(
      props.children,
      getFullListRendererAttributes(props.model, props.selectionReason),
    );
  }

  return (
    <div
      role="list"
      aria-label={props.accessibleLabel}
      {...getFullListRendererAttributes(props.model, props.selectionReason)}
    >
      {props.model.rows.map((row) => {
        const renderedRow = props.renderRow(row);
        const accessibilityAttributes =
          getShoppingListRowAccessibilityAttributes(row);
        return React.isValidElement<Record<string, unknown>>(renderedRow) ? (
          React.cloneElement(renderedRow, {
            ...accessibilityAttributes,
            key: row.rowKey,
          })
        ) : (
          <div key={row.rowKey} {...accessibilityAttributes}>
            {renderedRow}
          </div>
        );
      })}
    </div>
  );
};
