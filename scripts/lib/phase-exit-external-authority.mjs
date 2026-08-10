import {
  canonicalJsonBytes,
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import { assertConfiguredApprovalRolePolicy } from "./approval-policy.mjs";
import { assertReviewedPerformanceArtifactForAcceptedGate } from "./performance-evidence-identity.mjs";
import {
  REMOTE_DB_OBSERVATION_MEDIA_TYPE,
  readReviewedRemoteDbObservationProductionAuthority,
  readStoredRemoteDbObservationAuthority,
} from "../db/remote-db-observation-authority.mjs";
import { readBoundReviewedWorkflowRunAuthority } from "../release-state/reviewedWorkflowRunAuthority.mjs";
import { readBoundReviewedWorkflowArtifactAuthority } from "../release-state/reviewedWorkflowArtifactAuthority.mjs";
import {
  PWA_REVIEWED_FORMAL_CLOSURE_KIND,
  readManagedDeviceReviewedStageSetAuthority,
  readPwaReviewedFormalClosureAuthority,
} from "../release-state/managedDeviceReviewedStageSetAuthority.mjs";
import {
  readFoundationBaselineClosureForPhaseExit,
  resolveBootstrapFoundationSource,
} from "./foundation-baseline-closure-authority.mjs";
import {
  PRODUCTION_REQUEST_GRAPH_OBSERVATION_MEDIA_TYPE,
  assertProductionRequestGraphObservation,
  readStoredProductionRequestGraph,
  readStoredProductionRequestGraphOidcAuthority,
} from "../browser/production-request-graph.mjs";
import {
  DEPLOYED_CSP_FLOW_OBSERVATION_MEDIA_TYPE,
  assertDeployedCspFlowObservation,
  readStoredDeployedCspFlow,
} from "../browser/deployed-csp-flow.mjs";
import {
  assertCspReportObservation,
  readStoredCspReportObservationAuthority,
} from "../browser/csp-report-observation.mjs";
import {
  STARTUP_WAF_OBSERVATION_MEDIA_TYPE,
  readStartupWafObservationAuthority,
} from "../provider/startup-waf-observation.mjs";
import { loadStartupWafFixtures } from "../provider/collect-startup-waf-observation.mjs";
import {
  BACKUP_RESTORE_REHEARSAL_FILE_MEDIA_TYPE,
  assertBackupRestoreRehearsalObservation,
  readStoredBackupRestoreRehearsalAuthority,
} from "../provider/backup-restore-rehearsal.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_SUBJECT_KIND_BY_GATE,
  RELEASE_PHASE_GATES,
} from "../release-state/phaseGates.mjs";
import {
  ARTIFACT_CONTROL_STORE_DRILL_CLOSURE_MEDIA_TYPE,
  readArtifactControlStoreDrillClosure,
} from "../provider/artifact-control-store-drill-closure.mjs";
import {
  FOUNDATION_EXTERNAL_BINDINGS_OBSERVATION_MEDIA_TYPE,
  assertFoundationExternalBindingsObservation,
  readStoredFoundationExternalBindingsAuthority,
} from "../provider/foundation-external-bindings.mjs";
import {
  FOUNDATION_BOOTSTRAP_RECOVERY_OBSERVATION_MEDIA_TYPE,
  assertFoundationBootstrapRecoveryObservation,
  readStoredFoundationBootstrapRecoveryAuthority,
} from "../provider/foundation-bootstrap-recovery.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.phase-exit-authority-bundle+json;version=1";
export const PERFORMANCE_EVIDENCE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.performance-evidence+json;version=1";
export { REMOTE_DB_OBSERVATION_MEDIA_TYPE };
export const RETENTION_EVIDENCE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.metrics-retention-observation+json;version=1";
export const QUALITY_RUN_SOURCE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.phase-exit-quality-run-source+json;version=1";
export const CSP_REPORT_OBSERVATION_FILE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.csp-report-observation+json;version=1";
export const STARTUP_WAF_RESULT_FILE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.startup-waf-observation-result+json;version=1";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const FUTURE_SKEW_MILLISECONDS = 30_000;
const BUNDLE_MAXIMUM_AGE_MILLISECONDS = 60 * 60 * 1_000;
const MAXIMUM_OBJECT_BYTES = 16 * 1024 * 1024;

const AUTHORITY_DEFINITIONS = Object.freeze(
  [
    {
      gate: "P0-BASELINE",
      authority: "external-bindings",
      kind: "phase-exit-external-bindings/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorOperation: "produce-foundation-baseline-closure",
      collectorAuthorityKind: "foundation-baseline-closure",
      collectorArtifact: {
        nameTemplate: "foundation-external-bindings-{sourceSha}-{runAttempt}",
        fileName: "foundation-external-bindings.json",
        fileMediaType: FOUNDATION_EXTERNAL_BINDINGS_OBSERVATION_MEDIA_TYPE,
      },
      maximumAgeSeconds: 300,
    },
    {
      gate: "P0-BASELINE",
      authority: "bootstrap-recovery-drill",
      kind: "phase-exit-bootstrap-recovery-drill/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorOperation: "produce-foundation-baseline-closure",
      collectorAuthorityKind: "foundation-baseline-closure",
      collectorArtifact: {
        nameTemplate: "foundation-bootstrap-recovery-{sourceSha}-{runAttempt}",
        fileName: "foundation-bootstrap-recovery.json",
        fileMediaType: FOUNDATION_BOOTSTRAP_RECOVERY_OBSERVATION_MEDIA_TYPE,
      },
      maximumAgeSeconds: 30 * 24 * 60 * 60,
    },
    {
      gate: "P0-TOOLCHAIN",
      authority: "quality-run",
      kind: "phase-exit-quality-run/v1",
      collectorWorkflowPath: ".github/workflows/quality.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate: "foundation-phase-exit-quality-{sourceSha}-{runAttempt}",
        fileName: "quality-run-source.json",
        fileMediaType: QUALITY_RUN_SOURCE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 24 * 60 * 60,
    },
    {
      gate: "P0-RELEASE",
      authority: "physical-performance",
      kind: null,
      mediaType: PERFORMANCE_EVIDENCE_MEDIA_TYPE,
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-performance-own-gate-evidence-{sourceSha}-{runAttempt}",
        fileName: "performance-evidence.json",
        fileMediaType: PERFORMANCE_EVIDENCE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 30 * 24 * 60 * 60,
    },
    {
      gate: "P0-ARTIFACT",
      authority: "artifact-provider-control-store-drill",
      kind: "phase-exit-artifact-provider-control-store-drill/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-artifact-provider-control-store-drill-{sourceSha}-{runAttempt}",
        fileName: "artifact-provider-control-store-drill-closure.json",
        fileMediaType: ARTIFACT_CONTROL_STORE_DRILL_CLOSURE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 30 * 24 * 60 * 60,
    },
    {
      gate: "P0-DATA",
      authority: "remote-db",
      kind: null,
      mediaType: REMOTE_DB_OBSERVATION_MEDIA_TYPE,
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      maximumAgeSeconds: 60 * 60,
    },
    {
      gate: "P0-DATA",
      authority: "retention",
      kind: null,
      mediaType: RETENTION_EVIDENCE_MEDIA_TYPE,
      collectorWorkflowPath: ".github/workflows/metrics-retention.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-phase-exit-retention-{sourceSha}-{runAttempt}",
        fileName: "retention-evidence.json",
        fileMediaType: RETENTION_EVIDENCE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 2 * 60 * 60,
    },
    {
      gate: "P0-DATA",
      authority: "backup-restore-rehearsal",
      kind: "phase-exit-backup-restore-rehearsal/v2",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-backup-restore-rehearsal-{sourceSha}-{runAttempt}",
        fileName: "backup-restore-rehearsal.json",
        fileMediaType: BACKUP_RESTORE_REHEARSAL_FILE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 30 * 24 * 60 * 60,
    },
    {
      gate: "P0-DATA",
      authority: "startup-waf-observation",
      kind: "phase-exit-startup-waf-observation/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-startup-waf-observation-{sourceSha}-{runAttempt}",
        fileName: "startup-waf-observation.json",
        fileMediaType: STARTUP_WAF_RESULT_FILE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 24 * 60 * 60,
    },
    {
      gate: "P1-PWA",
      authority: "pwa-multiclient-drill",
      kind: "phase-exit-pwa-multiclient-drill/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorAuthorityKind: "pwa-reviewed-formal-closure",
      maximumAgeSeconds: 7 * 24 * 60 * 60,
    },
    {
      gate: "P2A-LOCAL",
      authority: "production-request-graph",
      kind: "phase-exit-production-request-graph/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-production-request-graph-{sourceSha}-{runAttempt}",
        fileName: "production-request-graph-observation.json",
        fileMediaType: PRODUCTION_REQUEST_GRAPH_OBSERVATION_MEDIA_TYPE,
      },
      maximumAgeSeconds: 24 * 60 * 60,
    },
    {
      gate: "P2B-REPORT",
      authority: "csp-report-observation",
      kind: "phase-exit-csp-report-observation/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate:
          "foundation-csp-report-observation-{sourceSha}-{runAttempt}",
        fileName: "csp-report-observation.json",
        fileMediaType: CSP_REPORT_OBSERVATION_FILE_MEDIA_TYPE,
      },
      maximumAgeSeconds: 24 * 60 * 60,
    },
    {
      gate: "P4-CSP",
      authority: "deployed-csp-flow",
      kind: "phase-exit-deployed-csp-flow/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorArtifact: {
        nameTemplate: "foundation-deployed-csp-flow-{sourceSha}-{runAttempt}",
        fileName: "deployed-csp-flow-observation.json",
        fileMediaType: DEPLOYED_CSP_FLOW_OBSERVATION_MEDIA_TYPE,
      },
      maximumAgeSeconds: 24 * 60 * 60,
    },
    {
      gate: "P7-IDB",
      authority: "idb-device-compatibility",
      kind: "phase-exit-idb-device-compatibility/v1",
      collectorWorkflowPath: ".github/workflows/release.yml",
      collectorImplemented: true,
      collectorAuthorityKind: "managed-device-reviewed-stage-set",
      maximumAgeSeconds: 7 * 24 * 60 * 60,
    },
  ].map((definition) =>
    Object.freeze({
      ...definition,
      mediaType:
        definition.mediaType ??
        `application/vnd.event-shopping-planner.${definition.authority}+json;version=1`,
    }),
  ),
);

const AUTHORITY_READER_KIND_BY_ID = Object.freeze({
  "external-bindings": "foundation-baseline-closure",
  "bootstrap-recovery-drill": "foundation-baseline-closure",
  "quality-run": "generic-reviewed-artifact",
  "physical-performance": "physical-performance-artifact",
  "artifact-provider-control-store-drill": "derived-reviewed-artifact",
  "remote-db": "reviewed-remote-db-production",
  retention: "generic-reviewed-artifact",
  "backup-restore-rehearsal": "derived-reviewed-artifact",
  "startup-waf-observation": "derived-reviewed-artifact",
  "pwa-multiclient-drill": "pwa-reviewed-formal-closure",
  "production-request-graph": "derived-reviewed-artifact",
  "csp-report-observation": "derived-reviewed-artifact",
  "deployed-csp-flow": "derived-reviewed-artifact",
  "idb-device-compatibility": "managed-device-reviewed-stage-set",
});

const authorityIds = AUTHORITY_DEFINITIONS.map(({ authority }) => authority);
if (
  Object.keys(AUTHORITY_READER_KIND_BY_ID).length !== authorityIds.length ||
  authorityIds.some(
    (authority) => AUTHORITY_READER_KIND_BY_ID[authority] === undefined,
  ) ||
  Object.keys(AUTHORITY_READER_KIND_BY_ID).some(
    (authority) => !authorityIds.includes(authority),
  )
) {
  throw new Error(
    "Phase exit external authority reader registry is incomplete",
  );
}

export const PHASE_EXIT_EXTERNAL_READER_BRANCHES = Object.freeze(
  AUTHORITY_DEFINITIONS.map(({ authority, gate }) =>
    Object.freeze({
      authority,
      gate,
      readerKind: AUTHORITY_READER_KIND_BY_ID[authority],
    }),
  ),
);

const DERIVED_REVIEWED_ARTIFACT_AUTHORITIES = new Set(
  PHASE_EXIT_EXTERNAL_READER_BRANCHES.filter(
    ({ readerKind }) => readerKind === "derived-reviewed-artifact",
  ).map(({ authority }) => authority),
);

