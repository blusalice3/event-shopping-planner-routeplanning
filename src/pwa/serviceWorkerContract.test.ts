import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readSibling = (relativeUrl: string): string =>
  readFileSync(new URL(relativeUrl, import.meta.url), "utf8");

describe("prompt-close-all PWA source contract", () => {
  it("keeps custom Service Worker activation natural", () => {
    const source = readSibling("../sw.ts");
    expect(source).toContain("self as unknown as");
    expect(source).toContain("__WB_MANIFEST");
    expect(source).not.toMatch(/\bskipWaiting\s*\(/);
    expect(source).not.toMatch(/\bclients\s*\.\s*claim\s*\(/);
    expect(source).not.toContain("navigator.locks");
    expect(source).not.toContain("persistenceCleanupCoordinator");
  });

  it("keeps the outer agent import closure inside recovery plus the identity protocol", () => {
    const source = readSibling("./recovery/outerRecoveryAgent.ts");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    expect(imports.length).toBeGreaterThan(0);
    expect(
      imports.every(
        (specifier) =>
          specifier.startsWith("./") ||
          specifier === "../releaseIdentityProtocol",
      ),
    ).toBe(true);
    expect(source).not.toMatch(
      /(?:App|indexedDB|xlsx|ShoppingList|persistenceCleanupCoordinator)/,
    );
  });

  it("keeps bootstrap and containment free of the application write graph", () => {
    const bootstrap = readSibling("../bootstrap.ts");
    const containment = readSibling("./containment/index.ts");
    for (const source of [bootstrap, containment]) {
      expect(source).not.toMatch(
        /from\s+["'][^"']*(?:App|indexedDB|xlsx|ShoppingList)/,
      );
    }
  });
});
