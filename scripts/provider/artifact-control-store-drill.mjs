import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  assertExactKeys,
  assertImmutableObjectReference,
} from "../release-state/releaseWorkflowValidation.mjs";
import {
  assertBrowserPhaseExitCollectorIdentity,
  assertProductionRequestGraphProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority,
  deriveBrowserPhaseExitCollectorIdentity,
  readStoredProductionRequestGraphOidcAuthority,
} from "../browser/production-request-graph.mjs";
import {
  ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
  assertArtifactControlStorePostgresReceipt,
} from "./artifact-control-store-drill-postgres.mjs";
import {
  ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE,
  ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE,
  assertArtifactDrillArchiveReceipt,
  assertArtifactDrillAssignmentReceipt,
  assertArtifactDrillBuildReceipt,
  assertArtifactDrillDeploymentReceipt,
  assertArtifactDrillProviderObservationReceipt,
  assertArtifactDrillProviderCleanupReceipt,
  assertArtifactDrillReceiptAuthority,
  assertArtifactDrillReconcileReceipt,
  assertArtifactDrillRedeployReceipt,
  parseCanonicalArtifactDrillReceipt,
} from "./artifact-control-store-drill-receipts.mjs";
import {
  VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  assertVercelObservationEvidence,
} from "./collect-vercel-observation.mjs";

export const ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-provider-control-store-drill-raw+json;version=2";

export {
  assertProductionRequestGraphProtectedWorkflow as assertArtifactControlStoreDrillProtectedWorkflow,
  collectAndStoreProductionRequestGraphOidcAuthority as collectAndStoreArtifactControlStoreDrillOidcAuthority,
};

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_RAW_BYTES = 16 * 1024 * 1024;

const canonicalTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
};

const assertProductionProviderObservationReference = (
  reference,
  namespace,
  label,
) => {
  assertExactKeys(
    reference,
    ["byteLength", "committedAt", "mediaType", "sha256", "uri"],
    label,
  );
  if (
    !NAMESPACE.test(namespace ?? "") ||
    !SHA256.test(reference.sha256 ?? "") ||
    reference.uri !==
      `release-state://${namespace}/evidence/${reference.sha256}` ||
    reference.mediaType !== VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE ||
    !Number.isSafeInteger(reference.byteLength) ||
    reference.byteLength < 1 ||
    reference.byteLength > MAXIMUM_RAW_BYTES
  ) {
    throw new Error(`${label} is not bound to canonical immutable bytes`);
  }
  canonicalTimestamp(reference.committedAt, `${label} commit`);
  return reference;
};

export const deriveArtifactDrillNamespace = ({
  productionNamespace,
  sourceSha,
  runId,
  runAttempt,
}) => {
  if (
    !NAMESPACE.test(productionNamespace ?? "") ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !/^[1-9][0-9]*$/u.test(runId ?? "") ||
    !/^[1-9][0-9]*$/u.test(runAttempt ?? "")
  ) {
    throw new Error("Artifact drill namespace authority is invalid");
  }
  const digest = sha256Json({
    kind: "artifact-provider-control-store-drill-namespace/v1",
    productionNamespace,
    runAttempt,
    runId,
    sourceSha,
  });
  const drillNamespace = `artifact-drill-${digest.slice(0, 32)}`;
  if (
    drillNamespace === productionNamespace ||
    !NAMESPACE.test(drillNamespace)
  ) {
    throw new Error("Artifact drill namespace is not disposable");
  }
  return drillNamespace;
};