export const PHASE_EXIT_EXTERNAL_AUTHORITIES = Object.freeze(
  AUTHORITY_DEFINITIONS.map(
    ({
      gate,
      authority,
      mediaType,
      collectorWorkflowPath,
      collectorImplemented,
      collectorOperation,
      collectorAuthorityKind,
    }) =>
      Object.freeze({
        gate,
        authority,
        mediaType,
        collectorWorkflowPath,
        collectorImplemented,
        collectorOperation: collectorOperation ?? null,
        collectorAuthorityKind: collectorAuthorityKind ?? null,
      }),
  ),
);

export const getPhaseExitCollectorArtifactIdentity = ({
  authority,
  sourceSha,
  runAttempt,
}) => {
  const definition = AUTHORITY_DEFINITIONS.find(
    (candidate) => candidate.authority === authority,
  );
  if (
    definition?.collectorArtifact === undefined ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    !/^[1-9][0-9]{0,9}$/u.test(runAttempt ?? "")
  ) {
    throw new Error("Phase authority collector artifact identity is invalid");
  }
  return Object.freeze({
    artifactName: definition.collectorArtifact.nameTemplate
      .replace("{sourceSha}", sourceSha)
      .replace("{runAttempt}", runAttempt),
    fileName: definition.collectorArtifact.fileName,
    fileMediaType: definition.collectorArtifact.fileMediaType,
  });
};

const AUTHORITY_BY_ID = new Map(
  AUTHORITY_DEFINITIONS.map((definition, index) => [
    definition.authority,
    Object.freeze({ ...definition, index }),
  ]),
);
const FORMAL_EXTERNAL_AUTHORITY_GATES = new Set(
  AUTHORITY_DEFINITIONS.filter(
    ({ collectorImplemented }) => collectorImplemented,
  ).map(({ gate }) => gate),
);

const QUALITY_CHECKS = Object.freeze([
  "api",
  "architecture",
  "artifact",
  "audit",
  "browser",
  "coverage",
  "dependency-usage",
  "encoding",
  "format",
  "foundation",
  "integration",
  "lint",
  "typecheck",
  "unit",
  "worker",
]);
const CSP_FLOW_IDS = Object.freeze([
  "api-error",
  "blob-download",
  "normal",
  "offline",
  "pwa-update",
  "recovery",
  "worker",
]);

const compareUtf8 = (left, right) =>
  Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).sort(compareUtf8).join("\n") ===
    [...expected].sort(compareUtf8).join("\n");

const assertExactKeys = (value, expected, label) => {
  if (!exactKeys(value, expected)) {
    throw new Error(`${label} schema is not closed`);
  }
};

const sameCanonicalValue = (left, right) =>
  sha256Json(left) === sha256Json(right);

