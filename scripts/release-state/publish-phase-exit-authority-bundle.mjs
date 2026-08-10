#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  putReviewedRemoteDbObservationProductionAuthority,
  readReviewedRemoteDbObservationProductionAuthority,
  readStoredRemoteDbObservationAuthority,
} from "../db/remote-db-observation-authority.mjs";
import {
  PHASE_EXIT_EXTERNAL_AUTHORITIES,
  buildFoundationBaselinePhaseExitEvidence,
  buildBrowserPhaseExitEvidence,
  buildManagedDevicePhaseExitEvidence,
  getPhaseExitCollectorArtifactIdentity,
  projectPhaseExitAuthorityReleaseContext,
  projectPhaseExitAuthoritySubject,
  readPhaseExitArtifactCollectorEvidence,
} from "../lib/phase-exit-external-authority.mjs";
import { readFoundationBaselineClosureForPhaseExit } from "../lib/foundation-baseline-closure-authority.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  publishPhaseExitAuthorityBundle,
  validatePhaseExitAuthorityBundle,
} from "./phaseExitAuthorityPublisher.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import { collectReviewedWorkflowArtifactAuthority } from "./reviewedWorkflowArtifactAuthority.mjs";
import { collectReviewedWorkflowRunAuthority } from "./reviewedWorkflowRunAuthority.mjs";
import {
  MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE,
  MANAGED_DEVICE_STAGE_FILE_NAME,
  PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE,
  PWA_STRICT_RECEIPT_FILE_NAME,
  putManagedDeviceReviewedStageSetAuthority,
  putPwaReviewedFormalClosureAuthority,
  readManagedDeviceReviewedStageSetAuthority,
  readPwaReviewedFormalClosureAuthority,
} from "./managedDeviceReviewedStageSetAuthority.mjs";
import { MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE } from "../browser/managed-device-stage-authority.mjs";
import { MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES } from "../browser/managed-device-authority.mjs";

export const PHASE_EXIT_AUTHORITY_PACKAGE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.phase-exit-authority-package+json;version=1";
export const PHASE_EXIT_AUTHORITY_REVIEW_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.phase-exit-authority-review+json;version=2";
export const PHASE_EXIT_AUTHORITY_PUBLICATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.phase-exit-authority-publication+json;version=2";
export const PHASE_EXIT_AUTHORITY_PACKAGE_FILE_NAME =
  "phase-exit-authority-package.json";
export const PHASE_EXIT_AUTHORITY_PACKAGE_ARTIFACT_PREFIX =
  "foundation-phase-exit-authority-package-";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const PRODUCE_COMMAND = "produce";
const PUBLISH_COMMAND = "publish";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
const MAXIMUM_PACKAGE_BYTES = 24 * 1024 * 1024;

const IMPLEMENTED_AUTHORITIES = PHASE_EXIT_EXTERNAL_AUTHORITIES.filter(
  ({ collectorImplemented }) => collectorImplemented,
);
const DEFINITION_BY_AUTHORITY = new Map(
  IMPLEMENTED_AUTHORITIES.map((definition) => [
    definition.authority,
    definition,
  ]),
);
const ARTIFACT_AUTHORITIES = Object.freeze([
  "external-bindings",
  "bootstrap-recovery-drill",
  "quality-run",
  "artifact-provider-control-store-drill",
  "physical-performance",
  "retention",
  "backup-restore-rehearsal",
  "startup-waf-observation",
  "production-request-graph",
  "csp-report-observation",
  "deployed-csp-flow",
]);
const MANAGED_DEVICE_AUTHORITY_BY_GATE = Object.freeze({
  "P1-PWA": "pwa-multiclient-drill",
  "P7-IDB": "idb-device-compatibility",
});
const IMPLEMENTED_AUTHORITIES_BY_GATE = new Map(
  [...new Set(IMPLEMENTED_AUTHORITIES.map(({ gate }) => gate))].map((gate) => [
    gate,
    Object.freeze(
      IMPLEMENTED_AUTHORITIES.filter((definition) => definition.gate === gate),
    ),
  ]),
);
const PRODUCE_ARGUMENTS_BY_GATE = Object.freeze({
  "P0-BASELINE": Object.freeze([
    ["--foundation-baseline-closure-sha256", "foundationBaselineClosureSha256"],
  ]),
  "P0-ARTIFACT": Object.freeze([
    ["--artifact-drill-run-id", "artifactDrillRunId"],
    ["--artifact-drill-run-attempt", "artifactDrillRunAttempt"],
  ]),
  "P0-TOOLCHAIN": Object.freeze([
    ["--quality-run-id", "qualityRunId"],
    ["--quality-run-attempt", "qualityRunAttempt"],
  ]),
  "P0-DATA": Object.freeze([
    ["--retention-run-id", "retentionRunId"],
    ["--retention-run-attempt", "retentionRunAttempt"],
    ["--backup-restore-run-id", "backupRestoreRunId"],
    ["--backup-restore-run-attempt", "backupRestoreRunAttempt"],
    ["--startup-waf-run-id", "startupWafRunId"],
    ["--startup-waf-run-attempt", "startupWafRunAttempt"],
    ["--remote-db-observation-sha256", "remoteDbObservationSha256"],
    ["--remote-db-production-sha256", "remoteDbProductionSha256"],
    ["--remote-db-run-id", "remoteDbRunId"],
    ["--remote-db-run-attempt", "remoteDbRunAttempt"],
  ]),
  "P0-RELEASE": Object.freeze([
    ["--performance-run-id", "performanceRunId"],
    ["--performance-run-attempt", "performanceRunAttempt"],
  ]),
  "P1-PWA": Object.freeze([
    ["--pwa-receipt-run-id", "pwaReceiptRunId"],
    ["--pwa-receipt-run-attempt", "pwaReceiptRunAttempt"],
    ["--managed-device-run-1-id", "managedDeviceRun1Id"],
    ["--managed-device-run-1-attempt", "managedDeviceRun1Attempt"],
    ["--managed-device-run-2-id", "managedDeviceRun2Id"],
    ["--managed-device-run-2-attempt", "managedDeviceRun2Attempt"],
    ["--managed-device-run-3-id", "managedDeviceRun3Id"],
    ["--managed-device-run-3-attempt", "managedDeviceRun3Attempt"],
  ]),
  "P2A-LOCAL": Object.freeze([
    ["--request-graph-run-id", "requestGraphRunId"],
    ["--request-graph-run-attempt", "requestGraphRunAttempt"],
  ]),
  "P2B-REPORT": Object.freeze([
    ["--csp-report-run-id", "cspReportRunId"],
    ["--csp-report-run-attempt", "cspReportRunAttempt"],
  ]),
  "P4-CSP": Object.freeze([
    ["--deployed-csp-run-id", "deployedCspRunId"],
    ["--deployed-csp-run-attempt", "deployedCspRunAttempt"],
  ]),
  "P7-IDB": Object.freeze([
    ["--managed-device-run-1-id", "managedDeviceRun1Id"],
    ["--managed-device-run-1-attempt", "managedDeviceRun1Attempt"],
    ["--managed-device-run-2-id", "managedDeviceRun2Id"],
    ["--managed-device-run-2-attempt", "managedDeviceRun2Attempt"],
    ["--managed-device-run-3-id", "managedDeviceRun3Id"],
    ["--managed-device-run-3-attempt", "managedDeviceRun3Attempt"],
  ]),
});

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const immutableReference = (namespace, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
};

