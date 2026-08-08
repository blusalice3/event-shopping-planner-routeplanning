// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDynamicCssClassRule,
  clearFooterHeightCss,
  setDynamicCssClassRule,
  setFooterHeightCss,
  updateDynamicCssClassRule,
  useDynamicCssClass,
} from "./useDynamicCssClass";

let registryElement: HTMLStyleElement;

const findRule = (selector: string): CSSStyleRule | undefined => {
  for (const styleSheet of Array.from(document.styleSheets)) {
    const rule = Array.from(styleSheet.cssRules).find(
      (candidate) =>
        candidate.type === CSSRule.STYLE_RULE &&
        (candidate as CSSStyleRule).selectorText === selector,
    );
    if (rule) return rule as CSSStyleRule;
  }
  return undefined;
};

beforeEach(() => {
  registryElement = document.createElement("style");
  registryElement.textContent = ".esp-dynamic-css-registry {}";
  document.head.appendChild(registryElement);
});

afterEach(() => {
  clearFooterHeightCss("footer-a");
  clearFooterHeightCss("footer-b");
  registryElement.remove();
});

describe("dynamic stylesheet registry", () => {
  it("updates hook declarations without creating an element style attribute", () => {
    const Probe = ({ left }: { left: string }) => {
      const className = useDynamicCssClass({
        left,
        transform: `translateY(${left})`,
      });
      return <div className={className} data-testid="probe" />;
    };
    const view = render(<Probe left="12px" />);
    const probe = view.getByTestId("probe");
    const selector = `.${probe.className}.${probe.className}`;

    expect(probe).not.toHaveAttribute("style");
    expect(findRule(selector)?.style.getPropertyValue("left")).toBe("12px");
    expect(findRule(selector)?.style.getPropertyValue("transform")).toBe(
      "translateY(12px)",
    );

    view.rerender(<Probe left="28px" />);
    expect(findRule(selector)?.style.getPropertyValue("left")).toBe("28px");
    expect(findRule(selector)?.style.getPropertyValue("transform")).toBe(
      "translateY(28px)",
    );
  });

  it("supports imperative replacement and patching for pointer-driven UI", () => {
    const className = setDynamicCssClassRule("drag-probe", {
      left: "10px",
      top: "20px",
      width: "100px",
    });
    updateDynamicCssClassRule("drag-probe", { top: "40px" });

    const selector = `.${className}.${className}`;
    const rule = findRule(selector);
    expect(rule?.style.getPropertyValue("left")).toBe("10px");
    expect(rule?.style.getPropertyValue("top")).toBe("40px");
    expect(rule?.style.getPropertyValue("width")).toBe("100px");

    clearDynamicCssClassRule("drag-probe");
    expect(findRule(selector)?.style.length).toBe(0);
  });

  it("restores the previous footer owner when the latest owner unmounts", () => {
    setFooterHeightCss("footer-a", 48);
    setFooterHeightCss("footer-b", 72);
    const selector = ":root:where(:not(.esp-dynamic-css-disabled))";

    expect(findRule(selector)?.style.getPropertyValue("--footer-height")).toBe(
      "72px",
    );

    clearFooterHeightCss("footer-b");
    expect(findRule(selector)?.style.getPropertyValue("--footer-height")).toBe(
      "48px",
    );
  });
});
