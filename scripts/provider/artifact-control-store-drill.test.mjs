import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE,
  assertArtifactControlStoreDrillRaw,
  collectAndStoreArtifactControlStoreDrill,
  deriveArtifactDrillNamespace,
  putArtifactControlStoreDrill,
  readArtifactDrillOperationReceipts,
  readStoredArtifactControlStoreDrill,
  summarizeArtifactControlStoreDrill,
} from "./artifact-control-store-drill.mjs";
import {
  parseArtifactControlStoreDrillArguments,
  runArtifactControlStoreDrillCli,
  writeArtifactControlStoreDrillOutput,
} from "./collect-artifact-control-store-drill.mjs";
import { ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE } from "./artifact-control-store-drill-postgres.mjs";
import {
  ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE,
} from "./artifact-control-store-drill-receipts.mjs";
import {
  buildArtifactControlStoreDrillClosure,
  captureArtifactControlStoreDrillClosureObjects,
  readArtifactControlStoreDrillClosure,
} from "./artifact-control-store-drill-closure.mjs";
import { VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE } from "./collect-vercel-observation.mjs";

const productionNamespace = "production-release";
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const runId = "12345";
const runAttempt = "1";
const drillNamespace = deriveArtifactDrillNamespace({
  productionNamespace,
  sourceSha,
  runId,
  runAttempt,
});
const hash = (character) => character.repeat(64);
const collectorIdentity = {
  repository: "owner/repository",
  workflowPath: ".github/workflows/release.yml",
  sourceSha,
  runId,
  runAttempt,
};
const receiptAuthority = {
  collectorIdentity,
  databaseEndpointSha256: hash("7"),
  databasePolicySha256: hash("6"),
  drillNamespace,
  providerPolicySha256: hash("5"),
  sourceSha,
  toolchainSha256: hash("4"),
};
const providerPolicy = {
  provider: "vercel",
  bindingStatus: "configured",
  expectedProjectId: "project-id",
  expectedTeamId: "team-id",
  ownedProductionDomains: ["app.example.test", "www.example.test"],
};
const artifactDrillPolicy = {
  providerPreviewAliasSuffix: "preview.example.invalid",
};
const roleProjection = (roleSha256, label, { direct = false } = {}) => ({
  canLogin: true,
  createDatabase: false,
  createRole: false,
  memberOfAnyRole: false,
  replication: false,
  roleSha256,
  rowSecurityBypass: false,
  superuser: false,
  ...(direct
    ? {
        directDenials: ["direct-table-insert", "schema-ddl-create"].map(
          (operation) => ({
            schemaVersion: 1,
            kind: "artifact-drill-postgres-error/v1",
            operation: `${label}-${operation}`,
            roleSha256,
            sqlstate: "42501",
          }),
        ),
        privileges: {
          directEvidenceWrite: false,
          functionExecute: true,
          schemaCreate: false,
          schemaUsage: true,
          selectEvidence: true,
        },
      }
    : {}),
});
const controlStoreReceipt = {
  schemaVersion: 1,
  kind: "artifact-drill-control-store-receipt/v1",
  namespace: drillNamespace,
  databaseEndpointSha256: hash("7"),
  administratorRoleSha256: hash("a"),
  executorRoleSha256: hash("b"),
  productionReaderRoleSha256: hash("c"),
  roleAuthority: {
    administrator: roleProjection(hash("a"), "administrator"),
    executor: roleProjection(hash("b"), "executor", { direct: true }),
    productionReader: roleProjection(hash("c"), "production-reader", {
      direct: true,
    }),
  },
  immutableEvidence: {
    committedAt: "2026-08-09T00:00:00.000Z",
    mediaType:
      "application/vnd.event-shopping-planner.artifact-drill-put-readback+json;version=1",
    objectSha256: hash("d"),
    putReadbackVerified: true,
  },
  idempotency: {
    appendEventHash: hash("e"),
    appendReplayObserved: true,
    evidenceReplayObserved: true,
  },
  casConflict: {
    schemaVersion: 1,
    kind: "artifact-drill-postgres-error/v1",
    operation: "compare-and-append-stale-head",
    roleSha256: hash("b"),
    sqlstate: "40001",
  },
  credentialDenial: {
    schemaVersion: 1,
    kind: "artifact-drill-postgres-error/v1",
    operation: "production-reader-put-evidence",
    roleSha256: hash("c"),
    sqlstate: "42501",
  },
};
const bootstrapVerification = {
  sourceSha,
  packageIndexSha256: hash("1"),
  artifactManifestSha256: hash("2"),
  artifactArchiveSha256: hash("3"),
  rawDistManifestSha256: hash("4"),
  rawDistTreeSha256: hash("5"),
  rawDistFileCount: 3,
  preserved: true,
  releaseIdentityAbsent: true,
};
const providerProjection = (role, suffix = "") => ({
  date: "Sun, 09 Aug 2026 00:00:00 GMT",
  deploymentTarget: null,
  etag: `"${role}${suffix}"`,
  projectId: providerPolicy.expectedProjectId,
  readyState: "READY",
  requestUrl: `https://api.vercel.com/v13/deployments/${role}-${drillNamespace}${suffix}.vercel.app?teamId=team-id`,
  responseSha256: hash(role === "containment" ? "6" : suffix ? "8" : "7"),
  status: 200,
  teamId: providerPolicy.expectedTeamId,
});
const buildAuthorityReceipt = () => {
  const document = {
    schemaVersion: 1,
    authorityKind: "artifact-drill-build-authority/v1",
    sourceSha,
    targetGate: "P0-ARTIFACT",
    buildPurpose: "non-promotable-artifact-drill",
    promotable: false,
    releasePolicySha256: hash("a"),
    toolchainPolicySha256: receiptAuthority.toolchainSha256,
    providerPolicySha256: receiptAuthority.providerPolicySha256,
    providerObservationSha256: hash("b"),
    providerConfigurationHash: hash("c"),
    cspPolicySha256: hash("d"),
    dbCompatibility: {
      contractUri: "urn:fixture:db-contract",
      fingerprint: hash("e"),
    },
    foundationBaselineSha256: hash("f"),
    standardDimensions: { releaseRole: "standard" },
    containmentDimensions: { releaseRole: "containment" },
    bootstrapVerification,
  };
  const sha256 = sha256Bytes(canonicalJsonBytes(document));
  return {
    document,
    reference: {
      uri: `artifact://sha256/${sha256}/artifact-drill-build-authority.json`,
      sha256,
    },
  };
};
const operationReceiptValue = (name) => {
  if (name === "control-store") return controlStoreReceipt;
  if (name.startsWith("build-")) {
    const attempt = Number(name.at(-1));
    return {
      schemaVersion: 1,
      kind: "artifact-drill-build-receipt/v1",
      attempt,
      authority: receiptAuthority,
      buildPurpose: "non-promotable-artifact-drill",
      buildAuthority: buildAuthorityReceipt(),
      packageArchiveSha256: hash("3"),
      packageIndexSha256: hash("4"),
      bootstrapVerification,
      roles: roles(),
    };
  }
  if (name === "archive-verification") {
    return {
      schemaVersion: 1,
      kind: "artifact-drill-archive-receipt/v1",
      authority: receiptAuthority,
      bootstrapVerification,
      capabilityVerified: true,
      dbBindingVerified: true,
      extractedManifestSha256: hash("5"),
      manifestVerified: true,
      policyBindingVerified: true,
    };
  }
  if (name.startsWith("deployment-")) {
    const role = name === "deployment-1" ? "containment" : "standard";
    const path = role === "containment" ? "/" : "/release-identity.json";
    return {
      schemaVersion: 1,
      kind: "artifact-drill-preview-deployment-receipt/v1",
      authority: receiptAuthority,
      deploymentId: `preview-${role}`,
      previewUrl: `https://${role}-${drillNamespace}.vercel.app/`,
      packageArchiveSha256: roles().find((item) => item.role === role)
        .archiveSha256,
      manifestSha256: roles().find((item) => item.role === role).manifestSha256,
      provider: providerProjection(role),
      role,
      routeProbes: [{ path, responseSha256: hash("a"), status: 200 }],
      target: "preview",
    };
  }
  if (name === "provider-observation") {
    return {
      schemaVersion: 1,
      kind: "artifact-drill-provider-observation/v1",
      authority: receiptAuthority,
      projectId: providerPolicy.expectedProjectId,
      teamId: providerPolicy.expectedTeamId,
      deployments: ["containment", "standard"].map((role) => ({
        deploymentId: `preview-${role}`,
        previewUrl: `https://${role}-${drillNamespace}.vercel.app/`,
        responseSha256: providerProjection(role).responseSha256,
        role,
      })),
    };
  }
  if (name.startsWith("assignment-")) {
    const role = name === "assignment-1" ? "standard" : "containment";
    const domain = `${drillNamespace}.${role}.preview.example.invalid`;
    return {
      schemaVersion: 1,
      kind: "artifact-drill-preview-assignment-receipt/v1",
      authority: receiptAuthority,
      deploymentId: `preview-${role}`,
      domain,
      provider: {
        commandRequestUrl: `https://api.vercel.com/v2/deployments/preview-${role}/aliases?teamId=team-id`,
        commandResponseSha256: hash("b"),
        date: "Sun, 09 Aug 2026 00:00:00 GMT",
        etag: `"assignment-${role}"`,
        observedDeploymentId: `preview-${role}`,
        observedProjectId: providerPolicy.expectedProjectId,
        requestUrl: `https://api.vercel.com/v4/aliases/${domain}?teamId=team-id`,
        responseSha256: hash(role === "standard" ? "c" : "d"),
        status: 200,
      },
    };
  }
  if (name === "redeploy") {
    const redeployHost = `redeploy-${drillNamespace.slice(0, 32)}.vercel.app`;
    const redeployProvider = providerProjection("standard", "-redeploy");
    redeployProvider.requestUrl = `https://api.vercel.com/v13/deployments/${redeployHost}?teamId=team-id`;
    return {
      schemaVersion: 1,
      kind: "artifact-drill-preview-redeploy-receipt/v1",
      authority: receiptAuthority,
      firstDeploymentId: "preview-standard",
      redeployedDeploymentId: "preview-standard-redeploy",
      previewUrl: `https://${redeployHost}/`,
      packageArchiveSha256: roles()[1].archiveSha256,
      manifestSha256: roles()[1].manifestSha256,
      provider: redeployProvider,
      routeProbes: [
        {
          path: "/release-identity.json",
          responseSha256: hash("e"),
          status: 200,
        },
      ],
    };
  }
  if (name === "reconcile") {
    return {
      schemaVersion: 1,
      kind: "artifact-drill-preview-reconcile-receipt/v1",
      authority: receiptAuthority,
      assignments: ["containment", "standard"].map((role) => ({
        deploymentId: `preview-${role}`,
        domain: `${drillNamespace}.${role}.preview.example.invalid`,
        responseSha256: hash(role === "containment" ? "d" : "c"),
      })),
    };
  }
  if (name === "provider-cleanup") {
    const request = (method, requestUrl, status, character) => ({
      method,
      requestUrl,
      responseSha256: hash(character),
      status,
    });
    const aliases = ["containment", "standard"].map((role, index) => {
      const domain = `${drillNamespace}.${role}.preview.example.invalid`;
      const lookupUrl = `https://api.vercel.com/v4/aliases/${domain}?teamId=team-id`;
      return {
        domain,
        deploymentId: `preview-${role}`,
        preDelete: request("GET", lookupUrl, 200, index === 0 ? "1" : "2"),
        deletion: request(
          "DELETE",
          `https://api.vercel.com/v2/aliases/${domain}?teamId=team-id`,
          200,
          index === 0 ? "3" : "4",
        ),
        readback: request("GET", lookupUrl, 404, index === 0 ? "5" : "6"),
      };
    });
    const deployments = [
      {
        deploymentId: "preview-containment",
        previewUrl: `https://containment-${drillNamespace}.vercel.app/`,
      },
      {
        deploymentId: "preview-standard",
        previewUrl: `https://standard-${drillNamespace}.vercel.app/`,
      },
      {
        deploymentId: "preview-standard-redeploy",
        previewUrl: `https://redeploy-${drillNamespace.slice(0, 32)}.vercel.app/`,
      },
    ].map((deployment, index) => {
      const hostname = new URL(deployment.previewUrl).hostname;
      const preDeleteUrl = `https://api.vercel.com/v13/deployments/${hostname}?teamId=team-id`;
      const deleteUrl = `https://api.vercel.com/v13/deployments/${deployment.deploymentId}?teamId=team-id`;
      return {
        ...deployment,
        preDelete: request("GET", preDeleteUrl, 200, `${index + 7}`),
        deletion: request("DELETE", deleteUrl, 200, `${index + 1}`),
        readback: request("GET", deleteUrl, 404, `${index + 4}`),
      };
    });
    return {
      schemaVersion: 1,
      kind: "artifact-drill-provider-cleanup-receipt/v1",
      authority: receiptAuthority,
      projectId: providerPolicy.expectedProjectId,
      teamId: providerPolicy.expectedTeamId,
      aliases,
      deployments,
    };
  }
  throw new Error(`Unknown fixture receipt: ${name}`);
};
const receiptBytes = (name) => canonicalJsonBytes(operationReceiptValue(name));
const receiptHash = (name) => sha256Bytes(receiptBytes(name));
const oidcReceipt = {
  uri: `release-state://${drillNamespace}/evidence/${hash("8")}`,
  sha256: hash("8"),
};
const forbiddenAliases = ["app.example.test", "www.example.test"];
const productionProviderObservationDocument = {
  schemaVersion: 1,
  evidenceKind: "test-vercel-provider-observation/v1",
};
const productionProviderObservationBytes = canonicalJsonBytes(
  productionProviderObservationDocument,
);
const productionProviderObservationSha256 = sha256Bytes(
  productionProviderObservationBytes,
);
const productionProviderObservation = {
  uri:
    `release-state://${drillNamespace}/evidence/` +
    productionProviderObservationSha256,
  sha256: productionProviderObservationSha256,
  mediaType: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  byteLength: productionProviderObservationBytes.length,
  committedAt: "2026-08-09T00:00:00.500Z",
};

