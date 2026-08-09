#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import {
  buildAuthoritativePrePromotionEvidenceSet,
  buildAuthoritativePromotionSubject,
  buildAuthoritativeProviderAliasObservation,
} from "./authoritativeInputProducers.mjs";
import { buildAuthoritativePolicyActivationSubject } from "./policyActivation.mjs";
import { buildAuthoritativePolicyActivationClosure } from "./policyActivationClosure.mjs";
import { buildPolicyActivationQaPackage } from "./policyActivationQaPackage.mjs";
import { buildAuthoritativePolicyActivationQaExecutionSubject } from "./policyActivationQaExecution.mjs";
import { buildAuthoritativeArtifactBuildRequirements } from "./artifactBuildAuthority.mjs";
import { POLICY_ACTIVATION_GATES, RELEASE_PHASE_GATES } from "./phaseGates.mjs";
import { createPostgresReleaseStateStore } from "./postgresStore.mjs";
import {
  NAMESPACE_PATTERN,
  OPERATION_ID_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
} from "./releaseWorkflowValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const COMMAND_FLAGS = {
  "artifact-build-requirements": [
    "--namespace",
    "--operation-id",
    "--output",
    "--source-sha",
    "--target-gate",
    "--target-source-sha",
  ],
  "prepromotion-evidence-set": [
    "--namespace",
    "--output",
    "--source",
    "--source-sha",
    "--source-sha256",
  ],
  "promotion-subject": [
    "--containment-binding",
    "--evidence-set",
    "--namespace",
    "--operation-id",
    "--output",
    "--standard-binding",
  ],
  "policy-activation-subject": [
    "--active-policy-sha256",
    "--closure-bundle-sha256",
    "--namespace",
    "--operation-id",
    "--output",
    "--proposed-policy-sha256",
    "--source-sha",
  ],
  "policy-activation-qa-package": [
    "--activation-gate",
    "--build-requirements-sha256",
    "--companion-archive",
    "--companion-manifest",
    "--namespace",
    "--operation-id",
    "--output",
    "--proposed-policy-sha256",
    "--source-sha",
    "--standard-archive",
    "--standard-manifest",
    "--target-source-sha",
  ],
  "policy-activation-closure": [
    "--namespace",
    "--operation-id",
    "--output",
    "--qa-execution-sha256",
    "--source-sha",
  ],
  "policy-activation-qa-execution-subject": [
    "--active-policy-sha256",
    "--approval-policy-sha256",
    "--namespace",
    "--operation-id",
    "--output",
    "--proposed-policy-sha256",
    "--qa-package-sha256",
    "--source-sha",
    "--target-source-sha",
  ],
  "policy-activation-qa-build-requirements": [
    "--active-policy-sha256",
    "--namespace",
    "--operation-id",
    "--output",
    "--proposed-policy-sha256",
    "--source-sha",
    "--target-source-sha",
  ],
  "provider-observation": ["--namespace", "--output"],
};

export const parseAuthoritativeInputProducerArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(
      "Usage: produce-protected-input.mjs <artifact-build-requirements|prepromotion-evidence-set|promotion-subject|policy-activation-qa-build-requirements|policy-activation-qa-package|policy-activation-closure|policy-activation-subject|provider-observation> [strict flags]",
    );
  }
  const [command, ...tokens] = argv;
  const baseFlags = COMMAND_FLAGS[command];
  const flagSets =
    command === "policy-activation-closure" && baseFlags
      ? [
          baseFlags,
          baseFlags.filter((flag) => flag !== "--qa-execution-sha256"),
        ]
      : baseFlags
        ? [baseFlags]
        : [];
  if (!flagSets.some((flags) => tokens.length === flags.length * 2)) {
    throw new Error(`Invalid authoritative input command: ${command}`);
  }
  const allowedFlags = [...new Set(flagSets.flat())];
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !allowedFlags.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(`Invalid or duplicate authoritative input flag: ${flag}`);
    }
    values[flag] = value;
  }
  const providedFlags = Object.keys(values).sort();
  const exactFlagSet = flagSets.some(
    (flags) =>
      flags.length === providedFlags.length &&
      [...flags].sort().every((flag, index) => flag === providedFlags[index]),
  );
  if (
    !exactFlagSet ||
    !NAMESPACE_PATTERN.test(values["--namespace"]) ||
    ([
      "promotion-subject",
      "artifact-build-requirements",
      "policy-activation-closure",
      "policy-activation-qa-build-requirements",
      "policy-activation-qa-execution-subject",
      "policy-activation-qa-package",
      "policy-activation-subject",
    ].includes(command) &&
      !OPERATION_ID_PATTERN.test(values["--operation-id"])) ||
    (command === "prepromotion-evidence-set" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !SHA256_PATTERN.test(values["--source-sha256"]))) ||
    (command === "policy-activation-subject" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !SHA256_PATTERN.test(values["--proposed-policy-sha256"]) ||
        !SHA256_PATTERN.test(values["--active-policy-sha256"]) ||
        !SHA256_PATTERN.test(values["--closure-bundle-sha256"]))) ||
    (command === "artifact-build-requirements" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !SOURCE_SHA_PATTERN.test(values["--target-source-sha"]) ||
        values["--source-sha"] !== values["--target-source-sha"] ||
        !RELEASE_PHASE_GATES.includes(values["--target-gate"]))) ||
    (command === "policy-activation-qa-build-requirements" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !SOURCE_SHA_PATTERN.test(values["--target-source-sha"]) ||
        !SHA256_PATTERN.test(values["--proposed-policy-sha256"]) ||
        !SHA256_PATTERN.test(values["--active-policy-sha256"]))) ||
    (command === "policy-activation-qa-package" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !SOURCE_SHA_PATTERN.test(values["--target-source-sha"]) ||
        !SHA256_PATTERN.test(values["--proposed-policy-sha256"]) ||
        !SHA256_PATTERN.test(values["--build-requirements-sha256"]) ||
        !POLICY_ACTIVATION_GATES.includes(values["--activation-gate"]))) ||
    (command === "policy-activation-qa-execution-subject" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        !SOURCE_SHA_PATTERN.test(values["--target-source-sha"]) ||
        [
          "--proposed-policy-sha256",
          "--active-policy-sha256",
          "--approval-policy-sha256",
          "--qa-package-sha256",
        ].some((flag) => !SHA256_PATTERN.test(values[flag])))) ||
    (command === "policy-activation-closure" &&
      (!SOURCE_SHA_PATTERN.test(values["--source-sha"]) ||
        (Object.hasOwn(values, "--qa-execution-sha256") &&
          !SHA256_PATTERN.test(values["--qa-execution-sha256"]))))
  ) {
    throw new Error("Authoritative input arguments are incomplete or invalid");
  }
  return { command, values };
};

