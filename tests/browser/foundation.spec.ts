import { expect, test, type Page } from "@playwright/test";
import axe from "axe-core";
import { readFileSync } from "node:fs";

type CspPolicy = {
  readonly directives: Record<string, string[]>;
  readonly securityHeaders: Record<string, string>;
};

const cspPolicy = JSON.parse(
  readFileSync(
    new URL("../../config/csp-policy.json", import.meta.url),
    "utf8",
  ),
) as CspPolicy;
const expectedContentSecurityPolicy = Object.entries(cspPolicy.directives)
  .map(([directive, values]) => `${directive} ${values.join(" ")}`)
  .join("; ");

const applicationOrigin = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173",
).origin;

type ReleaseIdentity = {
  schemaVersion: 1;
  sourceSha: string;
  buildId: string;
  variantId: string;
  releaseRole: "standard" | "containment";
  requiredDbCompatibilityFingerprint: string;
  pwaLifecycle: "prompt-close-all-v1";
  roleEntryUrl: string;
  roleEntrySha256: string;
  serviceWorkerUrl: string;
  serviceWorkerSha256: string;
  outerAgentUrl: string;
  outerAgentSha256: string;
};

type ReleaseCapabilities = {
  kind: "event-shopping-planner-release-capabilities";
  version: 1;
  buildId: string;
  sourceSha: string;
  releaseChannel: "release-a";
  legacyLocalStorageCleanup: "forced-off";
};

const waitForApplication = async (page: Page) => {
  const response = await page.goto("/");
  expect(response).not.toBeNull();
  await expect(page.locator("#loading-screen")).toHaveClass(/hidden/);
  await expect(page.locator("#root")).not.toBeEmpty();
  return response!;
};

test("loads the source-bound PWA without remote runtime dependencies", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const violations: Array<{
      blockedURI: string;
      effectiveDirective: string;
      sourceFile: string;
    }> = [];
    Object.defineProperty(globalThis, "__foundationCspViolations", {
      configurable: false,
      enumerable: false,
      value: violations,
      writable: false,
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push({
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        sourceFile: event.sourceFile,
      });
    });
  });
  const remoteRequests = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== applicationOrigin
    ) {
      remoteRequests.add(url.origin);
    }
  });

  const documentResponse = await waitForApplication(page);
  const responseHeaders = documentResponse.headers();
  expect(responseHeaders["content-security-policy"]).toBe(
    expectedContentSecurityPolicy,
  );
  for (const [headerName, expectedValue] of Object.entries(
    cspPolicy.securityHeaders,
  )) {
    expect(responseHeaders[headerName.toLowerCase()]).toBe(expectedValue);
  }

  const inlineSurface = await page.evaluate(() => ({
    inlineScripts: document.querySelectorAll("script:not([src])").length,
    inlineStyles: document.querySelectorAll("style, [style]").length,
    themePrepaintSource:
      document
        .querySelector<HTMLScriptElement>('script[src="/theme-prepaint.js"]')
        ?.getAttribute("src") ?? null,
  }));
  expect(inlineSurface).toEqual({
    inlineScripts: 0,
    inlineStyles: 0,
    themePrepaintSource: "/theme-prepaint.js",
  });

  const identity = await page.evaluate(async () => {
    const response = await fetch("/release-identity.json", {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`identity HTTP ${response.status}`);
    return (await response.json()) as ReleaseIdentity;
  });
  expect(identity).toMatchObject({
    schemaVersion: 1,
    releaseRole: "standard",
    pwaLifecycle: "prompt-close-all-v1",
    roleEntryUrl: "/assets/release-role.js",
    serviceWorkerUrl: "/sw.js",
    outerAgentUrl: "/assets/outer-recovery-agent.js",
  });
  expect(identity.sourceSha).toBe(identity.buildId);
  expect(identity.sourceSha).toMatch(/^[0-9a-f]{40}$/);
  expect(identity.variantId).toMatch(/^[0-9a-f]{64}$/);
  expect(identity.requiredDbCompatibilityFingerprint).toMatch(/^[0-9a-f]{64}$/);
  for (const digest of [
    identity.roleEntrySha256,
    identity.serviceWorkerSha256,
    identity.outerAgentSha256,
  ]) {
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  }

  const [versionedIdentity, capabilities] = await page.evaluate(
    async ({ versionedIdentityUrl, capabilityUrl }) => {
      const [identityResponse, capabilityResponse] = await Promise.all([
        fetch(versionedIdentityUrl, { cache: "no-store" }),
        fetch(capabilityUrl, { cache: "no-store" }),
      ]);
      if (!identityResponse.ok || !capabilityResponse.ok) {
        throw new Error(
          `versioned identity/capability HTTP ${identityResponse.status}/${capabilityResponse.status}`,
        );
      }
      return [
        (await identityResponse.json()) as ReleaseIdentity,
        (await capabilityResponse.json()) as ReleaseCapabilities,
      ] as const;
    },
    {
      versionedIdentityUrl: `/release-identity.${identity.sourceSha}.${identity.variantId}.json`,
      capabilityUrl: "/release-capabilities.json",
    },
  );
  expect(versionedIdentity).toEqual(identity);
  expect(capabilities).toMatchObject({
    kind: "event-shopping-planner-release-capabilities",
    version: 1,
    buildId: identity.sourceSha,
    sourceSha: identity.sourceSha,
    releaseChannel: "release-a",
    legacyLocalStorageCleanup: "forced-off",
  });
  expect([...remoteRequests]).toEqual([]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __foundationCspViolations?: unknown[];
            }
          ).__foundationCspViolations ?? [],
      ),
    )
    .toEqual([]);
});

test("keeps the controlled application available during an offline reload", async ({
  context,
  page,
}) => {
  await waitForApplication(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);

  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#loading-screen")).toHaveClass(/hidden/);
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      )
      .toBe(true);
  } finally {
    await context.setOffline(false);
  }
});

test("@a11y has no serious or critical automated accessibility violations", async ({
  page,
}) => {
  await page.addInitScript({ content: axe.source });
  await waitForApplication(page);
  const violations = await page.evaluate(async () => {
    const axeApi = (
      globalThis as typeof globalThis & {
        axe: {
          run(
            context: Document,
            options: {
              resultTypes: string[];
            },
          ): Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axeApi.run(document, {
      resultTypes: ["violations"],
    });
    return result.violations
      .filter(({ impact }) => impact === "serious" || impact === "critical")
      .map(({ id, impact, nodes }) => ({
        id,
        impact,
        targets: nodes.map(({ target }) => target.join(" ")),
      }));
  });

  expect(violations).toEqual([]);
});
