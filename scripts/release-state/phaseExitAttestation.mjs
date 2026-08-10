import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  FORMAL_PHASE_EXIT_GATES,
  PHASE_EXIT_REQUIRED_AUTHORITIES,
  PHASE_EXIT_SUBJECT_KIND_BY_GATE,
  previousFormalPhaseExitGate,
} from "./phaseGates.mjs";
import {
  createReleaseEvent,
  hashReleaseEvent,
  reduceReleaseState,
} from "./releaseStateReducer.mjs";
import { readCurrentReleaseState } from "./currentReleaseState.mjs";
import {
  assertPhaseExitSupportingEvent,
  resolveCurrentPhaseExitSupportingEvent,
} from "./phaseExitSupportingEvent.mjs";

export const PHASE_EXIT_ATTESTATION_MEDIA_TYPE =
  "application/vnd.event-shopping-planner.phase-exit-attestation+json;version=1";
export const PHASE_EXIT_ATTESTATION_KIND = "phase-exit-attestation/v1";

const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_ATTESTATION_BYTES = 4 * 1024 * 1024;

const compareUtf8 = (left, right) =>
  Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected) =>
  isRecord(value) &&
  Object.keys(value).sort(compareUtf8).join("\n") ===
    [...expected].sort(compareUtf8).join("\n");
const sameValue = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertHead = (head, { nullable = false } = {}) => {
  if (nullable && head === null) return;
  if (
    !exactKeys(head, ["sequence", "eventHash"]) ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 1 ||
    !SHA256.test(head.eventHash ?? "")
  ) {
    throw new Error("Phase exit subject Release State head is invalid");
  }
};

const assertReference = (reference, namespace, label) => {
  if (
    !exactKeys(reference, ["sha256", "uri"]) ||
    !SHA256.test(reference.sha256 ?? "") ||
    typeof reference.uri !== "string" ||
    !reference.uri.endsWith(`/${reference.sha256}`) ||
    !(
      reference.uri.startsWith(`release-state://${namespace}/evidence/`) ||
      reference.uri.startsWith(`release-state://${namespace}/events/`) ||
      reference.uri.startsWith("repository-verifier://")
    )
  ) {
    throw new Error(`${label} immutable reference is invalid`);
  }
  return reference;
};

const assertStoredReference = (reference, namespace, label) => {
  assertReference(reference, namespace, label);
  if (
    reference.uri !==
    `release-state://${namespace}/evidence/${reference.sha256}`
  ) {
    throw new Error(`${label} must be a stored evidence reference`);
  }
};

const assertSupportingEventShape = ({ gate, sourceSha, subject }) => {
  const support = subject.supportingEvent;
  const expectedEventType =
    gate === "P0-DATA"
      ? "state-initialized"
      : gate === "P0-PROMOTE"
        ? "assignment-validated"
        : "release-accepted";
  if (
    !exactKeys(support, [
      "sequence",
      "eventHash",
      "eventType",
      "gate",
      "sourceSha",
      "bindingId",
    ]) ||
    !Number.isSafeInteger(support.sequence) ||
    support.sequence < 1 ||
    !SHA256.test(support.eventHash ?? "") ||
    support.eventType !== expectedEventType ||
    support.gate !== gate ||
    support.sourceSha !== sourceSha ||
    typeof support.bindingId !== "string" ||
    support.bindingId.length === 0 ||
    support.sequence > subject.releaseStateHead.sequence ||
    (gate === "P0-DATA" &&
      support.sequence !== subject.releaseStateHead.sequence)
  ) {
    throw new Error(`${gate}: supporting event schema or identity is invalid`);
  }
};