const referenceFromSha256 = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const nextValue = (tokens, index, flag) => {
  const value = tokens[index + 1];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("--")
  ) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

const parseFlagSet = (tokens, definitions) => {
  const flags = new Map(definitions);
  const result = Object.fromEntries(
    definitions.map(([, property]) => [property, null]),
  );
  for (let index = 0; index < tokens.length; index += 1) {
    const property = flags.get(tokens[index]);
    if (property === undefined || result[property] !== null) {
      throw new Error(`Invalid phase authority argument: ${tokens[index]}`);
    }
    result[property] = nextValue(tokens, index, tokens[index]);
    index += 1;
  }
  if (
    tokens.length !== definitions.length * 2 ||
    Object.values(result).some((value) => value === null)
  ) {
    throw new Error("Phase authority operation requires all exact arguments");
  }
  return result;
};

export const parsePhaseExitAuthorityArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Phase authority operation command is absent");
  }
  const [command, ...tokens] = argv;
  const targetGateIndexes = tokens
    .map((token, index) => (token === "--target-gate" ? index : -1))
    .filter((index) => index !== -1);
  if (targetGateIndexes.length !== 1) {
    throw new Error("Phase authority operation requires one target gate");
  }
  const targetGate = nextValue(tokens, targetGateIndexes[0], "--target-gate");
  if (!IMPLEMENTED_AUTHORITIES_BY_GATE.has(targetGate)) {
    throw new Error(
      `Phase authority target gate has no implemented collector: ${targetGate}`,
    );
  }
  const common = [
    ["--namespace", "namespace"],
    ["--source-sha", "sourceSha"],
    ["--target-gate", "targetGate"],
    ["--output", "outputPath"],
  ];
  const produce = PRODUCE_ARGUMENTS_BY_GATE[targetGate];
  const publish = [
    ["--package-run-id", "packageRunId"],
    ["--package-run-attempt", "packageRunAttempt"],
    ["--package-sha256", "packageSha256"],
    ["--review-receipt-sha256", "reviewReceiptSha256"],
  ];
  if (command !== PRODUCE_COMMAND && command !== PUBLISH_COMMAND) {
    throw new Error(`Invalid phase authority operation command: ${command}`);
  }
  const values = parseFlagSet(tokens, [
    ...common,
    ...(command === PRODUCE_COMMAND ? produce : publish),
  ]);
  const runProperties =
    command === PRODUCE_COMMAND
      ? produce
          .map(([, property]) => property)
          .filter((property) => property.endsWith("RunId"))
      : ["packageRunId"];
  const runPairs = runProperties.map((runIdProperty) => [
    values[runIdProperty],
    values[runIdProperty.replace(/RunId$/u, "RunAttempt")],
  ]);
  if (
    !NAMESPACE_PATTERN.test(values.namespace) ||
    !SOURCE_SHA_PATTERN.test(values.sourceSha) ||
    values.targetGate !== targetGate ||
    runPairs.some(
      ([runId, runAttempt]) =>
        !RUN_ID_PATTERN.test(runId) || !RUN_ATTEMPT_PATTERN.test(runAttempt),
    ) ||
    (command === PRODUCE_COMMAND &&
      targetGate === "P0-DATA" &&
      (!SHA256_PATTERN.test(values.remoteDbObservationSha256) ||
        !SHA256_PATTERN.test(values.remoteDbProductionSha256))) ||
    (command === PRODUCE_COMMAND &&
      targetGate === "P0-BASELINE" &&
      !SHA256_PATTERN.test(values.foundationBaselineClosureSha256)) ||
    (command === PUBLISH_COMMAND &&
      (!SHA256_PATTERN.test(values.packageSha256) ||
        !SHA256_PATTERN.test(values.reviewReceiptSha256)))
  ) {
    throw new Error("Phase authority operation identity is invalid");
  }
  return { command, values };
};

const requireEnvironment = (env, name, pattern = null) => {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw new Error(`Required phase authority environment is invalid: ${name}`);
  }
  return value;
};

