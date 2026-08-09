#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "../lib/canonical-json.mjs";
import { resolveRepositoryPhaseExitReadiness } from "../lib/phase-exit-readiness.mjs";
import { projectPhaseExitAuthoritySubject } from "../lib/phase-exit-external-authority.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  appendPhaseExitAttestation,
  buildPhaseExitAttestation,
  putPhaseExitAttestation,
  readPhaseExitAttestationLedger,
  validatePhaseExitAttestationChain,
} from "./phaseExitAttestation.mjs";
import { derivePhaseExitSupportingEvent } from "./phaseExitSupportingEvent.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_SUBJECT_KIND_BY_GATE,
} from "./phaseGates.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { assertProtectedWorkflowEnvironment } from "./protected-release.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;

const subjectForGate = ({ gate, sourceSha, current, externalSubject }) => {
  const kind = PHASE_EXIT_SUBJECT_KIND_BY_GATE[gate];
  const subject =
    kind === "state-initialized-bootstrap-subject/v1"
      ? externalSubject
      : projectPhaseExitAuthoritySubject({
          current,
          targetGate: gate,
          sourceSha,
          drillId:
            kind === "disposable-drill-subject/v1"
              ? externalSubject?.drillId
              : null,
        });
  if (subject === null) {
    throw new Error("P0-DATA requires its reviewed dual-source subject");
  }
  if (
    externalSubject !== null &&
    !canonicalJsonBytes(subject).equals(canonicalJsonBytes(externalSubject))
  ) {
    throw new Error(
      "External phase authority subject differs from target gate",
    );
  }
  if (FORMAL_PHASE_EXIT_GATES.indexOf(gate) < 3) return subject;
  const supportingEvent = derivePhaseExitSupportingEvent({
    current,
    gate,
    sourceSha,
    subjectHead: subject.releaseStateHead,
  });
  return { ...subject, supportingEvent };
};

const gitIsAncestor = (ancestor, descendant) =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    windowsHide: true,
  }).status === 0;

export const produceAndAppendPhaseExitAttestation = async ({
  store,
  gate,
  sourceSha,
  externalAuthorityBundleSha256 = null,
  predecessorAttestationSha256 = null,
  currentWorkflowRunId = null,
  operationId,
  issuedAt = new Date().toISOString(),
}) => {
  if (
    !FORMAL_PHASE_EXIT_GATES.includes(gate) ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    (externalAuthorityBundleSha256 !== null &&
      !SHA256.test(externalAuthorityBundleSha256)) ||
    (predecessorAttestationSha256 !== null &&
      !SHA256.test(predecessorAttestationSha256))
  ) {
    throw new Error("Phase exit attestation production identity is invalid");
  }
  const { manifest, resolution } = await resolveRepositoryPhaseExitReadiness({
    releaseStateStore: store,
    externalAuthorityBundleSha256,
    currentWorkflowRunId,
  });
  if (
    resolution.source.sha !== sourceSha ||
    resolution.source.state !== "clean"
  ) {
    throw new Error("Phase exit attestation requires the exact clean source");
  }
  const current = await readCurrentReleaseState({
    store,
    requireInitialized: false,
  });
  const preInitialization = current.snapshot === null;
  const preInitializationGates = FORMAL_PHASE_EXIT_GATES.slice(0, 3);
  if (
    preInitialization !== preInitializationGates.includes(gate) ||
    (!preInitialization && predecessorAttestationSha256 !== null)
  ) {
    throw new Error(
      "Phase exit attestation initialization boundary is invalid",
    );
  }
  const suppliedPredecessor =
    predecessorAttestationSha256 === null
      ? null
      : {
          uri:
            `release-state://${store.namespace}/evidence/` +
            predecessorAttestationSha256,
          sha256: predecessorAttestationSha256,
        };
  const predecessorChain =
    preInitialization && suppliedPredecessor !== null
      ? await validatePhaseExitAttestationChain({
          store,
          head: suppliedPredecessor,
          current,
          currentSourceSha: sourceSha,
          isSourceAncestor: gitIsAncestor,
        })
      : [];
  if (
    preInitialization &&
    ((gate === "P0-BASELINE" && suppliedPredecessor !== null) ||
      (gate !== "P0-BASELINE" && suppliedPredecessor === null))
  ) {
    throw new Error(
      "Pre-initialization phase exit predecessor is missing or unexpected",
    );
  }
  const ledger = preInitialization
    ? predecessorChain.map(({ attestation, reference }) => ({
        gate: attestation.gate,
        attestation: reference,
      }))
    : readPhaseExitAttestationLedger(current);
  const gateIndex = FORMAL_PHASE_EXIT_GATES.indexOf(gate);
  if (ledger.length !== gateIndex) {
    throw new Error(
      "Phase exit attestation does not target the next formal gate",
    );
  }
  const directBlockers = resolution.blockersByGate[gate];
  if (!Array.isArray(directBlockers) || directBlockers.length !== 0) {
    throw new Error(
      `${gate}: direct phase exit blockers remain: ${directBlockers}`,
    );
  }
  const authorities = manifest.authorities[gate].map((id) => {
    const evidence = resolution.authorityEvidenceByGate[gate][id];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new Error(`${gate}/${id}: formal authority evidence is absent`);
    }
    return { id, evidence: evidence.map((reference) => ({ ...reference })) };
  });
  const predecessor = ledger.at(-1)?.attestation ?? null;
  const externalSubject =
    resolution.releaseState?.externalAuthorityTargetGate === gate
      ? resolution.releaseState.externalAuthoritySubject
      : null;
  const attestation = buildPhaseExitAttestation({
    namespace: store.namespace,
    gate,
    sourceSha,
    subject: subjectForGate({
      gate,
      sourceSha,
      current,
      externalSubject,
    }),
    authorities,
    predecessor,
    issuedAt,
  });
  const stored = await putPhaseExitAttestation({ store, attestation });
  if (preInitialization) {
    return Object.freeze({
      schemaVersion: 1,
      kind: "phase-exit-attestation-committed/v1",
      namespace: store.namespace,
      gate,
      sourceSha,
      attestation: stored.reference,
      event: null,
      head: Object.freeze({ ...current.head }),
      replayed: stored.receipt.replayed,
    });
  }
  const appended = await appendPhaseExitAttestation({
    store,
    attestationReference: stored.reference,
    operationId,
    currentSourceSha: sourceSha,
    isSourceAncestor: gitIsAncestor,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "phase-exit-attestation-committed/v1",
    namespace: store.namespace,
    gate,
    sourceSha,
    attestation: stored.reference,
    event: appended.event,
    head: appended.head,
    replayed: appended.replayed,
  });
};