const assertSubject = ({ gate, sourceSha, subject }) => {
  const kind = PHASE_EXIT_SUBJECT_KIND_BY_GATE[gate];
  if (subject?.kind !== kind) {
    throw new Error(`${gate}: phase exit subject kind differs`);
  }
  if (
    kind !== "state-initialized-bootstrap-subject/v1" &&
    subject.sourceSha !== sourceSha
  ) {
    throw new Error(`${gate}: phase exit subject source differs`);
  }
  if (kind === "repository-phase-subject/v1") {
    if (!exactKeys(subject, ["kind", "sourceSha"])) {
      throw new Error(`${gate}: repository subject schema is not closed`);
    }
    return;
  }
  if (kind === "disposable-drill-subject/v1") {
    if (
      !exactKeys(subject, ["kind", "sourceSha", "drillId"]) ||
      !NAMESPACE.test(subject.drillId ?? "") ||
      !subject.drillId.startsWith("artifact-drill-")
    ) {
      throw new Error(`${gate}: disposable drill subject schema is invalid`);
    }
    return;
  }
  if (kind === "state-initialized-bootstrap-subject/v1") {
    const binding = subject.bootstrapBinding;
    if (
      !exactKeys(subject, [
        "kind",
        "executorSourceSha",
        "bootstrapSourceSha",
        "bootstrapBinding",
        "rawDistManifestSha256",
        "releaseStateHead",
        "supportingEvent",
      ]) ||
      !exactKeys(binding, [
        "artifactArchiveSha256",
        "bindingId",
        "packageIndexSha256",
        "providerDeploymentId",
        "releaseRole",
        "sourceSha",
      ]) ||
      subject.executorSourceSha !== sourceSha ||
      !SOURCE_SHA.test(subject.bootstrapSourceSha ?? "") ||
      binding.sourceSha !== subject.bootstrapSourceSha ||
      binding.releaseRole !== "containment" ||
      typeof binding.bindingId !== "string" ||
      binding.bindingId.length === 0 ||
      typeof binding.providerDeploymentId !== "string" ||
      binding.providerDeploymentId.length === 0 ||
      !SHA256.test(binding.artifactArchiveSha256 ?? "") ||
      !SHA256.test(binding.packageIndexSha256 ?? "") ||
      !SHA256.test(subject.rawDistManifestSha256 ?? "")
    ) {
      throw new Error(
        `${gate}: initialized bootstrap subject schema is invalid`,
      );
    }
    assertHead(subject.releaseStateHead);
    assertSupportingEventShape({ gate, sourceSha, subject });
    return;
  }
  if (
    kind !== "release-state-subject/v1" ||
    subject.sourceSha !== sourceSha ||
    !exactKeys(subject, [
      "kind",
      "sourceSha",
      "releaseStateHead",
      "supportingEvent",
    ])
  ) {
    throw new Error(`${gate}: Release State subject schema is not closed`);
  }
  assertHead(subject.releaseStateHead);
  assertSupportingEventShape({ gate, sourceSha, subject });
};

export const assertPhaseExitAttestation = (attestation) => {
  if (
    !exactKeys(attestation, [
      "schemaVersion",
      "kind",
      "namespace",
      "gate",
      "sourceSha",
      "subject",
      "authorities",
      "predecessor",
      "issuedAt",
    ]) ||
    attestation.schemaVersion !== 1 ||
    attestation.kind !== PHASE_EXIT_ATTESTATION_KIND ||
    !NAMESPACE.test(attestation.namespace ?? "") ||
    !FORMAL_PHASE_EXIT_GATES.includes(attestation.gate) ||
    !SOURCE_SHA.test(attestation.sourceSha ?? "") ||
    !Array.isArray(attestation.authorities)
  ) {
    throw new Error("Phase exit attestation envelope is invalid");
  }
  const issuedAt = Date.parse(attestation.issuedAt);
  if (
    !Number.isFinite(issuedAt) ||
    new Date(issuedAt).toISOString() !== attestation.issuedAt
  ) {
    throw new Error("Phase exit attestation issuedAt is not canonical UTC");
  }
  assertSubject(attestation);
  const required = PHASE_EXIT_REQUIRED_AUTHORITIES[attestation.gate];
  if (
    attestation.authorities.length !== required.length ||
    attestation.authorities.some(
      (entry, index) =>
        !exactKeys(entry, ["id", "evidence"]) ||
        entry.id !== required[index] ||
        !Array.isArray(entry.evidence) ||
        entry.evidence.length === 0,
    )
  ) {
    throw new Error(
      `${attestation.gate}: authority set is missing, extra, reordered, or cross-gate`,
    );
  }
  const hashes = new Set();
  for (const entry of attestation.authorities) {
    for (const reference of entry.evidence) {
      assertReference(
        reference,
        attestation.namespace,
        `${attestation.gate}/${entry.id}`,
      );
      if (hashes.has(reference.sha256)) {
        throw new Error(
          "Phase exit attestation reuses evidence across authorities",
        );
      }
      hashes.add(reference.sha256);
    }
  }
  const priorGate = previousFormalPhaseExitGate(attestation.gate);
  if (priorGate === null) {
    if (attestation.predecessor !== null) {
      throw new Error(
        "First phase exit attestation must not have a predecessor",
      );
    }
  } else {
    assertStoredReference(
      attestation.predecessor,
      attestation.namespace,
      `${attestation.gate} predecessor`,
    );
  }
  return attestation;
};

