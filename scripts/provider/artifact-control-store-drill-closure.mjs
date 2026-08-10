import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import { readStoredProductionRequestGraphOidcAuthority } from "../browser/production-request-graph.mjs";
import {
  ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE,
  artifactDrillOperationReceiptHashes,
  assertArtifactControlStoreDrillObservation,
  readArtifactDrillOperationReceipts,
  readStoredArtifactControlStoreDrill,
} from "./artifact-control-store-drill.mjs";
import { ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE } from "./artifact-control-store-drill-postgres.mjs";
import { ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE } from "./artifact-control-store-drill-receipts.mjs";
import {
  VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE,
  assertVercelObservationEvidence,
} from "./collect-vercel-observation.mjs";
import { assertProductionProviderContext } from "../lib/artifact-builder-core.mjs";
import { assertArtifactDrillBuildAuthority } from "../lib/artifact-drill-build-authority.mjs";

export const ARTIFACT_CONTROL_STORE_DRILL_CLOSURE_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.artifact-provider-control-store-drill-closure+json;version=1";

const SHA256 = /^[0-9a-f]{64}$/u;
const RUN_ID = /^[1-9][0-9]*$/u;
const MAXIMUM_OBJECT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_CLOSURE_BYTES = 32 * 1024 * 1024;

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const canonicalTimestamp = (value, label) => {
  const milliseconds = Date.parse(value);
  if (
    typeof value !== "string" ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new Error(`${label} is not a canonical timestamp`);
  }
  return milliseconds;
};

