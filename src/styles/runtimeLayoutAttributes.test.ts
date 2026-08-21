// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearAppHeaderHeightAttribute,
  clearFooterHeightAttribute,
  setAppHeaderHeightAttribute,
  setFooterHeightAttribute,
} from "./runtimeLayoutAttributes";

describe("runtime layout attributes", () => {
  const owners = ["summary", "focus"];

  afterEach(() => {
    owners.forEach(clearFooterHeightAttribute);
    owners.forEach(clearAppHeaderHeightAttribute);
    delete document.documentElement.dataset.footerHeight;
    delete document.documentElement.dataset.appHeaderHeight;
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

  it("publishes the measured application header height", () => {
    setAppHeaderHeightAttribute("summary", 96);
    expect(document.documentElement).toHaveAttribute(
      "data-app-header-height",
      "96px",
    );

    setAppHeaderHeightAttribute("focus", 128.5);
    expect(document.documentElement).toHaveAttribute(
      "data-app-header-height",
      "128.5px",
    );
    expect(document.documentElement.getAttribute("style")).toBeNull();

    clearAppHeaderHeightAttribute("focus");
    expect(document.documentElement).toHaveAttribute(
      "data-app-header-height",
      "96px",
    );
  });
});
