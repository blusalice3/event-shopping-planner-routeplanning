import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJsonBytes,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { computeRoleEntryGraphHash } from "../lib/artifact-contract.mjs";
import { OUTER_AGENT_ENTRY_MODULE } from "../lib/outer-agent-contract.mjs";
import {
  computeVariantId,
  projectContainmentDimensions,
} from "../lib/release-policy.mjs";
import {
  ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
  ARTIFACT_ARCHIVE_MEDIA_TYPE,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  materializeArtifactRecoveryPackage,
  planArtifactRecovery,
} from "./archiveRecovery.mjs";
import {
  parseArchiveRecoveryArguments,
  runArchiveRecoveryCli,
} from "./plan-archive-recovery.mjs";

const namespace = "archive-recovery-test";
const committedAt = "2026-08-09T00:00:00.000Z";
const sourceSha = "a".repeat(40);

const readReleasePolicy = async () =>
  JSON.parse(
    await readFile(path.resolve("config", "release-variants.json"), "utf8"),
  );

const createMaterializationFixture = async () => {
  const evidence = new Map();
  const put = (bytes, mediaType = "application/json") => {
    const objectBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(objectBytes);
    evidence.set(sha256, { bytes: objectBytes, mediaType, committedAt });
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
    };
  };
  const releasePolicy = await readReleasePolicy();
  const standardDimensions = { ...releasePolicy.targetStandard };
  const containmentDimensions = projectContainmentDimensions(
    releasePolicy,
    standardDimensions,
  );
  const outputBytes = Buffer.from("recovered prebuilt output");
  const outputHash = sha256Bytes(outputBytes);
  const policyHashes = {
    toolchainPolicyHash: "1".repeat(64),
    providerConfigurationHash: "2".repeat(64),
    providerPolicyHash: "3".repeat(64),
    releasePolicyHash: sha256Json(releasePolicy),
  };
  const requiredDbCompatibility = {
    contractUri: "urn:test:db:recovery",
    fingerprint: "4".repeat(64),
  };
  const buildAuthority = put(
    canonicalJsonBytes({
      schemaVersion: 1,
      requirementsKind: "artifact-build-requirements/v1",
      operationId: "materialize-p8-recovery",
      targetGate: "P8-CLEAN",
    }),
  );
  const artifacts = [];
  const artifactObjects = new Map();
  for (const [releaseRole, dimensions, entryModule] of [
    ["standard", standardDimensions, OUTER_AGENT_ENTRY_MODULE],
    ["containment", containmentDimensions, OUTER_AGENT_ENTRY_MODULE],
  ]) {
    const variantId = computeVariantId(releasePolicy, dimensions);
    const entryFile = "/assets/release-role.js";
    const roleEntryGraph = {
      schemaVersion: 1,
      graphKind: "rollup-role-entry-v1",
      sourceSha,
      releaseRole,
      variantId,
      entryModule,
      entryFile,
      modules: [
        {
          id: entryModule,
          external: false,
          staticImports: [],
          dynamicImports: [],
        },
      ],
      chunks: [
        {
          file: entryFile,
          sha256: outputHash,
          size: outputBytes.length,
          staticImports: [],
          dynamicImports: [],
          modules: [entryModule],
        },
      ],
    };
    const manifest = {
      schemaVersion: 1,
      sourceSha,
      buildId: sourceSha,
      variantId,
      releaseRole,
      dimensions,
      buildAuthority,
      targetGate: "P8-CLEAN",
      buildPurpose: "production",
      promotable: true,
      buildInputClosureHash: "5".repeat(64),
      lockfileSha256: "6".repeat(64),
      ...policyHashes,
      publicBuildEnvHash: "7".repeat(64),
      requiredDbCompatibility,
      publicIdentityKind: "release-identity-v1",
      bootstrap: null,
      publicResponseHashes: { [entryFile]: outputHash },
      roleEntryGraph,
      roleEntryGraphHash: computeRoleEntryGraphHash(roleEntryGraph),
      outputFiles: [
        {
          path: `static/assets/${releaseRole}.js`,
          sha256: outputHash,
          size: outputBytes.length,
        },
      ],
    };
    const manifestBytes = canonicalJsonBytes(manifest);
    const archiveBytes = Buffer.from(`archive:${releaseRole}`);
    const manifestSha256 = sha256Bytes(manifestBytes);
    const archiveSha256 = sha256Bytes(archiveBytes);
    artifactObjects.set(releaseRole, { manifestBytes, archiveBytes });
    artifacts.push({
      releaseRole,
      variantId,
      manifest: {
        uri: `artifact://sha256/${manifestSha256}/artifact-manifest.json`,
        sha256: manifestSha256,
      },
      archive: {
        uri: `artifact://sha256/${archiveSha256}/artifact.zip`,
        sha256: archiveSha256,
      },
    });
  }
  const index = {
    schemaVersion: 1,
    packageKind: "source-hardened-pair",
    sourceSha,
    buildId: sourceSha,
    buildAuthority,
    targetGate: "P8-CLEAN",
    buildPurpose: "production",
    promotable: true,
    ...policyHashes,
    requiredDbCompatibility,
    artifacts,
  };
  const indexBytes = canonicalJsonBytes(index);
  const packageIndex = put(indexBytes);
  const policyReference = put(Buffer.from("policy"));
  const bindings = [];
  for (const reference of artifacts) {
    const objects = artifactObjects.get(reference.releaseRole);
    const artifactManifest = put(objects.manifestBytes);
    const artifactArchive = put(
      objects.archiveBytes,
      ARTIFACT_ARCHIVE_MEDIA_TYPE,
    );
    const partial = {
      bindingId: `deployment-binding:materialize-${reference.releaseRole}`,
      sourceSha,
      buildId: sourceSha,
      variantId: reference.variantId,
      releaseRole: reference.releaseRole,
      publicIdentityKind: "release-identity-v1",
      providerProjectId: "project-test",
      providerDeploymentId: `deployment-${reference.releaseRole}`,
      deploymentUrl: `https://deployment-${reference.releaseRole}.example.test`,
      artifactArchive,
      packageIndex,
      artifactManifest,
      providerEvidence: policyReference,
      releasePolicy: policyReference,
      providerPolicy: policyReference,
      providerConfigurationHash: policyHashes.providerConfigurationHash,
      requiredDbCompatibility,
    };
    const availabilityBytes = canonicalJsonBytes({
      schemaVersion: 1,
      evidenceKind: "artifact-archive-availability/v1",
      availability: "available",
      namespace,
      bindingId: partial.bindingId,
      sourceSha,
      variantId: reference.variantId,
      releaseRole: reference.releaseRole,
      artifactManifest,
      artifactArchive: {
        ...artifactArchive,
        mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
        byteLength: objects.archiveBytes.length,
        committedAt,
      },
    });
    bindings.push({
      ...partial,
      artifactArchiveAvailability: put(
        availabilityBytes,
        ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
      ),
    });
  }
  const store = {
    namespace,
    async readEvidence({ sha256 }) {
      const object = evidence.get(sha256);
      return object ? { ...object, bytes: Buffer.from(object.bytes) } : null;
    },
  };
  return { evidence, store, releasePolicy, bindings, index, indexBytes };
};