const readClosureObject = async ({ store, sha256 }) => {
  const stored = await store.readEvidence({ sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.bytes.length === 0 ||
    stored.bytes.length > MAXIMUM_OBJECT_BYTES ||
    sha256Bytes(stored.bytes) !== sha256 ||
    typeof stored.mediaType !== "string" ||
    !stored.mediaType.startsWith("application/") ||
    typeof stored.committedAt !== "string"
  ) {
    throw new Error("Artifact drill closure object readback differs");
  }
  canonicalTimestamp(
    stored.committedAt,
    "Artifact drill closure object commit",
  );
  return {
    bytesBase64: stored.bytes.toString("base64"),
    committedAt: stored.committedAt,
    mediaType: stored.mediaType,
    sha256,
  };
};

export const captureArtifactControlStoreDrillClosureObjects = async ({
  store,
  observation,
  authority,
}) => {
  assertArtifactControlStoreDrillObservation(observation);
  if (store?.namespace !== observation.drillNamespace) {
    throw new Error("Artifact drill closure store namespace differs");
  }
  const rawStored = await readStoredArtifactControlStoreDrill({
    store,
    reference: observation.rawTranscript,
    authority,
  });
  const operationReceipts = await readArtifactDrillOperationReceipts({
    store,
    operations: rawStored.raw,
    aliasSuffix: authority.aliasSuffix,
    forbiddenAliases: authority.forbiddenAliases,
    providerPolicy: authority.providerPolicy,
  });
  const controlStoreReceipt = operationReceipts.find(
    ({ mediaType }) =>
      mediaType === ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
  )?.receipt;
  if (controlStoreReceipt === undefined) {
    throw new Error("Artifact drill closure control-store receipt is absent");
  }
  const hashes = [
    observation.oidcReceipt.sha256,
    observation.productionProviderObservation.sha256,
    observation.rawTranscript.sha256,
    ...artifactDrillOperationReceiptHashes(rawStored.raw),
  ];
  if (new Set(hashes).size !== hashes.length) {
    throw new Error("Artifact drill closure object set is ambiguous");
  }
  const objects = await Promise.all(
    [...hashes]
      .sort((left, right) => left.localeCompare(right))
      .map((sha256) => readClosureObject({ store, sha256 })),
  );
  return Object.freeze({
    administratorRoleSha256: controlStoreReceipt.administratorRoleSha256,
    databaseEndpointSha256: rawStored.raw.authority.databaseEndpointSha256,
    objects: Object.freeze(objects.map((value) => Object.freeze(value))),
    observation: Object.freeze(structuredClone(observation)),
  });
};

export const buildArtifactControlStoreDrillClosure = ({
  capture,
  runId,
  runAttempt,
  cleanup,
}) => {
  const observation = capture?.observation;
  if (
    !RUN_ID.test(runId ?? "") ||
    !RUN_ID.test(runAttempt ?? "") ||
    !Array.isArray(capture?.objects) ||
    capture.objects.length < 3 ||
    !exactKeys(cleanup, [
      "administratorRoleSha256",
      "databaseEndpointSha256",
      "kind",
      "namespace",
      "observedAt",
      "removed",
      "schemaVersion",
    ]) ||
    cleanup.schemaVersion !== 1 ||
    cleanup.kind !== "artifact-drill-database-cleanup-receipt/v1" ||
    cleanup.administratorRoleSha256 !== capture.administratorRoleSha256 ||
    cleanup.databaseEndpointSha256 !== capture.databaseEndpointSha256 ||
    cleanup.namespace !== observation?.drillNamespace ||
    cleanup.removed !== true ||
    !SHA256.test(cleanup.databaseEndpointSha256 ?? "") ||
    !SHA256.test(cleanup.administratorRoleSha256 ?? "")
  ) {
    throw new Error("Artifact drill closure authority or cleanup is invalid");
  }
  assertArtifactControlStoreDrillObservation(observation);
  const closure = {
    schemaVersion: 1,
    kind: "artifact-provider-control-store-drill-closure/v1",
    productionNamespace: observation.productionNamespace,
    drillNamespace: observation.drillNamespace,
    sourceSha: observation.sourceSha,
    runId,
    runAttempt,
    observedAt: observation.observedAt,
    cleanup: { ...cleanup },
    observation: structuredClone(observation),
    objects: capture.objects.map((value) => ({ ...value })),
  };
  const bytes = canonicalJsonBytes(closure);
  if (bytes.length === 0 || bytes.length > MAXIMUM_CLOSURE_BYTES) {
    throw new Error("Artifact drill closure is empty or oversized");
  }
  return Object.freeze({
    bytes,
    closure: Object.freeze(closure),
    mediaType: ARTIFACT_CONTROL_STORE_DRILL_CLOSURE_MEDIA_TYPE,
    sha256: sha256Bytes(bytes),
  });
};

const decodeObjects = (closure) => {
  if (!Array.isArray(closure.objects) || closure.objects.length < 3) {
    throw new Error("Artifact drill closure object set is absent");
  }
  const objects = new Map();
  let previous = null;
  for (const object of closure.objects) {
    if (
      !exactKeys(object, [
        "bytesBase64",
        "committedAt",
        "mediaType",
        "sha256",
      ]) ||
      !SHA256.test(object.sha256 ?? "") ||
      typeof object.bytesBase64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
        object.bytesBase64,
      ) ||
      typeof object.mediaType !== "string" ||
      !object.mediaType.startsWith("application/") ||
      (previous !== null && previous.localeCompare(object.sha256) >= 0)
    ) {
      throw new Error("Artifact drill closure object metadata is invalid");
    }
    canonicalTimestamp(
      object.committedAt,
      "Artifact drill closure object commit",
    );
    const bytes = Buffer.from(object.bytesBase64, "base64");
    if (
      bytes.length === 0 ||
      bytes.length > MAXIMUM_OBJECT_BYTES ||
      bytes.toString("base64") !== object.bytesBase64 ||
      sha256Bytes(bytes) !== object.sha256
    ) {
      throw new Error("Artifact drill closure object bytes differ");
    }
    objects.set(object.sha256, {
      bytes,
      committedAt: object.committedAt,
      mediaType: object.mediaType,
    });
    previous = object.sha256;
  }
  return objects;
};

