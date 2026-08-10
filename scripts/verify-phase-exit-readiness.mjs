#!/usr/bin/env node

import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "./lib/canonical-json.mjs";
import {
  buildPhaseExitReadiness,
  resolveRepositoryPhaseExitReadiness,
} from "./lib/phase-exit-readiness.mjs";
import { createPostgresReleaseStateStore } from "./release-state/postgresStore.mjs";
import { FORMAL_PHASE_EXIT_GATES } from "./release-state/phaseGates.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;

const nextValue = (argv, index, option) => {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
};

const parseArguments = (argv) => {
  const result = {
    externalAuthorityBundleSha256: null,
    json: false,
    namespace: null,
    output: null,
    requireAll: false,
    requireExit: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json" && !result.json) result.json = true;
    else if (token === "--require-all" && !result.requireAll) {
      result.requireAll = true;
    } else if (token === "--namespace" && result.namespace === null) {
      const namespace = nextValue(argv, index, token);
      if (!NAMESPACE_PATTERN.test(namespace)) {
        throw new Error("Phase readiness namespace is invalid");
      }
      result.namespace = namespace;
      index += 1;
    } else if (
      token === "--external-authority-bundle-sha256" &&
      result.externalAuthorityBundleSha256 === null
    ) {
      const sha256 = nextValue(argv, index, token);
      if (!/^[0-9a-f]{64}$/u.test(sha256)) {
        throw new Error("Phase readiness authority bundle SHA-256 is invalid");
      }
      result.externalAuthorityBundleSha256 = sha256;
      index += 1;
    } else if (token === "--output" && result.output === null) {
      result.output = nextValue(argv, index, token);
      index += 1;
    } else if (token === "--require-exit" && result.requireExit === null) {
      const gate = nextValue(argv, index, token);
      if (!FORMAL_PHASE_EXIT_GATES.includes(gate)) {
        throw new Error(`Unknown formal phase exit: ${gate}`);
      }
      result.requireExit = gate;
      index += 1;
    } else {
      throw new Error(`Invalid phase readiness argument: ${String(token)}`);
    }
  }
  if (result.json && result.output !== null) {
    throw new Error(
      "Phase readiness JSON stdout and output file are exclusive",
    );
  }
  if (
    result.externalAuthorityBundleSha256 !== null &&
    result.namespace === null
  ) {
    throw new Error("Phase readiness authority bundle requires --namespace");
  }
  return result;
};

const requireEnvironment = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required phase readiness environment is absent: ${name}`);
  }
  return value;
};

const createLiveReleaseStateStore = async (namespace) => {
  const policy = await readJsonStrict(
    path.join(root, "config", "release-state-store.json"),
  );
  if (
    policy.bindingStatus !== "configured" ||
    typeof policy.databaseUrlEnvironmentName !== "string" ||
    policy.databaseUrlEnvironmentName.length === 0
  ) {
    throw new Error(
      `Release State store is not configured: ${(policy.blockerCodes ?? []).join(", ")}`,
    );
  }
  return createPostgresReleaseStateStore({
    connectionString: requireEnvironment(policy.databaseUrlEnvironmentName),
    namespace,
    policy,
    ca: requireEnvironment("RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

export const runPhaseExitReadinessCli = async (
  argv = process.argv.slice(2),
) => {
  const options = parseArguments(argv);
  let releaseStateStore = null;
  try {
    if (options.namespace !== null) {
      releaseStateStore = await createLiveReleaseStateStore(options.namespace);
    }
    const { manifest, resolution } = await resolveRepositoryPhaseExitReadiness({
      releaseStateStore,
      externalAuthorityBundleSha256: options.externalAuthorityBundleSha256,
      currentWorkflowRunId:
        options.externalAuthorityBundleSha256 === null
          ? null
          : requireEnvironment("GITHUB_RUN_ID"),
    });
    const report = buildPhaseExitReadiness({ manifest, resolution });
    const bytes = canonicalJsonBytes(report);
    if (options.output !== null) {
      const handle = await open(path.resolve(options.output), "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else if (options.json) {
      process.stdout.write(`${bytes.toString("utf8")}\n`);
    } else {
      process.stdout.write(
        `REPORT phase exit readiness: ${report.summary.completed}/${report.summary.total}; ` +
          `${report.productionActivationReady ? "ready" : "blocked"}; ` +
          `next ${report.summary.nextExit ?? "none"}\n`,
      );
    }
    const requiredExit =
      options.requireExit === null
        ? null
        : report.exits.find(({ gate }) => gate === options.requireExit);
    if (
      (options.requireAll && !report.productionActivationReady) ||
      (requiredExit !== null && requiredExit.status !== "complete")
    ) {
      throw new Error("Required formal phase exit is incomplete");
    }
    return report;
  } finally {
    await releaseStateStore?.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runPhaseExitReadinessCli();
