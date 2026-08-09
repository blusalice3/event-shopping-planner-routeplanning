import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) =>
  readFile(path.join(root, ".github", "workflows", name), "utf8");

test("uses one npm separator on Ubuntu workflows", async () => {
  const [release, quality, retention] = await Promise.all([
    workflow("release.yml"),
    workflow("quality.yml"),
    workflow("metrics-retention.yml"),
  ]);
  for (const [name, source] of [
    ["release.yml", release],
    ["quality.yml", quality],
    ["metrics-retention.yml", retention],
  ]) {
    assert.doesNotMatch(
      source,
      /npm run [A-Za-z0-9:.-]+ -- -- /u,
      `${name}: Linux npm must not forward a literal separator`,
    );
  }
  assert.ok(
    [...release.matchAll(/npm run [A-Za-z0-9:.-]+ -- /gu)].length >= 50,
  );
  assert.match(
    retention,
    /npm run verify:metrics-retention -- --live --output/u,
  );
  assert.match(
    quality,
    /node node_modules\/vite\/bin\/vite\.js preview --host 127\.0\.0\.1 --port 4173/u,
  );
  assert.doesNotMatch(quality, /npm run preview/u);

  const releaseRunArrayStarts = [
    ...release.matchAll(/'run',\s*'[A-Za-z0-9:.-]+',\s*'--',/gu),
  ];
  const releaseRunArrayDoubles = [
    ...release.matchAll(/'run',\s*'[A-Za-z0-9:.-]+',\s*'--',\s*'--',/gu),
  ];
  assert.equal(releaseRunArrayStarts.length, 5);
  assert.equal(releaseRunArrayDoubles.length, 0);
});

test("keeps the second npm separator on the Windows performance runner", async () => {
  const performance = await workflow("performance-evidence.yml");
  assert.match(
    performance,
    /runs-on: \[self-hosted, Windows, X64, foundation-performance\]/u,
  );
  assert.match(
    performance,
    /npm run performance:own-gate-samples:collect -- -- --namespace/u,
  );
});

test("selects spawned npm separators from the host platform", async () => {
  const source = await readFile(
    path.join(
      root,
      "scripts",
      "release-state",
      "prePromotionEvidenceExecution.mjs",
    ),
    "utf8",
  );
  assert.match(
    source,
    /process\.platform === "win32" \? \["--", "--"\] : \["--"\]/u,
  );
  assert.equal(
    [...source.matchAll(/\.\.\.npmArgumentSeparator\(\)/gu)].length,
    2,
  );
});