export const buildPhaseExitAttestation = (options) => {
  if (
    !exactKeys(options, [
      "namespace",
      "gate",
      "sourceSha",
      "subject",
      "authorities",
      "predecessor",
      "issuedAt",
    ])
  ) {
    throw new Error("Phase exit attestation builder options are invalid");
  }
  const attestation = {
    schemaVersion: 1,
    kind: PHASE_EXIT_ATTESTATION_KIND,
    namespace: options.namespace,
    gate: options.gate,
    sourceSha: options.sourceSha,
    subject: structuredClone(options.subject),
    authorities: structuredClone(options.authorities),
    predecessor:
      options.predecessor === null
        ? null
        : structuredClone(options.predecessor),
    issuedAt: options.issuedAt,
  };
  assertPhaseExitAttestation(attestation);
  return Object.freeze(structuredClone(attestation));
};

const parseCanonicalAttestation = (bytes, expectedSha256) => {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAXIMUM_ATTESTATION_BYTES ||
    sha256Bytes(bytes) !== expectedSha256
  ) {
    throw new Error("Phase exit attestation bytes are absent or tampered");
  }
  const attestation = parseJsonStrict(
    bytes.toString("utf8"),
    "Phase exit attestation",
  );
  if (!canonicalJsonBytes(attestation).equals(bytes)) {
    throw new Error("Phase exit attestation is not canonical JSON");
  }
  return assertPhaseExitAttestation(attestation);
};

export const readPhaseExitAttestation = async ({ store, reference }) => {
  if (
    !store ||
    typeof store.namespace !== "string" ||
    typeof store.readEvidence !== "function"
  ) {
    throw new Error("Phase exit attestation store is invalid");
  }
  assertStoredReference(reference, store.namespace, "Phase exit attestation");
  const stored = await store.readEvidence({ sha256: reference.sha256 });
  if (
    !Buffer.isBuffer(stored?.bytes) ||
    stored.mediaType !== PHASE_EXIT_ATTESTATION_MEDIA_TYPE ||
    !Number.isFinite(Date.parse(stored.committedAt))
  ) {
    throw new Error(
      "Phase exit attestation immutable object is absent or mistyped",
    );
  }
  return Object.freeze({
    reference: Object.freeze({ ...reference }),
    attestation: Object.freeze(
      structuredClone(
        parseCanonicalAttestation(stored.bytes, reference.sha256),
      ),
    ),
    committedAt: stored.committedAt,
  });
};

export const putPhaseExitAttestation = async ({ store, attestation }) => {
  if (
    !store ||
    typeof store.putEvidence !== "function" ||
    typeof store.readEvidence !== "function" ||
    store.namespace !== attestation?.namespace
  ) {
    throw new Error("Phase exit attestation publication store is invalid");
  }
  assertPhaseExitAttestation(attestation);
  const bytes = canonicalJsonBytes(attestation);
  const sha256 = sha256Bytes(bytes);
  const reference = {
    uri: `release-state://${store.namespace}/evidence/${sha256}`,
    sha256,
  };
  const receipt = await store.putEvidence({
    bytes,
    mediaType: PHASE_EXIT_ATTESTATION_MEDIA_TYPE,
  });
  const readback = await readPhaseExitAttestation({ store, reference });
  if (
    receipt?.uri !== reference.uri ||
    receipt.sha256 !== sha256 ||
    receipt.mediaType !== PHASE_EXIT_ATTESTATION_MEDIA_TYPE ||
    receipt.byteLength !== bytes.length ||
    receipt.committedAt !== readback.committedAt ||
    typeof receipt.replayed !== "boolean" ||
    !sameValue(readback.attestation, attestation)
  ) {
    throw new Error("Phase exit attestation immutable put/readback differs");
  }
  return Object.freeze({
    reference: Object.freeze(reference),
    receipt: Object.freeze({ ...receipt }),
    attestation: readback.attestation,
  });
};

