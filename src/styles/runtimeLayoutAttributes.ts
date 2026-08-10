const footerHeightOwners = new Map<
  string,
  { height: string; revision: number }
>();

let footerHeightRevision = 0;

const syncFooterHeightAttribute = (): void => {
  if (typeof document === "undefined") return;

  const activeOwner = Array.from(footerHeightOwners.values()).sort(
    (left, right) => right.revision - left.revision,
  )[0];
  if (activeOwner) {
    document.documentElement.dataset.footerHeight = activeOwner.height;
  } else {
    delete document.documentElement.dataset.footerHeight;
  }
};

/**
 * Publishes measured layout state as non-style data. The application stylesheet
 * consumes this value through a static typed attr() rule, so neither inline
 * styles nor CSSOM rules are created or mutated at runtime.
 */
export const setFooterHeightAttribute = (
  ownerId: string,
  heightPx: number,
): void => {
  if (!Number.isFinite(heightPx)) return;
  footerHeightOwners.set(ownerId, {
    height: `${Math.max(0, heightPx)}px`,
    revision: ++footerHeightRevision,
  });
  syncFooterHeightAttribute();
};

export const clearFooterHeightAttribute = (ownerId: string): void => {
  footerHeightOwners.delete(ownerId);
  syncFooterHeightAttribute();
};