const assertCanonicalTimestamp = (value, label) => {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical UTC timestamp`);
  }
  return milliseconds;
};

const assertFreshTimestamp = ({
  value,
  label,
  maximumAgeSeconds,
  nowMilliseconds,
}) => {
  const milliseconds = assertCanonicalTimestamp(value, label);
  if (
    milliseconds < nowMilliseconds - maximumAgeSeconds * 1_000 ||
    milliseconds > nowMilliseconds + FUTURE_SKEW_MILLISECONDS
  ) {
    throw new Error(`${label} is stale or in the future`);
  }
  return milliseconds;
};

const assertSha256 = (value, label) => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
  return value;
};

const assertNonEmptyString = (value, label, maximumBytes = 512) => {
  const hasControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    hasControlCharacter
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const assertSortedDistinctStrings = (
  values,
  label,
  { nonEmpty = false } = {},
) => {
  if (
    !Array.isArray(values) ||
    (nonEmpty && values.length === 0) ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    new Set(values).size !== values.length ||
    values.some(
      (value, index) => index > 0 && compareUtf8(values[index - 1], value) >= 0,
    )
  ) {
    throw new Error(`${label} must be sorted and distinct`);
  }
  return values;
};

const assertReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], `${label} reference`);
  assertSha256(reference.sha256, label);
  if (
    reference.uri !==
    `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} reference is not bound to the live namespace`);
  }
  return reference;
};

const projectBinding = (value) => {
  if (
    !isRecord(value) ||
    typeof value.bindingId !== "string" ||
    value.bindingId.length === 0 ||
    !SOURCE_SHA_PATTERN.test(value.sourceSha ?? "") ||
    (value.releaseRole !== "standard" && value.releaseRole !== "containment") ||
    typeof value.providerProjectId !== "string" ||
    value.providerProjectId.length === 0 ||
    typeof value.providerDeploymentId !== "string" ||
    value.providerDeploymentId.length === 0
  ) {
    return null;
  }
  return {
    bindingId: value.bindingId,
    sourceSha: value.sourceSha,
    releaseRole: value.releaseRole,
    publicIdentityKind:
      typeof value.publicIdentityKind === "string"
        ? value.publicIdentityKind
        : null,
    providerProjectId: value.providerProjectId,
    providerDeploymentId: value.providerDeploymentId,
    deploymentUrl:
      typeof value.deploymentUrl === "string" ? value.deploymentUrl : null,
    artifactArchiveSha256:
      typeof value.artifactArchive?.sha256 === "string" &&
      SHA256_PATTERN.test(value.artifactArchive.sha256)
        ? value.artifactArchive.sha256
        : null,
    packageIndexSha256:
      typeof value.packageIndex?.sha256 === "string" &&
      SHA256_PATTERN.test(value.packageIndex.sha256)
        ? value.packageIndex.sha256
        : null,
  };
};

const projectOptionalBinding = (value, label) => {
  if (value === null || value === undefined) return null;
  const projected = projectBinding(value);
  if (projected === null) {
    throw new Error(`Live Release State ${label} binding is invalid`);
  }
  return projected;
};

export const projectPhaseExitAuthorityReleaseContext = ({
  current,
  namespace = null,
}) => {
  if (
    isRecord(current) &&
    current.head?.sequence === 0 &&
    current.head.eventHash === null &&
    current.snapshot === null &&
    Array.isArray(current.records) &&
    current.records.length === 0 &&
    NAMESPACE_PATTERN.test(namespace ?? "")
  ) {
    return {
      namespace,
      releaseStateHead: { sequence: 0, eventHash: null },
      dbCompatibility: null,
      acceptedGate: null,
      deployments: {
        activeProduction: null,
        acceptedStandard: null,
        preparedStandard: null,
        containmentCompanion: null,
        bootstrapRecovery: null,
      },
    };
  }
  if (
    !isRecord(current) ||
    !isRecord(current.head) ||
    !Number.isSafeInteger(current.head.sequence) ||
    current.head.sequence < 1 ||
    !SHA256_PATTERN.test(current.head.eventHash ?? "") ||
    !isRecord(current.snapshot?.currentDbCompatibility) ||
    typeof current.snapshot.currentDbCompatibility.contractUri !== "string" ||
    !SHA256_PATTERN.test(
      current.snapshot.currentDbCompatibility.fingerprint ?? "",
    ) ||
    !Array.isArray(current.records)
  ) {
    throw new Error(
      "Live Release State cannot project a phase authority subject",
    );
  }
  return {
    namespace: current.records[0]?.event?.namespace,
    releaseStateHead: { ...current.head },
    dbCompatibility: {
      contractUri: current.snapshot.currentDbCompatibility.contractUri,
      fingerprint: current.snapshot.currentDbCompatibility.fingerprint,
    },
    acceptedGate: current.snapshot.acceptedGate ?? null,
    deployments: {
      activeProduction: projectOptionalBinding(
        current.snapshot.activeProduction,
        "active production",
      ),
      acceptedStandard: projectOptionalBinding(
        current.snapshot.acceptedStandard,
        "accepted standard",
      ),
      preparedStandard: projectOptionalBinding(
        current.snapshot.pendingOperation?.targetBinding?.releaseRole ===
          "standard"
          ? current.snapshot.pendingOperation.targetBinding
          : null,
        "prepared standard",
      ),
      containmentCompanion: projectOptionalBinding(
        current.snapshot.containmentCompanion,
        "containment companion",
      ),
      bootstrapRecovery: projectOptionalBinding(
        current.snapshot.bootstrapRecovery,
        "bootstrap recovery",
      ),
    },
  };
};

const projectPreparedBootstrapBinding = (binding, bootstrapSourceSha) => {
  const projected = projectBinding(binding);
  if (
    projected === null ||
    projected.sourceSha !== bootstrapSourceSha ||
    projected.releaseRole !== "containment" ||
    projected.publicIdentityKind !== "legacy-bootstrap-v1" ||
    projected.artifactArchiveSha256 === null ||
    projected.packageIndexSha256 === null
  ) {
    throw new Error(
      "P0-DATA subject has no verified baseline bootstrap recovery binding",
    );
  }
  return {
    bindingId: projected.bindingId,
    providerDeploymentId: projected.providerDeploymentId,
    releaseRole: projected.releaseRole,
    sourceSha: projected.sourceSha,
    artifactArchiveSha256: projected.artifactArchiveSha256,
    packageIndexSha256: projected.packageIndexSha256,
  };
};

export const projectPhaseExitAuthoritySubject = ({
  current,
  targetGate,
  sourceSha,
  drillId = null,
  p0aPolicy = null,
}) => {
  if (
    !FORMAL_PHASE_EXIT_GATES.includes(targetGate) ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "")
  ) {
    throw new Error("Phase authority target subject identity is invalid");
  }
  const kind = PHASE_EXIT_SUBJECT_KIND_BY_GATE[targetGate];
  if (kind === "repository-phase-subject/v1") {
    return { kind, sourceSha };
  }
  if (kind === "disposable-drill-subject/v1") {
    if (
      typeof drillId !== "string" ||
      !NAMESPACE_PATTERN.test(drillId) ||
      !drillId.startsWith("artifact-drill-")
    ) {
      throw new Error("P0-ARTIFACT disposable drill subject is invalid");
    }
    return { kind, sourceSha, drillId };
  }
  const releaseContext = projectPhaseExitAuthorityReleaseContext({ current });
  if (kind === "state-initialized-bootstrap-subject/v1") {
    const snapshot = current.snapshot;
    const initialized = current.records[0];
    const bootstrapSourceSha =
      p0aPolicy?.bootstrapRecovery?.bootstrapSourceSha ?? null;
    const rawDistManifestSha256 =
      p0aPolicy?.bootstrapRecovery?.rawDistManifestSha256 ?? null;
    if (
      initialized?.event?.eventType !== "state-initialized" ||
      initialized.sequence !== 1 ||
      initialized.event.payload?.executorSourceSha !== sourceSha ||
      !sameCanonicalValue(
        initialized.event.payload?.bootstrapRecovery,
        snapshot.bootstrapRecovery,
      ) ||
      !SOURCE_SHA_PATTERN.test(bootstrapSourceSha ?? "") ||
      !SHA256_PATTERN.test(rawDistManifestSha256 ?? "") ||
      snapshot.bootstrapRecovery?.sourceSha !== bootstrapSourceSha ||
      snapshot.activeProduction !== null ||
      snapshot.acceptedStandard !== null ||
      snapshot.acceptedGate !== null ||
      snapshot.pendingOperation !== null ||
      snapshot.pendingAcceptance !== null
    ) {
      throw new Error(
        "P0-DATA subject requires an exact dual-source initialized bootstrap state",
      );
    }
    return {
      kind,
      executorSourceSha: sourceSha,
      bootstrapSourceSha,
      bootstrapBinding: projectPreparedBootstrapBinding(
        snapshot.bootstrapRecovery,
        bootstrapSourceSha,
      ),
      rawDistManifestSha256,
      releaseStateHead: {
        sequence: initialized.sequence,
        eventHash: initialized.eventHash,
      },
    };
  }
  return {
    kind,
    sourceSha,
    releaseStateHead: { ...releaseContext.releaseStateHead },
  };
};

const assertSubject = ({ subject, expected }) => {
  assertExactKeys(subject, Object.keys(expected), "Phase authority subject");
  if (!sameCanonicalValue(subject, expected)) {
    throw new Error("Phase authority subject differs from live Release State");
  }
};

const parseCanonicalObject = (bytes, label) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error(`${label} bytes are absent`);
  }
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (!bytes.equals(canonicalJsonBytes(value))) {
    throw new Error(`${label} must use canonical JSON bytes`);
  }
  return value;
};

const readStoredObject = async ({
  store,
  namespace,
  reference,
  expectedMediaType,
  label,
  nowMilliseconds,
}) => {
  assertReference(reference, namespace, label);
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAXIMUM_OBJECT_BYTES ||
    sha256Bytes(stored.bytes) !== reference.sha256 ||
    stored.mediaType !== expectedMediaType
  ) {
    throw new Error(
      `${label} immutable object is absent, tampered, or mistyped`,
    );
  }
  const committedAt = assertCanonicalTimestamp(
    stored.committedAt,
    `${label} committedAt`,
  );
  if (committedAt > nowMilliseconds + FUTURE_SKEW_MILLISECONDS) {
    throw new Error(`${label} immutable commit time is in the future`);
  }
  return { ...stored, committedAtMilliseconds: committedAt };
};

const ACCEPTED_GATE_ORDER = RELEASE_PHASE_GATES;

const bindingForPreparedDeployment = (context, deploymentId, label) => {
  const prepared = context.releaseContext.deployments.bootstrapRecovery;
  if (
    prepared === null ||
    prepared.providerDeploymentId !== deploymentId ||
    prepared.sourceSha !== context.subject.bootstrapSourceSha ||
    prepared.releaseRole !== "containment" ||
    prepared.publicIdentityKind !== "legacy-bootstrap-v1" ||
    context.subject.kind !== "state-initialized-bootstrap-subject/v1" ||
    context.subject.executorSourceSha !== context.sourceSha ||
    !sameCanonicalValue(context.subject.bootstrapBinding, {
      bindingId: prepared.bindingId,
      providerDeploymentId: prepared.providerDeploymentId,
      releaseRole: prepared.releaseRole,
      sourceSha: prepared.sourceSha,
      artifactArchiveSha256: prepared.artifactArchiveSha256,
      packageIndexSha256: prepared.packageIndexSha256,
    })
  ) {
    throw new Error(
      `${label} is not the exact baseline bootstrap candidate deployment`,
    );
  }
  return prepared;
};

const bindingForCurrentAcceptedDeployment = (
  context,
  deploymentId,
  label,
  minimumAcceptedGate,
) => {
  const active = context.releaseContext.deployments.activeProduction;
  const accepted = context.releaseContext.deployments.acceptedStandard;
  const acceptedIndex = ACCEPTED_GATE_ORDER.indexOf(
    context.releaseContext.acceptedGate,
  );
  const minimumIndex = ACCEPTED_GATE_ORDER.indexOf(minimumAcceptedGate);
  if (
    active === null ||
    accepted === null ||
    !sameCanonicalValue(active, accepted) ||
    active.providerDeploymentId !== deploymentId ||
    active.sourceSha !== context.sourceSha ||
    active.releaseRole !== "standard" ||
    minimumIndex < 0 ||
    acceptedIndex < minimumIndex
  ) {
    throw new Error(
      `${label} is not the current exact-source accepted production deployment`,
    );
  }
  return active;
};

export const assertCurrentAcceptedPhaseExitDeployment = ({
  releaseContext,
  sourceSha,
  deploymentId,
  minimumAcceptedGate,
}) =>
  bindingForCurrentAcceptedDeployment(
    { releaseContext, sourceSha },
    deploymentId,
    "Phase authority deployment",
    minimumAcceptedGate,
  );

const assertConfiguredPolicies = ({
  providerPolicy,
  approvalPolicy,
  storePolicy,
  databaseContract,
}) => {
  const reviewerTeams = assertConfiguredApprovalRolePolicy(
    approvalPolicy,
    "External binding approval policy",
  );
  if (
    providerPolicy.bindingStatus !== "configured" ||
    (providerPolicy.blockerCodes ?? []).length !== 0 ||
    (approvalPolicy.blockerCodes ?? []).length !== 0 ||
    storePolicy.bindingStatus !== "configured" ||
    (storePolicy.blockerCodes ?? []).length !== 0 ||
    !["local-specification", "remote-verified"].includes(
      databaseContract.contractStatus,
    ) ||
    !["unobserved", "observed"].includes(
      databaseContract.remote?.observationStatus,
    )
  ) {
    throw new Error("External binding policies are not fully configured");
  }
  return reviewerTeams;
};

const externalBindingsResult = (context) => {
  const reviewerTeams = assertConfiguredPolicies(context);
  const remoteAuthority = context.databaseContract.remote.observationAuthority;
  return {
    provider: {
      provider: context.providerPolicy.provider,
      teamId: context.providerPolicy.expectedTeamId,
      projectId: context.providerPolicy.expectedProjectId,
      ownedProductionDomains: context.providerPolicy.ownedProductionDomains,
      productionEnvironmentName:
        context.providerPolicy.productionEnvironmentName,
      productionBranch: context.providerPolicy.productionBranch,
      configurationSha256: sha256Json(context.providerPolicy),
    },
    approval: {
      repository: context.approvalPolicy.repository,
      workflowRef: context.approvalPolicy.workflowRef,
      protectedEnvironment: context.approvalPolicy.protectedEnvironment,
      reviewerTeams,
      configurationSha256: sha256Json(context.approvalPolicy),
    },
    controlStore: {
      engine: context.storePolicy.engine,
      postgresMajor: context.storePolicy.postgresMajor,
      allowedHosts: context.storePolicy.allowedHosts,
      allowedDatabases: context.storePolicy.allowedDatabases,
      allowedExecutorRoles: context.storePolicy.allowedExecutorRoles,
      productionCaSha256: context.storePolicy.productionCaSha256,
      backupOwner: context.storePolicy.backupOwner,
      restoreOwner: context.storePolicy.restoreOwner,
      configurationSha256: sha256Json(context.storePolicy),
    },
    applicationDatabase: {
      contractUri: context.databaseContract.contractUri,
      contractFingerprint: sha256Json(context.databaseContract),
      allowedHosts: remoteAuthority.allowedHosts,
      allowedDatabases: remoteAuthority.allowedDatabases,
      allowedObserverRoles: remoteAuthority.allowedObserverRoles,
      productionCaSha256: remoteAuthority.productionCaSha256,
      configurationSha256: sha256Json(remoteAuthority),
    },
  };
};

const assertExternalBindings = (result, context) => {
  assertExactKeys(
    result,
    ["provider", "approval", "controlStore", "applicationDatabase"],
    "External binding result",
  );
  const expected = externalBindingsResult(context);
  if (!sameCanonicalValue(result, expected)) {
    throw new Error("External binding evidence differs from configured policy");
  }
};

const assertBootstrapRecoveryDrill = (result, context) => {
  assertExactKeys(
    result,
    [
      "drillId",
      "startedAt",
      "completedAt",
      "recoveryBindingId",
      "recoveryDeploymentId",
      "rawDistManifestSha256",
      "artifactArchiveSha256",
      "restoredArtifactSha256",
      "recoveryTimeSeconds",
      "dataLossObserved",
      "outcome",
    ],
    "Bootstrap recovery drill result",
  );
  const startedAt = assertCanonicalTimestamp(
    result.startedAt,
    "Bootstrap recovery drill start",
  );
  const completedAt = assertCanonicalTimestamp(
    result.completedAt,
    "Bootstrap recovery drill completion",
  );
  const binding = context.releaseContext.deployments.bootstrapRecovery;
  assertNonEmptyString(result.drillId, "Bootstrap recovery drill ID");
  assertSha256(result.rawDistManifestSha256, "Bootstrap raw dist manifest");
  assertSha256(result.artifactArchiveSha256, "Bootstrap artifact archive");
  assertSha256(result.restoredArtifactSha256, "Restored bootstrap artifact");
  if (
    binding === null ||
    binding.bindingId !== result.recoveryBindingId ||
    binding.providerDeploymentId !== result.recoveryDeploymentId ||
    binding.artifactArchiveSha256 !== result.artifactArchiveSha256 ||
    result.restoredArtifactSha256 !== result.artifactArchiveSha256 ||
    completedAt <= startedAt ||
    !Number.isSafeInteger(result.recoveryTimeSeconds) ||
    result.recoveryTimeSeconds < Math.ceil((completedAt - startedAt) / 1_000) ||
    result.dataLossObserved !== false ||
    result.outcome !== "succeeded"
  ) {
    throw new Error("Bootstrap recovery drill did not prove exact recovery");
  }
};

const assertQualityRun = (result, context) => {
  assertExactKeys(
    result,
    [
      "repository",
      "workflowPath",
      "workflowRunId",
      "workflowRunAttempt",
      "event",
      "headBranch",
      "headSha",
      "status",
      "conclusion",
      "nodeVersion",
      "npmVersion",
      "checks",
    ],
    "Quality run result",
  );
  assertSortedDistinctStrings(result.checks, "Quality check set", {
    nonEmpty: true,
  });
  const collector = context.collectorAuthority?.receipt;
  const sourceBytes = context.collectorAuthority?.fileBytes;
  const source = parseCanonicalObject(sourceBytes, "Quality run source");
  assertExactKeys(
    source,
    [
      "schemaVersion",
      "kind",
      "repository",
      "workflowPath",
      "workflowRunId",
      "workflowRunAttempt",
      "event",
      "headBranch",
      "headSha",
      "observedAt",
      "nodeVersion",
      "npmVersion",
      "checks",
    ],
    "Quality run source",
  );
  const expectedResult = {
    repository: source.repository,
    workflowPath: source.workflowPath,
    workflowRunId: source.workflowRunId,
    workflowRunAttempt: source.workflowRunAttempt,
    event: source.event,
    headBranch: source.headBranch,
    headSha: source.headSha,
    status: collector?.status,
    conclusion: collector?.conclusion,
    nodeVersion: source.nodeVersion,
    npmVersion: source.npmVersion,
    checks: source.checks,
  };
  if (
    source.schemaVersion !== 1 ||
    source.kind !== "phase-exit-quality-run-source/v1" ||
    source.observedAt !== context.entry.observedAt ||
    !sameCanonicalValue(result, expectedResult) ||
    result.repository !== context.approvalPolicy.repository ||
    result.workflowPath !== ".github/workflows/quality.yml" ||
    !/^[1-9][0-9]{0,19}$/u.test(result.workflowRunId ?? "") ||
    !/^[1-9][0-9]{0,9}$/u.test(result.workflowRunAttempt ?? "") ||
    result.event !== "push" ||
    result.headBranch !== "main" ||
    result.headSha !== context.sourceSha ||
    result.status !== "completed" ||
    result.conclusion !== "success" ||
    collector?.workflowPath !== result.workflowPath ||
    collector?.runId !== result.workflowRunId ||
    collector?.runAttempt !== result.workflowRunAttempt ||
    collector?.event !== result.event ||
    collector?.headBranch !== result.headBranch ||
    collector?.headSha !== result.headSha ||
    collector?.status !== result.status ||
    collector?.conclusion !== result.conclusion ||
    result.nodeVersion !== "24.19.0" ||
    result.npmVersion !== "11.19.0" ||
    !sameCanonicalValue(result.checks, QUALITY_CHECKS)
  ) {
    throw new Error(
      "Quality workflow run authority is incomplete or mismatched",
    );
  }
};

const assertArtifactDrill = (result, context) => {
  assertExactKeys(
    result,
    [
      "drillNamespace",
      "generatedArchiveSha256",
      "regeneratedArchiveSha256",
      "extractedManifestSha256",
      "providerDeploymentReceiptSha256",
      "providerObservationSha256",
      "controlStoreReceiptSha256",
      "routeProbeCount",
      "casConflictDenied",
      "multiDomainAssignmentVerified",
      "packageRedeployVerified",
      "readerVisibilityDenied",
      "readerWriteDenied",
      "reconcileVerified",
      "outcome",
    ],
    "Artifact/provider/control-store drill result",
  );
  const hashes = [
    result.generatedArchiveSha256,
    result.regeneratedArchiveSha256,
    result.extractedManifestSha256,
    result.providerDeploymentReceiptSha256,
    result.providerObservationSha256,
    result.controlStoreReceiptSha256,
  ];
  hashes.forEach((hash, index) =>
    assertSha256(hash, `Artifact drill hash ${index}`),
  );
  if (
    !NAMESPACE_PATTERN.test(result.drillNamespace ?? "") ||
    result.drillNamespace !== context.subject.drillId ||
    result.drillNamespace === context.releaseContext.namespace ||
    result.generatedArchiveSha256 !== result.regeneratedArchiveSha256 ||
    new Set(hashes.slice(3)).size !== 3 ||
    !Number.isSafeInteger(result.routeProbeCount) ||
    result.routeProbeCount < 1 ||
    result.casConflictDenied !== true ||
    result.multiDomainAssignmentVerified !== true ||
    result.packageRedeployVerified !== true ||
    result.readerVisibilityDenied !== true ||
    result.readerWriteDenied !== true ||
    result.reconcileVerified !== true ||
    result.outcome !== "succeeded"
  ) {
    throw new Error(
      "Artifact/provider/control-store drill evidence is incomplete",
    );
  }
};

const assertRetentionEvidence = (evidence, context) => {
  const policy = context.retentionPolicy;
  const targets = policy.requiredTargets;
  assertExactKeys(
    evidence,
    [
      "schemaVersion",
      "observedAt",
      "lastSuccessByTarget",
      "cronSchedule",
      "cronActive",
      "batchSize",
      "maximumBatchesPerRun",
      "lockTimeoutMilliseconds",
      "statementTimeoutMilliseconds",
      "dryRunByTarget",
      "backupRetentionOwner",
      "collectorIdentity",
    ],
    "Retention evidence",
  );
  const collector = context.collectorAuthority?.receipt;
  assertExactKeys(
    evidence.collectorIdentity,
    ["repository", "workflowPath", "sourceSha", "runId", "runAttempt"],
    "Retention collector identity",
  );
  if (
    policy.activationStatus !== "configured" ||
    (policy.blockerCodes ?? []).length !== 0 ||
    typeof policy.backupRetentionOwner !== "string" ||
    policy.backupRetentionOwner.length === 0 ||
    !Array.isArray(targets) ||
    targets.length === 0 ||
    evidence.schemaVersion !== 1 ||
    evidence.observedAt !== context.entry.observedAt ||
    evidence.cronSchedule !== policy.cron.schedule ||
    evidence.cronActive !== true ||
    evidence.batchSize !== policy.batchSize ||
    evidence.maximumBatchesPerRun !== policy.maximumBatchesPerRun ||
    evidence.lockTimeoutMilliseconds !== policy.lockTimeoutMilliseconds ||
    evidence.statementTimeoutMilliseconds !==
      policy.statementTimeoutMilliseconds ||
    evidence.backupRetentionOwner !== policy.backupRetentionOwner ||
    evidence.collectorIdentity.repository !== collector?.repository ||
    evidence.collectorIdentity.workflowPath !== collector?.workflowPath ||
    evidence.collectorIdentity.sourceSha !== collector?.headSha ||
    evidence.collectorIdentity.sourceSha !== context.sourceSha ||
    evidence.collectorIdentity.runId !== collector?.runId ||
    evidence.collectorIdentity.runAttempt !== collector?.runAttempt ||
    !exactKeys(evidence.lastSuccessByTarget, targets) ||
    !exactKeys(evidence.dryRunByTarget, targets)
  ) {
    throw new Error("Retention evidence differs from configured policy");
  }
  const observedAt = assertCanonicalTimestamp(
    evidence.observedAt,
    "Retention observedAt",
  );
  for (const target of targets) {
    const lastSuccess = assertCanonicalTimestamp(
      evidence.lastSuccessByTarget[target],
      `Retention ${target} last success`,
    );
    const dryRun = evidence.dryRunByTarget[target];
    assertExactKeys(
      dryRun,
      ["succeeded", "affectedRows", "batchCount", "cutoff"],
      `Retention ${target} dry run`,
    );
    const cutoff = assertCanonicalTimestamp(
      dryRun.cutoff,
      `Retention ${target} cutoff`,
    );
    if (
      lastSuccess > observedAt ||
      observedAt - lastSuccess >
        policy.lastSuccessBlockingAfterSeconds * 1_000 ||
      cutoff > observedAt ||
      dryRun.succeeded !== true ||
      !Number.isSafeInteger(dryRun.affectedRows) ||
      dryRun.affectedRows < 0 ||
      !Number.isSafeInteger(dryRun.batchCount) ||
      dryRun.batchCount < 0 ||
      dryRun.batchCount > policy.maximumBatchesPerRun
    ) {
      throw new Error(`Retention ${target} observation is stale or invalid`);
    }
  }
};

const assertBackupRestore = (result, context) => {
  assertExactKeys(
    result,
    [
      "rehearsalId",
      "backupId",
      "backupCompletedAt",
      "restoreStartedAt",
      "restoreCompletedAt",
      "restoredNamespace",
      "sourceHead",
      "restoredHead",
      "integrityCheckSha256",
      "recoveryPointObjectiveSeconds",
      "observedRecoveryPointSeconds",
      "recoveryTimeObjectiveSeconds",
      "observedRecoveryTimeSeconds",
      "dataLossObserved",
      "outcome",
    ],
    "Backup/restore rehearsal result",
  );
  assertNonEmptyString(result.rehearsalId, "Backup rehearsal ID");
  assertNonEmptyString(result.backupId, "Backup ID");
  assertSha256(result.integrityCheckSha256, "Backup integrity check");
  const backupCompletedAt = assertCanonicalTimestamp(
    result.backupCompletedAt,
    "Backup completion",
  );
  const restoreStartedAt = assertCanonicalTimestamp(
    result.restoreStartedAt,
    "Restore start",
  );
  const restoreCompletedAt = assertCanonicalTimestamp(
    result.restoreCompletedAt,
    "Restore completion",
  );
  for (const key of [
    "recoveryPointObjectiveSeconds",
    "observedRecoveryPointSeconds",
    "recoveryTimeObjectiveSeconds",
    "observedRecoveryTimeSeconds",
  ]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) {
      throw new Error(`Backup rehearsal ${key} is invalid`);
    }
  }
  if (
    !NAMESPACE_PATTERN.test(result.restoredNamespace ?? "") ||
    result.restoredNamespace === context.releaseContext.namespace ||
    !sameCanonicalValue(
      result.sourceHead,
      context.releaseContext.releaseStateHead,
    ) ||
    !sameCanonicalValue(result.restoredHead, result.sourceHead) ||
    backupCompletedAt > restoreStartedAt ||
    restoreStartedAt >= restoreCompletedAt ||
    result.observedRecoveryPointSeconds >
      result.recoveryPointObjectiveSeconds ||
    result.observedRecoveryTimeSeconds > result.recoveryTimeObjectiveSeconds ||
    result.observedRecoveryTimeSeconds <
      Math.ceil((restoreCompletedAt - restoreStartedAt) / 1_000) ||
    result.dataLossObserved !== false ||
    result.outcome !== "succeeded"
  ) {
    throw new Error(
      "Backup/restore rehearsal did not meet its bound objectives",
    );
  }
};

const assertStartupWaf = (result, context) => {
  assertExactKeys(
    result,
    [
      "provider",
      "deploymentId",
      "wafConfigurationSha256",
      "profileResults",
      "overLimitProbe",
      "falsePositiveCount",
      "falseNegativeCount",
      "outcome",
    ],
    "Startup WAF observation result",
  );
  bindingForPreparedDeployment(
    context,
    result.deploymentId,
    "Startup WAF deployment",
  );
  assertSha256(result.wafConfigurationSha256, "Startup WAF configuration");
  const profiles = context.startupBurstContract.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error("Startup burst contract has no profiles");
  }
  if (
    context.startupBurstContract.activationStatus !== "configured" ||
    (context.startupBurstContract.blockerCodes ?? []).length !== 0 ||
    result.provider !== context.providerPolicy.provider ||
    !Array.isArray(result.profileResults) ||
    result.profileResults.length !== profiles.length
  ) {
    throw new Error("Startup WAF observation is not bound to active policy");
  }
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    const observed = result.profileResults[index];
    assertExactKeys(
      observed,
      [
        "id",
        "expectedRequestCount",
        "allowedRequestCount",
        "rateLimitedRequestCount",
      ],
      `Startup WAF profile ${profile.id}`,
    );
    const expectedRequestCount = profile.expectedTuples.reduce(
      (sum, tuple) => sum + tuple.maximumCount,
      0,
    );
    if (
      observed.id !== profile.id ||
      observed.expectedRequestCount !== expectedRequestCount ||
      observed.allowedRequestCount !== expectedRequestCount ||
      observed.rateLimitedRequestCount !== 0
    ) {
      throw new Error(`Startup WAF profile ${profile.id} was not preserved`);
    }
  }
  assertExactKeys(
    result.overLimitProbe,
    ["sentRequestCount", "allowedRequestCount", "rateLimitedRequestCount"],
    "Startup WAF over-limit probe",
  );
  if (
    !Number.isSafeInteger(result.overLimitProbe.sentRequestCount) ||
    result.overLimitProbe.sentRequestCount < 2 ||
    !Number.isSafeInteger(result.overLimitProbe.allowedRequestCount) ||
    !Number.isSafeInteger(result.overLimitProbe.rateLimitedRequestCount) ||
    result.overLimitProbe.sentRequestCount !==
      result.overLimitProbe.allowedRequestCount +
        result.overLimitProbe.rateLimitedRequestCount ||
    result.overLimitProbe.rateLimitedRequestCount < 1 ||
    result.falsePositiveCount !== 0 ||
    result.falseNegativeCount !== 0 ||
    result.outcome !== "succeeded"
  ) {
    throw new Error("Startup WAF rate-limit drill is incomplete");
  }
};

const expectedIndexedDbFingerprint = (databaseContract) =>
  sha256Json({
    name: databaseContract.indexedDb.name,
    version: databaseContract.indexedDb.version,
    stores: Object.entries(databaseContract.indexedDb.stores)
      .map(([name, value]) => ({
        indexes: value.indexes,
        keyPath: value.keyPath,
        name,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });

const assertManagedDeviceMultistage = (result, context, authority) => {
  assertExactKeys(
    result,
    [
      "schemaVersion",
      "kind",
      "authority",
      "sourceSha",
      "deviceFingerprintSha256",
      "releaseStateSequenceSha256",
      "stages",
      "result",
    ],
    "Managed device multistage result",
  );
  assertSha256(result.deviceFingerprintSha256, "Managed device fingerprint");
  assertSha256(
    result.releaseStateSequenceSha256,
    "Managed device Release State sequence",
  );
  if (
    result.schemaVersion !== 1 ||
    result.kind !== "managed-device-multistage-authority/v1" ||
    result.authority !== authority ||
    result.sourceSha !== context.sourceSha ||
    !Array.isArray(result.stages) ||
    result.stages.length !== 3
  ) {
    throw new Error("Managed device multistage identity differs");
  }
  const expectedRoles = ["initial-forward", "rollback", "final-forward"];
  const runIds = new Set();
  result.stages.forEach((stage, index) => {
    assertExactKeys(
      stage,
      [
        "role",
        "runId",
        "runAttempt",
        "receiptSha256",
        "activation",
        "bindingId",
        "sourceSha",
      ],
      "Managed device stage result",
    );
    assertSha256(stage.receiptSha256, "Managed device stage receipt");
    assertNonEmptyString(stage.bindingId, "Managed device stage binding");
    runIds.add(stage.runId);
    if (
      stage.role !== expectedRoles[index] ||
      !/^[1-9][0-9]*$/u.test(stage.runId ?? "") ||
      !/^[1-9][0-9]*$/u.test(stage.runAttempt ?? "") ||
      !SOURCE_SHA_PATTERN.test(stage.sourceSha ?? "") ||
      !isRecord(stage.activation)
    ) {
      throw new Error("Managed device stage projection differs");
    }
  });
  assertExactKeys(
    result.result,
    [
      "clientKinds",
      "transitionCount",
      "finalSourceSha",
      "databaseFingerprintSha256",
    ],
    "Managed device aggregate result",
  );
  const expectedDatabaseFingerprint = expectedIndexedDbFingerprint(
    context.databaseContract,
  );
  if (
    runIds.size !== 3 ||
    !sameCanonicalValue(result.result.clientKinds, [
      "browser-tab",
      "installed-pwa",
    ]) ||
    result.result.transitionCount !== 3 ||
    result.result.finalSourceSha !== context.sourceSha ||
    (authority === "pwa-multiclient-drill" &&
      result.result.databaseFingerprintSha256 !== null) ||
    (authority === "idb-device-compatibility" &&
      result.result.databaseFingerprintSha256 !== expectedDatabaseFingerprint)
  ) {
    throw new Error("Managed device aggregate projection differs");
  }
};

const assertPwaMulticlient = (result, context) =>
  assertManagedDeviceMultistage(result, context, "pwa-multiclient-drill");

const assertRequestGraph = (result, context) => {
  assertExactKeys(
    result,
    [
      "deploymentId",
      "graphSha256",
      "totalRequestCount",
      "sameOriginRequestCount",
      "tailwindCdnRequestCount",
      "remoteFontRequestCount",
      "runtimeCssWriteCount",
      "unexpectedOrigins",
      "outcome",
    ],
    "Production request graph result",
  );
  bindingForCurrentAcceptedDeployment(
    context,
    result.deploymentId,
    "Production request graph deployment",
    "P2A-LOCAL",
  );
  assertSha256(result.graphSha256, "Production request graph");
  assertSortedDistinctStrings(
    result.unexpectedOrigins,
    "Production request graph unexpected origins",
  );
  if (
    !Number.isSafeInteger(result.totalRequestCount) ||
    result.totalRequestCount < 1 ||
    !Number.isSafeInteger(result.sameOriginRequestCount) ||
    result.sameOriginRequestCount < 1 ||
    result.sameOriginRequestCount > result.totalRequestCount ||
    result.tailwindCdnRequestCount !== 0 ||
    result.remoteFontRequestCount !== 0 ||
    result.runtimeCssWriteCount !== 0 ||
    result.unexpectedOrigins.length !== 0 ||
    result.outcome !== "succeeded"
  ) {
    throw new Error("Production request graph retains a forbidden remote edge");
  }
};

const assertCspReport = (result, context) => {
  assertExactKeys(
    result,
    [
      "deploymentId",
      "headerName",
      "reportEndpoint",
      "reportRouteStatus",
      "canonicalScenarioCount",
      "unexpectedFirstPartyViolationCount",
      "expectedNoiseCount",
      "storedSanitizedReportCount",
      "databaseFingerprint",
      "methodDenialStatus",
      "phaseStateSha256",
      "preP2BReportRouteStatus",
      "rateLimitConfigured",
      "rateLimitSentRequestCount",
      "rateLimitedRequestCount",
      "wafConfigurationSha256",
      "outcome",
    ],
    "CSP report-only observation result",
  );
  bindingForCurrentAcceptedDeployment(
    context,
    result.deploymentId,
    "CSP report-only deployment",
    "P2B-REPORT",
  );
  if (
    result.headerName !== "Content-Security-Policy-Report-Only" ||
    result.reportEndpoint !== context.cspPolicy.reportEndpoint ||
    result.reportRouteStatus !== 204 ||
    result.methodDenialStatus !== 405 ||
    result.preP2BReportRouteStatus !== 404 ||
    !SHA256_PATTERN.test(result.phaseStateSha256 ?? "") ||
    !SHA256_PATTERN.test(result.wafConfigurationSha256 ?? "") ||
    !Number.isSafeInteger(result.rateLimitConfigured) ||
    result.rateLimitConfigured < 2 ||
    result.rateLimitSentRequestCount !== result.rateLimitConfigured + 1 ||
    !Number.isSafeInteger(result.rateLimitedRequestCount) ||
    result.rateLimitedRequestCount < 1 ||
    result.rateLimitedRequestCount > result.rateLimitSentRequestCount ||
    !Number.isSafeInteger(result.canonicalScenarioCount) ||
    result.canonicalScenarioCount < 1 ||
    result.unexpectedFirstPartyViolationCount !== 0 ||
    !Number.isSafeInteger(result.expectedNoiseCount) ||
    result.expectedNoiseCount < 0 ||
    !Number.isSafeInteger(result.storedSanitizedReportCount) ||
    result.storedSanitizedReportCount < 0 ||
    result.databaseFingerprint !==
      context.releaseContext.dbCompatibility.fingerprint ||
    result.outcome !== "succeeded"
  ) {
    throw new Error("CSP report-only flow evidence is incomplete");
  }
};

const assertDeployedCsp = (result, context) => {
  assertExactKeys(
    result,
    [
      "deploymentId",
      "headerName",
      "policySha256",
      "reportEndpoint",
      "reportRouteStatus",
      "flows",
      "unexpectedViolationCount",
      "outcome",
    ],
    "Deployed CSP flow result",
  );
  bindingForCurrentAcceptedDeployment(
    context,
    result.deploymentId,
    "Deployed CSP flow deployment",
    "P4-CSP",
  );
  assertSha256(result.policySha256, "Deployed CSP policy");
  if (
    !Array.isArray(result.flows) ||
    result.flows.length !== CSP_FLOW_IDS.length
  ) {
    throw new Error("Deployed CSP flow set is incomplete");
  }
  const flowIds = [];
  for (const flow of result.flows) {
    assertExactKeys(flow, ["id", "outcome"], "Deployed CSP flow");
    flowIds.push(flow.id);
    if (flow.outcome !== "succeeded") {
      throw new Error(`Deployed CSP flow ${flow.id} failed`);
    }
  }
  assertSortedDistinctStrings(flowIds, "Deployed CSP flow IDs", {
    nonEmpty: true,
  });
  if (
    result.headerName !== "Content-Security-Policy" ||
    result.policySha256 !== sha256Json(context.cspPolicy) ||
    result.reportEndpoint !== context.cspPolicy.reportEndpoint ||
    result.reportRouteStatus !== 204 ||
    !sameCanonicalValue(flowIds, CSP_FLOW_IDS) ||
    result.unexpectedViolationCount !== 0 ||
    result.outcome !== "succeeded"
  ) {
    throw new Error("Deployed CSP enforcement evidence differs from policy");
  }
};

const assertIdbCompatibility = (result, context) =>
  assertManagedDeviceMultistage(result, context, "idb-device-compatibility");

const CUSTOM_VALIDATORS = Object.freeze({
  "external-bindings": assertExternalBindings,
  "bootstrap-recovery-drill": assertBootstrapRecoveryDrill,
  "quality-run": assertQualityRun,
  "artifact-provider-control-store-drill": assertArtifactDrill,
  "backup-restore-rehearsal": assertBackupRestore,
  "startup-waf-observation": assertStartupWaf,
  "pwa-multiclient-drill": assertPwaMulticlient,
  "production-request-graph": assertRequestGraph,
  "csp-report-observation": assertCspReport,
  "deployed-csp-flow": assertDeployedCsp,
  "idb-device-compatibility": assertIdbCompatibility,
});

const baselineRecoveryResult = (rehearsal) => ({
  drillId: `${rehearsal.runId}:${rehearsal.runAttempt}`,
  startedAt: rehearsal.startedAt,
  completedAt: rehearsal.completedAt,
  recoveryBindingId: rehearsal.recoveryBindingId,
  recoveryDeploymentId: rehearsal.recoveryDeploymentId,
  rawDistManifestSha256: rehearsal.rawDistManifestSha256,
  artifactArchiveSha256: rehearsal.artifactArchiveSha256,
  restoredArtifactSha256: rehearsal.restoredArtifactSha256,
  recoveryTimeSeconds: rehearsal.recoveryTimeSeconds,
  dataLossObserved: rehearsal.dataLossObserved,
  outcome: rehearsal.outcome,
});

export const buildFoundationBaselinePhaseExitEvidence = ({
  authorityReadback,
  subject,
  sourceSha,
  providerPolicy,
  approvalPolicy,
  storePolicy,
  databaseContract,
}) => {
  const closure = authorityReadback?.closure;
  const rehearsal = authorityReadback?.recoveryRehearsal;
  const collectorAuthority = authorityReadback?.reference;
  const bootstrap = subject?.deployments?.bootstrapRecovery;
  assertReference(
    collectorAuthority,
    subject?.namespace,
    "Foundation baseline closure collector authority",
  );
  if (
    !isRecord(closure) ||
    !isRecord(rehearsal) ||
    !SOURCE_SHA_PATTERN.test(sourceSha ?? "") ||
    closure.closureSource?.gitCommitSha !== sourceSha ||
    bootstrap === null ||
    bootstrap?.bindingId !== authorityReadback.bootstrapBinding?.bindingId ||
    bootstrap?.sourceSha !== authorityReadback.bootstrapBinding?.sourceSha ||
    bootstrap?.providerDeploymentId !==
      authorityReadback.bootstrapBinding?.providerDeploymentId ||
    bootstrap?.artifactArchiveSha256 !==
      authorityReadback.bootstrapBinding?.artifactArchive?.sha256
  ) {
    throw new Error("Foundation baseline phase authority binding differs");
  }
  const context = {
    subject,
    sourceSha,
    providerPolicy,
    approvalPolicy,
    storePolicy,
    databaseContract,
  };
  const definitions = [
    {
      authority: "external-bindings",
      observedAt: closure.observedAt,
      result: externalBindingsResult(context),
    },
    {
      authority: "bootstrap-recovery-drill",
      observedAt: rehearsal.completedAt,
      result: baselineRecoveryResult(rehearsal),
    },
  ];
  return new Map(
    definitions.map(({ authority, observedAt, result }) => {
      const definition = AUTHORITY_BY_ID.get(authority);
      const value = {
        schemaVersion: 1,
        evidenceKind: definition.kind,
        gate: definition.gate,
        authority,
        sourceSha,
        observedAt,
        subject,
        collectorAuthority,
        result,
      };
      CUSTOM_VALIDATORS[authority](result, context);
      return [
        authority,
        Object.freeze({
          observedAt,
          value: Object.freeze(structuredClone(value)),
          bytes: canonicalJsonBytes(value),
        }),
      ];
    }),
  );
};

const assertCustomEvidence = ({ value, definition, entry, context }) => {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "evidenceKind",
      "gate",
      "authority",
      "sourceSha",
      "observedAt",
      "subject",
      "collectorAuthority",
      "result",
    ],
    `${definition.authority} evidence`,
  );
  if (
    value.schemaVersion !== 1 ||
    value.evidenceKind !== definition.kind ||
    value.gate !== definition.gate ||
    value.authority !== definition.authority ||
    value.sourceSha !== context.sourceSha ||
    value.observedAt !== entry.observedAt ||
    !sameCanonicalValue(value.subject, context.subject) ||
    !sameCanonicalValue(value.collectorAuthority, entry.collectorAuthority)
  ) {
    throw new Error(`${definition.authority} evidence binding differs`);
  }
  CUSTOM_VALIDATORS[definition.authority](value.result, context);
};

const assertPerformanceEvidence = ({ bytes, reference, entry, context }) => {
  const artifact = assertReviewedPerformanceArtifactForAcceptedGate({
    acceptedGate: "P0-RELEASE",
    bytes,
    expectedSha256: reference.sha256,
    label: "P0 physical performance evidence",
  });
  const receipt = artifact.value.producerReceipt.receipt;
  if (
    artifact.value.evidence.gate !== "P0-TOOLCHAIN" ||
    artifact.value.evidence.source?.gitCommitSha !== context.sourceSha ||
    artifact.value.evidence.source?.treeState !== "clean" ||
    receipt.namespace !== context.releaseContext.namespace ||
    receipt.source?.gitCommitSha !== context.sourceSha ||
    receipt.producerRunId !== context.collectorAuthority?.receipt?.runId ||
    receipt.producerRunAttempt !==
      context.collectorAuthority?.receipt?.runAttempt ||
    entry.observedAt !== receipt.producedAtUtc ||
    !context.current.records.some(
      ({ sequence, eventHash }) =>
        sequence === receipt.authoritativeState.sequence &&
        eventHash === receipt.authoritativeState.eventHash,
    )
  ) {
    throw new Error("P0 physical performance authority binding differs");
  }
};

const assertRemoteDbEvidence = ({ observation, production, entry }) => {
  if (
    observation.observedAt !== entry.observedAt ||
    !sameCanonicalValue(
      production.authority.reviewedWorkflowRun,
      entry.collectorAuthority,
    ) ||
    !sameCanonicalValue(production.authority.observation, entry.evidence)
  ) {
    throw new Error("Remote DB observation timestamp differs from its bundle");
  }
};

const readBrowserCollectorEvidence = async ({
  definition,
  collectorAuthority,
  store,
  namespace,
  sourceSha,
  subject,
  releaseContext,
  current,
  providerPolicy,
  approvalPolicy,
  storePolicy,
  cspPolicy,
  startupBurstContract,
  backupRestorePrerequisitePolicy,
  backupRestoreProviderContract,
  artifactDrillPolicy,
  p0aPolicy,
  releasePolicy,
  toolchainPolicy,
  foundationBaseline,
  databaseContract,
}) => {
  const observation = parseCanonicalObject(
    collectorAuthority.fileBytes,
    `${definition.authority} collector observation`,
  );
  const workflowRun = collectorAuthority.receipt;
  if (definition.authority === "external-bindings") {
    assertFoundationExternalBindingsObservation(observation);
    const raw = await readStoredFoundationExternalBindingsAuthority({
      store,
      namespace,
      reference: observation.rawAuthority,
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
    });
    if (
      observation.namespace !== namespace ||
      observation.sourceSha !== sourceSha ||
      observation.collectorIdentity.runId !== workflowRun.runId ||
      observation.collectorIdentity.runAttempt !== workflowRun.runAttempt ||
      !sameCanonicalValue(
        observation.oidcReceipt,
        raw.raw.collector.oidcReceipt,
      ) ||
      !sameCanonicalValue(observation.result, raw.result)
    ) {
      throw new Error(
        "Foundation external binding collector authority differs",
      );
    }
    return { observation, raw };
  }
  if (definition.authority === "bootstrap-recovery-drill") {
    assertFoundationBootstrapRecoveryObservation(observation);
    const bootstrapSourceResolution = resolveBootstrapFoundationSource({
      bootstrapSourceSha: p0aPolicy.bootstrapRecovery.bootstrapSourceSha,
      cwd: repositoryRoot,
    });
    const raw = await readStoredFoundationBootstrapRecoveryAuthority({
      store,
      namespace,
      reference: observation.rawAuthority,
      p0aPolicy,
      providerPolicy,
      databaseContract,
      storePolicy,
      approvalPolicy,
      foundationBaseline,
      toolchainPolicy,
      bootstrapSourceResolution,
    });
    if (
      observation.namespace !== namespace ||
      observation.sourceSha !== sourceSha ||
      observation.collectorIdentity.runId !== workflowRun.runId ||
      observation.collectorIdentity.runAttempt !== workflowRun.runAttempt ||
      !sameCanonicalValue(
        observation.oidcReceipt,
        raw.raw.collector.oidcReceipt,
      ) ||
      !sameCanonicalValue(observation.rehearsalAuthority, raw.raw.rehearsal) ||
      !sameCanonicalValue(
        observation.stateInitializationSubject,
        raw.stateInitializationSubject,
      ) ||
      !sameCanonicalValue(observation.result, raw.result)
    ) {
      throw new Error(
        "Foundation bootstrap recovery collector authority differs",
      );
    }
    return { observation, raw };
  }
  if (definition.authority === "artifact-provider-control-store-drill") {
    const readback = await readArtifactControlStoreDrillClosure({
      bytes: collectorAuthority.fileBytes,
      approvalPolicy,
      providerPolicy,
      artifactDrillPolicy,
      releasePolicy,
      toolchainPolicy,
      dbContract: databaseContract,
      cspPolicy,
      foundationBaseline,
      expectedSourceSha: sourceSha,
      expectedRunId: workflowRun.runId,
      expectedRunAttempt: workflowRun.runAttempt,
    });
    if (
      readback.closure.productionNamespace !== namespace ||
      readback.closure.observation.sourceSha !== sourceSha ||
      readback.closure.drillNamespace !== subject.drillId
    ) {
      throw new Error("Artifact drill closure production authority differs");
    }
    return {
      observation: readback.closure.observation,
      raw: readback,
    };
  }
  if (definition.authority === "backup-restore-rehearsal") {
    assertBackupRestoreRehearsalObservation(observation);
    const raw = await readStoredBackupRestoreRehearsalAuthority({
      store,
      namespace,
      reference: observation.rawRehearsal,
      prerequisitePolicy: backupRestorePrerequisitePolicy,
      providerContract: backupRestoreProviderContract,
      current,
      sourceSha,
      approvalPolicy,
      runId: workflowRun.runId,
      runAttempt: workflowRun.runAttempt,
    });
    if (
      !sameCanonicalValue(
        observation.collectorIdentity,
        raw.raw.collector.identity,
      ) ||
      !sameCanonicalValue(
        observation.oidcReceipt,
        raw.raw.collector.oidcReceipt,
      ) ||
      !sameCanonicalValue(
        observation.releaseStateHead,
        raw.raw.releaseStateHead,
      ) ||
      observation.observedAt !== raw.raw.observedAt ||
      !sameCanonicalValue(observation.result, raw.result)
    ) {
      throw new Error(
        "Backup rehearsal collector output differs from raw immutable authority",
      );
    }
    return { observation, raw };
  }
  if (definition.authority === "startup-waf-observation") {
    assertExactKeys(
      observation,
      [
        "schemaVersion",
        "resultKind",
        "namespace",
        "sourceSha",
        "workflowRunId",
        "runAttempt",
        "mediaTypes",
        "authority",
        "transcript",
      ],
      "Startup WAF collector result",
    );
    if (
      observation.schemaVersion !== 1 ||
      observation.resultKind !== "startup-waf-observation-stored/v1" ||
      observation.namespace !== namespace ||
      observation.sourceSha !== sourceSha ||
      observation.workflowRunId !== workflowRun.runId ||
      observation.runAttempt !== workflowRun.runAttempt ||
      workflowRun.headSha !== sourceSha ||
      observation.mediaTypes?.authority !== STARTUP_WAF_OBSERVATION_MEDIA_TYPE
    ) {
      throw new Error("Startup WAF collector result binding differs");
    }
    assertReference(
      observation.authority,
      namespace,
      "Startup WAF immutable authority",
    );
    const [metricsContract, fixtures] = await Promise.all([
      readJsonStrict(
        path.join(
          repositoryRoot,
          "contracts",
          "persistence-release-a-metrics-v1.json",
        ),
      ),
      loadStartupWafFixtures({
        startupContract: startupBurstContract,
        root: repositoryRoot,
      }),
    ]);
    const raw = await readStartupWafObservationAuthority({
      store,
      namespace,
      reference: observation.authority,
      expectedSourceSha: sourceSha,
      providerPolicy,
      approvalPolicy,
      startupContract: startupBurstContract,
      metricsContract,
      fixtures,
      requireCurrentBinding: true,
      readState: async () => current,
    });
    bindingForPreparedDeployment(
      { subject, releaseContext, sourceSha },
      raw.result.deploymentId,
      "Startup WAF deployment",
    );
    if (
      !sameCanonicalValue(observation.transcript, raw.authority.transcript) ||
      raw.transcript.releaseState.sequence !==
        subject.releaseStateHead.sequence ||
      raw.transcript.releaseState.eventHash !==
        subject.releaseStateHead.eventHash ||
      raw.authority.runId !== workflowRun.runId ||
      raw.authority.runAttempt !== workflowRun.runAttempt
    ) {
      throw new Error("Startup WAF immutable authority differs from its run");
    }
    return {
      observation: {
        namespace,
        sourceSha,
        observedAt: raw.transcript.collectedAt,
        releaseStateHead: subject.releaseStateHead,
        result: raw.result,
      },
      raw,
    };
  }
  const commonMismatch =
    observation.namespace !== namespace ||
    observation.sourceSha !== sourceSha ||
    observation.collectorIdentity?.repository !== workflowRun?.repository ||
    observation.collectorIdentity?.workflowPath !==
      definition.collectorWorkflowPath ||
    observation.collectorIdentity?.workflowPath !== workflowRun?.workflowPath ||
    observation.collectorIdentity?.sourceSha !== sourceSha ||
    observation.collectorIdentity?.sourceSha !== workflowRun?.sourceSha ||
    observation.collectorIdentity?.runId !== workflowRun?.runId ||
    observation.collectorIdentity?.runAttempt !== workflowRun?.runAttempt ||
    !sameCanonicalValue(
      observation.releaseStateHead,
      subject.releaseStateHead,
    ) ||
    workflowRun?.headSha !== sourceSha;
  if (definition.authority === "production-request-graph") {
    assertProductionRequestGraphObservation(observation);
    const [raw] = await Promise.all([
      readStoredProductionRequestGraph({
        store,
        namespace,
        reference: observation.rawGraph,
      }),
      readStoredProductionRequestGraphOidcAuthority({
        store,
        namespace,
        reference: observation.oidcReceipt,
        approvalPolicy,
        sourceSha,
        runId: workflowRun.runId,
        runAttempt: workflowRun.runAttempt,
      }),
    ]);
    assertCurrentAcceptedPhaseExitDeployment({
      releaseContext,
      sourceSha,
      deploymentId: observation.result.deploymentId,
      minimumAcceptedGate: "P2A-LOCAL",
    });
    if (
      commonMismatch ||
      observation.binding.selection !== "active-production" ||
      !sameCanonicalValue(observation.binding, raw.raw.binding) ||
      !sameCanonicalValue(
        observation.releaseStateHead,
        raw.raw.releaseStateHead,
      ) ||
      observation.observedAt !== raw.raw.observedAt ||
      !sameCanonicalValue(observation.result, raw.result)
    ) {
      throw new Error(
        "Production request graph observation differs from live raw authority",
      );
    }
    return { observation, raw };
  }
  if (definition.authority === "deployed-csp-flow") {
    assertDeployedCspFlowObservation(observation);
    const [raw] = await Promise.all([
      readStoredDeployedCspFlow({
        store,
        namespace,
        reference: observation.rawTrace,
        cspPolicy,
      }),
      readStoredProductionRequestGraphOidcAuthority({
        store,
        namespace,
        reference: observation.oidcReceipt,
        approvalPolicy,
        sourceSha,
        runId: workflowRun.runId,
        runAttempt: workflowRun.runAttempt,
      }),
    ]);
    assertCurrentAcceptedPhaseExitDeployment({
      releaseContext,
      sourceSha,
      deploymentId: observation.result.deploymentId,
      minimumAcceptedGate: "P4-CSP",
    });
    if (
      commonMismatch ||
      observation.binding.selection !== "active-production" ||
      !sameCanonicalValue(observation.binding, raw.raw.binding) ||
      !sameCanonicalValue(
        observation.releaseStateHead,
        raw.raw.releaseStateHead,
      ) ||
      observation.observedAt !== raw.raw.observedAt ||
      !sameCanonicalValue(observation.result, raw.result)
    ) {
      throw new Error(
        "Deployed CSP observation differs from live raw authority",
      );
    }
    return { observation, raw };
  }
  if (definition.authority === "csp-report-observation") {
    assertCspReportObservation(observation);
    const [raw] = await Promise.all([
      readStoredCspReportObservationAuthority({
        store,
        namespace,
        reference: observation.rawObservation,
        cspPolicy,
        providerPolicy,
        current,
        sourceSha,
      }),
      readStoredProductionRequestGraphOidcAuthority({
        store,
        namespace,
        reference: observation.oidcReceipt,
        approvalPolicy,
        sourceSha,
        runId: workflowRun.runId,
        runAttempt: workflowRun.runAttempt,
      }),
    ]);
    assertCurrentAcceptedPhaseExitDeployment({
      releaseContext,
      sourceSha,
      deploymentId: observation.result.deploymentId,
      minimumAcceptedGate: "P2B-REPORT",
    });
    if (
      commonMismatch ||
      observation.binding.selection !== "active-production" ||
      observation.result.databaseFingerprint !==
        releaseContext.dbCompatibility.fingerprint ||
      !sameCanonicalValue(observation.binding, raw.raw.binding) ||
      !sameCanonicalValue(
        observation.releaseStateHead,
        raw.raw.releaseStateHead,
      ) ||
      observation.observedAt !== raw.raw.observedAt ||
      !sameCanonicalValue(observation.result, raw.result)
    ) {
      throw new Error("CSP report observation differs from live raw authority");
    }
    return { observation, raw };
  }
  throw new Error("Browser phase authority collector kind is invalid");
};

export const readPhaseExitArtifactCollectorEvidence = async (options) => {
  const definition = AUTHORITY_BY_ID.get(options?.authority);
  if (definition?.collectorArtifact === undefined) {
    throw new Error("Phase exit artifact collector authority is invalid");
  }
  return readBrowserCollectorEvidence({ ...options, definition });
};

export const buildManagedDevicePhaseExitEvidence = ({
  authority,
  authorityReadback,
  stageSetReadback,
  collectorAuthority,
  subject,
  sourceSha,
  databaseContract,
}) => {
  const readback = stageSetReadback ?? authorityReadback;
  const definition = AUTHORITY_BY_ID.get(authority);
  const aggregated = readback?.aggregated;
  const finalStage = aggregated?.stages?.at(-1);
  const requiresPwaFormalClosure = authority === "pwa-multiclient-drill";
  const expectedCollectorAuthorityKind = requiresPwaFormalClosure
    ? "pwa-reviewed-formal-closure"
    : "managed-device-reviewed-stage-set";
  const formalClosure = readback?.formalClosure;
  const pwaFormalClosureMatches =
    !requiresPwaFormalClosure ||
    (exactKeys(formalClosure, [
      "authority",
      "kind",
      "reference",
      "sourceSha",
      "stageSetAuthority",
      "strictReceiptArtifactAuthority",
      "strictReceiptSha256",
    ]) &&
      formalClosure.kind === PWA_REVIEWED_FORMAL_CLOSURE_KIND &&
      formalClosure.authority === authority &&
      formalClosure.sourceSha === sourceSha &&
      sameCanonicalValue(formalClosure.reference, collectorAuthority) &&
      exactKeys(formalClosure.stageSetAuthority, ["sha256", "uri"]) &&
      exactKeys(formalClosure.strictReceiptArtifactAuthority, [
        "sha256",
        "uri",
      ]) &&
      SHA256_PATTERN.test(formalClosure.stageSetAuthority.sha256 ?? "") &&
      SHA256_PATTERN.test(
        formalClosure.strictReceiptArtifactAuthority.sha256 ?? "",
      ) &&
      SHA256_PATTERN.test(formalClosure.strictReceiptSha256 ?? ""));
  if (
    !["pwa-multiclient-drill", "idb-device-compatibility"].includes(
      authority,
    ) ||
    definition?.collectorAuthorityKind !== expectedCollectorAuthorityKind ||
    !pwaFormalClosureMatches ||
    aggregated?.document?.authority !== authority ||
    aggregated.document.sourceSha !== sourceSha ||
    aggregated.sha256 !== sha256Json(aggregated.document) ||
    !sameCanonicalValue(readback?.setReceipt?.reference, collectorAuthority) ||
    typeof finalStage?.payload?.observedAt !== "string"
  ) {
    throw new Error("Managed device phase authority readback differs");
  }
  const observedAt = finalStage.payload.observedAt;
  const value = {
    schemaVersion: 1,
    evidenceKind: definition.kind,
    gate: definition.gate,
    authority,
    sourceSha,
    observedAt,
    subject,
    collectorAuthority,
    result: aggregated.document,
  };
  CUSTOM_VALIDATORS[authority](value.result, {
    sourceSha,
    databaseContract,
  });
  return Object.freeze({
    observedAt,
    value: Object.freeze(structuredClone(value)),
    bytes: canonicalJsonBytes(value),
  });
};

export const buildBrowserPhaseExitEvidence = ({
  authority,
  observation,
  collectorAuthority,
  subject,
  sourceSha,
}) => {
  const definition = AUTHORITY_BY_ID.get(authority);
  if (
    (!DERIVED_REVIEWED_ARTIFACT_AUTHORITIES.has(authority) &&
      !["external-bindings", "bootstrap-recovery-drill"].includes(authority)) ||
    definition?.collectorImplemented !== true
  ) {
    throw new Error("Browser phase authority evidence kind is invalid");
  }
  if (authority === "external-bindings") {
    assertFoundationExternalBindingsObservation(observation);
  } else if (authority === "bootstrap-recovery-drill") {
    assertFoundationBootstrapRecoveryObservation(observation);
  } else if (authority === "production-request-graph") {
    assertProductionRequestGraphObservation(observation);
  } else if (authority === "backup-restore-rehearsal") {
    assertBackupRestoreRehearsalObservation(observation);
  } else if (authority === "deployed-csp-flow") {
    assertDeployedCspFlowObservation(observation);
  } else if (authority === "csp-report-observation") {
    assertCspReportObservation(observation);
  }
  if (
    observation.sourceSha !== sourceSha ||
    ([
      "production-request-graph",
      "csp-report-observation",
      "deployed-csp-flow",
    ].includes(authority) &&
      !sameCanonicalValue(
        observation.releaseStateHead,
        subject.releaseStateHead,
      ))
  ) {
    throw new Error("Browser phase authority observation binding differs");
  }
  const value = {
    schemaVersion: 1,
    evidenceKind: definition.kind,
    gate: definition.gate,
    authority,
    sourceSha,
    observedAt: observation.observedAt,
    subject,
    collectorAuthority,
    result: [
      "csp-report-observation",
      "artifact-provider-control-store-drill",
    ].includes(authority)
      ? Object.fromEntries(
          Object.entries(observation.result).filter(
            ([key]) => key !== "rawSha256" && key !== "collectorIdentitySha256",
          ),
        )
      : observation.result,
  };
  return Object.freeze({
    observedAt: observation.observedAt,
    value: Object.freeze(structuredClone(value)),
    bytes: canonicalJsonBytes(value),
  });
};

const assertEntryEvidence = ({
  stored,
  remoteObservation,
  remoteProduction,
  definition,
  entry,
  context,
}) => {
  const collectorArtifact = context.collectorAuthority?.artifactReceipt;
  if (
    definition.collectorArtifact !== undefined &&
    definition.authority !== "quality-run" &&
    definition.authority !== "external-bindings" &&
    definition.authority !== "bootstrap-recovery-drill" &&
    definition.authority !== "startup-waf-observation" &&
    definition.authority !== "artifact-provider-control-store-drill" &&
    definition.authority !== "backup-restore-rehearsal" &&
    definition.authority !== "production-request-graph" &&
    definition.authority !== "csp-report-observation" &&
    definition.authority !== "deployed-csp-flow" &&
    (!sameCanonicalValue(collectorArtifact?.artifactFile, entry.evidence) ||
      !Buffer.isBuffer(context.collectorAuthority?.fileBytes) ||
      !context.collectorAuthority.fileBytes.equals(stored.bytes))
  ) {
    throw new Error(
      `${definition.authority} evidence differs from its fixed collector artifact`,
    );
  }
  if (definition.authority === "physical-performance") {
    assertPerformanceEvidence({
      bytes: stored.bytes,
      reference: entry.evidence,
      entry,
      context,
    });
    return;
  }
  if (definition.authority === "remote-db") {
    assertRemoteDbEvidence({
      observation: remoteObservation,
      production: remoteProduction,
      entry,
    });
    return;
  }
  const value = parseCanonicalObject(
    stored.bytes,
    `${definition.authority} evidence`,
  );
  if (definition.collectorAuthorityKind === "foundation-baseline-closure") {
    const expected = buildFoundationBaselinePhaseExitEvidence({
      authorityReadback: context.collectorAuthority,
      subject: context.subject,
      sourceSha: context.sourceSha,
      providerPolicy: context.providerPolicy,
      approvalPolicy: context.approvalPolicy,
      storePolicy: context.storePolicy,
      databaseContract: context.databaseContract,
    }).get(definition.authority);
    if (
      !expected.bytes.equals(stored.bytes) ||
      expected.observedAt !== entry.observedAt
    ) {
      throw new Error(
        `${definition.authority} differs from the live baseline closure`,
      );
    }
    assertCustomEvidence({
      value,
      definition,
      entry,
      context: { ...context, entry },
    });
  } else if (
    [
      "managed-device-reviewed-stage-set",
      "pwa-reviewed-formal-closure",
    ].includes(definition.collectorAuthorityKind)
  ) {
    const expected = buildManagedDevicePhaseExitEvidence({
      authority: definition.authority,
      authorityReadback: context.collectorAuthority,
      collectorAuthority: entry.collectorAuthority,
      subject: context.subject,
      sourceSha: context.sourceSha,
      databaseContract: context.databaseContract,
    });
    if (
      !expected.bytes.equals(stored.bytes) ||
      expected.observedAt !== entry.observedAt
    ) {
      throw new Error(
        `${definition.authority} differs from reviewed managed device stages`,
      );
    }
    assertCustomEvidence({
      value,
      definition,
      entry,
      context: { ...context, entry },
    });
  } else if (DERIVED_REVIEWED_ARTIFACT_AUTHORITIES.has(definition.authority)) {
    const expected = buildBrowserPhaseExitEvidence({
      authority: definition.authority,
      observation: context.browserAuthority?.observation,
      collectorAuthority: entry.collectorAuthority,
      subject: context.subject,
      sourceSha: context.sourceSha,
    });
    if (
      !expected.bytes.equals(stored.bytes) ||
      expected.observedAt !== entry.observedAt
    ) {
      throw new Error(
        `${definition.authority} derived evidence differs from its raw observation`,
      );
    }
    assertCustomEvidence({
      value,
      definition,
      entry,
      context: { ...context, entry },
    });
  } else if (definition.authority === "retention") {
    assertRetentionEvidence(value, { ...context, entry });
  } else {
    assertCustomEvidence({
      value,
      definition,
      entry,
      context: { ...context, entry },
    });
  }
};

const assertBundleShape = ({
  bundle,
  namespace,
  sourceSha,
  subject,
  releaseContext,
  nowMilliseconds,
}) => {
  assertExactKeys(
    bundle,
    [
      "schemaVersion",
      "kind",
      "namespace",
      "sourceSha",
      "releaseStateHead",
      "createdAt",
      "targetGate",
      "entries",
    ],
    "Phase authority bundle",
  );
  if (
    bundle.schemaVersion !== 1 ||
    bundle.kind !== "phase-exit-external-authority-bundle/v1" ||
    bundle.namespace !== namespace ||
    bundle.sourceSha !== sourceSha ||
    !sameCanonicalValue(
      bundle.releaseStateHead,
      releaseContext.releaseStateHead,
    ) ||
    !Array.isArray(bundle.entries) ||
    !FORMAL_EXTERNAL_AUTHORITY_GATES.has(bundle.targetGate)
  ) {
    throw new Error("Phase authority bundle identity differs from live state");
  }
  assertFreshTimestamp({
    value: bundle.createdAt,
    label: "Phase authority bundle createdAt",
    maximumAgeSeconds: BUNDLE_MAXIMUM_AGE_MILLISECONDS / 1_000,
    nowMilliseconds,
  });

  const authorities = new Set();
  const hashes = new Set();
  let previousIndex = -1;
  for (const entry of bundle.entries) {
    assertExactKeys(
      entry,
      [
        "gate",
        "authority",
        "sourceSha",
        "observedAt",
        "subject",
        "collectorAuthority",
        "productionAuthority",
        "evidence",
      ],
      "Phase authority bundle entry",
    );
    const definition = AUTHORITY_BY_ID.get(entry.authority);
    if (definition?.collectorImplemented !== true) {
      throw new Error(
        `${entry?.gate ?? "unknown"}/${entry?.authority ?? "unknown"} has no implemented production collector authority`,
      );
    }
    if (
      definition === undefined ||
      entry.gate !== definition.gate ||
      entry.sourceSha !== sourceSha ||
      definition.index <= previousIndex ||
      authorities.has(entry.authority)
    ) {
      throw new Error(
        "Phase authority bundle has a wrong, duplicate, or unordered entry",
      );
    }
    assertSubject({ subject: entry.subject, expected: subject });
    assertReference(
      entry.collectorAuthority,
      namespace,
      `${entry.gate}/${entry.authority} collector authority`,
    );
    if (definition.authority === "remote-db") {
      assertReference(
        entry.productionAuthority,
        namespace,
        `${entry.gate}/${entry.authority} production authority`,
      );
    } else if (entry.productionAuthority !== null) {
      throw new Error(
        `${entry.gate}/${entry.authority} has an unrelated production authority`,
      );
    }
    assertReference(
      entry.evidence,
      namespace,
      `${entry.gate}/${entry.authority}`,
    );
    if (hashes.has(entry.evidence.sha256)) {
      throw new Error(
        "Phase authority bundle reuses one object for two authorities",
      );
    }
    assertFreshTimestamp({
      value: entry.observedAt,
      label: `${entry.gate}/${entry.authority} observedAt`,
      maximumAgeSeconds: definition.maximumAgeSeconds,
      nowMilliseconds,
    });
    previousIndex = definition.index;
    authorities.add(entry.authority);
    hashes.add(entry.evidence.sha256);
  }
  if (
    bundle.entries.length === 0 ||
    bundle.entries.some(({ gate }) => gate !== bundle.targetGate)
  ) {
    throw new Error(
      "Phase authority bundle contains an empty or cross-gate input set",
    );
  }
  return bundle.entries.map((entry) => ({
    entry,
    definition: AUTHORITY_BY_ID.get(entry.authority),
  }));
};

const assertResolverOptions = (options) => {
  assertExactKeys(
    options,
    [
      "store",
      "bundleSha256",
      "current",
      "sourceSha",
      "providerPolicy",
      "approvalPolicy",
      "storePolicy",
      "databaseContract",
      "retentionPolicy",
      "startupBurstContract",
      "cspPolicy",
      "backupRestorePrerequisitePolicy",
      "backupRestoreProviderContract",
      "artifactDrillPolicy",
      "p0aPolicy",
      "releasePolicy",
      "toolchainPolicy",
      "foundationBaseline",
      "currentWorkflowRunId",
    ],
    "External phase authority resolver options",
  );
  if (
    !options.store ||
    typeof options.store.readEvidence !== "function" ||
    !NAMESPACE_PATTERN.test(options.store.namespace ?? "") ||
    !SHA256_PATTERN.test(options.bundleSha256 ?? "") ||
    !SOURCE_SHA_PATTERN.test(options.sourceSha ?? "") ||
    (options.currentWorkflowRunId !== null &&
      !/^[1-9][0-9]{0,19}$/u.test(options.currentWorkflowRunId ?? ""))
  ) {
    throw new Error("External phase authority resolver identity is invalid");
  }
};

export const resolveExternalPhaseExitAuthorities = async (options) => {
  assertResolverOptions(options);
  const nowMilliseconds = Date.now();
  const releaseContext = projectPhaseExitAuthorityReleaseContext({
    current: options.current,
    namespace: options.store.namespace,
  });
  const namespace = releaseContext.namespace;
  if (namespace !== options.store.namespace) {
    throw new Error("External phase authority store namespace differs");
  }
  const bundleReference = {
    uri: `release-state://${namespace}/evidence/${options.bundleSha256}`,
    sha256: options.bundleSha256,
  };
  const storedBundle = await readStoredObject({
    store: options.store,
    namespace,
    reference: bundleReference,
    expectedMediaType: PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
    label: "Phase authority bundle",
    nowMilliseconds,
  });
  const bundle = parseCanonicalObject(
    storedBundle.bytes,
    "Phase authority bundle",
  );
  const subject = projectPhaseExitAuthoritySubject({
    current: options.current,
    targetGate: bundle.targetGate,
    sourceSha: options.sourceSha,
    drillId:
      bundle.targetGate === "P0-ARTIFACT"
        ? bundle.entries?.[0]?.subject?.drillId
        : null,
    foundationBaseline: options.foundationBaseline,
    p0aPolicy: options.p0aPolicy,
  });
  const entries = assertBundleShape({
    bundle,
    namespace,
    sourceSha: options.sourceSha,
    subject,
    releaseContext,
    nowMilliseconds,
  });
  if (
    storedBundle.committedAtMilliseconds + FUTURE_SKEW_MILLISECONDS <
    Date.parse(bundle.createdAt)
  ) {
    throw new Error(
      "Phase authority bundle predates its claimed creation time",
    );
  }
  const context = {
    current: options.current,
    sourceSha: options.sourceSha,
    subject,
    releaseContext,
    providerPolicy: options.providerPolicy,
    approvalPolicy: options.approvalPolicy,
    storePolicy: options.storePolicy,
    databaseContract: options.databaseContract,
    retentionPolicy: options.retentionPolicy,
    startupBurstContract: options.startupBurstContract,
    cspPolicy: options.cspPolicy,
    backupRestorePrerequisitePolicy: options.backupRestorePrerequisitePolicy,
    backupRestoreProviderContract: options.backupRestoreProviderContract,
    artifactDrillPolicy: options.artifactDrillPolicy,
    p0aPolicy: options.p0aPolicy,
    releasePolicy: options.releasePolicy,
    toolchainPolicy: options.toolchainPolicy,
    foundationBaseline: options.foundationBaseline,
  };
  if (
    options.approvalPolicy.bindingStatus !== "configured" ||
    (options.approvalPolicy.blockerCodes ?? []).length !== 0 ||
    typeof options.approvalPolicy.repository !== "string" ||
    options.approvalPolicy.repository.length === 0
  ) {
    throw new Error(
      "Reviewed phase authority producer policy is not configured",
    );
  }
  const collectorAuthorityCache = new Map();
  const collectorAuthorityByEntry = new Map();
  await Promise.all(
    entries.map(async ({ entry, definition }) => {
      const cacheKey =
        `${definition.collectorAuthorityKind ?? definition.collectorWorkflowPath}\n` +
        entry.collectorAuthority.sha256;
      let pending = collectorAuthorityCache.get(cacheKey);
      if (pending === undefined) {
        const collectorArtifact = definition.collectorArtifact;
        pending = (
          definition.collectorAuthorityKind === "foundation-baseline-closure"
            ? readFoundationBaselineClosureForPhaseExit({
                store: options.store,
                reference: entry.collectorAuthority,
                expectedSourceSha: options.sourceSha,
                cwd: repositoryRoot,
                providerPolicy: options.providerPolicy,
                databaseContract: options.databaseContract,
                controlStorePolicy: options.storePolicy,
                approvalPolicy: options.approvalPolicy,
                p0aPolicy: options.p0aPolicy,
                currentWorkflowRunId: options.currentWorkflowRunId,
              })
            : definition.collectorAuthorityKind ===
                "pwa-reviewed-formal-closure"
              ? options.currentWorkflowRunId === null
                ? Promise.reject(
                    new Error(
                      "PWA reviewed formal closure requires the current protected workflow run",
                    ),
                  )
                : readPwaReviewedFormalClosureAuthority({
                    namespace,
                    reference: entry.collectorAuthority,
                    store: options.store,
                    current: options.current,
                    expectedCollectorSourceSha: options.sourceSha,
                    externalPolicy: options.backupRestorePrerequisitePolicy,
                    approvalPolicy: options.approvalPolicy,
                    dbContract: options.databaseContract,
                    currentWorkflowRunId: options.currentWorkflowRunId,
                  })
              : definition.collectorAuthorityKind ===
                  "managed-device-reviewed-stage-set"
                ? options.currentWorkflowRunId === null
                  ? Promise.reject(
                      new Error(
                        "Managed device stage set requires the current protected workflow run",
                      ),
                    )
                  : readManagedDeviceReviewedStageSetAuthority({
                      authority: definition.authority,
                      namespace,
                      reference: entry.collectorAuthority,
                      store: options.store,
                      current: options.current,
                      expectedCollectorSourceSha: options.sourceSha,
                      externalPolicy: options.backupRestorePrerequisitePolicy,
                      approvalPolicy: options.approvalPolicy,
                      dbContract: options.databaseContract,
                      currentWorkflowRunId: options.currentWorkflowRunId,
                    })
                : collectorArtifact === undefined
                  ? readBoundReviewedWorkflowRunAuthority({
                      namespace,
                      repository: options.approvalPolicy.repository,
                      expectedSourceSha: options.sourceSha,
                      expectedWorkflowPath: definition.collectorWorkflowPath,
                      reference: entry.collectorAuthority,
                      store: options.store,
                    })
                  : readBoundReviewedWorkflowArtifactAuthority({
                      namespace,
                      repository: options.approvalPolicy.repository,
                      expectedSourceSha: options.sourceSha,
                      expectedWorkflowPath: definition.collectorWorkflowPath,
                      expectedArtifactNameTemplate:
                        collectorArtifact.nameTemplate.replace(
                          "{sourceSha}",
                          options.sourceSha,
                        ),
                      expectedFileName: collectorArtifact.fileName,
                      expectedFileMediaType: collectorArtifact.fileMediaType,
                      reference: entry.collectorAuthority,
                      store: options.store,
                    }).then((artifactAuthority) => ({
                      ...artifactAuthority,
                      artifactReceipt: artifactAuthority.receipt,
                      receipt: artifactAuthority.workflowRun.receipt,
                    }))
        ).then((authority) => {
          const producerRunId =
            authority.receipt?.runId ?? authority.closure?.producer?.runId;
          if (
            options.currentWorkflowRunId !== null &&
            (producerRunId === options.currentWorkflowRunId ||
              authority.recoveryRehearsal?.runId ===
                options.currentWorkflowRunId)
          ) {
            throw new Error(
              "Phase authority evidence requires a distinct completed prior collector run",
            );
          }
          return authority;
        });
        collectorAuthorityCache.set(cacheKey, pending);
      }
      collectorAuthorityByEntry.set(entry.authority, await pending);
    }),
  );
  const storedEntries = await Promise.all(
    entries.map(async ({ entry, definition }) => {
      if (definition.authority === "remote-db") {
        if (options.currentWorkflowRunId === null) {
          throw new Error(
            "Remote DB authority requires the current protected workflow run",
          );
        }
        const [remote, production] = await Promise.all([
          readStoredRemoteDbObservationAuthority({
            store: options.store,
            namespace,
            reference: entry.evidence,
            contract: options.databaseContract,
          }),
          readReviewedRemoteDbObservationProductionAuthority({
            store: options.store,
            namespace,
            reference: entry.productionAuthority,
            observationReference: entry.evidence,
            expectedSourceSha: options.sourceSha,
            currentWorkflowRunId: options.currentWorkflowRunId,
            contract: options.databaseContract,
            approvalPolicy: options.approvalPolicy,
          }),
        ]);
        return {
          entry,
          definition,
          remoteObservation: remote.observation,
          remoteProduction: production,
          stored: {
            bytes: remote.bytes,
            mediaType: remote.mediaType,
            committedAt: remote.committedAt,
            committedAtMilliseconds: assertCanonicalTimestamp(
              remote.committedAt,
              `${entry.gate}/${entry.authority} committedAt`,
            ),
          },
        };
      }
      const stored = await readStoredObject({
        store: options.store,
        namespace,
        reference: entry.evidence,
        expectedMediaType: definition.mediaType,
        label: `${entry.gate}/${entry.authority}`,
        nowMilliseconds,
      });
      const browserAuthority = DERIVED_REVIEWED_ARTIFACT_AUTHORITIES.has(
        definition.authority,
      )
        ? await readBrowserCollectorEvidence({
            definition,
            collectorAuthority: collectorAuthorityByEntry.get(entry.authority),
            store: options.store,
            namespace,
            sourceSha: options.sourceSha,
            subject,
            releaseContext,
            current: options.current,
            providerPolicy: options.providerPolicy,
            approvalPolicy: options.approvalPolicy,
            storePolicy: options.storePolicy,
            cspPolicy: options.cspPolicy,
            startupBurstContract: options.startupBurstContract,
            backupRestorePrerequisitePolicy:
              options.backupRestorePrerequisitePolicy,
            backupRestoreProviderContract:
              options.backupRestoreProviderContract,
            artifactDrillPolicy: options.artifactDrillPolicy,
            p0aPolicy: options.p0aPolicy,
            releasePolicy: options.releasePolicy,
            toolchainPolicy: options.toolchainPolicy,
            foundationBaseline: options.foundationBaseline,
            databaseContract: options.databaseContract,
          })
        : null;
      return {
        entry,
        definition,
        remoteObservation: null,
        remoteProduction: null,
        browserAuthority,
        stored,
      };
    }),
  );
  for (const {
    stored,
    remoteObservation,
    remoteProduction,
    browserAuthority,
    definition,
    entry,
  } of storedEntries) {
    if (
      stored.committedAtMilliseconds >
        nowMilliseconds + FUTURE_SKEW_MILLISECONDS ||
      stored.committedAtMilliseconds + FUTURE_SKEW_MILLISECONDS <
        Date.parse(entry.observedAt)
    ) {
      throw new Error(
        `${entry.gate}/${entry.authority} immutable commit time is invalid`,
      );
    }
    assertEntryEvidence({
      stored,
      remoteObservation,
      remoteProduction,
      definition,
      entry,
      context: {
        ...context,
        collectorAuthority: collectorAuthorityByEntry.get(entry.authority),
        browserAuthority,
      },
    });
  }
  return Object.freeze({
    bundle: Object.freeze({ ...bundleReference }),
    targetGate: bundle.targetGate,
    subject: Object.freeze(structuredClone(subject)),
    references: Object.freeze(
      entries.map(({ entry }) =>
        Object.freeze({
          gate: entry.gate,
          authority: entry.authority,
          reference: Object.freeze({ ...entry.evidence }),
        }),
      ),
    ),
  });
};