const roles = () =>
  ["containment", "standard"].map((role, index) => ({
    role,
    archiveSha256: hash(index === 0 ? "a" : "b"),
    capabilitySha256: hash(index === 0 ? "c" : "d"),
    dbFingerprint: hash("e"),
    manifestSha256: hash(index === 0 ? "f" : "1"),
    policySha256: hash("2"),
  }));

const operations = () => ({
  toolchain: { node: "24.19.0", npm: "11.19.0" },
  builds: [1, 2].map((attempt) => ({
    attempt,
    packageArchiveSha256: hash("3"),
    packageIndexSha256: hash("4"),
    receiptSha256: receiptHash(`build-${attempt}`),
    roles: roles(),
  })),
  archiveVerification: {
    capabilityVerified: true,
    dbBindingVerified: true,
    extractedManifestSha256: hash("5"),
    manifestVerified: true,
    policyBindingVerified: true,
    receiptSha256: receiptHash("archive-verification"),
  },
  deployments: ["containment", "standard"].map((role, index) => ({
    deploymentId: `preview-${role}`,
    previewUrl: `https://${role}-${drillNamespace}.vercel.app/`,
    receiptSha256: receiptHash(`deployment-${index + 1}`),
    role,
    target: "preview",
  })),
  providerObservationSha256: receiptHash("provider-observation"),
  routeProbes: [
    { deploymentId: "preview-containment", path: "/", status: 200 },
    {
      deploymentId: "preview-standard",
      path: "/release-identity.json",
      status: 200,
    },
  ],
  controlStore: {
    casConflictDenied: true,
    credentialDenialVerified: true,
    idempotencyVerified: true,
    putReadbackVerified: true,
    receiptSha256: receiptHash("control-store"),
  },
  assignments: [
    {
      deploymentId: "preview-standard",
      domain: `${drillNamespace}.standard.preview.example.invalid`,
      receiptSha256: receiptHash("assignment-1"),
      verified: true,
    },
    {
      deploymentId: "preview-containment",
      domain: `${drillNamespace}.containment.preview.example.invalid`,
      receiptSha256: receiptHash("assignment-2"),
      verified: true,
    },
  ],
  redeploy: { receiptSha256: receiptHash("redeploy"), verified: true },
  reconcile: { receiptSha256: receiptHash("reconcile"), verified: true },
  providerCleanup: {
    aliasCount: 2,
    deploymentCount: 3,
    receiptSha256: receiptHash("provider-cleanup"),
    verified: true,
  },
});

