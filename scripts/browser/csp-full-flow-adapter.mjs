import { readFile } from "node:fs/promises";

export const CSP_FULL_FLOW_IDS = Object.freeze([
  "api-error",
  "blob-download",
  "normal",
  "offline",
  "pwa-update",
  "recovery",
  "worker",
]);

const FLOW_ORDER = new Map(CSP_FULL_FLOW_IDS.map((id, index) => [id, index]));

const canonicalPath = (value) => {
  const url = new URL(value);
  return url.pathname;
};

const violationCollector = () => {
  const { document } = globalThis;
  const violations = [];
  Object.defineProperty(globalThis, "__espCspFullFlowViolations", {
    configurable: false,
    enumerable: false,
    value: violations,
    writable: false,
  });
  document.addEventListener("securitypolicyviolation", (event) => {
    const safeUrl = (value) => {
      try {
        const url = new URL(value, document.location.href);
        return `${url.origin}${url.pathname}`;
      } catch {
        return String(value);
      }
    };
    violations.push({
      blockedUri: safeUrl(event.blockedURI),
      disposition: event.disposition,
      documentUri: safeUrl(event.documentURI),
      effectiveDirective: event.effectiveDirective,
      sourceFile: safeUrl(event.sourceFile),
    });
  });
};

const waitForApplication = async (page) => {
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.locator("#root").waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const { document } = globalThis;
    const root = document.querySelector("#root");
    return root !== null && root.childNodes.length > 0;
  });
};

const readViolations = async (page) => {
  await page.waitForTimeout(100);
  return page.evaluate(() => globalThis.__espCspFullFlowViolations ?? []);
};

const responseTrace = async (response, expectedCspHeader) => {
  if (response === null) throw new Error("CSP flow document has no response");
  const headers = await response.allHeaders();
  const enforced = headers["content-security-policy"] ?? null;
  const reportOnly = headers["content-security-policy-report-only"] ?? null;
  if (enforced !== expectedCspHeader || reportOnly !== null) {
    throw new Error("CSP flow response header differs from enforced policy");
  }
  return {
    path: canonicalPath(response.url()),
    status: response.status(),
    enforcedHeader: enforced,
    reportOnlyHeader: reportOnly,
  };
};

const installCollector = (page) => page.addInitScript(violationCollector);

const openApplication = async (page, deploymentUrl, expectedCspHeader) => {
  const response = await page.goto(deploymentUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const trace = await responseTrace(response, expectedCspHeader);
  await waitForApplication(page);
  return trace;
};

const reloadApplication = async (page, expectedCspHeader) => {
  const response = await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const trace = await responseTrace(response, expectedCspHeader);
  await waitForApplication(page);
  return trace;
};

const withPage = async (browser, operation) => {
  const context = await browser.newContext({
    acceptDownloads: true,
    serviceWorkers: "allow",
  });
  try {
    const page = await context.newPage();
    await installCollector(page);
    return await operation({ context, page });
  } finally {
    await context.close();
  }
};

const assertNoViolations = async (page) => {
  const violations = await readViolations(page);
  if (violations.length !== 0) {
    throw new Error("CSP full flow emitted a policy violation");
  }
  return violations;
};

const waitForServiceWorker = async (page) => {
  await page.waitForFunction(
    () =>
      navigator.serviceWorker !== undefined &&
      navigator.serviceWorker.ready.then(() => true),
    undefined,
    { timeout: 15_000 },
  );
};

const waitForController = (page) =>
  page.waitForFunction(
    () => Boolean(navigator.serviceWorker.controller),
    null,
    {
      timeout: 15_000,
    },
  );

const succeeded = async (id, responses, checkpoints, page) => ({
  id,
  outcome: "succeeded",
  responses,
  checkpoints,
  violations: await assertNoViolations(page),
});

const runNormal = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ page }) =>
    succeeded(
      "normal",
      [await openApplication(page, deploymentUrl, expectedCspHeader)],
      [{ id: "application-ready", value: "true" }],
      page,
    ),
  );

