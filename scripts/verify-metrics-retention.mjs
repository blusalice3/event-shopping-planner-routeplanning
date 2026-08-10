import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = await readJsonStrict(
  path.join(root, "config", "metrics-retention-policy.json"),
);
const migration = await readFile(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260805000000_persistence_release_a_hardening.sql",
  ),
  "utf8",
);

const exactValues = {
  primaryRawRetentionDays: 30,
  cspSanitizedRetentionDays: 7,
  batchSize: 5000,
  maximumBatchesPerRun: 12,
  lockTimeoutMilliseconds: 1000,
  statementTimeoutMilliseconds: 15000,
  lastSuccessBlockingAfterSeconds: 7200,
};
for (const [key, expected] of Object.entries(exactValues)) {
  if (policy[key] !== expected) {
    throw new Error(`Retention policy ${key} must equal ${expected}`);
  }
}
if (
  policy.cron?.schedule !== "17 * * * *" ||
  !migration.includes("'17 * * * *'")
) {
  throw new Error("Retention cron must run hourly at UTC minute 17");
}
const requiredTargets = ["csp-reports", "persistence-release-a-metrics"];
if (
  !Array.isArray(policy.requiredTargets) ||
  policy.requiredTargets.length !== requiredTargets.length ||
  policy.requiredTargets.some(
    (target, index) => target !== requiredTargets[index],
  )
) {
  throw new Error("Retention policy target set is invalid");
}
for (const fragment of [
  "interval '30 days'",
  "interval '7 days'",
  "requested_dry_run is null",
  "requested_batch_size is null",
  "requested_max_batches is null",
  "pg_try_advisory_xact_lock",
  "set_config('lock_timeout', '1000ms', true)",
  "set_config('statement_timeout', '15000ms', true)",
  "limit requested_batch_size",
  "for update skip locked",
  "foundation_retention_run_audit",
]) {
  if (!migration.includes(fragment)) {
    throw new Error(`Retention migration lacks: ${fragment}`);
  }
}