const assertHash = (value, label) => {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} is invalid`);
};

const assertBuild = (build, index) => {
  assertExactKeys(
    build,
    [
      "attempt",
      "packageArchiveSha256",
      "packageIndexSha256",
      "receiptSha256",
      "roles",
    ],
    `Artifact drill build ${index + 1}`,
  );
  if (
    build.attempt !== index + 1 ||
    !Array.isArray(build.roles) ||
    build.roles.length !== 2
  ) {
    throw new Error("Artifact drill build attempt is invalid");
  }
  assertHash(build.packageArchiveSha256, "Artifact drill package archive");
  assertHash(build.packageIndexSha256, "Artifact drill package index");
  assertHash(build.receiptSha256, "Artifact drill build receipt");
  const roles = build.roles.map(({ role }) => role);
  if (roles.join(",") !== "containment,standard") {
    throw new Error("Artifact drill build role set differs");
  }
  for (const role of build.roles) {
    assertExactKeys(
      role,
      [
        "archiveSha256",
        "capabilitySha256",
        "dbFingerprint",
        "manifestSha256",
        "policySha256",
        "role",
      ],
      "Artifact drill role build",
    );
    for (const key of [
      "archiveSha256",
      "capabilitySha256",
      "dbFingerprint",
      "manifestSha256",
      "policySha256",
    ]) {
      assertHash(role[key], `Artifact drill role ${key}`);
    }
  }
};

const assertProviderReceipt = (receipt, label) => {
  assertExactKeys(
    receipt,
    ["deploymentId", "previewUrl", "receiptSha256", "role", "target"],
    label,
  );
  assertHash(receipt.receiptSha256, `${label} receipt`);
  const url = new URL(receipt.previewUrl);
  if (
    url.protocol !== "https:" ||
    receipt.target !== "preview" ||
    !["standard", "containment"].includes(receipt.role) ||
    typeof receipt.deploymentId !== "string" ||
    receipt.deploymentId.length === 0
  ) {
    throw new Error(`${label} is not an immutable preview deployment`);
  }
};

export const assertArtifactControlStoreDrillRaw = (
  raw,
  { productionNamespace, forbiddenAliases },
) => {
  assertExactKeys(
    raw,
    [
      "archiveVerification",
      "assignments",
      "authority",
      "builds",
      "completedAt",
      "controlStore",
      "deployments",
      "drillNamespace",
      "kind",
      "productionNamespace",
      "providerCleanup",
      "providerObservationSha256",
      "productionProviderObservation",
      "reconcile",
      "redeploy",
      "routeProbes",
      "schemaVersion",
      "sourceSha",
      "startedAt",
      "toolchain",
    ],
    "Artifact drill raw transcript",
  );
  if (
    raw.schemaVersion !== 2 ||
    raw.kind !== "artifact-provider-control-store-drill-raw/v2" ||
    raw.productionNamespace !== productionNamespace ||
    raw.drillNamespace === productionNamespace ||
    !NAMESPACE.test(raw.drillNamespace ?? "") ||
    !SOURCE_SHA.test(raw.sourceSha ?? "")
  ) {
    throw new Error("Artifact drill identity or namespace safety differs");
  }
  assertArtifactDrillReceiptAuthority(raw.authority, {
    drillNamespace: raw.drillNamespace,
    sourceSha: raw.sourceSha,
  });
  const started = canonicalTimestamp(raw.startedAt, "Artifact drill start");
  const completed = canonicalTimestamp(
    raw.completedAt,
    "Artifact drill completion",
  );
  if (started >= completed)
    throw new Error("Artifact drill time interval is invalid");
  assertExactKeys(raw.toolchain, ["node", "npm"], "Artifact drill toolchain");
  if (raw.toolchain.node !== "24.19.0" || raw.toolchain.npm !== "11.19.0") {
    throw new Error("Artifact drill toolchain differs from fixed authority");
  }
  if (!Array.isArray(raw.builds) || raw.builds.length !== 2) {
    throw new Error("Artifact drill requires two independent package builds");
  }
  raw.builds.forEach(assertBuild);
  if (
    raw.builds[0].packageArchiveSha256 !== raw.builds[1].packageArchiveSha256 ||
    raw.builds[0].packageIndexSha256 !== raw.builds[1].packageIndexSha256
  ) {
    throw new Error("Artifact drill package build is not reproducible");
  }
  for (let roleIndex = 0; roleIndex < 2; roleIndex += 1) {
    const first = raw.builds[0].roles[roleIndex];
    const second = raw.builds[1].roles[roleIndex];
    if (
      canonicalJsonBytes(first).equals(canonicalJsonBytes(second)) === false
    ) {
      throw new Error(`Artifact drill ${first.role} build is not reproducible`);
    }
  }
  assertExactKeys(
    raw.archiveVerification,
    [
      "capabilityVerified",
      "dbBindingVerified",
      "extractedManifestSha256",
      "manifestVerified",
      "policyBindingVerified",
      "receiptSha256",
    ],
    "Artifact drill archive verification",
  );
  assertHash(
    raw.archiveVerification.extractedManifestSha256,
    "Artifact drill extracted manifest",
  );
  assertProductionProviderObservationReference(
    raw.productionProviderObservation,
    raw.drillNamespace,
    "Artifact drill production provider observation",
  );
  assertHash(
    raw.archiveVerification.receiptSha256,
    "Artifact drill archive verification receipt",
  );
  for (const key of [
    "capabilityVerified",
    "dbBindingVerified",
    "manifestVerified",
    "policyBindingVerified",
  ]) {
    if (raw.archiveVerification[key] !== true)
      throw new Error(`Artifact drill ${key} failed`);
  }
  if (!Array.isArray(raw.deployments) || raw.deployments.length !== 2) {
    throw new Error("Artifact drill preview deployment set is incomplete");
  }
  raw.deployments.forEach((receipt) =>
    assertProviderReceipt(receipt, "Artifact drill deployment"),
  );
  assertHash(
    raw.providerObservationSha256,
    "Artifact drill provider observation",
  );
  assertExactKeys(
    raw.providerCleanup,
    ["aliasCount", "deploymentCount", "receiptSha256", "verified"],
    "Artifact drill provider cleanup",
  );
  if (
    raw.providerCleanup.aliasCount !== 2 ||
    raw.providerCleanup.deploymentCount !== 3 ||
    raw.providerCleanup.verified !== true
  ) {
    throw new Error("Artifact drill provider cleanup is incomplete");
  }
  assertHash(
    raw.providerCleanup.receiptSha256,
    "Artifact drill provider cleanup receipt",
  );
  if (!Array.isArray(raw.routeProbes) || raw.routeProbes.length < 1) {
    throw new Error("Artifact drill route probes are absent");
  }
  for (const probe of raw.routeProbes) {
    assertExactKeys(
      probe,
      ["deploymentId", "path", "status"],
      "Artifact drill route probe",
    );
    if (
      !raw.deployments.some(
        ({ deploymentId }) => deploymentId === probe.deploymentId,
      ) ||
      typeof probe.path !== "string" ||
      !probe.path.startsWith("/") ||
      !Number.isSafeInteger(probe.status) ||
      probe.status < 200 ||
      probe.status >= 400
    ) {
      throw new Error("Artifact drill route probe failed");
    }
  }
  assertExactKeys(
    raw.controlStore,
    [
      "casConflictDenied",
      "idempotencyVerified",
      "putReadbackVerified",
      "readerVisibilityDenied",
      "readerWriteDenied",
      "receiptSha256",
    ],
    "Artifact drill control store",
  );
  assertHash(
    raw.controlStore.receiptSha256,
    "Artifact drill control store receipt",
  );
  for (const key of [
    "casConflictDenied",
    "idempotencyVerified",
    "putReadbackVerified",
    "readerVisibilityDenied",
    "readerWriteDenied",
  ]) {
    if (raw.controlStore[key] !== true)
      throw new Error(`Artifact drill control store ${key} failed`);
  }
  if (!Array.isArray(raw.assignments) || raw.assignments.length < 2) {
    throw new Error("Artifact drill multi-domain assignment is incomplete");
  }
  const forbidden = new Set(
    forbiddenAliases.map((value) => value.toLowerCase()),
  );
  if (
    raw.deployments.some(({ previewUrl }) =>
      forbidden.has(new URL(previewUrl).hostname.toLowerCase()),
    )
  ) {
    throw new Error(
      "Artifact drill preview deployment reached a production alias",
    );
  }
  const domains = new Set();
  for (const assignment of raw.assignments) {
    assertExactKeys(
      assignment,
      ["deploymentId", "domain", "receiptSha256", "verified"],
      "Artifact drill domain assignment",
    );
    const domain = assignment.domain.toLowerCase();
    assertHash(
      assignment.receiptSha256,
      "Artifact drill domain assignment receipt",
    );
    if (
      assignment.verified !== true ||
      forbidden.has(domain) ||
      !domain.startsWith(`${raw.drillNamespace}.`) ||
      domains.has(domain) ||
      !raw.deployments.some(
        ({ deploymentId }) => deploymentId === assignment.deploymentId,
      )
    ) {
      throw new Error(
        "Artifact drill attempted a production or ambiguous alias",
      );
    }
    domains.add(domain);
  }
  for (const [name, value] of [
    ["redeploy", raw.redeploy],
    ["reconcile", raw.reconcile],
  ]) {
    assertExactKeys(
      value,
      ["receiptSha256", "verified"],
      `Artifact drill ${name}`,
    );
    assertHash(value.receiptSha256, `Artifact drill ${name} receipt`);
    if (value.verified !== true)
      throw new Error(`Artifact drill ${name} failed`);
  }
  return raw;
};

export const artifactDrillOperationReceiptHashes = (operations) => [
  ...operations.builds.map(({ receiptSha256 }) => receiptSha256),
  operations.archiveVerification.receiptSha256,
  ...operations.deployments.map(({ receiptSha256 }) => receiptSha256),
  operations.providerObservationSha256,
  operations.controlStore.receiptSha256,
  ...operations.assignments.map(({ receiptSha256 }) => receiptSha256),
  operations.redeploy.receiptSha256,
  operations.reconcile.receiptSha256,
  operations.providerCleanup.receiptSha256,
];

export const readArtifactDrillOperationReceipts = async ({
  store,
  operations,
  providerPolicy,
  aliasSuffix,
  forbiddenAliases = [],
}) => {
  const hashes = artifactDrillOperationReceiptHashes(operations);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("Artifact drill operation receipts are ambiguous");
  }
  const receipts = await Promise.all(
    hashes.map(async (sha256) => {
      const stored = await store.readEvidence({ sha256 });
      if (
        !Buffer.isBuffer(stored?.bytes) ||
        stored.bytes.length === 0 ||
        stored.bytes.length > MAXIMUM_RAW_BYTES ||
        sha256Bytes(stored.bytes) !== sha256 ||
        typeof stored.mediaType !== "string" ||
        !stored.mediaType.startsWith("application/") ||
        typeof stored.committedAt !== "string"
      ) {
        throw new Error("Artifact drill operation receipt readback differs");
      }
      const expected = {
        authority: {
          databaseEndpointSha256: operations.authority.databaseEndpointSha256,
          databasePolicySha256: operations.authority.databasePolicySha256,
          drillNamespace: operations.drillNamespace,
          providerPolicySha256: operations.authority.providerPolicySha256,
          sourceSha: operations.sourceSha,
          toolchainSha256: operations.authority.toolchainSha256,
        },
        aliasSuffix,
        forbiddenAliases,
        providerPolicy,
      };
      let semanticReceipt;
      if (sha256 === operations.controlStore.receiptSha256) {
        if (
          stored.mediaType !== ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE
        ) {
          throw new Error(
            "Artifact drill control-store receipt media type differs",
          );
        }
        const receipt = parseJsonStrict(
          stored.bytes.toString("utf8"),
          "Artifact drill control-store receipt",
        );
        if (!canonicalJsonBytes(receipt).equals(stored.bytes)) {
          throw new Error(
            "Artifact drill control-store receipt is not canonical",
          );
        }
        assertArtifactControlStorePostgresReceipt(receipt);
        if (
          receipt.namespace !== store.namespace ||
          receipt.databaseEndpointSha256 !==
            operations.authority.databaseEndpointSha256 ||
          operations.controlStore.casConflictDenied !==
            (receipt.casConflict.sqlstate === "40001") ||
          operations.controlStore.readerVisibilityDenied !==
            (receipt.readerVisibilityDenial.sqlstate === "42501") ||
          operations.controlStore.readerWriteDenied !==
            (receipt.readerWriteDenial.sqlstate === "42501") ||
          operations.controlStore.idempotencyVerified !==
            (receipt.idempotency.appendReplayObserved === true &&
              receipt.idempotency.evidenceReplayObserved === true) ||
          operations.controlStore.putReadbackVerified !==
            receipt.immutableEvidence.putReadbackVerified
        ) {
          throw new Error(
            "Artifact drill control-store projection differs from raw SQL receipt",
          );
        }
        semanticReceipt = receipt;
      } else {
        const buildIndex = operations.builds.findIndex(
          ({ receiptSha256 }) => receiptSha256 === sha256,
        );
        const deployment = operations.deployments.find(
          ({ receiptSha256 }) => receiptSha256 === sha256,
        );
        const assignment = operations.assignments.find(
          ({ receiptSha256 }) => receiptSha256 === sha256,
        );
        let mediaType;
        let validator;
        let label;
        if (buildIndex >= 0) {
          mediaType = ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillBuildReceipt;
          expected.attempt = buildIndex + 1;
          label = "Artifact drill build receipt";
        } else if (sha256 === operations.archiveVerification.receiptSha256) {
          mediaType = ARTIFACT_DRILL_ARCHIVE_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillArchiveReceipt;
          label = "Artifact drill archive receipt";
        } else if (deployment !== undefined) {
          mediaType = ARTIFACT_DRILL_DEPLOYMENT_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillDeploymentReceipt;
          label = "Artifact drill deployment receipt";
        } else if (sha256 === operations.providerObservationSha256) {
          mediaType = ARTIFACT_DRILL_PROVIDER_OBSERVATION_MEDIA_TYPE;
          validator = assertArtifactDrillProviderObservationReceipt;
          label = "Artifact drill provider observation receipt";
        } else if (assignment !== undefined) {
          mediaType = ARTIFACT_DRILL_ASSIGNMENT_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillAssignmentReceipt;
          label = "Artifact drill assignment receipt";
        } else if (sha256 === operations.redeploy.receiptSha256) {
          mediaType = ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillRedeployReceipt;
          label = "Artifact drill redeploy receipt";
        } else if (sha256 === operations.reconcile.receiptSha256) {
          mediaType = ARTIFACT_DRILL_RECONCILE_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillReconcileReceipt;
          label = "Artifact drill reconcile receipt";
        } else if (sha256 === operations.providerCleanup.receiptSha256) {
          mediaType = ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE;
          validator = assertArtifactDrillProviderCleanupReceipt;
          label = "Artifact drill provider cleanup receipt";
        } else {
          throw new Error(
            "Artifact drill receipt is not projected by operations",
          );
        }
        if (stored.mediaType !== mediaType) {
          throw new Error(`${label} media type differs`);
        }
        semanticReceipt = parseCanonicalArtifactDrillReceipt({
          bytes: stored.bytes,
          expected,
          label,
          validator,
        });
        if (
          !canonicalJsonBytes(semanticReceipt.authority).equals(
            canonicalJsonBytes(operations.authority),
          )
        ) {
          throw new Error(`${label} authority differs from raw transcript`);
        }
        if (buildIndex >= 0) {
          const projection = operations.builds[buildIndex];
          if (
            semanticReceipt.attempt !== projection.attempt ||
            semanticReceipt.packageArchiveSha256 !==
              projection.packageArchiveSha256 ||
            semanticReceipt.packageIndexSha256 !==
              projection.packageIndexSha256 ||
            !canonicalJsonBytes(semanticReceipt.roles).equals(
              canonicalJsonBytes(projection.roles),
            )
          ) {
            throw new Error("Artifact drill build receipt projection differs");
          }
        } else if (sha256 === operations.archiveVerification.receiptSha256) {
          for (const key of [
            "capabilityVerified",
            "dbBindingVerified",
            "extractedManifestSha256",
            "manifestVerified",
            "policyBindingVerified",
          ]) {
            if (semanticReceipt[key] !== operations.archiveVerification[key]) {
              throw new Error(
                "Artifact drill archive receipt projection differs",
              );
            }
          }
        } else if (deployment !== undefined) {
          for (const key of ["deploymentId", "previewUrl", "role", "target"]) {
            if (semanticReceipt[key] !== deployment[key]) {
              throw new Error(
                "Artifact drill deployment receipt projection differs",
              );
            }
          }
          const rawProbes = operations.routeProbes
            .filter(
              ({ deploymentId }) => deploymentId === deployment.deploymentId,
            )
            .map(({ path, status }) => ({ path, status }));
          const receiptProbes = semanticReceipt.routeProbes.map(
            ({ path, status }) => ({ path, status }),
          );
          if (
            !canonicalJsonBytes(rawProbes).equals(
              canonicalJsonBytes(receiptProbes),
            )
          ) {
            throw new Error(
              "Artifact drill deployment route projection differs",
            );
          }
        } else if (assignment !== undefined) {
          if (
            semanticReceipt.deploymentId !== assignment.deploymentId ||
            semanticReceipt.domain !== assignment.domain ||
            assignment.verified !== true
          ) {
            throw new Error(
              "Artifact drill assignment receipt projection differs",
            );
          }
        } else if (sha256 === operations.providerObservationSha256) {
          const projected = operations.deployments
            .map(({ deploymentId, previewUrl, role }) => ({
              deploymentId,
              previewUrl,
              responseSha256: semanticReceipt.deployments.find(
                (item) => item.deploymentId === deploymentId,
              )?.responseSha256,
              role,
            }))
            .sort((left, right) => left.role.localeCompare(right.role));
          const observed = [...semanticReceipt.deployments].sort(
            (left, right) => left.role.localeCompare(right.role),
          );
          if (
            !canonicalJsonBytes(projected).equals(canonicalJsonBytes(observed))
          ) {
            throw new Error(
              "Artifact drill provider observation projection differs",
            );
          }
        } else if (sha256 === operations.reconcile.receiptSha256) {
          const projected = operations.assignments
            .map(({ deploymentId, domain }) => ({ deploymentId, domain }))
            .sort((left, right) => left.domain.localeCompare(right.domain));
          const reconciled = semanticReceipt.assignments.map(
            ({ deploymentId, domain }) => ({ deploymentId, domain }),
          );
          if (
            !canonicalJsonBytes(projected).equals(
              canonicalJsonBytes(reconciled),
            )
          ) {
            throw new Error("Artifact drill reconcile projection differs");
          }
        } else if (sha256 === operations.providerCleanup.receiptSha256) {
          if (
            semanticReceipt.aliases.length !==
              operations.providerCleanup.aliasCount ||
            semanticReceipt.deployments.length !==
              operations.providerCleanup.deploymentCount ||
            operations.providerCleanup.verified !== true
          ) {
            throw new Error(
              "Artifact drill provider cleanup projection differs",
            );
          }
        }
      }
      canonicalTimestamp(
        stored.committedAt,
        "Artifact drill operation receipt commit",
      );
      return { sha256, mediaType: stored.mediaType, receipt: semanticReceipt };
    }),
  );
  const buildReceipts = receipts
    .filter(
      ({ mediaType }) => mediaType === ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
    )
    .map(({ receipt }) => receipt)
    .sort((left, right) => left.attempt - right.attempt);
  if (
    buildReceipts.length !== 2 ||
    !canonicalJsonBytes(buildReceipts[0].buildAuthority).equals(
      canonicalJsonBytes(buildReceipts[1].buildAuthority),
    ) ||
    !canonicalJsonBytes(buildReceipts[0].bootstrapVerification).equals(
      canonicalJsonBytes(buildReceipts[1].bootstrapVerification),
    )
  ) {
    throw new Error("Artifact drill build authority is not reproducible");
  }
  const cleanupReceipt = receipts.find(
    ({ mediaType }) =>
      mediaType === ARTIFACT_DRILL_PROVIDER_CLEANUP_RECEIPT_MEDIA_TYPE,
  )?.receipt;
  const redeployReceipt = receipts.find(
    ({ mediaType }) => mediaType === ARTIFACT_DRILL_REDEPLOY_RECEIPT_MEDIA_TYPE,
  )?.receipt;
  if (cleanupReceipt === undefined || redeployReceipt === undefined) {
    throw new Error("Artifact drill cleanup or redeploy receipt is absent");
  }
  const expectedAliases = operations.assignments
    .map(({ deploymentId, domain }) => ({ deploymentId, domain }))
    .sort((left, right) => left.domain.localeCompare(right.domain));
  const cleanedAliases = cleanupReceipt?.aliases.map(
    ({ deploymentId, domain }) => ({ deploymentId, domain }),
  );
  const expectedDeployments = [
    ...operations.deployments.map(({ deploymentId, previewUrl }) => ({
      deploymentId,
      previewUrl,
    })),
    {
      deploymentId: redeployReceipt.redeployedDeploymentId,
      previewUrl: redeployReceipt.previewUrl,
    },
  ].sort((left, right) => left.deploymentId.localeCompare(right.deploymentId));
  const cleanedDeployments = cleanupReceipt?.deployments.map(
    ({ deploymentId, previewUrl }) => ({ deploymentId, previewUrl }),
  );
  if (
    !canonicalJsonBytes(cleanedAliases).equals(
      canonicalJsonBytes(expectedAliases),
    ) ||
    !canonicalJsonBytes(cleanedDeployments).equals(
      canonicalJsonBytes(expectedDeployments),
    )
  ) {
    throw new Error(
      "Artifact drill provider cleanup differs from created resources",
    );
  }
  return receipts;
};

export const summarizeArtifactControlStoreDrill = (raw, authority) => {
  assertArtifactControlStoreDrillRaw(raw, authority);
  return {
    drillNamespace: raw.drillNamespace,
    generatedArchiveSha256: raw.builds[0].packageArchiveSha256,
    regeneratedArchiveSha256: raw.builds[1].packageArchiveSha256,
    extractedManifestSha256: raw.archiveVerification.extractedManifestSha256,
    providerDeploymentReceiptSha256: sha256Json(
      raw.deployments.map(({ receiptSha256 }) => receiptSha256),
    ),
    providerObservationSha256: raw.providerObservationSha256,
    controlStoreReceiptSha256: raw.controlStore.receiptSha256,
    collectorIdentitySha256: sha256Json(raw.authority.collectorIdentity),
    routeProbeCount: raw.routeProbes.length,
    casConflictDenied: raw.controlStore.casConflictDenied,
    readerVisibilityDenied: raw.controlStore.readerVisibilityDenied,
    readerWriteDenied: raw.controlStore.readerWriteDenied,
    multiDomainAssignmentVerified: true,
    packageRedeployVerified: raw.redeploy.verified,
    reconcileVerified: raw.reconcile.verified,
    outcome: "succeeded",
    rawSha256: sha256Bytes(canonicalJsonBytes(raw)),
  };
};

export const readStoredArtifactControlStoreDrill = async ({
  store,
  reference,
  authority,
}) => {
  assertImmutableObjectReference(
    reference,
    store.namespace,
    "Artifact drill raw reference",
  );
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error("Stored artifact drill transcript differs");
  }
  canonicalTimestamp(stored.committedAt, "Artifact drill immutable commit");
  const raw = parseJsonStrict(
    stored.bytes.toString("utf8"),
    "Stored artifact drill transcript",
  );
  if (!canonicalJsonBytes(raw).equals(stored.bytes))
    throw new Error("Stored artifact drill transcript is not canonical");
  return {
    bytes: Buffer.from(stored.bytes),
    committedAt: stored.committedAt,
    raw,
    result: summarizeArtifactControlStoreDrill(raw, authority),
  };
};

export const putArtifactControlStoreDrill = async ({
  store,
  raw,
  authority,
}) => {
  if (store?.namespace !== raw?.drillNamespace)
    throw new Error("Artifact drill store namespace differs");
  summarizeArtifactControlStoreDrill(raw, authority);
  const bytes = canonicalJsonBytes(raw);
  if (bytes.length > MAXIMUM_RAW_BYTES)
    throw new Error("Artifact drill transcript is oversized");
  const sha256 = sha256Bytes(bytes);
  const reference = {
    uri: `release-state://${store.namespace}/evidence/${sha256}`,
    sha256,
  };
  const receipt = await store.putEvidence({
    bytes,
    mediaType: ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE,
  });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.committedAt !== "string"
  ) {
    throw new Error("Artifact drill immutable receipt differs");
  }
  const readback = await readStoredArtifactControlStoreDrill({
    store,
    reference,
    authority,
  });
  if (
    !readback.bytes.equals(bytes) ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error("Artifact drill immutable readback differs");
  }
  return { reference, readback };
};

