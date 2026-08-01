export const QUANTITY_OPTION_MIN = 1;
export const QUANTITY_OPTION_MAX = 20;

export const buildQuantityOptions = (
  currentQuantity?: number | string,
): number[] => {
  const options = Array.from(
    { length: QUANTITY_OPTION_MAX - QUANTITY_OPTION_MIN + 1 },
    (_, index) => index + QUANTITY_OPTION_MIN,
  );
  const parsedCurrent =
    typeof currentQuantity === "number"
      ? currentQuantity
      : Number(currentQuantity);

  if (Number.isFinite(parsedCurrent) && !options.includes(parsedCurrent)) {
    options.push(parsedCurrent);
    options.sort((left, right) => left - right);
  }

  return options;
};

export const isStandardQuantityOption = (quantity: number): boolean =>
  Number.isInteger(quantity) &&
  quantity >= QUANTITY_OPTION_MIN &&
  quantity <= QUANTITY_OPTION_MAX;
