#!/usr/bin/env node

import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  acceptPendingStandardRelease,
  preparePendingStandardAcceptanceBundle,
  recordPreparedPromotionAssignment,
  recordPreparedPromotionLifecycle,
  resolvePendingAcceptanceRequirements,
} from "./lifecycleExecution.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  activateP8MinimumSafetyFloor,
  activateReleasePolicy,
} from "./policyActivation.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  parseCanonicalJsonBytes,
} from "./releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_TERMINAL_OBJECT_SET_BYTES = 512 * 1024 * 1024;
const ACCEPTANCE_INPUT_FLAGS = [
  "--continuous-probe",
  "--continuous-probe-sha256",
  "--evidence",
  "--evidence-sha256",
  "--namespace",
  "--output",
];
const ACCEPTANCE_PERFORMANCE_FLAGS = [
  "--performance-evidence",
  "--performance-evidence-sha256",
];
const COMMAND_FLAGS = {
  "record-assignment": [
    "--assignment-authority",
    "--namespace",
    "--output",
    "--prepared-result",
    "--promotion-receipt",
  ],
  "record-promotion": [
    "--assignment-authority",
    "--assignment-validation",
    "--namespace",
    "--output",
    "--prepared-result",
    "--production-probe",
    "--promotion-receipt",
  ],
  "prepare-acceptance-bundle": [
    ...ACCEPTANCE_INPUT_FLAGS,
    "--terminal-bundle-output",
    "--terminal-object-set-output",
  ],
  "accept-standard": [
    ...ACCEPTANCE_INPUT_FLAGS,
    "--terminal-bundle",
    "--terminal-bundle-sha256",
    "--terminal-object-set",
    "--terminal-object-set-sha256",
  ],
  "activate-policy-floor": [
    "--namespace",
    "--output",
    "--subject",
    "--subject-sha256",
  ],
  "activate-policy": [
    "--namespace",
    "--output",
    "--subject",
    "--subject-sha256",
  ],
  "describe-acceptance-requirements": ["--namespace", "--output"],
};
const ACCEPTANCE_RECOVERY_FLAGS = [
  "--companion-recovery-drill",
  "--companion-recovery-drill-sha256",
];

