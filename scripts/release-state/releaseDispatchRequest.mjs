import { appendFile, open, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJsonBytes, parseJsonStrict } from "../lib/canonical-json.mjs";
import { FORMAL_PHASE_EXIT_GATES, RELEASE_PHASE_GATES } from "./phaseGates.mjs";
import { assertReleaseOperationPredecessorCoverage } from "./releaseOperationPhaseExit.mjs";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/u;

const schema = (required = [], optional = []) =>
  Object.freeze({
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
  });

const EMPTY = schema();
const SUBJECT = schema(["subject_run_id", "subject_sha256"]);
const ADMIN_EXECUTION = schema([
  "operation_id",
  "subject_run_id",
  "subject_sha256",
]);
const PHASE_AUTHORITY_FIELDS_BY_GATE = Object.freeze({
  "P0-BASELINE": Object.freeze([
    "phase_authority_external_bindings_run_id",
    "phase_authority_external_bindings_run_attempt",
    "phase_authority_bootstrap_recovery_run_id",
    "phase_authority_bootstrap_recovery_run_attempt",
  ]),
  "P0-ARTIFACT": Object.freeze([
    "phase_authority_artifact_drill_run_id",
    "phase_authority_artifact_drill_run_attempt",
  ]),
  "P0-TOOLCHAIN": Object.freeze([
    "phase_authority_quality_run_id",
    "phase_authority_quality_run_attempt",
  ]),
  "P0-DATA": Object.freeze([
    "phase_authority_retention_run_id",
    "phase_authority_retention_run_attempt",
    "phase_authority_backup_restore_run_id",
    "phase_authority_backup_restore_run_attempt",
    "phase_authority_startup_waf_run_id",
    "phase_authority_startup_waf_run_attempt",
    "db_observation_sha256",
    "db_observation_production_sha256",
    "db_observation_run_id",
    "db_observation_run_attempt",
  ]),
  "P0-RELEASE": Object.freeze([
    "phase_authority_performance_run_id",
    "phase_authority_performance_run_attempt",
  ]),
  "P1-PWA": Object.freeze([
    "phase_authority_pwa_receipt_run_id",
    "phase_authority_pwa_receipt_run_attempt",
    "phase_authority_managed_device_run_1_id",
    "phase_authority_managed_device_run_1_attempt",
    "phase_authority_managed_device_run_2_id",
    "phase_authority_managed_device_run_2_attempt",
    "phase_authority_managed_device_run_3_id",
    "phase_authority_managed_device_run_3_attempt",
  ]),
  "P2A-LOCAL": Object.freeze([
    "phase_authority_request_graph_run_id",
    "phase_authority_request_graph_run_attempt",
  ]),
  "P2B-REPORT": Object.freeze([
    "phase_authority_csp_report_run_id",
    "phase_authority_csp_report_run_attempt",
  ]),
  "P4-CSP": Object.freeze([
    "phase_authority_deployed_csp_run_id",
    "phase_authority_deployed_csp_run_attempt",
  ]),
  "P7-IDB": Object.freeze([
    "phase_authority_managed_device_run_1_id",
    "phase_authority_managed_device_run_1_attempt",
    "phase_authority_managed_device_run_2_id",
    "phase_authority_managed_device_run_2_attempt",
    "phase_authority_managed_device_run_3_id",
    "phase_authority_managed_device_run_3_attempt",
  ]),
});
const ALL_PHASE_AUTHORITY_FIELDS = Object.freeze([
  ...new Set(Object.values(PHASE_AUTHORITY_FIELDS_BY_GATE).flat()),
]);

