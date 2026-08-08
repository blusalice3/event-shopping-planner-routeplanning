#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import {
  deployVerifiedPrebuilt,
  repositoryRoot,
} from "./prebuiltDeployment.mjs";

const REQUIRED_FLAGS = Object.freeze([
  "--package",
  "--role",
  "--provider-observation",
  "--idempotency-key",
  "--receipt",
]);
const ROLE_VALUES = new Set(["standard", "containment"]);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export const parseDeployPrebuiltCliArguments = (arguments_) => {
  if (arguments_.length !== REQUIRED_FLAGS.length * 2) {
    throw new Error("Prebuilt deploy requires the exact five flag/value pairs");
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !REQUIRED_FLAGS.includes(flag) ||
      Object.prototype.hasOwnProperty.call(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid, duplicate, or missing CLI option: ${flag}`);
    }
    values[flag] = value;
  }
  for (const flag of REQUIRED_FLAGS) {
    if (!Object.prototype.hasOwnProperty.call(values, flag)) {
      throw new Error(`Missing required CLI option: ${flag}`);
    }
  }
  if (!ROLE_VALUES.has(values["--role"])) {
    throw new Error("--role must be standard or containment");
  }
  if (!IDEMPOTENCY_PATTERN.test(values["--idempotency-key"])) {
    throw new Error("--idempotency-key is invalid");
  }
  return {
    packageRoot: values["--package"],
    role: values["--role"],
    providerObservationPath: values["--provider-observation"],
    idempotencyKey: values["--idempotency-key"],
    receiptPath: values["--receipt"],
  };
};

export const resolveDeployPrebuiltCliPaths = async (parsed) => {
  const resolved = {
    ...parsed,
    packageRoot: path.resolve(parsed.packageRoot),
    providerObservationPath: path.resolve(parsed.providerObservationPath),
    receiptPath: path.resolve(parsed.receiptPath),
  };
  const pathIdentity = (value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (
    new Set([
      pathIdentity(resolved.packageRoot),
      pathIdentity(resolved.providerObservationPath),
      pathIdentity(resolved.receiptPath),
    ]).size !== 3
  ) {
    throw new Error("Package, observation, and receipt paths must be distinct");
  }
  return resolved;
};

export const runDeployPrebuiltCli = async (arguments_) => {
  const parsed = await resolveDeployPrebuiltCliPaths(
    parseDeployPrebuiltCliArguments(arguments_),
  );
  const [
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    dbContract,
    cspPolicy,
    providerObservation,
  ] = await Promise.all([
    readJsonStrict(
      path.join(repositoryRoot, "config", "release-variants.json"),
    ),
    readJsonStrict(
      path.join(repositoryRoot, "config", "toolchain-versions.json"),
    ),
    readJsonStrict(path.join(repositoryRoot, "config", "provider-policy.json")),
    readJsonStrict(
      path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
    ),
    readJsonStrict(path.join(repositoryRoot, "config", "csp-policy.json")),
    readJsonStrict(parsed.providerObservationPath),
  ]);

  const result = await deployVerifiedPrebuilt({
    packageRoot: parsed.packageRoot,
    role: parsed.role,
    providerObservation,
    idempotencyKey: parsed.idempotencyKey,
    receiptPath: parsed.receiptPath,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    dbContract,
    cspPolicy,
  });
  process.stdout.write(
    `PASS prebuilt deployment ${result.receipt.releaseRole} ${result.receipt.deployment.id} receipt ${result.receiptSha256}\n`,
  );
  return result;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await runDeployPrebuiltCli(process.argv.slice(2));
}
