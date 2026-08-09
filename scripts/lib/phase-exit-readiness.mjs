import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalJsonBytes,
  readJsonStrict,
  sha256Bytes,
  sha256Json,
} from "./canonical-json.mjs";
import { resolveExternalPhaseExitAuthorities } from "./phase-exit-external-authority.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  readPhaseExitAttestationLedger,
  validatePhaseExitAttestationChain,
} from "../release-state/phaseExitAttestation.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_REQUIRED_AUTHORITIES,
  PRE_RELEASE_PHASE_EXIT_GATES,
  RELEASE_PHASE_GATES,
} from "../release-state/phaseGates.mjs";
import { resolveCurrentPhaseExitSupportingEvent } from "../release-state/phaseExitSupportingEvent.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const EXPECTED_AUTHORITIES = PHASE_EXIT_REQUIRED_AUTHORITIES;

const AUTHORITY_IDS = new Set(Object.values(EXPECTED_AUTHORITIES).flat());
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const brandedResolutions = new WeakSet();

const compareUtf8 = (left, right) =>
  Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).sort(compareUtf8).join("\n") ===
    [...expected].sort(compareUtf8).join("\n");

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

export const assertPhaseExitReadinessManifest = (manifest) => {
  if (
    !exactKeys(manifest, [
      "schemaVersion",
      "formalExitSequence",
      "authorities",
    ]) ||
    manifest.schemaVersion !== 1 ||
    canonicalJsonBytes(manifest.formalExitSequence).compare(
      canonicalJsonBytes(FORMAL_PHASE_EXIT_GATES),
    ) !== 0 ||
    !exactKeys(manifest.authorities, FORMAL_PHASE_EXIT_GATES) ||
    canonicalJsonBytes(manifest.authorities).compare(
      canonicalJsonBytes(EXPECTED_AUTHORITIES),
    ) !== 0
  ) {
    throw new Error(
      "Phase exit readiness manifest shape or sequence is invalid",
    );
  }
  for (const gate of FORMAL_PHASE_EXIT_GATES) {
    const authorities = manifest.authorities[gate];
    if (
      !Array.isArray(authorities) ||
      authorities.length === 0 ||
      new Set(authorities).size !== authorities.length ||
      authorities.some((authority) => !AUTHORITY_IDS.has(authority))
    ) {
      throw new Error(`${gate}: phase exit authority set is invalid`);
    }
  }
  return manifest;
};

const normalizeBlockers = (values) => [...new Set(values)].sort(compareUtf8);

const createBlockersByGate = () =>
  Object.fromEntries(FORMAL_PHASE_EXIT_GATES.map((gate) => [gate, []]));

const createAuthorityEvidenceByGate = (manifest) =>
  Object.fromEntries(
    FORMAL_PHASE_EXIT_GATES.map((gate) => [
      gate,
      Object.fromEntries(
        manifest.authorities[gate].map((authorityId) => [authorityId, []]),
      ),
    ]),
  );

const addBlockers = (blockersByGate, gate, values) => {
  if (!FORMAL_PHASE_EXIT_GATES.includes(gate)) return;
  blockersByGate[gate].push(
    ...values.filter((value) => typeof value === "string" && value.length > 0),
  );
};

const assertAuthorityReference = (reference) => {
  if (
    !exactKeys(reference, ["sha256", "uri"]) ||
    !SHA256_PATTERN.test(reference.sha256) ||
    typeof reference.uri !== "string" ||
    reference.uri.length === 0 ||
    !reference.uri.endsWith(`/${reference.sha256}`)
  ) {
    throw new Error("Resolved phase authority reference is invalid");
  }
};

const addAuthorityReference = (
  authorityEvidenceByGate,
  gate,
  authorityId,
  reference,
) => {
  assertAuthorityReference(reference);
  const references = authorityEvidenceByGate[gate]?.[authorityId];
  if (!Array.isArray(references)) {
    throw new Error(`${gate}/${authorityId}: phase authority is not declared`);
  }
  if (!references.some(({ sha256 }) => sha256 === reference.sha256)) {
    references.push({ ...reference });
  }
};

const verifierReference = (authorityId, sha256) => ({
  uri: `repository-verifier://${authorityId}/${sha256}`,
  sha256,
});

const isRepositoryAncestor = (ancestor, descendant) =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    windowsHide: true,
  }).status === 0;

