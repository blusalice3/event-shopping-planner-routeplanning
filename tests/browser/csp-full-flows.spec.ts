import { expect, test, type Page, type Response } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

type CspPolicy = {
  readonly directives: Record<string, string[]>;
};

type CspViolation = {
  readonly blockedURI: string;
  readonly disposition: string;
  readonly documentURI: string;
  readonly effectiveDirective: string;
  readonly sourceFile: string;
};

type ReleaseIdentity = {
  readonly sourceSha: string;
  readonly variantId: string;
  readonly roleEntryUrl: string;
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

const installCspViolationCollector = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const violations: CspViolation[] = [];
    Object.defineProperty(globalThis, "__cspFullFlowViolations", {
      configurable: false,
      enumerable: false,
      value: violations,
      writable: false,
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push({
        blockedURI: event.blockedURI,
        disposition: event.disposition,
        documentURI: event.documentURI,
        effectiveDirective: event.effectiveDirective,
        sourceFile: event.sourceFile,
      });
    });
  });
};

const readCspViolations = async (page: Page): Promise<CspViolation[]> =>
  page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __cspFullFlowViolations?: CspViolation[];
        }
      ).__cspFullFlowViolations ?? [],
  );

const assertNoCspViolations = async (
  page: Page,
  label: string,
): Promise<void> => {
  await page.waitForTimeout(100);
  const violations = await readCspViolations(page);
  expect(
    violations,
    `${label} emitted CSP violations: ${JSON.stringify(violations)}`,
  ).toEqual([]);
};

const assertEnforcedCsp = (response: Response | null): void => {
  expect(response).not.toBeNull();
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toBe(
    expectedContentSecurityPolicy,
  );
  expect(headers["content-security-policy-report-only"]).toBeUndefined();
};

const waitForApplication = async (page: Page): Promise<void> => {
  await expect(page.locator("#loading-screen")).toHaveClass(/hidden/);
  await expect(page.locator("#loading-screen")).toBeHidden();
  await expect(page.locator("#root")).not.toBeEmpty();
};

const openApplication = async (page: Page): Promise<void> => {
  const response = await page.goto("/", { waitUntil: "domcontentloaded" });
  assertEnforcedCsp(response);
  await waitForApplication(page);
};

const reloadApplication = async (page: Page): Promise<void> => {
  const response = await page.reload({ waitUntil: "domcontentloaded" });
  assertEnforcedCsp(response);
  await waitForApplication(page);
};

