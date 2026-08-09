import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { RELEASE_DIMENSION_KEYS } from "../lib/release-policy.mjs";
import {
  ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  CSP_POLICY_MEDIA_TYPE,
  PROVIDER_POLICY_MEDIA_TYPE,
  RELEASE_POLICY_MEDIA_TYPE,
  TOOLCHAIN_POLICY_MEDIA_TYPE,
  buildAuthoritativeArtifactBuildRequirements,
  validateAuthoritativeArtifactBuildRequirements,
} from "./artifactBuildAuthority.mjs";
import { RELEASE_PHASE_GATES } from "./phaseGates.mjs";

const rootUrl = new URL(["..", "..", ""].join("/"), import.meta.url);
const basePolicy = JSON.parse(
  await readFile(new URL("config/release-variants.json", rootUrl), "utf8"),
);
const toolchainPolicyBytes = canonicalJsonBytes(
  JSON.parse(
    await readFile(new URL("config/toolchain-versions.json", rootUrl), "utf8"),
  ),
);
const cspPolicyBytes = canonicalJsonBytes(
  JSON.parse(
    await readFile(new URL("config/csp-policy.json", rootUrl), "utf8"),
  ),
);
const namespace = "artifact-build-authority-test";
const executorSourceSha = "1".repeat(40);
const targetSourceSha = "2".repeat(40);
const floorKeys = RELEASE_DIMENSION_KEYS.filter((key) => key !== "releaseRole");

class MemoryEvidenceStore {
  constructor(storeNamespace = namespace) {
    this.namespace = storeNamespace;
    this.objects = new Map();
  }

  async putEvidence({ bytes, mediaType }) {
    const input = Buffer.from(bytes);
    const sha256 = sha256Bytes(input);
    const existing = this.objects.get(sha256);
    if (existing && existing.mediaType !== mediaType) {
      throw new Error("Immutable evidence media type conflict");
    }
    this.objects.set(sha256, { bytes: input, mediaType });
    return {
      uri: `release-state://${this.namespace}/evidence/${sha256}`,
      sha256,
      byteLength: input.length,
      mediaType,
      replayed: existing !== undefined,
    };
  }

  async readEvidence({ sha256 }) {
    const stored = this.objects.get(sha256);
    return stored
      ? { bytes: Buffer.from(stored.bytes), mediaType: stored.mediaType }
      : null;
  }

  setMediaType(sha256, mediaType) {
    const stored = this.objects.get(sha256);
    assert.ok(stored);
    this.objects.set(sha256, { ...stored, mediaType });
  }
}

const immutableReference = (store, bytes) => {
  const sha256 = sha256Bytes(bytes);
  return {
    uri: `release-state://${store.namespace}/evidence/${sha256}`,
    sha256,
  };
};

const putJson = async (store, value, mediaType) => {
  const bytes = canonicalJsonBytes(value);
  await store.putEvidence({ bytes, mediaType });
  return immutableReference(store, bytes);
};

const standardAtGate = (policy, gate) => {
  let standard = structuredClone(policy.initialStandard);
  for (const phase of policy.phaseSequence) {
    if (phase.change !== null) standard = { ...standard, ...phase.change };
    if (phase.gate === gate) return standard;
  }
  throw new Error(`Unknown test gate ${gate}`);
};

const floorsAtGate = (policy, gate) =>
  Object.fromEntries(
    floorKeys.map((key) => [key, standardAtGate(policy, gate)[key]]),
  );

const policyAtGate = (
  gate,
  {
    status = "active",
    blockers = status === "active" ? [] : ["qa-required"],
  } = {},
) => ({
  ...structuredClone(basePolicy),
  activationStatus: status,
  activationBlockers: blockers,
  acceptedStandardFloors: floorsAtGate(basePolicy, gate),
});

const configuredProviderPolicy = Object.freeze({
  schemaVersion: 1,
  bindingStatus: "configured",
  expectedTeamId: "team-authority",
  expectedProjectId: "project-authority",
  blockerCodes: [],
});

const currentSafetyFloors = () => {
  const floors = structuredClone(basePolicy.minimumSafetyFloors);
  delete floors.styleSrcAttr;
  return floors;
};