const raw = (overrides = {}) => ({
  schemaVersion: 1,
  kind: "artifact-provider-control-store-drill-raw/v1",
  productionNamespace,
  drillNamespace,
  sourceSha,
  startedAt: "2026-08-09T00:00:00.000Z",
  completedAt: "2026-08-09T00:00:01.000Z",
  authority: receiptAuthority,
  productionProviderObservation: { ...productionProviderObservation },
  ...operations(),
  ...overrides,
});

const memoryStore = ({ namespace = drillNamespace } = {}) => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const sha256 = sha256Bytes(bytes);
      const committedAt = "2026-08-09T00:00:02.000Z";
      objects.set(sha256, {
        bytes: Buffer.from(bytes),
        mediaType,
        committedAt,
      });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: bytes.length,
        committedAt,
      };
    },
    async readEvidence({ sha256 }) {
      return objects.get(sha256) ?? null;
    },
  };
};

const seedOperationReceipts = (store) => {
  store.objects.set(productionProviderObservationSha256, {
    bytes: productionProviderObservationBytes,
    mediaType: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
    committedAt: productionProviderObservation.committedAt,
  });
  for (const name of [
    "build-1",
    "build-2",
    "archive-verification",
    "deployment-1",
    "deployment-2",
    "provider-observation",
    "control-store",
    "assignment-1",
    "assignment-2",
    "redeploy",
    "reconcile",
    "provider-cleanup",
  ]) {
    const bytes = receiptBytes(name);
    store.objects.set(sha256Bytes(bytes), {
      bytes,
      mediaType: {
        "build-1": ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
        "build-2": ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
        "archive-verification": ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE,
        "deployment-1": ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
        "deployment-2": ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
        "provider-observation": ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE,
        "control-store": ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
        "assignment-1": ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE,
        "assignment-2": ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE,
        redeploy: ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE,
        reconcile: ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE,
        "provider-cleanup": ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
      }[name],
      committedAt: "2026-08-09T00:00:00.500Z",
    });
  }
  return store;
};

