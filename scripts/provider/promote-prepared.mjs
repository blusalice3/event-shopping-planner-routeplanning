#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import {
  promotePreparedOperation,
  repositoryRoot,
} from "./preparedPromotion.mjs";

const REQUIRED_FLAGS = ["--prepared-result", "--receipt"];
const MAX_PREPARED_RESULT_BYTES = 4 * 1024 * 1024;

export const parsePromotePreparedCliArguments = (arguments_) => {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length !== REQUIRED_FLAGS.length * 2
  ) {
    throw new Error(
      "Prepared promotion requires exactly --prepared-result and --receipt",
    );
  }
  const values = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !REQUIRED_FLAGS.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid, duplicate, or forbidden prepared promotion option: ${String(flag)}`,
      );
    }
    values[flag] = value;
  }
  if (Object.keys(values).length !== REQUIRED_FLAGS.length) {
    throw new Error("Prepared promotion CLI options are incomplete");
  }
  return {
    preparedResultPath: values["--prepared-result"],
    receiptPath: values["--receipt"],
  };
};

export const resolvePromotePreparedCliPaths = (
  parsed,
  workingDirectory = process.cwd(),
) => {
  const resolved = {
    preparedResultPath: path.resolve(
      workingDirectory,
      parsed.preparedResultPath,
    ),
    receiptPath: path.resolve(workingDirectory, parsed.receiptPath),
  };
  const pathIdentity = (value) =>
    process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
  if (
    pathIdentity(resolved.preparedResultPath) ===
    pathIdentity(resolved.receiptPath)
  ) {
    throw new Error(
      "Prepared promotion result and receipt paths must be distinct",
    );
  }
  return resolved;
};

const readPreparedResult = async (preparedResultPath, readFileImpl) => {
  const metadata = await lstat(preparedResultPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size === 0 ||
    metadata.size > MAX_PREPARED_RESULT_BYTES
  ) {
    throw new Error("Prepared promotion result path, type, or size is invalid");
  }
  const bytes = await readFileImpl(preparedResultPath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length !== metadata.size ||
    bytes.length === 0 ||
    bytes.length > MAX_PREPARED_RESULT_BYTES
  ) {
    throw new Error("Prepared promotion result changed while being read");
  }
  return bytes;
};

export const runPromotePreparedCli = async (
  arguments_,
  {
    workingDirectory = process.cwd(),
    environment = process.env,
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    readFileImpl = readFile,
    promote = promotePreparedOperation,
  } = {},
) => {
  const paths = resolvePromotePreparedCliPaths(
    parsePromotePreparedCliArguments(arguments_),
    workingDirectory,
  );
  const [preparedResultBytes, providerPolicy, toolchainPolicy] =
    await Promise.all([
      readPreparedResult(paths.preparedResultPath, readFileImpl),
      loadJson(path.join(repositoryRoot, "config", "provider-policy.json")),
      loadJson(path.join(repositoryRoot, "config", "toolchain-versions.json")),
    ]);
  const result = await promote({
    preparedResultBytes,
    receiptPath: paths.receiptPath,
    providerPolicy,
    toolchainPolicy,
    root: repositoryRoot,
    environment,
  });
  stdout.write(
    `PASS prepared promotion ${result.receipt.outcome} receipt ${result.receiptSha256}\n`,
  );
  return result;
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await runPromotePreparedCli(process.argv.slice(2));
}
