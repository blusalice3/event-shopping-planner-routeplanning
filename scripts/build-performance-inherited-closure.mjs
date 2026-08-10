#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalPerformanceInheritedClosureBytes,
  buildPerformanceInheritedClosure,
} from "./lib/performance-inherited-closure.mjs";
import { resolveAuthoritativePerformanceClosureEntries } from "./lib/performance-inherited-closure-authority.mjs";
import { readJsonStrict, sha256Bytes } from "./lib/canonical-json.mjs";
import { createPostgresReleaseStateStore } from "./release-state/postgresStore.mjs";
import { verifyPerformancePolicy } from "./verify-performance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FLAG_TO_GATE = Object.freeze({
  "--p0-accepted-event-sha256": "P0-TOOLCHAIN",
  "--p3-accepted-event-sha256": "P3-XLSX",
  "--p5d-accepted-event-sha256": "P5-DUAL",
  "--p5e-accepted-event-sha256": "P5-LIST",
});
const ARGUMENT_NAMES = new Set([
  "--closure-id",
  "--namespace",
  "--output",
  ...Object.keys(FLAG_TO_GATE),
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const usage =
  "Usage: build-performance-inherited-closure.mjs " +
  "--namespace <release-state-namespace> --closure-id <id> " +
  "--p0-accepted-event-sha256 <sha256> " +
  "--p3-accepted-event-sha256 <sha256> " +
  "--p5d-accepted-event-sha256 <sha256> " +
  "--p5e-accepted-event-sha256 <sha256> --output <new-json-file>";

export const parsePerformanceInheritedClosureArguments = (arguments_) => {
  const values = Object.fromEntries(
    [...ARGUMENT_NAMES].map((argument) => [argument, null]),
  );
  const seen = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!ARGUMENT_NAMES.has(argument)) {
      throw new Error(`Unknown performance closure argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      ARGUMENT_NAMES.has(value) ||
      seen.has(argument)
    ) {
      throw new Error(`Performance closure argument ${argument} is invalid`);
    }
    values[argument] = value;
    seen.add(argument);
    index += 1;
  }
  if ([...ARGUMENT_NAMES].some((argument) => values[argument] === null)) {
    throw new Error(usage);
  }
  if (
    !/^[a-z0-9][a-z0-9-]{2,62}$/.test(values["--namespace"]) ||
    !/^perf-closure-[a-z0-9][a-z0-9._-]{7,111}$/.test(values["--closure-id"])
  ) {
    throw new Error("Performance closure namespace or ID is invalid");
  }
  const acceptedEventSha256ByGate = Object.fromEntries(
    Object.entries(FLAG_TO_GATE).map(([flag, gate]) => {
      if (!SHA256_PATTERN.test(values[flag])) {
        throw new Error(`${gate}: accepted event SHA-256 is invalid`);
      }
      return [gate, values[flag]];
    }),
  );
  if (new Set(Object.values(acceptedEventSha256ByGate)).size !== 4) {
    throw new Error(
      "Historical accepted event SHA-256 values must be distinct",
    );
  }
  return {
    namespace: values["--namespace"],
    closureId: values["--closure-id"],
    outputPath: values["--output"],
    acceptedEventSha256ByGate,
  };
};

const requireEnvironment = (environment, name) => {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required performance closure environment is absent: ${name}`,
    );
  }
  return value;
};

const assertOutputAvailable = async (outputPath, lstatImpl) => {
  try {
    await lstatImpl(outputPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Performance closure output already exists");
};

const execGit = (arguments_, options = {}) =>
  execFileSync("git", arguments_, {
    cwd: root,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

const resolveCleanP8Source = async ({ environment }) => {
  const packageJson = await readJsonStrict(path.join(root, "package.json"));
  if (process.versions.node !== packageJson.engines.node) {
    throw new Error(
      `Performance closure requires Node ${packageJson.engines.node}; received ${process.versions.node}`,
    );
  }
  if (
    execGit(["status", "--porcelain", "--untracked-files=all"]).trim() !== ""
  ) {
    throw new Error("Performance closure requires a clean Git tree");
  }
  const gitCommitSha = execGit(["rev-parse", "HEAD"]).trim();
  if (requireEnvironment(environment, "GITHUB_SHA") !== gitCommitSha) {
    throw new Error(
      "Performance closure workflow source differs from clean HEAD",
    );
  }
  const treeBytes = execGit(
    ["ls-tree", "-r", "-z", "--full-tree", gitCommitSha],
    { encoding: null },
  );
  return {
    gitCommitSha,
    sourceClosureSha256: sha256Bytes(treeBytes),
    treeState: "clean",
  };
};

const createBoundStore = async ({
  environment,
  namespace,
  storePolicy,
  createStore,
}) => {
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  return createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

export const runPerformanceInheritedClosureCli = async (
  {
    arguments_ = process.argv.slice(2),
    environment = process.env,
    workingDirectory = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    lstatImpl = lstat,
    writeFileImpl = writeFile,
    loadJson = readJsonStrict,
    verifyPolicy = verifyPerformancePolicy,
    createStore = createPostgresReleaseStateStore,
    resolveP8Source = resolveCleanP8Source,
    resolveEntries = resolveAuthoritativePerformanceClosureEntries,
    buildClosure = buildPerformanceInheritedClosure,
    clock = Date.now,
  } = {},
) => {
  const parsed = parsePerformanceInheritedClosureArguments(arguments_);
  const outputPath = path.resolve(workingDirectory, parsed.outputPath);
  await assertOutputAvailable(outputPath, lstatImpl);
  const [storePolicy, approvalPolicy, releasePolicy, context, p8Source] =
    await Promise.all([
      loadJson(path.join(root, "config", "release-state-store.json")),
      loadJson(path.join(root, "config", "approval-policy.json")),
      loadJson(path.join(root, "config", "release-variants.json")),
      verifyPolicy({ root }),
      resolveP8Source({ environment }),
    ]);
  const nowMilliseconds = clock();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new Error("Performance closure clock is invalid");
  }
  const store = await createBoundStore({
    environment,
    namespace: parsed.namespace,
    storePolicy,
    createStore,
  });
  try {
    const { entries } = await resolveEntries({
      store,
      acceptedEventSha256ByGate: parsed.acceptedEventSha256ByGate,
      approvalPolicy,
    });
    const envelope = buildClosure({
      context,
      releasePolicy,
      closureId: parsed.closureId,
      createdAtUtc: new Date(nowMilliseconds).toISOString(),
      p8Source,
      entries,
    });
    const bytes = canonicalPerformanceInheritedClosureBytes(envelope);
    await writeFileImpl(outputPath, bytes, { flag: "wx", mode: 0o600 });
    stdout.write(`PASS performance inherited closure: ${sha256Bytes(bytes)}\n`);
    return { envelope, bytes, sha256: sha256Bytes(bytes), outputPath };
  } finally {
    await store.close();
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPerformanceInheritedClosureCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