export const parseReleaseLifecycleArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length === 0) {
    throw new Error(
      "Usage: execute-release-lifecycle.mjs <record-assignment|record-promotion|prepare-acceptance-bundle|accept-standard|activate-policy|activate-policy-floor|describe-acceptance-requirements> [strict flags]",
    );
  }
  const [command, ...tokens] = arguments_;
  const baseFlags = COMMAND_FLAGS[command];
  const flagSets = ["accept-standard", "prepare-acceptance-bundle"].includes(
    command,
  )
    ? [
        baseFlags,
        [...baseFlags, ...ACCEPTANCE_PERFORMANCE_FLAGS],
        [...baseFlags, ...ACCEPTANCE_RECOVERY_FLAGS],
        [
          ...baseFlags,
          ...ACCEPTANCE_PERFORMANCE_FLAGS,
          ...ACCEPTANCE_RECOVERY_FLAGS,
        ],
      ]
    : [baseFlags];
  if (
    !baseFlags ||
    !flagSets.some((flags) => tokens.length === flags.length * 2)
  ) {
    throw new Error(`Invalid release lifecycle command: ${String(command)}`);
  }
  const allowedFlags = [...new Set(flagSets.flat())];
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !allowedFlags.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid, duplicate, or forbidden lifecycle option: ${String(flag)}`,
      );
    }
    values[flag] = value;
  }
  const providedFlags = Object.keys(values).sort();
  const exactFlagSet = flagSets.some(
    (flags) =>
      flags.length === providedFlags.length &&
      [...flags].sort().every((flag, index) => flag === providedFlags[index]),
  );
  if (
    !exactFlagSet ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    (["accept-standard", "prepare-acceptance-bundle"].includes(command) &&
      (!SHA256_PATTERN.test(values["--evidence-sha256"]) ||
        !SHA256_PATTERN.test(values["--continuous-probe-sha256"]) ||
        (Object.hasOwn(values, "--performance-evidence-sha256") &&
          !SHA256_PATTERN.test(values["--performance-evidence-sha256"])) ||
        (Object.hasOwn(values, "--companion-recovery-drill-sha256") &&
          !SHA256_PATTERN.test(values["--companion-recovery-drill-sha256"])) ||
        (command === "accept-standard" &&
          (!SHA256_PATTERN.test(values["--terminal-bundle-sha256"]) ||
            !SHA256_PATTERN.test(values["--terminal-object-set-sha256"]))))) ||
    (["activate-policy", "activate-policy-floor"].includes(command) &&
      !SHA256_PATTERN.test(values["--subject-sha256"]))
  ) {
    throw new Error("Release lifecycle arguments are incomplete or invalid");
  }
  return { command, values };
};

const resolveDistinctPaths = ({ command, values }, workingDirectory) => {
  const inputFlags = command.startsWith("record-")
    ? ["--prepared-result", "--promotion-receipt", "--assignment-authority"]
    : ["activate-policy", "activate-policy-floor"].includes(command)
      ? ["--subject"]
      : command === "describe-acceptance-requirements"
        ? []
        : ["--evidence", "--continuous-probe"];
  const outputFlags = ["--output"];
  if (command === "record-promotion") {
    inputFlags.push("--assignment-validation", "--production-probe");
  }
  if (command === "accept-standard") {
    inputFlags.push("--terminal-bundle", "--terminal-object-set");
  }
  if (command === "prepare-acceptance-bundle") {
    outputFlags.push(
      "--terminal-bundle-output",
      "--terminal-object-set-output",
    );
  }
  if (
    ["accept-standard", "prepare-acceptance-bundle"].includes(command) &&
    Object.hasOwn(values, "--performance-evidence")
  ) {
    inputFlags.push("--performance-evidence");
  }
  if (
    ["accept-standard", "prepare-acceptance-bundle"].includes(command) &&
    Object.hasOwn(values, "--companion-recovery-drill")
  ) {
    inputFlags.push("--companion-recovery-drill");
  }
  const paths = Object.fromEntries(
    [...inputFlags, ...outputFlags].map((flag) => [
      flag,
      path.resolve(workingDirectory, values[flag]),
    ]),
  );
  const identities = Object.values(paths).map((value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error("Lifecycle output and inputs must use distinct paths");
  }
  return paths;
};

const readBoundedRegularFile = async (
  filePath,
  { lstatImpl = lstat, readFileImpl = readFile } = {},
  maximumBytes = MAX_INPUT_BYTES,
) => {
  const metadata = await lstatImpl(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error("Lifecycle input path, type, or size is invalid");
  }
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== metadata.size ||
    bytes.length > maximumBytes
  ) {
    throw new Error("Lifecycle input changed while being read");
  }
  return bytes;
};

const assertOutputAvailable = async (filePath, lstatImpl) => {
  try {
    await lstatImpl(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Lifecycle output already exists");
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required lifecycle environment is absent: ${name}`);
  }
  return value;
};

const createBoundStore = async ({
  environment,
  namespace,
  storePolicy,
  createStore,
}) => {
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  return createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

const sourceFromPreparedResult = (bytes, executorSourceSha) => {
  const result = parseCanonicalJsonBytes(bytes, "Prepared promotion result");
  const operation = result.event?.payload?.pendingOperation;
  const sourceSha =
    operation?.kind === "promote-standard"
      ? operation?.targetBinding?.sourceSha
      : executorSourceSha;
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("Prepared promotion source identity is invalid");
  }
  return sourceSha;
};

const sourceFromAcceptanceEvidence = (bytes) => {
  const evidence = parseCanonicalJsonBytes(
    bytes,
    "Release A acceptance evidence",
  );
  const sourceSha = evidence.release?.commitSha;
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("Acceptance evidence source identity is invalid");
  }
  return sourceSha;
};

const sourceFromPolicyActivationSubject = (bytes) => {
  const subject = parseCanonicalJsonBytes(bytes, "Policy activation subject");
  const sourceSha = subject.executorSourceSha;
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new Error("Policy activation subject source identity is invalid");
  }
  return sourceSha;
};

