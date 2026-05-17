import type { ShoppingItem } from '../types/item';

export type LimitedPurchaseValidationError =
  | 'planned_required'
  | 'actual_required'
  | 'planned_not_integer'
  | 'actual_not_integer'
  | 'planned_not_positive'
  | 'actual_not_positive'
  | 'actual_not_less_than_planned';

export type LimitedPurchaseValidationResult =
  | { ok: true }
  | { ok: false; error: LimitedPurchaseValidationError };

export type LimitedPurchaseInput = {
  actual?: number;
  planned: number;
};

export type PurchaseFilterStatus = ShoppingItem['purchaseStatus'];

const DECIMAL_INTEGER_PATTERN = /^\d+$/;

export const parseDecimalIntegerInput = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!DECIMAL_INTEGER_PATTERN.test(trimmed)) return Number.NaN;
  return Number(trimmed);
};

export const isLimitedPurchase = (
  item: Pick<ShoppingItem, 'purchaseStatus'>,
): boolean => item.purchaseStatus === 'LimitedPurchase';

export const isPurchasedLike = (
  item: Pick<ShoppingItem, 'purchaseStatus'>,
): boolean => item.purchaseStatus === 'Purchased' || item.purchaseStatus === 'LimitedPurchase';

export const isPriceRequiredStatus = (
  item: Pick<ShoppingItem, 'purchaseStatus'>,
): boolean => item.purchaseStatus === 'Purchased' || item.purchaseStatus === 'LimitedPurchase';

export const isUndefinedPrice = (price: ShoppingItem['price'] | -1): boolean =>
  price === null || price === -1;

export const normalizePrice = (price: ShoppingItem['price'] | -1): ShoppingItem['price'] =>
  isUndefinedPrice(price) ? null : price;

export const getSafePriceForCalculation = (price: ShoppingItem['price'] | -1): number =>
  isUndefinedPrice(price) ? 0 : (price ?? 0);

export const getPlannedQuantity = (item: Pick<ShoppingItem, 'quantity'>): number =>
  Number.isInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1;

export const getActualPurchasedQuantity = (
  item: Pick<ShoppingItem, 'purchaseStatus' | 'limitedPurchasedQuantity' | 'quantity'>,
): number | undefined => {
  if (item.purchaseStatus === 'Purchased') return getPlannedQuantity(item);
  if (item.purchaseStatus !== 'LimitedPurchase') return undefined;

  const planned = getPlannedQuantity(item);
  const actual = item.limitedPurchasedQuantity;
  return typeof actual === 'number' && Number.isInteger(actual) && actual > 0 && actual < planned
    ? actual
    : undefined;
};

export const getChargeableQuantity = (
  item: Pick<ShoppingItem, 'purchaseStatus' | 'limitedPurchasedQuantity' | 'quantity'>,
): number => {
  if (item.purchaseStatus === 'Purchased') return getPlannedQuantity(item);
  if (item.purchaseStatus === 'LimitedPurchase') return getActualPurchasedQuantity(item) ?? 0;
  return 0;
};

export const getPlannedBudgetQuantity = (item: Pick<ShoppingItem, 'quantity'>): number =>
  getPlannedQuantity(item);

export const hasMissingLimitedPurchaseQuantity = (
  item: Pick<ShoppingItem, 'purchaseStatus' | 'limitedPurchasedQuantity' | 'quantity'>,
): boolean =>
  item.purchaseStatus === 'LimitedPurchase' && getActualPurchasedQuantity(item) === undefined;

export const isCountedAsPurchased = (
  item: Pick<ShoppingItem, 'purchaseStatus' | 'limitedPurchasedQuantity' | 'quantity'>,
): boolean =>
  item.purchaseStatus === 'Purchased' ||
  (item.purchaseStatus === 'LimitedPurchase' && getActualPurchasedQuantity(item) !== undefined);