const parseArguments = (argv) => {
  const options = {
    evidencePath: null,
    live: false,
    outputPath: null,
    requireProductionReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--live" && !options.live) {
      options.live = true;
    } else if (
      argument === "--require-production-ready" &&
      !options.requireProductionReady
    ) {
      options.requireProductionReady = true;
    } else if (
      argument === "--evidence" &&
      options.evidencePath === null &&
      typeof argv[index + 1] === "string"
    ) {
      options.evidencePath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (
      argument === "--output" &&
      options.outputPath === null &&
      typeof argv[index + 1] === "string"
    ) {
      options.outputPath = path.resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Invalid metrics retention argument: ${argument}`);
    }
  }
  if (
    (options.outputPath !== null && !options.live) ||
    (options.evidencePath !== null && options.live)
  ) {
    throw new Error("Metrics retention argument combination is invalid");
  }
  return options;
};

const options = parseArguments(process.argv.slice(2));

const canonicalTimestamp = (value) => {
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? milliseconds
    : NaN;
};

const hasExactKeys = (value, expected) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key));

const assertCollectorIdentity = (identity) => {
  if (
    !hasExactKeys(identity, [
      "repository",
      "workflowPath",
      "sourceSha",
      "runId",
      "runAttempt",
    ]) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.repository ?? "") ||
    identity.workflowPath !== ".github/workflows/metrics-retention.yml" ||
    !/^[0-9a-f]{40}$/u.test(identity.sourceSha ?? "") ||
    !/^[1-9][0-9]{0,19}$/u.test(identity.runId ?? "") ||
    !/^[1-9][0-9]{0,19}$/u.test(identity.runAttempt ?? "")
  ) {
    throw new Error("Retention collector identity is invalid");
  }
};

const readProtectedCollectorIdentity = (
  environment,
  { requireWorkflowDispatch },
) => {
  const workflowReference = environment.GITHUB_WORKFLOW_REF ?? "";
  const repository = environment.GITHUB_REPOSITORY ?? "";
  const workflowPrefix = `${repository}/.github/workflows/metrics-retention.yml@`;
  const identity = {
    repository,
    workflowPath: ".github/workflows/metrics-retention.yml",
    sourceSha: environment.GITHUB_SHA ?? "",
    runId: environment.GITHUB_RUN_ID ?? "",
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? "",
  };
  assertCollectorIdentity(identity);
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    !["schedule", "workflow_dispatch"].includes(
      environment.GITHUB_EVENT_NAME,
    ) ||
    (requireWorkflowDispatch &&
      environment.GITHUB_EVENT_NAME !== "workflow_dispatch") ||
    environment.GITHUB_REF !== "refs/heads/main" ||
    environment.GITHUB_REF_PROTECTED !== "true" ||
    !workflowReference.startsWith(workflowPrefix)
  ) {
    throw new Error(
      "Retention collector must run as the protected main workflow dispatch",
    );
  }
  return identity;
};

const validateEvidence = (evidence) => {
  if (
    !hasExactKeys(evidence, [
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
    ])
  ) {
    throw new Error("Retention evidence schema is not closed");
  }
  assertCollectorIdentity(evidence.collectorIdentity);
  const observedAt = canonicalTimestamp(evidence.observedAt);
  if (!Number.isFinite(observedAt)) {
    throw new Error("Retention observation timestamp is invalid");
  }
  const lastSuccessByTarget = evidence.lastSuccessByTarget ?? {};
  const dryRunByTarget = evidence.dryRunByTarget ?? {};
  if (
    Object.keys(lastSuccessByTarget).sort().join("\n") !==
      requiredTargets.join("\n") ||
    Object.keys(dryRunByTarget).sort().join("\n") !== requiredTargets.join("\n")
  ) {
    throw new Error("Retention evidence target set is incomplete");
  }
  for (const target of requiredTargets) {
    const lastSuccess = canonicalTimestamp(lastSuccessByTarget[target]);
    const dryRun = dryRunByTarget[target];
    if (
      !Number.isFinite(lastSuccess) ||
      observedAt < lastSuccess ||
      (observedAt - lastSuccess) / 1000 > policy.lastSuccessBlockingAfterSeconds
    ) {
      throw new Error(`Retention last-success is stale or invalid: ${target}`);
    }
    if (
      dryRun?.succeeded !== true ||
      !Number.isSafeInteger(dryRun.affectedRows) ||
      dryRun.affectedRows < 0 ||
      !Number.isSafeInteger(dryRun.batchCount) ||
      dryRun.batchCount < 0 ||
      dryRun.batchCount > policy.maximumBatchesPerRun ||
      !Number.isFinite(canonicalTimestamp(dryRun.cutoff))
    ) {
      throw new Error(`Retention dry-run evidence is invalid: ${target}`);
    }
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.cronSchedule !== policy.cron.schedule ||
    evidence.cronActive !== true ||
    evidence.batchSize !== policy.batchSize ||
    evidence.maximumBatchesPerRun !== policy.maximumBatchesPerRun ||
    evidence.lockTimeoutMilliseconds !== policy.lockTimeoutMilliseconds ||
    evidence.statementTimeoutMilliseconds !==
      policy.statementTimeoutMilliseconds ||
    evidence.backupRetentionOwner !== policy.backupRetentionOwner
  ) {
    throw new Error("Retention evidence differs from policy");
  }
};

if (options.evidencePath !== null) {
  const evidence = await readJsonStrict(options.evidencePath);
  validateEvidence(evidence);
}

if (options.live) {
  if (
    policy.activationStatus !== "configured" ||
    typeof policy.backupRetentionOwner !== "string" ||
    policy.backupRetentionOwner.length === 0
  ) {
    throw new Error(
      `Metrics retention is not configured: ${(policy.blockerCodes ?? []).join(", ")}`,
    );
  }
  const connectionString =
    process.env.PERSISTENCE_METRICS_VERIFIER_DATABASE_URL;
  const ca = process.env.PERSISTENCE_METRICS_VERIFIER_CA;
  if (!connectionString || !ca) {
    throw new Error("Remote retention verifier credentials are absent");
  }
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    application_name: "event-shopping-planner-retention-verifier",
  });
  await client.connect();
  try {
    const [cronResult, successResult, metricDryRun, cspDryRun] =
      await Promise.all([
        client.query({
          text: `
            select schedule, active
            from cron.job
            where jobname = $1
          `,
          values: ["event-shopping-planner-foundation-retention-v1"],
        }),
        client.query(`
          select target, max(completed_at) as last_success_at
          from public.foundation_retention_run_audit
          where succeeded and not dry_run
          group by target
        `),
        client.query(
          "select * from public.retain_persistence_release_a_metrics(true, 5000, 12)",
        ),
        client.query(
          "select * from public.retain_csp_violation_reports(true, 5000, 12)",
        ),
      ]);
    if (
      cronResult.rowCount !== 1 ||
      cronResult.rows[0].active !== true ||
      metricDryRun.rowCount !== 1 ||
      cspDryRun.rowCount !== 1
    ) {
      throw new Error("Remote retention cron or dry-run contract is invalid");
    }
    const successByTarget = Object.fromEntries(
      successResult.rows.map((row) => [
        row.target,
        new Date(row.last_success_at).toISOString(),
      ]),
    );
    const toDryRunEvidence = (row) => ({
      succeeded: true,
      affectedRows: Number(row.affected_rows),
      batchCount: Number(row.batch_count),
      cutoff: new Date(row.cutoff).toISOString(),
    });
    const evidence = {
      schemaVersion: 1,
      observedAt: new Date().toISOString(),
      lastSuccessByTarget: successByTarget,
      cronSchedule: cronResult.rows[0].schedule,
      cronActive: cronResult.rows[0].active,
      batchSize: policy.batchSize,
      maximumBatchesPerRun: policy.maximumBatchesPerRun,
      lockTimeoutMilliseconds: policy.lockTimeoutMilliseconds,
      statementTimeoutMilliseconds: policy.statementTimeoutMilliseconds,
      dryRunByTarget: {
        "persistence-release-a-metrics": toDryRunEvidence(
          metricDryRun.rows[0] ?? {},
        ),
        "csp-reports": toDryRunEvidence(cspDryRun.rows[0] ?? {}),
      },
      backupRetentionOwner: policy.backupRetentionOwner,
      collectorIdentity: readProtectedCollectorIdentity(process.env, {
        requireWorkflowDispatch: options.outputPath !== null,
      }),
    };
    validateEvidence(evidence);
    if (options.outputPath !== null) {
      const bytes = canonicalJsonBytes(evidence);
      await writeFile(options.outputPath, bytes, { flag: "wx" });
      const readback = await readFile(options.outputPath);
      if (!readback.equals(bytes)) {
        throw new Error("Metrics retention evidence readback differs");
      }
    }
  } finally {
    await client.end();
  }
}

if (
  options.requireProductionReady &&
  policy.activationStatus !== "configured"
) {
  throw new Error(
    `Metrics retention is not configured: ${(policy.blockerCodes ?? []).join(", ")}`,
  );
}

console.log(
  `PASS metrics retention policy: raw ${policy.primaryRawRetentionDays}d; CSP ${policy.cspSanitizedRetentionDays}d; ${policy.batchSize}x${policy.maximumBatchesPerRun}.`,
);