const assertCleanExactSource = (sourceSha) => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (head !== sourceSha || dirty.length !== 0) {
    throw new Error(
      "Phase authority operation requires the exact clean source",
    );
  }
};

const parseCanonical = (bytes, label) => {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error(`${label} bytes are absent`);
  }
  const value = parseJsonStrict(bytes.toString("utf8"), label);
  if (!canonicalJsonBytes(value).equals(bytes)) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return value;
};

const loadPolicies = async () => {
  const [
    providerPolicy,
    approvalPolicy,
    storePolicy,
    databaseContract,
    retentionPolicy,
    startupBurstContract,
    cspPolicy,
    backupRestorePrerequisitePolicy,
    backupRestoreProviderContract,
    artifactDrillPolicy,
    releasePolicy,
    toolchainPolicy,
    foundationBaseline,
    p0aPolicy,
  ] = await Promise.all(
    [
      "config/provider-policy.json",
      "config/approval-policy.json",
      "config/release-state-store.json",
      "config/db-compatibility-contract.json",
      "config/metrics-retention-policy.json",
      "contracts/persistence-release-a-startup-bursts-v1.json",
      "config/csp-policy.json",
      "config/phase-exit-external-prerequisites.json",
      "config/backup-restore-provider-contract.json",
      "config/artifact-control-store-drill.json",
      "config/release-variants.json",
      "config/toolchain-versions.json",
      "config/foundation-baseline.json",
      "config/foundation-p0a-authorities.json",
    ].map((relativePath) => readJsonStrict(path.join(root, relativePath))),
  );
  return {
    providerPolicy,
    approvalPolicy,
    storePolicy,
    databaseContract,
    retentionPolicy,
    startupBurstContract,
    cspPolicy,
    backupRestorePrerequisitePolicy,
    backupRestoreProviderContract,
    artifactDrillPolicy,
    releasePolicy,
    toolchainPolicy,
    foundationBaseline,
    p0aPolicy,
  };
};