export const RELEASE_DISPATCH_OPERATION_SCHEMAS = Object.freeze({
  "produce-artifact-build-requirements": schema([
    "operation_id",
    "candidate_gate",
  ]),
  "build-and-verify": schema([
    "artifact_build_requirements_run_id",
    "artifact_build_requirements_sha256",
  ]),
  "produce-policy-activation-qa-build-requirements": schema([
    "operation_id",
    "policy_target_source_sha",
    "proposed_release_policy_sha256",
    "active_release_policy_sha256",
  ]),
  "build-policy-activation-qa": schema([
    "artifact_build_requirements_run_id",
    "artifact_build_requirements_sha256",
    "policy_target_source_sha",
  ]),
  "deploy-prebuilt": schema(
    ["artifact_run_id", "artifact_build_requirements_sha256", "release_role"],
    ["replay_receipt_run_id"],
  ),
  "collect-prepromotion-evidence-source": schema([
    "artifact_build_requirements_run_id",
    "artifact_build_requirements_sha256",
    "standard_deployment_run_id",
    "containment_deployment_run_id",
    "standard_deployment_binding_sha256",
    "containment_deployment_binding_sha256",
  ]),
  "produce-prepromotion-evidence": schema([
    "prepromotion_evidence_source_run_id",
    "prepromotion_evidence_source_sha256",
  ]),
  "produce-promotion-subject": schema([
    "operation_id",
    "standard_deployment_run_id",
    "containment_deployment_run_id",
    "prepromotion_evidence_run_id",
  ]),
  "prepare-and-promote": SUBJECT,
  "record-promotion": schema(["promotion_run_id"]),
  reconcile: EMPTY,
  "initialize-acceptance-collector": EMPTY,
  "collect-continuous-sample": schema([
    "acceptance_evidence_source_run_id",
    "acceptance_collector_receipt_sha256",
    "continuous_probe_source_sha256",
  ]),
  "finalize-acceptance-evidence": schema(
    [
      "acceptance_evidence_source_run_id",
      "acceptance_collector_receipt_sha256",
      "continuous_probe_source_sha256",
    ],
    ["companion_terminal_event_sha256"],
  ),
  "publish-acceptance-evidence": schema(
    [
      "acceptance_evidence_source_run_id",
      "acceptance_collector_receipt_sha256",
      "evidence_sha256",
      "continuous_probe_source_sha256",
    ],
    ["companion_recovery_source_sha256"],
  ),
  "produce-own-gate-performance-evidence": schema([
    "performance_raw_samples_run_id",
    "performance_raw_samples_run_attempt",
    "performance_raw_samples_sha256",
  ]),
  "produce-performance-inherited-closure": schema([
    "p0_accepted_event_sha256",
    "p3_accepted_event_sha256",
    "p5d_accepted_event_sha256",
    "p5e_accepted_event_sha256",
  ]),
  "produce-acceptance-requirements": schema(["candidate_gate"]),
  "produce-acceptance-inputs": schema(
    [
      "candidate_gate",
      "acceptance_evidence_run_id",
      "acceptance_requirements_run_id",
      "acceptance_requirements_sha256",
      "acceptance_collector_receipt_sha256",
      "evidence_sha256",
      "continuous_probe_source_sha256",
    ],
    [
      "companion_recovery_source_sha256",
      "performance_evidence_run_id",
      "performance_evidence_run_attempt",
      "performance_evidence_sha256",
    ],
  ),
  "accept-standard": schema(
    [
      "candidate_gate",
      "acceptance_evidence_run_id",
      "acceptance_inputs_run_id",
      "acceptance_requirements_run_id",
      "acceptance_requirements_sha256",
      "evidence_sha256",
      "continuous_probe_sha256",
      "terminal_bundle_sha256",
      "terminal_object_set_sha256",
    ],
    [
      "companion_recovery_drill_sha256",
      "performance_evidence_run_id",
      "performance_evidence_run_attempt",
      "performance_evidence_sha256",
    ],
  ),
  "produce-policy-activation-qa-package": schema([
    "operation_id",
    "artifact_run_id",
    "artifact_build_requirements_sha256",
    "policy_target_source_sha",
    "proposed_release_policy_sha256",
    "policy_activation_gate",
  ]),
  "produce-policy-activation-qa-execution-subject": schema([
    "operation_id",
    "policy_target_source_sha",
    "proposed_release_policy_sha256",
    "active_release_policy_sha256",
    "approval_policy_sha256",
    "policy_qa_package_sha256",
  ]),
  "execute-policy-activation-qa": schema([
    "operation_id",
    "policy_qa_execution_subject_run_id",
    "policy_qa_execution_subject_sha256",
  ]),
  "produce-policy-activation-closure": schema(
    ["operation_id"],
    ["policy_qa_execution_run_id", "policy_qa_execution_sha256"],
  ),
  "produce-policy-activation-subject": schema([
    "operation_id",
    "proposed_release_policy_sha256",
    "active_release_policy_sha256",
    "policy_closure_bundle_sha256",
  ]),
  "activate-policy": SUBJECT,
  "activate-policy-floor": SUBJECT,
  "plan-archive-recovery": schema([
    "archive_recovery_action",
    "archive_recovery_binding_id",
    "archive_recovery_source_sha",
  ]),
  "produce-archive-recovery-subject": schema([
    "operation_id",
    "archive_recovery_action",
    "archive_recovery_binding_id",
    "archive_recovery_source_sha",
  ]),
  "execute-reviewed-archive-recovery": SUBJECT,
  "collect-remote-db-observation": EMPTY,
  "collect-foundation-external-bindings": EMPTY,
  "collect-foundation-bootstrap-recovery": EMPTY,
  "collect-production-request-graph": EMPTY,
  "collect-csp-report-observation": EMPTY,
  "collect-deployed-csp-flow": EMPTY,
  "collect-startup-waf-observation": EMPTY,
  "collect-artifact-control-store-drill": EMPTY,
  "collect-backup-restore-rehearsal": EMPTY,
  "collect-managed-device-live-stage": EMPTY,
  "collect-pwa-multiclient-drill": EMPTY,
  "produce-phase-exit-authority-bundle": schema(
    ["target_gate"],
    ALL_PHASE_AUTHORITY_FIELDS,
  ),
  "publish-phase-exit-authority-bundle": schema([
    "target_gate",
    "phase_authority_bundle_run_id",
    "phase_authority_bundle_run_attempt",
    "phase_authority_bundle_sha256",
    "phase_authority_review_sha256",
  ]),
  "attest-phase-exit": schema(
    ["operation_id", "target_gate"],
    ["phase_authority_bundle_sha256", "predecessor_attestation_sha256"],
  ),
  "produce-state-initialization-subject": schema([
    "operation_id",
    "bootstrap_recovery_sha256",
    "db_contract_sha256",
    "db_observation_sha256",
    "db_observation_production_sha256",
    "db_observation_run_id",
    "db_observation_run_attempt",
    "legacy_observation_sha256",
    "p0_artifact_attestation_sha256",
    "p0_baseline_attestation_sha256",
    "p0_toolchain_attestation_sha256",
    "release_policy_sha256",
  ]),
  "initialize-release-state": ADMIN_EXECUTION,
  "produce-db-contract-activation-subject": schema([
    "operation_id",
    "db_contract_sha256",
    "db_observation_sha256",
    "db_observation_production_sha256",
    "db_observation_run_id",
    "db_observation_run_attempt",
  ]),
  "activate-db-contract": ADMIN_EXECUTION,
  "produce-operation-abort-subject": schema(["operation_id"]),
  "abort-pending-operation": ADMIN_EXECUTION,
});

