#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict } from "./lib/canonical-json.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = await readJsonStrict(path.join(root, "package.json"));
const cspContractMigration = await readFile(
  path.join(
    root,
    "supabase",
    "migrations",
    "20260808000000_csp_report_contract.sql",
  ),
  "utf8",
);
const cspUpgradeMatch = cspContractMigration.match(
  /-- CSP_REPORT_CONTRACT_UPGRADE_BEGIN([\s\S]*?)-- CSP_REPORT_CONTRACT_UPGRADE_END/u,
);
if (!cspUpgradeMatch) {
  throw new Error("CSP report contract upgrade block is missing");
}
const cspReportContractUpgradeSql = cspUpgradeMatch[1];
if (process.versions.node !== packageJson.engines.node) {
  throw new Error(
    `Disposable DB gate requires Node ${packageJson.engines.node}; received ${process.versions.node}`,
  );
}
if (process.platform !== "linux") {
  throw new Error(
    "Disposable DB gate is CI-only and requires a Linux Docker host",
  );
}

const supabaseEntry = path.join(
  root,
  "node_modules",
  "supabase",
  "dist",
  "supabase.js",
);
const excludedServices = [
  "gotrue",
  "realtime",
  "storage-api",
  "imgproxy",
  "kong",
  "mailpit",
  "postgrest",
  "postgres-meta",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
].join(",");

const runSupabase = (arguments_, { allowFailure = false } = {}) => {
  const result = spawnSync(
    process.execPath,
    [supabaseEntry, ...arguments_, "--workdir", root],
    {
      cwd: root,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      stdio: allowFailure ? "pipe" : "inherit",
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`Supabase ${arguments_.join(" ")} failed`);
  }
  return result;
};

const scalar = async (client, text) => {
  const result = await client.query(text);
  if (result.rowCount !== 1 || Object.keys(result.rows[0]).length !== 1) {
    throw new Error(`Disposable DB scalar query is ambiguous: ${text}`);
  }
  return Object.values(result.rows[0])[0];
};