const createFixture = ({
  releaseRole = "standard",
  bindingId = `deployment-binding:${releaseRole}`,
} = {}) => {
  const evidence = new Map();
  const put = (bytes, mediaType) => {
    const objectBytes = Buffer.from(bytes);
    const sha256 = sha256Bytes(objectBytes);
    evidence.set(sha256, { bytes: objectBytes, mediaType, committedAt });
    return {
      uri: `release-state://${namespace}/evidence/${sha256}`,
      sha256,
    };
  };
  const archiveBytes = Buffer.from("rollback archive bytes");
  const artifactArchive = put(archiveBytes, ARTIFACT_ARCHIVE_MEDIA_TYPE);
  const artifactManifest = put(Buffer.from("manifest"), "application/json");
  const object = (value) => put(Buffer.from(value), "application/json");
  const partialBinding = {
    bindingId,
    sourceSha,
    buildId: sourceSha,
    variantId: "b".repeat(64),
    releaseRole,
    publicIdentityKind: "release-identity-v1",
    providerProjectId: "project-test",
    providerDeploymentId: "deployment-test",
    deploymentUrl: "https://deployment-test.example.test",
    artifactArchive,
    packageIndex: object("index"),
    artifactManifest,
    providerEvidence: object("provider"),
    releasePolicy: object("release"),
    providerPolicy: object("provider-policy"),
    providerConfigurationHash: "c".repeat(64),
    requiredDbCompatibility: {
      contractUri: "urn:test:db:v1",
      fingerprint: "d".repeat(64),
    },
  };
  const availabilityBytes = canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "artifact-archive-availability/v1",
    availability: "available",
    namespace,
    bindingId: partialBinding.bindingId,
    sourceSha,
    variantId: partialBinding.variantId,
    releaseRole,
    artifactManifest,
    artifactArchive: {
      ...artifactArchive,
      mediaType: ARTIFACT_ARCHIVE_MEDIA_TYPE,
      byteLength: archiveBytes.length,
      committedAt,
    },
  });
  const binding = {
    ...partialBinding,
    artifactArchiveAvailability: put(
      availabilityBytes,
      ARTIFACT_ARCHIVE_AVAILABILITY_MEDIA_TYPE,
    ),
  };
  const store = {
    namespace,
    closed: false,
    async readEvidence({ sha256 }) {
      const value = evidence.get(sha256);
      return value ? { ...value, bytes: Buffer.from(value.bytes) } : null;
    },
    async close() {
      this.closed = true;
    },
  };
  const current = {
    head: { sequence: 7, eventHash: "e".repeat(64) },
    snapshot: {
      activeProduction: null,
      acceptedStandard: null,
      containmentCompanion: releaseRole === "containment" ? binding : null,
      bootstrapRecovery: null,
      standardRecovery: null,
      pendingOperation: null,
      rollbackInventory:
        releaseRole === "standard"
          ? [
              {
                binding,
                eligibleActions: ["package-redeploy", "rollback"],
                eligibility: "eligible",
              },
            ]
          : [],
    },
  };
  return { binding, current, evidence, store };
};

