// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { acquireBodyScrollLock } from "./bodyScrollLock";

describe("bodyScrollLock", () => {
  afterEach(() => {
    document.body.className = "";
    document.body.style.overflow = "";
    document.body.style.overscrollBehavior = "";
    document.body.style.touchAction = "";
  });

  it("keeps the body locked until overlapping owners have both released it", () => {
    document.body.style.overflow = "auto";
    document.body.style.overscrollBehavior = "contain";

    const releaseDragLock = acquireBodyScrollLock();
    const releaseNavigatorLock = acquireBodyScrollLock({
      lockOverscroll: true,
    });

    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
    );
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehavior).toBe("contain");

    releaseDragLock();
    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
    );

    releaseNavigatorLock();
    expect(document.body).not.toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-overscroll-lock",
    );
    expect(document.body.style.overflow).toBe("auto");
    expect(document.body.style.overscrollBehavior).toBe("contain");
  });

  it("restores overscroll independently and makes release idempotent", () => {
    document.body.style.overscrollBehavior = "contain";
    document.body.style.touchAction = "pan-y";

    const releasePanelLock = acquireBodyScrollLock({
      lockTouchAction: true,
    });
    const releaseNavigatorLock = acquireBodyScrollLock({
      lockOverscroll: true,
    });

    releaseNavigatorLock();
    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-touch-lock",
    );
    expect(document.body).not.toHaveClass("esp-body-overscroll-lock");
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("contain");
    expect(document.body.style.touchAction).toBe("pan-y");

    releaseNavigatorLock();
    expect(document.body).toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-touch-lock",
    );

    releasePanelLock();
    expect(document.body).not.toHaveClass(
      "esp-body-scroll-lock",
      "esp-body-touch-lock",
    );
    expect(document.body.style.overflow).toBe("");
    expect(document.body.style.overscrollBehavior).toBe("contain");
    expect(document.body.style.touchAction).toBe("pan-y");
  });
});
