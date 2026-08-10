// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearFooterHeightAttribute,
  setFooterHeightAttribute,
} from "./runtimeLayoutAttributes";

describe("runtime layout attributes", () => {
  const owners = ["summary", "focus"];

  afterEach(() => {
    owners.forEach(clearFooterHeightAttribute);
    delete document.documentElement.dataset.footerHeight;
  });

  it("publishes the most recently measured footer without a style mutation", () => {
    setFooterHeightAttribute("summary", 72);
    expect(document.documentElement).toHaveAttribute(
      "data-footer-height",
      "72px",
    );

    setFooterHeightAttribute("focus", 104.5);
    expect(document.documentElement).toHaveAttribute(
      "data-footer-height",
      "104.5px",
    );
    expect(document.documentElement.getAttribute("style")).toBeNull();

    clearFooterHeightAttribute("focus");
    expect(document.documentElement).toHaveAttribute(
      "data-footer-height",
      "72px",
    );
  });

  it("removes the attribute when the final owner unmounts", () => {
    setFooterHeightAttribute("summary", -10);
    expect(document.documentElement).toHaveAttribute(
      "data-footer-height",
      "0px",
    );

    clearFooterHeightAttribute("summary");
    expect(document.documentElement).not.toHaveAttribute("data-footer-height");
  });
});