const putAndReadExact = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const reference = immutableReference(namespace, bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== reference.sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store put/readback differs`);
  }
  return reference;
};

const validationOptions = ({
  store,
  current,
  sourceSha,
  currentWorkflowRunId,
  bundleBytes,
  evidenceBytesByAuthority,
  policies,
}) => ({
  store,
  current,
  sourceSha,
  currentWorkflowRunId,
  bundleBytes,
  expectedBundleSha256: sha256Bytes(bundleBytes),
  evidenceBytesByAuthority,
  ...policies,
});

const buildQualityEvidence = ({
  sourceBytes,
  collector,
  subject,
  sourceSha,
}) => {
  const source = parseCanonical(sourceBytes, "Quality run source artifact");
  const run = collector.workflowRun.receipt;
  const result = {
    repository: source.repository,
    workflowPath: source.workflowPath,
    workflowRunId: source.workflowRunId,
    workflowRunAttempt: source.workflowRunAttempt,
    event: source.event,
    headBranch: source.headBranch,
    headSha: source.headSha,
    status: run.status,
    conclusion: run.conclusion,
    nodeVersion: source.nodeVersion,
    npmVersion: source.npmVersion,
    checks: source.checks,
  };
  return canonicalJsonBytes({
    schemaVersion: 1,
    evidenceKind: "phase-exit-quality-run/v1",
    gate: "P0-TOOLCHAIN",
    authority: "quality-run",
    sourceSha,
    observedAt: source.observedAt,
    subject,
    collectorAuthority: collector.reference,
    result,
  });
};

const buildBundleInputs = async ({
  store,
  current,
  sourceSha,
  currentWorkflowRunId,
  currentWorkflowRunAttempt,
  values,
  policies,
  githubToken,
  now = Date.now,
}) => {
  const targetDefinitions = IMPLEMENTED_AUTHORITIES_BY_GATE.get(
    values.targetGate,
  );
  if (!Array.isArray(targetDefinitions) || targetDefinitions.length === 0) {
    throw new Error("Phase authority target gate definition is absent");
  }
  const runByAuthority = {
    "quality-run": [values.qualityRunId, values.qualityRunAttempt],
    "artifact-provider-control-store-drill": [
      values.artifactDrillRunId,
      values.artifactDrillRunAttempt,
    ],
    "physical-performance": [
      values.performanceRunId,
      values.performanceRunAttempt,
    ],
    retention: [values.retentionRunId, values.retentionRunAttempt],
    "backup-restore-rehearsal": [
      values.backupRestoreRunId,
      values.backupRestoreRunAttempt,
    ],
    "startup-waf-observation": [
      values.startupWafRunId,
      values.startupWafRunAttempt,
    ],
    "production-request-graph": [
      values.requestGraphRunId,
      values.requestGraphRunAttempt,
    ],
    "csp-report-observation": [
      values.cspReportRunId,
      values.cspReportRunAttempt,
    ],
    "deployed-csp-flow": [
      values.deployedCspRunId,
      values.deployedCspRunAttempt,
    ],
    "remote-db": [values.remoteDbRunId, values.remoteDbRunAttempt],
  };
  const managedDeviceSelectors = [
    [values.managedDeviceRun1Id, values.managedDeviceRun1Attempt],
    [values.managedDeviceRun2Id, values.managedDeviceRun2Attempt],
    [values.managedDeviceRun3Id, values.managedDeviceRun3Attempt],
  ];
  const managedDeviceAuthority =
    MANAGED_DEVICE_AUTHORITY_BY_GATE[values.targetGate] ?? null;
  const pwaStrictReceiptSelector =
    values.targetGate === "P1-PWA"
      ? [values.pwaReceiptRunId, values.pwaReceiptRunAttempt]
      : null;
  const targetArtifactAuthorities = targetDefinitions
    .filter(
      ({ authority, collectorAuthorityKind }) =>
        ARTIFACT_AUTHORITIES.includes(authority) &&
        collectorAuthorityKind !== "foundation-baseline-closure",
    )
    .map(({ authority }) => authority);
  const targetRuns =
    managedDeviceAuthority === null
      ? targetDefinitions
          .map(({ authority }) => runByAuthority[authority])
          .filter(Array.isArray)
      : pwaStrictReceiptSelector === null
        ? managedDeviceSelectors
        : [pwaStrictReceiptSelector, ...managedDeviceSelectors];
  const runIds = targetRuns.map(([runId]) => runId);
  if (
    new Set(runIds).size !== runIds.length ||
    runIds.includes(currentWorkflowRunId)
  ) {
    throw new Error(
      "Phase authority collectors require distinct completed prior runs",
    );
  }
  const collectors = new Map(
    await Promise.all(
      targetArtifactAuthorities.map(async (authority) => {
        const definition = DEFINITION_BY_AUTHORITY.get(authority);
        const [expectedRunId, expectedRunAttempt] = runByAuthority[authority];
        const identity = getPhaseExitCollectorArtifactIdentity({
          authority,
          sourceSha,
          runAttempt: expectedRunAttempt,
        });
        const collected = await collectReviewedWorkflowArtifactAuthority({
          githubToken,
          namespace: store.namespace,
          repository: policies.approvalPolicy.repository,
          expectedRunId,
          expectedRunAttempt,
          expectedSourceSha: sourceSha,
          expectedWorkflowPath: definition.collectorWorkflowPath,
          expectedArtifactName: identity.artifactName,
          expectedFileName: identity.fileName,
          expectedFileMediaType: identity.fileMediaType,
          store,
        });
        return [authority, collected];
      }),
    ),
  );
  let managedDeviceStageSet = null;
  let managedDeviceCollectorAuthority = null;
  let managedDeviceAuthorityReadback = null;
  if (managedDeviceAuthority !== null) {
    const [reviewedStages, strictPwaReceiptArtifact] = await Promise.all([
      Promise.all(
        managedDeviceSelectors.map(
          async ([expectedRunId, expectedRunAttempt]) =>
            collectReviewedWorkflowArtifactAuthority({
              githubToken,
              namespace: store.namespace,
              repository: policies.approvalPolicy.repository,
              expectedRunId,
              expectedRunAttempt,
              expectedSourceSha: sourceSha,
              expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
              expectedArtifactName:
                MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE.replace(
                  "{sourceSha}",
                  sourceSha,
                ).replace("{runAttempt}", expectedRunAttempt),
              expectedFileName: MANAGED_DEVICE_STAGE_FILE_NAME,
              expectedFileMediaType: MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE,
              store,
            }),
        ),
      ),
      pwaStrictReceiptSelector === null
        ? Promise.resolve(null)
        : collectReviewedWorkflowArtifactAuthority({
            githubToken,
            namespace: store.namespace,
            repository: policies.approvalPolicy.repository,
            expectedRunId: pwaStrictReceiptSelector[0],
            expectedRunAttempt: pwaStrictReceiptSelector[1],
            expectedSourceSha: sourceSha,
            expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
            expectedArtifactName:
              PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE.replace(
                "{sourceSha}",
                sourceSha,
              ).replace("{runAttempt}", pwaStrictReceiptSelector[1]),
            expectedFileName: PWA_STRICT_RECEIPT_FILE_NAME,
            expectedFileMediaType:
              MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES[
                "pwa-multiclient-drill"
              ],
            store,
          }),
    ]);
    managedDeviceStageSet = await putManagedDeviceReviewedStageSetAuthority({
      authority: managedDeviceAuthority,
      namespace: store.namespace,
      repository: policies.approvalPolicy.repository,
      sourceSha,
      reviewedStages,
      store,
      currentWorkflowRunId,
    });
    const stageSetReadback = await readManagedDeviceReviewedStageSetAuthority({
      authority: managedDeviceAuthority,
      namespace: store.namespace,
      reference: managedDeviceStageSet.reference,
      store,
      current,
      expectedCollectorSourceSha: sourceSha,
      externalPolicy: policies.backupRestorePrerequisitePolicy,
      approvalPolicy: policies.approvalPolicy,
      dbContract: policies.databaseContract,
      currentWorkflowRunId,
    });
    managedDeviceCollectorAuthority = managedDeviceStageSet;
    managedDeviceAuthorityReadback = stageSetReadback;
    if (strictPwaReceiptArtifact !== null) {
      managedDeviceCollectorAuthority =
        await putPwaReviewedFormalClosureAuthority({
          namespace: store.namespace,
          repository: policies.approvalPolicy.repository,
          sourceSha,
          stageSetReference: managedDeviceStageSet.reference,
          strictReceiptArtifactReference: strictPwaReceiptArtifact.reference,
          store,
          currentWorkflowRunId,
        });
      managedDeviceAuthorityReadback =
        await readPwaReviewedFormalClosureAuthority({
          namespace: store.namespace,
          reference: managedDeviceCollectorAuthority.reference,
          store,
          current,
          expectedCollectorSourceSha: sourceSha,
          externalPolicy: policies.backupRestorePrerequisitePolicy,
          approvalPolicy: policies.approvalPolicy,
          dbContract: policies.databaseContract,
          currentWorkflowRunId,
        });
    }
  }
  let reviewedRemote = null;
  let remoteProduction = null;
  let remoteObservation = null;
  if (values.targetGate === "P0-DATA") {
    const remoteObservationReference = referenceFromSha256(
      store.namespace,
      values.remoteDbObservationSha256,
    );
    const remoteProductionReceiptReference = referenceFromSha256(
      store.namespace,
      values.remoteDbProductionSha256,
    );
    const remoteReviewedRun = await collectReviewedWorkflowRunAuthority({
      githubToken,
      namespace: store.namespace,
      repository: policies.approvalPolicy.repository,
      expectedRunId: values.remoteDbRunId,
      expectedRunAttempt: values.remoteDbRunAttempt,
      expectedSourceSha: sourceSha,
      expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
      store,
    });
    reviewedRemote = await putReviewedRemoteDbObservationProductionAuthority({
      store,
      namespace: store.namespace,
      sourceSha,
      producerRunId: values.remoteDbRunId,
      producerRunAttempt: values.remoteDbRunAttempt,
      currentWorkflowRunId,
      repository: policies.approvalPolicy.repository,
      observationReference: remoteObservationReference,
      productionReceiptReference: remoteProductionReceiptReference,
      reviewedWorkflowRunReference: remoteReviewedRun.receipt,
      contract: policies.databaseContract,
      approvalPolicy: policies.approvalPolicy,
    });
    remoteProduction = await readReviewedRemoteDbObservationProductionAuthority(
      {
        store,
        namespace: store.namespace,
        reference: reviewedRemote.reference,
        observationReference: remoteObservationReference,
        expectedSourceSha: sourceSha,
        currentWorkflowRunId,
        contract: policies.databaseContract,
        approvalPolicy: policies.approvalPolicy,
      },
    );
    remoteObservation = await readStoredRemoteDbObservationAuthority({
      store,
      namespace: store.namespace,
      reference: remoteObservationReference,
      contract: policies.databaseContract,
    });
  }
  const releaseContext = projectPhaseExitAuthorityReleaseContext({
    current,
    namespace: store.namespace,
  });
  const artifactDrillClosure = collectors.has(
    "artifact-provider-control-store-drill",
  )
    ? parseCanonical(
        collectors.get("artifact-provider-control-store-drill").fileBytes,
        "Artifact drill closure subject",
      )
    : null;
  const subject = projectPhaseExitAuthoritySubject({
    current,
    targetGate: values.targetGate,
    sourceSha,
    drillId: artifactDrillClosure?.drillNamespace ?? null,
    foundationBaseline: policies.foundationBaseline,
    p0aPolicy: policies.p0aPolicy,
  });
  const evidenceBytesByAuthority = new Map();
  let foundationBaselineClosure = null;
  if (
    targetDefinitions.some(
      ({ collectorAuthorityKind }) =>
        collectorAuthorityKind === "foundation-baseline-closure",
    )
  ) {
    const closureReference = referenceFromSha256(
      store.namespace,
      values.foundationBaselineClosureSha256,
    );
    foundationBaselineClosure = await readFoundationBaselineClosureForPhaseExit(
      {
        store,
        reference: closureReference,
        expectedSourceSha: sourceSha,
        cwd: root,
        providerPolicy: policies.providerPolicy,
        databaseContract: policies.databaseContract,
        controlStorePolicy: policies.storePolicy,
        approvalPolicy: policies.approvalPolicy,
        p0aPolicy: policies.p0aPolicy,
        currentWorkflowRunId,
      },
    );
    const baselineEvidence = buildFoundationBaselinePhaseExitEvidence({
      authorityReadback: foundationBaselineClosure,
      subject,
      sourceSha,
      providerPolicy: policies.providerPolicy,
      approvalPolicy: policies.approvalPolicy,
      storePolicy: policies.storePolicy,
      databaseContract: policies.databaseContract,
    });
    for (const definition of targetDefinitions) {
      if (definition.collectorAuthorityKind === "foundation-baseline-closure") {
        const evidence = baselineEvidence.get(definition.authority);
        if (evidence === undefined) {
          throw new Error(
            `Foundation baseline closure does not resolve ${definition.authority}`,
          );
        }
        evidenceBytesByAuthority.set(definition.authority, evidence.bytes);
      }
    }
  }
  if (collectors.has("quality-run")) {
    evidenceBytesByAuthority.set(
      "quality-run",
      buildQualityEvidence({
        sourceBytes: collectors.get("quality-run").fileBytes,
        collector: collectors.get("quality-run"),
        subject,
        sourceSha,
      }),
    );
  }
  for (const authority of ["physical-performance", "retention"]) {
    if (collectors.has(authority)) {
      evidenceBytesByAuthority.set(
        authority,
        collectors.get(authority).fileBytes,
      );
    }
  }
  if (remoteObservation !== null) {
    evidenceBytesByAuthority.set("remote-db", remoteObservation.bytes);
  }
  const managedDeviceEvidence =
    managedDeviceAuthority === null
      ? null
      : buildManagedDevicePhaseExitEvidence({
          authority: managedDeviceAuthority,
          authorityReadback: managedDeviceAuthorityReadback,
          collectorAuthority: managedDeviceCollectorAuthority.reference,
          subject,
          sourceSha,
          databaseContract: policies.databaseContract,
        });
  if (managedDeviceEvidence !== null) {
    evidenceBytesByAuthority.set(
      managedDeviceAuthority,
      managedDeviceEvidence.bytes,
    );
  }
  const browserAuthorities = [
    "startup-waf-observation",
    "artifact-provider-control-store-drill",
    "backup-restore-rehearsal",
    "production-request-graph",
    "csp-report-observation",
    "deployed-csp-flow",
  ].filter((authority) => collectors.has(authority));
  const derivedCollectorAuthorities = new Map(
    await Promise.all(
      browserAuthorities.map(async (authority) => {
        const collected = collectors.get(authority);
        const readback = await readPhaseExitArtifactCollectorEvidence({
          authority,
          collectorAuthority: {
            ...collected,
            artifactReceipt: collected.receipt,
            receipt: collected.workflowRun.receipt,
          },
          store,
          namespace: store.namespace,
          sourceSha,
          subject,
          releaseContext,
          current,
          providerPolicy: policies.providerPolicy,
          approvalPolicy: policies.approvalPolicy,
          cspPolicy: policies.cspPolicy,
          startupBurstContract: policies.startupBurstContract,
          backupRestorePrerequisitePolicy:
            policies.backupRestorePrerequisitePolicy,
          backupRestoreProviderContract: policies.backupRestoreProviderContract,
          artifactDrillPolicy: policies.artifactDrillPolicy,
          p0aPolicy: policies.p0aPolicy,
          releasePolicy: policies.releasePolicy,
          toolchainPolicy: policies.toolchainPolicy,
          foundationBaseline: policies.foundationBaseline,
          databaseContract: policies.databaseContract,
        });
        return [authority, readback];
      }),
    ),
  );
  const browserEvidence = new Map();
  for (const authority of browserAuthorities) {
    const built = buildBrowserPhaseExitEvidence({
      authority,
      observation: derivedCollectorAuthorities.get(authority).observation,
      collectorAuthority: collectors.get(authority).reference,
      subject,
      sourceSha,
    });
    browserEvidence.set(authority, built);
    evidenceBytesByAuthority.set(authority, built.bytes);
  }
  const parsedEvidence = new Map(
    [...evidenceBytesByAuthority].map(([authority, bytes]) => [
      authority,
      parseCanonical(bytes, `${authority} evidence`),
    ]),
  );
  const observedAtByAuthority = new Map(
    targetDefinitions.map(({ authority }) => {
      const parsed = parsedEvidence.get(authority);
      const observedAt =
        authority === "physical-performance"
          ? parsed.producerReceipt.receipt.producedAtUtc
          : (browserEvidence.get(authority)?.observedAt ??
            (authority === managedDeviceAuthority
              ? managedDeviceEvidence.observedAt
              : parsed.observedAt));
      return [authority, observedAt];
    }),
  );
  const entries = targetDefinitions.map((definition) => {
    const authority = definition.authority;
    const evidenceBytes = evidenceBytesByAuthority.get(authority);
    const isRemote = authority === "remote-db";
    return {
      gate: definition.gate,
      authority,
      sourceSha,
      observedAt: observedAtByAuthority.get(authority),
      subject,
      collectorAuthority: isRemote
        ? remoteProduction.authority.reviewedWorkflowRun
        : authority === managedDeviceAuthority
          ? managedDeviceCollectorAuthority.reference
          : definition.collectorAuthorityKind === "foundation-baseline-closure"
            ? foundationBaselineClosure.reference
            : collectors.get(authority).reference,
      productionAuthority: isRemote ? reviewedRemote.reference : null,
      evidence: immutableReference(store.namespace, evidenceBytes),
    };
  });
  const bundleBytes = canonicalJsonBytes({
    schemaVersion: 1,
    kind: "phase-exit-external-authority-bundle/v1",
    namespace: store.namespace,
    sourceSha,
    releaseStateHead: { ...current.head },
    createdAt: new Date(Number(now())).toISOString(),
    targetGate: values.targetGate,
    entries,
  });
  const validated = await validatePhaseExitAuthorityBundle(
    validationOptions({
      store,
      current,
      sourceSha,
      currentWorkflowRunId,
      bundleBytes,
      evidenceBytesByAuthority,
      policies,
    }),
  );
  const review = {
    schemaVersion: 2,
    kind: "phase-exit-authority-bundle-review/v2",
    namespace: store.namespace,
    sourceSha,
    targetGate: values.targetGate,
    producerRunId: currentWorkflowRunId,
    producerRunAttempt: currentWorkflowRunAttempt,
    releaseStateHead: { ...current.head },
    bundle: immutableReference(store.namespace, bundleBytes),
    evidence: validated.resolved.references,
    collectors: entries.map(({ authority, collectorAuthority }) => ({
      authority,
      collectorAuthority,
    })),
  };
  const packageValue = {
    schemaVersion: 1,
    kind: "phase-exit-authority-package/v1",
    namespace: store.namespace,
    sourceSha,
    targetGate: values.targetGate,
    producerRunId: currentWorkflowRunId,
    producerRunAttempt: currentWorkflowRunAttempt,
    bundleSha256: sha256Bytes(bundleBytes),
    reviewReceiptSha256: sha256Bytes(canonicalJsonBytes(review)),
    bundle: parseCanonical(bundleBytes, "Produced phase authority bundle"),
    evidence: targetDefinitions.map((definition) => ({
      authority: definition.authority,
      mediaType: definition.mediaType,
      value: parsedEvidence.get(definition.authority),
    })),
    review,
  };
  return {
    packageValue,
    packageBytes: canonicalJsonBytes(packageValue),
    bundleBytes,
    evidenceBytesByAuthority,
    review,
  };
};

const parsePackage = ({
  bytes,
  namespace,
  sourceSha,
  targetGate,
  producerRunId,
  producerRunAttempt,
}) => {
  const packageValue = parseCanonical(bytes, "Phase authority package");
  if (
    !exactKeys(packageValue, [
      "schemaVersion",
      "kind",
      "namespace",
      "sourceSha",
      "targetGate",
      "producerRunId",
      "producerRunAttempt",
      "bundleSha256",
      "reviewReceiptSha256",
      "bundle",
      "evidence",
      "review",
    ]) ||
    packageValue.schemaVersion !== 1 ||
    packageValue.kind !== "phase-exit-authority-package/v1" ||
    packageValue.namespace !== namespace ||
    packageValue.sourceSha !== sourceSha ||
    packageValue.targetGate !== targetGate ||
    packageValue.producerRunId !== producerRunId ||
    packageValue.producerRunAttempt !== producerRunAttempt ||
    !SHA256_PATTERN.test(packageValue.bundleSha256 ?? "") ||
    !SHA256_PATTERN.test(packageValue.reviewReceiptSha256 ?? "") ||
    !Array.isArray(packageValue.evidence) ||
    packageValue.evidence.length !==
      IMPLEMENTED_AUTHORITIES_BY_GATE.get(targetGate)?.length
  ) {
    throw new Error("Phase authority package binding differs");
  }
  const evidenceBytesByAuthority = new Map();
  const targetDefinitions = IMPLEMENTED_AUTHORITIES_BY_GATE.get(targetGate);
  for (let index = 0; index < targetDefinitions.length; index += 1) {
    const definition = targetDefinitions[index];
    const evidence = packageValue.evidence[index];
    if (
      !exactKeys(evidence, ["authority", "mediaType", "value"]) ||
      evidence.authority !== definition.authority ||
      evidence.mediaType !== definition.mediaType
    ) {
      throw new Error("Phase authority package evidence set differs");
    }
    evidenceBytesByAuthority.set(
      evidence.authority,
      canonicalJsonBytes(evidence.value),
    );
  }
  const bundleBytes = canonicalJsonBytes(packageValue.bundle);
  const reviewBytes = canonicalJsonBytes(packageValue.review);
  if (
    sha256Bytes(bundleBytes) !== packageValue.bundleSha256 ||
    sha256Bytes(reviewBytes) !== packageValue.reviewReceiptSha256
  ) {
    throw new Error("Phase authority package internal digest differs");
  }
  return {
    packageValue,
    bundleBytes,
    evidenceBytesByAuthority,
    reviewBytes,
  };
};

const assertReview = ({
  review,
  namespace,
  sourceSha,
  targetGate,
  producerRunId,
  producerRunAttempt,
  current,
  bundleBytes,
  resolved,
}) => {
  if (
    !exactKeys(review, [
      "schemaVersion",
      "kind",
      "namespace",
      "sourceSha",
      "targetGate",
      "producerRunId",
      "producerRunAttempt",
      "releaseStateHead",
      "bundle",
      "evidence",
      "collectors",
    ]) ||
    review.schemaVersion !== 2 ||
    review.kind !== "phase-exit-authority-bundle-review/v2" ||
    review.namespace !== namespace ||
    review.sourceSha !== sourceSha ||
    review.targetGate !== targetGate ||
    review.producerRunId !== producerRunId ||
    review.producerRunAttempt !== producerRunAttempt ||
    JSON.stringify(review.releaseStateHead) !== JSON.stringify(current.head) ||
    JSON.stringify(review.bundle) !==
      JSON.stringify(immutableReference(namespace, bundleBytes)) ||
    JSON.stringify(review.evidence) !== JSON.stringify(resolved.references) ||
    !Array.isArray(review.collectors) ||
    review.collectors.length !==
      IMPLEMENTED_AUTHORITIES_BY_GATE.get(targetGate)?.length
  ) {
    throw new Error("Phase authority review receipt binding differs");
  }
  for (let index = 0; index < review.collectors.length; index += 1) {
    const expectedEntry = parseCanonical(
      bundleBytes,
      "Reviewed phase authority bundle",
    ).entries[index];
    const collector = review.collectors[index];
    if (
      !exactKeys(collector, ["authority", "collectorAuthority"]) ||
      collector.authority !== expectedEntry.authority ||
      JSON.stringify(collector.collectorAuthority) !==
        JSON.stringify(expectedEntry.collectorAuthority)
    ) {
      throw new Error("Phase authority review collector binding differs");
    }
  }
};

const writeCanonicalOutput = async (outputPath, value, label) => {
  const bytes = canonicalJsonBytes(value);
  if (bytes.length > MAXIMUM_PACKAGE_BYTES) {
    throw new Error(`${label} is oversized`);
  }
  const absolutePath = path.resolve(outputPath);
  await writeFile(absolutePath, bytes, { flag: "wx" });
  const readback = await readFile(absolutePath);
  if (!readback.equals(bytes)) {
    throw new Error(`${label} output readback differs`);
  }
  return bytes;
};

export const runPhaseExitAuthorityPublisherCli = async (
  argv = process.argv.slice(2),
  { env = process.env, now = Date.now } = {},
) => {
  const { command, values } = parsePhaseExitAuthorityArguments(argv);
  assertCleanExactSource(values.sourceSha);
  const currentWorkflowRunId = requireEnvironment(
    env,
    "GITHUB_RUN_ID",
    RUN_ID_PATTERN,
  );
  const currentWorkflowRunAttempt = requireEnvironment(
    env,
    "GITHUB_RUN_ATTEMPT",
    RUN_ATTEMPT_PATTERN,
  );
  const priorRunIds =
    command === PRODUCE_COMMAND
      ? PRODUCE_ARGUMENTS_BY_GATE[values.targetGate]
          .map(([, property]) => property)
          .filter((property) => property.endsWith("RunId"))
          .map((property) => values[property])
      : [values.packageRunId];
  if (priorRunIds.includes(currentWorkflowRunId)) {
    throw new Error("Phase authority operation requires distinct prior runs");
  }
  const policies = await loadPolicies();
  if (policies.storePolicy.bindingStatus !== "configured") {
    throw new Error("Release State store is not configured for publication");
  }
  assertProtectedWorkflowEnvironment({
    env,
    approvalPolicy: policies.approvalPolicy,
    namespace: values.namespace,
    sourceSha: values.sourceSha,
    runId: currentWorkflowRunId,
  });
  const store = await createPostgresReleaseStateStore({
    connectionString: requireEnvironment(
      env,
      policies.storePolicy.databaseUrlEnvironmentName,
    ),
    namespace: values.namespace,
    policy: policies.storePolicy,
    ca: requireEnvironment(env, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const current = await readCurrentReleaseState({
      store,
      requireInitialized: false,
    });
    const githubToken = requireEnvironment(env, "GITHUB_TOKEN");
    let result;
    if (command === PRODUCE_COMMAND) {
      const produced = await buildBundleInputs({
        store,
        current,
        sourceSha: values.sourceSha,
        currentWorkflowRunId,
        currentWorkflowRunAttempt,
        values,
        policies,
        githubToken,
        now,
      });
      const packageBytes = await writeCanonicalOutput(
        values.outputPath,
        produced.packageValue,
        "Phase authority package",
      );
      result = {
        schemaVersion: 1,
        kind: "phase-exit-authority-package-result/v1",
        namespace: values.namespace,
        sourceSha: values.sourceSha,
        targetGate: values.targetGate,
        workflowRunId: currentWorkflowRunId,
        packageSha256: sha256Bytes(packageBytes),
        reviewReceiptSha256: sha256Bytes(canonicalJsonBytes(produced.review)),
        bundleSha256: sha256Bytes(produced.bundleBytes),
        evidenceCount: produced.evidenceBytesByAuthority.size,
      };
    } else {
      const packageIdentity = {
        artifactName:
          `${PHASE_EXIT_AUTHORITY_PACKAGE_ARTIFACT_PREFIX}${values.sourceSha}-` +
          `${values.targetGate}-` +
          values.packageRunAttempt,
        fileName: PHASE_EXIT_AUTHORITY_PACKAGE_FILE_NAME,
        fileMediaType: PHASE_EXIT_AUTHORITY_PACKAGE_MEDIA_TYPE,
      };
      const packageAuthority = await collectReviewedWorkflowArtifactAuthority({
        githubToken,
        namespace: values.namespace,
        repository: policies.approvalPolicy.repository,
        expectedRunId: values.packageRunId,
        expectedRunAttempt: values.packageRunAttempt,
        expectedSourceSha: values.sourceSha,
        expectedWorkflowPath: RELEASE_WORKFLOW_PATH,
        expectedArtifactName: packageIdentity.artifactName,
        expectedFileName: packageIdentity.fileName,
        expectedFileMediaType: packageIdentity.fileMediaType,
        store,
      });
      if (sha256Bytes(packageAuthority.fileBytes) !== values.packageSha256) {
        throw new Error("Reviewed phase authority package SHA-256 differs");
      }
      const parsed = parsePackage({
        bytes: packageAuthority.fileBytes,
        namespace: values.namespace,
        sourceSha: values.sourceSha,
        targetGate: values.targetGate,
        producerRunId: values.packageRunId,
        producerRunAttempt: values.packageRunAttempt,
      });
      if (sha256Bytes(parsed.reviewBytes) !== values.reviewReceiptSha256) {
        throw new Error("Reviewed phase authority receipt SHA-256 differs");
      }
      const options = validationOptions({
        store,
        current,
        sourceSha: values.sourceSha,
        currentWorkflowRunId,
        bundleBytes: parsed.bundleBytes,
        evidenceBytesByAuthority: parsed.evidenceBytesByAuthority,
        policies,
      });
      const validated = await validatePhaseExitAuthorityBundle(options);
      assertReview({
        review: parsed.packageValue.review,
        namespace: values.namespace,
        sourceSha: values.sourceSha,
        targetGate: values.targetGate,
        producerRunId: values.packageRunId,
        producerRunAttempt: values.packageRunAttempt,
        current,
        bundleBytes: parsed.bundleBytes,
        resolved: validated.resolved,
      });
      const published = await publishPhaseExitAuthorityBundle(options);
      const reviewReceipt = await putAndReadExact({
        store,
        namespace: values.namespace,
        bytes: parsed.reviewBytes,
        mediaType: PHASE_EXIT_AUTHORITY_REVIEW_MEDIA_TYPE,
        label: "Phase authority review receipt",
      });
      const publicationBytes = canonicalJsonBytes({
        schemaVersion: 2,
        kind: "reviewed-phase-exit-authority-publication/v2",
        namespace: values.namespace,
        sourceSha: values.sourceSha,
        targetGate: values.targetGate,
        publisherRunId: currentWorkflowRunId,
        publisherRunAttempt: currentWorkflowRunAttempt,
        producerRunId: values.packageRunId,
        producerRunAttempt: values.packageRunAttempt,
        producerArtifactAuthority: packageAuthority.reference,
        reviewReceipt,
        bundle: published.bundle.reference,
        evidenceCount: published.evidenceReceipts.length,
      });
      const publicationAuthority = await putAndReadExact({
        store,
        namespace: values.namespace,
        bytes: publicationBytes,
        mediaType: PHASE_EXIT_AUTHORITY_PUBLICATION_MEDIA_TYPE,
        label: "Phase authority publication authority",
      });
      result = {
        schemaVersion: 2,
        kind: "phase-exit-authority-publication-result/v2",
        namespace: values.namespace,
        sourceSha: values.sourceSha,
        targetGate: values.targetGate,
        workflowRunId: currentWorkflowRunId,
        publicationAuthority,
        bundle: published.bundle.reference,
        evidenceCount: published.evidenceReceipts.length,
      };
      await writeCanonicalOutput(
        values.outputPath,
        result,
        "Phase authority publication result",
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runPhaseExitAuthorityPublisherCli();