let started = false;
try {
  runSupabase(["start", "--exclude", excludedServices]);
  started = true;
  runSupabase(["db", "reset", "--local", "--no-seed"]);

  const { Client } = await import("pg");
  const client = new Client({
    host: "127.0.0.1",
    port: 54322,
    database: "postgres",
    user: "postgres",
    password: "postgres",
    ssl: false,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "foundation-disposable-db-gate",
  });
  await client.connect();
  try {
    const serverVersion = String(await scalar(client, "show server_version"));
    if (!serverVersion.startsWith("17.")) {
      throw new Error(`Disposable DB must use PostgreSQL 17: ${serverVersion}`);
    }
    const requiredRelations = await client.query(`
      select c.relname, c.relkind
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'persistence_release_a_metric_events',
          'persistence_release_a_metrics_dashboard_24h',
          'persistence_release_a_metrics_dashboard_hourly_24h',
          'persistence_release_a_cleanup_dashboard_24h',
          'csp_violation_reports',
          'foundation_retention_run_audit'
        )
      order by c.relname
    `);
    if (requiredRelations.rowCount !== 6) {
      throw new Error("Disposable DB is missing a required table or view");
    }
    const requiredFunctions = await client.query(`
      select p.proname
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in (
          'read_persistence_release_a_metrics',
          'read_csp_violation_aggregates',
          'retain_persistence_release_a_metrics',
          'retain_csp_violation_reports'
        )
      order by p.proname
    `);
    if (requiredFunctions.rowCount !== 4) {
      throw new Error("Disposable DB is missing a bounded operator function");
    }

    const legacyCspSourceSha = "fedcba9876543210fedcba9876543210fedcba98";
    await client.query(`
      alter table public.csp_violation_reports
        drop constraint csp_violation_reports_blocked_target_check;
      alter table public.csp_violation_reports
        add check (
          blocked_target in (
            'self',
            'data',
            'blob',
            'http',
            'https',
            'same-site',
            'cross-site',
            'inline',
            'eval',
            'unknown'
          )
        );
      insert into public.csp_violation_reports (
        schema_version,
        effective_directive,
        disposition,
        blocked_target,
        source_sha,
        provider_deployment_id
      ) values (
        1,
        'script-src',
        'report',
        'data',
        '${legacyCspSourceSha}',
        'deployment_disposable_csp_legacy'
      );
    `);
    const legacyBlockedTargetConstraint = await scalar(
      client,
      `select constraint_name
       from information_schema.check_constraints
       where constraint_schema = 'public'
         and constraint_name like 'csp_violation_reports_blocked_target_check%'`,
    );
    if (
      legacyBlockedTargetConstraint !==
      "csp_violation_reports_blocked_target_check"
    ) {
      throw new Error(
        `Legacy CSP constraint received an unexpected name: ${legacyBlockedTargetConstraint}`,
      );
    }

    await client.query(cspReportContractUpgradeSql);
    const upgradedLegacyTarget = await scalar(
      client,
      `select blocked_target
       from public.csp_violation_reports
       where provider_deployment_id = 'deployment_disposable_csp_legacy'`,
    );
    const upgradedConstraints = await client.query(`
      select conname, convalidated
      from pg_catalog.pg_constraint
      where conrelid = 'public.csp_violation_reports'::regclass
        and contype = 'c'
        and (
          pg_catalog.pg_get_constraintdef(oid) like '%effective_directive%'
          or pg_catalog.pg_get_constraintdef(oid) like '%blocked_target%'
        )
      order by conname
    `);
    const expectedUpgradedConstraintNames = [
      "csp_violation_reports_blocked_target_check",
      "csp_violation_reports_effective_directive_check",
    ];
    if (
      upgradedLegacyTarget !== "scheme" ||
      upgradedConstraints.rowCount !== 2 ||
      upgradedConstraints.rows.some(
        (constraint, index) =>
          constraint.conname !== expectedUpgradedConstraintNames[index],
      ) ||
      upgradedConstraints.rows.some(
        (constraint) => constraint.convalidated !== true,
      )
    ) {
      throw new Error("CSP report contract upgrade was not validated");
    }
    await client.query(
      `delete from public.csp_violation_reports
       where provider_deployment_id = 'deployment_disposable_csp_legacy'`,
    );

    const grants = await client.query(`
      select
        has_table_privilege(
          'service_role',
          'public.persistence_release_a_metric_events',
          'INSERT'
        ) as metrics_insert,
        has_table_privilege(
          'service_role',
          'public.persistence_release_a_metric_events',
          'SELECT'
        ) as metrics_select,
        has_table_privilege(
          'service_role',
          'public.csp_violation_reports',
          'INSERT'
        ) as csp_insert,
        has_table_privilege(
          'service_role',
          'public.csp_violation_reports',
          'SELECT'
        ) as csp_select,
        has_function_privilege(
          'service_role',
          'public.read_persistence_release_a_metrics(timestamptz,timestamptz,integer)',
          'EXECUTE'
        ) as metrics_read_execute,
        has_function_privilege(
          'service_role',
          'public.retain_persistence_release_a_metrics(boolean,integer,integer)',
          'EXECUTE'
        ) as metrics_retention_execute
    `);
    if (
      grants.rowCount !== 1 ||
      grants.rows[0].metrics_insert !== true ||
      grants.rows[0].metrics_select !== false ||
      grants.rows[0].csp_insert !== true ||
      grants.rows[0].csp_select !== false ||
      grants.rows[0].metrics_read_execute !== false ||
      grants.rows[0].metrics_retention_execute !== false
    ) {
      throw new Error("Disposable DB service role privileges differ");
    }
    for (const role of ["anon", "authenticated"]) {
      const roleGrants = await client.query({
        text: `select
          has_table_privilege(
            $1,
            'public.persistence_release_a_metric_events',
            'SELECT'
          ) as can_read,
          has_table_privilege(
            $1,
            'public.persistence_release_a_metric_events',
            'INSERT'
          ) as can_insert`,
        values: [role],
      });
      if (
        roleGrants.rowCount !== 1 ||
        roleGrants.rows[0].can_read ||
        roleGrants.rows[0].can_insert
      ) {
        throw new Error(`Disposable DB grants application access to ${role}`);
      }
    }
    const forbiddenAclCount = Number(
      await scalar(
        client,
        `select count(*)::integer
         from (
           select c.oid
           from pg_catalog.pg_class c
           join pg_catalog.pg_namespace n on n.oid = c.relnamespace
           cross join lateral pg_catalog.aclexplode(
             coalesce(
               c.relacl,
               pg_catalog.acldefault(
                 case when c.relkind = 'S' then 's' else 'r' end::"char",
                 c.relowner
               )
             )
           ) acl
           where n.nspname = 'public'
             and c.relname in (
               'persistence_release_a_metric_events',
               'persistence_release_a_metric_events_id_seq',
               'persistence_release_a_metrics_dashboard_24h',
               'persistence_release_a_metrics_dashboard_hourly_24h',
               'persistence_release_a_cleanup_dashboard_24h',
               'csp_violation_reports',
               'csp_violation_reports_id_seq',
               'foundation_retention_run_audit',
               'foundation_retention_run_audit_id_seq'
             )
             and (
               acl.grantee = 0
               or pg_catalog.pg_get_userbyid(acl.grantee) in (
                 'anon',
                 'authenticated'
               )
             )
           union all
           select p.oid
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           cross join lateral pg_catalog.aclexplode(
             coalesce(
               p.proacl,
               pg_catalog.acldefault('f'::"char", p.proowner)
             )
           ) acl
           where n.nspname = 'public'
             and p.proname in (
               'read_persistence_release_a_metrics',
               'read_csp_violation_aggregates',
               'retain_persistence_release_a_metrics',
               'retain_csp_violation_reports'
             )
             and (
               acl.grantee = 0
               or pg_catalog.pg_get_userbyid(acl.grantee) in (
                 'anon',
                 'authenticated'
               )
             )
         ) forbidden_acl`,
      ),
    );
    if (forbiddenAclCount !== 0) {
      throw new Error(
        `Disposable DB exposes ${forbiddenAclCount} forbidden ACL entries`,
      );
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await client.query(`
        insert into public.persistence_release_a_metric_events (
          schema_version,
          event_version,
          event_name,
          outcome,
          duration_bucket,
          cleanup_mode,
          cleanup_reason,
          build_id,
          browser_family,
          app_mode,
          online
        ) values (
          1,
          1,
          'startup',
          'ready',
          'lt-250ms',
          null,
          null,
          '0123456789abcdef0123456789abcdef01234567',
          'chromium',
          'browser-tab',
          true
        )
      `);
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await assert.rejects(
        client.query(`
          insert into public.persistence_release_a_metric_events (
            schema_version,
            event_version,
            event_name,
            outcome,
            duration_bucket,
            cleanup_mode,
            cleanup_reason,
            build_id,
            browser_family,
            app_mode,
            online
          ) values (
            1,
            1,
            'startup',
            'ready',
            null,
            null,
            null,
            '0123456789abcdef0123456789abcdef01234567',
            'chromium',
            'browser-tab',
            true
          )
        `),
        /persistence_release_a_metric_duration_check/,
      );
    } finally {
      await client.query("rollback");
    }

    const cspSourceSha = "89abcdef0123456789abcdef0123456789abcdef";
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await client.query({
        text: `insert into public.csp_violation_reports (
          schema_version,
          effective_directive,
          disposition,
          blocked_target,
          source_sha,
          provider_deployment_id
        ) values
          (1, 'worker-src', 'report', 'scheme', $1, $2),
          (1, 'unknown', 'report', 'unknown', $1, $3)`,
        values: [
          cspSourceSha,
          "deployment_disposable_csp_1",
          "deployment_disposable_csp_2",
        ],
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await assert.rejects(
        client.query({
          text: `insert into public.csp_violation_reports (
            schema_version,
            effective_directive,
            disposition,
            blocked_target,
            source_sha,
            provider_deployment_id
          ) values (1, 'trusted-types', 'report', 'unknown', $1, $2)`,
          values: [cspSourceSha, "deployment_disposable_csp_invalid"],
        }),
        /csp_violation_reports_effective_directive_check/,
      );
    } finally {
      await client.query("rollback");
    }

    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await assert.rejects(
        client.query("select blocked_target from public.csp_violation_reports"),
        /permission denied for table csp_violation_reports/,
      );
    } finally {
      await client.query("rollback");
    }

    const cspOperatorRole = "foundation_disposable_csp_operator";
    await client.query(`create role ${cspOperatorRole} nologin`);
    try {
      await client.query(
        `grant execute on function public.read_csp_violation_aggregates(
          timestamptz,
          timestamptz,
          integer
        ) to ${cspOperatorRole}`,
      );
      await client.query("begin");
      try {
        await client.query(`set local role ${cspOperatorRole}`);
        await assert.rejects(
          client.query(
            "select blocked_target from public.csp_violation_reports",
          ),
          /permission denied for table csp_violation_reports/,
        );
      } finally {
        await client.query("rollback");
      }

      await client.query("begin");
      try {
        await client.query(`set local role ${cspOperatorRole}`);
        const cspAggregate = await client.query({
          text: `select *
            from public.read_csp_violation_aggregates(
              clock_timestamp() - interval '1 minute',
              clock_timestamp() + interval '1 minute',
              10
            )`,
        });
        const aggregatesByDirective = new Map(
          cspAggregate.rows.map((row) => [row.effective_directive, row]),
        );
        const workerAggregate = aggregatesByDirective.get("worker-src");
        const unknownAggregate = aggregatesByDirective.get("unknown");
        if (
          cspAggregate.rowCount !== 2 ||
          workerAggregate?.source_sha !== cspSourceSha ||
          workerAggregate?.disposition !== "report" ||
          workerAggregate?.blocked_target !== "scheme" ||
          Number(workerAggregate?.violation_count) !== 1 ||
          unknownAggregate?.source_sha !== cspSourceSha ||
          unknownAggregate?.disposition !== "report" ||
          unknownAggregate?.blocked_target !== "unknown" ||
          Number(unknownAggregate?.violation_count) !== 1
        ) {
          throw new Error("Disposable DB CSP operator aggregate differs");
        }
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.query(
        `revoke execute on function public.read_csp_violation_aggregates(
          timestamptz,
          timestamptz,
          integer
        ) from ${cspOperatorRole}`,
      );
      await client.query(`drop role ${cspOperatorRole}`);
    }

    const retention = await client.query(
      "select * from public.retain_persistence_release_a_metrics(true, 10, 1)",
    );
    if (
      retention.rowCount !== 1 ||
      retention.rows[0].dry_run !== true ||
      Number(retention.rows[0].affected_rows) !== 0
    ) {
      throw new Error("Disposable DB retention dry-run differs");
    }
    const cronJobs = Number(
      await scalar(
        client,
        `select count(*) from cron.job
         where jobname = 'event-shopping-planner-foundation-retention-v1'`,
      ),
    );
    if (cronJobs !== 1) {
      throw new Error(
        "Disposable DB retention schedule is missing or duplicated",
      );
    }
  } finally {
    await client.end();
  }
  process.stdout.write(
    "PASS disposable PostgreSQL 17 migrations, privileges, constraints, retention, and cron\n",
  );
} finally {
  if (started) {
    const stopped = runSupabase(["stop", "--no-backup"], {
      allowFailure: true,
    });
    if (stopped.status !== 0) {
      process.stderr.write(
        `WARN disposable Supabase cleanup failed: ${stopped.stderr}\n`,
      );
      process.exitCode = 1;
    }
  }
}