const makeCurrent = ({
  acceptedGate,
  acceptedFloors,
  activeReleasePolicy,
  providerPolicy,
  pendingOperation = null,
  sequence = 17,
  seed = "current-state",
}) => ({
  head: {
    sequence,
    eventHash: sha256Bytes(Buffer.from(`${seed}:${sequence}`, "utf8")),
  },
  records: [],
  snapshot: {
    acceptedGate,
    acceptedStandard:
      acceptedGate === null
        ? null
        : {
            providerPolicy: structuredClone(providerPolicy),
            sourceSha: "0".repeat(40),
          },
    acceptedStandardFloors: structuredClone(acceptedFloors),
    activeReleasePolicy: structuredClone(activeReleasePolicy),
    bootstrapRecovery: { providerPolicy: structuredClone(providerPolicy) },
    currentDbCompatibility: {
      contractUri: "urn:event-shopping-planner:db-contract:v1",
      fingerprint: "d".repeat(64),
    },
    minimumSafetyFloors: currentSafetyFloors(),
    pendingAcceptance: null,
    pendingOperation,
  },
});

const prepareProductionAuthority = async ({
  targetGate,
  acceptedGate,
  activePolicy = policyAtGate(targetGate),
  store = new MemoryEvidenceStore(),
  pendingOperation = null,
} = {}) => {
  const providerPolicy = await putJson(
    store,
    configuredProviderPolicy,
    PROVIDER_POLICY_MEDIA_TYPE,
  );
  const activeReleasePolicy = await putJson(
    store,
    activePolicy,
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const acceptedFloors =
    acceptedGate === null ? {} : floorsAtGate(activePolicy, acceptedGate);
  const current = makeCurrent({
    acceptedGate,
    acceptedFloors,
    activeReleasePolicy,
    providerPolicy,
    pendingOperation,
    seed: `${acceptedGate ?? "bootstrap"}:${targetGate}`,
  });
  return { store, current, activeReleasePolicy, providerPolicy };
};

const productionOptions = (
  store,
  operationId = "build-production",
  targetGate = "P0-RELEASE",
) => ({
  store,
  namespace: store.namespace,
  operationId,
  executorSourceSha,
  targetSourceSha: executorSourceSha,
  targetGate,
  purpose: "production",
  toolchainPolicyBytes,
  cspPolicyBytes,
});

test("production requirements bind every canonical predecessor/target gate", async () => {
  const results = [];
  for (let index = 0; index < RELEASE_PHASE_GATES.length; index += 1) {
    const targetGate = RELEASE_PHASE_GATES[index];
    const acceptedGate = index === 0 ? null : RELEASE_PHASE_GATES[index - 1];
    const { store, current } = await prepareProductionAuthority({
      targetGate,
      acceptedGate,
    });
    const built = await buildAuthoritativeArtifactBuildRequirements(
      productionOptions(store, `build-${targetGate.toLowerCase()}`, targetGate),
      { readState: async () => current },
    );
    assert.equal(built.requirements.acceptedGate, acceptedGate);
    assert.equal(built.requirements.targetGate, targetGate);
    assert.equal(built.requirements.purpose, "production");
    assert.equal(built.requirements.promotable, true);
    assert.deepEqual(
      built.requirements.standardDimensions,
      standardAtGate(basePolicy, targetGate),
    );
    const validated = await validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: built.requirementsBytes,
        expectedSha256: built.requirementsSha256,
        checkoutSourceSha: executorSourceSha,
      },
      { readState: async () => current },
    );
    assert.deepEqual(validated.requirements, built.requirements);
    results.push(built.requirements);
  }
  assert.deepEqual(
    results[8].standardDimensions,
    results[7].standardDimensions,
    "P6 must be an explicit zero-delta gate",
  );
  assert.deepEqual(
    results[10].standardDimensions,
    results[9].standardDimensions,
    "P8 must be an explicit zero-delta gate",
  );
});

test("production requirements authorize an exact distinct-source same-floor replacement", async () => {
  const { store, current } = await prepareProductionAuthority({
    targetGate: "P1-PWA",
    acceptedGate: "P1-PWA",
  });
  const built = await buildAuthoritativeArtifactBuildRequirements(
    productionOptions(store, "replace-p1-source", "P1-PWA"),
    { readState: async () => current },
  );
  assert.equal(built.requirements.acceptedGate, "P1-PWA");
  assert.equal(built.requirements.targetGate, "P1-PWA");
  assert.deepEqual(
    built.requirements.standardDimensions,
    standardAtGate(basePolicy, "P1-PWA"),
  );
  const validated = await validateAuthoritativeArtifactBuildRequirements(
    {
      store,
      requirementsBytes: built.requirementsBytes,
      expectedSha256: built.requirementsSha256,
      checkoutSourceSha: executorSourceSha,
    },
    { readState: async () => current },
  );
  assert.deepEqual(validated.requirements, built.requirements);
});

