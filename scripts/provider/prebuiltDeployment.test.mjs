import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  contentAddressedObjectPath,
  writeContentAddressedObject,
} from "../lib/content-addressed-store.mjs";
import { createDeterministicZip } from "../deterministic-zip.mjs";
import {
  deployVerifiedPrebuilt,
  repositoryRoot,
  resolveAuthoritativeVercelDeployment,
} from "./prebuiltDeployment.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";
import {
  parseDeployPrebuiltCliArguments,
  resolveDeployPrebuiltCliPaths,
} from "./deploy-prebuilt.mjs";

const SOURCE_SHA = "1".repeat(40);
const STANDARD_VARIANT = "2".repeat(64);
const CONTAINMENT_VARIANT = "3".repeat(64);
const TOKEN = "test-token-must-never-leak";
const DEPLOYMENT_URL = "https://immutable-test.vercel.app";
const PROVIDER_RESPONSE_HASH = "f".repeat(64);
const FIXED_NOW = Date.parse("Thu, 06 Aug 2026 00:01:00 GMT");

const replaceAllBytes = (bytes, before, after) => {
  assert.equal(before.length, after.length);
  const result = Buffer.from(bytes);
  let offset = 0;
  while ((offset = result.indexOf(before, offset)) >= 0) {
    after.copy(result, offset);
    offset += after.length;
  }
  return result;
};

