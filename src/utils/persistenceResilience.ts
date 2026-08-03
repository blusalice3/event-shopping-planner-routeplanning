export const RUNTIME_FALLBACK_NAMESPACE = "esp:idb-fallback:v1";
export const PERSISTENCE_METADATA_NAMESPACE = "__esp_internal__:meta:v1";
export const PERSISTENCE_CHECKPOINT_NAMESPACE =
  "__esp_internal__:checkpoint:v1";
export const PERSISTENCE_CHECKPOINT_KIND =
  "event-shopping-planner-persistence-checkpoint" as const;
export const PERSISTENCE_CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const PERSISTENCE_RECOVERY_KIND =
  "event-shopping-planner-persistence-recovery" as const;

const CANONICALIZATION_VERSION = "esp-json-v1" as const;
const DIGEST_ALGORITHM = "SHA-256" as const;
const FALLBACK_SCHEMA_VERSION = 1 as const;
const FNV_64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;
const FNV_64_MASK = 0xffffffffffffffffn;
const MAX_RECOVERY_SNAPSHOT_DEPTH = 100;
const MAX_RECOVERY_ARRAY_ITEMS = 100_000;

export class PersistenceSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataCloneError";
  }
}

export class PersistenceEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceEnvelopeError";
  }
}

export interface PersistenceDigestDescriptor {
  algorithm: typeof DIGEST_ALGORITHM;
  canonicalization: typeof CANONICALIZATION_VERSION;
  value: string;
}

export interface PersistenceSynchronousFingerprint {
  algorithm: "FNV-1A-64";
  canonicalization: typeof CANONICALIZATION_VERSION;
  canonicalLength: number;
  value: string;
}

export interface RuntimeFallbackCandidate<T = unknown> {
  schemaVersion: typeof FALLBACK_SCHEMA_VERSION;
  storeName: string;
  key: string;
  revision: string;
  baseRevision: string | null;
  writerId: string;
  createdAt: string;
  digest: PersistenceDigestDescriptor;
  payload: T;
}

export interface PersistenceCheckpointCommittedRoot {
  revision: string;
  baseRevision: string | null;
  digest: PersistenceDigestDescriptor;
  writerId: string;
  committedAt: string;
}

export interface PersistenceCheckpointAbsorbedCandidate {
  schemaVersion: typeof FALLBACK_SCHEMA_VERSION;
  revision: string;
  baseRevision: string | null;
  digest: PersistenceDigestDescriptor;
  writerId: string;
  createdAt: string;
}

export interface PersistenceCheckpoint {
  kind: typeof PERSISTENCE_CHECKPOINT_KIND;
  version: typeof PERSISTENCE_CHECKPOINT_SCHEMA_VERSION;
  storeName: string;
  key: string;
  committedRoot: PersistenceCheckpointCommittedRoot;
  absorbedCandidates: PersistenceCheckpointAbsorbedCandidate[];
  updatedAt: string;
}

export interface StartupRecoveryIssue {
  stage: string;
  code: string;
  message: string;
  storeName?: string;
  key?: string;
}

export type StartupRecoveryCandidateSource =
  | "legacy-localStorage"
  | "indexedDB"
  | "runtime-fallback"
  | "migration-journal";

export type StartupRecoveryCandidateRole =
  | "app-payload"
  | "persistence-metadata"
  | "persistence-checkpoint"
  | "legacy-migration-source"
  | "migration-journal"
  | "migration-archive"
  | "invalid-source";

export interface StartupRecoveryCandidate {
  id: string;
  source: StartupRecoveryCandidateSource;
  role?: StartupRecoveryCandidateRole;
  adoptable?: boolean;
  storeName?: string;
  key?: string;
  sourceKey?: string;
  targetKey?: string;
  revision?: string;
  digest?: string;
  digestAlgorithm?: "SHA-256" | "FNV-1A-64";
  digestCanonicalization?: "esp-json-v1";
  digestCanonicalLength?: number;
  payload?: unknown;
  rawValue?: string;
}

export type StartupRecoveryCandidateIdentity = Pick<
  StartupRecoveryCandidate,
  | "source"
  | "role"
  | "storeName"
  | "sourceKey"
  | "targetKey"
  | "revision"
  | "digest"
  | "digestAlgorithm"
  | "digestCanonicalization"
  | "digestCanonicalLength"
>;

