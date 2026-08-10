import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
  PHASE_EXIT_EXTERNAL_AUTHORITIES,
  resolveExternalPhaseExitAuthorities,
} from "../lib/phase-exit-external-authority.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAXIMUM_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 16 * 1024 * 1024;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");

const assertValidationOptions = (options) => {
  if (
    !exactKeys(options, [
      "store",
      "current",
      "sourceSha",
      "currentWorkflowRunId",
      "bundleBytes",
      "expectedBundleSha256",
      "evidenceBytesByAuthority",
      "providerPolicy",
      "approvalPolicy",
      "storePolicy",
      "databaseContract",
      "retentionPolicy",
      "startupBurstContract",
      "cspPolicy",
      "backupRestorePrerequisitePolicy",
      "backupRestoreProviderContract",
      "artifactDrillPolicy",
      "p0aPolicy",
      "releasePolicy",
      "toolchainPolicy",
      "foundationBaseline",
    ]) ||
    typeof options.store?.putEvidence !== "function" ||
    typeof options.store?.readEvidence !== "function" ||
    typeof options.store?.namespace !== "string" ||
    !SOURCE_SHA_PATTERN.test(options.sourceSha ?? "") ||
    !/^[1-9][0-9]{0,19}$/u.test(options.currentWorkflowRunId ?? "") ||
    !Buffer.isBuffer(options.bundleBytes) ||
    options.bundleBytes.length === 0 ||
    options.bundleBytes.length > MAXIMUM_BUNDLE_BYTES ||
    !SHA256_PATTERN.test(options.expectedBundleSha256 ?? "") ||
    !(options.evidenceBytesByAuthority instanceof Map)
  ) {
    throw new Error("Phase authority bundle validation options are invalid");
  }
};

const assertPublisherOptions = (options) => {
  assertValidationOptions(options);
  if (typeof options.store?.putEvidence !== "function") {
    throw new Error("Phase authority publisher options are invalid");
  }
};

const parseCanonicalBundle = (bytes, expectedSha256) => {
  if (sha256Bytes(bytes) !== expectedSha256) {
    throw new Error("Phase authority bundle differs from its reviewed SHA-256");
  }
  const bundle = parseJsonStrict(
    bytes.toString("utf8"),
    "Phase authority bundle input",
  );
  if (!bytes.equals(canonicalJsonBytes(bundle))) {
    throw new Error("Phase authority bundle input is not canonical JSON");
  }
  if (
    !isRecord(bundle) ||
    !Array.isArray(bundle.entries) ||
    bundle.entries.length === 0
  ) {
    throw new Error("Phase authority bundle entry set is absent");
  }
  return bundle;
};

const authorityDefinitions = new Map(
  PHASE_EXIT_EXTERNAL_AUTHORITIES.map((definition) => [
    definition.authority,
    definition,
  ]),
);

const createLocalObjects = ({
  bundle,
  bundleBytes,
  evidenceBytesByAuthority,
}) => {
  const expectedAuthorities = bundle.entries.map(({ authority }) => authority);
  const requiredTargetAuthorities = PHASE_EXIT_EXTERNAL_AUTHORITIES.filter(
    ({ gate, collectorImplemented }) =>
      gate === bundle.targetGate && collectorImplemented,
  ).map(({ authority }) => authority);
  if (
    requiredTargetAuthorities.length === 0 ||
    JSON.stringify(expectedAuthorities) !==
      JSON.stringify(requiredTargetAuthorities) ||
    expectedAuthorities.some(
      (authority) => !authorityDefinitions.has(authority),
    ) ||
    new Set(expectedAuthorities).size !== expectedAuthorities.length ||
    evidenceBytesByAuthority.size !== expectedAuthorities.length ||
    [...evidenceBytesByAuthority.keys()].some(
      (authority) => !expectedAuthorities.includes(authority),
    )
  ) {
    throw new Error(
      "Phase authority evidence file set differs from the exact target gate",
    );
  }
  const localObjects = new Map();
  const localCommittedAt = new Date().toISOString();
  for (const entry of bundle.entries) {
    const definition = authorityDefinitions.get(entry.authority);
    const bytes = evidenceBytesByAuthority.get(entry.authority);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0 ||
      bytes.length > MAXIMUM_EVIDENCE_BYTES ||
      !isRecord(entry.evidence) ||
      sha256Bytes(bytes) !== entry.evidence.sha256
    ) {
      throw new Error(
        `${entry.authority}: evidence bytes differ from the bundle reference`,
      );
    }
    localObjects.set(entry.evidence.sha256, {
      bytes: Buffer.from(bytes),
      mediaType: definition.mediaType,
      committedAt: localCommittedAt,
    });
  }
  localObjects.set(sha256Bytes(bundleBytes), {
    bytes: Buffer.from(bundleBytes),
    mediaType: PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
    committedAt: localCommittedAt,
  });
  return localObjects;
};