const eventReference = (namespace, record) => ({
  uri:
    `release-state://${namespace}/events/${record.sequence}/` +
    record.eventHash,
  sha256: record.eventHash,
});

const resolveLiveReleaseState = async ({
  store,
  authorityEvidenceByGate,
  externalAuthorityBundleSha256,
  currentWorkflowRunId,
  sourceSha,
  policies,
}) => {
  const current = await readCurrentReleaseState({
    store,
    requireInitialized: false,
  });
  const namespace = current.records[0]?.event?.namespace ?? store.namespace;
  if (current.snapshot === null) {
    const externalAuthorities =
      externalAuthorityBundleSha256 === null
        ? null
        : await resolveExternalPhaseExitAuthorities({
            store,
            bundleSha256: externalAuthorityBundleSha256,
            current,
            sourceSha,
            providerPolicy: policies.provider,
            approvalPolicy: policies.approval,
            storePolicy: policies.store,
            databaseContract: policies.database,
            retentionPolicy: policies.retention,
            startupBurstContract: policies.startupBurst,
            cspPolicy: policies.csp,
            backupRestorePrerequisitePolicy: policies.externalPrerequisites,
            backupRestoreProviderContract: policies.backupRestoreProvider,
            artifactDrillPolicy: policies.artifactDrill,
            p0aPolicy: policies.p0a,
            releasePolicy: policies.release,
            toolchainPolicy: policies.toolchain,
            foundationBaseline: policies.foundationBaseline,
            currentWorkflowRunId,
          });
    for (const resolved of externalAuthorities?.references ?? []) {
      addAuthorityReference(
        authorityEvidenceByGate,
        resolved.gate,
        resolved.authority,
        resolved.reference,
      );
    }
    const releaseState = {
      namespace,
      head: { sequence: 0, eventHash: null },
      acceptedGate: null,
    };
    return externalAuthorities === null
      ? releaseState
      : {
          ...releaseState,
          externalAuthorityBundle: externalAuthorities.bundle,
          externalAuthorityTargetGate: externalAuthorities.targetGate,
          externalAuthoritySubject: externalAuthorities.subject,
        };
  }
  const initialized = current.records[0];
  if (initialized.event.eventType !== "state-initialized") {
    throw new Error("Release State replay does not start with initialization");
  }
  if (initialized.event.payload?.executorSourceSha === sourceSha) {
    addAuthorityReference(
      authorityEvidenceByGate,
      "P0-DATA",
      "state-initialized",
      eventReference(namespace, initialized),
    );
  }

  const promotionSupport = resolveCurrentPhaseExitSupportingEvent({
    current,
    gate: "P0-PROMOTE",
    sourceSha,
    subjectHead: current.head,
  });
  if (promotionSupport !== null) {
    addAuthorityReference(
      authorityEvidenceByGate,
      "P0-PROMOTE",
      "assignment-validated",
      eventReference(namespace, current.records[promotionSupport.sequence - 1]),
    );
  }

  const acceptedGate = current.snapshot.acceptedGate;
  if (acceptedGate !== null && !RELEASE_PHASE_GATES.includes(acceptedGate)) {
    throw new Error("Release State terminal accepted gate is invalid");
  }
  if (acceptedGate !== null) {
    const acceptanceSupport = resolveCurrentPhaseExitSupportingEvent({
      current,
      gate: acceptedGate,
      sourceSha,
      subjectHead: current.head,
    });
    if (acceptanceSupport !== null) {
      addAuthorityReference(
        authorityEvidenceByGate,
        acceptedGate,
        "accepted-gate",
        eventReference(
          namespace,
          current.records[acceptanceSupport.sequence - 1],
        ),
      );
    }
  }
  if (
    acceptedGate === "P8-CLEAN" &&
    current.snapshot.minimumSafetyFloors?.styleSrcAttr === "none"
  ) {
    const p8FloorActivation = current.records.find(
      ({ event }) =>
        event.eventType === "policy-activated" &&
        event.payload.activationGate === "P8-CLEAN",
    );
    if (!p8FloorActivation) {
      throw new Error("P8 safety floor is not bound to an activation event");
    }
    addAuthorityReference(
      authorityEvidenceByGate,
      "P8-CLEAN",
      "minimum-safety-floor-activated",
      eventReference(namespace, p8FloorActivation),
    );
  }

  const externalAuthorities =
    externalAuthorityBundleSha256 === null
      ? null
      : await resolveExternalPhaseExitAuthorities({
          store,
          bundleSha256: externalAuthorityBundleSha256,
          current,
          sourceSha,
          providerPolicy: policies.provider,
          approvalPolicy: policies.approval,
          storePolicy: policies.store,
          databaseContract: policies.database,
          retentionPolicy: policies.retention,
          startupBurstContract: policies.startupBurst,
          cspPolicy: policies.csp,
          backupRestorePrerequisitePolicy: policies.externalPrerequisites,
          backupRestoreProviderContract: policies.backupRestoreProvider,
          artifactDrillPolicy: policies.artifactDrill,
          p0aPolicy: policies.p0a,
          releasePolicy: policies.release,
          toolchainPolicy: policies.toolchain,
          foundationBaseline: policies.foundationBaseline,
          currentWorkflowRunId,
        });
  for (const resolved of externalAuthorities?.references ?? []) {
    addAuthorityReference(
      authorityEvidenceByGate,
      resolved.gate,
      resolved.authority,
      resolved.reference,
    );
  }

  const ledger = readPhaseExitAttestationLedger(current);
  if (ledger.length > 0) {
    const chain = await validatePhaseExitAttestationChain({
      store,
      head: ledger.at(-1).attestation,
      current,
      currentSourceSha: sourceSha,
      isSourceAncestor: isRepositoryAncestor,
    });
    if (
      chain.length !== ledger.length ||
      chain.some(
        ({ reference }, index) =>
          reference.sha256 !== ledger[index].attestation.sha256,
      )
    ) {
      throw new Error(
        "Live phase exit ledger differs from its immutable chain",
      );
    }
  }

  const releaseState = {
    namespace,
    head: { ...current.head },
    acceptedGate,
    ...(ledger.length === 0
      ? {}
      : {
          phaseExitLedger: ledger.map(
            ({ gate, sourceSha, attestation, event }) => ({
              gate,
              sourceSha,
              attestation: { ...attestation },
              event: { ...event },
            }),
          ),
        }),
  };
  return externalAuthorities === null
    ? releaseState
    : {
        ...releaseState,
        externalAuthorityBundle: externalAuthorities.bundle,
        externalAuthorityTargetGate: externalAuthorities.targetGate,
        externalAuthoritySubject: externalAuthorities.subject,
      };
};

