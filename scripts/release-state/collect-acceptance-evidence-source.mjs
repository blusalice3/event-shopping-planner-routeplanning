#!/usr/bin/env node

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import { validateReleaseAEvidence } from "../verify-release-a-evidence.mjs";
import {
  GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
  collectContinuousProductionSample,
  collectReleaseAEvidenceAuthority,
  createCompanionRecoverySource,
  initializeContinuousProbeCollection,
} from "./acceptanceEvidenceAuthority.mjs";
import {
  assertCompanionRecoverySourceSchema,
  assertContinuousProbeSourceSchema,
} from "./acceptanceEvidenceSchemas.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  assertStoredGitHubOidcReceipt,
  assertVerifiedGitHubOidcResult,
  deriveGitHubOidcPolicy,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  assertExactKeys,
  parseCanonicalJsonBytes,
} from "./releaseWorkflowValidation.mjs";
import {
  collectReviewedWorkflowRunAuthority,
  readReviewedWorkflowRunAuthority,
} from "./reviewedWorkflowRunAuthority.mjs";

export const ACCEPTANCE_COLLECTOR_RECEIPT_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.acceptance-collector-receipt+json;version=1";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_FLAGS = {
  initialize: ["--namespace", "--output-directory"],
  append: [
    "--namespace",
    "--prior-source",
    "--prior-source-sha256",
    "--prior-receipt",
    "--prior-receipt-sha256",
    "--output-directory",
  ],
  finalize: [
    "--namespace",
    "--prior-source",
    "--prior-source-sha256",
    "--prior-receipt",
    "--prior-receipt-sha256",
    "--companion-terminal-event-sha256",
    "--output-directory",
  ],
};
const RECEIPT_KEYS = [
  "collectorIdentity",
  "command",
  "createdAt",
  "evidenceKind",
  "namespace",
  "operationId",
  "outputs",
  "prior",
  "runId",
  "schemaVersion",
  "sourceSha",
];
const PRIOR_KEYS = ["receiptReference", "sourceSha256", "workflowRunAuthority"];
const OUTPUT_KEYS = [
  "authorityBundle",
  "companionSourceSha256",
  "continuousSourceSha256",
  "releaseAEvidenceSha256",
  "sourceTransaction",
];

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required acceptance collector environment is absent: ${name}`,
    );
  }
  return value;
};

export const parseAcceptanceCollectorArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length < 1) {
    throw new Error("Acceptance collector command is required");
  }
  const [command, ...tokens] = arguments_;
  const flags = COMMAND_FLAGS[command];
  if (!flags || tokens.length !== flags.length * 2) {
    throw new Error(
      `Acceptance collector ${String(command)} arguments are invalid`,
    );
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !flags.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Acceptance collector option is invalid: ${String(flag)}`,
      );
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== flags.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    (command !== "initialize" &&
      (!SHA256_PATTERN.test(values["--prior-source-sha256"]) ||
        !SHA256_PATTERN.test(values["--prior-receipt-sha256"]))) ||
    (command === "finalize" &&
      values["--companion-terminal-event-sha256"] !== "none" &&
      !SHA256_PATTERN.test(values["--companion-terminal-event-sha256"]))
  ) {
    throw new Error("Acceptance collector reviewed bindings are invalid");
  }
  return { command, values };
};

const readBoundedCanonicalFile = async (
  filePath,
  expectedSha256,
  { lstatImpl, readFileImpl },
) => {
  const metadata = await lstatImpl(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > MAX_INPUT_BYTES
  ) {
    throw new Error("Acceptance collector reviewed input is invalid");
  }
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== metadata.size ||
    sha256Bytes(bytes) !== expectedSha256
  ) {
    throw new Error("Acceptance collector reviewed input hash differs");
  }
  return {
    bytes,
    value: parseCanonicalJsonBytes(
      bytes,
      "Acceptance collector reviewed input",
    ),
  };
};

