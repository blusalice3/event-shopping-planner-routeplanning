import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { resolveContentAddressedObject } from "../lib/content-addressed-store.mjs";
import {
  assertVerifiedGitHubOidcResult,
  requestGitHubOidcToken,
  verifyGitHubOidcTokenFromIssuer,
} from "./githubOidc.mjs";
import {
  PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE,
  PRE_PROMOTION_EVIDENCE_CATEGORIES,
  PRE_PROMOTION_OIDC_MEDIA_TYPE,
  assertPrePromotionOidcReceipt,
  prePromotionVerifierCommands,
  resolveNamedPrePromotionEvidence,
  resolvePrePromotionBindingContext,
  storePrePromotionBuildRunReceipt,
  storePrePromotionCategoryReceipt,
  storePrePromotionVerifierRunReceipt,
} from "./prePromotionEvidence.mjs";
import { PRE_PROMOTION_EVIDENCE_SOURCE_KIND } from "./authoritativeInputProducers.mjs";
import {
  NAMESPACE_PATTERN,
  SHA256_PATTERN,
  SOURCE_SHA_PATTERN,
  assertDeploymentBinding,
  assertEvidenceObjectAvailable,
  parseCanonicalJsonBytes,
  sameCanonicalValue,
  validateProviderEvidenceForBinding,
} from "./releaseWorkflowValidation.mjs";

const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PROVIDER_OBSERVATION_BYTES = 4 * 1024 * 1024;
const RUN_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const SECRET_ENVIRONMENT_NAMES = Object.freeze([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_TOKEN",
  "RELEASE_STATE_DATABASE_CA_PEM",
  "RELEASE_STATE_DATABASE_URL",
  "VERCEL_TOKEN",
]);

const referenceFor = (namespace, sha256) => ({
  uri: `release-state://${namespace}/evidence/${sha256}`,
  sha256,
});

const npmExecutable = () => (process.platform === "win32" ? "npm.cmd" : "npm");

const defaultRunCommand = ({
  executable,
  arguments: args,
  cwd,
  environment,
  timeout,
}) =>
  spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: null,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false,
    timeout,
    windowsHide: true,
  });

const toOutputBytes = (value, label) => {
  const bytes = Buffer.isBuffer(value)
    ? value
    : value === null || value === undefined
      ? Buffer.alloc(0)
      : Buffer.from(String(value), "utf8");
  if (bytes.length > MAX_COMMAND_OUTPUT_BYTES) {
    throw new Error(`${label} output is oversized`);
  }
  return bytes;
};

const assertSuccessfulCommand = (result, label) => {
  if (
    !result ||
    result.error !== undefined ||
    (result.signal !== null && result.signal !== undefined) ||
    result.status !== 0
  ) {
    throw new Error(`${label} failed`);
  }
  return {
    stdoutBytes: toOutputBytes(result.stdout, `${label} stdout`),
    stderrBytes: toOutputBytes(result.stderr, `${label} stderr`),
  };
};

const secretValues = (environment) =>
  SECRET_ENVIRONMENT_NAMES.map((name) => environment[name]).filter(
    (value) =>
      typeof value === "string" && Buffer.byteLength(value, "utf8") >= 8,
  );

const assertNoSecretBytes = (bytes, secrets, label) => {
  for (const secret of secrets) {
    if (bytes.includes(Buffer.from(secret, "utf8"))) {
      throw new Error(`${label} contains protected credentials`);
    }
  }
};

const assertSafeOutputs = (outputs, environment, label) => {
  const secrets = secretValues(environment);
  assertNoSecretBytes(outputs.stdoutBytes, secrets, `${label} stdout`);
  assertNoSecretBytes(outputs.stderrBytes, secrets, `${label} stderr`);
  return outputs;
};

const runGit = async ({
  args,
  repositoryRoot,
  environment,
  runCommand,
  label,
}) =>
  assertSuccessfulCommand(
    await runCommand({
      executable: "git",
      arguments: args,
      cwd: repositoryRoot,
      environment,
      timeout: 30_000,
    }),
    label,
  );