const runPwaUpdate = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ page }) => {
    const responses = [
      await openApplication(page, deploymentUrl, expectedCspHeader),
    ];
    await waitForServiceWorker(page);
    responses.push(await reloadApplication(page, expectedCspHeader));
    await waitForController(page);
    const update = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      return {
        controlled: Boolean(navigator.serviceWorker.controller),
        scope: registration.scope,
      };
    });
    if (!update.controlled || new URL(update.scope).pathname !== "/") {
      throw new Error("CSP PWA update flow did not remain controlled");
    }
    return succeeded(
      "pwa-update",
      responses,
      [
        { id: "controlled", value: String(update.controlled) },
        { id: "scope-path", value: new URL(update.scope).pathname },
      ],
      page,
    );
  });

const runOffline = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ context, page }) => {
    const responses = [
      await openApplication(page, deploymentUrl, expectedCspHeader),
    ];
    await waitForServiceWorker(page);
    responses.push(await reloadApplication(page, expectedCspHeader));
    await waitForController(page);
    await context.setOffline(true);
    try {
      responses.push(await reloadApplication(page, expectedCspHeader));
      await waitForController(page);
    } finally {
      await context.setOffline(false);
    }
    return succeeded(
      "offline",
      responses,
      [{ id: "offline-controlled", value: "true" }],
      page,
    );
  });

const runWorker = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ page }) => {
    const responses = [
      await openApplication(page, deploymentUrl, expectedCspHeader),
    ];
    const workerResult = await page.evaluate(async () => {
      const { Worker } = globalThis;
      const identityResponse = await fetch("/release-identity.json", {
        cache: "no-store",
      });
      if (!identityResponse.ok) throw new Error("Release identity unavailable");
      const identity = await identityResponse.json();
      const roleEntryResponse = await fetch(identity.roleEntryUrl, {
        cache: "no-store",
      });
      if (!roleEntryResponse.ok) throw new Error("Role entry unavailable");
      const roleEntrySource = await roleEntryResponse.text();
      const workerAssetName = roleEntrySource.match(
        /xlsx\.worker-[A-Za-z0-9_-]+\.js/,
      )?.[0];
      if (!workerAssetName) throw new Error("XLSX Worker reference missing");
      const workerUrl = new URL(workerAssetName, roleEntryResponse.url).href;
      const workerAssetResponse = await fetch(workerUrl, { cache: "no-store" });
      if (!workerAssetResponse.ok) throw new Error("XLSX Worker unavailable");
      const requestId = "00000000-0000-4000-8000-000000000001";
      const worker = new Worker(workerUrl, {
        name: "csp-full-flow-xlsx",
        type: "module",
      });
      try {
        const message = await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("XLSX Worker response timed out")),
            10_000,
          );
          worker.addEventListener(
            "message",
            (event) => {
              clearTimeout(timeout);
              resolve(event.data);
            },
            { once: true },
          );
          worker.addEventListener(
            "error",
            (event) => {
              clearTimeout(timeout);
              reject(new Error(event.message || "XLSX Worker failed"));
            },
            { once: true },
          );
          worker.postMessage({ requestId });
        });
        return {
          contentType:
            workerAssetResponse.headers.get("content-type")?.toLowerCase() ??
            "",
          message,
          workerPath: new URL(workerUrl).pathname,
        };
      } finally {
        worker.terminate();
      }
    });
    if (
      !/^\/assets\/xlsx\.worker-[A-Za-z0-9_-]+\.js$/u.test(
        workerResult.workerPath,
      ) ||
      !workerResult.contentType.includes("javascript") ||
      workerResult.message?.type !== "XLSX_ERROR" ||
      workerResult.message?.errorCode !== "INVALID_REQUEST"
    ) {
      throw new Error("CSP Worker flow result differs");
    }
    return succeeded(
      "worker",
      responses,
      [
        { id: "worker-path", value: workerResult.workerPath },
        { id: "worker-result", value: workerResult.message.errorCode },
      ],
      page,
    );
  });

