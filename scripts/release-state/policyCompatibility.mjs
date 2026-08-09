import {
  NAMESPACE_PATTERN,
  assertExactKeys,
  compareUtf8,
  sameCanonicalValue,
} from "./releaseWorkflowValidation.mjs";

export const POLICY_COMPATIBILITY_ACTIONS = Object.freeze([
  "containment",
  "rollback",
]);

const assertImmutableReference = (reference, namespace, label) => {
  assertExactKeys(reference, ["sha256", "uri"], label);
  if (
    typeof reference.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(reference.sha256) ||
    typeof reference.uri !== "string" ||
    !new RegExp(
      `^release-state://${namespace}/evidence/${reference.sha256}$`,
    ).test(reference.uri)
  ) {
    throw new Error(`${label} is not an immutable policy reference`);
  }
};

const assertStringSet = (values, { allowed, label }) => {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) =>
      allowed === undefined
        ? typeof value !== "string" || value.length === 0
        : !allowed.includes(value),
    ) ||
    new Set(values).size !== values.length ||
    !sameCanonicalValue(values, [...values].sort(compareUtf8))
  ) {
    throw new Error(`${label} must be a non-empty sorted distinct set`);
  }
};

export const assertPolicyCompatibilityEntry = (
  entry,
  {
    namespace,
    minimumSafetyFloors,
    currentDbCompatibility,
    nowMilliseconds,
    label = "Policy compatibility entry",
  },
) => {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`${label} namespace is invalid`);
  }
  assertExactKeys(
    entry,
    [
      "allowedActions",
      "eligibleBindingIds",
      "expiresAt",
      "minimumSafetyFloors",
      "owner",
      "predecessorPolicy",
      "requiredDbCompatibility",
    ],
    label,
  );
  assertImmutableReference(
    entry.predecessorPolicy,
    namespace,
    `${label} predecessor policy`,
  );
  assertStringSet(entry.allowedActions, {
    allowed: POLICY_COMPATIBILITY_ACTIONS,
    label: `${label} actions`,
  });
  assertStringSet(entry.eligibleBindingIds, {
    label: `${label} binding IDs`,
  });
  if (
    typeof entry.owner !== "string" ||
    entry.owner.length === 0 ||
    !Number.isFinite(Date.parse(entry.expiresAt)) ||
    (Number.isFinite(nowMilliseconds) &&
      Date.parse(entry.expiresAt) <= nowMilliseconds) ||
    !sameCanonicalValue(entry.minimumSafetyFloors, minimumSafetyFloors) ||
    !sameCanonicalValue(entry.requiredDbCompatibility, currentDbCompatibility)
  ) {
    throw new Error(`${label} safety, expiry, DB, or owner binding is invalid`);
  }
  return entry;
};

export const assertPolicyCompatibilityEntries = (
  entries,
  { namespace, minimumSafetyFloors, currentDbCompatibility, nowMilliseconds },
) => {
  if (!Array.isArray(entries)) {
    throw new Error("Policy compatibility entries must be an array");
  }
  const identities = new Set();
  for (const [index, entry] of entries.entries()) {
    assertPolicyCompatibilityEntry(entry, {
      namespace,
      minimumSafetyFloors,
      currentDbCompatibility,
      nowMilliseconds,
      label: `Policy compatibility entry ${index + 1}`,
    });
    const identity = entry.predecessorPolicy.sha256;
    if (identities.has(identity)) {
      throw new Error(
        "Policy compatibility predecessor references are ambiguous",
      );
    }
    identities.add(identity);
  }
  const sorted = [...entries].sort((left, right) =>
    compareUtf8(left.predecessorPolicy.sha256, right.predecessorPolicy.sha256),
  );
  if (!sameCanonicalValue(entries, sorted)) {
    throw new Error("Policy compatibility entries must be SHA-256 sorted");
  }
  return entries;
};

export const findBindingPolicyCompatibility = ({
  snapshot,
  binding,
  action,
}) => {
  if (sameCanonicalValue(binding.releasePolicy, snapshot.activeReleasePolicy)) {
    return { kind: "active", entry: null };
  }
  const entries = snapshot.activePolicyCompatibility ?? [];
  const matches = entries.filter(
    (entry) =>
      sameCanonicalValue(entry.predecessorPolicy, binding.releasePolicy) &&
      entry.eligibleBindingIds.includes(binding.bindingId) &&
      (action === undefined || entry.allowedActions.includes(action)) &&
      sameCanonicalValue(
        entry.requiredDbCompatibility,
        binding.requiredDbCompatibility,
      ) &&
      sameCanonicalValue(
        entry.minimumSafetyFloors,
        snapshot.minimumSafetyFloors,
      ),
  );
  return matches.length === 1
    ? { kind: "compatible-predecessor", entry: matches[0] }
    : null;
};

export const assertBindingPolicyEligible = ({
  snapshot,
  binding,
  action,
  label,
}) => {
  const match = findBindingPolicyCompatibility({ snapshot, binding, action });
  if (match === null) {
    throw new Error(
      `${label} does not match the active policy or an exact compatible predecessor`,
    );
  }
  return match;
};
