import { useId, useInsertionEffect, useMemo } from "react";
import "./dynamic-css.css";

const REGISTRY_SELECTOR = ".esp-dynamic-css-registry";
const FOOTER_HEIGHT_SELECTOR = ":root:where(:not(.esp-dynamic-css-disabled))";

type DynamicCssProperty =
  | "--footer-height"
  | "height"
  | "left"
  | "right"
  | "top"
  | "transform"
  | "width";

export type DynamicCssDeclarations = Readonly<
  Partial<Record<DynamicCssProperty, string | null | undefined>>
>;

type NormalizedDeclarations = Partial<Record<DynamicCssProperty, string>>;

const ruleCache = new Map<string, CSSStyleRule>();
const imperativeDeclarations = new Map<string, NormalizedDeclarations>();
const footerHeightOwners = new Map<
  string,
  { height: string; revision: number }
>();
let footerHeightRevision = 0;

const getDocumentStyleSheets = (): CSSStyleSheet[] => {
  if (typeof document === "undefined") return [];
  return Array.from(document.styleSheets);
};

const findRegistryStyleSheet = (): CSSStyleSheet | null => {
  for (const styleSheet of getDocumentStyleSheets()) {
    try {
      const hasRegistryRule = Array.from(styleSheet.cssRules).some(
        (rule) =>
          rule.type === CSSRule.STYLE_RULE &&
          (rule as CSSStyleRule).selectorText === REGISTRY_SELECTOR,
      );
      if (hasRegistryRule) return styleSheet;
    } catch {
      // Cross-origin stylesheets are intentionally skipped.
    }
  }
  return null;
};

const getDynamicRule = (selector: string): CSSStyleRule | null => {
  const cachedRule = ruleCache.get(selector);
  if (
    cachedRule?.parentStyleSheet &&
    getDocumentStyleSheets().includes(cachedRule.parentStyleSheet)
  ) {
    return cachedRule;
  }
  ruleCache.delete(selector);

  const styleSheet = findRegistryStyleSheet();
  if (!styleSheet) return null;

  try {
    const existingRule = Array.from(styleSheet.cssRules).find(
      (rule) =>
        rule.type === CSSRule.STYLE_RULE &&
        (rule as CSSStyleRule).selectorText === selector,
    ) as CSSStyleRule | undefined;
    if (existingRule) {
      ruleCache.set(selector, existingRule);
      return existingRule;
    }

    const ruleIndex = styleSheet.insertRule(
      `${selector} {}`,
      styleSheet.cssRules.length,
    );
    const insertedRule = styleSheet.cssRules[ruleIndex] as CSSStyleRule;
    ruleCache.set(selector, insertedRule);
    return insertedRule;
  } catch {
    return null;
  }
};

const normalizeDeclarations = (
  declarations: DynamicCssDeclarations,
): NormalizedDeclarations =>
  Object.fromEntries(
    Object.entries(declarations).filter(
      (entry): entry is [DynamicCssProperty, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  ) as NormalizedDeclarations;

const replaceRuleDeclarations = (
  selector: string,
  declarations: DynamicCssDeclarations,
): void => {
  const rule = getDynamicRule(selector);
  if (!rule) return;

  const ruleDeclarations = rule.style;
  while (ruleDeclarations.length > 0) {
    ruleDeclarations.removeProperty(ruleDeclarations.item(0));
  }
  for (const [property, value] of Object.entries(
    normalizeDeclarations(declarations),
  )) {
    ruleDeclarations.setProperty(property, value);
  }
};

const toDynamicClassName = (ruleKey: string): string => {
  const safeKey = ruleKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `esp-dynamic-${safeKey}`;
};

const toDynamicClassSelector = (className: string): string =>
  `.${className}.${className}`;

export const getDynamicCssClassName = (ruleKey: string): string =>
  toDynamicClassName(ruleKey);

export const setDynamicCssClassRule = (
  ruleKey: string,
  declarations: DynamicCssDeclarations,
): string => {
  const className = toDynamicClassName(ruleKey);
  const normalizedDeclarations = normalizeDeclarations(declarations);
  imperativeDeclarations.set(className, normalizedDeclarations);
  replaceRuleDeclarations(
    toDynamicClassSelector(className),
    normalizedDeclarations,
  );
  return className;
};

export const updateDynamicCssClassRule = (
  ruleKey: string,
  declarations: DynamicCssDeclarations,
): string => {
  const className = toDynamicClassName(ruleKey);
  const nextDeclarations = {
    ...imperativeDeclarations.get(className),
  };
  for (const [property, value] of Object.entries(declarations) as [
    DynamicCssProperty,
    string | null | undefined,
  ][]) {
    if (typeof value === "string" && value.length > 0) {
      nextDeclarations[property] = value;
    } else {
      delete nextDeclarations[property];
    }
  }
  imperativeDeclarations.set(className, nextDeclarations);
  replaceRuleDeclarations(toDynamicClassSelector(className), nextDeclarations);
  return className;
};

export const clearDynamicCssClassRule = (ruleKey: string): void => {
  const className = toDynamicClassName(ruleKey);
  imperativeDeclarations.delete(className);
  replaceRuleDeclarations(toDynamicClassSelector(className), {});
};

const syncFooterHeightRule = (): void => {
  const activeOwner = Array.from(footerHeightOwners.values()).sort(
    (left, right) => right.revision - left.revision,
  )[0];
  replaceRuleDeclarations(
    FOOTER_HEIGHT_SELECTOR,
    activeOwner ? { "--footer-height": activeOwner.height } : {},
  );
};

export const setFooterHeightCss = (ownerId: string, heightPx: number): void => {
  if (!Number.isFinite(heightPx)) return;
  footerHeightOwners.set(ownerId, {
    height: `${Math.max(0, heightPx)}px`,
    revision: ++footerHeightRevision,
  });
  syncFooterHeightRule();
};

export const clearFooterHeightCss = (ownerId: string): void => {
  footerHeightOwners.delete(ownerId);
  syncFooterHeightRule();
};

/**
 * Applies continuously changing layout values through a rule in the external
 * application stylesheet. This keeps production DOM nodes free of style
 * attributes under a strict `style-src-attr 'none'` CSP.
 */
export const useDynamicCssClass = (
  declarations: DynamicCssDeclarations,
): string => {
  const reactId = useId();
  const className = useMemo(() => toDynamicClassName(reactId), [reactId]);
  const declarationEntries = Object.entries(
    normalizeDeclarations(declarations),
  ).sort(([leftProperty], [rightProperty]) =>
    leftProperty.localeCompare(rightProperty),
  );
  const declarationSignature = JSON.stringify(declarationEntries);

  useInsertionEffect(() => {
    const currentDeclarations = Object.fromEntries(
      JSON.parse(declarationSignature) as [DynamicCssProperty, string][],
    ) as NormalizedDeclarations;
    replaceRuleDeclarations(
      toDynamicClassSelector(className),
      currentDeclarations,
    );

    return () => {
      replaceRuleDeclarations(toDynamicClassSelector(className), {});
    };
  }, [className, declarationSignature]);

  return className;
};
