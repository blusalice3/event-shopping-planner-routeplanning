import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { assertConfiguredArtifactControlStoreDrillPolicy } from "../lib/artifact-control-store-drill-policy.mjs";
import {
  describeExactFile,
  readExactRegularFile,
  sameExactFileIdentityAndSize,
} from "../lib/exact-file-read.mjs";
import { collectVercelProviderObservation } from "./collect-vercel-observation.mjs";
import {
  assertArtifactControlStoreDrillProtectedWorkflow,
  collectAndStoreArtifactControlStoreDrill,
  collectAndStoreArtifactControlStoreDrillOidcAuthority,
  deriveArtifactDrillNamespace,
} from "./artifact-control-store-drill.mjs";
import {
  buildArtifactControlStoreDrillClosure,
  captureArtifactControlStoreDrillClosureObjects,
  readArtifactControlStoreDrillClosure,
} from "./artifact-control-store-drill-closure.mjs";
import {
  executeArtifactControlStorePostgresDrill,
  openDisposableArtifactControlStoreDrill,
} from "./artifact-control-store-drill-postgres.mjs";
import { executeArtifactControlStoreLiveOperations } from "./artifact-control-store-drill-provider.mjs";
import { prepareArtifactDrillBootstrapRawDist } from "./artifact-control-store-drill-bootstrap.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { resolveBootstrapFoundationSource } from "../lib/foundation-baseline-closure-authority.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_INPUT_BYTES = 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 32 * 1024 * 1024;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Artifact drill environment is absent: ${name}`);
  }
  return value;
};

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

export const parseArtifactControlStoreDrillArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length !== 6) {
    throw new Error(
      "Usage: collect-artifact-control-store-drill.mjs --namespace <production-namespace> --source-sha <sha> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--namespace", "--output", "--source-sha"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("Artifact drill arguments are invalid");
    }
    values.set(flag, value);
  }
  const productionNamespace = values.get("--namespace");
  const sourceSha = values.get("--source-sha");
  if (
    !NAMESPACE.test(productionNamespace ?? "") ||
    !SOURCE_SHA.test(sourceSha ?? "")
  ) {
    throw new Error("Artifact drill namespace or source SHA is invalid");
  }
  return {
    productionNamespace,
    sourceSha,
    outputPath: values.get("--output"),
  };
};

const exactFile = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return { path: resolved, ...describeExactFile(metadata) };
};

const readExactJson = async (filePath, label) => {
  const bytes = await readExactRegularFile({
    description: await exactFile(filePath, label),
    maximumBytes: MAXIMUM_INPUT_BYTES,
    label,
  });
  return parseJsonStrict(bytes.toString("utf8"), label);
};

const sameDescriptor = (metadata, description) =>
  metadata.isFile() &&
  !metadata.isSymbolicLink() &&
  sameExactFileIdentityAndSize(describeExactFile(metadata), description);

const assertCommittedClosureFile = async ({ resolved, bytes, description }) => {
  const pathMetadata = await lstat(resolved, { bigint: true });
  if (!sameDescriptor(pathMetadata, description)) {
    throw new Error("Artifact drill closure output path changed");
  }
  const first = await readExactRegularFile({
    description: { path: resolved, ...description },
    maximumBytes: bytes.length,
    label: "Artifact drill closure output",
    requireDescriptionTimestamps: false,
  });
  const settledMetadata = await lstat(resolved, { bigint: true });
  if (!sameDescriptor(settledMetadata, description) || !first.equals(bytes)) {
    throw new Error("Artifact drill closure output readback differs");
  }
  const settled = await readExactRegularFile({
    description: { path: resolved, ...description },
    maximumBytes: bytes.length,
    label: "Settled artifact drill closure output",
    requireDescriptionTimestamps: false,
  });
  const finalMetadata = await lstat(resolved, { bigint: true });
  if (!sameDescriptor(finalMetadata, description) || !settled.equals(bytes)) {
    throw new Error("Artifact drill closure output did not remain exact");
  }
};

export const writeArtifactControlStoreDrillOutput = async (
  outputPath,
  closure,
) => {
  if (
    !Buffer.isBuffer(closure?.bytes) ||
    closure.bytes.length < 1 ||
    closure.bytes.length > MAXIMUM_OUTPUT_BYTES ||
    sha256Bytes(closure.bytes) !== closure.sha256 ||
    !closure.bytes.equals(canonicalJsonBytes(closure.closure))
  ) {
    throw new Error("Artifact drill closure output authority is invalid");
  }
  const resolved = path.resolve(outputPath);
  try {
    await lstat(resolved);
    throw new Error("Artifact drill output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await open(temporary, "wx+", 0o600);
  let linked = false;
  try {
    await handle.writeFile(closure.bytes);
    await handle.sync();
    const description = describeExactFile(await handle.stat({ bigint: true }));
    if (description.size !== closure.bytes.length) {
      throw new Error("Artifact drill closure temporary output differs");
    }
    const descriptorBytes = Buffer.alloc(closure.bytes.length);
    const descriptorRead = await handle.read(
      descriptorBytes,
      0,
      descriptorBytes.length,
      0,
    );
    if (
      descriptorRead.bytesRead !== descriptorBytes.length ||
      !descriptorBytes.equals(closure.bytes)
    ) {
      throw new Error("Artifact drill closure descriptor readback differs");
    }
    await link(temporary, resolved);
    linked = true;
    await unlink(temporary);
    await handle.close();
    await assertCommittedClosureFile({
      resolved,
      bytes: closure.bytes,
      description,
    });
    return { path: resolved, bytes: Buffer.from(closure.bytes) };
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (!linked) await unlink(resolved).catch(() => {});
  }
};

const verifyFixedToolchain = (toolchainPolicy) => {
  const adjacentNpmCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const npmExecPath =
    typeof process.env.npm_execpath === "string" &&
    existsSync(process.env.npm_execpath)
      ? process.env.npm_execpath
      : adjacentNpmCli;
  if (!existsSync(npmExecPath)) {
    throw new Error("Artifact drill pinned npm CLI is unavailable");
  }
  const npmVersion = execFileSync(
    process.execPath,
    [npmExecPath, "--version"],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();
  if (
    process.version !== `v${toolchainPolicy.runtime?.node}` ||
    npmVersion !== toolchainPolicy.runtime?.npm
  ) {
    throw new Error("Artifact drill runtime differs from fixed toolchain");
  }
};

const policyPath = (name) => path.join(root, "config", name);

export const prepareArtifactControlStoreDrillExternalInputs = async ({
  createProductionStore,
  collectProviderObservation,
  prepareBootstrap,
  environment,
  storePolicy,
  productionNamespace,
  providerPolicy,
  p0aPolicy,
  bootstrapSourceResolution,
  foundationBaseline,
}) => {
  let productionStore = null;
  let bootstrapMaterialization = null;
  let providerObservation = null;
  const failures = [];
  try {
    productionStore = await createProductionStore({
      connectionString: requireEnvironment(
        environment,
        storePolicy.databaseUrlEnvironmentName,
      ),
      namespace: productionNamespace,
      policy: storePolicy,
      ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
    });
    const [providerResult, bootstrapResult] = await Promise.allSettled([
      Promise.resolve().then(() =>
        collectProviderObservation({
          policy: providerPolicy,
          token: environment.VERCEL_TOKEN,
        }),
      ),
      Promise.resolve().then(() =>
        prepareBootstrap({
          store: productionStore,
          namespace: productionNamespace,
          p0aPolicy,
          providerPolicy,
          bootstrapSourceResolution,
          foundationBaseline,
          requiredRoutes: p0aPolicy.bootstrapRecovery.requiredRoutes,
        }),
      ),
    ]);
    if (providerResult.status === "fulfilled") {
      providerObservation = providerResult.value ?? null;
    } else {
      failures.push(providerResult.reason);
    }
    if (bootstrapResult.status === "fulfilled") {
      bootstrapMaterialization = bootstrapResult.value ?? null;
    } else {
      failures.push(bootstrapResult.reason);
    }
  } catch (error) {
    failures.push(error);
  }
  if (productionStore !== null) {
    try {
      await productionStore.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (
    failures.length === 0 &&
    (providerObservation === null || bootstrapMaterialization === null)
  ) {
    failures.push(
      new Error("Artifact drill external input preparation is incomplete"),
    );
  }
  if (failures.length > 0) {
    if (bootstrapMaterialization !== null) {
      try {
        await bootstrapMaterialization.cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(
      failures,
      "Artifact drill external input preparation or cleanup failed",
    );
  }
  return Object.freeze({ bootstrapMaterialization, providerObservation });
};

export const runArtifactControlStoreDrillCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadPolicy = readExactJson,
    assertProtected = assertArtifactControlStoreDrillProtectedWorkflow,
    collectOidc = collectAndStoreArtifactControlStoreDrillOidcAuthority,
    collectProviderObservation = collectVercelProviderObservation,
    openDisposable = openDisposableArtifactControlStoreDrill,
    executeControlStore = executeArtifactControlStorePostgresDrill,
    executeLive = executeArtifactControlStoreLiveOperations,
    createProductionStore = createPostgresReleaseStateStore,
    prepareBootstrap = prepareArtifactDrillBootstrapRawDist,
    resolveBootstrapSource = resolveBootstrapFoundationSource,
    collect = collectAndStoreArtifactControlStoreDrill,
    captureClosure = captureArtifactControlStoreDrillClosureObjects,
    buildClosure = buildArtifactControlStoreDrillClosure,
    readClosure = readArtifactControlStoreDrillClosure,
    writeOutput = writeArtifactControlStoreDrillOutput,
  } = {},
) => {
  const parsed = parseArtifactControlStoreDrillArguments(argv);
  const [
    approvalPolicy,
    storePolicy,
    providerPolicy,
    toolchainPolicy,
    artifactDrillPolicy,
    releasePolicy,
    dbContract,
    archivePolicy,
    cspPolicy,
    foundationBaseline,
    p0aPolicy,
  ] = await Promise.all([
    loadPolicy(
      policyPath("approval-policy.json"),
      "Artifact drill approval policy",
    ),
    loadPolicy(
      policyPath("release-state-store.json"),
      "Artifact drill store policy",
    ),
    loadPolicy(
      policyPath("provider-policy.json"),
      "Artifact drill provider policy",
    ),
    loadPolicy(
      policyPath("toolchain-versions.json"),
      "Artifact drill toolchain policy",
    ),
    loadPolicy(
      policyPath("artifact-control-store-drill.json"),
      "Artifact drill dedicated database policy",
    ),
    loadPolicy(
      policyPath("release-variants.json"),
      "Artifact drill release policy",
    ),
    loadPolicy(
      policyPath("db-compatibility-contract.json"),
      "Artifact drill DB compatibility contract",
    ),
    loadPolicy(
      policyPath("artifact-archive-policy.json"),
      "Artifact drill archive policy",
    ),
    loadPolicy(policyPath("csp-policy.json"), "Artifact drill CSP policy"),
    loadPolicy(
      policyPath("foundation-baseline.json"),
      "Artifact drill foundation baseline",
    ),
    loadPolicy(
      policyPath("foundation-p0a-authorities.json"),
      "Artifact drill P0A authority policy",
    ),
  ]);
  verifyFixedToolchain(toolchainPolicy);
  assertConfiguredArtifactControlStoreDrillPolicy(artifactDrillPolicy);
  const workflow = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.productionNamespace,
    sourceSha: parsed.sourceSha,
  });
  const drillNamespace = deriveArtifactDrillNamespace({
    productionNamespace: parsed.productionNamespace,
    sourceSha: parsed.sourceSha,
    runId: workflow.runId,
    runAttempt: workflow.runAttempt,
  });
  const bootstrapSourceResolution = resolveBootstrapSource({
    bootstrapSourceSha: p0aPolicy.bootstrapRecovery.bootstrapSourceSha,
    cwd: root,
  });
  let disposable = null;
  let bootstrapMaterialization = null;
  let result = null;
  let primaryError = null;
  let cleanup = null;
  try {
    const preparedInputs = await prepareArtifactControlStoreDrillExternalInputs(
      {
        createProductionStore,
        collectProviderObservation,
        prepareBootstrap,
        environment,
        storePolicy,
        productionNamespace: parsed.productionNamespace,
        providerPolicy,
        p0aPolicy,
        bootstrapSourceResolution,
        foundationBaseline,
      },
    );
    const providerObservation = preparedInputs.providerObservation;
    bootstrapMaterialization = preparedInputs.bootstrapMaterialization;
    disposable = await openDisposable({
      policy: artifactDrillPolicy,
      storePolicy,
      environment,
      namespace: drillNamespace,
    });
    const oidc = await collectOidc({
      store: disposable.drillStore,
      namespace: drillNamespace,
      sourceSha: parsed.sourceSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
      approvalPolicy,
      environment,
    });
    const executionAuthority = {
      databaseEndpointSha256: disposable.identity.databaseEndpointSha256,
      databasePolicySha256: sha256Json(artifactDrillPolicy),
      providerPolicySha256: sha256Json(providerPolicy),
      toolchainSha256: sha256Json(toolchainPolicy),
    };
    const observation = await collect({
      drillStore: disposable.drillStore,
      productionNamespace: parsed.productionNamespace,
      sourceSha: parsed.sourceSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
      oidcReceipt: oidc.reference,
      oidcAuthority: {
        approvalPolicy,
        runId: workflow.runId,
        runAttempt: workflow.runAttempt,
      },
      providerPolicy,
      artifactDrillPolicy,
      providerObservation,
      executionAuthority,
      executeOperations: (options) =>
        executeLive({
          ...options,
          drillStore: disposable.drillStore,
          controlStoreExecutor: () =>
            executeControlStore({
              drillStore: disposable.drillStore,
              deniedReaderProjectionPool: disposable.deniedReaderProjectionPool,
              namespace: drillNamespace,
              identity: disposable.identity,
            }),
          providerPolicy,
          artifactDrillPolicy,
          bootstrapMaterialization,
          buildOptions: {
            sourceSha: parsed.sourceSha,
            p0aPolicy,
            foundationBaseline,
            releasePolicy,
            toolchainPolicy,
            providerPolicy,
            providerObservation,
            dbContract,
            archivePolicy,
            cspPolicy,
            environment,
          },
          cspPolicy,
          toolchainPolicy,
          environment,
          root,
        }),
    });
    const forbiddenAliases = [
      ...(providerPolicy.ownedProductionDomains ?? []),
      ...(providerPolicy.productionDomains ?? []),
      ...(providerPolicy.productionAliases ?? []),
    ];
    const closureAuthority = {
      productionNamespace: parsed.productionNamespace,
      forbiddenAliases,
      aliasSuffix: artifactDrillPolicy.providerPreviewAliasSuffix,
      providerPolicy,
    };
    const capture = await captureClosure({
      store: disposable.drillStore,
      observation,
      authority: closureAuthority,
    });
    const completedDisposable = disposable;
    disposable = null;
    cleanup = await completedDisposable.cleanup();
    const closure = buildClosure({
      capture,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
      cleanup,
    });
    await readClosure({
      bytes: closure.bytes,
      approvalPolicy,
      providerPolicy,
      artifactDrillPolicy,
      releasePolicy,
      toolchainPolicy,
      dbContract,
      cspPolicy,
      foundationBaseline,
      p0aPolicy,
      expectedSourceSha: parsed.sourceSha,
      expectedRunId: workflow.runId,
      expectedRunAttempt: workflow.runAttempt,
    });
    await writeOutput(path.resolve(cwd, parsed.outputPath), closure);
    result = closure;
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupFailures = [];
    if (disposable !== null) {
      const incompleteDisposable = disposable;
      disposable = null;
      try {
        cleanup = await incompleteDisposable.cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const pendingCleanup = [];
    if (bootstrapMaterialization !== null) {
      pendingCleanup.push(bootstrapMaterialization.cleanup());
    }
    const settled = await Promise.allSettled(pendingCleanup);
    cleanupFailures.push(
      ...settled
        .filter(({ status }) => status === "rejected")
        .map(({ reason }) => reason),
    );
    if (cleanupFailures.length > 0) {
      primaryError = new AggregateError(
        primaryError === null
          ? cleanupFailures
          : [primaryError, ...cleanupFailures],
        "Artifact drill collector execution or cleanup failed",
      );
    }
  }
  if (primaryError !== null) throw primaryError;
  if (result === null) {
    throw new Error("Artifact drill collector produced no closure");
  }
  stdout.write(`PASS artifact control-store drill: ${result.sha256}\n`);
  return result;
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runArtifactControlStoreDrillCli();