const assertHistoricalHead = (current, head, label) => {
  assertHead(head);
  const record = current?.records?.[head.sequence - 1];
  if (
    record?.sequence !== head.sequence ||
    record.eventHash !== head.eventHash ||
    head.sequence > current.head.sequence
  ) {
    throw new Error(
      `${label} is not an ancestor of the live Release State head`,
    );
  }
};

export const validatePhaseExitAttestationChain = async ({
  store,
  head,
  current,
  currentSourceSha,
  isSourceAncestor = (ancestor, descendant) => ancestor === descendant,
}) => {
  if (
    !SOURCE_SHA.test(currentSourceSha ?? "") ||
    typeof isSourceAncestor !== "function" ||
    !Array.isArray(current?.records) ||
    !isRecord(current?.head)
  ) {
    throw new Error(
      "Phase exit attestation chain validation context is invalid",
    );
  }
  const reversed = [];
  const seen = new Set();
  let reference = head;
  while (reference !== null) {
    assertStoredReference(reference, store.namespace, "Phase exit chain link");
    if (seen.has(reference.sha256)) {
      throw new Error("Phase exit attestation chain contains a cycle");
    }
    seen.add(reference.sha256);
    const readback = await readPhaseExitAttestation({ store, reference });
    reversed.push(readback);
    reference = readback.attestation.predecessor;
    if (reversed.length > FORMAL_PHASE_EXIT_GATES.length) {
      throw new Error(
        "Phase exit attestation chain is longer than the formal sequence",
      );
    }
  }
  const chain = reversed.reverse();
  let previousSourceSha = null;
  let previousSubjectHead = null;
  let previousIssuedAt = null;
  for (let index = 0; index < chain.length; index += 1) {
    const { attestation, reference: currentReference } = chain[index];
    if (attestation.gate !== FORMAL_PHASE_EXIT_GATES[index]) {
      throw new Error("Phase exit attestation chain skips or reorders a gate");
    }
    const expectedPredecessor = index === 0 ? null : chain[index - 1].reference;
    if (!sameValue(attestation.predecessor, expectedPredecessor)) {
      throw new Error("Phase exit attestation predecessor link was tampered");
    }
    if (!(await isSourceAncestor(attestation.sourceSha, currentSourceSha))) {
      throw new Error(
        `${attestation.gate}: attested source is not repository ancestry`,
      );
    }
    if (
      previousSourceSha !== null &&
      !(await isSourceAncestor(previousSourceSha, attestation.sourceSha))
    ) {
      throw new Error(
        `${attestation.gate}: attested source forks from its predecessor history`,
      );
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    if (previousIssuedAt !== null && issuedAt < previousIssuedAt) {
      throw new Error(
        `${attestation.gate}: attestation time regresses from its predecessor`,
      );
    }
    const subjectHead = attestation.subject.releaseStateHead;
    if (subjectHead !== undefined && subjectHead !== null) {
      assertHistoricalHead(
        current,
        subjectHead,
        `${attestation.gate} subject head`,
      );
      if (
        previousSubjectHead !== null &&
        subjectHead.sequence < previousSubjectHead.sequence
      ) {
        throw new Error(
          `${attestation.gate}: subject head regresses from its predecessor`,
        );
      }
      previousSubjectHead = subjectHead;
    }
    if (FORMAL_PHASE_EXIT_GATES.indexOf(attestation.gate) >= 3) {
      assertPhaseExitSupportingEvent({
        current,
        gate: attestation.gate,
        sourceSha: attestation.sourceSha,
        subjectHead,
        supportingEvent: attestation.subject.supportingEvent,
      });
      if (
        attestation.gate === "P0-DATA" &&
        !(await isSourceAncestor(
          attestation.subject.bootstrapSourceSha,
          attestation.sourceSha,
        ))
      ) {
        throw new Error(
          "P0-DATA bootstrap source is not repository ancestry of its executor",
        );
      }
    }
    if (
      currentReference.uri !==
      `release-state://${store.namespace}/evidence/${currentReference.sha256}`
    ) {
      throw new Error("Phase exit chain reference left the live namespace");
    }
    previousSourceSha = attestation.sourceSha;
    previousIssuedAt = issuedAt;
  }
  return Object.freeze(chain.map((entry) => Object.freeze(entry)));
};

export const validatePreInitializationPhaseExitSeed = async ({
  store,
  references,
  currentSourceSha,
  isSourceAncestor,
}) => {
  if (
    !Array.isArray(references) ||
    references.length !== 3 ||
    references.some((reference) => !isRecord(reference)) ||
    new Set(references.map(({ sha256 }) => sha256)).size !== references.length
  ) {
    throw new Error(
      "Pre-initialization phase exit seed must contain three distinct references",
    );
  }
  const chain = await validatePhaseExitAttestationChain({
    store,
    head: references.at(-1),
    current: { head: { sequence: 0, eventHash: null }, records: [] },
    currentSourceSha,
    isSourceAncestor,
  });
  const expectedGates = FORMAL_PHASE_EXIT_GATES.slice(0, 3);
  if (
    chain.length !== expectedGates.length ||
    chain.some(
      ({ attestation, reference }, index) =>
        attestation.gate !== expectedGates[index] ||
        !sameValue(reference, references[index]),
    )
  ) {
    throw new Error(
      "Pre-initialization phase exit seed skips, reorders, or substitutes its chain",
    );
  }
  return Object.freeze(
    chain.map(({ attestation, reference }) =>
      Object.freeze({
        gate: attestation.gate,
        sourceSha: attestation.sourceSha,
        subjectKind: attestation.subject.kind,
        attestation: Object.freeze({ ...reference }),
        predecessor:
          attestation.predecessor === null
            ? null
            : Object.freeze({ ...attestation.predecessor }),
      }),
    ),
  );
};

export const readPhaseExitAttestationLedger = (current) => {
  if (!Array.isArray(current?.records)) {
    throw new Error("Release State replay is required for phase exit ledger");
  }
  const entries = [];
  for (const record of current.records) {
    if (record.event.eventType === "state-initialized") {
      const seed = record.event.payload.phaseExitAttestationSeed;
      if (!Array.isArray(seed) || seed.length !== 3 || entries.length !== 0) {
        throw new Error("Release State phase exit seed is invalid");
      }
      for (const payload of seed) {
        if (
          payload.gate !== FORMAL_PHASE_EXIT_GATES[entries.length] ||
          (entries.length === 0
            ? payload.predecessor !== null
            : !sameValue(payload.predecessor, entries.at(-1).attestation))
        ) {
          throw new Error("Release State phase exit seed is not contiguous");
        }
        entries.push(
          Object.freeze({
            gate: payload.gate,
            sourceSha: payload.sourceSha,
            subjectKind: payload.subjectKind,
            attestation: Object.freeze({ ...payload.attestation }),
            event: Object.freeze({
              uri:
                `release-state://${record.event.namespace}/events/${record.sequence}/` +
                record.eventHash,
              sha256: record.eventHash,
            }),
          }),
        );
      }
      continue;
    }
    if (record.event.eventType !== "phase-exit-attested") continue;
    const payload = record.event.payload;
    if (
      payload.gate !== FORMAL_PHASE_EXIT_GATES[entries.length] ||
      (entries.length === 0
        ? payload.predecessor !== null
        : !sameValue(payload.predecessor, entries.at(-1).attestation))
    ) {
      throw new Error("Release State phase exit ledger is not contiguous");
    }
    entries.push(
      Object.freeze({
        gate: payload.gate,
        sourceSha: payload.sourceSha,
        subjectKind: payload.subjectKind,
        attestation: Object.freeze({ ...payload.attestation }),
        event: Object.freeze({
          uri:
            `release-state://${record.event.namespace}/events/${record.sequence}/` +
            record.eventHash,
          sha256: record.eventHash,
        }),
      }),
    );
  }
  return Object.freeze(entries);
};

export const appendPhaseExitAttestation = async (
  {
    store,
    attestationReference,
    operationId,
    appendId = randomUUID(),
    currentSourceSha,
    isSourceAncestor,
  },
  { readState = readCurrentReleaseState } = {},
) => {
  if (
    typeof operationId !== "string" ||
    operationId.length === 0 ||
    !UUID_V4.test(appendId ?? "")
  ) {
    throw new Error("Phase exit attestation append identity is invalid");
  }
  const current = await readState({ store });
  const chain = await validatePhaseExitAttestationChain({
    store,
    head: attestationReference,
    current,
    currentSourceSha,
    isSourceAncestor,
  });
  const latest = chain.at(-1);
  if (FORMAL_PHASE_EXIT_GATES.indexOf(latest.attestation.gate) >= 3) {
    const subjectHead = latest.attestation.subject.releaseStateHead;
    if (
      subjectHead.sequence !== current.head.sequence ||
      subjectHead.eventHash !== current.head.eventHash
    ) {
      throw new Error(
        "New phase exit attestation does not bind the live Release State head",
      );
    }
    const supportingEvent = resolveCurrentPhaseExitSupportingEvent({
      current,
      gate: latest.attestation.gate,
      sourceSha: latest.attestation.sourceSha,
      subjectHead,
    });
    if (
      supportingEvent === null ||
      !sameValue(supportingEvent, latest.attestation.subject.supportingEvent)
    ) {
      throw new Error(
        "New phase exit attestation lacks its exact current supporting event",
      );
    }
  }
  const ledger = readPhaseExitAttestationLedger(current);
  if (
    latest.attestation.gate !== FORMAL_PHASE_EXIT_GATES[ledger.length] ||
    chain.length !== ledger.length + 1 ||
    ledger.some(
      (entry, index) =>
        entry.attestation.sha256 !== chain[index].reference.sha256,
    )
  ) {
    throw new Error(
      "Phase exit attestation does not extend the live formal ledger",
    );
  }
  const payload = {
    gate: latest.attestation.gate,
    sourceSha: latest.attestation.sourceSha,
    subjectKind: latest.attestation.subject.kind,
    attestation: { ...latest.reference },
    predecessor:
      latest.attestation.predecessor === null
        ? null
        : { ...latest.attestation.predecessor },
  };
  const evidenceRefs = [
    payload.attestation,
    ...(payload.predecessor === null ? [] : [payload.predecessor]),
  ];
  const event = createReleaseEvent({
    namespace: store.namespace,
    sequence: current.head.sequence + 1,
    eventType: "phase-exit-attested",
    operationId,
    appendId,
    previousEventHash: current.head.eventHash,
    payload,
    evidenceRefs,
    approvalRefs: [],
  });
  reduceReleaseState(current.snapshot, event);
  const eventHash = hashReleaseEvent(event);
  const receipt = await store.compareAndAppend({
    expectedSequence: current.head.sequence,
    expectedHash: current.head.eventHash,
    event,
  });
  if (
    receipt?.namespace !== store.namespace ||
    receipt.sequence !== event.sequence ||
    receipt.eventHash !== eventHash ||
    typeof receipt.replayed !== "boolean"
  ) {
    throw new Error("Phase exit attestation CAS receipt differs");
  }
  const committed = await readState({ store });
  const committedEntry = readPhaseExitAttestationLedger(committed).at(-1);
  if (committedEntry?.attestation.sha256 !== attestationReference.sha256) {
    throw new Error("Phase exit attestation was not recovered by live replay");
  }
  return Object.freeze({
    gate: latest.attestation.gate,
    attestation: Object.freeze({ ...attestationReference }),
    event: committedEntry.event,
    replayed: receipt.replayed,
    head: Object.freeze({ ...committed.head }),
  });
};