test("same-floor replacement rejects reused source, policy drift, regress, and missing gate", async () => {
  const terminal = await prepareProductionAuthority({
    targetGate: "P8-CLEAN",
    acceptedGate: "P8-CLEAN",
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(
        terminal.store,
        "reject-terminal-source-replacement",
        "P8-CLEAN",
      ),
      { readState: async () => terminal.current },
    ),
    /Terminal P8-CLEAN does not permit a same-floor source replacement/u,
  );

  const sameFloor = await prepareProductionAuthority({
    targetGate: "P1-PWA",
    acceptedGate: "P1-PWA",
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      {
        ...productionOptions(sameFloor.store, "reuse-p1-source", "P1-PWA"),
        executorSourceSha: "0".repeat(40),
        targetSourceSha: "0".repeat(40),
      },
      { readState: async () => sameFloor.current },
    ),
    /distinct source and accepted standard/,
  );

  const unboundAcceptedSource = structuredClone(sameFloor.current);
  delete unboundAcceptedSource.snapshot.acceptedStandard.sourceSha;
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(sameFloor.store, "replace-unbound-p1-source", "P1-PWA"),
      { readState: async () => unboundAcceptedSource },
    ),
    /distinct source and accepted standard/,
  );

  const policyAhead = await prepareProductionAuthority({
    targetGate: "P4-CSP",
    acceptedGate: "P3-XLSX",
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(policyAhead.store, "replace-p3-source", "P3-XLSX"),
      { readState: async () => policyAhead.current },
    ),
    /does not authorize the current production floor/,
  );

  const regressed = await prepareProductionAuthority({
    targetGate: "P4-CSP",
    acceptedGate: "P4-CSP",
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(regressed.store, "regress-p4-source", "P3-XLSX"),
      { readState: async () => regressed.current },
    ),
    /preserve the accepted floor or advance exactly one gate/,
  );

  const missingGate = productionOptions(
    sameFloor.store,
    "missing-replacement-gate",
    "P1-PWA",
  );
  delete missingGate.targetGate;
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(missingGate, {
      readState: async () => sameFloor.current,
    }),
    /unknown or missing fields/,
  );
});

