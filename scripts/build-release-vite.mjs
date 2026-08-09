import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  buildIndependentOuterAgent,
  buildPwaRecoveryIdentity,
} from "./build-pwa-recovery-agent.mjs";
import { readJsonStrict, sha256Json } from "./lib/canonical-json.mjs";
import {
  bindReleaseBuildLauncher,
  POLICY_ACTIVATION_QA_BUILD_PURPOSE,
  RELEASE_BUILD_PURPOSE_ENV,
  resolveReleaseBuildInput,
} from "./lib/release-build-input.mjs";
import {
  OUTER_AGENT_BUNDLE_ENV,
  OUTER_AGENT_GRAPH_ENV,
  parseIndependentOuterAgentGraph,
} from "./lib/outer-agent-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};
const cliRole = argument("--role");
if (cliRole !== null && cliRole !== "standard" && cliRole !== "containment") {
  throw new Error("--role must be standard or containment");
}
const qaProfile = argument("--qa-profile");
if (process.argv.includes("--qa-profile") && qaProfile === null) {
  throw new Error("--qa-profile requires xlsx-main or list-force-full");
}
if (
  qaProfile !== null &&
  qaProfile !== "xlsx-main" &&
  qaProfile !== "list-force-full"
) {
  throw new Error("--qa-profile must be xlsx-main or list-force-full");
}
const reviewedRequirementsSha256 =
  process.env.FOUNDATION_ARTIFACT_BUILD_REQUIREMENTS_SHA256 ?? null;
const reviewedPolicyQaLaunch =
  qaProfile === null &&
  process.env[RELEASE_BUILD_PURPOSE_ENV] ===
    POLICY_ACTIVATION_QA_BUILD_PURPOSE &&
  typeof reviewedRequirementsSha256 === "string" &&
  /^[0-9a-f]{64}$/.test(reviewedRequirementsSha256);
const cliBuildPurpose =
  qaProfile !== null
    ? `qa-${qaProfile}`
    : reviewedPolicyQaLaunch
      ? POLICY_ACTIVATION_QA_BUILD_PURPOSE
      : "production";
if (
  qaProfile !== null &&
  cliBuildPurpose !== POLICY_ACTIVATION_QA_BUILD_PURPOSE &&
  cliRole === "containment"
) {
  throw new Error("Nonproduction QA profiles require the standard role");
}
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
})
  .trim()
  .toLowerCase();
if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
  throw new Error("Unable to resolve a full source SHA");
}
const sourceState =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim().length === 0
    ? "clean"
    : "dirty";

const [releasePolicy, dbContract] = await Promise.all([
  readJsonStrict(path.join(repositoryRoot, "config", "release-variants.json")),
  readJsonStrict(
    path.join(repositoryRoot, "config", "db-compatibility-contract.json"),
  ),
]);
const dbFingerprint = sha256Json(dbContract);
const providerCommitSha =
  process.env.VERCEL === "1" &&
  /^[0-9a-f]{40}$/i.test(process.env.VERCEL_GIT_COMMIT_SHA ?? "")
    ? process.env.VERCEL_GIT_COMMIT_SHA.toLowerCase()
    : null;
const buildInput = resolveReleaseBuildInput({
  policy: releasePolicy,
  environment: process.env,
  gitSourceSha: sourceSha,
  gitSourceState: sourceState,
  providerCommitSha,
  cliRole,
  cliBuildPurpose,
  defaultDbFingerprint: dbFingerprint,
  requireClean: process.argv.includes("--require-clean"),
  requireCliForNonProduction: true,
});

Object.assign(process.env, bindReleaseBuildLauncher(buildInput, releasePolicy));

const suppliedOuterAgentPath = process.env[OUTER_AGENT_BUNDLE_ENV] ?? null;
const suppliedOuterGraphPath = process.env[OUTER_AGENT_GRAPH_ENV] ?? null;
if ((suppliedOuterAgentPath === null) !== (suppliedOuterGraphPath === null)) {
  throw new Error(
    "Independent outer agent bundle and graph must be supplied together",
  );
}
let temporaryOuterRoot = null;
let outerAgentPath = suppliedOuterAgentPath;
let outerGraphPath = suppliedOuterGraphPath;
if (outerAgentPath === null || outerGraphPath === null) {
  temporaryOuterRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-independent-outer-"),
  );
  const builtOuter = await buildIndependentOuterAgent({
    outputDirectory: temporaryOuterRoot,
    sourceSha: buildInput.sourceSha,
  });
  outerAgentPath = builtOuter.outerAgentPath;
  outerGraphPath = builtOuter.graphPath;
} else {
  const [outerAgentBytes, graphBytes] = await Promise.all([
    readFile(path.resolve(outerAgentPath)),
    readFile(path.resolve(outerGraphPath)),
  ]);
  parseIndependentOuterAgentGraph({
    graphBytes,
    sourceSha: buildInput.sourceSha,
    outerAgentBytes,
  });
}
process.env[OUTER_AGENT_BUNDLE_ENV] = path.resolve(outerAgentPath);
process.env[OUTER_AGENT_GRAPH_ENV] = path.resolve(outerGraphPath);

let result;
try {
  await build({
    root: repositoryRoot,
    mode: "release-a",
  });
  result = await buildPwaRecoveryIdentity({
    distDirectory: path.join(repositoryRoot, "dist"),
    sourceSha: buildInput.sourceSha,
    releaseRole: buildInput.releaseRole,
    dimensions: buildInput.dimensions,
    variantId: buildInput.variantId,
    dbFingerprint: buildInput.dbFingerprint,
    buildPurpose: buildInput.buildPurpose,
    nonPromotable: buildInput.nonPromotable,
  });
} finally {
  if (temporaryOuterRoot !== null) {
    await rm(temporaryOuterRoot, { recursive: true, force: true });
  }
}
if (
  result.identity.sourceSha !== buildInput.sourceSha ||
  result.identity.releaseRole !== buildInput.releaseRole ||
  result.identity.variantId !== buildInput.variantId ||
  (result.identity.nonPromotable === true) !== buildInput.nonPromotable ||
  (result.identity.buildPurpose ?? "production") !== buildInput.buildPurpose ||
  sha256Json(result.dimensions) !== sha256Json(buildInput.dimensions)
) {
  throw new Error("Built release identity differs from canonical build input");
}
process.stdout.write(
  `Built ${buildInput.buildPurpose} ${buildInput.releaseRole} release ${buildInput.sourceSha}/${result.identity.variantId}; ` +
    `identity ${result.identitySha256}; source ${buildInput.sourceState}.\n`,
);