const assertCleanCheckout = async ({
  repositoryRoot,
  sourceSha,
  environment,
  runCommand,
}) => {
  const [head, status] = await Promise.all([
    runGit({
      args: ["rev-parse", "HEAD"],
      repositoryRoot,
      environment,
      runCommand,
      label: "Protected checkout source",
    }),
    runGit({
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
      repositoryRoot,
      environment,
      runCommand,
      label: "Protected checkout status",
    }),
  ]);
  if (
    head.stdoutBytes.toString("utf8").trim() !== sourceSha ||
    status.stdoutBytes.length !== 0
  ) {
    throw new Error(
      "Protected checkout is dirty or differs from the reviewed source",
    );
  }
};

const putExactEvidence = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const sha256 = sha256Bytes(bytes);
  const receipt = await store.putEvidence({ bytes, mediaType });
  if (
    receipt?.uri !== `release-state://${namespace}/evidence/${sha256}` ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error(`${label} immutable-store receipt is invalid`);
  }
  const stored = await store.readEvidence({ sha256 });
  if (
    !stored ||
    !Buffer.isBuffer(stored.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== mediaType
  ) {
    throw new Error(`${label} immutable-store readback differs`);
  }
  return referenceFor(namespace, sha256);
};

const defaultObtainOidcReceiptBytes = async ({
  approvalPolicy,
  sourceSha,
  workflowRunId,
  environment,
  fetchImpl,
  nowMilliseconds,
}) => {
  const token = await requestGitHubOidcToken({
    requestUrl: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
    requestToken: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    audience: approvalPolicy.oidcAudience,
    fetchImpl,
  });
  const verified = await verifyGitHubOidcTokenFromIssuer({
    token,
    policy: approvalPolicy,
    expectedSourceSha: sourceSha,
    expectedRunId: workflowRunId,
    nowMs: nowMilliseconds,
    fetchImpl,
  });
  assertVerifiedGitHubOidcResult(verified);
  return verified.receiptBytes;
};

const assertOidcReceiptBytes = ({
  bytes,
  sourceSha,
  workflowRunId,
  runAttempt,
}) => {
  const receipt = parseCanonicalJsonBytes(bytes, "Pre-promotion OIDC receipt");
  assertPrePromotionOidcReceipt({
    receipt,
    sourceSha,
    workflowRunId,
    runAttempt,
    label: "Pre-promotion OIDC receipt",
  });
  return bytes;
};

const readStoredReference = async ({ store, namespace, reference, label }) => {
  const stored = await assertEvidenceObjectAvailable({
    store,
    namespace,
    reference,
    label,
  });
  return stored.bytes;
};

const readBuiltObject = async ({ packageRoot, reference, expectedKind }) =>
  (
    await resolveContentAddressedObject({
      packageRoot,
      reference,
      expectedKind,
    })
  ).bytes;

const verifyBuiltPackage = async ({
  store,
  namespace,
  packageRoot,
  context,
}) => {
  const indexBytes = await readFile(
    path.join(packageRoot, "release-package-index.json"),
  );
  const index = parseCanonicalJsonBytes(
    indexBytes,
    "Reproducibility package index",
  );
  if (!sameCanonicalValue(index, context.index)) {
    throw new Error(
      "Reproducibility package index differs from reviewed authority",
    );
  }
  const storedIndexBytes = await readStoredReference({
    store,
    namespace,
    reference: context.packageIndexReference,
    label: "Reviewed package index",
  });
  if (!indexBytes.equals(storedIndexBytes)) {
    throw new Error(
      "Reproducibility package index bytes differ from immutable storage",
    );
  }
  const artifacts = Object.fromEntries(
    context.index.artifacts.map((artifact) => [artifact.releaseRole, artifact]),
  );
  const outputs = { indexBytes, manifests: {}, archives: {} };
  for (const [role, bindingReference, manifestReference] of [
    [
      "standard",
      context.standardArchiveReference,
      context.standardManifestReference,
    ],
    [
      "containment",
      context.containmentArchiveReference,
      context.containmentManifestReference,
    ],
  ]) {
    const artifact = artifacts[role];
    if (!artifact) throw new Error(`Reproducibility package lacks ${role}`);
    const [
      manifestBytes,
      archiveBytes,
      storedManifestBytes,
      storedArchiveBytes,
    ] = await Promise.all([
      readBuiltObject({
        packageRoot,
        reference: artifact.manifest,
        expectedKind: "artifact.json",
      }),
      readBuiltObject({
        packageRoot,
        reference: artifact.archive,
        expectedKind: "artifact.zip",
      }),
      readStoredReference({
        store,
        namespace,
        reference: manifestReference,
        label: `Reviewed ${role} manifest`,
      }),
      readStoredReference({
        store,
        namespace,
        reference: bindingReference,
        label: `Reviewed ${role} archive`,
      }),
    ]);
    if (
      artifact.manifest.sha256 !== manifestReference.sha256 ||
      artifact.archive.sha256 !== bindingReference.sha256 ||
      !manifestBytes.equals(storedManifestBytes) ||
      !archiveBytes.equals(storedArchiveBytes)
    ) {
      throw new Error(
        `Reproducibility ${role} artifact differs from immutable storage`,
      );
    }
    outputs.manifests[role] = manifestBytes;
    outputs.archives[role] = archiveBytes;
  }
  return outputs;
};