const authority = { productionNamespace, forbiddenAliases };

test("derives an uncallable disposable namespace from workflow authority", () => {
  assert.match(drillNamespace, /^artifact-drill-[0-9a-f]{32}$/u);
  assert.notEqual(drillNamespace, productionNamespace);
  assert.equal(
    deriveArtifactDrillNamespace({
      productionNamespace,
      sourceSha,
      runId,
      runAttempt,
    }),
    drillNamespace,
  );
});

test("validates and summarizes the complete artifact/provider/store drill", () => {
  const transcript = raw();
  assert.equal(
    assertArtifactControlStoreDrillRaw(transcript, authority),
    transcript,
  );
  const summary = summarizeArtifactControlStoreDrill(transcript, authority);
  assert.equal(
    summary.generatedArchiveSha256,
    summary.regeneratedArchiveSha256,
  );
  assert.equal(summary.routeProbeCount, 2);
  assert.equal(summary.outcome, "succeeded");
});

test("provider cleanup raw responses and created-resource set are rederived", async () => {
  const unsafeReadback = operationReceiptValue("provider-cleanup");
  unsafeReadback.aliases[0].readback.status = 200;
  const unsafeBytes = canonicalJsonBytes(unsafeReadback);
  const unsafeSha256 = sha256Bytes(unsafeBytes);
  const unsafeStore = seedOperationReceipts(memoryStore());
  unsafeStore.objects.set(unsafeSha256, {
    bytes: unsafeBytes,
    mediaType: ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
    committedAt: "2026-08-09T00:00:00.500Z",
  });
  const unsafeRaw = raw();
  unsafeRaw.providerCleanup.receiptSha256 = unsafeSha256;
  await assert.rejects(
    readArtifactDrillOperationReceipts({
      store: unsafeStore,
      operations: unsafeRaw,
      aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
      forbiddenAliases,
      providerPolicy,
    }),
    /cleanup readback semantics are invalid/,
  );

  const foreignResource = operationReceiptValue("provider-cleanup");
  const replaced = foreignResource.deployments.at(-1);
  replaced.deploymentId = "foreign-preview";
  replaced.deletion.requestUrl =
    "https://api.vercel.com/v13/deployments/foreign-preview?teamId=team-id";
  replaced.readback.requestUrl = replaced.deletion.requestUrl;
  foreignResource.deployments.sort((left, right) =>
    left.deploymentId.localeCompare(right.deploymentId),
  );
  const foreignBytes = canonicalJsonBytes(foreignResource);
  const foreignSha256 = sha256Bytes(foreignBytes);
  const foreignStore = seedOperationReceipts(memoryStore());
  foreignStore.objects.set(foreignSha256, {
    bytes: foreignBytes,
    mediaType: ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
    committedAt: "2026-08-09T00:00:00.500Z",
  });
  const foreignRaw = raw();
  foreignRaw.providerCleanup.receiptSha256 = foreignSha256;
  await assert.rejects(
    readArtifactDrillOperationReceipts({
      store: foreignStore,
      operations: foreignRaw,
      aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
      forbiddenAliases,
      providerPolicy,
    }),
    /cleanup differs from created resources/,
  );
});