export const runReleaseLifecycleCli = async (
  {
    arguments_ = process.argv.slice(2),
    environment = process.env,
    workingDirectory = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    lstatImpl = lstat,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    createStore = createPostgresReleaseStateStore,
    recordAssignment = recordPreparedPromotionAssignment,
    recordLifecycle = recordPreparedPromotionLifecycle,
    prepareAcceptance = preparePendingStandardAcceptanceBundle,
    acceptRelease = acceptPendingStandardRelease,
    describeAcceptanceRequirements = resolvePendingAcceptanceRequirements,
    activatePolicy = activateReleasePolicy,
    activatePolicyFloor = activateP8MinimumSafetyFloor,
    readState = readCurrentReleaseState,
  } = {},
) => {
  const parsed = parseReleaseLifecycleArguments(arguments_);
  const paths = resolveDistinctPaths(parsed, workingDirectory);
  const outputPaths = [paths["--output"]];
  if (parsed.command === "prepare-acceptance-bundle") {
    outputPaths.push(
      paths["--terminal-bundle-output"],
      paths["--terminal-object-set-output"],
    );
  }
  await Promise.all(
    outputPaths.map((outputPath) =>
      assertOutputAvailable(outputPath, lstatImpl),
    ),
  );
  const namespace = parsed.values["--namespace"];
  const [storePolicy, approvalPolicy] = await Promise.all([
    loadJson(path.join(root, "config", "release-state-store.json")),
    loadJson(path.join(root, "config", "approval-policy.json")),
  ]);
  const inputOptions = { lstatImpl, readFileImpl };
  let sourceSha;
  let input;
  if (parsed.command.startsWith("record-")) {
    const commonInputs = await Promise.all([
      readBoundedRegularFile(paths["--prepared-result"], inputOptions),
      readBoundedRegularFile(paths["--promotion-receipt"], inputOptions),
      readBoundedRegularFile(paths["--assignment-authority"], inputOptions),
      loadJson(path.join(root, "config", "provider-policy.json")),
    ]);
    const [
      preparedResultBytes,
      promotionReceiptBytes,
      assignmentAuthorityBytes,
      providerPolicy,
    ] = commonInputs;
    sourceSha = sourceFromPreparedResult(
      preparedResultBytes,
      environment.GITHUB_SHA,
    );
    input = {
      preparedResultBytes,
      promotionReceiptBytes,
      assignmentAuthorityBytes,
      providerPolicy,
    };
    if (parsed.command === "record-promotion") {
      const [assignmentValidationBytes, productionProbeBytes] =
        await Promise.all([
          readBoundedRegularFile(
            paths["--assignment-validation"],
            inputOptions,
          ),
          readBoundedRegularFile(paths["--production-probe"], inputOptions),
        ]);
      input.assignmentValidationBytes = assignmentValidationBytes;
      input.productionProbeBytes = productionProbeBytes;
    }
  } else if (
    ["activate-policy", "activate-policy-floor"].includes(parsed.command)
  ) {
    const subjectBytes = await readBoundedRegularFile(
      paths["--subject"],
      inputOptions,
    );
    const expectedSubjectSha256 = parsed.values["--subject-sha256"];
    if (sha256Bytes(subjectBytes) !== expectedSubjectSha256) {
      throw new Error(
        "Policy activation subject differs from the reviewed SHA-256",
      );
    }
    sourceSha = sourceFromPolicyActivationSubject(subjectBytes);
    input = { subjectBytes, expectedSubjectSha256 };
  } else if (parsed.command === "describe-acceptance-requirements") {
    sourceSha = requireEnvironment(environment, "GITHUB_SHA");
    input = {};
  } else {
    const [evidenceBytes, continuousProbeBytes] = await Promise.all([
      readBoundedRegularFile(paths["--evidence"], inputOptions),
      readBoundedRegularFile(paths["--continuous-probe"], inputOptions),
    ]);
    const expectedEvidenceSha256 = parsed.values["--evidence-sha256"];
    const expectedContinuousProbeSha256 =
      parsed.values["--continuous-probe-sha256"];
    if (sha256Bytes(evidenceBytes) !== expectedEvidenceSha256) {
      throw new Error("Acceptance evidence differs from the reviewed SHA-256");
    }
    if (sha256Bytes(continuousProbeBytes) !== expectedContinuousProbeSha256) {
      throw new Error(
        "Continuous production probe differs from the reviewed SHA-256",
      );
    }
    sourceSha = sourceFromAcceptanceEvidence(evidenceBytes);
    input = {
      evidenceBytes,
      expectedEvidenceSha256,
      continuousProbeBytes,
      expectedContinuousProbeSha256,
      performanceEvidenceBytes: null,
      expectedPerformanceEvidenceSha256: null,
    };
    if (Object.hasOwn(parsed.values, "--performance-evidence")) {
      const performanceEvidenceBytes = await readBoundedRegularFile(
        paths["--performance-evidence"],
        inputOptions,
      );
      const expectedPerformanceEvidenceSha256 =
        parsed.values["--performance-evidence-sha256"];
      if (
        sha256Bytes(performanceEvidenceBytes) !==
        expectedPerformanceEvidenceSha256
      ) {
        throw new Error(
          "Performance evidence differs from the reviewed SHA-256",
        );
      }
      input.performanceEvidenceBytes = performanceEvidenceBytes;
      input.expectedPerformanceEvidenceSha256 =
        expectedPerformanceEvidenceSha256;
    }
    if (parsed.command === "prepare-acceptance-bundle") {
      const dbCompatibilityContract = await loadJson(
        path.join(root, "config", "db-compatibility-contract.json"),
      );
      input.dbCompatibilityContractBytes = canonicalJsonBytes(
        dbCompatibilityContract,
      );
    } else {
      const [terminalBundleBytes, terminalObjectSetBytes] = await Promise.all([
        readBoundedRegularFile(paths["--terminal-bundle"], inputOptions),
        readBoundedRegularFile(
          paths["--terminal-object-set"],
          inputOptions,
          MAX_TERMINAL_OBJECT_SET_BYTES,
        ),
      ]);
      input.terminalBundleBytes = terminalBundleBytes;
      input.expectedTerminalBundleSha256 =
        parsed.values["--terminal-bundle-sha256"];
      input.terminalObjectSetBytes = terminalObjectSetBytes;
      input.expectedTerminalObjectSetSha256 =
        parsed.values["--terminal-object-set-sha256"];
      if (
        sha256Bytes(terminalBundleBytes) !==
          input.expectedTerminalBundleSha256 ||
        sha256Bytes(terminalObjectSetBytes) !==
          input.expectedTerminalObjectSetSha256
      ) {
        throw new Error(
          "Acceptance terminal artifact differs from its reviewed SHA-256",
        );
      }
    }
    if (Object.hasOwn(parsed.values, "--companion-recovery-drill")) {
      const companionRecoveryDrillBytes = await readBoundedRegularFile(
        paths["--companion-recovery-drill"],
        inputOptions,
      );
      const expectedCompanionRecoveryDrillSha256 =
        parsed.values["--companion-recovery-drill-sha256"];
      if (
        sha256Bytes(companionRecoveryDrillBytes) !==
        expectedCompanionRecoveryDrillSha256
      ) {
        throw new Error(
          "Companion recovery drill differs from the reviewed SHA-256",
        );
      }
      input.companionRecoveryDrillBytes = companionRecoveryDrillBytes;
      input.expectedCompanionRecoveryDrillSha256 =
        expectedCompanionRecoveryDrillSha256;
    }
  }
  const runId = requireEnvironment(environment, "GITHUB_RUN_ID");
  assertProtectedWorkflowEnvironment({
    env: environment,
    approvalPolicy,
    namespace,
    sourceSha,
    runId,
  });
  const store = await createBoundStore({
    environment,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    let result;
    if (parsed.command === "describe-acceptance-requirements") {
      result = await describeAcceptanceRequirements({ store });
      if (result.sourceSha !== sourceSha) {
        throw new Error(
          "Acceptance requirements source differs from the workflow source",
        );
      }
    } else if (parsed.command === "record-assignment") {
      result = await recordAssignment({
        store,
        ...input,
        environment,
      });
    } else if (parsed.command === "record-promotion") {
      try {
        result = await recordLifecycle({
          store,
          ...input,
          environment,
        });
      } catch (error) {
        const prepared = parseCanonicalJsonBytes(
          input.preparedResultBytes,
          "Prepared recovery result",
        );
        const operation = prepared.event?.payload?.pendingOperation;
        const recoveryKinds = new Set([
          "rollback-standard",
          "activate-containment",
          "redeploy-standard",
          "redeploy-containment",
        ]);
        if (recoveryKinds.has(operation?.kind)) {
          const current = await readState({ store, requireInitialized: true });
          const assignmentRecorded = current.records.some(
            (record) =>
              record.event.eventType === "deployment-assigned" &&
              record.event.operationId === operation.operationId,
          );
          if (
            assignmentRecorded &&
            current.snapshot.pendingOperation?.operationId ===
              operation.operationId &&
            current.snapshot.pendingOperation?.targetBinding?.bindingId ===
              operation.targetBinding.bindingId
          ) {
            const reconcileRequired = {
              schemaVersion: 1,
              resultKind: "recovery-reconcile-required/v1",
              status: "pending-provider-reconcile",
              reasonCode: "terminal-cas-not-committed-after-assignment",
              namespace,
              operationId: operation.operationId,
              operationKind: operation.kind,
              targetBindingId: operation.targetBinding.bindingId,
              expectedState: current.head,
              promotionReceiptSha256: sha256Bytes(input.promotionReceiptBytes),
              providerObservationRequired: true,
              reconcileOperation: "reconcile",
            };
            await writeFileImpl(
              paths["--output"],
              canonicalJsonBytes(reconcileRequired),
              { flag: "wx", mode: 0o600 },
            );
          }
        }
        throw error;
      }
    } else if (parsed.command === "prepare-acceptance-bundle") {
      result = await prepareAcceptance({
        store,
        ...input,
        approvalPolicy,
        expectedRunId: runId,
        oidcRequestUrl: requireEnvironment(
          environment,
          "ACTIONS_ID_TOKEN_REQUEST_URL",
        ),
        oidcRequestToken: requireEnvironment(
          environment,
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        ),
        githubToken: requireEnvironment(environment, "APPROVAL_GITHUB_TOKEN"),
      });
    } else if (
      ["activate-policy", "activate-policy-floor"].includes(parsed.command)
    ) {
      const activate =
        parsed.command === "activate-policy"
          ? activatePolicy
          : activatePolicyFloor;
      result = await activate({
        store,
        ...input,
        approvalPolicy,
        expectedExecutorSourceSha: sourceSha,
        expectedRunId: runId,
        oidcRequestUrl: requireEnvironment(
          environment,
          "ACTIONS_ID_TOKEN_REQUEST_URL",
        ),
        oidcRequestToken: requireEnvironment(
          environment,
          "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        ),
        githubToken: requireEnvironment(environment, "APPROVAL_GITHUB_TOKEN"),
      });
    } else {
      result = await acceptRelease({
        store,
        ...input,
        approvalPolicy,
        expectedRunId: runId,
      });
    }
    let outputValue = result;
    const writes = [];
    if (parsed.command === "prepare-acceptance-bundle") {
      outputValue = Object.fromEntries(
        Object.entries(result).filter(
          ([key]) =>
            !["bundle", "bundleBytes", "objectSet", "objectSetBytes"].includes(
              key,
            ),
        ),
      );
      writes.push(
        writeFileImpl(paths["--terminal-bundle-output"], result.bundleBytes, {
          flag: "wx",
          mode: 0o600,
        }),
        writeFileImpl(
          paths["--terminal-object-set-output"],
          result.objectSetBytes,
          {
            flag: "wx",
            mode: 0o600,
          },
        ),
      );
    }
    writes.push(
      writeFileImpl(paths["--output"], canonicalJsonBytes(outputValue), {
        flag: "wx",
        mode: 0o600,
      }),
    );
    await Promise.all(writes);
    stdout.write(
      `PASS release lifecycle ${parsed.command}: ${result.operationId}\n`,
    );
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runReleaseLifecycleCli();
}
