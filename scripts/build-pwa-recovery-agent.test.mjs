import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPwaRecoveryIdentity } from "./build-pwa-recovery-agent.mjs";
import { readJsonStrict, sha256Json } from "./lib/canonical-json.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "./lib/release-policy.mjs";

const sourceSha = "1".repeat(40);
const dbFingerprint = "2".repeat(64);

const createOutput = async (serviceWorkerSource) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwa-identity-test-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await Promise.all([
    writeFile(
      path.join(root, "assets", "outer-recovery-agent.js"),
      "export const outer = true;\n",
      "utf8",
    ),
    writeFile(
      path.join(root, "assets", "release-role.js"),
      "export const role = 'standard';\n",
      "utf8",
    ),
    writeFile(path.join(root, "sw.js"), serviceWorkerSource, "utf8"),
  ]);
  return root;
};

test("writes byte-identical canonical stable and versioned identities", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  const variantId = computeVariantId(policy, policy.targetStandard);
  const versionedUrl = `/release-identity.${sourceSha}.${variantId}.json`;
  const root = await createOutput(
    `const identityUrl=${JSON.stringify(versionedUrl)};`,
  );
  try {
    const result = await buildPwaRecoveryIdentity({
      distDirectory: root,
      sourceSha,
      releaseRole: "standard",
      dbFingerprint,
    });
    const [stable, versioned] = await Promise.all([
      readFile(result.stablePath, "utf8"),
      readFile(result.versionedPath, "utf8"),
    ]);
    assert.equal(stable, versioned);
    assert.deepEqual(JSON.parse(stable), result.identity);
    assert.equal(result.identity.variantId, variantId);
    assert.equal(result.dimensionsSha256, sha256Json(policy.targetStandard));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an immediate-activation worker", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  const variantId = computeVariantId(policy, policy.targetStandard);
  const root = await createOutput(
    `const identityUrl="/release-identity.${sourceSha}.${variantId}.json";self.skipWaiting();`,
  );
  try {
    await assert.rejects(
      buildPwaRecoveryIdentity({
        distDirectory: root,
        sourceSha,
        releaseRole: "standard",
        dbFingerprint,
      }),
      /natural-activation policy/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("binds a non-target phase candidate into legacy identity bytes", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  const dimensions = { ...policy.initialStandard };
  const variantId = computeVariantId(policy, dimensions);
  const root = await createOutput(
    `const identityUrl="/release-identity.${sourceSha}.${variantId}.json";`,
  );
  try {
    const result = await buildPwaRecoveryIdentity({
      distDirectory: root,
      sourceSha,
      releaseRole: "standard",
      dimensions,
      variantId,
      dbFingerprint,
    });
    assert.equal(result.identity.pwaLifecycle, "legacy-auto-update-v1");
    assert.equal(
      result.identity.appEntryUrl,
      "/assets/outer-recovery-agent.js",
    );
    assert.equal(result.identity.variantId, variantId);
    assert.deepEqual(result.dimensions, dimensions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks a CLI-selected QA identity as nonpromotable", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  const variantId = computeVariantId(policy, policy.targetStandard);
  const root = await createOutput(
    `const identityUrl="/release-identity.${sourceSha}.${variantId}.json";`,
  );
  try {
    const result = await buildPwaRecoveryIdentity({
      distDirectory: root,
      sourceSha,
      releaseRole: "standard",
      dbFingerprint,
      buildPurpose: "qa-list-force-full",
      nonPromotable: true,
    });
    assert.equal(result.identity.buildPurpose, "qa-list-force-full");
    assert.equal(result.identity.nonPromotable, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed hashes, roles, and QA purpose bindings", async () => {
  const base = {
    distDirectory: "not-read",
    sourceSha,
    releaseRole: "standard",
    dbFingerprint,
  };
  for (const [patch, message] of [
    [{ sourceSha: null }, /sourceSha must be a lowercase/],
    [{ sourceSha: "not-a-sha" }, /sourceSha must be a lowercase/],
    [{ dbFingerprint: null }, /dbFingerprint must be a lowercase/],
    [{ releaseRole: "preview" }, /Unsupported release role/],
    [{ buildPurpose: "preview" }, /build purpose is invalid/],
    [{ nonPromotable: "yes" }, /build purpose is invalid/],
    [
      { buildPurpose: "qa-xlsx-main", nonPromotable: false },
      /build purpose is invalid/,
    ],
    [
      {
        releaseRole: "containment",
        buildPurpose: "qa-xlsx-main",
        nonPromotable: true,
      },
      /build purpose is invalid/,
    ],
  ]) {
    await assert.rejects(
      buildPwaRecoveryIdentity({ ...base, ...patch }),
      message,
    );
  }
});

test("rejects dimensions, variants, and worker identity contract drift", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  await assert.rejects(
    buildPwaRecoveryIdentity({
      distDirectory: "not-read",
      sourceSha,
      releaseRole: "containment",
      dimensions: policy.targetStandard,
      dbFingerprint,
    }),
    /role differs from supplied dimensions/,
  );
  await assert.rejects(
    buildPwaRecoveryIdentity({
      distDirectory: "not-read",
      sourceSha,
      releaseRole: "standard",
      dimensions: policy.targetStandard,
      variantId: "f".repeat(64),
      dbFingerprint,
    }),
    /variant differs from supplied dimensions/,
  );

  const variantId = computeVariantId(policy, policy.targetStandard);
  const missingIdentityRoot = await createOutput("const worker = true;");
  const stableIdentityRoot = await createOutput(
    `const identityUrl="/release-identity.${sourceSha}.${variantId}.json";` +
      'const request={url:"/release-identity.json"};',
  );
  try {
    await assert.rejects(
      buildPwaRecoveryIdentity({
        distDirectory: missingIdentityRoot,
        sourceSha,
        releaseRole: "standard",
        dbFingerprint,
      }),
      /does not precache/,
    );
    await assert.rejects(
      buildPwaRecoveryIdentity({
        distDirectory: stableIdentityRoot,
        sourceSha,
        releaseRole: "standard",
        dbFingerprint,
      }),
      /stable-identity or natural-activation policy/,
    );
  } finally {
    await Promise.all([
      rm(missingIdentityRoot, { recursive: true, force: true }),
      rm(stableIdentityRoot, { recursive: true, force: true }),
    ]);
  }
});

test("rejects empty and non-file recovery agent output", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  const variantId = computeVariantId(policy, policy.targetStandard);
  const root = await createOutput(
    `const identityUrl="/release-identity.${sourceSha}.${variantId}.json";`,
  );
  const outerAgentPath = path.join(root, "assets", "outer-recovery-agent.js");
  try {
    await writeFile(outerAgentPath, "", "utf8");
    await assert.rejects(
      buildPwaRecoveryIdentity({
        distDirectory: root,
        sourceSha,
        releaseRole: "standard",
        dbFingerprint,
      }),
      /missing or empty/,
    );
    await rm(outerAgentPath);
    await mkdir(outerAgentPath);
    await assert.rejects(
      buildPwaRecoveryIdentity({
        distDirectory: root,
        sourceSha,
        releaseRole: "standard",
        dbFingerprint,
      }),
      /missing or empty/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("builds the projected containment identity", async () => {
  const policy = await readJsonStrict(
    new URL("../config/release-variants.json", import.meta.url),
  );
  const dimensions = projectContainmentDimensions(
    policy,
    policy.targetStandard,
  );
  const variantId = computeVariantId(policy, dimensions);
  const root = await createOutput(
    `const identityUrl="/release-identity.${sourceSha}.${variantId}.json";`,
  );
  try {
    const result = await buildPwaRecoveryIdentity({
      distDirectory: root,
      sourceSha,
      releaseRole: "containment",
      dbFingerprint,
    });
    assert.equal(result.identity.releaseRole, "containment");
    assert.deepEqual(result.dimensions, dimensions);
    assert.equal(result.identity.variantId, variantId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