const readSourceSnapshot = () => {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!SOURCE_SHA_PATTERN.test(sha)) {
      return { sha: null, state: "unknown" };
    }
    const dirty =
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      }).trim().length > 0;
    return { sha, state: dirty ? "dirty" : "clean" };
  } catch {
    return { sha: null, state: "unknown" };
  }
};

export const resolveRepositoryPhaseExitReadiness = async (options = {}) => {
  if (
    !isRecord(options) ||
    Object.keys(options).some(
      (key) =>
        key !== "releaseStateStore" &&
        key !== "externalAuthorityBundleSha256" &&
        key !== "currentWorkflowRunId",
    )
  ) {
    throw new Error("Phase exit repository resolver options are invalid");
  }
  const releaseStateStore = options.releaseStateStore ?? null;
  const externalAuthorityBundleSha256 =
    options.externalAuthorityBundleSha256 ?? null;
  const currentWorkflowRunId = options.currentWorkflowRunId ?? null;
  if (
    (externalAuthorityBundleSha256 !== null &&
      !SHA256_PATTERN.test(externalAuthorityBundleSha256)) ||
    (externalAuthorityBundleSha256 !== null && releaseStateStore === null) ||
    (currentWorkflowRunId !== null &&
      !/^[1-9][0-9]{0,19}$/u.test(currentWorkflowRunId)) ||
    (externalAuthorityBundleSha256 !== null && currentWorkflowRunId === null)
  ) {
    throw new Error(
      "Phase exit external authority bundle requires a live Release State store",
    );
  }
  const [
    manifest,
    baseline,
    provider,
    storePolicy,
    approval,
    database,
    retention,
    performance,
    startupBurst,
    csp,
    externalPrerequisites,
    backupRestoreProvider,
    artifactDrill,
    release,
    toolchainPolicy,
    p0a,
  ] = await Promise.all(
    [
      "config/phase-exit-readiness.json",
      "config/foundation-baseline.json",
      "config/provider-policy.json",
      "config/release-state-store.json",
      "config/approval-policy.json",
      "config/db-compatibility-contract.json",
      "config/metrics-retention-policy.json",
      "config/performance-budgets.json",
      "contracts/persistence-release-a-startup-bursts-v1.json",
      "config/csp-policy.json",
      "config/phase-exit-external-prerequisites.json",
      "config/backup-restore-provider-contract.json",
      "config/artifact-control-store-drill.json",
      "config/release-variants.json",
      "config/toolchain-versions.json",
      "config/foundation-p0a-authorities.json",
    ].map((relativePath) => readJsonStrict(path.join(root, relativePath))),
  );
  assertPhaseExitReadinessManifest(manifest);

  const blockersByGate = createBlockersByGate();
  const authorityEvidenceByGate = createAuthorityEvidenceByGate(manifest);
  for (const blocker of baseline.blockers ?? []) {
    for (const gate of blocker.blocks ?? []) {
      addBlockers(blockersByGate, gate, [blocker.id]);
    }
  }
  addBlockers(blockersByGate, "P0-BASELINE", [
    ...(p0a.blockerCodes ?? []),
    ...(provider.blockerCodes ?? []),
    ...(storePolicy.blockerCodes ?? []),
    ...(approval.blockerCodes ?? []),
    ...(database.blockerCodes ?? []),
  ]);
  addBlockers(
    blockersByGate,
    "P0-RELEASE",
    (performance.blockers ?? [])
      .filter(({ blocksExit }) => blocksExit === "P0-RELEASE")
      .map(({ id }) => id),
  );
  addBlockers(blockersByGate, "P0-ARTIFACT", [
    ...(provider.blockerCodes ?? []),
    ...(storePolicy.blockerCodes ?? []),
    ...(artifactDrill.blockerCodes ?? []),
  ]);
  addBlockers(blockersByGate, "P0-DATA", [
    ...(database.blockerCodes ?? []),
    ...(retention.blockerCodes ?? []),
    ...(externalPrerequisites.blockerCodes ?? []).filter((blocker) =>
      blocker.startsWith("backup-"),
    ),
    ...(backupRestoreProvider.bindingStatus === "configured"
      ? []
      : ["backup-provider-contract-unconfigured"]),
  ]);
  addBlockers(blockersByGate, "P0-PROMOTE", [
    ...(provider.blockerCodes ?? []),
    ...(storePolicy.blockerCodes ?? []),
    ...(approval.blockerCodes ?? []),
  ]);
  for (const gate of RELEASE_PHASE_GATES) {
    addBlockers(blockersByGate, gate, storePolicy.blockerCodes ?? []);
  }

  const baselineVerification = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-foundation-baseline.mjs")],
    { cwd: root, windowsHide: true },
  );
  if (
    baselineVerification.status === 0 &&
    SHA256_PATTERN.test(baseline.baselineEvidenceSha256)
  ) {
    addAuthorityReference(
      authorityEvidenceByGate,
      "P0-BASELINE",
      "foundation-baseline",
      verifierReference("foundation-baseline", baseline.baselineEvidenceSha256),
    );
  } else {
    addBlockers(blockersByGate, "P0-BASELINE", [
      "foundation-baseline-verification-failed",
    ]);
  }

  const toolchain = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "verify-toolchain.mjs")],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (toolchain.status === 0) {
    const stdoutSha256 = sha256Bytes(Buffer.from(toolchain.stdout, "utf8"));
    addAuthorityReference(
      authorityEvidenceByGate,
      "P0-TOOLCHAIN",
      "strict-toolchain",
      verifierReference("strict-toolchain", stdoutSha256),
    );
  } else {
    addBlockers(blockersByGate, "P0-TOOLCHAIN", ["strict-toolchain-mismatch"]);
  }

  const source = readSourceSnapshot();
  if (source.state !== "clean") {
    addBlockers(blockersByGate, "P0-BASELINE", ["source-tree-not-clean"]);
  }
  const releaseState =
    releaseStateStore === null
      ? null
      : await resolveLiveReleaseState({
          store: releaseStateStore,
          authorityEvidenceByGate,
          externalAuthorityBundleSha256,
          currentWorkflowRunId,
          sourceSha: source.sha,
          policies: {
            provider,
            approval,
            store: storePolicy,
            database,
            retention,
            startupBurst,
            csp,
            externalPrerequisites,
            backupRestoreProvider,
            artifactDrill,
            p0a,
            release,
            toolchain: toolchainPolicy,
            foundationBaseline: baseline,
          },
        });
  const resolution = deepFreeze({
    schemaVersion: 1,
    manifestSha256: sha256Json(manifest),
    source,
    releaseState,
    blockersByGate,
    authorityEvidenceByGate,
  });
  brandedResolutions.add(resolution);
  return Object.freeze({ manifest, resolution });
};