test("rejects production namespaces and production alias attempts", () => {
  assert.throws(
    () =>
      assertArtifactControlStoreDrillRaw(
        raw({ drillNamespace: productionNamespace }),
        authority,
      ),
    /namespace safety differs/,
  );
  const aliasAttempt = raw();
  aliasAttempt.assignments[0].domain = forbiddenAliases[0];
  assert.throws(
    () => assertArtifactControlStoreDrillRaw(aliasAttempt, authority),
    /production or ambiguous alias/,
  );
  const productionPreview = raw();
  productionPreview.deployments[0].previewUrl = `https://${forbiddenAliases[0]}/`;
  assert.throws(
    () => assertArtifactControlStoreDrillRaw(productionPreview, authority),
    /preview deployment reached a production alias/,
  );
});

test("rejects archive, CAS, credential, route, redeploy, and reconcile failures", () => {
  const mutations = [
    [
      "archive",
      (value) => (value.builds[1].roles[0].archiveSha256 = hash("d")),
      /not reproducible/,
    ],
    [
      "CAS",
      (value) => (value.controlStore.casConflictDenied = false),
      /casConflictDenied failed/,
    ],
    [
      "credential",
      (value) => (value.controlStore.credentialDenialVerified = false),
      /credentialDenialVerified failed/,
    ],
    [
      "route",
      (value) => (value.routeProbes[0].status = 500),
      /route probe failed/,
    ],
    [
      "redeploy",
      (value) => (value.redeploy.verified = false),
      /redeploy failed/,
    ],
    [
      "reconcile",
      (value) => (value.reconcile.verified = false),
      /reconcile failed/,
    ],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const transcript = raw();
    mutate(transcript);
    assert.throws(
      () => assertArtifactControlStoreDrillRaw(transcript, authority),
      pattern,
      label,
    );
  }
});

