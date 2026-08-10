#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import { fail, readJson } from "./foundation-policy-utils.mjs";

const policy = await readJson("config/audit-waivers.json");
const lockfile = await readJson("package-lock.json");
const errors = [];

const runAudit = (productionOnly) => {
  const npmArguments = [
    "audit",
    ...(productionOnly ? ["--omit=dev"] : []),
    "--json",
  ];
  const result =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
          ["/d", "/s", "/c", `npm ${npmArguments.join(" ")}`],
          { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
        )
      : spawnSync("npm", npmArguments, {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm audit did not return JSON: ${result.stderr || result.stdout}`,
    );
  }
};

const allAudit = runAudit(false);
const productionAudit = runAudit(true);
const activeWaivers = new Map();

for (const waiver of policy.waivers) {
  for (const field of [
    "id",
    "advisory",
    "severity",
    "owner",
    "reason",
    "expiry",
    "mitigation",
  ]) {
    if (typeof waiver[field] !== "string" || waiver[field].length === 0) {
      errors.push(`${waiver.id ?? "unknown waiver"}: missing ${field}`);
    }
  }
  if (Date.parse(`${waiver.expiry}T00:00:00Z`) <= Date.now()) {
    errors.push(`${waiver.id}: audit waiver is expired`);
  }
  const installedVersion =
    lockfile.packages?.[`node_modules/${waiver.installedPackage}`]?.version;
  if (installedVersion !== waiver.installedVersion) {
    errors.push(
      `${waiver.id}: installed ${waiver.installedPackage} is ${installedVersion ?? "missing"}, expected ${waiver.installedVersion}`,
    );
  }
  for (const [graph, reachability] of Object.entries(
    waiver.reachability ?? {},
  )) {
    if (typeof reachability !== "string" || reachability.length === 0) {
      errors.push(`${waiver.id}: reachability.${graph} is missing`);
    }
  }
  for (const packageName of waiver.affectedPackages ?? []) {
    activeWaivers.set(packageName, waiver);
  }
}

const blockingSeverities = new Set(["critical", "high"]);
for (const [name, vulnerability] of Object.entries(
  allAudit.vulnerabilities ?? {},
)) {
  if (!blockingSeverities.has(vulnerability.severity)) continue;
  if (!activeWaivers.has(name)) {
    errors.push(`${name}: unwaived ${vulnerability.severity} vulnerability`);
  }
}

for (const [name, vulnerability] of Object.entries(
  productionAudit.vulnerabilities ?? {},
)) {
  if (blockingSeverities.has(vulnerability.severity)) {
    errors.push(
      `${name}: reachable production ${vulnerability.severity} vulnerability`,
    );
  }
}

if (errors.length > 0) {
  fail("FAIL reachability-aware audit", errors);
} else {
  const all = allAudit.metadata.vulnerabilities;
  const production = productionAudit.metadata.vulnerabilities;
  process.stdout.write(
    `PASS reachability-aware audit: all critical=${all.critical}, high=${all.high} (${policy.waivers.length} reviewed waiver); production critical=${production.critical}, high=${production.high}; moderate=${production.moderate}\n`,
  );
}
