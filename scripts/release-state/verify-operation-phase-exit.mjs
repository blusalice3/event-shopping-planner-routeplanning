#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  readPhaseExitAttestationLedger,
  validatePhaseExitAttestationChain,
} from "./phaseExitAttestation.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import { resolveRequiredPhaseExitForOperation } from "./releaseOperationPhaseExit.mjs";
import { RELEASE_PHASE_GATES } from "./phaseGates.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const CANDIDATE_GATE_OPERATIONS = new Set([
  "produce-acceptance-requirements",
  "produce-acceptance-inputs",
  "accept-standard",
]);

const gitIsAncestor = (ancestor, descendant) =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: root,
    windowsHide: true,
  }).status === 0;

export const assertReleaseOperationPhaseExit = async (
  { store, operation, sourceSha, candidateGate = null },
  {
    readState = readCurrentReleaseState,
    readLedger = readPhaseExitAttestationLedger,
    validateChain = validatePhaseExitAttestationChain,
    isSourceAncestor = gitIsAncestor,
  } = {},
) => {
  const requiresCandidateGate = CANDIDATE_GATE_OPERATIONS.has(operation);
  if (
    !SOURCE_SHA.test(sourceSha ?? "") ||
    requiresCandidateGate !== (candidateGate !== null) ||
    (candidateGate !== null && !RELEASE_PHASE_GATES.includes(candidateGate))
  ) {
    throw new Error("Release operation predecessor identity is invalid");
  }
  const current = await readState({ store });
  const requiredGate = resolveRequiredPhaseExitForOperation({
    operation,
    acceptedGate: current.snapshot.acceptedGate,
    candidateGate,
  });
  if (requiredGate === null) {
    return Object.freeze({ operation, requiredGate: null, status: "exempt" });
  }
  const ledger = readLedger(current);
  const entry = ledger.find(({ gate }) => gate === requiredGate);
  if (entry === undefined) {
    throw new Error(
      `${operation}: required formal predecessor exit is absent: ${requiredGate}`,
    );
  }
  const chain = await validateChain({
    store,
    head: ledger.at(-1).attestation,
    current,
    currentSourceSha: sourceSha,
    isSourceAncestor,
  });
  if (!chain.some(({ attestation }) => attestation.gate === requiredGate)) {
    throw new Error(`${operation}: immutable predecessor chain is incomplete`);
  }
  return Object.freeze({ operation, requiredGate, status: "verified" });
};

const parseArguments = (argv) => {
  const values = {};
  const fields = new Map([
    ["--namespace", "namespace"],
    ["--source-sha", "sourceSha"],
    ["--operation", "operation"],
    ["--candidate-gate", "candidateGate"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const property = fields.get(argv[index]);
    const value = argv[index + 1];
    if (
      property === undefined ||
      Object.hasOwn(values, property) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid release predecessor argument: ${argv[index]}`);
    }
    values[property] = value;
    index += 1;
  }
  if (
    ![3, 4].includes(Object.keys(values).length) ||
    !NAMESPACE.test(values.namespace ?? "") ||
    !SOURCE_SHA.test(values.sourceSha ?? "") ||
    CANDIDATE_GATE_OPERATIONS.has(values.operation) !==
      Object.hasOwn(values, "candidateGate") ||
    (Object.hasOwn(values, "candidateGate") &&
      !RELEASE_PHASE_GATES.includes(values.candidateGate))
  ) {
    throw new Error("Release predecessor arguments are incomplete");
  }
  return values;
};

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required release predecessor environment is absent: ${name}`,
    );
  }
  return value;
};

export const runReleaseOperationPhaseExitCli = async (
  argv = process.argv.slice(2),
) => {
  const values = parseArguments(argv);
  const policy = await readJsonStrict(
    path.join(root, "config", "release-state-store.json"),
  );
  const store = await createPostgresReleaseStateStore({
    connectionString: requireEnvironment(policy.databaseUrlEnvironmentName),
    namespace: values.namespace,
    policy,
    ca: requireEnvironment("RELEASE_STATE_DATABASE_CA_PEM"),
  });
  try {
    const result = await assertReleaseOperationPhaseExit({ store, ...values });
    process.stdout.write(
      `PASS release operation predecessor: ${result.operation}; ${result.requiredGate ?? "exempt"}.\n`,
    );
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runReleaseOperationPhaseExitCli();