assertReleaseOperationPredecessorCoverage(
  Object.keys(RELEASE_DISPATCH_OPERATION_SCHEMAS),
);

const SHA_FIELDS = new Set(
  [
    ...new Set(
      Object.values(RELEASE_DISPATCH_OPERATION_SCHEMAS).flatMap(
        ({ required, optional }) => [...required, ...optional],
      ),
    ),
  ].filter((name) => name.endsWith("_sha256")),
);
const RUN_FIELDS = new Set(
  [
    ...new Set(
      Object.values(RELEASE_DISPATCH_OPERATION_SCHEMAS).flatMap(
        ({ required, optional }) => [...required, ...optional],
      ),
    ),
  ].filter((name) => name.endsWith("_run_id") || name.endsWith("_run_attempt")),
);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const validateField = (name, value) => {
  if (typeof value !== "string" || value.length === 0) return false;
  if (SHA_FIELDS.has(name)) return SHA256.test(value);
  if (RUN_FIELDS.has(name)) return RUN_ID.test(value);
  if (name === "operation_id") return OPERATION_ID.test(value);
  if (name === "candidate_gate") return RELEASE_PHASE_GATES.includes(value);
  if (name === "archive_recovery_binding_id") return BINDING_ID.test(value);
  if (name.endsWith("source_sha")) return SOURCE_SHA.test(value);
  if (name === "release_role")
    return ["standard", "containment"].includes(value);
  if (name === "archive_recovery_action") {
    return [
      "rollback",
      "redeploy-standard",
      "redeploy-containment",
      "activate-containment",
    ].includes(value);
  }
  if (name === "target_gate") {
    return FORMAL_PHASE_EXIT_GATES.includes(value);
  }
  if (name === "policy_activation_gate") {
    return [
      "P1-PWA",
      "P2A-LOCAL",
      "P2B-REPORT",
      "P3-XLSX",
      "P4-CSP",
      "P5-DUAL",
      "P5-LIST",
      "P7-IDB",
      "P8-CLEAN",
    ].includes(value);
  }
  return SAFE_VALUE.test(value);
};