test("policy QA requirements bind the exact successor proposed/active policy triplet", async () => {
  const store = new MemoryEvidenceStore();
  const providerPolicy = await putJson(
    store,
    configuredProviderPolicy,
    PROVIDER_POLICY_MEDIA_TYPE,
  );
  const previousReleasePolicy = await putJson(
    store,
    policyAtGate("P0-RELEASE"),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const proposedReleasePolicy = await putJson(
    store,
    policyAtGate("P1-PWA", { status: "proposed" }),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const activeReleasePolicy = await putJson(
    store,
    policyAtGate("P1-PWA"),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const current = makeCurrent({
    acceptedGate: "P0-RELEASE",
    acceptedFloors: floorsAtGate(basePolicy, "P0-RELEASE"),
    activeReleasePolicy: previousReleasePolicy,
    providerPolicy,
  });
  const built = await buildAuthoritativeArtifactBuildRequirements(
    {
      store,
      namespace,
      operationId: "build-policy-qa-p1",
      executorSourceSha,
      targetSourceSha,
      purpose: "policy-activation-qa",
      proposedPolicyReference: proposedReleasePolicy,
      activePolicyReference: activeReleasePolicy,
      toolchainPolicyBytes,
      cspPolicyBytes,
    },
    { readState: async () => current },
  );
  assert.equal(built.requirements.targetGate, "P1-PWA");
  assert.equal(built.requirements.promotable, false);
  assert.equal(
    built.requirements.buildPurpose,
    "non-promotable-policy-activation-qa",
  );
  assert.deepEqual(built.requirements.releasePolicy, proposedReleasePolicy);
  assert.deepEqual(
    built.requirements.previousReleasePolicy,
    previousReleasePolicy,
  );
  assert.deepEqual(built.requirements.activeReleasePolicy, activeReleasePolicy);
});

test("caller dimensions, proposed production, skipped gates, and pending state fail closed", async () => {
  const p0 = await prepareProductionAuthority({
    targetGate: "P0-RELEASE",
    acceptedGate: null,
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      {
        ...productionOptions(p0.store),
        standardDimensions: standardAtGate(basePolicy, "P0-RELEASE"),
      },
      { readState: async () => p0.current },
    ),
    /unknown or missing fields/,
  );
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      {
        ...productionOptions(p0.store),
        proposedPolicyReference: p0.activeReleasePolicy,
      },
      { readState: async () => p0.current },
    ),
    /unknown or missing fields/,
  );

  const skipped = await prepareProductionAuthority({
    targetGate: "P2A-LOCAL",
    acceptedGate: "P0-RELEASE",
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(skipped.store, "build-skipped", "P2A-LOCAL"),
      { readState: async () => skipped.current },
    ),
    /preserve the accepted floor or advance exactly one gate/,
  );

  const pending = await prepareProductionAuthority({
    targetGate: "P1-PWA",
    acceptedGate: "P0-RELEASE",
    pendingOperation: { operationId: "pending" },
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(pending.store, "build-pending", "P1-PWA"),
      { readState: async () => pending.current },
    ),
    /idle Release State/,
  );
});

test("production accepts only an active policy and QA accepts only its exact successor", async () => {
  const proposedProduction = await prepareProductionAuthority({
    targetGate: "P1-PWA",
    acceptedGate: "P0-RELEASE",
    activePolicy: policyAtGate("P1-PWA", { status: "proposed" }),
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      productionOptions(proposedProduction.store, "build-proposed", "P1-PWA"),
      { readState: async () => proposedProduction.current },
    ),
    /valid active authority/,
  );

  const store = new MemoryEvidenceStore();
  const providerPolicy = await putJson(
    store,
    configuredProviderPolicy,
    PROVIDER_POLICY_MEDIA_TYPE,
  );
  const previousReleasePolicy = await putJson(
    store,
    policyAtGate("P0-RELEASE"),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const proposedReleasePolicy = await putJson(
    store,
    policyAtGate("P2A-LOCAL", { status: "proposed" }),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const activeReleasePolicy = await putJson(
    store,
    policyAtGate("P2A-LOCAL"),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const current = makeCurrent({
    acceptedGate: "P0-RELEASE",
    acceptedFloors: floorsAtGate(basePolicy, "P0-RELEASE"),
    activeReleasePolicy: previousReleasePolicy,
    providerPolicy,
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      {
        store,
        namespace,
        operationId: "skip-policy-qa-gate",
        executorSourceSha,
        targetSourceSha,
        purpose: "policy-activation-qa",
        proposedPolicyReference: proposedReleasePolicy,
        activePolicyReference: activeReleasePolicy,
        toolchainPolicyBytes,
        cspPolicyBytes,
      },
      { readState: async () => current },
    ),
    /advance exactly one phase gate/,
  );
});

test("P8 floor activation cannot authorize an artifact rebuild", async () => {
  const store = new MemoryEvidenceStore();
  const providerPolicy = await putJson(
    store,
    configuredProviderPolicy,
    PROVIDER_POLICY_MEDIA_TYPE,
  );
  const releasePolicy = await putJson(
    store,
    policyAtGate("P8-CLEAN"),
    RELEASE_POLICY_MEDIA_TYPE,
  );
  const current = makeCurrent({
    acceptedGate: "P8-CLEAN",
    acceptedFloors: floorsAtGate(basePolicy, "P8-CLEAN"),
    activeReleasePolicy: releasePolicy,
    providerPolicy,
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      {
        store,
        namespace,
        operationId: "p8-floor-rebuild",
        executorSourceSha,
        targetSourceSha,
        purpose: "policy-activation-qa",
        proposedPolicyReference: releasePolicy,
        activePolicyReference: releasePolicy,
        toolchainPolicyBytes,
        cspPolicyBytes,
      },
      { readState: async () => current },
    ),
    /valid proposed authority/,
  );
});

test("validation rejects state drift and a wrong checkout source", async () => {
  const { store, current } = await prepareProductionAuthority({
    targetGate: "P0-RELEASE",
    acceptedGate: null,
  });
  const built = await buildAuthoritativeArtifactBuildRequirements(
    productionOptions(store),
    { readState: async () => current },
  );
  await assert.rejects(
    validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: built.requirementsBytes,
        expectedSha256: built.requirementsSha256,
        checkoutSourceSha: "f".repeat(40),
      },
      { readState: async () => current },
    ),
    /checkout source differs/,
  );
  const drifted = {
    ...current,
    head: {
      sequence: current.head.sequence + 1,
      eventHash: "e".repeat(64),
    },
  };
  await assert.rejects(
    validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: built.requirementsBytes,
        expectedSha256: built.requirementsSha256,
        checkoutSourceSha: executorSourceSha,
      },
      { readState: async () => drifted },
    ),
    /differ from current authoritative state/,
  );
});

