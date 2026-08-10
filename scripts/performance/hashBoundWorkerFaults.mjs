import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FAULT_REFS = Object.freeze({
  "xlsx-worker-cancel": "scripts/performance/fault-workers/cancel.worker.js",
  "xlsx-worker-timeout": "scripts/performance/fault-workers/timeout.worker.js",
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const waitFor = async (read, label, timeoutMs = 5_000) => {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

export const installHashBoundWorkerFault = async ({
  artifactBinding,
  browserContext,
  fixtureDocument,
  page,
  scenarioId,
  targetUrl,
  workerUrl,
}) => {
  const expectedRef = FAULT_REFS[scenarioId];
  const fault = fixtureDocument?.faultInjection;
  if (
    !expectedRef ||
    fault?.method !== "playwright-exact-worker-response-substitution-v1" ||
    fault.replacementRef !== expectedRef ||
    !SHA256_PATTERN.test(fault.replacementSha256 ?? "") ||
    fault.beaconPath !== "/__foundation-performance-worker-beacon"
  ) {
    throw new Error(`${scenarioId}: fault fixture binding is invalid`);
  }

  const target = new URL(targetUrl);
  const worker = new URL(workerUrl);
  if (
    worker.origin !== target.origin ||
    worker.search !== "" ||
    worker.hash !== "" ||
    !/^\/assets\/xlsx\.worker-[A-Za-z0-9_-]+\.js$/.test(worker.pathname)
  ) {
    throw new Error(`${scenarioId}: Worker URL is not an exact public asset`);
  }
  const outputPath = `static${worker.pathname}`;
  const manifestEntry = artifactBinding?.outputFiles?.find(
    (entry) => entry.path === outputPath,
  );
  if (
    !manifestEntry ||
    !SHA256_PATTERN.test(manifestEntry.sha256 ?? "") ||
    !Number.isSafeInteger(manifestEntry.size) ||
    manifestEntry.size <= 0
  ) {
    throw new Error(`${scenarioId}: Worker is absent from artifact binding`);
  }
  const originalResponse = await browserContext.request.get(worker.href, {
    failOnStatusCode: false,
    headers: { "cache-control": "no-cache" },
  });
  const originalBytes = await originalResponse.body();
  if (
    originalResponse.status() !== 200 ||
    originalBytes.length !== manifestEntry.size ||
    sha256(originalBytes) !== manifestEntry.sha256
  ) {
    throw new Error(`${scenarioId}: original Worker differs from artifact`);
  }

  const replacementPath = path.resolve(root, expectedRef);
  const relative = path.relative(root, replacementPath).replaceAll("\\", "/");
  if (relative !== expectedRef) {
    throw new Error(`${scenarioId}: fault asset escaped the source tree`);
  }
  const replacementBytes = await readFile(replacementPath);
  if (sha256(replacementBytes) !== fault.replacementSha256) {
    throw new Error(`${scenarioId}: fault asset differs from fixture hash`);
  }

  const beacons = [];
  const workerCloseEvents = [];
  let replacementRequestCount = 0;
  const beaconListener = (request) => {
    const requestUrl = new URL(request.url());
    if (
      requestUrl.origin === target.origin &&
      requestUrl.pathname === fault.beaconPath &&
      request.method() === "POST" &&
      requestUrl.searchParams.get("scenario") === scenarioId
    ) {
      beacons.push({
        event: requestUrl.searchParams.get("event"),
        observedAt: performance.now(),
        requestId: requestUrl.searchParams.get("requestId"),
      });
    }
  };
  const workerListener = (workerHandle) => {
    if (workerHandle.url() !== worker.href) return;
    workerHandle.on("close", () => {
      workerCloseEvents.push(performance.now());
    });
  };
  const routeHandler = async (route, request) => {
    replacementRequestCount += 1;
    if (
      replacementRequestCount !== 1 ||
      request.url() !== worker.href ||
      request.method() !== "GET" ||
      request.resourceType() !== "script"
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/javascript; charset=utf-8",
      },
      body: replacementBytes,
    });
  };

  page.on("request", beaconListener);
  page.on("worker", workerListener);
  await browserContext.route(worker.href, routeHandler);

  return Object.freeze({
    binding: Object.freeze({
      method: fault.method,
      originalWorkerSha256: manifestEntry.sha256,
      replacementWorkerSha256: fault.replacementSha256,
    }),
    async waitForBeacon(eventName, timeoutMs) {
      return waitFor(
        () => beacons.find(({ event }) => event === eventName),
        `${scenarioId} ${eventName} beacon`,
        timeoutMs,
      );
    },
    async waitForWorkerClose(timeoutMs) {
      return waitFor(
        () => workerCloseEvents[0],
        `${scenarioId} Worker close`,
        timeoutMs,
      );
    },
    async dispose() {
      await browserContext.unroute(worker.href, routeHandler);
      page.off("request", beaconListener);
      page.off("worker", workerListener);
      if (replacementRequestCount !== 1) {
        throw new Error(
          `${scenarioId}: fault route expected one Worker request; received ${replacementRequestCount}`,
        );
      }
    },
  });
};
