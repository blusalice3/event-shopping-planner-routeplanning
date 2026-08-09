import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { canonicalJsonBytes } from "../lib/canonical-json.mjs";
import {
  RELEASE_DISPATCH_OPERATION_SCHEMAS,
  buildReleaseDispatchRequest,
  runReleaseDispatchRequestCli,
  validateReleaseDispatchRequest,
} from "./releaseDispatchRequest.mjs";

const SOURCE_SHA = "a".repeat(40);
let nextRunId = 1000;

const valueFor = (name) => {
  if (name.endsWith("_sha256")) return "b".repeat(64);
  if (name.endsWith("_run_id") || name.endsWith("_run_attempt")) {
    nextRunId += 1;
    return String(nextRunId);
  }
  if (name === "operation_id") return "release-operation:1";
  if (name === "release_role") return "standard";
  if (name === "archive_recovery_action") return "rollback";
  if (name === "archive_recovery_binding_id") return "binding:1";
  if (name === "policy_activation_gate") return "P4-CSP";
  if (name === "candidate_gate") return "P1-PWA";
  if (name === "target_gate") return "P0-DATA";
  if (name.endsWith("source_sha")) return "c".repeat(40);
  return "value-1";
};

const requiredRequest = (operation) => {
  const request = Object.fromEntries(
    RELEASE_DISPATCH_OPERATION_SCHEMAS[operation].required.map((name) => [
      name,
      valueFor(name),
    ]),
  );
  if (operation === "produce-phase-exit-authority-bundle") {
    for (const name of [
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
    ]) {
      request[name] = valueFor(name);
    }
  }
  return request;
};

test("every release operation has a closed valid dispatch payload", () => {
  for (const operation of Object.keys(RELEASE_DISPATCH_OPERATION_SCHEMAS)) {
    const request = requiredRequest(operation);
    const bytes = canonicalJsonBytes(request);
    const resolved = validateReleaseDispatchRequest({
      operation,
      sourceSha: SOURCE_SHA,
      requestBytes: bytes,
      currentRunId: "999999",
    });
    assert.deepEqual(resolved.request, request, operation);
    assert.deepEqual(
      buildReleaseDispatchRequest({ operation, fields: request }),
      bytes,
      operation,
    );
  }
});

test("dispatch payload rejects missing, extra, malformed, duplicate-run, and noncanonical input", () => {
  const operation = "produce-phase-exit-authority-bundle";
  const request = requiredRequest(operation);
  const firstKey = Object.keys(request)[0];
  const missing = { ...request };
  delete missing[firstKey];
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(missing),
      }),
    /fields differ/u,
  );
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes({ ...request, caller_passed: "true" }),
      }),
    /fields differ/u,
  );
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: Buffer.from(` ${canonicalJsonBytes(request)}`, "utf8"),
      }),
    /canonical object/u,
  );
  const malformed = { ...request, baseline_closure_sha256: "f".repeat(63) };
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(malformed),
      }),
    /fields differ/u,
  );
  const runFields = Object.keys(request).filter((name) =>
    name.endsWith("_run_id"),
  );
  const duplicate = {
    ...request,
    [runFields[1]]: request[runFields[0]],
  };
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(duplicate),
      }),
    /prior-run authority/u,
  );
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(request),
        currentRunId: request[runFields[0]],
      }),
    /prior-run authority/u,
  );
});

test("closes P0 baseline collectors and pre-initialization attestation predecessors by gate", () => {
  const baseline = {
    target_gate: "P0-BASELINE",
    phase_authority_external_bindings_run_id: "7101",
    phase_authority_external_bindings_run_attempt: "1",
    phase_authority_bootstrap_recovery_run_id: "7102",
    phase_authority_bootstrap_recovery_run_attempt: "2",
  };
  assert.deepEqual(
    validateReleaseDispatchRequest({
      operation: "produce-phase-exit-authority-bundle",
      sourceSha: SOURCE_SHA,
      requestBytes: canonicalJsonBytes(baseline),
    }).request,
    baseline,
  );
  const attest = (targetGate, predecessor = undefined) => ({
    operation_id: "phase-exit:preinit",
    target_gate: targetGate,
    ...(predecessor === undefined
      ? {}
      : { predecessor_attestation_sha256: predecessor }),
  });
  for (const targetGate of ["P0-TOOLCHAIN", "P0-ARTIFACT"]) {
    assert.doesNotThrow(() =>
      validateReleaseDispatchRequest({
        operation: "attest-phase-exit",
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(attest(targetGate, "e".repeat(64))),
      }),
    );
    assert.throws(
      () =>
        validateReleaseDispatchRequest({
          operation: "attest-phase-exit",
          sourceSha: SOURCE_SHA,
          requestBytes: canonicalJsonBytes(attest(targetGate)),
        }),
      /pre-initialization attestation predecessor/u,
    );
  }
  for (const targetGate of ["P0-BASELINE", "P0-DATA", "P1-PWA"]) {
    assert.throws(
      () =>
        validateReleaseDispatchRequest({
          operation: "attest-phase-exit",
          sourceSha: SOURCE_SHA,
          requestBytes: canonicalJsonBytes(attest(targetGate, "e".repeat(64))),
        }),
      /pre-initialization attestation predecessor/u,
    );
  }
});