export const assertArtifactControlStoreDrillObservation = (observation) => {
  assertExactKeys(
    observation,
    [
      "collectorIdentity",
      "drillNamespace",
      "kind",
      "observedAt",
      "oidcReceipt",
      "productionNamespace",
      "productionProviderObservation",
      "rawTranscript",
      "result",
      "schemaVersion",
      "sourceSha",
    ],
    "Artifact drill observation",
  );
  if (
    observation.schemaVersion !== 2 ||
    observation.kind !==
      "artifact-provider-control-store-drill-observation/v2" ||
    observation.drillNamespace === observation.productionNamespace ||
    !NAMESPACE.test(observation.drillNamespace ?? "") ||
    !NAMESPACE.test(observation.productionNamespace ?? "") ||
    !SOURCE_SHA.test(observation.sourceSha ?? "")
  ) {
    throw new Error("Artifact drill observation identity is invalid");
  }
  canonicalTimestamp(observation.observedAt, "Artifact drill observation time");
  assertBrowserPhaseExitCollectorIdentity(
    observation.collectorIdentity,
    observation.sourceSha,
  );
  assertImmutableObjectReference(
    observation.oidcReceipt,
    observation.drillNamespace,
    "Artifact drill OIDC receipt",
  );
  assertProductionProviderObservationReference(
    observation.productionProviderObservation,
    observation.drillNamespace,
    "Artifact drill observation production provider authority",
  );
  assertImmutableObjectReference(
    observation.rawTranscript,
    observation.drillNamespace,
    "Artifact drill raw transcript",
  );
  assertExactKeys(
    observation.result,
    [
      "casConflictDenied",
      "collectorIdentitySha256",
      "controlStoreReceiptSha256",
      "drillNamespace",
      "extractedManifestSha256",
      "generatedArchiveSha256",
      "multiDomainAssignmentVerified",
      "outcome",
      "packageRedeployVerified",
      "providerDeploymentReceiptSha256",
      "providerObservationSha256",
      "rawSha256",
      "readerVisibilityDenied",
      "readerWriteDenied",
      "reconcileVerified",
      "regeneratedArchiveSha256",
      "routeProbeCount",
    ],
    "Artifact drill result",
  );
  if (
    observation.result.drillNamespace !== observation.drillNamespace ||
    observation.result.rawSha256 !== observation.rawTranscript.sha256 ||
    observation.result.collectorIdentitySha256 !==
      sha256Json(observation.collectorIdentity) ||
    observation.result.generatedArchiveSha256 !==
      observation.result.regeneratedArchiveSha256 ||
    observation.result.casConflictDenied !== true ||
    observation.result.multiDomainAssignmentVerified !== true ||
    observation.result.packageRedeployVerified !== true ||
    observation.result.reconcileVerified !== true ||
    observation.result.readerVisibilityDenied !== true ||
    observation.result.readerWriteDenied !== true ||
    observation.result.outcome !== "succeeded" ||
    !Number.isSafeInteger(observation.result.routeProbeCount) ||
    observation.result.routeProbeCount < 1
  ) {
    throw new Error("Artifact drill observation result differs");
  }
  return observation;
};