test("plans rollback and package redeploy only after live archive verification", async () => {
  for (const action of ["rollback", "redeploy-standard"]) {
    const fixture = createFixture();
    const result = await planArtifactRecovery(
      {
        store: fixture.store,
        namespace,
        action,
        bindingId: fixture.binding.bindingId,
        expectedSourceSha: sourceSha,
      },
      { readCurrent: async () => fixture.current },
    );
    assert.equal(result.status, "ready");
    assert.equal(result.executionMode, "dry-run");
    assert.equal(
      result.artifactArchive.sha256,
      fixture.binding.artifactArchive.sha256,
    );
    assert.equal(
      result.providerExecutionContract.deploymentReceiptProduced,
      false,
    );
  }
});

test("plans containment activation and redeploy from a verified companion archive", async () => {
  for (const action of ["activate-containment", "redeploy-containment"]) {
    const fixture = createFixture({ releaseRole: "containment" });
    const result = await planArtifactRecovery(
      {
        store: fixture.store,
        namespace,
        action,
        bindingId: fixture.binding.bindingId,
        expectedSourceSha: sourceSha,
      },
      { readCurrent: async () => fixture.current },
    );
    assert.equal(result.action, action);
    assert.equal(result.binding.releaseRole, "containment");
    assert.equal(result.status, "ready");
  }
});

test("plans redeploy of the currently accepted standard before it enters rollback inventory", async () => {
  const fixture = createFixture();
  fixture.current.snapshot.rollbackInventory = [];
  fixture.current.snapshot.acceptedStandard = fixture.binding;
  const result = await planArtifactRecovery(
    {
      store: fixture.store,
      namespace,
      action: "redeploy-standard",
      bindingId: fixture.binding.bindingId,
      expectedSourceSha: sourceSha,
    },
    { readCurrent: async () => fixture.current },
  );
  assert.equal(result.status, "ready");
  assert.equal(result.binding.bindingId, fixture.binding.bindingId);
});

test("planner fails closed for unavailable bytes, wrong source, and wrong binding", async () => {
  const unavailable = createFixture();
  unavailable.evidence.delete(unavailable.binding.artifactArchive.sha256);
  await assert.rejects(
    planArtifactRecovery(
      {
        store: unavailable.store,
        namespace,
        action: "rollback",
        bindingId: unavailable.binding.bindingId,
        expectedSourceSha: sourceSha,
      },
      { readCurrent: async () => unavailable.current },
    ),
    /absent from the durable store/,
  );

  const wrong = createFixture();
  await assert.rejects(
    planArtifactRecovery(
      {
        store: wrong.store,
        namespace,
        action: "rollback",
        bindingId: wrong.binding.bindingId,
        expectedSourceSha: "f".repeat(40),
      },
      { readCurrent: async () => wrong.current },
    ),
    /differs from the requested source/,
  );
  await assert.rejects(
    planArtifactRecovery(
      {
        store: wrong.store,
        namespace,
        action: "rollback",
        bindingId: "deployment-binding:unknown",
        expectedSourceSha: sourceSha,
      },
      { readCurrent: async () => wrong.current },
    ),
    /not eligible/,
  );
});