export const buildPhaseExitReadiness = (options) => {
  if (!exactKeys(options, ["manifest", "resolution"])) {
    throw new Error("Phase exit readiness builder options are invalid");
  }
  const { manifest, resolution } = options;
  assertPhaseExitReadinessManifest(manifest);
  if (
    !brandedResolutions.has(resolution) ||
    resolution.manifestSha256 !== sha256Json(manifest)
  ) {
    throw new Error("Trusted phase exit authority resolution is required");
  }

  const acceptedReleaseGate = resolution.releaseState?.acceptedGate ?? null;
  const attestationByGate = new Map(
    (resolution.releaseState?.phaseExitLedger ?? []).map((entry) => [
      entry.gate,
      entry.attestation,
    ]),
  );
  const acceptedIndex =
    acceptedReleaseGate === null
      ? -1
      : RELEASE_PHASE_GATES.indexOf(acceptedReleaseGate);
  let priorComplete = true;
  const exits = FORMAL_PHASE_EXIT_GATES.map((gate, index) => {
    const formalAttestation = attestationByGate.get(gate) ?? null;
    const blockers =
      formalAttestation === null ? [...resolution.blockersByGate[gate]] : [];
    if (resolution.releaseState !== null && formalAttestation === null) {
      blockers.push("phase-exit-attestation-unobserved");
    }
    if (
      formalAttestation === null &&
      gate === "P0-BASELINE" &&
      resolution.source.sha === null
    ) {
      blockers.push("source-sha-unobserved");
    }
    if (
      formalAttestation === null &&
      gate === "P0-BASELINE" &&
      resolution.source.state !== "clean"
    ) {
      blockers.push("source-tree-not-clean");
    }
    const authorities = manifest.authorities[gate].map((authorityId) => {
      const evidence =
        formalAttestation === null
          ? resolution.authorityEvidenceByGate[gate][authorityId]
          : [formalAttestation];
      if (evidence.length === 0) {
        blockers.push(`authority-evidence-unobserved:${authorityId}`);
      }
      return {
        id: authorityId,
        status: evidence.length === 0 ? "unobserved" : "verified",
        evidence: evidence.map((reference) => ({ ...reference })),
      };
    });
    const releaseIndex = RELEASE_PHASE_GATES.indexOf(gate);
    if (
      formalAttestation === null &&
      releaseIndex !== -1 &&
      releaseIndex > acceptedIndex
    ) {
      blockers.push("accepted-gate-unobserved");
    }
    if (!priorComplete) blockers.push("prior-exit-incomplete");
    const blockerCodes = normalizeBlockers(blockers);
    const status = blockerCodes.length === 0 ? "complete" : "blocked";
    priorComplete = status === "complete";
    return { gate, index, status, authorities, blockerCodes };
  });
  const completed = exits.filter(({ status }) => status === "complete").length;
  const blockerCodes = normalizeBlockers(
    exits.flatMap((exit) => exit.blockerCodes),
  );
  return {
    schemaVersion: 1,
    manifestSha256: sha256Json(manifest),
    source: { ...resolution.source },
    releaseState:
      resolution.releaseState === null
        ? null
        : structuredClone(resolution.releaseState),
    productionActivationReady:
      completed === FORMAL_PHASE_EXIT_GATES.length && blockerCodes.length === 0,
    summary: {
      completed,
      total: FORMAL_PHASE_EXIT_GATES.length,
      nextExit: exits.find(({ status }) => status !== "complete")?.gate ?? null,
    },
    exits,
    blockerCodes,
  };
};

export const isPreReleasePhaseExit = (gate) =>
  PRE_RELEASE_PHASE_EXIT_GATES.includes(gate);