test("P1 requires a strict PWA receipt while P7 keeps only three stage selectors", () => {
  const managedDeviceSelectors = {
    phase_authority_managed_device_run_1_id: "8103",
    phase_authority_managed_device_run_1_attempt: "1",
    phase_authority_managed_device_run_2_id: "8101",
    phase_authority_managed_device_run_2_attempt: "2",
    phase_authority_managed_device_run_3_id: "8102",
    phase_authority_managed_device_run_3_attempt: "1",
  };
  const pwaRequest = {
    target_gate: "P1-PWA",
    phase_authority_pwa_receipt_run_id: "8104",
    phase_authority_pwa_receipt_run_attempt: "3",
    ...managedDeviceSelectors,
  };
  const idbRequest = {
    target_gate: "P7-IDB",
    ...managedDeviceSelectors,
  };
  for (const request of [pwaRequest, idbRequest]) {
    assert.deepEqual(
      validateReleaseDispatchRequest({
        operation: "produce-phase-exit-authority-bundle",
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(request),
        currentRunId: "9000",
      }).request,
      request,
    );
    for (const forbidden of [
      "stage",
      "status",
      "receipt_sha256",
      "deployment_url",
      "client_kind",
    ]) {
      assert.throws(
        () =>
          validateReleaseDispatchRequest({
            operation: "produce-phase-exit-authority-bundle",
            sourceSha: SOURCE_SHA,
            requestBytes: canonicalJsonBytes({
              ...request,
              [`phase_authority_managed_device_${forbidden}`]: "caller-claim",
            }),
          }),
        /fields differ/u,
      );
    }
  }
  for (const missing of [
    "phase_authority_pwa_receipt_run_id",
    "phase_authority_pwa_receipt_run_attempt",
  ]) {
    const incomplete = { ...pwaRequest };
    delete incomplete[missing];
    assert.throws(
      () =>
        validateReleaseDispatchRequest({
          operation: "produce-phase-exit-authority-bundle",
          sourceSha: SOURCE_SHA,
          requestBytes: canonicalJsonBytes(incomplete),
        }),
      /exact target gate/u,
    );
  }
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation: "produce-phase-exit-authority-bundle",
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes({
          ...idbRequest,
          phase_authority_pwa_receipt_run_id: "8104",
          phase_authority_pwa_receipt_run_attempt: "3",
        }),
      }),
    /exact target gate/u,
  );
});

test("strict PWA collector dispatch accepts only an empty request and known operation", () => {
  assert.deepEqual(
    validateReleaseDispatchRequest({
      operation: "collect-pwa-multiclient-drill",
      sourceSha: SOURCE_SHA,
      requestBytes: canonicalJsonBytes({}),
    }).request,
    {},
  );
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation: "collect-pwa-multiclient-drill",
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes({ status: "passed" }),
      }),
    /fields differ/u,
  );
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation: "collect-pwa-multiclient-drill-unknown",
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes({}),
      }),
    /identity is invalid/u,
  );
});

test("acceptance performance evidence requires run, attempt, and hash together", () => {
  for (const operation of ["produce-acceptance-inputs", "accept-standard"]) {
    const base = requiredRequest(operation);
    const complete = {
      ...base,
      performance_evidence_run_id: String(nextRunId + 100),
      performance_evidence_run_attempt: "1",
      performance_evidence_sha256: "d".repeat(64),
    };
    assert.deepEqual(
      validateReleaseDispatchRequest({
        operation,
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(complete),
      }).request,
      complete,
    );
    for (const missing of Object.keys(complete).filter((name) =>
      name.startsWith("performance_evidence_"),
    )) {
      const partial = { ...complete };
      delete partial[missing];
      assert.throws(
        () =>
          validateReleaseDispatchRequest({
            operation,
            sourceSha: SOURCE_SHA,
            requestBytes: canonicalJsonBytes(partial),
          }),
        /prior-run authority/u,
      );
    }
  }
});

test("candidate gate is required and limited to production release gates", () => {
  for (const operation of [
    "produce-artifact-build-requirements",
    "produce-acceptance-requirements",
    "produce-acceptance-inputs",
    "accept-standard",
  ]) {
    const request = requiredRequest(operation);
    assert.equal(request.candidate_gate, "P1-PWA");
    const missing = { ...request };
    delete missing.candidate_gate;
    assert.throws(
      () =>
        validateReleaseDispatchRequest({
          operation,
          sourceSha: SOURCE_SHA,
          requestBytes: canonicalJsonBytes(missing),
        }),
      /fields differ/u,
      operation,
    );
    assert.throws(
      () =>
        validateReleaseDispatchRequest({
          operation,
          sourceSha: SOURCE_SHA,
          requestBytes: canonicalJsonBytes({
            ...request,
            candidate_gate: "P0-TOOLCHAIN",
          }),
        }),
      /fields differ/u,
      operation,
    );
  }
});

