#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import {
  canonicalize,
  fail,
  projectRoot,
  readJson,
  sha256,
  utf8Compare,
  writeJson,
} from "./foundation-policy-utils.mjs";

const writeBaseline = process.argv.includes("--write-baseline");
const baselinePath = "config/foundation-baseline.json";
const measurementSourceSha = "638dc0d2b05a09da9ea09e3f25e00bb36e1b2994";
const implementationTreeBaselineSha =
  "806794df6222053235139e7ef6684f4aa6538b3d";
// Baseline evidence is historical. Reproduce its policy snapshot from the
// clean commit that recorded it instead of rebinding it to mutable policies.
const baselinePolicyEvidenceSourceSha =
  "4de2708817236550fe7570db78239b4d7389b707";
const policyPaths = [
  "config/architecture-baseline.json",
  "config/architecture-policy.json",
  "config/audit-waivers.json",
  "config/coverage-policy.json",
  "config/encoding-policy.json",
  "config/performance-budgets.json",
  "config/test-project-membership.json",
  "config/toolchain-versions.json",
  "config/ui-scenarios.json",
];
const errors = [];

const git = (args, options = {}) =>
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: options.encoding ?? null,
    maxBuffer: 128 * 1024 * 1024,
  });

const verifyCommit = (sha, label) => {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
  } catch {
    errors.push(`${label}: commit ${sha} is not available`);
  }
};

const buildInputPath = (file) =>
  file === "index.html" ||
  file === "package-lock.json" ||
  file === "package.json" ||
  file === "pwa-assets.config.ts" ||
  file === "tsconfig.json" ||
  file === "tsconfig.node.json" ||
  file === "vercel.json" ||
  file === "vite.config.ts" ||
  file.startsWith("api/") ||
  file.startsWith("public/") ||
  file.startsWith("src/") ||
  file === "scripts/verify-release-a-build.mjs";

const readGitFile = (sha, file) => git(["show", `${sha}:${file}`]);

const readGitJson = (sha, file) =>
  JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(readGitFile(sha, file)),
  );

const calculateBuildInputClosure = (sha) => {
  const treeBytes = git(["ls-tree", "-r", "--name-only", "-z", sha]);
  const files = new TextDecoder("utf-8", { fatal: true })
    .decode(treeBytes)
    .split("\0")
    .filter((file) => file.length > 0 && buildInputPath(file))
    .sort(utf8Compare);
  const entries = files.map((file) => {
    const bytes = readGitFile(sha, file);
    return {
      path: file,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    };
  });
  return {
    algorithm: "sha256-jcs-path-byteLength-fileSha256-v1",
    fileCount: entries.length,
    sha256: sha256(canonicalize(entries)),
  };
};

const projectPhase0UiScenarioPolicy = (policy) => ({
  schemaVersion: 1,
  scenarios: policy.scenarios
    .filter(({ introducedAtGate }) => introducedAtGate === "P0-BASELINE")
    .map(
      ({
        id,
        kind,
        fixtureRef,
        fixtureSha256,
        introducedAtGate,
        requiredFromExit,
      }) => ({
        id,
        kind,
        fixtureRef,
        fixtureSha256,
        introducedAtGate,
        requiredFromExit,
      }),
    ),
});

const projectPhase0PerformancePolicy = (policy) => ({
  schemaVersion: 1,
  measurementSourceSha: policy.measurementSourceSha,
  machineProfile: policy.machineProfile,
  browser: policy.browser,
  sampleCount: policy.sampleCount,
  statistics: policy.statistics,
  scenarios: policy.scenarios
    .filter(({ id }) => id.startsWith("foundation-"))
    .map(
      ({ id, measurement, absoluteCeilingMs, regressionCeilingPercent }) => ({
        id,
        measurement,
        absoluteCeilingMs,
        regressionCeilingPercent,
      }),
    ),
  blockers: policy.blockers
    .filter(({ blocksExit }) => blocksExit === "P0-TOOLCHAIN")
    .map(({ id, reason, blocksExit }) => ({ id, reason, blocksExit })),
});

const projectPhase0Policy = (policyPath, policy) => {
  if (policyPath === "config/ui-scenarios.json") {
    return projectPhase0UiScenarioPolicy(policy);
  }
  if (policyPath === "config/performance-budgets.json") {
    return projectPhase0PerformancePolicy(policy);
  }
  return policy;
};