const requireEnvironment = (env, name) => {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Required producer environment is absent: ${name}`);
  }
  return value;
};

const readBoundedFile = async (
  filePath,
  readFileImpl,
  maximumBytes = MAX_INPUT_BYTES,
) => {
  const bytes = await readFileImpl(filePath);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > maximumBytes
  ) {
    throw new Error("Authoritative producer input is empty or oversized");
  }
  return bytes;
};

const resolveOutputPath = (value, cwd) => path.resolve(cwd, value);

const createBoundStore = async ({
  env,
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
      env,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(env, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

const assertDistinctPaths = (paths) => {
  if (new Set(paths).size !== paths.length) {
    throw new Error(
      "Authoritative producer output must not overwrite an input",
    );
  }
};

export const runAuthoritativeInputProducerCli = async (
  {
    argv = process.argv.slice(2),
    env = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    readFileImpl = readFile,
    writeFileImpl = writeFile,
    createStore = createPostgresReleaseStateStore,
    buildPromotionSubject = buildAuthoritativePromotionSubject,
    buildPolicyActivationSubject = buildAuthoritativePolicyActivationSubject,
    buildPolicyActivationClosure = buildAuthoritativePolicyActivationClosure,
    buildPolicyQaExecutionSubject = buildAuthoritativePolicyActivationQaExecutionSubject,
    buildPolicyQaPackage = buildPolicyActivationQaPackage,
    buildArtifactBuildRequirements = buildAuthoritativeArtifactBuildRequirements,
    buildProviderObservation = buildAuthoritativeProviderAliasObservation,
    buildPrePromotionEvidenceSet = buildAuthoritativePrePromotionEvidenceSet,
  } = {},
) => {
  const { command, values } = parseAuthoritativeInputProducerArguments(argv);
  const namespace = values["--namespace"];
  if (requireEnvironment(env, "RELEASE_STATE_NAMESPACE") !== namespace) {
    throw new Error(
      "Release State namespace differs from the producer environment",
    );
  }
  const storePolicy = await loadJson(
    path.join(root, "config", "release-state-store.json"),
  );
  const output = resolveOutputPath(values["--output"], cwd);
  const store = await createBoundStore({
    env,
    namespace,
    storePolicy,
    createStore,
  });

  try {
    let result;
    if (
      command === "artifact-build-requirements" ||
      command === "policy-activation-qa-build-requirements"
    ) {
      if (requireEnvironment(env, "GITHUB_SHA") !== values["--source-sha"]) {
        throw new Error(
          "Artifact build requirements executor source differs from protected checkout",
        );
      }
      const [toolchainPolicyBytes, cspPolicyBytes] = await Promise.all([
        readBoundedFile(
          path.join(root, "config", "toolchain-versions.json"),
          readFileImpl,
        ),
        readBoundedFile(
          path.join(root, "config", "csp-policy.json"),
          readFileImpl,
        ),
      ]);
      const qa = command === "policy-activation-qa-build-requirements";
      const reference = (flag) => ({
        uri: `release-state://${namespace}/evidence/${values[flag]}`,
        sha256: values[flag],
      });
      result = await buildArtifactBuildRequirements({
        store,
        namespace,
        operationId: values["--operation-id"],
        executorSourceSha: values["--source-sha"],
        targetSourceSha: values["--target-source-sha"],
        purpose: qa ? "policy-activation-qa" : "production",
        toolchainPolicyBytes,
        cspPolicyBytes,
        ...(qa
          ? {
              proposedPolicyReference: reference("--proposed-policy-sha256"),
              activePolicyReference: reference("--active-policy-sha256"),
            }
          : { targetGate: values["--target-gate"] }),
      });
      await writeFileImpl(output, result.requirementsBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative ${qa ? "policy QA" : "production"} artifact build requirements: ${result.requirementsSha256}\n`,
      );
    } else if (command === "promotion-subject") {
      const inputPaths = {
        standard: path.resolve(cwd, values["--standard-binding"]),
        containment: path.resolve(cwd, values["--containment-binding"]),
        evidenceSet: path.resolve(cwd, values["--evidence-set"]),
      };
      assertDistinctPaths([...Object.values(inputPaths), output]);
      const [standardBindingBytes, containmentBindingBytes, evidenceSetBytes] =
        await Promise.all([
          readBoundedFile(inputPaths.standard, readFileImpl),
          readBoundedFile(inputPaths.containment, readFileImpl),
          readBoundedFile(inputPaths.evidenceSet, readFileImpl),
        ]);
      result = await buildPromotionSubject({
        store,
        namespace,
        operationId: values["--operation-id"],
        standardBindingBytes,
        containmentBindingBytes,
        evidenceSetBytes,
      });
      await writeFileImpl(output, result.subjectBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative promotion subject: ${result.subjectSha256}\n`,
      );
    } else if (command === "prepromotion-evidence-set") {
      const sourcePath = path.resolve(cwd, values["--source"]);
      assertDistinctPaths([sourcePath, output]);
      const sourceBytes = await readBoundedFile(sourcePath, readFileImpl);
      const approvalPolicy = await loadJson(
        path.join(root, "config", "approval-policy.json"),
      );
      result = await buildPrePromotionEvidenceSet({
        store,
        namespace,
        sourceSha: values["--source-sha"],
        sourceBytes,
        expectedSourceSha256: values["--source-sha256"],
        currentRunId: requireEnvironment(env, "GITHUB_RUN_ID"),
        githubToken: requireEnvironment(env, "GITHUB_TOKEN"),
        repository: approvalPolicy.repository,
      });
      await writeFileImpl(output, result.evidenceSetBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative pre-promotion evidence set: ${result.evidenceSetSha256}\n`,
      );
    } else if (command === "policy-activation-qa-package") {
      if (requireEnvironment(env, "GITHUB_SHA") !== values["--source-sha"]) {
        throw new Error(
          "Policy activation QA executor source differs from protected checkout",
        );
      }
      const inputPaths = {
        standardManifest: path.resolve(cwd, values["--standard-manifest"]),
        standardArchive: path.resolve(cwd, values["--standard-archive"]),
        companionManifest: path.resolve(cwd, values["--companion-manifest"]),
        companionArchive: path.resolve(cwd, values["--companion-archive"]),
      };
      assertDistinctPaths([...Object.values(inputPaths), output]);
      const [
        standardManifestBytes,
        standardArchiveBytes,
        companionManifestBytes,
        companionArchiveBytes,
      ] = await Promise.all([
        readBoundedFile(inputPaths.standardManifest, readFileImpl),
        readBoundedFile(
          inputPaths.standardArchive,
          readFileImpl,
          MAX_ARCHIVE_BYTES,
        ),
        readBoundedFile(inputPaths.companionManifest, readFileImpl),
        readBoundedFile(
          inputPaths.companionArchive,
          readFileImpl,
          MAX_ARCHIVE_BYTES,
        ),
      ]);
      const proposedPolicySha256 = values["--proposed-policy-sha256"];
      result = await buildPolicyQaPackage({
        store,
        namespace,
        operationId: values["--operation-id"],
        executorSourceSha: values["--source-sha"],
        targetSourceSha: values["--target-source-sha"],
        activationGate: values["--activation-gate"],
        proposedPolicyReference: {
          uri: `release-state://${namespace}/evidence/${proposedPolicySha256}`,
          sha256: proposedPolicySha256,
        },
        buildRequirementsReference: {
          uri:
            `release-state://${namespace}/evidence/` +
            values["--build-requirements-sha256"],
          sha256: values["--build-requirements-sha256"],
        },
        standardManifestBytes,
        standardArchiveBytes,
        companionManifestBytes,
        companionArchiveBytes,
      });
      await writeFileImpl(output, result.indexBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS nonpromotable policy activation QA package: ${result.indexSha256}\n`,
      );
    } else if (command === "policy-activation-qa-execution-subject") {
      if (requireEnvironment(env, "GITHUB_SHA") !== values["--source-sha"]) {
        throw new Error(
          "Policy QA execution subject source differs from protected checkout",
        );
      }
      const reference = (flag) => ({
        uri: `release-state://${namespace}/evidence/` + values[flag],
        sha256: values[flag],
      });
      const [cspPolicyBytes, toolchainPolicyBytes] = await Promise.all([
        readBoundedFile(
          path.join(root, "config", "csp-policy.json"),
          readFileImpl,
        ),
        readBoundedFile(
          path.join(root, "config", "toolchain-versions.json"),
          readFileImpl,
        ),
      ]);
      result = await buildPolicyQaExecutionSubject({
        store,
        namespace,
        operationId: values["--operation-id"],
        executorSourceSha: values["--source-sha"],
        targetSourceSha: values["--target-source-sha"],
        proposedPolicyReference: reference("--proposed-policy-sha256"),
        activePolicyReference: reference("--active-policy-sha256"),
        approvalPolicyReference: reference("--approval-policy-sha256"),
        qaPackageReference: reference("--qa-package-sha256"),
        cspPolicyBytes,
        toolchainPolicyBytes,
      });
      await writeFileImpl(output, result.subjectBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative policy QA execution subject: ${result.subjectSha256}\n`,
      );
    } else if (command === "policy-activation-closure") {
      if (requireEnvironment(env, "GITHUB_SHA") !== values["--source-sha"]) {
        throw new Error(
          "Policy activation executor source differs from protected checkout",
        );
      }
      const reference = (flag) => ({
        uri: `release-state://${namespace}/evidence/` + values[flag],
        sha256: values[flag],
      });
      result = await buildPolicyActivationClosure({
        store,
        namespace,
        operationId: values["--operation-id"],
        executorSourceSha: values["--source-sha"],
        qaExecutionReference: Object.hasOwn(values, "--qa-execution-sha256")
          ? reference("--qa-execution-sha256")
          : null,
      });
      await writeFileImpl(output, result.bundleBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative policy activation closure: ${result.bundleSha256}\n`,
      );
    } else if (command === "policy-activation-subject") {
      if (requireEnvironment(env, "GITHUB_SHA") !== values["--source-sha"]) {
        throw new Error(
          "Policy activation executor source differs from protected checkout",
        );
      }
      result = await buildPolicyActivationSubject({
        store,
        namespace,
        operationId: values["--operation-id"],
        executorSourceSha: values["--source-sha"],
        proposedPolicySha256: values["--proposed-policy-sha256"],
        activePolicySha256: values["--active-policy-sha256"],
        closureBundleSha256: values["--closure-bundle-sha256"],
      });
      await writeFileImpl(output, result.subjectBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative policy activation subject: ${result.subjectSha256}\n`,
      );
    } else {
      result = await buildProviderObservation({
        store,
        namespace,
        providerToken: requireEnvironment(env, "VERCEL_TOKEN"),
      });
      await writeFileImpl(output, result.observationBytes, {
        flag: "wx",
        mode: 0o600,
      });
      stdout.write(
        `PASS authoritative provider observation: ${result.observationSha256}\n`,
      );
    }
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runAuthoritativeInputProducerCli();
}