const runBlobDownload = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ page }) => {
    const responses = [
      await openApplication(page, deploymentUrl, expectedCspHeader),
    ];
    const downloadPromise = page.waitForEvent("download");
    const details = await page.evaluate(() => {
      const { document } = globalThis;
      const contents = "csp-full-flow-blob";
      const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.download = "csp-full-flow.txt";
      link.href = url;
      document.body.append(link);
      link.click();
      return { contents, size: blob.size, url };
    });
    const download = await downloadPromise;
    const downloadPath = await download.path();
    if (
      download.suggestedFilename() !== "csp-full-flow.txt" ||
      downloadPath === null ||
      (await readFile(downloadPath, "utf8")) !== details.contents ||
      new URL(details.url).protocol !== "blob:"
    ) {
      throw new Error("CSP Blob download result differs");
    }
    return succeeded(
      "blob-download",
      responses,
      [{ id: "download-bytes", value: String(details.size) }],
      page,
    );
  });

const runRecovery = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ context, page }) => {
    const origin = new URL(deploymentUrl).origin;
    const identityResponse = await context.request.get(
      `${origin}/release-identity.json`,
    );
    if (!identityResponse.ok()) throw new Error("Release identity unavailable");
    const canonicalIdentity = await identityResponse.text();
    const identity = JSON.parse(canonicalIdentity);
    if (!/^[0-9a-f]{64}$/u.test(identity.outerAgentSha256 ?? "")) {
      throw new Error("Recovery identity digest is invalid");
    }
    const replacement =
      identity.outerAgentSha256 === "0".repeat(64)
        ? "f".repeat(64)
        : "0".repeat(64);
    const mismatchedIdentity = canonicalIdentity.replace(
      `"outerAgentSha256":"${identity.outerAgentSha256}"`,
      `"outerAgentSha256":"${replacement}"`,
    );
    if (mismatchedIdentity === canonicalIdentity) {
      throw new Error("Recovery identity could not be changed canonically");
    }
    const versionedPath = `/release-identity.${identity.sourceSha}.${identity.variantId}.json`;
    let requests = 0;
    await page.route(
      (url) => url.origin === origin && url.pathname === versionedPath,
      async (route) => {
        requests += 1;
        await route.fulfill({
          body: mismatchedIdentity,
          contentType: "application/json; charset=utf-8",
          headers: { "cache-control": "no-store" },
          status: 200,
        });
      },
    );
    const response = await page.goto(deploymentUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const responses = [await responseTrace(response, expectedCspHeader)];
    await page
      .locator('#root[data-pwa-recovery="true"]')
      .waitFor({ state: "visible" });
    await page
      .locator('[data-diagnostic-code="first-install-identity-unavailable"]')
      .waitFor({ state: "visible" });
    if (requests !== 1) throw new Error("Recovery identity request differs");
    return succeeded(
      "recovery",
      responses,
      [{ id: "versioned-identity-requests", value: String(requests) }],
      page,
    );
  });

const runApiError = ({ browser, deploymentUrl, expectedCspHeader }) =>
  withPage(browser, async ({ page }) => {
    const origin = new URL(deploymentUrl).origin;
    const apiPath = "/api/__foundation-assignment-validation__";
    let requests = 0;
    await page.route(
      (url) => url.origin === origin && url.pathname === apiPath,
      async (route) => {
        requests += 1;
        await route.fulfill({
          body: '{"error":"api-not-found"}',
          contentType: "application/json; charset=utf-8",
          headers: { "cache-control": "no-store" },
          status: 404,
        });
      },
    );
    const responses = [
      await openApplication(page, deploymentUrl, expectedCspHeader),
    ];
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      return { body: await response.json(), status: response.status };
    }, apiPath);
    if (
      requests !== 1 ||
      result.status !== 404 ||
      result.body?.error !== "api-not-found"
    ) {
      throw new Error("CSP API error flow result differs");
    }
    return succeeded(
      "api-error",
      responses,
      [{ id: "api-status", value: String(result.status) }],
      page,
    );
  });

const FLOW_RUNNERS = Object.freeze({
  "api-error": runApiError,
  "blob-download": runBlobDownload,
  normal: runNormal,
  offline: runOffline,
  "pwa-update": runPwaUpdate,
  recovery: runRecovery,
  worker: runWorker,
});

export const runCspFullFlows = async (options) => {
  const flows = await Promise.all(
    CSP_FULL_FLOW_IDS.map((id) => FLOW_RUNNERS[id](options)),
  );
  return flows.sort(
    (left, right) => FLOW_ORDER.get(left.id) - FLOW_ORDER.get(right.id),
  );
};