export const readArtifactControlStoreDrillClosure = async (
  {
    bytes,
    approvalPolicy,
    providerPolicy,
    expectedSourceSha,
    expectedRunId,
    expectedRunAttempt,
    artifactDrillPolicy,
    releasePolicy = null,
    toolchainPolicy = null,
    dbContract = null,
    cspPolicy = null,
    foundationBaseline = null,
  },
  {
    readOidcAuthority = readStoredProductionRequestGraphOidcAuthority,
    validateProviderObservation = ({
      observation,
      providerPolicy,
      cspMode,
    }) => {
      assertVercelObservationEvidence(observation, providerPolicy);
      assertProductionProviderContext(providerPolicy, observation, { cspMode });
    },
  } = {},
) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAXIMUM_CLOSURE_BYTES
  ) {
    throw new Error("Artifact drill closure bytes are invalid");
  }
  const closure = parseJsonStrict(
    bytes.toString("utf8"),
    "Artifact drill closure",
  );
  if (
    !bytes.equals(canonicalJsonBytes(closure)) ||
    !exactKeys(closure, [
      "cleanup",
      "drillNamespace",
      "kind",
      "objects",
      "observation",
      "observedAt",
      "productionNamespace",
      "runAttempt",
      "runId",
      "schemaVersion",
      "sourceSha",
    ]) ||
    closure.schemaVersion !== 1 ||
    closure.kind !== "artifact-provider-control-store-drill-closure/v1" ||
    closure.sourceSha !== expectedSourceSha ||
    closure.runId !== expectedRunId ||
    closure.runAttempt !== expectedRunAttempt ||
    closure.observedAt !== closure.observation?.observedAt ||
    closure.productionNamespace !== closure.observation?.productionNamespace ||
    closure.drillNamespace !== closure.observation?.drillNamespace ||
    !exactKeys(closure.cleanup, [
      "administratorRoleSha256",
      "databaseEndpointSha256",
      "kind",
      "namespace",
      "observedAt",
      "removed",
      "schemaVersion",
    ]) ||
    closure.cleanup.schemaVersion !== 1 ||
    closure.cleanup.kind !== "artifact-drill-database-cleanup-receipt/v1" ||
    closure.cleanup.namespace !== closure.drillNamespace ||
    closure.cleanup.removed !== true ||
    !SHA256.test(closure.cleanup.databaseEndpointSha256 ?? "") ||
    !SHA256.test(closure.cleanup.administratorRoleSha256 ?? "")
  ) {
    throw new Error("Artifact drill closure identity is invalid");
  }
  canonicalTimestamp(closure.observedAt, "Artifact drill closure observation");
  canonicalTimestamp(
    closure.cleanup.observedAt,
    "Artifact drill database cleanup observation",
  );
  assertArtifactControlStoreDrillObservation(closure.observation);
  const objects = decodeObjects(closure);
  const store = {
    namespace: closure.drillNamespace,
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { ...stored, bytes: Buffer.from(stored.bytes) };
    },
  };
  const forbiddenAliases = [
    ...(providerPolicy.ownedProductionDomains ?? []),
    ...(providerPolicy.productionDomains ?? []),
    ...(providerPolicy.productionAliases ?? []),
  ];
  const authority = {
    productionNamespace: closure.productionNamespace,
    forbiddenAliases,
    aliasSuffix: artifactDrillPolicy?.providerPreviewAliasSuffix,
    providerPolicy,
  };
  const raw = await readStoredArtifactControlStoreDrill({
    store,
    reference: closure.observation.rawTranscript,
    authority,
  });
  if (
    !canonicalJsonBytes(raw.raw.productionProviderObservation).equals(
      canonicalJsonBytes(closure.observation.productionProviderObservation),
    )
  ) {
    throw new Error("Artifact drill production provider reference differs");
  }
  const providerObject = objects.get(
    closure.observation.productionProviderObservation.sha256,
  );
  if (
    providerObject?.mediaType !==
      closure.observation.productionProviderObservation.mediaType ||
    providerObject.mediaType !== VERCEL_PROVIDER_OBSERVATION_MEDIA_TYPE ||
    providerObject.committedAt !==
      closure.observation.productionProviderObservation.committedAt ||
    !Buffer.isBuffer(providerObject.bytes) ||
    providerObject.bytes.length !==
      closure.observation.productionProviderObservation.byteLength
  ) {
    throw new Error("Artifact drill production provider authority is absent");
  }
  const productionProviderObservation = parseJsonStrict(
    providerObject.bytes.toString("utf8"),
    "Artifact drill production provider observation",
  );
  if (
    !providerObject.bytes.equals(
      canonicalJsonBytes(productionProviderObservation),
    )
  ) {
    throw new Error(
      "Artifact drill production provider observation is not canonical",
    );
  }
  validateProviderObservation({
    observation: productionProviderObservation,
    providerPolicy,
    cspMode: releasePolicy?.initialStandard?.cspMode ?? null,
  });
  if (raw.raw.sourceSha !== expectedSourceSha) {
    throw new Error("Artifact drill closure raw source differs");
  }
  if (
    raw.raw.authority.databaseEndpointSha256 !==
      closure.cleanup.databaseEndpointSha256 ||
    raw.raw.authority.collectorIdentity.repository !==
      approvalPolicy?.repository ||
    raw.raw.authority.collectorIdentity.sourceSha !== expectedSourceSha ||
    raw.raw.authority.collectorIdentity.runId !== expectedRunId ||
    raw.raw.authority.collectorIdentity.runAttempt !== expectedRunAttempt ||
    !canonicalJsonBytes(raw.raw.authority.collectorIdentity).equals(
      canonicalJsonBytes(closure.observation.collectorIdentity),
    )
  ) {
    throw new Error("Artifact drill closure semantic authority differs");
  }
  const operationReceipts = await readArtifactDrillOperationReceipts({
    store,
    operations: raw.raw,
    aliasSuffix: artifactDrillPolicy?.providerPreviewAliasSuffix,
    forbiddenAliases,
    providerPolicy,
  });
  const buildReceipts = operationReceipts
    .filter(
      ({ mediaType }) => mediaType === ARTIFACT_DRILL_BUILD_RECEIPT_MEDIA_TYPE,
    )
    .map(({ receipt }) => receipt)
    .sort((left, right) => left.attempt - right.attempt);
  if (
    buildReceipts.length !== 2 ||
    !canonicalJsonBytes(buildReceipts[0].buildAuthority).equals(
      canonicalJsonBytes(buildReceipts[1].buildAuthority),
    )
  ) {
    throw new Error("Artifact drill build authority pair differs");
  }
  const currentInputs = [
    releasePolicy,
    toolchainPolicy,
    dbContract,
    cspPolicy,
    foundationBaseline,
  ];
  if (currentInputs.every((value) => value !== null)) {
    const bootstrapVerification = buildReceipts[0].bootstrapVerification;
    const expectedBootstrapSource =
      foundationBaseline.bootstrapBaselineSourceSha;
    const expectedRawDistManifest =
      foundationBaseline.external?.bootstrapBaseline?.rawDistManifestSha256 ??
      foundationBaseline.baselineEvidence?.artifactObservation
        ?.rawDistManifestSha256;
    if (
      bootstrapVerification.sourceSha !== expectedBootstrapSource ||
      bootstrapVerification.rawDistManifestSha256 !== expectedRawDistManifest ||
      raw.raw.authority.databasePolicySha256 !==
        sha256Json(artifactDrillPolicy) ||
      raw.raw.authority.providerPolicySha256 !== sha256Json(providerPolicy) ||
      raw.raw.authority.toolchainSha256 !== sha256Json(toolchainPolicy)
    ) {
      throw new Error(
        "Artifact drill current bootstrap or execution authority differs",
      );
    }
    for (const receipt of buildReceipts) {
      assertArtifactDrillBuildAuthority(receipt.buildAuthority.document, {
        sourceSha: expectedSourceSha,
        releasePolicy,
        toolchainPolicy,
        providerPolicy,
        providerObservation: productionProviderObservation,
        dbContract,
        cspPolicy,
        foundationBaseline,
        bootstrapVerification,
      });
    }
  }
  const controlStoreReceipt = operationReceipts.find(
    ({ mediaType }) =>
      mediaType === ARTIFACT_DRILL_CONTROL_STORE_RECEIPT_MEDIA_TYPE,
  )?.receipt;
  if (
    controlStoreReceipt?.administratorRoleSha256 !==
    closure.cleanup.administratorRoleSha256
  ) {
    throw new Error("Artifact drill cleanup administrator authority differs");
  }
  await readOidcAuthority({
    store,
    namespace: closure.drillNamespace,
    reference: closure.observation.oidcReceipt,
    approvalPolicy,
    sourceSha: expectedSourceSha,
    runId: expectedRunId,
    runAttempt: expectedRunAttempt,
  });
  const expectedHashes = new Set([
    closure.observation.oidcReceipt.sha256,
    closure.observation.productionProviderObservation.sha256,
    closure.observation.rawTranscript.sha256,
    ...artifactDrillOperationReceiptHashes(raw.raw),
  ]);
  if (
    expectedHashes.size !== objects.size ||
    [...objects.keys()].some((sha256) => !expectedHashes.has(sha256)) ||
    objects.get(closure.observation.rawTranscript.sha256)?.mediaType !==
      ARTIFACT_CONTROL_STORE_DRILL_RAW_MEDIA_TYPE
  ) {
    throw new Error("Artifact drill closure contains missing or extra objects");
  }
  return Object.freeze({
    closure: Object.freeze(structuredClone(closure)),
    result: Object.freeze({ ...raw.result }),
    productionProviderObservation: Object.freeze(
      structuredClone(productionProviderObservation),
    ),
    sha256: sha256Bytes(bytes),
  });
};
