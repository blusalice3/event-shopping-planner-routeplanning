import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ServiceWorkerActivationTracker } from "./lib/service-worker-activation-tracker.mjs";

const verifierPath = fileURLToPath(
  new URL("./verify-release-a-browser.mjs", import.meta.url),
);
const verifierSource = await readFile(verifierPath, "utf8");

test("Release A browser verifier is syntax-valid and Playwright-owned", () => {
  const syntaxCheck = spawnSync(process.execPath, ["--check", verifierPath], {
    encoding: "utf8",
  });
  assert.equal(syntaxCheck.status, 0, syntaxCheck.stderr || syntaxCheck.stdout);

  assert.match(
    verifierSource,
    /import \{ chromium as playwrightChromium \} from "playwright";/,
  );
  assert.match(verifierSource, /\.launchPersistentContext\(/);
  assert.match(verifierSource, /context\.newPage\(\)/);
  assert.match(verifierSource, /context\.newCDPSession\(page\)/);
  assert.match(verifierSource, /browser\.newBrowserCDPSession\(\)/);

  for (const forbidden of [
    /from "ws"/,
    /\bWebSocket\b/,
    /remote-debugging-port/,
    /\/json\/(?:list|new|close|version)/,
    /spawn\(\s*chrome/,
  ]) {
    assert.doesNotMatch(verifierSource, forbidden);
  }
});

test("active Service Worker evidence remains exact and narrowly scoped", () => {
  assert.match(verifierSource, /Target\.getTargets/);
  assert.match(verifierSource, /Target\.attachToTarget/);
  assert.match(verifierSource, /Target\.sendMessageToTarget/);
  assert.match(verifierSource, /Debugger\.getScriptSource/);
  assert.match(
    verifierSource,
    /Playwright has no public API for reading the exact running worker source/,
  );
  assert.match(verifierSource, /sha256:\s*sha256Text\(scriptSource\)/);
});

test("forward transition waits for one target worker to activate naturally", () => {
  const helperStart = verifierSource.indexOf(
    "const waitForNaturalServiceWorkerActivation",
  );
  const helperEnd = verifierSource.indexOf(
    "const requestTargetServiceWorkerUpdate",
  );
  const helperSource = verifierSource.slice(helperStart, helperEnd);
  const orderedFragments = [
    "ServiceWorker.workerVersionUpdated",
    'pageClient.send("ServiceWorker.enable")',
    "freezeBaselineVersionIds()",
    "requestUpdate()",
    "getNewInstalledVersionId()",
    "markClientsReleaseStarted(waitingVersionId)",
    "releaseClients()",
    "isNaturalActivationComplete()",
  ];
  let previousIndex = -1;
  for (const fragment of orderedFragments) {
    const fragmentIndex = helperSource.indexOf(fragment);
    assert.ok(
      fragmentIndex > previousIndex,
      `Out-of-order fragment: ${fragment}`,
    );
    previousIndex = fragmentIndex;
  }
  const reopenIndex = helperSource.indexOf("reopenClients()", previousIndex);
  const postReopenCheckIndex = helperSource.indexOf(
    "isNaturalActivationComplete()",
    previousIndex + "isNaturalActivationComplete()".length,
  );
  const unsubscribeIndex = helperSource.indexOf("unsubscribe()", previousIndex);
  assert.ok(
    reopenIndex > previousIndex &&
      postReopenCheckIndex > reopenIndex &&
      unsubscribeIndex > postReopenCheckIndex,
    "Reopened clients must remain under tracker observation through the post-reopen check.",
  );
  assert.match(helperSource, /finally \{\s*unsubscribe\(\);/);
  assert.match(helperSource, /pageClient\.send\("ServiceWorker\.disable"\)/);

  const requestSource = verifierSource.slice(helperEnd);
  assert.match(requestSource, /previousRegistration\.installing/);
  assert.match(requestSource, /previousRegistration\.waiting/);
  assert.ok(
    requestSource.indexOf("registration.installing") <
      requestSource.indexOf("registration.waiting"),
    "A new installing worker must take precedence over a waiting worker.",
  );
  assert.match(requestSource, /type: "classic"/);
  assert.match(requestSource, /updateViaCache: "none"/);
  assert.match(requestSource, /page\.goto\("about:blank"/);
  const forwardStart = verifierSource.indexOf(
    '} else if (TRANSITION_MODE === "forward")',
  );
  const primaryReopen = verifierSource.indexOf(
    "await navigate(primary.client, PREVIEW_URL)",
    forwardStart,
  );
  const standaloneReopen = verifierSource.indexOf(
    "await navigate(standaloneTarget.client, PREVIEW_URL)",
    primaryReopen,
  );
  assert.ok(
    primaryReopen > forwardStart && standaloneReopen > primaryReopen,
    "Forward clients must reopen in primary-then-standalone order.",
  );
  const stagedReopenSource = verifierSource.slice(
    primaryReopen,
    verifierSource.indexOf(
      "return { primaryRegistration, standaloneRegistration }",
      standaloneReopen,
    ),
  );
  assert.match(stagedReopenSource, /waitForControlledApplication/);
  assert.doesNotMatch(stagedReopenSource, /Promise\.all|\breload\(/);
  assert.doesNotMatch(
    verifierSource,
    /forwardInstrumentation\.controllerChangeCount\s*>=\s*1/,
  );
});

const workerVersion = (versionId, status) => ({
  versionId,
  status,
  scriptURL: "http://127.0.0.1:4173/sw.js",
  runningStatus: status === "activated" ? "running" : "stopped",
  controlledClients: [],
});

test("activation tracker selects only the post-baseline installed version", () => {
  const tracker = new ServiceWorkerActivationTracker(
    "http://127.0.0.1:4173/sw.js",
  );
  tracker.observe(
    {
      versions: [
        workerVersion("active-a", "activated"),
        workerVersion("stale-b", "installed"),
      ],
    },
    100,
  );
  assert.equal(tracker.isBaselineReady(500, 300), true);
  assert.deepEqual(tracker.freezeBaselineVersionIds(500, 300), [
    "active-a",
    "stale-b",
  ]);
  tracker.observe(
    { versions: [workerVersion("candidate-c", "installed")] },
    600,
  );
  assert.equal(tracker.getNewInstalledVersionId(), "candidate-c");
  tracker.markClientsReleaseStarted("candidate-c");
  tracker.observe(
    {
      versions: [
        workerVersion("active-a", "redundant"),
        workerVersion("stale-b", "redundant"),
        workerVersion("candidate-c", "activated"),
      ],
    },
    700,
  );
  assert.equal(tracker.isNaturalActivationComplete(1_100, 300), true);
  tracker.observe(
    { versions: [workerVersion("unexpected-d", "installed")] },
    1_200,
  );
  assert.throws(
    () => tracker.isNaturalActivationComplete(1_600, 300),
    /not bound to exactly one new Service Worker version/,
  );
});

test("activation tracker rejects a baseline waiting worker activation", () => {
  const tracker = new ServiceWorkerActivationTracker(
    "http://127.0.0.1:4173/sw.js",
  );
  tracker.observe(
    {
      versions: [
        workerVersion("active-a", "activated"),
        workerVersion("stale-b", "installed"),
      ],
    },
    100,
  );
  tracker.freezeBaselineVersionIds(500, 300);
  tracker.observe({ versions: [workerVersion("stale-b", "activated")] }, 600);
  assert.throws(
    () => tracker.getNewInstalledVersionId(),
    /activated before client release/,
  );
});

test("activation tracker rejects two post-baseline versions", () => {
  const tracker = new ServiceWorkerActivationTracker(
    "http://127.0.0.1:4173/sw.js",
  );
  tracker.observe({ versions: [workerVersion("active-a", "activated")] }, 100);
  tracker.freezeBaselineVersionIds(500, 300);
  tracker.observe(
    {
      versions: [
        workerVersion("candidate-c", "installed"),
        workerVersion("candidate-d", "installed"),
      ],
    },
    600,
  );
  assert.throws(
    () => tracker.getNewInstalledVersionId(),
    /produced 2 new Service Worker versions/,
  );
});

test("preflight and transition JSON contracts remain present", () => {
  for (const contractFragment of [
    'result: "PREFLIGHT_PASS"',
    'result: "PASS"',
    'mode: "rollback"',
    'mode: "forward"',
    "standaloneAppWindowEquivalent",
    "sameProfile",
    "offlineReload",
    "onlineResume",
    "physicalDeleteCount",
    "controllerChangeCount",
    "naturalActivation",
    "activeSource",
    "offlineControllerIdentity",
  ]) {
    assert.ok(
      verifierSource.includes(contractFragment),
      `Missing browser evidence contract fragment: ${contractFragment}`,
    );
  }

  assert.match(
    verifierSource,
    /assets\\\\\/\(\?:index-\[\^\/\]\+\|release-role\)/,
  );
});