export interface StartupRecoveryBundle {
  kind: typeof PERSISTENCE_RECOVERY_KIND;
  version: 1;
  capturedAt: string;
  issues: StartupRecoveryIssue[];
  candidates: StartupRecoveryCandidate[];
}

type RuntimeFallbackCurrentRevision = {
  revision: string | null;
  baseRevision: string | null;
  digest?: PersistenceDigestDescriptor;
  writerId?: string;
  createdAt?: string;
};

export type RuntimeFallbackReconciliation<T = unknown> =
  | {
      status: "resolved";
      head: RuntimeFallbackCandidate<T> | null;
      headRevision: string | null;
      chain: RuntimeFallbackCandidate<T>[];
      staleCandidates: RuntimeFallbackCandidate<T>[];
    }
  | {
      status: "conflict";
      reason:
        | "duplicate-revision"
        | "same-revision-different-payload"
        | "same-revision-different-metadata"
        | "mixed-record"
        | "unknown-parent"
        | "branch"
        | "ancestor-branch"
        | "ancestor-cycle";
      conflictingCandidates: RuntimeFallbackCandidate<T>[];
      staleCandidates: RuntimeFallbackCandidate<T>[];
    };

let revisionCounter = 0;
let cachedWriterId: string | null = null;

const failSerialization = (path: string, reason: string): never => {
  throw new PersistenceSerializationError(
    `Persistence payload is not JSON-compatible at ${path}: ${reason}.`,
  );
};

