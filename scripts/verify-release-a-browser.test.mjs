import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
