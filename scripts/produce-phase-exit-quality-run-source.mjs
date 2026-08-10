import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "./lib/canonical-json.mjs";

export const QUALITY_RUN_SOURCE_FILE_NAME = "quality-run-source.json";
export const QUALITY_RUN_SOURCE_ARTIFACT_PREFIX =
  "foundation-phase-exit-quality-";

const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const RUN_ATTEMPT_PATTERN = /^[1-9][0-9]{0,9}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const QUALITY_WORKFLOW_PATH = ".github/workflows/quality.yml";
const QUALITY_CHECKS = Object.freeze([
  "api",
  "architecture",
  "artifact",
  "audit",
  "browser",
  "coverage",
  "dependency-usage",
  "encoding",
  "format",
  "foundation",
  "integration",
  "lint",
  "typecheck",
  "unit",
  "worker",
]);

const requireEnvironment = (env, name, pattern = null) => {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (pattern !== null && !pattern.test(value))
  ) {
    throw new Error(`Quality run source environment is invalid: ${name}`);
  }
  return value;
};

const parseArguments = (argv) => {
  if (
    argv.length !== 2 ||
    argv[0] !== "--output" ||
    typeof argv[1] !== "string" ||
    argv[1].length === 0
  ) {
    throw new Error("Quality run source requires exactly --output <file>");
  }
  return { outputPath: path.resolve(argv[1]) };
};

export const buildPhaseExitQualityRunSource = ({
  env,
  now = Date.now,
  nodeVersion = process.versions.node,
  npmVersion,
}) => {
  const repository = requireEnvironment(
    env,
    "GITHUB_REPOSITORY",
    REPOSITORY_PATTERN,
  );
  const sourceSha = requireEnvironment(env, "GITHUB_SHA", SOURCE_SHA_PATTERN);
  const workflowRunId = requireEnvironment(
    env,
    "GITHUB_RUN_ID",
    RUN_ID_PATTERN,
  );
  const workflowRunAttempt = requireEnvironment(
    env,
    "GITHUB_RUN_ATTEMPT",
    RUN_ATTEMPT_PATTERN,
  );
  const workflowRef = requireEnvironment(env, "GITHUB_WORKFLOW_REF");
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    workflowRef !== `${repository}/${QUALITY_WORKFLOW_PATH}@refs/heads/main` ||
    nodeVersion !== "24.19.0" ||
    npmVersion !== "11.19.0"
  ) {
    throw new Error("Quality run source is not the exact protected main run");
  }
  const observedAtMilliseconds = Number(now());
  if (!Number.isFinite(observedAtMilliseconds)) {
    throw new Error("Quality run source clock is invalid");
  }
  return {
    schemaVersion: 1,
    kind: "phase-exit-quality-run-source/v1",
    repository,
    workflowPath: QUALITY_WORKFLOW_PATH,
    workflowRunId,
    workflowRunAttempt,
    event: "push",
    headBranch: "main",
    headSha: sourceSha,
    observedAt: new Date(observedAtMilliseconds).toISOString(),
    nodeVersion,
    npmVersion,
    checks: [...QUALITY_CHECKS],
  };
};

export const runPhaseExitQualityRunSourceCli = async ({
  argv = process.argv.slice(2),
  env = process.env,
  now = Date.now,
  npmVersion = execFileSync("npm", ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim(),
} = {}) => {
  const { outputPath } = parseArguments(argv);
  const value = buildPhaseExitQualityRunSource({ env, now, npmVersion });
  const bytes = canonicalJsonBytes(value);
  await writeFile(outputPath, bytes, { flag: "wx" });
  const readback = await readFile(outputPath);
  const parsed = parseJsonStrict(
    readback.toString("utf8"),
    "Quality run source readback",
  );
  if (!readback.equals(bytes) || !canonicalJsonBytes(parsed).equals(bytes)) {
    throw new Error("Quality run source output readback differs");
  }
  const result = {
    artifactName:
      `${QUALITY_RUN_SOURCE_ARTIFACT_PREFIX}${value.headSha}-` +
      value.workflowRunAttempt,
    fileName: QUALITY_RUN_SOURCE_FILE_NAME,
    sha256: sha256Bytes(bytes),
    byteLength: bytes.length,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runPhaseExitQualityRunSourceCli();