test("rejects credential overreach and provider observation failure", () => {
  const overreach = raw();
  overreach.assignments.push({
    deploymentId: "preview-standard",
    domain: `${drillNamespace}.standard.preview.example.invalid`,
    receiptSha256: hash("f"),
    verified: true,
  });
  assert.throws(
    () => assertArtifactControlStoreDrillRaw(overreach, authority),
    /production or ambiguous alias/,
  );
  const providerFailure = raw();
  providerFailure.providerObservationSha256 = "invalid";
  assert.throws(
    () => assertArtifactControlStoreDrillRaw(providerFailure, authority),
    /provider observation is invalid/,
  );
});

test("stores, reads back, and rejects tamper/media/store mismatch", async () => {
  const store = memoryStore();
  const stored = await putArtifactControlStoreDrill({
    store,
    raw: raw(),
    authority,
  });
  const readback = await readStoredArtifactControlStoreDrill({
    store,
    reference: stored.reference,
    authority,
  });
  assert.equal(readback.result.rawSha256, stored.reference.sha256);
  store.objects.get(stored.reference.sha256).bytes = Buffer.from("{}", "utf8");
  await assert.rejects(
    readStoredArtifactControlStoreDrill({
      store,
      reference: stored.reference,
      authority,
    }),
    /differs/,
  );
  store.objects.get(stored.reference.sha256).bytes = stored.readback.bytes;
  store.objects.get(stored.reference.sha256).mediaType = "application/json";
  await assert.rejects(
    readStoredArtifactControlStoreDrill({
      store,
      reference: stored.reference,
      authority,
    }),
    /differs/,
  );
  await assert.rejects(
    putArtifactControlStoreDrill({
      store: memoryStore({ namespace: "other-drill" }),
      raw: raw(),
      authority,
    }),
    /store namespace differs/,
  );
  assert.throws(
    () =>
      assertArtifactControlStoreDrillRaw(
        { ...raw(), callerResult: true },
        authority,
      ),
    /unknown or missing fields/,
  );
});

