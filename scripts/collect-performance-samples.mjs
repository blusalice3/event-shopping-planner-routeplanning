#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalizeJson,
  parseJsonStrict,
  readJsonStrict,
  sha256Bytes,
} from "./lib/canonical-json.mjs";
import { assertArtifactManifest } from "./lib/artifact-contract.mjs";
import { computeVariantId } from "./lib/release-policy.mjs";
import { collectCanonicalPerformanceSamples } from "./lib/performance-sample-collector.mjs";
import { verifyDeterministicZip } from "./deterministic-zip.mjs";
import { REQUIRED_PERFORMANCE_VARIANTS } from "./performance/canonicalScenarioDispatch.mjs";
import { verifyPerformancePolicy } from "./verify-performance-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultAdapterPath = path.join(
  root,
  "scripts",
  "performance",
  "canonicalPlaywrightAdapters.mjs",
);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const argumentNames = new Set([
  "--adapter-module",
  "--artifact",
  "--artifact-manifest",
  "--environment",
  "--evidence-id",
  "--gate",
  "--output",
  "--target-url",
]);

export const parseArguments = (argv) => {
  const values = {
    "--adapter-module": null,
    "--artifact": null,
    "--artifact-manifest": null,
    "--environment": null,
    "--evidence-id": null,
    "--gate": null,
    "--output": null,
    "--target-url": null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argumentNames.has(argument)) {
      throw new Error(`Unknown performance collector argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || argumentNames.has(value) || seen.has(argument)) {
      throw new Error(`Performance collector argument ${argument} is invalid`);
    }
    seen.add(argument);
    values[argument] = value;
    index += 1;
  }
  for (const required of [
    "--artifact",
    "--artifact-manifest",
    "--environment",
    "--evidence-id",
    "--gate",
    "--output",
    "--target-url",
  ]) {
    if (values[required] === null) {
      throw new Error(
        "Usage: --gate <gate> --evidence-id <id> --artifact <archive> " +
          "--artifact-manifest <manifest.json> " +
          "--environment <binding.json> --target-url <url> --output <raw.json> " +
          "[--adapter-module <tracked-module.mjs>]",
      );
    }
  }
  return {
    adapterModule: values["--adapter-module"] ?? defaultAdapterPath,
    artifact: values["--artifact"],
    artifactManifest: values["--artifact-manifest"],
    environment: values["--environment"],
    evidenceId: values["--evidence-id"],
    gate: values["--gate"],
    output: values["--output"],
    targetUrl: values["--target-url"],
  };
};

const execGit = (arguments_, options = {}) =>
  execFileSync("git", arguments_, {
    cwd: root,
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });

const assertCleanExactSource = async () => {
  const packageJson = await readJsonStrict(path.join(root, "package.json"));
  if (process.versions.node !== packageJson.engines.node) {
    throw new Error(
      `Performance collection requires Node ${packageJson.engines.node}; received ${process.versions.node}`,
    );
  }
  const treeState = execGit([
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).trim();
  if (treeState !== "") {
    throw new Error("Performance collection requires a clean Git tree");
  }
  const gitCommitSha = execGit(["rev-parse", "HEAD"]).trim();
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

const resolveTrackedAdapter = async (adapterPath) => {
  const resolved = path.resolve(adapterPath);
  const relative = path.relative(root, resolved).replaceAll("\\", "/");
  if (
    relative === "" ||
    relative.startsWith("../") ||
    path.isAbsolute(relative) ||
    path.extname(relative) !== ".mjs"
  ) {
    throw new Error("Performance adapter must be a repository-local .mjs file");
  }
  try {
    execGit(["ls-files", "--error-unmatch", "--", relative]);
  } catch {
    throw new Error("Performance adapter must be tracked by the clean source");
  }
  const module = await import(`${pathToFileURL(resolved).href}?source=clean`);
  if (
    module.PERFORMANCE_ADAPTER_CONTRACT_VERSION !== 1 ||
    typeof module.scenarioAdapters !== "object" ||
    module.scenarioAdapters === null
  ) {
    throw new Error("Performance adapter module contract is invalid");
  }
  return module.scenarioAdapters;
};

const resolveFullVariant = (releasePolicy, gate) => {
  const dimensions = structuredClone(releasePolicy.initialStandard);
  if (gate !== "P0-TOOLCHAIN") {
    let found = false;
    for (const phase of releasePolicy.phaseSequence) {
      Object.assign(dimensions, phase.change);
      if (phase.gate === gate) {
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`${gate}: release variant phase is missing`);
    }
  }
  const required = REQUIRED_PERFORMANCE_VARIANTS[gate];
  if (
    !required ||
    Object.entries(required).some(([key, value]) => dimensions[key] !== value)
  ) {
    throw new Error(`${gate}: release variant differs from performance policy`);
  }
  return dimensions;
};

const detectMachineProfile = () => {
  const cpuModels = [
    ...new Set(
      os
        .cpus()
        .map(({ model }) => model.trim())
        .filter(Boolean),
    ),
  ];
  if (cpuModels.length !== 1) {
    throw new Error("Canonical machine CPU model is absent or heterogeneous");
  }
  const powerMode = process.env.FOUNDATION_PERFORMANCE_POWER_MODE;
  if (!powerMode) {
    throw new Error(
      "FOUNDATION_PERFORMANCE_POWER_MODE must identify the reviewed power mode",
    );
  }
  return {
    os: `${process.platform}-${os.release()}-${process.arch}`,
    cpu: cpuModels[0],
    memoryBytes: os.totalmem(),
    powerMode,
  };
};

const assertEnvironmentMatchesHost = ({ actualBrowser, environment }) => {
  const detectedMachine = detectMachineProfile();
  if (
    !environment ||
    !environment.machineProfile ||
    !environment.browser ||
    Object.entries(detectedMachine).some(
      ([key, value]) => environment.machineProfile[key] !== value,
    ) ||
    Object.keys(environment.machineProfile).length !==
      Object.keys(detectedMachine).length ||
    Object.keys(environment.browser).length !== 3 ||
    environment.browser.family !== "chromium" ||
    environment.browser.version !== actualBrowser.version ||
    environment.browser.channel !== actualBrowser.channel
  ) {
    throw new Error(
      "Detected machine/Chromium binding differs from the reviewed environment",
    );
  }
};

const assertTargetUrl = (value) => {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error(
      "Performance target must be HTTPS or an explicit loopback HTTP origin",
    );
  }
  return url.toString();
};

const verifyTargetIdentity = async ({
  browser,
  expectedSourceSha,
  expectedVariantId,
  releaseRole,
  targetUrl,
}) => {
  const browserContext = await browser.newContext();
  try {
    const identityUrl = new URL("/release-identity.json", targetUrl);
    const response = await browserContext.request.get(identityUrl.toString(), {
      failOnStatusCode: false,
      headers: { "cache-control": "no-cache" },
    });
    if (response.status() !== 200) {
      throw new Error(
        `Performance target identity returned HTTP ${response.status()}`,
      );
    }
    const identityBytes = await response.body();
    if (
      identityBytes.length >= 3 &&
      identityBytes[0] === 0xef &&
      identityBytes[1] === 0xbb &&
      identityBytes[2] === 0xbf
    ) {
      throw new Error("Performance target identity must not contain a BOM");
    }
    const identity = parseJsonStrict(UTF8_DECODER.decode(identityBytes));
    if (
      identity.schemaVersion !== 1 ||
      identity.sourceSha !== expectedSourceSha ||
      identity.buildId !== expectedSourceSha ||
      identity.variantId !== expectedVariantId ||
      identity.releaseRole !== releaseRole
    ) {
      throw new Error(
        "Performance target identity differs from source/release variant",
      );
    }
  } finally {
    await browserContext.close();
  }
};

export const verifyTargetArtifactAssets = async ({
  browser,
  manifest,
  targetUrl,
}) => {
  const staticFiles = manifest.outputFiles.filter(({ path: outputPath }) =>
    outputPath.startsWith("static/"),
  );
  if (staticFiles.length === 0) {
    throw new Error("Performance artifact contains no public static files");
  }
  const browserContext = await browser.newContext();
  try {
    for (const file of staticFiles) {
      const publicPath = `/${file.path.slice("static/".length)}`;
      const assetUrl = new URL(publicPath, targetUrl);
      const targetOrigin = new URL(targetUrl).origin;
      if (
        assetUrl.origin !== targetOrigin ||
        assetUrl.search !== "" ||
        assetUrl.hash !== "" ||
        assetUrl.pathname !== publicPath
      ) {
        throw new Error(
          `Performance target asset path is unsafe: ${file.path}`,
        );
      }
      const response = await browserContext.request.get(assetUrl.toString(), {
        failOnStatusCode: false,
        headers: { "cache-control": "no-cache" },
      });
      if (response.status() !== 200) {
        throw new Error(
          `Performance target asset ${publicPath} returned HTTP ${response.status()}`,
        );
      }
      const bytes = await response.body();
      if (bytes.length !== file.size || sha256Bytes(bytes) !== file.sha256) {
        throw new Error(
          `Performance target asset ${publicPath} differs from artifact bytes`,
        );
      }
    }
  } finally {
    await browserContext.close();
  }
};

const createFixtureLoader = (policyContext) => async (scenario) => {
  if (scenario.fixtureBinding === "current-policy-tree") {
    return readFile(path.join(root, scenario.fixtureRef));
  }
  if (scenario.introducedAtGate !== "P0-BASELINE") {
    throw new Error(`${scenario.id}: unsupported fixture binding`);
  }
  return execGit(
    [
      "show",
      `${policyContext.budgets.measurementSourceSha}:${scenario.fixtureRef}`,
    ],
    { encoding: null },
  );
};

export const main = async ({ argv = process.argv.slice(2) } = {}) => {
  const arguments_ = parseArguments(argv);
  const gate = arguments_.gate;
  if (!Object.hasOwn(REQUIRED_PERFORMANCE_VARIANTS, gate)) {
    throw new Error(`Unknown performance gate ${gate}`);
  }
  if (gate === "P8-CLEAN") {
    throw new Error(
      "P8-CLEAN inherited performance evidence must be built from accepted gate evidence; single-artifact collection is forbidden",
    );
  }
  const targetUrl = assertTargetUrl(arguments_.targetUrl);
  const [
    sourceState,
    artifactBytes,
    artifactManifest,
    environment,
    policyContext,
    releasePolicy,
  ] = await Promise.all([
    assertCleanExactSource(),
    readFile(path.resolve(arguments_.artifact)),
    readJsonStrict(path.resolve(arguments_.artifactManifest)),
    readJsonStrict(path.resolve(arguments_.environment)),
    verifyPerformancePolicy({ root }),
    readJsonStrict(path.join(root, "config", "release-variants.json")),
  ]);
  if (artifactBytes.length === 0) {
    throw new Error("Performance artifact is empty");
  }
  const fullVariant = resolveFullVariant(releasePolicy, gate);
  assertArtifactManifest(artifactManifest, releasePolicy);
  if (
    artifactManifest.sourceSha !== sourceState.gitCommitSha ||
    artifactManifest.buildId !== sourceState.gitCommitSha ||
    artifactManifest.releaseRole !==
      REQUIRED_PERFORMANCE_VARIANTS[gate].releaseRole ||
    Object.entries(fullVariant).some(
      ([key, value]) => artifactManifest.dimensions[key] !== value,
    ) ||
    artifactManifest.variantId !== computeVariantId(releasePolicy, fullVariant)
  ) {
    throw new Error(
      "Performance artifact manifest differs from source/release variant",
    );
  }
  const archiveVerification = await verifyDeterministicZip({
    archivePath: path.resolve(arguments_.artifact),
    expectedFiles: artifactManifest.outputFiles,
  });
  if (archiveVerification.archiveSha256 !== sha256Bytes(artifactBytes)) {
    throw new Error("Performance artifact archive digest verification failed");
  }
  const source = {
    ...sourceState,
    artifactSha256: sha256Bytes(artifactBytes),
    releaseVariant: structuredClone(REQUIRED_PERFORMANCE_VARIANTS[gate]),
  };
  const adapters = await resolveTrackedAdapter(arguments_.adapterModule);
  const { chromium } = await import("@playwright/test");
  const channel = environment.browser?.channel;
  const browser = await chromium.launch({
    headless: true,
    ...(channel === "chromium" ? {} : { channel }),
  });
  try {
    assertEnvironmentMatchesHost({
      actualBrowser: { channel, version: browser.version() },
      environment,
    });
    await verifyTargetIdentity({
      browser,
      expectedSourceSha: source.gitCommitSha,
      expectedVariantId: computeVariantId(releasePolicy, fullVariant),
      releaseRole: source.releaseVariant.releaseRole,
      targetUrl,
    });
    await verifyTargetArtifactAssets({
      browser,
      manifest: artifactManifest,
      targetUrl,
    });
    const rawSamples = await collectCanonicalPerformanceSamples({
      adapters,
      artifactBinding: {
        archiveSha256: archiveVerification.archiveSha256,
        outputFiles: structuredClone(artifactManifest.outputFiles),
      },
      browser,
      context: policyContext,
      environment,
      evidenceId: arguments_.evidenceId,
      gate,
      loadFixture: createFixtureLoader(policyContext),
      source,
      targetUrl,
    });
    await writeFile(
      path.resolve(arguments_.output),
      `${canonicalizeJson(rawSamples)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    process.stdout.write(
      `Wrote ${gate} raw performance samples for ${rawSamples.scenarios.length} scenario(s)\n`,
    );
  } finally {
    await browser.close();
  }
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