const nextValue = (argv, index, flag) => {
  const value = argv[index + 1];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("--")
  ) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
};

export const parsePhaseExitAttestationArguments = (argv) => {
  const values = {};
  const fields = new Map([
    ["--namespace", "namespace"],
    ["--source-sha", "sourceSha"],
    ["--target-gate", "gate"],
    ["--operation-id", "operationId"],
    ["--external-authority-bundle-sha256", "externalAuthorityBundleSha256"],
    ["--predecessor-attestation-sha256", "predecessorAttestationSha256"],
    ["--output", "outputPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const property = fields.get(argv[index]);
    if (property === undefined || Object.hasOwn(values, property)) {
      throw new Error(
        `Invalid phase exit attestation argument: ${argv[index]}`,
      );
    }
    values[property] = nextValue(argv, index, argv[index]);
    index += 1;
  }
  if (
    ![5, 6, 7].includes(Object.keys(values).length) ||
    !NAMESPACE.test(values.namespace ?? "") ||
    !SOURCE_SHA.test(values.sourceSha ?? "") ||
    !FORMAL_PHASE_EXIT_GATES.includes(values.gate) ||
    typeof values.operationId !== "string" ||
    values.operationId.length === 0 ||
    typeof values.outputPath !== "string" ||
    (values.externalAuthorityBundleSha256 !== undefined &&
      !SHA256.test(values.externalAuthorityBundleSha256)) ||
    (values.predecessorAttestationSha256 !== undefined &&
      !SHA256.test(values.predecessorAttestationSha256)) ||
    ["P0-TOOLCHAIN", "P0-ARTIFACT"].includes(values.gate) !==
      (values.predecessorAttestationSha256 !== undefined) ||
    (values.gate === "P0-BASELINE" &&
      values.predecessorAttestationSha256 !== undefined)
  ) {
    throw new Error(
      "Phase exit attestation arguments are incomplete or invalid",
    );
  }
  return Object.freeze(values);
};

const requireEnvironment = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required phase exit attestation environment is absent: ${name}`,
    );
  }
  return value;
};

export const runPhaseExitAttestationCli = async (
  argv = process.argv.slice(2),
  { env = process.env } = {},
) => {
  const values = parsePhaseExitAttestationArguments(argv);
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
  if (head !== values.sourceSha || dirty.length !== 0) {
    throw new Error("Phase exit attestation requires the exact clean checkout");
  }
  const [storePolicy, approvalPolicy] = await Promise.all(
    ["config/release-state-store.json", "config/approval-policy.json"].map(
      (relativePath) => readJsonStrict(path.join(root, relativePath)),
    ),
  );
  const runId = requireEnvironment(env, "GITHUB_RUN_ID");
  assertProtectedWorkflowEnvironment({
    env,
    approvalPolicy,
    namespace: values.namespace,
    sourceSha: values.sourceSha,
    runId,
  });
  const store = await createPostgresReleaseStateStore({
    connectionString: requireEnvironment(
      env,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace: values.namespace,
    policy: storePolicy,
    ca: requireEnvironment(env, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const result = await produceAndAppendPhaseExitAttestation({
      store,
      gate: values.gate,
      sourceSha: values.sourceSha,
      externalAuthorityBundleSha256:
        values.externalAuthorityBundleSha256 ?? null,
      predecessorAttestationSha256: values.predecessorAttestationSha256 ?? null,
      currentWorkflowRunId:
        values.externalAuthorityBundleSha256 === undefined ? null : runId,
      operationId: values.operationId,
    });
    const bytes = canonicalJsonBytes(result);
    const absoluteOutput = path.resolve(values.outputPath);
    await writeFile(absoluteOutput, bytes, { flag: "wx" });
    if (!(await readFile(absoluteOutput)).equals(bytes)) {
      throw new Error("Phase exit attestation result readback differs");
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
if (isMain) await runPhaseExitAttestationCli();