export const validateReleaseDispatchRequest = ({
  operation,
  sourceSha,
  requestBytes,
  currentRunId = null,
}) => {
  const operationSchema = RELEASE_DISPATCH_OPERATION_SCHEMAS[operation];
  if (
    operationSchema === undefined ||
    !SOURCE_SHA.test(sourceSha ?? "") ||
    !Buffer.isBuffer(requestBytes) ||
    requestBytes.length < 2 ||
    requestBytes.length > 32 * 1024 ||
    (currentRunId !== null && !RUN_ID.test(currentRunId))
  ) {
    throw new Error("Release dispatch request identity is invalid");
  }
  const request = parseJsonStrict(
    requestBytes.toString("utf8"),
    "Release dispatch request",
  );
  if (!isRecord(request) || !canonicalJsonBytes(request).equals(requestBytes)) {
    throw new Error("Release dispatch request must be a canonical object");
  }
  const keys = Object.keys(request).sort();
  const allowed = [...operationSchema.required, ...operationSchema.optional];
  if (
    operationSchema.required.some((name) => !Object.hasOwn(request, name)) ||
    keys.some((name) => !allowed.includes(name)) ||
    keys.some((name) => !validateField(name, request[name]))
  ) {
    throw new Error(
      "Release dispatch request fields differ from its operation",
    );
  }
  if (operation === "produce-phase-exit-authority-bundle") {
    const expected = [
      "target_gate",
      ...(PHASE_AUTHORITY_FIELDS_BY_GATE[request.target_gate] ?? []),
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      throw new Error(
        "Release dispatch phase authority fields differ from the exact target gate",
      );
    }
  }
  if (
    operation === "publish-phase-exit-authority-bundle" &&
    !Object.hasOwn(PHASE_AUTHORITY_FIELDS_BY_GATE, request.target_gate)
  ) {
    throw new Error(
      "Release dispatch phase authority target gate is unsupported",
    );
  }
  if (
    operation === "attest-phase-exit" &&
    ["P0-TOOLCHAIN", "P0-ARTIFACT"].includes(request.target_gate) !==
      Object.hasOwn(request, "predecessor_attestation_sha256")
  ) {
    throw new Error(
      "Release dispatch pre-initialization attestation predecessor is invalid",
    );
  }
  if (
    operation === "produce-policy-activation-closure" &&
    Object.hasOwn(request, "policy_qa_execution_run_id") !==
      Object.hasOwn(request, "policy_qa_execution_sha256")
  ) {
    throw new Error(
      "Release dispatch policy QA selector must be wholly present or absent",
    );
  }
  const priorRunIds = keys
    .filter((name) => name.endsWith("_run_id"))
    .map((name) => request[name]);
  if (
    (currentRunId !== null && priorRunIds.includes(currentRunId)) ||
    new Set(priorRunIds).size !== priorRunIds.length ||
    new Set(
      [
        "performance_evidence_run_id",
        "performance_evidence_run_attempt",
        "performance_evidence_sha256",
      ].map((name) => Object.hasOwn(request, name)),
    ).size > 1
  ) {
    throw new Error("Release dispatch prior-run authority is invalid");
  }
  return Object.freeze({
    operation,
    sourceSha,
    request: Object.freeze({ ...request }),
  });
};

