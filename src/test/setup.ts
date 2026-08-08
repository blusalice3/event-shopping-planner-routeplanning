import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom には ResizeObserver が存在しないので最小限 polyfill する
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverPolyfill implements ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}

    observe(_target: Element, _options?: ResizeObserverOptions): void {}

    unobserve(_target: Element): void {}

    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}

// 各テスト後に RTL がマウントした DOM を明示的に片付ける
afterEach(() => {
  cleanup();
});