test("wrong namespace, absent references, and wrong evidence media fail closed", async () => {
  const { store, current } = await prepareProductionAuthority({
    targetGate: "P0-RELEASE",
    acceptedGate: null,
  });
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(
      { ...productionOptions(store), namespace: "another-namespace" },
      { readState: async () => current },
    ),
    /identity is invalid/,
  );

  const missing = structuredClone(current);
  missing.snapshot.activeReleasePolicy = {
    uri: `release-state://${namespace}/evidence/${"9".repeat(64)}`,
    sha256: "9".repeat(64),
  };
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(productionOptions(store), {
      readState: async () => missing,
    }),
    /absent or failed immutable verification/,
  );

  store.setMediaType(
    current.snapshot.activeReleasePolicy.sha256,
    "application/json",
  );
  await assert.rejects(
    buildAuthoritativeArtifactBuildRequirements(productionOptions(store), {
      readState: async () => current,
    }),
    /media type is invalid/,
  );
});

test("reviewed requirements and referenced policy media are re-read canonically", async () => {
  const { store, current } = await prepareProductionAuthority({
    targetGate: "P0-RELEASE",
    acceptedGate: null,
  });
  const built = await buildAuthoritativeArtifactBuildRequirements(
    productionOptions(store),
    { readState: async () => current },
  );
  store.setMediaType(built.requirementsSha256, "application/json");
  await assert.rejects(
    validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: built.requirementsBytes,
        expectedSha256: built.requirementsSha256,
        checkoutSourceSha: executorSourceSha,
      },
      { readState: async () => current },
    ),
    /Stored artifact build requirements differ from review/,
  );

  store.setMediaType(
    built.requirementsSha256,
    ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
  );
  store.setMediaType(
    built.requirements.toolchainPolicy.sha256,
    CSP_POLICY_MEDIA_TYPE,
  );
  await assert.rejects(
    validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: built.requirementsBytes,
        expectedSha256: built.requirementsSha256,
        checkoutSourceSha: executorSourceSha,
      },
      { readState: async () => current },
    ),
    /Toolchain policy media type is invalid/,
  );
});

test("reviewed requirements SHA and closed object fields cannot be substituted", async () => {
  const { store, current } = await prepareProductionAuthority({
    targetGate: "P0-RELEASE",
    acceptedGate: null,
  });
  const built = await buildAuthoritativeArtifactBuildRequirements(
    productionOptions(store),
    { readState: async () => current },
  );
  await assert.rejects(
    validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: built.requirementsBytes,
        expectedSha256: "0".repeat(64),
        checkoutSourceSha: executorSourceSha,
      },
      { readState: async () => current },
    ),
    /reviewed SHA differs/,
  );

  const openObject = canonicalJsonBytes({
    ...built.requirements,
    callerStandardDimensions: built.requirements.standardDimensions,
  });
  await assert.rejects(
    validateAuthoritativeArtifactBuildRequirements(
      {
        store,
        requirementsBytes: openObject,
        expectedSha256: sha256Bytes(openObject),
        checkoutSourceSha: executorSourceSha,
      },
      { readState: async () => current },
    ),
    /unknown or missing fields/,
  );
});

test("policy evidence constants stay distinct and exact", () => {
  assert.notEqual(RELEASE_POLICY_MEDIA_TYPE, PROVIDER_POLICY_MEDIA_TYPE);
  assert.notEqual(TOOLCHAIN_POLICY_MEDIA_TYPE, CSP_POLICY_MEDIA_TYPE);
  assert.equal(
    ARTIFACT_BUILD_REQUIREMENTS_MEDIA_TYPE,
    "application/vnd.event-shopping-planner.artifact-build-requirements+json;version=1",
  );
});