const environmentName = (field) => `REQUESTED_${field.toUpperCase()}`;

export const appendValidatedReleaseDispatchEnvironment = async ({
  resolution,
  githubEnvironmentPath,
}) => {
  const lines = Object.entries(resolution.request).map(
    ([name, value]) => `${environmentName(name)}=${value}`,
  );
  if (lines.length !== 0) {
    await appendFile(githubEnvironmentPath, `${lines.join("\n")}\n`, "utf8");
  }
};

export const buildReleaseDispatchRequest = ({ operation, fields }) => {
  const request = Object.fromEntries(
    Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)),
  );
  const bytes = canonicalJsonBytes(request);
  validateReleaseDispatchRequest({
    operation,
    sourceSha: "0".repeat(40),
    requestBytes: bytes,
  });
  return bytes;
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

export const runReleaseDispatchRequestCli = async ({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) => {
  const [command, ...tokens] = argv;
  if (command === "validate") {
    if (tokens.length !== 0)
      throw new Error("Release dispatch validate flags are forbidden");
    const operation = env.INPUT_OPERATION;
    const sourceSha = env.INPUT_SOURCE_SHA;
    const requestJson = env.INPUT_REQUEST_JSON;
    const githubEnvironmentPath = env.GITHUB_ENV;
    if (
      typeof requestJson !== "string" ||
      typeof githubEnvironmentPath !== "string" ||
      githubEnvironmentPath.length === 0
    ) {
      throw new Error("Release dispatch workflow input is absent");
    }
    const resolution = validateReleaseDispatchRequest({
      operation,
      sourceSha,
      requestBytes: Buffer.from(requestJson, "utf8"),
      currentRunId: env.GITHUB_RUN_ID ?? null,
    });
    await appendValidatedReleaseDispatchEnvironment({
      resolution,
      githubEnvironmentPath,
    });
    return resolution;
  }
  if (command !== "build" || tokens.length < 4 || tokens.length % 2 !== 0) {
    throw new Error(
      "Usage: releaseDispatchRequest.mjs build --operation <id> --output <new-file> [--field value]",
    );
  }
  let operation = null;
  let output = null;
  const fields = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = nextValue(tokens, index, flag);
    if (flag === "--operation" && operation === null) operation = value;
    else if (flag === "--output" && output === null) output = value;
    else if (flag.startsWith("--") && !Object.hasOwn(fields, flag.slice(2))) {
      fields[flag.slice(2)] = value;
    } else throw new Error(`Invalid release dispatch build flag: ${flag}`);
  }
  if (operation === null || output === null) {
    throw new Error("Release dispatch build operation/output is absent");
  }
  const bytes = buildReleaseDispatchRequest({ operation, fields });
  const resolvedOutput = path.resolve(output);
  const handle = await open(resolvedOutput, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (!(await readFile(resolvedOutput)).equals(bytes)) {
    throw new Error("Release dispatch request output readback differs");
  }
  process.stdout.write(`${bytes.toString("utf8")}\n`);
  return bytes;
};