test("policy closure selector distinguishes normal QA from P8 floor-only", () => {
  const floorOnly = { operation_id: "activate-p8-floor" };
  assert.deepEqual(
    validateReleaseDispatchRequest({
      operation: "produce-policy-activation-closure",
      sourceSha: SOURCE_SHA,
      requestBytes: canonicalJsonBytes(floorOnly),
      currentRunId: "9000",
    }).request,
    floorOnly,
  );
  const normalQa = {
    ...floorOnly,
    policy_qa_execution_run_id: "8100",
    policy_qa_execution_sha256: "f".repeat(64),
  };
  assert.deepEqual(
    validateReleaseDispatchRequest({
      operation: "produce-policy-activation-closure",
      sourceSha: SOURCE_SHA,
      requestBytes: canonicalJsonBytes(normalQa),
      currentRunId: "9000",
    }).request,
    normalQa,
  );
  for (const incomplete of [
    {
      ...floorOnly,
      policy_qa_execution_run_id: "8100",
    },
    {
      ...floorOnly,
      policy_qa_execution_sha256: "f".repeat(64),
    },
  ]) {
    assert.throws(
      () =>
        validateReleaseDispatchRequest({
          operation: "produce-policy-activation-closure",
          sourceSha: SOURCE_SHA,
          requestBytes: canonicalJsonBytes(incomplete),
          currentRunId: "9000",
        }),
      /selector must be wholly present or absent/u,
    );
  }
  assert.throws(
    () =>
      validateReleaseDispatchRequest({
        operation: "produce-policy-activation-closure",
        sourceSha: SOURCE_SHA,
        requestBytes: canonicalJsonBytes(normalQa),
        currentRunId: "8100",
      }),
    /prior-run authority/u,
  );
});

test("workflow dispatch has only three inputs and never interpolates raw request JSON", async () => {
  const workflowText = await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const workflow = yaml.load(workflowText);
  const dispatch = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(dispatch), [
    "source_sha",
    "operation",
    "request_json",
  ]);
  assert.ok(Object.keys(dispatch).length <= 25);
  const references = [
    ...workflowText.matchAll(/inputs\.([a-zA-Z0-9_]+)/gu),
  ].map((match) => match[1]);
  assert.ok(
    references.every((name) =>
      ["source_sha", "operation", "request_json"].includes(name),
    ),
  );
  assert.doesNotMatch(workflowText, /run:\s*.*\$\{\{\s*inputs\.request_json/u);
  for (const operation of Object.keys(RELEASE_DISPATCH_OPERATION_SCHEMAS)) {
    assert.ok(workflowText.includes(operation), operation);
  }
});

test("validator writes only normalized fields and builder uses create-only output", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-dispatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operation = "plan-archive-recovery";
  const request = requiredRequest(operation);
  const githubEnvironmentPath = path.join(directory, "github-env.txt");
  await runReleaseDispatchRequestCli({
    argv: ["validate"],
    env: {
      INPUT_OPERATION: operation,
      INPUT_SOURCE_SHA: SOURCE_SHA,
      INPUT_REQUEST_JSON: canonicalJsonBytes(request).toString("utf8"),
      GITHUB_ENV: githubEnvironmentPath,
      GITHUB_RUN_ID: "999999",
    },
  });
  const normalized = await readFile(githubEnvironmentPath, "utf8");
  assert.match(normalized, /REQUESTED_ARCHIVE_RECOVERY_ACTION=rollback/u);
  assert.doesNotMatch(normalized, /INPUT_REQUEST_JSON/u);

  const emptyEnvironmentPath = path.join(directory, "empty-github-env.txt");
  await writeFile(emptyEnvironmentPath, "EXISTING=preserved\n", "utf8");
  await runReleaseDispatchRequestCli({
    argv: ["validate"],
    env: {
      INPUT_OPERATION: "collect-pwa-multiclient-drill",
      INPUT_SOURCE_SHA: SOURCE_SHA,
      INPUT_REQUEST_JSON: canonicalJsonBytes({}).toString("utf8"),
      GITHUB_ENV: emptyEnvironmentPath,
      GITHUB_RUN_ID: "999999",
    },
  });
  assert.equal(
    await readFile(emptyEnvironmentPath, "utf8"),
    "EXISTING=preserved\n",
  );

  const output = path.join(directory, "request.json");
  const flags = Object.entries(request).flatMap(([name, value]) => [
    `--${name}`,
    value,
  ]);
  await runReleaseDispatchRequestCli({
    argv: ["build", "--operation", operation, "--output", output, ...flags],
  });
  assert.deepEqual(await readFile(output), canonicalJsonBytes(request));
  await assert.rejects(
    runReleaseDispatchRequestCli({
      argv: ["build", "--operation", operation, "--output", output, ...flags],
    }),
    /EEXIST/u,
  );
});