const calculatePolicyHashes = async () =>
  Object.fromEntries(
    policyPaths.map((policyPath) => {
      const policy = readGitJson(baselinePolicyEvidenceSourceSha, policyPath);
      return [
        policyPath,
        sha256(canonicalize(projectPhase0Policy(policyPath, policy))),
      ];
    }),
  );

const verifyScenarioFixtures = async () => {
  const scenarios = readGitJson(
    baselinePolicyEvidenceSourceSha,
    "config/ui-scenarios.json",
  );
  if (scenarios.baselineFixtureSourceSha !== measurementSourceSha) {
    errors.push("baselineFixtureSourceSha changed unexpectedly");
    return;
  }
  for (const scenario of scenarios.scenarios.filter(
    ({ introducedAtGate }) => introducedAtGate === "P0-BASELINE",
  )) {
    let bytes;
    try {
      bytes = readGitFile(measurementSourceSha, scenario.fixtureRef);
    } catch {
      errors.push(`${scenario.id}: fixture ${scenario.fixtureRef} is missing`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== scenario.fixtureSha256) {
      errors.push(
        `${scenario.id}: fixture hash ${actual} does not match ${scenario.fixtureSha256}`,
      );
    }
  }
};

verifyCommit(measurementSourceSha, "measurementSourceSha");
verifyCommit(implementationTreeBaselineSha, "implementationTreeBaselineSha");
verifyCommit(
  baselinePolicyEvidenceSourceSha,
  "baselinePolicyEvidenceSourceSha",
);

if (writeBaseline && errors.length === 0) {
  const buildInputClosure = calculateBuildInputClosure(measurementSourceSha);
  const lockfileSha256 = sha256(
    readGitFile(measurementSourceSha, "package-lock.json"),
  );
  const policyHashes = await calculatePolicyHashes();
  const commandResults = {
    encoding: {
      command: "npm run test:encoding",
      status: "pass",
      textFileCount: 328,
      representativeStrings: {
        エラーが発生しました: 6,
        ユーザー登録: 3,
      },
    },
    typecheck: {
      command: "npm run typecheck",
      status: "pass",
    },
    lint: {
      command: "npm run lint",
      status: "pass-with-baseline",
      errors: 0,
      warnings: 130,
    },
    tests: {
      command: "npm run test:run",
      status: "pass",
      files: 120,
      tests: 1198,
    },
    releaseABuild: {
      command: "npm run build:release-a",
      status: "pass",
    },
    auditAll: {
      command: "npm audit",
      status: "blocking",
      critical: 1,
      high: 19,
      moderate: 8,
      low: 1,
    },
    auditProduction: {
      command: "npm audit --omit=dev",
      status: "blocking",
      critical: 0,
      high: 4,
      moderate: 2,
      low: 0,
    },
  };
  const baselineEvidence = {
    measurementSourceSha,
    sourceState: "clean",
    runtime: {
      node: "20.20.0",
      npm: "10.8.2",
    },
    lockfileSha256,
    buildInputClosure,
    policyHashes,
    commandEvidenceHash: sha256(canonicalize(commandResults)),
    commandResults,
    artifactObservation: {
      authority: "local-reference-only",
      mainJavaScriptBytes: 941325,
      xlsxParserBytes: 974780,
      precacheEntries: 19,
      precacheKiB: 3085.67,
      rawDistManifestSha256: null,
    },
    moduleObservation: {
      supabaseBrowserImporters: 0,
      inlineJsxStyleCount: 101,
    },
  };
  await writeJson(baselinePath, {
    schemaVersion: 1,
    implementationTreeBaselineSha,
    measurementSourceSha,
    bootstrapBaselineSourceSha: null,
    baselineEvidence,
    baselineEvidenceSha256: sha256(canonicalize(baselineEvidence)),
    externalBindings: {
      providerProduction: {
        status: "unknown",
        projectId: null,
        deploymentId: null,
        sourceSha: null,
        domains: [],
        environmentName: null,
      },
      metricsDatabase: {
        status: "unknown",
        projectRef: null,
        fingerprint: null,
        backupOwner: null,
        restoreOwner: null,
      },
      releaseStateDatabase: {
        status: "not-provisioned",
        namespace: null,
        credentialOwner: null,
        backupOwner: null,
        restoreOwner: null,
      },
    },
    blockers: [
      {
        id: "P0-PROVIDER-BINDING",
        blocks: ["P0-BASELINE", "P0-PROMOTE"],
        reason:
          "Production project, deployment, source, domains, and environment have not been observed through the provider API.",
      },
      {
        id: "P0-BOOTSTRAP-BASELINE",
        blocks: ["P0-BASELINE", "P0-PROMOTE"],
        reason:
          "No provider-bound bootstrapBaselineSourceSha, raw-dist manifest, or recovery rehearsal evidence is available.",
      },
      {
        id: "P0-RELEASE-STATE-STORE",
        blocks: ["P0-BASELINE", "P0-ARTIFACT"],
        reason:
          "The protected PostgreSQL control store, namespace roles, credentials, and backup/restore owners are not provisioned.",
      },
      {
        id: "P0-DATABASE-BINDING",
        blocks: ["P0-BASELINE", "P0-DATA"],
        reason:
          "The production metrics database schema, privilege state, project reference, and backup/PITR ownership are not remotely observed.",
      },
    ],
  });
  process.stdout.write(`WROTE ${baselinePath}\n`);
} else if (!writeBaseline && errors.length === 0) {
  const baseline = await readJson(baselinePath);
  const recordedBaseline = readGitJson(
    baselinePolicyEvidenceSourceSha,
    baselinePath,
  );
  if (
    sha256(canonicalize(baseline.baselineEvidence)) !==
    sha256(canonicalize(recordedBaseline.baselineEvidence))
  ) {
    errors.push("historical baseline evidence differs from its clean source");
  }
  if (
    baseline.implementationTreeBaselineSha !== implementationTreeBaselineSha
  ) {
    errors.push("implementationTreeBaselineSha changed unexpectedly");
  }
  if (baseline.measurementSourceSha !== measurementSourceSha) {
    errors.push("measurementSourceSha changed unexpectedly");
  }
  const closure = calculateBuildInputClosure(baseline.measurementSourceSha);
  if (
    JSON.stringify(closure) !==
    JSON.stringify(baseline.baselineEvidence.buildInputClosure)
  ) {
    errors.push("build input closure is not reproducible");
  }
  const lockfileSha256 = sha256(
    readGitFile(baseline.measurementSourceSha, "package-lock.json"),
  );
  if (lockfileSha256 !== baseline.baselineEvidence.lockfileSha256) {
    errors.push("baseline lockfile hash is not reproducible");
  }
  const policyHashes = await calculatePolicyHashes();
  for (const [policyPath, hash] of Object.entries(policyHashes)) {
    if (baseline.baselineEvidence.policyHashes[policyPath] !== hash) {
      errors.push(`${policyPath}: policy hash differs from baseline`);
    }
  }
  const commandHash = sha256(
    canonicalize(baseline.baselineEvidence.commandResults),
  );
  if (commandHash !== baseline.baselineEvidence.commandEvidenceHash) {
    errors.push("command evidence hash is invalid");
  }
  if (
    sha256(canonicalize(baseline.baselineEvidence)) !==
    baseline.baselineEvidenceSha256
  ) {
    errors.push("baseline evidence object hash is invalid");
  }
  if (
    baseline.bootstrapBaselineSourceSha === null &&
    !baseline.blockers.some(({ id }) => id === "P0-BOOTSTRAP-BASELINE")
  ) {
    errors.push("missing bootstrap baseline must have an explicit blocker");
  }
  for (const binding of Object.values(baseline.externalBindings)) {
    if (binding.status !== "verified" && baseline.blockers.length === 0) {
      errors.push("unknown external binding is not represented by a blocker");
    }
  }
  await verifyScenarioFixtures();
}

if (errors.length > 0) {
  fail("FAIL foundation baseline verification", errors);
} else if (!writeBaseline) {
  const baseline = await readJson(baselinePath);
  process.stdout.write(
    `PASS foundation baseline: source ${baseline.measurementSourceSha}; evidence ${baseline.baselineEvidenceSha256}; ${baseline.blockers.length} explicit external blocker(s)\n`,
  );
}