test("collector requires trusted OIDC and never resolves production Release State", async () => {
  const clock = (() => {
    const values = [0, 1000];
    return () => values.shift();
  })();
  let previewOnly;
  const positiveStore = seedOperationReceipts(memoryStore());
  const observation = await collectAndStoreArtifactControlStoreDrill(
    {
      drillStore: positiveStore,
      productionNamespace,
      sourceSha,
      runId,
      runAttempt,
      oidcReceipt,
      oidcAuthority: {
        approvalPolicy: { repository: collectorIdentity.repository },
      },
      providerPolicy,
      artifactDrillPolicy,
      providerObservation: productionProviderObservationDocument,
      executionAuthority: {
        databaseEndpointSha256: receiptAuthority.databaseEndpointSha256,
        databasePolicySha256: receiptAuthority.databasePolicySha256,
        providerPolicySha256: receiptAuthority.providerPolicySha256,
        toolchainSha256: receiptAuthority.toolchainSha256,
      },
      executeOperations: async (options) => {
        previewOnly = options.previewOnly;
        assert.equal(options.drillNamespace, drillNamespace);
        assert.equal(Object.hasOwn(options, "current"), false);
        assert.equal(Object.hasOwn(options, "binding"), false);
        assert.deepEqual(options.authority, receiptAuthority);
        return operations();
      },
      now: clock,
    },
    {
      readOidcAuthority: async () => ({}),
      validateProviderObservation: () => {},
    },
  );
  assert.equal(previewOnly, true);
  assert.equal(observation.result.outcome, "succeeded");
  await assert.rejects(
    collectAndStoreArtifactControlStoreDrill(
      {
        drillStore: memoryStore(),
        productionNamespace,
        sourceSha,
        runId,
        runAttempt,
        oidcReceipt,
        oidcAuthority: {
          approvalPolicy: { repository: collectorIdentity.repository },
        },
        providerPolicy,
        artifactDrillPolicy,
        providerObservation: productionProviderObservationDocument,
        executionAuthority: {
          databaseEndpointSha256: receiptAuthority.databaseEndpointSha256,
          databasePolicySha256: receiptAuthority.databasePolicySha256,
          providerPolicySha256: receiptAuthority.providerPolicySha256,
          toolchainSha256: receiptAuthority.toolchainSha256,
        },
        executeOperations: async () => operations(),
      },
      {
        readOidcAuthority: async () => {
          throw new Error("untrusted OIDC");
        },
        validateProviderObservation: () => {},
      },
    ),
    /untrusted OIDC/,
  );

  const receiptTamperStore = seedOperationReceipts(memoryStore());
  receiptTamperStore.objects.get(receiptHash("control-store")).bytes =
    Buffer.from("tampered", "utf8");
  await assert.rejects(
    collectAndStoreArtifactControlStoreDrill(
      {
        drillStore: receiptTamperStore,
        productionNamespace,
        sourceSha,
        runId,
        runAttempt,
        oidcReceipt,
        oidcAuthority: {
          approvalPolicy: { repository: collectorIdentity.repository },
        },
        providerPolicy,
        artifactDrillPolicy,
        providerObservation: productionProviderObservationDocument,
        executionAuthority: {
          databaseEndpointSha256: receiptAuthority.databaseEndpointSha256,
          databasePolicySha256: receiptAuthority.databasePolicySha256,
          providerPolicySha256: receiptAuthority.providerPolicySha256,
          toolchainSha256: receiptAuthority.toolchainSha256,
        },
        executeOperations: async () => operations(),
        now: (() => {
          const values = [0, 1000];
          return () => values.shift();
        })(),
      },
      {
        readOidcAuthority: async () => ({}),
        validateProviderObservation: () => {},
      },
    ),
    /operation receipt readback differs/,
  );
});

test("CLI accepts only production namespace, source, and new output", () => {
  for (const flag of [
    "--drill-namespace",
    "--archive-sha256",
    "--cas-denied",
    "--result",
  ]) {
    assert.throws(
      () =>
        parseArtifactControlStoreDrillArguments([
          "--namespace",
          productionNamespace,
          "--source-sha",
          sourceSha,
          flag,
          "caller-value",
        ]),
      /invalid/,
    );
  }
});

test("default CLI reaches the closed binding gate before opening a database", async () => {
  let storeOpenCount = 0;
  await assert.rejects(
    runArtifactControlStoreDrillCli(
      {
        argv: [
          "--namespace",
          productionNamespace,
          "--source-sha",
          sourceSha,
          "--output",
          "unused.json",
        ],
      },
      {
        openDisposable: async () => {
          storeOpenCount += 1;
          throw new Error("database must not open");
        },
      },
    ),
    /not configured/,
  );
  assert.equal(storeOpenCount, 0);
});

test("uses a dedicated immutable transcript media type", () => {
  assert.match(
    ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE,
    /artifact-provider-control-store-drill/,
  );
});