export const matchesPurchaseStatusFilter = (
  item: Pick<ShoppingItem, 'purchaseStatus'>,
  filterStatus: PurchaseFilterStatus,
): boolean => {
  if (filterStatus === 'Purchased') return item.purchaseStatus === 'Purchased';
  if (filterStatus === 'LimitedPurchase') return item.purchaseStatus === 'LimitedPurchase';
  return item.purchaseStatus === filterStatus;
};

export const getLimitedPurchaseCounts = (
  items: Pick<ShoppingItem, 'purchaseStatus' | 'limitedPurchasedQuantity' | 'quantity'>[],
): { total: number; missing: number } => {
  const limitedItems = items.filter(isLimitedPurchase);
  return {
    total: limitedItems.length,
    missing: limitedItems.filter(hasMissingLimitedPurchaseQuantity).length,
  };
};

export const formatDisplayQuantity = (
  item: Pick<ShoppingItem, 'purchaseStatus' | 'limitedPurchasedQuantity' | 'quantity'>,
): string => {
  const planned = getPlannedQuantity(item);
  if (item.purchaseStatus !== 'LimitedPurchase') return String(planned);
  return `${getActualPurchasedQuantity(item) ?? '-'}/${planned}`;
};

export const validateLimitedPurchaseQuantities = (
  actual: number | undefined,
  planned: number | undefined,
): LimitedPurchaseValidationResult => {
  if (actual === undefined) return { ok: false, error: 'actual_required' };
  if (!Number.isInteger(actual)) return { ok: false, error: 'actual_not_integer' };
  if (actual < 1) return { ok: false, error: 'actual_not_positive' };
  if (planned === undefined) return { ok: false, error: 'planned_required' };
  if (!Number.isInteger(planned)) return { ok: false, error: 'planned_not_integer' };
  if (planned < 1) return { ok: false, error: 'planned_not_positive' };
  if (actual >= planned) return { ok: false, error: 'actual_not_less_than_planned' };
  return { ok: true };
};

export const validateLimitedPurchasePlannedQuantity = (
  planned: number | undefined,
): LimitedPurchaseValidationResult => {
  if (planned === undefined) return { ok: false, error: 'planned_required' };
  if (!Number.isInteger(planned)) return { ok: false, error: 'planned_not_integer' };
  if (planned < 1) return { ok: false, error: 'planned_not_positive' };
  return { ok: true };
};

export const applyLimitedPurchase = (
  item: ShoppingItem,
  input: LimitedPurchaseInput,
): ShoppingItem => {
  const { limitedPurchasedQuantity: _removed, ...rest } = item;
  return {
    ...rest,
    purchaseStatus: 'LimitedPurchase',
    quantity: input.planned,
    ...(input.actual !== undefined ? { limitedPurchasedQuantity: input.actual } : {}),
  };
};

export const applyPurchasedFromLimitedInput = (
  item: ShoppingItem,
  planned: number,
): ShoppingItem => {
  const { limitedPurchasedQuantity: _removed, ...rest } = item;
  return {
    ...rest,
    purchaseStatus: 'Purchased',
    quantity: planned,
  };
};

export const clearLimitedPurchase = (item: ShoppingItem): ShoppingItem => {
  const { limitedPurchasedQuantity: _removed, ...rest } = item;
  return rest;
};

export const normalizeLimitedPurchaseFields = (item: ShoppingItem): ShoppingItem => {
  const planned = getPlannedQuantity(item);
  const normalizedBase = { ...item, price: normalizePrice(item.price), quantity: planned };

  if (normalizedBase.purchaseStatus !== 'LimitedPurchase') {
    return clearLimitedPurchase(normalizedBase);
  }

  const actual = normalizedBase.limitedPurchasedQuantity;
  if (
    typeof actual !== 'number' ||
    !Number.isInteger(actual) ||
    actual < 1 ||
    actual >= planned
  ) {
    const { limitedPurchasedQuantity: _removed, ...rest } = normalizedBase;
    return rest;
  }

  return normalizedBase;
};
