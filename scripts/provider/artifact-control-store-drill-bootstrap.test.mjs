import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { buildRawDistManifest } from "../lib/artifact-builder-core.mjs";
import {
  assertPreparedArtifactDrillBootstrapRawDist,
  prepareArtifactDrillBootstrapRawDist,
} from "./artifact-control-store-drill-bootstrap.mjs";

const sourceSha = "0123456789abcdef0123456789abcdef01234567";

const createP0aPolicy = () => ({
  bootstrapRecovery: {
    bootstrapSourceSha: sourceSha,
    deploymentBindingSha256: "a".repeat(64),
    rawDistManifestSha256: null,
  },
});

const absent = async (target) => {
  try {
    await lstat(target);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
};

const materializer = (p0aPolicy, captured) => async (options) => {
  captured.options = options;
  const rawDistRoot = path.join(options.workRoot, "verified-output", "static");
  await mkdir(path.join(rawDistRoot, "assets"), { recursive: true });
  await Promise.all([
    writeFile(path.join(rawDistRoot, "index.html"), "<main>bootstrap</main>"),
    writeFile(path.join(rawDistRoot, "assets", "app.js"), "bootstrap();"),
  ]);
  const rawDistManifest = await buildRawDistManifest(rawDistRoot);
  const rawDistManifestSha256 = sha256Bytes(
    canonicalJsonBytes(rawDistManifest),
  );
  p0aPolicy.bootstrapRecovery.rawDistManifestSha256 = rawDistManifestSha256;
  return {
    rawDistRoot,
    rawDistManifest,
    receipt: {
      schemaVersion: 1,
      kind: "foundation-bootstrap-materialization-receipt/v1",
      sourceSha,
      rawDistManifestSha256,
    },
  };
};

const options = (p0aPolicy) => ({
  store: { namespace: "foundation-production" },
  namespace: "foundation-production",
  p0aPolicy,
  providerPolicy: { expectedProjectId: "project-id" },
  bootstrapSourceResolution: {
    gitCommitSha: sourceSha,
    treeSha: "1".repeat(40),
  },
  foundationBaseline: { bootstrapBaselineSourceSha: null },
  requiredRoutes: ["/"],
});

test("materializes P0A raw dist internally and removes it after use", async () => {
  const p0aPolicy = createP0aPolicy();
  const captured = {};
  const prepared = await prepareArtifactDrillBootstrapRawDist(
    options(p0aPolicy),
    { materialize: materializer(p0aPolicy, captured) },
  );
  assert.equal(
    assertPreparedArtifactDrillBootstrapRawDist(prepared),
    prepared.rawDistRoot,
  );
  assert.equal(captured.options.store.namespace, "foundation-production");
  assert.equal(captured.options.namespace, "foundation-production");
  const workRoot = path.dirname(path.dirname(prepared.rawDistRoot));
  assert.equal(await absent(workRoot), false);
  await prepared.cleanup();
  assert.equal(await absent(workRoot), true);
  assert.throws(
    () => assertPreparedArtifactDrillBootstrapRawDist(prepared),
    /not prepared from Release State/,
  );
  await assert.rejects(prepared.cleanup(), /cleanup replayed/);
});

test("removes the temporary tree when materialization or validation fails", async () => {
  const p0aPolicy = createP0aPolicy();
  let failedRoot;
  await assert.rejects(
    prepareArtifactDrillBootstrapRawDist(options(p0aPolicy), {
      materialize: async ({ workRoot }) => {
        failedRoot = workRoot;
        await mkdir(path.join(workRoot, "partial"), { recursive: true });
        await writeFile(
          path.join(workRoot, "partial", "secret.txt"),
          "partial",
        );
        throw new Error("immutable object read failed");
      },
    }),
    /immutable object read failed/,
  );
  assert.equal(await absent(failedRoot), true);

  const externalRoot = await mkdtemp(
    path.join(os.tmpdir(), "artifact-drill-external-raw-"),
  );
  try {
    await writeFile(path.join(externalRoot, "index.html"), "external");
    const rawDistManifest = await buildRawDistManifest(externalRoot);
    const rawDistManifestSha256 = sha256Bytes(
      canonicalJsonBytes(rawDistManifest),
    );
    p0aPolicy.bootstrapRecovery.rawDistManifestSha256 = rawDistManifestSha256;
    await assert.rejects(
      prepareArtifactDrillBootstrapRawDist(options(p0aPolicy), {
        materialize: async () => ({
          rawDistRoot: externalRoot,
          rawDistManifest,
          receipt: {
            schemaVersion: 1,
            kind: "foundation-bootstrap-materialization-receipt/v1",
            sourceSha,
            rawDistManifestSha256,
          },
        }),
      }),
      /not bound to P0A evidence/,
    );
  } finally {
    await rm(externalRoot, { recursive: true, force: true });
  }
});