const serializeCanonicalValue = (
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): string => {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        return failSerialization(path, "non-finite numbers are not supported");
      }
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return failSerialization(
        path,
        `${typeof value} values are not supported`,
      );
    case "object":
      break;
    default:
      return failSerialization(path, "unsupported value");
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    return failSerialization(path, "cyclic references are not supported");
  }
  ancestors.add(objectValue);

  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return failSerialization(path, "symbol keys are not supported");
      }
      const expectedKeys = Array.from({ length: value.length }, (_, index) =>
        String(index),
      );
      const actualKeys = Object.getOwnPropertyNames(value).filter(
        (key) => key !== "length",
      );
      if (
        actualKeys.length !== expectedKeys.length ||
        actualKeys.some((key, index) => key !== expectedKeys[index])
      ) {
        return failSerialization(
          path,
          "array properties other than dense indices are not supported",
        );
      }
      const serializedItems: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          return failSerialization(
            `${path}[${index}]`,
            "sparse array entries are not supported",
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          return failSerialization(
            `${path}[${index}]`,
            "accessor properties are not supported",
          );
        }
        serializedItems.push(
          serializeCanonicalValue(
            descriptor.value,
            `${path}[${index}]`,
            ancestors,
          ),
        );
      }
      return `[${serializedItems.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return failSerialization(path, "only plain objects are supported");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return failSerialization(path, "symbol keys are not supported");
    }

    const record = value as Record<string, unknown>;
    const propertyNames = Object.getOwnPropertyNames(record).sort();
    const serializedEntries: string[] = [];
    propertyNames.forEach((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return failSerialization(
          `${path}.${key}`,
          "non-enumerable and accessor properties are not supported",
        );
      }
      if (descriptor.value === undefined) {
        return;
      }
      serializedEntries.push(
        `${JSON.stringify(key)}:${serializeCanonicalValue(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
        )}`,
      );
    });
    return `{${serializedEntries.join(",")}}`;
  } finally {
    ancestors.delete(objectValue);
  }
};

export function canonicalStringifyPersistencePayload(value: unknown): string {
  return serializeCanonicalValue(value, "$", new WeakSet<object>());
}

const encodeHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function createPersistenceDigest(
  payload: unknown,
): Promise<PersistenceDigestDescriptor> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const error = new Error(
      "Web Crypto SHA-256 is required for resilient persistence.",
    );
    error.name = "NotSupportedError";
    throw error;
  }

  const canonical = canonicalStringifyPersistencePayload(payload);
  const digest = await subtle.digest(
    DIGEST_ALGORITHM,
    new TextEncoder().encode(canonical),
  );
  return {
    algorithm: DIGEST_ALGORITHM,
    canonicalization: CANONICALIZATION_VERSION,
    value: encodeHex(new Uint8Array(digest)),
  };
}

export function createSynchronousFingerprint(
  payload: unknown,
): PersistenceSynchronousFingerprint {
  const canonical = canonicalStringifyPersistencePayload(payload);
  const bytes = new TextEncoder().encode(canonical);
  let hash = FNV_64_OFFSET_BASIS;
  bytes.forEach((byte) => {
    hash ^= BigInt(byte);
    hash = (hash * FNV_64_PRIME) & FNV_64_MASK;
  });
  return {
    algorithm: "FNV-1A-64",
    canonicalization: CANONICALIZATION_VERSION,
    canonicalLength: canonical.length,
    value: hash.toString(16).padStart(16, "0"),
  };
}

export function createStartupRecoveryCandidateId(
  identity: StartupRecoveryCandidateIdentity,
): string {
  const fingerprint = createSynchronousFingerprint(identity);
  return [
    "esp-recovery-candidate",
    fingerprint.algorithm,
    fingerprint.value,
    fingerprint.canonicalLength,
  ].join(":");
}

export function isPersistenceDigestDescriptor(
  value: unknown,
): value is PersistenceDigestDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "algorithm" ||
    keys[1] !== "canonicalization" ||
    keys[2] !== "value"
  ) {
    return false;
  }
  return (
    (value as Partial<PersistenceDigestDescriptor>).algorithm ===
      DIGEST_ALGORITHM &&
    (value as Partial<PersistenceDigestDescriptor>).canonicalization ===
      CANONICALIZATION_VERSION &&
    typeof (value as Partial<PersistenceDigestDescriptor>).value === "string" &&
    /^[0-9a-f]{64}$/.test(
      (value as Partial<PersistenceDigestDescriptor>).value ?? "",
    )
  );
}

export function isPersistenceSynchronousFingerprint(
  value: unknown,
): value is PersistenceSynchronousFingerprint {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "algorithm" ||
    keys[1] !== "canonicalLength" ||
    keys[2] !== "canonicalization" ||
    keys[3] !== "value"
  ) {
    return false;
  }
  const candidate = value as Partial<PersistenceSynchronousFingerprint>;
  return (
    candidate.algorithm === "FNV-1A-64" &&
    candidate.canonicalization === CANONICALIZATION_VERSION &&
    typeof candidate.canonicalLength === "number" &&
    Number.isSafeInteger(candidate.canonicalLength) &&
    candidate.canonicalLength >= 0 &&
    typeof candidate.value === "string" &&
    /^[0-9a-f]{16}$/.test(candidate.value)
  );
}

export async function verifyPersistenceDigest(
  payload: unknown,
  expected: PersistenceDigestDescriptor,
): Promise<boolean> {
  if (!isPersistenceDigestDescriptor(expected)) return false;
  const actual = await createPersistenceDigest(payload);
  return actual.value === expected.value;
}

const randomHex = (byteLength: number): string => {
  const bytes = new Uint8Array(byteLength);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return encodeHex(bytes);
};

export function getPersistenceWriterId(): string {
  if (!cachedWriterId) {
    cachedWriterId =
      globalThis.crypto?.randomUUID?.() ?? `writer-${randomHex(16)}`;
  }
  return cachedWriterId;
}

// This is an opaque, unique causal token. Cross-tab ordering is determined only
// by the envelope's baseRevision graph; clock or lexical order is never trusted.
export function createPersistenceRevision(
  writerId = getPersistenceWriterId(),
): string {
  revisionCounter = (revisionCounter + 1) % Number.MAX_SAFE_INTEGER;
  return [
    Date.now().toString(36).padStart(10, "0"),
    revisionCounter.toString(36).padStart(6, "0"),
    writerId,
    randomHex(8),
  ].join("-");
}

export function createSyntheticLegacyRevision(
  digest: PersistenceDigestDescriptor,
): string {
  if (!isPersistenceDigestDescriptor(digest)) {
    throw new PersistenceEnvelopeError(
      "Cannot create a legacy revision from an unsupported digest.",
    );
  }
  return `legacy:${digest.value}`;
}

export function createRuntimeFallbackPrefix(
  storeName: string,
  key: string,
): string {
  return `${RUNTIME_FALLBACK_NAMESPACE}:${encodeURIComponent(
    storeName,
  )}:${encodeURIComponent(key)}:`;
}

export function createRuntimeFallbackKey(
  storeName: string,
  key: string,
  revision: string,
): string {
  return `${createRuntimeFallbackPrefix(storeName, key)}${encodeURIComponent(
    revision,
  )}`;
}

export function createPersistenceMetadataKey(
  storeName: string,
  key: string,
): string {
  return `${PERSISTENCE_METADATA_NAMESPACE}:${encodeURIComponent(
    storeName,
  )}:${encodeURIComponent(key)}`;
}

export function createPersistenceCheckpointKey(
  storeName: string,
  key: string,
): string {
  return `${PERSISTENCE_CHECKPOINT_NAMESPACE}:${encodeURIComponent(
    storeName,
  )}:${encodeURIComponent(key)}`;
}

const hasExactCheckpointKeys = (
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every(
      (actualKey, index) => actualKey === sortedExpectedKeys[index],
    )
  );
};

const isNonEmptyCheckpointString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isCheckpointBaseRevision = (value: unknown): value is string | null =>
  value === null || isNonEmptyCheckpointString(value);

const isCheckpointTimestamp = (value: unknown): value is string =>
  isNonEmptyCheckpointString(value) && Number.isFinite(Date.parse(value));

const isPersistenceCheckpointCommittedRoot = (
  value: unknown,
): value is PersistenceCheckpointCommittedRoot => {
  if (
    !hasExactCheckpointKeys(value, [
      "revision",
      "baseRevision",
      "digest",
      "writerId",
      "committedAt",
    ])
  ) {
    return false;
  }
  return (
    isNonEmptyCheckpointString(value.revision) &&
    isCheckpointBaseRevision(value.baseRevision) &&
    isPersistenceDigestDescriptor(value.digest) &&
    isNonEmptyCheckpointString(value.writerId) &&
    isCheckpointTimestamp(value.committedAt)
  );
};

const isPersistenceCheckpointAbsorbedCandidate = (
  value: unknown,
): value is PersistenceCheckpointAbsorbedCandidate => {
  if (
    !hasExactCheckpointKeys(value, [
      "schemaVersion",
      "revision",
      "baseRevision",
      "digest",
      "writerId",
      "createdAt",
    ])
  ) {
    return false;
  }
  return (
    value.schemaVersion === FALLBACK_SCHEMA_VERSION &&
    isNonEmptyCheckpointString(value.revision) &&
    isCheckpointBaseRevision(value.baseRevision) &&
    isPersistenceDigestDescriptor(value.digest) &&
    isNonEmptyCheckpointString(value.writerId) &&
    isCheckpointTimestamp(value.createdAt)
  );
};

export function isPersistenceCheckpoint(
  value: unknown,
  expected: { storeName?: string; key?: string } = {},
): value is PersistenceCheckpoint {
  if (
    !hasExactCheckpointKeys(value, [
      "kind",
      "version",
      "storeName",
      "key",
      "committedRoot",
      "absorbedCandidates",
      "updatedAt",
    ]) ||
    value.kind !== PERSISTENCE_CHECKPOINT_KIND ||
    value.version !== PERSISTENCE_CHECKPOINT_SCHEMA_VERSION ||
    !isNonEmptyCheckpointString(value.storeName) ||
    !isNonEmptyCheckpointString(value.key) ||
    (expected.storeName !== undefined &&
      value.storeName !== expected.storeName) ||
    (expected.key !== undefined && value.key !== expected.key) ||
    !isPersistenceCheckpointCommittedRoot(value.committedRoot) ||
    !Array.isArray(value.absorbedCandidates) ||
    !value.absorbedCandidates.every(isPersistenceCheckpointAbsorbedCandidate) ||
    !isCheckpointTimestamp(value.updatedAt)
  ) {
    return false;
  }

  const absorbedRevisions = new Set<string>();
  for (const candidate of value.absorbedCandidates) {
    if (absorbedRevisions.has(candidate.revision)) {
      return false;
    }
    absorbedRevisions.add(candidate.revision);
  }
  return true;
}

const cloneCanonicalPayload = <T>(payload: T): T =>
  JSON.parse(canonicalStringifyPersistencePayload(payload)) as T;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.values(value as Record<string, unknown>).forEach((child) => {
    deepFreeze(child, seen);
  });
  return Object.freeze(value);
};

export async function createRuntimeFallbackCandidate<T>({
  storeName,
  key,
  revision = createPersistenceRevision(),
  baseRevision,
  writerId = getPersistenceWriterId(),
  createdAt = new Date().toISOString(),
  payload,
}: {
  storeName: string;
  key: string;
  revision?: string;
  baseRevision: string | null;
  writerId?: string;
  createdAt?: string;
  payload: T;
}): Promise<RuntimeFallbackCandidate<T>> {
  const canonicalPayload = cloneCanonicalPayload(payload);
  const digest = await createPersistenceDigest(canonicalPayload);
  return deepFreeze({
    schemaVersion: FALLBACK_SCHEMA_VERSION,
    storeName,
    key,
    revision,
    baseRevision,
    writerId,
    createdAt,
    digest,
    payload: canonicalPayload,
  });
}

const assertExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void => {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new PersistenceEnvelopeError(
      "Runtime fallback envelope contains missing or unsupported fields.",
    );
  }
};

export function parseRuntimeFallbackCandidate<T = unknown>(
  rawValue: string,
  expected: {
    storeName?: string;
    key?: string;
    revision?: string;
  } = {},
): RuntimeFallbackCandidate<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new PersistenceEnvelopeError(
      "Runtime fallback envelope is not valid JSON.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PersistenceEnvelopeError(
      "Runtime fallback envelope must be an object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  assertExactKeys(record, [
    "schemaVersion",
    "storeName",
    "key",
    "revision",
    "baseRevision",
    "writerId",
    "createdAt",
    "digest",
    "payload",
  ]);
  if (
    record.schemaVersion !== FALLBACK_SCHEMA_VERSION ||
    typeof record.storeName !== "string" ||
    typeof record.key !== "string" ||
    typeof record.revision !== "string" ||
    record.revision.length === 0 ||
    !(
      record.baseRevision === null || typeof record.baseRevision === "string"
    ) ||
    typeof record.writerId !== "string" ||
    record.writerId.length === 0 ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !isPersistenceDigestDescriptor(record.digest)
  ) {
    throw new PersistenceEnvelopeError(
      "Runtime fallback envelope has an invalid schema.",
    );
  }
  if (
    (expected.storeName !== undefined &&
      record.storeName !== expected.storeName) ||
    (expected.key !== undefined && record.key !== expected.key) ||
    (expected.revision !== undefined && record.revision !== expected.revision)
  ) {
    throw new PersistenceEnvelopeError(
      "Runtime fallback envelope does not match its storage key.",
    );
  }

  canonicalStringifyPersistencePayload(record.payload);
  return deepFreeze(
    cloneCanonicalPayload(record) as unknown as RuntimeFallbackCandidate<T>,
  );
}

export function serializeRuntimeFallbackCandidate(
  candidate: RuntimeFallbackCandidate,
): string {
  return canonicalStringifyPersistencePayload(candidate);
}

const candidateIdentity = (candidate: RuntimeFallbackCandidate): string =>
  canonicalStringifyPersistencePayload(candidate);

export function reconcileRuntimeFallbackCandidates<T>(
  current: RuntimeFallbackCurrentRevision,
  candidates: readonly RuntimeFallbackCandidate<T>[],
): RuntimeFallbackReconciliation<T> {
  const recordIdentities = new Set(
    candidates.map(
      (candidate) => `${candidate.storeName}\u0000${candidate.key}`,
    ),
  );
  if (recordIdentities.size > 1) {
    return {
      status: "conflict",
      reason: "mixed-record",
      conflictingCandidates: [...candidates],
      staleCandidates: [],
    };
  }

  const byRevision = new Map<string, RuntimeFallbackCandidate<T>>();
  for (const candidate of candidates) {
    const existing = byRevision.get(candidate.revision);
    if (!existing) {
      byRevision.set(candidate.revision, candidate);
      continue;
    }
    if (candidateIdentity(existing) !== candidateIdentity(candidate)) {
      return {
        status: "conflict",
        reason: "duplicate-revision",
        conflictingCandidates: [existing, candidate],
        staleCandidates: [],
      };
    }
  }

  const staleRevisions = new Set<string>();
  if (current.revision && byRevision.has(current.revision)) {
    const duplicateOfCurrent = byRevision.get(current.revision);
    if (
      duplicateOfCurrent &&
      (!current.digest ||
        duplicateOfCurrent.digest.value !== current.digest.value)
    ) {
      return {
        status: "conflict",
        reason: "same-revision-different-payload",
        conflictingCandidates: [duplicateOfCurrent],
        staleCandidates: [],
      };
    }
    if (
      duplicateOfCurrent &&
      (duplicateOfCurrent.baseRevision !== current.baseRevision ||
        (current.writerId !== undefined &&
          duplicateOfCurrent.writerId !== current.writerId) ||
        (current.createdAt !== undefined &&
          duplicateOfCurrent.createdAt !== current.createdAt))
    ) {
      return {
        status: "conflict",
        reason: "same-revision-different-metadata",
        conflictingCandidates: [duplicateOfCurrent],
        staleCandidates: [],
      };
    }
    staleRevisions.add(current.revision);
  }
  let ancestorRevision = current.baseRevision;
  const visitedAncestors = new Set<string>();
  while (
    ancestorRevision &&
    byRevision.has(ancestorRevision) &&
    !visitedAncestors.has(ancestorRevision)
  ) {
    visitedAncestors.add(ancestorRevision);
    staleRevisions.add(ancestorRevision);
    ancestorRevision = byRevision.get(ancestorRevision)?.baseRevision ?? null;
  }
  if (ancestorRevision && visitedAncestors.has(ancestorRevision)) {
    return {
      status: "conflict",
      reason: "ancestor-cycle",
      conflictingCandidates: Array.from(visitedAncestors)
        .map((revision) => byRevision.get(revision))
        .filter(
          (candidate): candidate is RuntimeFallbackCandidate<T> =>
            candidate !== undefined,
        ),
      staleCandidates: [],
    };
  }

  const staleCandidates = Array.from(staleRevisions)
    .map((revision) => byRevision.get(revision))
    .filter(
      (candidate): candidate is RuntimeFallbackCandidate<T> =>
        candidate !== undefined,
    );
  const activeCandidates = Array.from(byRevision.values()).filter(
    (candidate) => !staleRevisions.has(candidate.revision),
  );
  const activeRevisions = new Set(
    activeCandidates.map((candidate) => candidate.revision),
  );

  const ancestorBranch = activeCandidates.filter(
    (candidate) =>
      candidate.baseRevision !== null &&
      staleRevisions.has(candidate.baseRevision) &&
      candidate.baseRevision !== current.revision,
  );
  if (ancestorBranch.length > 0) {
    return {
      status: "conflict",
      reason: "ancestor-branch",
      conflictingCandidates: ancestorBranch,
      staleCandidates,
    };
  }

  const candidatesWithUnknownParent = activeCandidates.filter(
    (candidate) =>
      candidate.baseRevision !== current.revision &&
      !(current.revision === null && candidate.baseRevision === null) &&
      !(
        candidate.baseRevision !== null &&
        activeRevisions.has(candidate.baseRevision)
      ),
  );
  if (candidatesWithUnknownParent.length > 0) {
    return {
      status: "conflict",
      reason: "unknown-parent",
      conflictingCandidates: candidatesWithUnknownParent,
      staleCandidates,
    };
  }

  const childrenByParent = new Map<
    string | null,
    RuntimeFallbackCandidate<T>[]
  >();
  activeCandidates.forEach((candidate) => {
    const children = childrenByParent.get(candidate.baseRevision) ?? [];
    children.push(candidate);
    childrenByParent.set(candidate.baseRevision, children);
  });
  const branches = Array.from(childrenByParent.values()).filter(
    (children) => children.length > 1,
  );
  if (branches.length > 0) {
    return {
      status: "conflict",
      reason: "branch",
      conflictingCandidates: branches.flat(),
      staleCandidates,
    };
  }

  const chain: RuntimeFallbackCandidate<T>[] = [];
  let parentRevision = current.revision;
  while (true) {
    const child = childrenByParent.get(parentRevision)?.[0];
    if (!child) break;
    chain.push(child);
    parentRevision = child.revision;
  }
  if (chain.length !== activeCandidates.length) {
    return {
      status: "conflict",
      reason: "unknown-parent",
      conflictingCandidates: activeCandidates.filter(
        (candidate) => !chain.includes(candidate),
      ),
      staleCandidates,
    };
  }

  const head = chain.length > 0 ? chain[chain.length - 1] : null;
  return {
    status: "resolved",
    head,
    headRevision: head?.revision ?? current.revision,
    chain,
    staleCandidates,
  };
}

const createRecoveryMarker = (
  type: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> => ({
  __espRecoveryValue: type,
  ...details,
});

function snapshotRecoveryValue(
  value: unknown,
  path: string,
  seen: WeakMap<object, string>,
  depth: number,
): unknown {
  if (depth > MAX_RECOVERY_SNAPSHOT_DEPTH) {
    return createRecoveryMarker("depth-limit", { path });
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : createRecoveryMarker("non-finite-number", { value: String(value) });
  }
  if (typeof value === "bigint") {
    return createRecoveryMarker("bigint", { value: value.toString() });
  }
  if (typeof value === "undefined") {
    return createRecoveryMarker("undefined");
  }
  if (typeof value === "symbol") {
    return createRecoveryMarker("symbol", {
      value: value.description ?? "",
    });
  }
  if (typeof value === "function") {
    return createRecoveryMarker("function");
  }

  const objectValue = value as object;
  const previousPath = seen.get(objectValue);
  if (previousPath !== undefined) {
    return createRecoveryMarker("reference", { path: previousPath });
  }
  seen.set(objectValue, path);

  let propertyNames: string[];
  let symbolKeys: symbol[];
  try {
    propertyNames = Object.getOwnPropertyNames(objectValue);
    symbolKeys = Object.getOwnPropertySymbols(objectValue);
  } catch (error) {
    return createRecoveryMarker("unreadable-object", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }

  const readDescriptor = (
    propertyKey: string | symbol,
    propertyPath: string,
  ): Record<string, unknown> => {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(objectValue, propertyKey);
    } catch (error) {
      return createRecoveryMarker("unreadable-property", {
        error: error instanceof Error ? error.name : "UnknownError",
      });
    }
    if (!descriptor) {
      return createRecoveryMarker("missing-property");
    }
    if (!("value" in descriptor)) {
      return createRecoveryMarker("accessor", {
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
        hasGetter: typeof descriptor.get === "function",
        hasSetter: typeof descriptor.set === "function",
      });
    }
    return {
      enumerable: descriptor.enumerable ?? false,
      configurable: descriptor.configurable ?? false,
      writable: descriptor.writable ?? false,
      value: snapshotRecoveryValue(
        descriptor.value,
        propertyPath,
        seen,
        depth + 1,
      ),
    };
  };

  let isArray = false;
  try {
    isArray = Array.isArray(objectValue);
  } catch (error) {
    return createRecoveryMarker("unreadable-object", {
      error: error instanceof Error ? error.name : "UnknownError",
    });
  }
  if (isArray) {
    const lengthDescriptor = readDescriptor("length", `${path}.length`);
    const lengthValue = lengthDescriptor.value;
    const length =
      typeof lengthValue === "number" &&
      Number.isSafeInteger(lengthValue) &&
      lengthValue >= 0
        ? lengthValue
        : 0;
    const capturedLength = Math.min(length, MAX_RECOVERY_ARRAY_ITEMS);
    const itemDescriptors = Array.from({ length: capturedLength }, (_, index) =>
      readDescriptor(String(index), `${path}[${index}]`),
    );
    const hasOnlyDenseDataItems =
      capturedLength === length &&
      propertyNames.length === length + 1 &&
      propertyNames.every(
        (key) =>
          key === "length" ||
          (/^(0|[1-9]\d*)$/.test(key) && Number(key) < length),
      ) &&
      symbolKeys.length === 0 &&
      itemDescriptors.every(
        (descriptor) => "value" in descriptor && descriptor.enumerable === true,
      );
    if (hasOnlyDenseDataItems) {
      return itemDescriptors.map((descriptor) => descriptor.value);
    }
    return createRecoveryMarker("array", {
      length,
      capturedLength,
      truncated: capturedLength !== length,
      items: itemDescriptors,
      properties: propertyNames
        .filter(
          (key) =>
            key !== "length" &&
            !(/^(0|[1-9]\d*)$/.test(key) && Number(key) < length),
        )
        .map((key) => ({
          key,
          descriptor: readDescriptor(key, `${path}.${key}`),
        })),
      symbols: symbolKeys.map((symbol, index) => ({
        key: symbol.description ?? `symbol-${index}`,
        descriptor: readDescriptor(symbol, `${path}[symbol:${index}]`),
      })),
    });
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(objectValue);
  } catch {
    prototype = null;
  }
  const isPlainObject = prototype === Object.prototype || prototype === null;
  const descriptors = propertyNames.map((key) => ({
    key,
    descriptor: readDescriptor(key, `${path}.${key}`),
  }));
  const canRemainPlain =
    isPlainObject &&
    symbolKeys.length === 0 &&
    descriptors.every(
      ({ descriptor }) =>
        "value" in descriptor && descriptor.enumerable === true,
    );
  if (canRemainPlain) {
    const output: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    descriptors.forEach(({ key, descriptor }) => {
      Object.defineProperty(output, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    });
    return output;
  }

  let tag = "object";
  try {
    tag = Object.prototype.toString.call(objectValue);
  } catch {
    // A hostile proxy may reject tag inspection; the property snapshot remains usable.
  }
  return createRecoveryMarker("object", {
    tag,
    properties: descriptors,
    symbols: symbolKeys.map((symbol, index) => ({
      key: symbol.description ?? `symbol-${index}`,
      descriptor: readDescriptor(symbol, `${path}[symbol:${index}]`),
    })),
  });
}

export function snapshotStartupRecoveryValue(value: unknown): unknown {
  return snapshotRecoveryValue(value, "$", new WeakMap<object, string>(), 0);
}

function createStartupRecoveryCandidateSelectionDescriptor(
  candidate: StartupRecoveryCandidate,
): string {
  return canonicalStringifyPersistencePayload(
    snapshotStartupRecoveryValue(candidate),
  );
}

export function createStartupRecoveryCandidateSelectionKey(
  candidate: StartupRecoveryCandidate,
): string {
  const fingerprint = createSynchronousFingerprint(
    snapshotStartupRecoveryValue(candidate),
  );
  return [
    "esp-recovery-selection",
    fingerprint.algorithm,
    fingerprint.value,
    fingerprint.canonicalLength,
  ].join(":");
}

export function startupRecoveryCandidatesHaveSameSelectionDescriptor(
  left: StartupRecoveryCandidate,
  right: StartupRecoveryCandidate,
): boolean {
  return (
    createStartupRecoveryCandidateSelectionDescriptor(left) ===
    createStartupRecoveryCandidateSelectionDescriptor(right)
  );
}

export function createStartupRecoveryBundle({
  issues,
  candidates = [],
  capturedAt = new Date().toISOString(),
}: {
  issues: readonly StartupRecoveryIssue[];
  candidates?: readonly StartupRecoveryCandidate[];
  capturedAt?: string;
}): StartupRecoveryBundle {
  return {
    kind: PERSISTENCE_RECOVERY_KIND,
    version: 1,
    capturedAt,
    issues: issues.map(
      (issue) => snapshotStartupRecoveryValue(issue) as StartupRecoveryIssue,
    ),
    candidates: candidates.map(
      (candidate) =>
        snapshotStartupRecoveryValue(candidate) as StartupRecoveryCandidate,
    ),
  };
}

export function mergeStartupRecoveryBundles(
  bundles: readonly StartupRecoveryBundle[],
): StartupRecoveryBundle {
  const issues = new Map<string, StartupRecoveryIssue>();
  const candidates: StartupRecoveryCandidate[] = [];
  const serializedCandidates = new Set<string>();
  bundles.forEach((bundle) => {
    const safeBundle = createStartupRecoveryBundle({
      capturedAt: bundle.capturedAt,
      issues: bundle.issues,
      candidates: bundle.candidates,
    });
    safeBundle.issues.forEach((issue) => {
      issues.set(
        [
          issue.stage,
          issue.code,
          issue.storeName ?? "",
          issue.key ?? "",
          issue.message,
        ].join("\u0000"),
        issue,
      );
    });
    safeBundle.candidates.forEach((candidate) => {
      const serialized = canonicalStringifyPersistencePayload(candidate);
      if (!serializedCandidates.has(serialized)) {
        serializedCandidates.add(serialized);
        candidates.push(candidate);
      }
    });
  });
  return createStartupRecoveryBundle({
    capturedAt: bundles[0]?.capturedAt,
    issues: Array.from(issues.values()),
    candidates,
  });
}

export function serializeStartupRecoveryBundle(
  bundle: StartupRecoveryBundle,
): string {
  const safeBundle = createStartupRecoveryBundle({
    capturedAt: bundle.capturedAt,
    issues: bundle.issues,
    candidates: bundle.candidates,
  });
  return `${JSON.stringify(safeBundle, null, 2)}\n`;
}