const putExact = async ({ store, namespace, bytes, mediaType, label }) => {
  const input = Buffer.from(bytes);
  const sha256 = sha256Bytes(input);
  const reference = {
    uri: `release-state://${namespace}/evidence/${sha256}`,
    sha256,
  };
  const receipt = await store.putEvidence({ bytes: input, mediaType });
  const readback = await store.readEvidence({ sha256 });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== input.length ||
    !readback?.bytes?.equals(input) ||
    readback.mediaType !== mediaType ||
    readback.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store receipt differs`);
  }
  return { reference, committedAt: receipt.committedAt };
};

const createStore = async ({
  environment,
  namespace,
  storePolicy,
  factory,
}) => {
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  return factory({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

const collectOidcIdentity = async ({
  environment,
  approvalPolicy,
  sourceSha,
  runId,
  store,
  namespace,
  requestOidcToken,
  verifyOidcToken,
  nowMilliseconds,
}) => {
  const token = await requestOidcToken({
    requestUrl: requireEnvironment(environment, "ACTIONS_ID_TOKEN_REQUEST_URL"),
    requestToken: requireEnvironment(
      environment,
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    ),
    audience: approvalPolicy.oidcAudience,
  });
  const verified = await verifyOidcToken({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: runId,
    nowMs: nowMilliseconds,
  });
  assertVerifiedGitHubOidcResult(verified);
  return (
    await putExact({
      store,
      namespace,
      bytes: verified.receiptBytes,
      mediaType: GITHUB_OIDC_RECEIPT_MEDIA_TYPE,
      label: "Acceptance collector OIDC receipt",
    })
  ).reference;
};

export const resolveReviewedAcceptanceCollectorAuthority = async ({
  store,
  namespace,
  input,
  expectedSourceSha256,
  expectedReleaseAEvidenceSha256 = null,
  currentRunId,
  pendingAcceptance,
  approvalPolicy,
  environment,
  allowedCommands,
  collectRunAuthority = collectReviewedWorkflowRunAuthority,
}) => {
  const receipt = input.value;
  assertExactKeys(receipt, RECEIPT_KEYS, "Prior acceptance collector receipt");
  assertExactKeys(receipt.outputs, OUTPUT_KEYS, "Prior collector outputs");
  if (receipt.prior !== null) {
    assertExactKeys(receipt.prior, PRIOR_KEYS, "Prior collector predecessor");
  }
  if (
    receipt.schemaVersion !== 1 ||
    receipt.evidenceKind !== "acceptance-collector-receipt/v1" ||
    receipt.namespace !== namespace ||
    receipt.operationId !== pendingAcceptance.operationId ||
    receipt.sourceSha !== pendingAcceptance.standardBinding.sourceSha ||
    receipt.runId === currentRunId ||
    receipt.outputs?.continuousSourceSha256 !== expectedSourceSha256 ||
    !allowedCommands.includes(receipt.command) ||
    (expectedReleaseAEvidenceSha256 !== null &&
      receipt.outputs?.releaseAEvidenceSha256 !==
        expectedReleaseAEvidenceSha256)
  ) {
    throw new Error("Prior acceptance collector receipt binding differs");
  }
  const reference = {
    uri: `release-state://${namespace}/evidence/${sha256Bytes(input.bytes)}`,
    sha256: sha256Bytes(input.bytes),
  };
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !stored?.bytes?.equals(input.bytes) ||
    stored.mediaType !== ACCEPTANCE_COLLECTOR_RECEIPT_MEDIA_TYPE
  ) {
    throw new Error("Prior acceptance collector receipt is not authoritative");
  }
  const oidcStored = await store.readEvidence({
    sha256: receipt.collectorIdentity?.sha256,
  });
  if (
    !oidcStored ||
    oidcStored.mediaType !== GITHUB_OIDC_RECEIPT_MEDIA_TYPE ||
    sha256Bytes(oidcStored.bytes) !== receipt.collectorIdentity?.sha256
  ) {
    throw new Error("Prior acceptance collector OIDC identity is absent");
  }
  const oidc = parseCanonicalJsonBytes(
    oidcStored.bytes,
    "Prior acceptance collector OIDC identity",
  );
  const workflowPath = ".github/workflows/release.yml";
  const oidcPolicy = deriveGitHubOidcPolicy({
    basePolicy: approvalPolicy,
    workflowPath,
    protectedEnvironment: approvalPolicy.protectedEnvironment,
  });
  assertStoredGitHubOidcReceipt({
    receipt: oidc,
    policy: oidcPolicy,
    expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
    expectedRunId: receipt.runId,
  });
  if (receipt.prior !== null) {
    await readReviewedWorkflowRunAuthority({
      namespace,
      repository: approvalPolicy.repository,
      expectedRunId: receipt.prior.workflowRunAuthority.runId,
      expectedRunAttempt: receipt.prior.workflowRunAuthority.runAttempt,
      expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
      expectedWorkflowPath: workflowPath,
      reference: receipt.prior.workflowRunAuthority.receipt,
      store,
    });
  }
  const runAuthority = await collectRunAuthority({
    githubToken: requireEnvironment(environment, "GITHUB_TOKEN"),
    namespace,
    repository: approvalPolicy.repository,
    expectedRunId: receipt.runId,
    expectedRunAttempt: oidc.claims.runAttempt,
    expectedSourceSha: pendingAcceptance.standardBinding.sourceSha,
    expectedWorkflowPath: workflowPath,
    store,
  });
  return {
    receipt,
    reference,
    workflowRunAuthority: {
      runId: receipt.runId,
      runAttempt: oidc.claims.runAttempt,
      receipt: runAuthority.receipt,
    },
  };
};