const assertIndependentPackageBytes = (first, second) => {
  for (const [label, left, right] of [
    ["package index", first.indexBytes, second.indexBytes],
    ["standard manifest", first.manifests.standard, second.manifests.standard],
    [
      "containment manifest",
      first.manifests.containment,
      second.manifests.containment,
    ],
    ["standard archive", first.archives.standard, second.archives.standard],
    [
      "containment archive",
      first.archives.containment,
      second.archives.containment,
    ],
  ]) {
    if (!left.equals(right)) {
      throw new Error(`Independent reproducibility ${label} bytes differ`);
    }
  }
};

const runArtifactBuild = async ({
  output,
  providerObservationPath,
  buildRequirementsPath,
  buildRequirementsSha256,
  repositoryRoot,
  environment,
  runCommand,
}) =>
  assertSafeOutputs(
    assertSuccessfulCommand(
      await runCommand({
        executable: npmExecutable(),
        arguments: [
          "run",
          "artifact:build",
          "--",
          "--output",
          output,
          "--provider-observation",
          providerObservationPath,
          "--build-requirements",
          buildRequirementsPath,
          "--build-requirements-sha256",
          buildRequirementsSha256,
        ],
        cwd: repositoryRoot,
        environment,
        timeout: 60 * 60 * 1000,
      }),
      "Pre-promotion artifact build",
    ),
    environment,
    "Pre-promotion artifact build",
  );

const runVerifierCategory = async ({
  category,
  buildOutputPaths,
  repositoryRoot,
  environment,
  runCommand,
}) => {
  const executions = [];
  for (const {
    id,
    command,
    targetBuildOrdinal,
  } of prePromotionVerifierCommands(category)) {
    const match = /^npm run ([a-z0-9:.-]+)$/u.exec(command);
    const arguments_ =
      targetBuildOrdinal === null
        ? match === null
          ? null
          : ["run", match[1]]
        : [
            "run",
            "artifact:verify",
            "--",
            "--package",
            buildOutputPaths[targetBuildOrdinal - 1],
          ];
    if (arguments_ === null) {
      throw new Error(`Pre-promotion ${category} command is not executable`);
    }
    const outputs = assertSafeOutputs(
      assertSuccessfulCommand(
        await runCommand({
          executable: npmExecutable(),
          arguments: arguments_,
          cwd: repositoryRoot,
          environment,
          timeout: 60 * 60 * 1000,
        }),
        `Pre-promotion ${category} command ${id}`,
      ),
      environment,
      `Pre-promotion ${category} command ${id}`,
    );
    executions.push({ id, targetBuildOrdinal, exitCode: 0, ...outputs });
  }
  return executions;
};

const validateCollectionInputs = ({
  store,
  namespace,
  sourceSha,
  workflowRunId,
  runAttempt,
  repositoryRoot,
  buildRequirementsBytes,
  buildRequirementsSha256,
  buildRequirementsPath,
  providerObservationBytes,
  providerObservationSha256,
  providerObservationPath,
  environment,
  approvalPolicy,
}) => {
  if (
    !store ||
    typeof store.readEvidence !== "function" ||
    typeof store.putEvidence !== "function" ||
    !NAMESPACE_PATTERN.test(namespace) ||
    !SOURCE_SHA_PATTERN.test(sourceSha) ||
    !RUN_ID_PATTERN.test(workflowRunId) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !path.isAbsolute(repositoryRoot) ||
    !Buffer.isBuffer(buildRequirementsBytes) ||
    !SHA256_PATTERN.test(buildRequirementsSha256) ||
    sha256Bytes(buildRequirementsBytes) !== buildRequirementsSha256 ||
    !path.isAbsolute(buildRequirementsPath) ||
    !Buffer.isBuffer(providerObservationBytes) ||
    !SHA256_PATTERN.test(providerObservationSha256) ||
    sha256Bytes(providerObservationBytes) !== providerObservationSha256 ||
    !path.isAbsolute(providerObservationPath) ||
    !environment ||
    !approvalPolicy
  ) {
    throw new Error("Pre-promotion evidence execution binding is invalid");
  }
};