export const collectAndStoreArtifactControlStoreDrill = async (
  {
    drillStore,
    productionNamespace,
    sourceSha,
    runId,
    runAttempt,
    oidcReceipt,
    oidcAuthority,
    providerPolicy,
    artifactDrillPolicy,
    providerObservation,
    executionAuthority,
    executeOperations,
    now = () => Date.now(),
  },
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    validateProviderObservation = assertVercelObservationEvidence,
  } = {},
) => {
  const drillNamespace = deriveArtifactDrillNamespace({
    productionNamespace,
    sourceSha,
    runId,
    runAttempt,
  });
  if (drillStore?.namespace !== drillNamespace)
    throw new Error("Artifact drill store is not disposable");
  const collectorIdentity = deriveBrowserPhaseExitCollectorIdentity({
    sourceSha,
    oidcAuthority: {
      ...oidcAuthority,
      runId,
      runAttempt,
    },
  });
  validateProviderObservation(providerObservation, providerPolicy);
  const productionProviderObservationBytes =
    canonicalJsonBytes(providerObservation);
  const productionProviderObservationSha256 = sha256Bytes(
    productionProviderObservationBytes,
  );
  const productionProviderObservationUri =
    `release-state://${drillNamespace}/evidence/` +
    productionProviderObservationSha256;
  const providerObservationReceipt = await drillStore.putEvidence({
    bytes: productionProviderObservationBytes,
    mediaType: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  });
  const storedProviderObservation = await drillStore.readEvidence({
    sha256: productionProviderObservationSha256,
  });
  if (
    providerObservationReceipt?.uri !== productionProviderObservationUri ||
    providerObservationReceipt.sha256 !== productionProviderObservationSha256 ||
    providerObservationReceipt.mediaType !==
      VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE ||
    providerObservationReceipt.byteLength !==
      productionProviderObservationBytes.length ||
    !Buffer.isBuffer(storedProviderObservation?.bytes) ||
    !storedProviderObservation.bytes.equals(
      productionProviderObservationBytes,
    ) ||
    storedProviderObservation.mediaType !==
      VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE ||
    storedProviderObservation.committedAt !==
      providerObservationReceipt.committedAt
  ) {
    throw new Error(
      "Artifact drill production provider observation immutable readback differs",
    );
  }
  const productionProviderObservation = {
    uri: productionProviderObservationUri,
    sha256: productionProviderObservationSha256,
    mediaType: VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
    byteLength: productionProviderObservationBytes.length,
    committedAt: providerObservationReceipt.committedAt,
  };
  assertProductionProviderObservationReference(
    productionProviderObservation,
    drillNamespace,
    "Artifact drill production provider observation",
  );
  const receiptAuthority = {
    collectorIdentity,
    databaseEndpointSha256: executionAuthority?.databaseEndpointSha256,
    databasePolicySha256: executionAuthority?.databasePolicySha256,
    drillNamespace,
    providerPolicySha256: executionAuthority?.providerPolicySha256,
    sourceSha,
    toolchainSha256: executionAuthority?.toolchainSha256,
  };
  assertArtifactDrillReceiptAuthority(receiptAuthority, {
    drillNamespace,
    sourceSha,
  });
  await readOidcAuthority({
    store: drillStore,
    namespace: drillNamespace,
    reference: oidcReceipt,
    approvalPolicy: oidcAuthority.approvalPolicy,
    sourceSha,
    runId,
    runAttempt,
  });
  const forbiddenAliases = [
    ...(providerPolicy.ownedProductionDomains ?? []),
    ...(providerPolicy.productionDomains ?? []),
    ...(providerPolicy.productionAliases ?? []),
  ];
  const startedAt = new Date(Number(now())).toISOString();
  const operations = await executeOperations({
    authority: receiptAuthority,
    drillNamespace,
    forbiddenAliases: [...forbiddenAliases],
    previewOnly: true,
    sourceSha,
  });
  const completedAt = new Date(Number(now())).toISOString();
  const raw = {
    schemaVersion: 2,
    kind: "artifact-provider-control-store-drill-raw/v2",
    productionNamespace,
    drillNamespace,
    sourceSha,
    startedAt,
    completedAt,
    authority: receiptAuthority,
    productionProviderObservation,
    ...operations,
  };
  const authority = { productionNamespace, forbiddenAliases };
  assertArtifactControlStoreDrillRaw(raw, authority);
  await readArtifactDrillOperationReceipts({
    store: drillStore,
    operations: raw,
    aliasSuffix: artifactDrillPolicy?.providerPreviewAliasSuffix,
    forbiddenAliases,
    providerPolicy,
  });
  const stored = await putArtifactControlStoreDrill({
    store: drillStore,
    raw,
    authority,
  });
  const observation = {
    schemaVersion: 2,
    kind: "artifact-provider-control-store-drill-observation/v2",
    productionNamespace,
    productionProviderObservation: { ...productionProviderObservation },
    drillNamespace,
    sourceSha,
    collectorIdentity,
    observedAt: completedAt,
    oidcReceipt: { ...oidcReceipt },
    rawTranscript: { ...stored.reference },
    result: { ...stored.readback.result },
  };
  assertArtifactControlStoreDrillObservation(observation);
  return observation;
};
