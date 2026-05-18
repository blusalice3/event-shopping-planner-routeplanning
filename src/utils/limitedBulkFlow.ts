import type { LimitedBulkDialogContext } from '../types/limitedPurchase';
import type { ShoppingItem } from '../types/item';
import type { LimitedBulkInputTargetDecision } from './purchaseQuantity';

export type LimitedBulkSubmitDecision =
  | { kind: 'stale'; flowToken: symbol }
  | { kind: 'notFound'; flowToken: symbol; nextIndex: number; nextSkippedCount: number }
  | { kind: 'notTarget'; flowToken: symbol; nextIndex: number; nextSkippedCount: number }
  | {
      kind: 'commit';
      baseItem: ShoppingItem;
      flowToken: symbol;
      nextIndex: number;
      nextSkippedCount: number;
    };

export type ComputeLimitedBulkSubmitDecisionParams =
  | {
      context: LimitedBulkDialogContext;
      latestItem: undefined;
      isActiveFlow: boolean;
    }
  | {
      context: LimitedBulkDialogContext;
      latestItem: ShoppingItem;
      decision: LimitedBulkInputTargetDecision;
      isActiveFlow: boolean;
    };

export const computeLimitedBulkSubmitDecision = (
  params: ComputeLimitedBulkSubmitDecisionParams,
): LimitedBulkSubmitDecision => {
  const { context, isActiveFlow } = params;

  if (!isActiveFlow) {
    return { kind: 'stale', flowToken: context.flowToken };
  }

  if (params.latestItem === undefined) {
    return {
      kind: 'notFound',
      flowToken: context.flowToken,
      nextIndex: context.index + 1,
      nextSkippedCount: context.skippedCount + 1,
    };
  }

  if (!params.decision.isTarget) {
    return {
      kind: 'notTarget',
      flowToken: context.flowToken,
      nextIndex: context.index + 1,
      nextSkippedCount: context.skippedCount + 1,
    };
  }

  return {
    kind: 'commit',
    baseItem: params.latestItem,
    flowToken: context.flowToken,
    nextIndex: context.index + 1,
    nextSkippedCount: context.skippedCount,
  };
};

export type LimitedBulkCancelDecision =
  | { kind: 'stale'; flowToken: symbol }
  | {
      kind: 'finish';
      flowToken: symbol;
      skippedCount: number;
      preserveStartNotification: boolean;
    };

export const computeLimitedBulkCancelDecision = (params: {
  context: LimitedBulkDialogContext;
  isActiveFlow: boolean;
}): LimitedBulkCancelDecision => {
  if (!params.isActiveFlow) {
    return { kind: 'stale', flowToken: params.context.flowToken };
  }

  return {
    kind: 'finish',
    flowToken: params.context.flowToken,
    skippedCount: params.context.skippedCount,
    preserveStartNotification: params.context.preserveStartNotification,
  };
};
