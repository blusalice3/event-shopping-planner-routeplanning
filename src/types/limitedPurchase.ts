import type { ShoppingItem } from "./item";

/**
 * Result saved from the limited-purchase quantity input dialog.
 */
export type LimitedPurchaseDialogResult =
  | { kind: "limited"; actual: number; planned: number }
  | { kind: "purchased"; planned: number }
  | { kind: "defer"; planned: number };

/**
 * Context for one target in the bulk limited-purchase input flow.
 */
export type LimitedBulkDialogContext = {
  itemSnapshot: ShoppingItem;
  queueIds: string[];
  index: number;
  skippedCount: number;
  preserveStartNotification: boolean;
  flowToken: symbol;
};

/**
 * Owner metadata for notifications emitted by a bulk limited-purchase flow.
 */
export type LimitedBulkNotificationOwner = {
  flowToken: symbol;
  message: string;
};

/**
 * Bulk notification state. The nonce keeps repeated identical messages visible.
 */
export type BulkLimitedMessageState = {
  message: string;
  nonce: number;
};