const fixture = async ({
  manifestRole = "standard",
  traversal = false,
} = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "prebuilt-deploy-test-"));
  const packageRoot = path.join(root, "package");
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, traversal ? "aa" : "static"), {
    recursive: true,
  });
  const relativeFile = traversal ? "aa/escape" : "static/index.html";
  await writeFile(
    path.join(sourceRoot, ...relativeFile.split("/")),
    "verified prebuilt bytes",
    "utf8",
  );
  const archivePath = path.join(root, "artifact.zip");
  const archivePolicy = parseJsonStrict(
    await readFile(
      path.join(repositoryRoot, "config", "artifact-archive-policy.json"),
      "utf8",
    ),
  );
  const zip = await createDeterministicZip({
    sourceDirectory: sourceRoot,
    outputPath: archivePath,
    policy: archivePolicy,
  });
  let archiveBytes = await readFile(archivePath);
  if (traversal) {
    archiveBytes = replaceAllBytes(
      archiveBytes,
      Buffer.from("aa/escape"),
      Buffer.from(["..", "escape"].join("/")),
    );
  }

  const releasePolicy = { schemaVersion: 1, purpose: "test" };
  const toolchainPolicy = {
    schemaVersion: 1,
    packages: { vercel: "58.5.1" },
  };
  const providerPolicy = {
    schemaVersion: 1,
    provider: "vercel",
    bindingStatus: "configured",
    expectedProjectId: "prj_expected",
    expectedTeamId: "team_expected",
  };
  const providerObservation = {
    schemaVersion: 1,
    observedAt: "2026-08-06T00:00:00.000Z",
    providerProjectId: "prj_expected",
    providerTeamId: "team_expected",
    evidenceReceipts: [
      {
        kind: "project",
        responseDate: "Thu, 06 Aug 2026 00:00:00 GMT",
        etag: '"first"',
        responseSha256: "a".repeat(64),
      },
    ],
  };
  const requiredDbCompatibility = {
    contractUri: "urn:test:db",
    fingerprint: "4".repeat(64),
  };
  const manifest = {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    releaseRole: manifestRole,
    variantId: STANDARD_VARIANT,
    toolchainPolicyHash: "5".repeat(64),
    providerConfigurationHash: providerConfigurationHash(providerObservation),
    providerPolicyHash: sha256Json(providerPolicy),
    releasePolicyHash: sha256Json(releasePolicy),
    requiredDbCompatibility,
    outputFiles: zip.files,
  };
  const manifestReference = await writeContentAddressedObject({
    packageRoot,
    bytes: canonicalJsonBytes(manifest),
    kind: "artifact-manifest.json",
  });
  const archiveReference = await writeContentAddressedObject({
    packageRoot,
    bytes: archiveBytes,
    kind: "artifact.zip",
  });
  const index = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha: SOURCE_SHA,
    buildId: SOURCE_SHA,
    toolchainPolicyHash: manifest.toolchainPolicyHash,
    providerConfigurationHash: manifest.providerConfigurationHash,
    providerPolicyHash: manifest.providerPolicyHash,
    releasePolicyHash: manifest.releasePolicyHash,
    requiredDbCompatibility,
    artifacts: [
      {
        releaseRole: "standard",
        variantId: STANDARD_VARIANT,
        manifest: {
          uri: manifestReference.uri,
          sha256: manifestReference.sha256,
        },
        archive: {
          uri: archiveReference.uri,
          sha256: archiveReference.sha256,
        },
      },
      {
        releaseRole: "containment",
        variantId: CONTAINMENT_VARIANT,
        manifest: {
          uri: manifestReference.uri,
          sha256: manifestReference.sha256,
        },
        archive: {
          uri: archiveReference.uri,
          sha256: archiveReference.sha256,
        },
      },
    ],
  };
  const indexBytes = canonicalJsonBytes(index);
  await writeFile(
    path.join(packageRoot, "release-package-index.json"),
    indexBytes,
  );
  const events = [];
  const invocations = [];
  const productionVerifier = async (options) => {
    events.push("production-verifier");
    assert.equal(options.requireProductionBindings, true);
    assert.equal(
      providerConfigurationHash(options.providerObservation),
      manifest.providerConfigurationHash,
    );
    return {
      index,
      packageIndexSha256: sha256Bytes(indexBytes),
      productionEligible: true,
    };
  };
  const providerResolution = (overrides = {}) => ({
    request: {
      url: "https://api.vercel.com/v13/deployments/immutable-test.vercel.app?teamId=team_expected",
      status: 200,
      date: "Thu, 06 Aug 2026 00:00:00 GMT",
      etag: '"deployment-etag"',
      responseSha256: PROVIDER_RESPONSE_HASH,
    },
    deployment: {
      id: "dpl_authoritative",
      url: DEPLOYMENT_URL,
      projectId: "prj_expected",
      teamId: "team_expected",
      target: "production",
      readyState: "READY",
      ...overrides,
    },
  });
  const baseOptions = {
    packageRoot,
    role: "standard",
    providerObservation,
    idempotencyKey: "release:test:1234567890",
    receiptPath: path.join(root, "receipt.json"),
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    dbContract: { schemaVersion: 1 },
    cspPolicy: { schemaVersion: 1 },
    root: repositoryRoot,
    environment: {
      ...process.env,
      VERCEL_TOKEN: TOKEN,
      VERCEL_PROJECT_ID: "prj_expected",
      VERCEL_ORG_ID: "team_expected",
    },
    stagingParent: root,
    productionVerifier,
    manifestValidator: (value) => value,
    commandRunner: async (invocation) => {
      events.push("command");
      invocations.push(invocation);
      assert.equal(
        await readFile(
          path.join(invocation.cwd, ".vercel", "output", relativeFile),
          "utf8",
        ),
        "verified prebuilt bytes",
      );
      return { status: 0, stdout: `${DEPLOYMENT_URL}\n`, stderr: "" };
    },
    providerResolver: async () => providerResolution(),
    nowMilliseconds: FIXED_NOW,
  };
  return {
    root,
    packageRoot,
    archiveReference,
    baseOptions,
    events,
    invocations,
    providerResolution,
  };
};