export const executePrePromotionEvidenceCollection = async (
  options,
  {
    runCommand = defaultRunCommand,
    obtainOidcReceiptBytes = defaultObtainOidcReceiptBytes,
    createTemporaryRoot = () =>
      mkdtemp(path.join(os.tmpdir(), "foundation-prepromotion-")),
    removeTemporaryRoot = (temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    now = Date.now,
  } = {},
) => {
  const {
    store,
    namespace,
    sourceSha,
    workflowRunId,
    runAttempt,
    repositoryRoot,
    standardBinding,
    containmentBinding,
    buildRequirementsBytes,
    buildRequirementsSha256,
    buildRequirementsPath,
    providerObservationBytes,
    providerObservationPath,
    environment,
    approvalPolicy,
    fetchImpl = fetch,
  } = options;
  validateCollectionInputs(options);
  assertDeploymentBinding(standardBinding, {
    namespace,
    expectedRole: "standard",
    label: "Pre-promotion execution standard binding",
  });
  assertDeploymentBinding(containmentBinding, {
    namespace,
    expectedRole: "containment",
    label: "Pre-promotion execution containment binding",
  });
  const context = await resolvePrePromotionBindingContext({
    store,
    namespace,
    standardBinding,
    containmentBinding,
  });
  if (
    context.index.sourceSha !== sourceSha ||
    context.index.buildAuthority.sha256 !== buildRequirementsSha256 ||
    !canonicalJsonBytes(context.authority).equals(buildRequirementsBytes)
  ) {
    throw new Error(
      "Reviewed build requirements differ from the package authority",
    );
  }
  const buildRequirementsFileBytes = await readFile(buildRequirementsPath);
  if (!buildRequirementsFileBytes.equals(buildRequirementsBytes)) {
    throw new Error("Build requirements file differs from reviewed bytes");
  }
  const providerObservationFileBytes = await readFile(providerObservationPath);
  if (
    providerObservationBytes.length === 0 ||
    providerObservationBytes.length > MAX_PROVIDER_OBSERVATION_BYTES ||
    !providerObservationFileBytes.equals(providerObservationBytes)
  ) {
    throw new Error("Provider observation is empty or oversized");
  }
  parseCanonicalJsonBytes(providerObservationBytes, "Provider observation");
  await assertCleanCheckout({
    repositoryRoot,
    sourceSha,
    environment,
    runCommand,
  });
  const oidcReceiptBytes = assertOidcReceiptBytes({
    bytes: await obtainOidcReceiptBytes({
      approvalPolicy,
      sourceSha,
      workflowRunId,
      environment,
      fetchImpl,
      nowMilliseconds: now(),
    }),
    sourceSha,
    workflowRunId,
    runAttempt,
  });
  const issuerReceiptReference = await putExactEvidence({
    store,
    namespace,
    bytes: oidcReceiptBytes,
    mediaType: PRE_PROMOTION_OIDC_MEDIA_TYPE,
    label: "Pre-promotion OIDC receipt",
  });
  const temporaryRoot = path.resolve(await createTemporaryRoot());
  if (
    temporaryRoot === repositoryRoot ||
    temporaryRoot.startsWith(`${repositoryRoot}${path.sep}`)
  ) {
    throw new Error(
      "Pre-promotion build temporary root must be outside the checkout",
    );
  }
  try {
    const buildOutputs = [];
    const buildOutputPaths = [];
    const buildCommandOutputs = [];
    for (const buildOrdinal of [1, 2]) {
      const output = path.join(temporaryRoot, `build-${buildOrdinal}`);
      buildOutputPaths.push(output);
      buildCommandOutputs.push(
        await runArtifactBuild({
          output,
          providerObservationPath,
          buildRequirementsPath,
          buildRequirementsSha256,
          repositoryRoot,
          environment,
          runCommand,
        }),
      );
      buildOutputs.push(
        await verifyBuiltPackage({
          store,
          namespace,
          packageRoot: output,
          context,
        }),
      );
      await assertCleanCheckout({
        repositoryRoot,
        sourceSha,
        environment,
        runCommand,
      });
    }
    assertIndependentPackageBytes(buildOutputs[0], buildOutputs[1]);
    const buildRuns = [];
    for (const buildOrdinal of [1, 2]) {
      buildRuns.push(
        await storePrePromotionBuildRunReceipt({
          store,
          namespace,
          standardBinding,
          containmentBinding,
          workflowRunId,
          runAttempt,
          buildOrdinal,
          issuerReceiptReference,
          ...buildCommandOutputs[buildOrdinal - 1],
        }),
      );
    }
    const verifierRuns = {};
    for (const category of ["qa", "security", "resource"]) {
      const executions = await runVerifierCategory({
        category,
        buildOutputPaths,
        repositoryRoot,
        environment,
        runCommand,
      });
      verifierRuns[category] = await storePrePromotionVerifierRunReceipt({
        store,
        namespace,
        standardBinding,
        containmentBinding,
        category,
        workflowRunId,
        runAttempt,
        issuerReceiptReference,
        executions,
      });
    }
    await assertCleanCheckout({
      repositoryRoot,
      sourceSha,
      environment,
      runCommand,
    });
    const [standardProviderEvidence, containmentProviderEvidence] =
      await Promise.all([
        validateProviderEvidenceForBinding({
          store,
          namespace,
          binding: standardBinding,
          label: "Pre-promotion standard",
        }),
        validateProviderEvidenceForBinding({
          store,
          namespace,
          binding: containmentBinding,
          label: "Pre-promotion containment",
        }),
      ]);
    const namedEvidence = {
      qa: await storePrePromotionCategoryReceipt({
        store,
        namespace,
        standardBinding,
        containmentBinding,
        category: "qa",
        proof: { verifierRun: verifierRuns.qa },
      }),
      reproducibility: await storePrePromotionCategoryReceipt({
        store,
        namespace,
        standardBinding,
        containmentBinding,
        category: "reproducibility",
        proof: { firstBuildRun: buildRuns[0], secondBuildRun: buildRuns[1] },
      }),
      resource: await storePrePromotionCategoryReceipt({
        store,
        namespace,
        standardBinding,
        containmentBinding,
        category: "resource",
        proof: { verifierRun: verifierRuns.resource },
      }),
      route: await storePrePromotionCategoryReceipt({
        store,
        namespace,
        standardBinding,
        containmentBinding,
        category: "route",
        proof: {
          standardRouteProbe: referenceFor(
            namespace,
            standardProviderEvidence.routeProbeEvidenceHash,
          ),
          containmentRouteProbe: referenceFor(
            namespace,
            containmentProviderEvidence.routeProbeEvidenceHash,
          ),
        },
      }),
      security: await storePrePromotionCategoryReceipt({
        store,
        namespace,
        standardBinding,
        containmentBinding,
        category: "security",
        proof: { verifierRun: verifierRuns.security },
      }),
    };
    if (
      Object.keys(namedEvidence).sort().join("\n") !==
      [...PRE_PROMOTION_EVIDENCE_CATEGORIES].sort().join("\n")
    ) {
      throw new Error(
        "Pre-promotion evidence category production is incomplete",
      );
    }
    await resolveNamedPrePromotionEvidence({
      store,
      namespace,
      namedEvidence,
      bindings: { standard: standardBinding, containment: containmentBinding },
    });
    const source = {
      schemaVersion: 1,
      sourceKind: PRE_PROMOTION_EVIDENCE_SOURCE_KIND,
      namespace,
      sourceSha,
      evidence: namedEvidence,
    };
    const sourceBytes = canonicalJsonBytes(source);
    return {
      source,
      sourceBytes,
      sourceSha256: sha256Bytes(sourceBytes),
      issuerReceiptReference,
      buildRuns,
      verifierRuns,
    };
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
};

export const prePromotionCommandOutputMediaType =
  PRE_PROMOTION_COMMAND_OUTPUT_MEDIA_TYPE;