const resolverOptions = (options, store) => ({
  store,
  bundleSha256: options.expectedBundleSha256,
  current: options.current,
  sourceSha: options.sourceSha,
  providerPolicy: options.providerPolicy,
  approvalPolicy: options.approvalPolicy,
  storePolicy: options.storePolicy,
  databaseContract: options.databaseContract,
  retentionPolicy: options.retentionPolicy,
  startupBurstContract: options.startupBurstContract,
  cspPolicy: options.cspPolicy,
  backupRestorePrerequisitePolicy: options.backupRestorePrerequisitePolicy,
  backupRestoreProviderContract: options.backupRestoreProviderContract,
  artifactDrillPolicy: options.artifactDrillPolicy,
  p0aPolicy: options.p0aPolicy,
  releasePolicy: options.releasePolicy,
  toolchainPolicy: options.toolchainPolicy,
  foundationBaseline: options.foundationBaseline,
  currentWorkflowRunId: options.currentWorkflowRunId,
});

const putAndReadExact = async ({
  store,
  namespace,
  bytes,
  mediaType,
  label,
}) => {
  const sha256 = sha256Bytes(bytes);
  const expectedUri = `release-state://${namespace}/evidence/${sha256}`;
  const receipt = await store.putEvidence({ bytes, mediaType });
  const stored = await store.readEvidence({ sha256 });
  if (
    receipt?.uri !== expectedUri ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== mediaType ||
    receipt.byteLength !== bytes.length ||
    typeof receipt.replayed !== "boolean" ||
    !Buffer.isBuffer(stored?.bytes) ||
    !stored.bytes.equals(bytes) ||
    stored.mediaType !== mediaType ||
    stored.committedAt !== receipt.committedAt
  ) {
    throw new Error(`${label} immutable-store put/readback differs`);
  }
  return {
    reference: { uri: expectedUri, sha256 },
    receipt,
  };
};

export const validatePhaseExitAuthorityBundle = async (options) => {
  assertValidationOptions(options);
  const bundle = parseCanonicalBundle(
    options.bundleBytes,
    options.expectedBundleSha256,
  );
  const localObjects = createLocalObjects({
    bundle,
    bundleBytes: options.bundleBytes,
    evidenceBytesByAuthority: options.evidenceBytesByAuthority,
  });
  const overlayStore = {
    namespace: options.store.namespace,
    putEvidence: options.store.putEvidence.bind(options.store),
    async readEvidence({ sha256 }) {
      const local = localObjects.get(sha256);
      return local === undefined
        ? options.store.readEvidence({ sha256 })
        : { ...local, bytes: Buffer.from(local.bytes) };
    },
  };

  const resolved = await resolveExternalPhaseExitAuthorities(
    resolverOptions(options, overlayStore),
  );
  return Object.freeze({
    bundle: Object.freeze(structuredClone(bundle)),
    resolved,
  });
};

export const publishPhaseExitAuthorityBundle = async (options) => {
  assertPublisherOptions(options);
  const validated = await validatePhaseExitAuthorityBundle(options);
  const bundle = validated.bundle;

  const evidenceReceipts = await Promise.all(
    bundle.entries.map((entry) => {
      const definition = authorityDefinitions.get(entry.authority);
      return putAndReadExact({
        store: options.store,
        namespace: options.store.namespace,
        bytes: options.evidenceBytesByAuthority.get(entry.authority),
        mediaType: definition.mediaType,
        label: `${entry.gate}/${entry.authority}`,
      });
    }),
  );
  const bundleStored = await putAndReadExact({
    store: options.store,
    namespace: options.store.namespace,
    bytes: options.bundleBytes,
    mediaType: PHASE_EXIT_AUTHORITY_BUNDLE_MEDIA_TYPE,
    label: "Phase authority bundle",
  });
  const resolved = await resolveExternalPhaseExitAuthorities(
    resolverOptions(options, options.store),
  );
  if (
    resolved.bundle.sha256 !== bundleStored.reference.sha256 ||
    resolved.references.length !== evidenceReceipts.length
  ) {
    throw new Error("Published phase authority bundle resolution differs");
  }
  return Object.freeze({
    bundle: Object.freeze({
      reference: Object.freeze({ ...bundleStored.reference }),
      receipt: Object.freeze({ ...bundleStored.receipt }),
    }),
    evidenceReceipts: Object.freeze(
      evidenceReceipts.map(({ reference, receipt }) =>
        Object.freeze({
          reference: Object.freeze({ ...reference }),
          receipt: Object.freeze({ ...receipt }),
        }),
      ),
    ),
    resolved,
  });
};