test("strict recovery CLI writes only a dry-run plan and closes the store", async () => {
  const fixture = createFixture();
  const argv = [
    "--namespace",
    namespace,
    "--action",
    "rollback",
    "--binding-id",
    fixture.binding.bindingId,
    "--source-sha",
    sourceSha,
    "--output",
    "recovery-plan.json",
  ];
  assert.equal(parseArchiveRecoveryArguments(argv)["--action"], "rollback");
  const badAction = [...argv];
  badAction[badAction.indexOf("--action") + 1] = "unknown-action";
  assert.throws(
    () => parseArchiveRecoveryArguments(badAction),
    /arguments are invalid/,
  );
  assert.throws(
    () => parseArchiveRecoveryArguments([...argv, "--unknown", "value"]),
    /requires five strict flags/,
  );
  let written = null;
  const result = await runArchiveRecoveryCli(
    {
      argv,
      environment: {
        RELEASE_STATE_NAMESPACE: namespace,
        RELEASE_STATE_DATABASE_URL: "postgresql://release:test@db.example/test",
        RELEASE_STATE_DATABASE_CA_PEM: "test-ca",
      },
      cwd: "C:\\workspace",
      stdout: { write() {} },
    },
    {
      loadJson: async () => ({
        databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
      }),
      createStore: async () => fixture.store,
      planner: async (options) =>
        planArtifactRecovery(options, {
          readCurrent: async () => fixture.current,
        }),
      writeOutput: async (outputPath, bytes) => {
        written = { outputPath, bytes };
      },
    },
  );
  assert.equal(result.executionMode, "dry-run");
  assert.equal(fixture.store.closed, true);
  assert.match(written.outputPath, /recovery-plan\.json$/);
  assert.equal(JSON.parse(written.bytes).status, "ready");
});

test("materializes an exact source-hardened package from durable archive objects", async () => {
  const fixture = await createMaterializationFixture();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "archive-recovery-"),
  );
  try {
    const packageRoot = path.join(temporaryRoot, "package");
    const result = await materializeArtifactRecoveryPackage({
      store: fixture.store,
      namespace,
      bindings: fixture.bindings,
      packageRoot,
      releasePolicy: fixture.releasePolicy,
    });
    assert.equal(result.packageIndexSha256, sha256Bytes(fixture.indexBytes));
    assert.deepEqual(
      await readFile(path.join(packageRoot, "release-package-index.json")),
      fixture.indexBytes,
    );
    for (const artifact of fixture.index.artifacts) {
      for (const [reference, kind] of [
        [artifact.manifest, "artifact-manifest.json"],
        [artifact.archive, "artifact.zip"],
      ]) {
        assert.equal(
          sha256Bytes(
            await readFile(
              path.join(
                packageRoot,
                "objects",
                "sha256",
                `${reference.sha256}.${kind}`,
              ),
            ),
          ),
          reference.sha256,
        );
      }
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("materialization fails closed for missing pair, tamper, and wrong URI kind", async () => {
  const fixture = await createMaterializationFixture();
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "archive-recovery-"),
  );
  try {
    await assert.rejects(
      materializeArtifactRecoveryPackage({
        store: fixture.store,
        namespace,
        bindings: fixture.bindings.slice(0, 1),
        packageRoot: path.join(temporaryRoot, "missing-pair"),
        releasePolicy: fixture.releasePolicy,
      }),
      /binding set is incomplete/,
    );

    const [standard] = fixture.bindings;
    fixture.evidence.set(standard.artifactManifest.sha256, {
      bytes: Buffer.from("tampered"),
      mediaType: "application/json",
      committedAt,
    });
    await assert.rejects(
      materializeArtifactRecoveryPackage({
        store: fixture.store,
        namespace,
        bindings: fixture.bindings,
        packageRoot: path.join(temporaryRoot, "tampered"),
        releasePolicy: fixture.releasePolicy,
      }),
      /content hash|SHA-256|differs|immutable verification/i,
    );

    const wrongKind = await createMaterializationFixture();
    wrongKind.index.artifacts[0].archive.uri = `artifact://sha256/${wrongKind.index.artifacts[0].archive.sha256}/artifact-manifest.json`;
    const wrongIndexBytes = canonicalJsonBytes(wrongKind.index);
    const wrongIndexHash = sha256Bytes(wrongIndexBytes);
    wrongKind.evidence.set(wrongIndexHash, {
      bytes: wrongIndexBytes,
      mediaType: "application/json",
      committedAt,
    });
    for (const binding of wrongKind.bindings) {
      binding.packageIndex = {
        uri: `release-state://${namespace}/evidence/${wrongIndexHash}`,
        sha256: wrongIndexHash,
      };
    }
    await assert.rejects(
      materializeArtifactRecoveryPackage({
        store: wrongKind.store,
        namespace,
        bindings: wrongKind.bindings,
        packageRoot: path.join(temporaryRoot, "wrong-kind"),
        releasePolicy: wrongKind.releasePolicy,
      }),
      /kind .* differs/i,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
