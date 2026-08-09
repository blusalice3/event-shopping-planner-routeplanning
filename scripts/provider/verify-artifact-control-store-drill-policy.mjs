#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseJsonStrict } from "../lib/canonical-json.mjs";
import { verifyArtifactControlStoreDrillPolicy } from "../lib/artifact-control-store-drill-policy.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const readPolicy = async () => {
  const bytes = await readFile(
    path.join(root, "config", "artifact-control-store-drill.json"),
  );
  return parseJsonStrict(bytes.toString("utf8"), "Artifact drill policy");
};

export const runArtifactControlStoreDrillPolicyVerifier = async (
  { argv = process.argv.slice(2), stdout = process.stdout } = {},
  { loadPolicy = readPolicy } = {},
) => {
  if (
    !Array.isArray(argv) ||
    !(
      argv.length === 0 ||
      (argv.length === 1 && argv[0] === "--require-configured")
    )
  ) {
    throw new Error(
      "Usage: verify-artifact-control-store-drill-policy.mjs [--require-configured]",
    );
  }
  const report = verifyArtifactControlStoreDrillPolicy(await loadPolicy());
  if (argv[0] === "--require-configured" && !report.configured) {
    throw new Error(
      `Artifact drill policy is not configured: ${report.blockerCodes.join(", ")}`,
    );
  }
  stdout.write(
    `PASS artifact control-store drill policy: ${report.bindingStatus}; blockers ${report.blockerCodes.length}\n`,
  );
  return report;
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runArtifactControlStoreDrillPolicyVerifier();
