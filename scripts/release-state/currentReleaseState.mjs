import {
  hashReleaseEvent,
  replayReleaseEvents,
} from "./releaseStateReducer.mjs";
import { SHA256_PATTERN, isRecord } from "./releaseWorkflowValidation.mjs";

const assertHead = (head) => {
  if (
    !isRecord(head) ||
    !Number.isSafeInteger(head.sequence) ||
    head.sequence < 0 ||
    !(
      (head.sequence === 0 && head.eventHash === null) ||
      (head.sequence > 0 &&
        typeof head.eventHash === "string" &&
        SHA256_PATTERN.test(head.eventHash))
    )
  ) {
    throw new Error("Release State head is invalid");
  }
};

const deepFreeze = (value) => {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

export const readCurrentReleaseState = async ({
  store,
  requireInitialized = true,
}) => {
  if (
    !store ||
    typeof store.readHead !== "function" ||
    typeof store.readEvents !== "function"
  ) {
    throw new Error("Release State store does not provide read operations");
  }

  const headBefore = await store.readHead();
  assertHead(headBefore);
  const records = await store.readEvents({ afterSequence: 0 });
  if (!Array.isArray(records)) {
    throw new Error("Release State event read did not return an array");
  }
  const headAfter = await store.readHead();
  assertHead(headAfter);
  if (
    headBefore.sequence !== headAfter.sequence ||
    headBefore.eventHash !== headAfter.eventHash
  ) {
    throw new Error("Release State head changed during replay");
  }
  if (records.length !== headAfter.sequence) {
    throw new Error("Release State head and event count differ");
  }
  if (records.length === 0) {
    if (requireInitialized) {
      throw new Error("Release State namespace is not initialized");
    }
    return deepFreeze({
      head: { ...headAfter },
      snapshot: null,
      records: [],
    });
  }

  const events = [];
  let previousHash = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const expectedSequence = index + 1;
    if (
      !isRecord(record) ||
      record.sequence !== expectedSequence ||
      typeof record.eventHash !== "string" ||
      !SHA256_PATTERN.test(record.eventHash) ||
      record.previousHash !== previousHash ||
      !isRecord(record.event) ||
      record.event.sequence !== expectedSequence ||
      record.event.previousEventHash !== previousHash ||
      hashReleaseEvent(record.event) !== record.eventHash ||
      !Number.isFinite(Date.parse(record.committedAt))
    ) {
      throw new Error(
        `Release State event record ${expectedSequence} failed replay binding`,
      );
    }
    events.push(structuredClone(record.event));
    previousHash = record.eventHash;
  }
  if (previousHash !== headAfter.eventHash) {
    throw new Error("Release State replay does not reach the current head");
  }
  const namespace = events[0].namespace;
  if (typeof store.namespace === "string" && store.namespace !== namespace) {
    throw new Error("Release State events differ from the store namespace");
  }
  const snapshot = replayReleaseEvents(events);
  if (
    snapshot.sequence !== headAfter.sequence ||
    snapshot.eventHash !== headAfter.eventHash
  ) {
    throw new Error("Release State reducer result differs from the store head");
  }
  return deepFreeze({
    head: { ...headAfter },
    snapshot,
    records: records.map((record) => structuredClone(record)),
  });
};