test.describe("enforced CSP full runtime flows", () => {
  test("keeps normal, controlled, and explicit update flows violation-free", async ({
    page,
  }) => {
    await installCspViolationCollector(page);
    await openApplication(page);
    await assertNoCspViolations(page, "normal document");

    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await reloadApplication(page);
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      )
      .toBe(true);
    await assertNoCspViolations(page, "controlled document");

    const updateResult = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        scope: registration.scope,
      };
    });
    expect(updateResult).toEqual({
      controlled: true,
      scope: `${applicationOrigin}/`,
    });
    await assertNoCspViolations(page, "controlled update flow");
  });

  test("keeps a controlled offline reload violation-free", async ({
    context,
    page,
  }) => {
    await installCspViolationCollector(page);
    await openApplication(page);
    await assertNoCspViolations(page, "offline setup document");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });

    await reloadApplication(page);
    await expect
      .poll(() =>
        page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
      )
      .toBe(true);
    await assertNoCspViolations(page, "online controlled document");

    await context.setOffline(true);
    try {
      await reloadApplication(page);
      await expect
        .poll(() =>
          page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
        )
        .toBe(true);
      await assertNoCspViolations(page, "offline controlled document");
    } finally {
      await context.setOffline(false);
    }
  });

  test("loads the emitted XLSX module Worker and receives INVALID_REQUEST", async ({
    page,
  }) => {
    await installCspViolationCollector(page);
    await openApplication(page);

    const workerResult = await page.evaluate(async () => {
      const identityResponse = await fetch("/release-identity.json", {
        cache: "no-store",
      });
      if (!identityResponse.ok) {
        throw new Error(`release identity HTTP ${identityResponse.status}`);
      }
      const identity = (await identityResponse.json()) as ReleaseIdentity;
      const roleEntryResponse = await fetch(identity.roleEntryUrl, {
        cache: "no-store",
      });
      if (!roleEntryResponse.ok) {
        throw new Error(`role entry HTTP ${roleEntryResponse.status}`);
      }
      const roleEntrySource = await roleEntryResponse.text();
      const workerAssetName = roleEntrySource.match(
        /xlsx\.worker-[A-Za-z0-9_-]+\.js/,
      )?.[0];
      if (!workerAssetName) {
        throw new Error("Built role entry does not reference the XLSX Worker.");
      }

      const workerUrl = new URL(workerAssetName, roleEntryResponse.url).href;
      const workerAssetResponse = await fetch(workerUrl, { cache: "no-store" });
      if (!workerAssetResponse.ok) {
        throw new Error(`XLSX Worker HTTP ${workerAssetResponse.status}`);
      }

      const requestId = "00000000-0000-4000-8000-000000000001";
      const worker = new Worker(workerUrl, {
        name: "csp-full-flow-xlsx",
        type: "module",
      });
      try {
        const message = await new Promise<unknown>((resolve, reject) => {
          const timeout = globalThis.setTimeout(() => {
            reject(
              new Error("Timed out waiting for the XLSX Worker response."),
            );
          }, 10_000);
          worker.addEventListener(
            "message",
            (event) => {
              globalThis.clearTimeout(timeout);
              resolve(event.data);
            },
            { once: true },
          );
          worker.addEventListener(
            "error",
            (event) => {
              globalThis.clearTimeout(timeout);
              reject(new Error(event.message || "XLSX Worker failed to load."));
            },
            { once: true },
          );
          worker.postMessage({ requestId });
        });
        return {
          contentType:
            workerAssetResponse.headers.get("content-type")?.toLowerCase() ??
            null,
          message,
          workerUrl,
        };
      } finally {
        worker.terminate();
      }
    });

    const workerUrl = new URL(workerResult.workerUrl);
    expect(workerUrl.origin).toBe(applicationOrigin);
    expect(workerUrl.pathname).toMatch(
      /^\/assets\/xlsx\.worker-[A-Za-z0-9_-]+\.js$/,
    );
    expect(workerUrl.search).toBe("");
    expect(workerResult.contentType).toMatch(/javascript/);
    expect(workerResult.message).toEqual({
      type: "XLSX_ERROR",
      protocolVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000001",
      kind: "unknown",
      errorCode: "INVALID_REQUEST",
    });
    await assertNoCspViolations(page, "XLSX module Worker document");
  });

  test("downloads a browser-created Blob without a CSP violation", async ({
    page,
  }) => {
    await installCspViolationCollector(page);
    await openApplication(page);

    const downloadPromise = page.waitForEvent("download");
    const blobDetails = await page.evaluate(() => {
      const contents = "csp-full-flow-blob";
      const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = "csp-full-flow.txt";
      link.href = url;
      link.hidden = true;
      document.body.append(link);
      (
        globalThis as typeof globalThis & {
          __cspFullFlowBlob?: { link: HTMLAnchorElement; url: string };
        }
      ).__cspFullFlowBlob = { link, url };
      link.click();
      return { contents, size: blob.size, url };
    });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("csp-full-flow.txt");
    const blobUrl = new URL(blobDetails.url);
    expect(blobUrl.protocol).toBe("blob:");
    expect(blobUrl.origin).toBe(applicationOrigin);
    expect(blobDetails.size).toBe(
      new TextEncoder().encode(blobDetails.contents).byteLength,
    );
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    if (downloadPath === null) {
      throw new Error("Playwright did not retain the Blob download.");
    }
    expect(await readFile(downloadPath, "utf8")).toBe(blobDetails.contents);
    await page.evaluate(() => {
      const state = (
        globalThis as typeof globalThis & {
          __cspFullFlowBlob?: { link: HTMLAnchorElement; url: string };
        }
      ).__cspFullFlowBlob;
      if (state) {
        state.link.remove();
        URL.revokeObjectURL(state.url);
        delete (
          globalThis as typeof globalThis & {
            __cspFullFlowBlob?: { link: HTMLAnchorElement; url: string };
          }
        ).__cspFullFlowBlob;
      }
    });
    await assertNoCspViolations(page, "Blob download document");
  });

  test("renders recovery for mismatched versioned identity bytes without a CSP violation", async ({
    page,
    request,
  }) => {
    const identityResponse = await request.get("/release-identity.json");
    expect(identityResponse.ok()).toBe(true);
    const canonicalIdentity = await identityResponse.text();
    const identity = JSON.parse(canonicalIdentity) as ReleaseIdentity & {
      readonly outerAgentSha256: string;
    };
    expect(identity.outerAgentSha256).toMatch(/^[0-9a-f]{64}$/);
    const replacementDigest =
      identity.outerAgentSha256 === "0".repeat(64)
        ? "f".repeat(64)
        : "0".repeat(64);
    const mismatchedIdentity = canonicalIdentity.replace(
      `"outerAgentSha256":"${identity.outerAgentSha256}"`,
      `"outerAgentSha256":"${replacementDigest}"`,
    );
    expect(mismatchedIdentity).not.toBe(canonicalIdentity);
    expect(JSON.parse(mismatchedIdentity)).toMatchObject({
      outerAgentSha256: replacementDigest,
    });
    const versionedIdentityPath = `/release-identity.${identity.sourceSha}.${identity.variantId}.json`;
    let versionedIdentityRequests = 0;
    await page.route(
      (url) =>
        url.origin === applicationOrigin &&
        url.pathname === versionedIdentityPath,
      async (route) => {
        versionedIdentityRequests += 1;
        await route.fulfill({
          body: mismatchedIdentity,
          contentType: "application/json; charset=utf-8",
          headers: { "cache-control": "no-store" },
          status: 200,
        });
      },
    );

    await installCspViolationCollector(page);
    const documentResponse = await page.goto("/", {
      waitUntil: "domcontentloaded",
    });
    assertEnforcedCsp(documentResponse);
    const recoveryRoot = page.locator('#root[data-pwa-recovery="true"]');
    await expect(recoveryRoot).toBeVisible();
    await expect(
      recoveryRoot.locator(
        '[data-diagnostic-code="first-install-identity-unavailable"]',
      ),
    ).toBeVisible();
    expect(versionedIdentityRequests).toBe(1);
    await assertNoCspViolations(page, "forced recovery document");
  });

  test("handles a same-origin API error response without a CSP violation", async ({
    page,
  }) => {
    const apiPath = "/api/__foundation-assignment-validation__";
    let apiRequests = 0;
    await page.route(
      (url) => url.origin === applicationOrigin && url.pathname === apiPath,
      async (route) => {
        apiRequests += 1;
        await route.fulfill({
          body: '{"error":"api-not-found"}',
          contentType: "application/json; charset=utf-8",
          headers: { "cache-control": "no-store" },
          status: 404,
        });
      },
    );
    await installCspViolationCollector(page);
    await openApplication(page);

    const apiResult = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      return {
        body: (await response.json()) as unknown,
        contentType: response.headers.get("content-type"),
        ok: response.ok,
        status: response.status,
        url: response.url,
      };
    }, apiPath);
    expect(apiRequests).toBe(1);
    expect(apiResult).toEqual({
      body: { error: "api-not-found" },
      contentType: "application/json; charset=utf-8",
      ok: false,
      status: 404,
      url: `${applicationOrigin}${apiPath}`,
    });
    await assertNoCspViolations(page, "same-origin API error document");
  });
});