const writeOutputSet = async ({
  outputDirectory,
  files,
  mkdirImpl,
  writeFileImpl,
}) => {
  await mkdirImpl(outputDirectory, { recursive: false, mode: 0o700 });
  await Promise.all(
    Object.entries(files).map(([name, bytes]) =>
      writeFileImpl(path.join(outputDirectory, name), bytes, {
        flag: "wx",
        mode: 0o600,
      }),
    ),
  );
};

export const runAcceptanceCollectorCli = async (
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
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    storeFactory = createPostgresReleaseStateStore,
    readState = readCurrentReleaseState,
    requestOidcToken = requestGitHubOidcToken,
    verifyOidcToken = verifyGitHubOidcTokenFromIssuer,
    collectIdentity = collectOidcIdentity,
    collectRunAuthority = collectReviewedWorkflowRunAuthority,
    validateEvidence = validateReleaseAEvidence,
    fetchImpl = globalThis.fetch,
    clock = Date.now,
  } = {},
) => {
  const parsed = parseAcceptanceCollectorArguments(arguments_);
  const namespace = parsed.values["--namespace"];
  const outputDirectory = path.resolve(
    workingDirectory,
    parsed.values["--output-directory"],
  );
  try {
    await lstatImpl(outputDirectory);
    throw new Error("Acceptance collector output directory already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const [approvalPolicy, storePolicy, providerPolicy] = await Promise.all([
    loadJson(path.join(root, "config", "approval-policy.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
    loadJson(path.join(root, "config", "provider-policy.json")),
  ]);
  const store = await createStore({
    environment,
    namespace,
    storePolicy,
    factory: storeFactory,
  });
  try {
    const current = await readState({ store });
    const pendingAcceptance = current.snapshot.pendingAcceptance;
    if (!pendingAcceptance) {
      throw new Error(
        "Acceptance collector has no pending standard acceptance",
      );
    }
    const sourceSha = pendingAcceptance.standardBinding.sourceSha;
    const runId = requireEnvironment(environment, "GITHUB_RUN_ID");
    assertProtectedWorkflowEnvironment({
      env: environment,
      approvalPolicy,
      namespace,
      sourceSha,
      runId,
    });
    const nowMilliseconds = Number(clock());
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("Acceptance collector clock is invalid");
    }
    const collectorIdentity = await collectIdentity({
      environment,
      approvalPolicy,
      sourceSha,
      runId,
      store,
      namespace,
      requestOidcToken,
      verifyOidcToken,
      nowMilliseconds,
    });

    let prior = null;
    let priorSource = null;
    if (parsed.command !== "initialize") {
      const sourcePath = path.resolve(
        workingDirectory,
        parsed.values["--prior-source"],
      );
      const receiptPath = path.resolve(
        workingDirectory,
        parsed.values["--prior-receipt"],
      );
      if (sourcePath === receiptPath || sourcePath === outputDirectory) {
        throw new Error(
          "Acceptance collector input/output paths are not distinct",
        );
      }
      const [sourceInput, receiptInput] = await Promise.all([
        readBoundedCanonicalFile(
          sourcePath,
          parsed.values["--prior-source-sha256"],
          { lstatImpl, readFileImpl },
        ),
        readBoundedCanonicalFile(
          receiptPath,
          parsed.values["--prior-receipt-sha256"],
          { lstatImpl, readFileImpl },
        ),
      ]);
      prior = await resolveReviewedAcceptanceCollectorAuthority({
        store,
        namespace,
        input: receiptInput,
        expectedSourceSha256: parsed.values["--prior-source-sha256"],
        currentRunId: runId,
        pendingAcceptance,
        approvalPolicy,
        environment,
        allowedCommands: ["initialize", "append"],
        collectRunAuthority,
      });
      priorSource = sourceInput.value;
    }

    let continuousSource;
    let releaseAEvidenceBytes = null;
    let companionSourceBytes = null;
    let sourceTransaction = null;
    let authorityBundle = null;
    if (parsed.command === "initialize") {
      continuousSource = (
        await initializeContinuousProbeCollection({
          store,
          namespace,
          pendingAcceptance,
          collectorIdentity,
        })
      ).source;
    } else if (parsed.command === "append") {
      continuousSource = (
        await collectContinuousProductionSample({
          store,
          namespace,
          pendingAcceptance,
          providerPolicy,
          providerToken: requireEnvironment(environment, "VERCEL_TOKEN"),
          collectorIdentity,
          priorSource,
          fetchImpl,
          clock: () => nowMilliseconds,
        })
      ).source;
    } else {
      const terminalHash =
        parsed.values["--companion-terminal-event-sha256"] === "none"
          ? null
          : parsed.values["--companion-terminal-event-sha256"];
      const terminalReference =
        terminalHash === null
          ? null
          : createCompanionRecoverySource({
              current,
              namespace,
              pendingAcceptance,
              authorityBundle: priorSource.authorityBundle,
              terminalEventSha256: terminalHash,
            }).packageRedeployTerminalEvent;
      const finalized = await collectReleaseAEvidenceAuthority({
        store,
        current,
        namespace,
        pendingAcceptance,
        providerPolicy,
        evidenceUrl: requireEnvironment(environment, "RELEASE_A_EVIDENCE_URL"),
        evidenceToken: requireEnvironment(
          environment,
          "RELEASE_A_EVIDENCE_TOKEN",
        ),
        collectorIdentity,
        continuousSource: priorSource,
        rollbackTerminalEvent: terminalReference,
        validateEvidence,
        fetchImpl,
        clock: () => nowMilliseconds,
      });
      continuousSource = finalized.continuousSource;
      releaseAEvidenceBytes = finalized.releaseAEvidenceBytes;
      sourceTransaction = finalized.sourceTransaction;
      authorityBundle = finalized.authority.reference;
      if (terminalHash !== null) {
        companionSourceBytes = canonicalJsonBytes(
          createCompanionRecoverySource({
            current,
            namespace,
            pendingAcceptance,
            authorityBundle,
            terminalEventSha256: terminalHash,
          }),
        );
      }
    }

    assertContinuousProbeSourceSchema(continuousSource);
    if (companionSourceBytes !== null) {
      assertCompanionRecoverySourceSchema(
        parseCanonicalJsonBytes(
          companionSourceBytes,
          "Companion recovery collector source",
        ),
      );
    }
    const continuousSourceBytes = canonicalJsonBytes(continuousSource);
    const outputs = {
      continuousSourceSha256: sha256Bytes(continuousSourceBytes),
      releaseAEvidenceSha256:
        releaseAEvidenceBytes === null
          ? null
          : sha256Bytes(releaseAEvidenceBytes),
      companionSourceSha256:
        companionSourceBytes === null
          ? null
          : sha256Bytes(companionSourceBytes),
      authorityBundle,
      sourceTransaction,
    };
    const collectorReceiptBytes = canonicalJsonBytes({
      schemaVersion: 1,
      evidenceKind: "acceptance-collector-receipt/v1",
      namespace,
      operationId: pendingAcceptance.operationId,
      sourceSha,
      command: parsed.command,
      runId,
      createdAt: new Date(nowMilliseconds).toISOString(),
      collectorIdentity,
      prior:
        prior === null
          ? null
          : {
              sourceSha256: parsed.values["--prior-source-sha256"],
              receiptReference: prior.reference,
              workflowRunAuthority: prior.workflowRunAuthority,
            },
      outputs,
    });
    const collectorReceipt = await putExact({
      store,
      namespace,
      bytes: collectorReceiptBytes,
      mediaType: ACCEPTANCE_COLLECTOR_RECEIPT_MEDIA_TYPE,
      label: "Acceptance collector receipt",
    });
    const files = {
      "continuous-production-probe-source.json": continuousSourceBytes,
      "acceptance-collector-receipt.json": collectorReceiptBytes,
    };
    if (releaseAEvidenceBytes !== null) {
      files["release-a-acceptance-evidence.json"] = releaseAEvidenceBytes;
    }
    if (companionSourceBytes !== null) {
      files["companion-recovery-drill-source.json"] = companionSourceBytes;
    }
    await writeOutputSet({
      outputDirectory,
      files,
      mkdirImpl,
      writeFileImpl,
    });
    stdout.write(
      `PASS acceptance collector ${parsed.command}: ${collectorReceipt.reference.sha256}\n`,
    );
    return {
      command: parsed.command,
      outputs,
      collectorReceipt: collectorReceipt.reference,
    };
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runAcceptanceCollectorCli();
}