test("captures a self-contained closure before disposable database cleanup", async () => {
  const store = seedOperationReceipts(memoryStore());
  const transcript = raw();
  const stored = await putArtifactControlStoreDrill({
    store,
    raw: transcript,
    authority,
  });
  const oidcBytes = canonicalJsonBytes({
    kind: "test-oidc/v1",
    runId,
    runAttempt,
    sourceSha,
  });
  const oidcSha256 = sha256Bytes(oidcBytes);
  store.objects.set(oidcSha256, {
    bytes: oidcBytes,
    mediaType:
      "application/vnd.event-shopping-planner.github-oidc-receipt+json;version=1",
    committedAt: "2026-08-09T00:00:00.500Z",
  });
  const observation = {
    schemaVersion: 1,
    kind: "artifact-provider-control-store-drill-observation/v1",
    collectorIdentity,
    productionNamespace,
    productionProviderObservation: { ...productionProviderObservation },
    drillNamespace,
    sourceSha,
    observedAt: transcript.completedAt,
    oidcReceipt: {
      uri: `release-state://${drillNamespace}/evidence/${oidcSha256}`,
      sha256: oidcSha256,
    },
    rawTranscript: stored.reference,
    result: stored.readback.result,
  };
  const capture = await captureArtifactControlStoreDrillClosureObjects({
    store,
    observation,
    authority: {
      ...authority,
      aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
      providerPolicy,
    },
  });
  const built = buildArtifactControlStoreDrillClosure({
    capture,
    runId,
    runAttempt,
    cleanup: {
      schemaVersion: 1,
      kind: "artifact-drill-database-cleanup-receipt/v1",
      administratorRoleSha256: controlStoreReceipt.administratorRoleSha256,
      databaseEndpointSha256: receiptAuthority.databaseEndpointSha256,
      namespace: drillNamespace,
      observedAt: "2026-08-09T00:00:03.000Z",
      removed: true,
    },
  });
  store.objects.clear();
  const read = await readArtifactControlStoreDrillClosure(
    {
      bytes: built.bytes,
      approvalPolicy: { repository: collectorIdentity.repository },
      providerPolicy,
      artifactDrillPolicy,
      expectedSourceSha: sourceSha,
      expectedRunId: runId,
      expectedRunAttempt: runAttempt,
    },
    {
      readOidcAuthority: async (options) => {
        assert.equal(options.reference.sha256, oidcSha256);
        assert.equal(options.runId, runId);
        assert.equal(options.runAttempt, runAttempt);
        return {};
      },
      validateProviderObservation: () => {},
    },
  );
  assert.equal(read.result.rawSha256, observation.rawTranscript.sha256);
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "artifact-drill-closure-"),
  );
  try {
    const outputPath = path.join(temporaryRoot, "closure.json");
    const written = await writeArtifactControlStoreDrillOutput(
      outputPath,
      built,
    );
    assert.deepEqual(await readFile(outputPath), written.bytes);
    await assert.rejects(
      writeArtifactControlStoreDrillOutput(outputPath, built),
      /already exists/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const tampered = structuredClone(built.closure);
  tampered.objects[0].bytesBase64 = Buffer.from("tampered", "utf8").toString(
    "base64",
  );
  await assert.rejects(
    readArtifactControlStoreDrillClosure(
      {
        bytes: canonicalJsonBytes(tampered),
        approvalPolicy: { repository: collectorIdentity.repository },
        providerPolicy,
        artifactDrillPolicy,
        expectedSourceSha: sourceSha,
        expectedRunId: runId,
        expectedRunAttempt: runAttempt,
      },
      {
        readOidcAuthority: async () => ({}),
        validateProviderObservation: () => {},
      },
    ),
    /object bytes differ/,
  );
  const providerMetadataTampered = structuredClone(built.closure);
  const providerObject = providerMetadataTampered.objects.find(
    ({ sha256 }) => sha256 === productionProviderObservationSha256,
  );
  providerObject.committedAt = "2026-08-09T00:00:04.000Z";
  await assert.rejects(
    readArtifactControlStoreDrillClosure(
      {
        bytes: canonicalJsonBytes(providerMetadataTampered),
        approvalPolicy: { repository: collectorIdentity.repository },
        providerPolicy,
        artifactDrillPolicy,
        expectedSourceSha: sourceSha,
        expectedRunId: runId,
        expectedRunAttempt: runAttempt,
      },
      {
        readOidcAuthority: async () => ({}),
        validateProviderObservation: () => {},
      },
    ),
    /production provider authority is absent/,
  );
  const providerReferenceTampered = structuredClone(built.closure);
  providerReferenceTampered.observation.productionProviderObservation.caller =
    "trusted";
  await assert.rejects(
    readArtifactControlStoreDrillClosure(
      {
        bytes: canonicalJsonBytes(providerReferenceTampered),
        approvalPolicy: { repository: collectorIdentity.repository },
        providerPolicy,
        artifactDrillPolicy,
        expectedSourceSha: sourceSha,
        expectedRunId: runId,
        expectedRunAttempt: runAttempt,
      },
      {
        readOidcAuthority: async () => ({}),
        validateProviderObservation: () => {},
      },
    ),
    /unknown or missing fields/,
  );
});