test("deploys only the verified prebuilt command and writes a canonical receipt", async () => {
  const context = await fixture();
  try {
    const result = await deployVerifiedPrebuilt(context.baseOptions);
    assert.deepEqual(context.events, ["production-verifier", "command"]);
    assert.equal(context.invocations.length, 1);
    const invocation = context.invocations[0];
    assert.equal(invocation.executable, process.execPath);
    assert.deepEqual(invocation.arguments.slice(1, 7), [
      "deploy",
      "--prebuilt",
      "--prod",
      "--skip-domain",
      "--yes",
      "--cwd",
    ]);
    assert.equal(
      invocation.arguments.some((argument) =>
        /^(?:build|npm|vite|vercel-build)$/i.test(argument),
      ),
      false,
    );
    assert.equal(invocation.arguments.includes(TOKEN), false);
    const receiptBytes = await readFile(result.receiptPath);
    assert.equal(receiptBytes.equals(canonicalJsonBytes(result.receipt)), true);
    assert.equal(receiptBytes.includes(Buffer.from(TOKEN)), false);
    assert.equal(
      result.receipt.archive.sha256,
      context.archiveReference.sha256,
    );
    assert.equal(
      result.receipt.idempotencyKey,
      context.baseOptions.idempotencyKey,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("replays an exact idempotency receipt after fresh provider resolution without redeploying", async () => {
  const context = await fixture();
  try {
    const first = await deployVerifiedPrebuilt(context.baseOptions);
    context.baseOptions.providerObservation = {
      ...context.baseOptions.providerObservation,
      observedAt: "2026-08-06T00:01:00.000Z",
      evidenceReceipts: [
        {
          kind: "project",
          responseDate: "Thu, 06 Aug 2026 00:01:00 GMT",
          etag: '"second"',
          responseSha256: "b".repeat(64),
        },
      ],
    };
    const replay = await deployVerifiedPrebuilt(context.baseOptions);
    assert.equal(replay.replayed, true);
    assert.equal(replay.receiptSha256, first.receiptSha256);
    assert.equal(context.invocations.length, 1);
    assert.deepEqual(context.events, [
      "production-verifier",
      "command",
      "production-verifier",
    ]);
    await assert.rejects(
      deployVerifiedPrebuilt({
        ...context.baseOptions,
        idempotencyKey: "release:different:123456",
      }),
      /receipt binding differs/,
    );
    assert.equal(context.invocations.length, 1);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects content-addressed archive tampering before command execution", async () => {
  const context = await fixture();
  try {
    const archivePath = contentAddressedObjectPath(
      context.packageRoot,
      context.archiveReference.sha256,
      "artifact.zip",
    );
    await writeFile(archivePath, "tampered");
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /bytes differ from declared SHA-256/,
    );
    assert.deepEqual(context.events, ["production-verifier"]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects path traversal in a content-addressed ZIP", async () => {
  const context = await fixture({ traversal: true });
  try {
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /(?:Unsafe package path|invalid relative path)/,
    );
    assert.deepEqual(context.events, ["production-verifier"]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects selected role and manifest role mismatch", async () => {
  const context = await fixture({ manifestRole: "containment" });
  try {
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /manifest binding differs/,
    );
    assert.deepEqual(context.events, ["production-verifier"]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects ambiguous CLI URL output", async () => {
  const context = await fixture();
  try {
    context.baseOptions.commandRunner = async () => ({
      status: 0,
      stdout: `${DEPLOYMENT_URL}\nhttps://other.vercel.app\n`,
      stderr: "",
    });
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /ambiguous deployment URL/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects authoritative provider project/team mismatch", async () => {
  const context = await fixture();
  try {
    context.baseOptions.providerResolver = async () =>
      context.providerResolution({ projectId: "prj_other" });
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /provider deployment binding differs/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects stale authoritative provider Date evidence", async () => {
  const context = await fixture();
  try {
    context.baseOptions.providerResolver = async () => {
      const resolution = context.providerResolution();
      resolution.request.date = "Thu, 06 Aug 2026 00:00:00 GMT";
      return resolution;
    };
    context.baseOptions.nowMilliseconds = Date.parse(
      "Thu, 06 Aug 2026 00:10:00 GMT",
    );
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /Date is stale or future/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects a token leaked by command output without echoing it", async () => {
  const context = await fixture();
  try {
    context.baseOptions.commandRunner = async () => ({
      status: 0,
      stdout: `${DEPLOYMENT_URL}\n`,
      stderr: `debug credential ${TOKEN}`,
    });
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      (error) =>
        /contains a secret value/.test(error.message) &&
        !error.message.includes(TOKEN),
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("rejects control-bearing provider token before command or fetch", async () => {
  const context = await fixture();
  try {
    let fetched = false;
    context.baseOptions.environment = {
      ...context.baseOptions.environment,
      VERCEL_TOKEN: `${TOKEN}\n`,
    };
    context.baseOptions.providerResolver = async () => {
      fetched = true;
      return context.providerResolution();
    };
    await assert.rejects(
      deployVerifiedPrebuilt(context.baseOptions),
      /deploy environment binding is invalid/,
    );
    assert.equal(context.invocations.length, 0);
    assert.equal(fetched, false);
    assert.deepEqual(context.events, ["production-verifier"]);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("authoritative resolver keeps token in headers and records raw response evidence", async () => {
  const responseBody = Buffer.from(
    JSON.stringify({
      id: "dpl_authoritative",
      url: "immutable-test.vercel.app",
      projectId: "prj_expected",
      ownerId: "team_expected",
      target: "production",
      readyState: "READY",
    }),
    "utf8",
  );
  let observedUrl;
  let observedInit;
  const resolution = await resolveAuthoritativeVercelDeployment({
    deploymentUrl: DEPLOYMENT_URL,
    expectedTeamId: "team_expected",
    token: TOKEN,
    fetchImpl: async (url, init) => {
      observedUrl = url.href;
      observedInit = init;
      return new Response(responseBody, {
        status: 200,
        headers: {
          date: "Thu, 06 Aug 2026 00:00:00 GMT",
          etag: '"deployment-etag"',
          "content-length": String(responseBody.length),
          "content-type": "application/json",
        },
      });
    },
  });
  assert.equal(observedUrl.includes(TOKEN), false);
  assert.equal(observedInit.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(resolution.deployment.projectId, "prj_expected");
  assert.equal(resolution.request.responseSha256, sha256Bytes(responseBody));
});

test("CLI rejects unknown, duplicate, missing, unsafe values and path reuse", async () => {
  const valid = [
    "--package",
    "package",
    "--role",
    "standard",
    "--provider-observation",
    "observation.json",
    "--idempotency-key",
    "release:test:1234567890",
    "--receipt",
    "receipt.json",
  ];
  assert.throws(
    () =>
      parseDeployPrebuiltCliArguments([
        ...valid.slice(0, -2),
        "--unknown",
        "receipt.json",
      ]),
    /Invalid, duplicate, or missing/,
  );
  assert.throws(
    () =>
      parseDeployPrebuiltCliArguments([
        ...valid.slice(0, 2),
        "--package",
        "other",
        ...valid.slice(4),
      ]),
    /Invalid, duplicate, or missing/,
  );
  assert.throws(
    () => parseDeployPrebuiltCliArguments(valid.slice(0, -1)),
    /exact five flag/,
  );
  assert.throws(
    () =>
      parseDeployPrebuiltCliArguments(
        valid.map((value) => (value === "standard" ? "other" : value)),
      ),
    /--role/,
  );
  assert.throws(
    () =>
      parseDeployPrebuiltCliArguments(
        valid.map((value) =>
          value === "release:test:1234567890" ? "short" : value,
        ),
      ),
    /--idempotency-key/,
  );
  const parsed = parseDeployPrebuiltCliArguments(valid);
  parsed.receiptPath = parsed.providerObservationPath;
  await assert.rejects(
    resolveDeployPrebuiltCliPaths(parsed),
    /paths must be distinct/,
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "prebuilt-cli-test-"));
  try {
    const existingReceipt = path.join(root, "receipt.json");
    await writeFile(existingReceipt, "already exists", "utf8");
    const existing = await resolveDeployPrebuiltCliPaths({
      ...parsed,
      packageRoot: path.join(root, "package"),
      providerObservationPath: path.join(root, "observation.json"),
      receiptPath: existingReceipt,
    });
    assert.equal(existing.receiptPath, existingReceipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
