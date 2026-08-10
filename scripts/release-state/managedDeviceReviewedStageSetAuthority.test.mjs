import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES } from "../browser/managed-device-authority.mjs";
import { MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE } from "../browser/managed-device-stage-authority.mjs";
import { buildManagedDevicePhaseExitEvidence } from "../lib/phase-exit-external-authority.mjs";
import {
  MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE,
  MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE,
  MANAGED_DEVICE_STAGE_FILE_NAME,
  MANAGED_DEVICE_STAGE_WORKFLOW_PATH,
  PWA_REVIEWED_FORMAL_CLOSURE_KIND,
  PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE,
  PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE,
  PWA_STRICT_RECEIPT_FILE_NAME,
  putManagedDeviceReviewedStageSetAuthority,
  putPwaReviewedFormalClosureAuthority,
  readManagedDeviceReviewedStageSetAuthority,
  readPwaReviewedFormalClosureAuthority,
} from "./managedDeviceReviewedStageSetAuthority.mjs";

const namespace = "foundation-release";
const repository = "example/event-shopping-planner";
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const authority = "pwa-multiclient-drill";
const reference = (character) => ({
  uri: `release-state://${namespace}/evidence/${character.repeat(64)}`,
  sha256: character.repeat(64),
});

const createStore = () => {
  const objects = new Map();
  return {
    objects,
    store: {
      namespace,
      async putEvidence({ bytes, mediaType }) {
        const sha256 = sha256Bytes(bytes);
        const committedAt = "2026-08-09T12:00:00.000Z";
        objects.set(sha256, {
          bytes: Buffer.from(bytes),
          mediaType,
          committedAt,
        });
        return {
          uri: `release-state://${namespace}/evidence/${sha256}`,
          sha256,
          mediaType,
          byteLength: bytes.length,
          committedAt,
          replayed: false,
        };
      },
      async readEvidence({ sha256 }) {
        const stored = objects.get(sha256);
        return stored === undefined
          ? null
          : { ...stored, bytes: Buffer.from(stored.bytes) };
      },
    },
  };
};

const reviewedStage = (runId, runAttempt = "1", character = "a") => ({
  reference: reference(character),
  receipt: {
    kind: "reviewed-github-workflow-artifact/v1",
    repository,
    runId,
    runAttempt,
    sourceSha,
    workflowPath: MANAGED_DEVICE_STAGE_WORKFLOW_PATH,
    artifactName: MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE.replace(
      "{sourceSha}",
      sourceSha,
    ).replace("{runAttempt}", runAttempt),
    fileName: MANAGED_DEVICE_STAGE_FILE_NAME,
    artifactFileMediaType: MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE,
  },
});

const stages = () => [
  reviewedStage("103", "1", "c"),
  reviewedStage("101", "2", "a"),
  reviewedStage("102", "1", "b"),
];

const put = async (overrides = {}) => {
  const fixture = createStore();
  const written = await putManagedDeviceReviewedStageSetAuthority({
    authority,
    namespace,
    repository,
    sourceSha,
    reviewedStages: stages(),
    store: fixture.store,
    currentWorkflowRunId: "200",
    ...overrides,
  });
  return { ...fixture, written };
};

const read = async (fixture, overrides = {}, dependencies = {}) => {
  const readReviewedArtifact =
    dependencies.readReviewedArtifact ??
    (async (options) => {
      const stage = fixture.written.document.stages.find(
        ({ reviewedArtifact }) =>
          reviewedArtifact.sha256 === options.reference.sha256,
      );
      const receipt = {
        kind: "managed-device-stage-signed-receipt/v1",
        runId: stage.runId,
      };
      return {
        receipt: {
          runId: stage.runId,
          runAttempt: stage.runAttempt,
        },
        fileBytes: canonicalJsonBytes(receipt),
      };
    });
  const aggregate =
    dependencies.aggregate ??
    ((options) => {
      const document = {
        authority: options.authority,
        sourceSha: options.expectedCollectorSourceSha,
      };
      return {
        document,
        sha256: sha256Bytes(canonicalJsonBytes(document)),
      };
    });
  return readManagedDeviceReviewedStageSetAuthority(
    {
      authority,
      namespace,
      reference: fixture.written.reference,
      store: fixture.store,
      current: { head: { sequence: 9, eventHash: "f".repeat(64) } },
      expectedCollectorSourceSha: sourceSha,
      externalPolicy: {},
      approvalPolicy: { repository },
      dbContract: {},
      currentWorkflowRunId: "200",
      ...overrides,
    },
    { readReviewedArtifact, aggregate },
  );
};

const rollbackSourceSha = "f".repeat(40);
const hash = (character) => character.repeat(64);
const binding = ({ rollback = false } = {}) => ({
  bindingId: rollback ? "rollback-binding" : "accepted-binding",
  deploymentUrl: rollback
    ? "https://rollback.example.test/"
    : "https://accepted.example.test/",
  providerDeploymentId: rollback
    ? "rollback-deployment"
    : "accepted-deployment",
  providerProjectId: "provider-project",
  releaseRole: "standard",
  sourceSha: rollback ? rollbackSourceSha : sourceSha,
});

const deployment = ({ rollback = false } = {}) => ({
  ...binding({ rollback }),
  policyEligibility: rollback ? "current-rollback-inventory" : "active-policy",
  selection: rollback
    ? "eligible-rollback-standard"
    : "active-accepted-standard",
});

const browser = Object.freeze({
  family: "chromium",
  binaryPath: "C:\\Program Files\\Chromium\\chrome.exe",
  binarySha256: hash("1"),
  enrollmentIdSha256: hash("2"),
  version: "140.0.7339.41",
});
const operatingSystem = Object.freeze({
  family: "windows",
  release: "11",
  architecture: "x64",
});
const policy = Object.freeze({
  applicationId: "abcdefghijklmnopabcdefghijklmnop",
  forceInstallPolicyName: "WebAppInstallForceList",
  forceInstallPolicyValueSha256: hash("3"),
  installUrl: "https://planner.example.test/app",
  shortcutArgumentsSha256: hash("4"),
  shortcutPathSha256: hash("5"),
});
const profiles = Object.freeze([
  Object.freeze({ profileId: "browser-tab", profilePathSha256: hash("6") }),
  Object.freeze({
    profileId: "installed-pwa",
    profilePathSha256: hash("7"),
  }),
]);
const controllerHashes = Object.freeze([hash("8"), hash("9"), hash("8")]);

const strictSignedReceipt = () => ({
  schemaVersion: 1,
  kind: "managed-device-signed-receipt/v1",
  payload: {
    authority,
    sourceSha,
    observedAt: "2026-08-09T00:00:00.000Z",
    deployment: deployment(),
    rollbackDeployment: deployment({ rollback: true }),
    host: {
      runnerGroup: "managed-foundation",
      runnerLabels: ["self-hosted", "windows", "managed-foundation"],
      operatingSystem: { ...operatingSystem, buildNumber: "10.0.26100" },
      browser: structuredClone(browser),
      policy: {
        applicationId: policy.applicationId,
        forceInstallPolicyName: policy.forceInstallPolicyName,
        forceInstallPolicyValueSha256: policy.forceInstallPolicyValueSha256,
        installUrl: policy.installUrl,
        observedPolicyResult: "OK",
      },
      appLaunch: {
        applicationId: policy.applicationId,
        argumentsSha256: policy.shortcutArgumentsSha256,
        shortcutPathSha256: policy.shortcutPathSha256,
      },
      profiles: profiles.map((profile, index) => ({
        ...profile,
        profileName: `foundation-profile-${index + 1}`,
        initialProcessId: 100 + index,
        reopenedProcessId: 200 + index,
      })),
    },
    evidence: {
      transitions: controllerHashes.map((scriptSourceSha256) => ({
        controller: { scriptSourceSha256 },
      })),
    },
  },
  signature: {
    algorithm: "ed25519",
    publicKeySpkiBase64: "fixture",
    signatureBase64: "fixture",
  },
});

const strictReviewedArtifact = ({
  runId = "100",
  runAttempt = "1",
  artifactReference = reference("d"),
  signedReceipt = strictSignedReceipt(),
} = {}) => ({
  reference: artifactReference,
  receipt: {
    kind: "reviewed-github-workflow-artifact/v1",
    repository,
    runId,
    runAttempt,
    sourceSha,
    workflowPath: MANAGED_DEVICE_STAGE_WORKFLOW_PATH,
    artifactName: PWA_STRICT_RECEIPT_ARTIFACT_NAME_TEMPLATE.replace(
      "{sourceSha}",
      sourceSha,
    ).replace("{runAttempt}", runAttempt),
    fileName: PWA_STRICT_RECEIPT_FILE_NAME,
    artifactFileMediaType: MANAGED_DEVICE_SIGNED_RECEIPT_MEDIA_TYPES[authority],
  },
  fileBytes: canonicalJsonBytes(signedReceipt),
});

const aggregateFixture = () => {
  const sourceBindings = [binding(), binding({ rollback: true }), binding()];
  const stages = sourceBindings.map((activeBinding, index) => ({
    payload: {
      collectorIdentity: {
        repository,
        runId: String(101 + index),
        runAttempt: index === 0 ? "2" : "1",
      },
      observedAt: `2026-08-09T00:${String(index * 10 + 1).padStart(2, "0")}:00.000Z`,
      releaseState: { activeBinding },
      observation: {
        runnerGroup: "managed-foundation",
        runnerLabels: ["self-hosted", "windows", "managed-foundation"],
        operatingSystem: structuredClone(operatingSystem),
        browser: structuredClone(browser),
        policy: structuredClone(policy),
        cycles: [
          {
            clients: profiles.map((profile) => ({ ...profile })),
          },
        ],
      },
    },
    result: {
      clients: profiles.map((profile) => ({
        profileId: profile.profileId,
        controllerSha256: controllerHashes[index],
      })),
    },
  }));
  const document = {
    schemaVersion: 1,
    kind: "managed-device-multistage-authority/v1",
    authority,
    sourceSha,
    deviceFingerprintSha256: hash("a"),
    releaseStateSequenceSha256: hash("b"),
    stages: stages.map((stage, index) => ({
      role: ["initial-forward", "rollback", "final-forward"][index],
      runId: stage.payload.collectorIdentity.runId,
      runAttempt: stage.payload.collectorIdentity.runAttempt,
      receiptSha256: hash(String(index + 1)),
      activation: { sequence: index + 1 },
      bindingId: stage.payload.releaseState.activeBinding.bindingId,
      sourceSha: stage.payload.releaseState.activeBinding.sourceSha,
    })),
    result: {
      clientKinds: ["browser-tab", "installed-pwa"],
      transitionCount: 3,
      finalSourceSha: sourceSha,
      databaseFingerprintSha256: null,
    },
  };
  return {
    document,
    sha256: sha256Bytes(canonicalJsonBytes(document)),
    stages,
  };
};

const putComposite = async ({
  strictRunId = "100",
  strictRunAttempt = "1",
  strictArtifactMutate = () => undefined,
  currentWorkflowRunId = "200",
} = {}) => {
  const fixture = await put({ currentWorkflowRunId });
  const strictArtifact = strictReviewedArtifact({
    runId: strictRunId,
    runAttempt: strictRunAttempt,
  });
  strictArtifactMutate(strictArtifact);
  const composite = await putPwaReviewedFormalClosureAuthority(
    {
      namespace,
      repository,
      sourceSha,
      stageSetReference: fixture.written.reference,
      strictReceiptArtifactReference: strictArtifact.reference,
      store: fixture.store,
      currentWorkflowRunId,
    },
    { readReviewedArtifact: async () => strictArtifact },
  );
  return {
    ...fixture,
    stageSet: fixture.written,
    written: composite,
    strictArtifact,
  };
};

const stageSetReadbackFixture = (fixture, aggregate = aggregateFixture()) => ({
  document: structuredClone(fixture.stageSet.document),
  sha256: fixture.stageSet.reference.sha256,
  aggregated: aggregate,
  reviewedStages: [],
  setReceipt: {
    reference: structuredClone(fixture.stageSet.reference),
    mediaType: MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE,
    committedAt: "2026-08-09T12:00:00.000Z",
  },
});

const readComposite = async (fixture, overrides = {}, dependencies = {}) => {
  const readStageSet =
    dependencies.readStageSet ?? (async () => stageSetReadbackFixture(fixture));
  const readReviewedArtifact =
    dependencies.readReviewedArtifact ?? (async () => fixture.strictArtifact);
  const assertStrictReceipt =
    dependencies.assertStrictReceipt ??
    ((receipt) => ({
      receipt,
      result: {
        clientKinds: ["browser-tab", "installed-pwa"],
        transitionCount: 3,
        finalBuildId: sourceSha,
      },
      sha256: sha256Bytes(canonicalJsonBytes(receipt)),
    }));
  const resolveDeployment =
    dependencies.resolveDeployment ??
    (() => ({
      projection: deployment(),
      rollbackProjection: deployment({ rollback: true }),
    }));
  return readPwaReviewedFormalClosureAuthority(
    {
      namespace,
      reference: fixture.written.reference,
      store: fixture.store,
      current: { head: { sequence: 9, eventHash: hash("a") } },
      expectedCollectorSourceSha: sourceSha,
      externalPolicy: {},
      approvalPolicy: { repository },
      dbContract: {},
      currentWorkflowRunId: "200",
      ...overrides,
    },
    {
      readStageSet,
      readReviewedArtifact,
      assertStrictReceipt,
      resolveDeployment,
    },
  );
};

test("stores a canonical closed set and derives order only from reviewed runs", async () => {
  const fixture = await put();
  assert.deepEqual(
    fixture.written.document.stages.map(({ runId }) => runId),
    ["101", "102", "103"],
  );
  assert.equal(
    fixture.objects.get(fixture.written.reference.sha256).mediaType,
    MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE,
  );
  const resolved = await read(fixture);
  assert.equal(resolved.aggregated.document.authority, authority);
  assert.deepEqual(
    resolved.reviewedStages.map(({ runId }) => runId),
    ["101", "102", "103"],
  );
});

test("rejects duplicate, current, future, and extra old run selectors", async (t) => {
  await t.test("duplicate", async () => {
    await assert.rejects(
      put({
        reviewedStages: [
          reviewedStage("101", "1", "a"),
          reviewedStage("101", "2", "b"),
          reviewedStage("103", "1", "c"),
        ],
      }),
      /three distinct prior runs/u,
    );
  });
  for (const [name, runId] of [
    ["current", "200"],
    ["future", "201"],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        put({
          reviewedStages: [
            reviewedStage("101", "1", "a"),
            reviewedStage("102", "1", "b"),
            reviewedStage(runId, "1", "c"),
          ],
        }),
        /current or future run/u,
      );
    });
  }
  await t.test("extra old valid run", async () => {
    await assert.rejects(
      put({
        reviewedStages: [reviewedStage("100", "1", "d"), ...stages()],
      }),
      /three distinct prior runs/u,
    );
  });
});

test("rejects tamper, cross-authority reuse, and reviewed selector substitution", async (t) => {
  await t.test("tamper", async () => {
    const fixture = await put();
    fixture.objects.get(fixture.written.reference.sha256).bytes = Buffer.from(
      "{}",
      "utf8",
    );
    await assert.rejects(read(fixture), /absent or differs/u);
  });
  await t.test("cross authority", async () => {
    const fixture = await put();
    await assert.rejects(
      read(fixture, { authority: "idb-device-compatibility" }),
      /identity differs/u,
    );
  });
  await t.test("selector substitution", async () => {
    const fixture = await put();
    await assert.rejects(
      read(
        fixture,
        {},
        {
          readReviewedArtifact: async () => ({
            receipt: { runId: "99", runAttempt: "1" },
            fileBytes: canonicalJsonBytes({ substituted: true }),
          }),
        },
      ),
      /selector was substituted/u,
    );
  });
});

test("stores and reads a canonical PWA reviewed formal closure from immutable predecessors", async () => {
  const fixture = await putComposite();
  assert.deepEqual(Object.keys(fixture.written.document).sort(), [
    "authority",
    "kind",
    "namespace",
    "repository",
    "schemaVersion",
    "sourceSha",
    "stageSetAuthority",
    "strictReceiptArtifactAuthority",
  ]);
  assert.equal(
    fixture.objects.get(fixture.written.reference.sha256).mediaType,
    PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE,
  );
  let strictValidation;
  const resolved = await readComposite(
    fixture,
    {},
    {
      assertStrictReceipt: (receipt, validation) => {
        strictValidation = validation;
        return {
          receipt,
          result: {
            clientKinds: ["browser-tab", "installed-pwa"],
            transitionCount: 3,
            finalBuildId: sourceSha,
          },
          sha256: sha256Bytes(canonicalJsonBytes(receipt)),
        };
      },
    },
  );
  assert.equal(strictValidation.expectedRunId, "100");
  assert.deepEqual(strictValidation.expectedDeployment, deployment());
  assert.equal(resolved.aggregated.document.authority, authority);
  assert.deepEqual(resolved.setReceipt.reference, fixture.written.reference);
  assert.deepEqual(resolved.formalClosure, {
    kind: PWA_REVIEWED_FORMAL_CLOSURE_KIND,
    authority,
    sourceSha,
    reference: fixture.written.reference,
    stageSetAuthority: fixture.stageSet.reference,
    strictReceiptArtifactAuthority: fixture.strictArtifact.reference,
    strictReceiptSha256: sha256Bytes(fixture.strictArtifact.fileBytes),
  });
});

test("binds four reviewed publisher inputs to the P1 formal phase resolver", async () => {
  const fixture = await putComposite();
  const reviewedInputReferences = [
    fixture.strictArtifact.reference,
    ...fixture.stageSet.document.stages.map(
      ({ reviewedArtifact }) => reviewedArtifact,
    ),
  ];
  assert.equal(reviewedInputReferences.length, 4);
  assert.equal(
    new Set(reviewedInputReferences.map(({ sha256 }) => sha256)).size,
    4,
  );
  assert.deepEqual(
    fixture.written.document.strictReceiptArtifactAuthority,
    reviewedInputReferences[0],
  );
  assert.deepEqual(
    fixture.written.document.stageSetAuthority,
    fixture.stageSet.reference,
  );

  const authorityReadback = await readComposite(fixture);
  const subject = { kind: "p1-reviewed-formal-closure-subject/v1" };
  const databaseContract = {
    indexedDb: { name: "fixture", version: 1, stores: {} },
  };
  const evidence = buildManagedDevicePhaseExitEvidence({
    authority,
    authorityReadback,
    collectorAuthority: fixture.written.reference,
    subject,
    sourceSha,
    databaseContract,
  });
  assert.deepEqual(
    evidence.value.collectorAuthority,
    fixture.written.reference,
  );
  assert.deepEqual(
    evidence.value.result,
    authorityReadback.aggregated.document,
  );

  assert.throws(
    () =>
      buildManagedDevicePhaseExitEvidence({
        authority,
        stageSetReadback: stageSetReadbackFixture(fixture),
        collectorAuthority: fixture.stageSet.reference,
        subject,
        sourceSha,
        databaseContract,
      }),
    /phase authority readback differs/u,
  );
});

test("rejects unknown, missing, and substituted PWA closure identities", async (t) => {
  const storeDocument = async (fixture, document) => {
    const bytes = canonicalJsonBytes(document);
    const receipt = await fixture.store.putEvidence({
      bytes,
      mediaType: PWA_REVIEWED_FORMAL_CLOSURE_MEDIA_TYPE,
    });
    return {
      ...fixture,
      written: {
        ...fixture.written,
        document,
        reference: { uri: receipt.uri, sha256: receipt.sha256 },
      },
    };
  };
  await t.test("unknown field", async () => {
    const fixture = await putComposite();
    const substituted = await storeDocument(fixture, {
      ...fixture.written.document,
      callerClaim: "accepted",
    });
    await assert.rejects(readComposite(substituted), /identity differs/u);
  });
  await t.test("missing field", async () => {
    const fixture = await putComposite();
    const document = structuredClone(fixture.written.document);
    delete document.strictReceiptArtifactAuthority;
    const substituted = await storeDocument(fixture, document);
    await assert.rejects(readComposite(substituted), /identity differs/u);
  });
  await t.test("strict authority substitution", async () => {
    const fixture = await putComposite();
    const substituted = await storeDocument(fixture, {
      ...fixture.written.document,
      strictReceiptArtifactAuthority: reference("e"),
    });
    await assert.rejects(
      readComposite(substituted),
      /strict PWA receipt artifact differs/u,
    );
  });
  await t.test("stage set readback substitution", async () => {
    const fixture = await putComposite();
    await assert.rejects(
      readComposite(
        fixture,
        {},
        {
          readStageSet: async () => {
            const readback = stageSetReadbackFixture(fixture);
            readback.document.sourceSha = rollbackSourceSha;
            return readback;
          },
        },
      ),
      /stage set readback differs/u,
    );
  });
});

test("rejects non-predecessor and non-distinct composite workflow runs", async (t) => {
  for (const [name, strictRunId] of [
    ["duplicates a stage", "101"],
    ["follows the stages", "104"],
    ["is the current run", "200"],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        putComposite({ strictRunId }),
        /strict predecessor and three distinct prior stage runs/u,
      );
    });
  }
  await t.test("changes after composite publication", async () => {
    const fixture = await putComposite();
    fixture.strictArtifact.receipt.runId = "101";
    await assert.rejects(
      readComposite(fixture),
      /strict predecessor and three distinct prior stage runs/u,
    );
  });
});

test("rejects strict reviewed artifact metadata and signed receipt failures", async (t) => {
  for (const [name, mutate] of [
    ["repository", (artifact) => (artifact.receipt.repository = "other/repo")],
    ["source", (artifact) => (artifact.receipt.sourceSha = rollbackSourceSha)],
    ["workflow", (artifact) => (artifact.receipt.workflowPath = "other.yml")],
    ["artifact", (artifact) => (artifact.receipt.artifactName = "other")],
    ["file", (artifact) => (artifact.receipt.fileName = "other.json")],
    [
      "media type",
      (artifact) =>
        (artifact.receipt.artifactFileMediaType = "application/json"),
    ],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        putComposite({ strictArtifactMutate: mutate }),
        /strict PWA receipt artifact differs/u,
      );
    });
  }
  await t.test("noncanonical signed receipt", async () => {
    const fixture = await putComposite();
    fixture.strictArtifact.fileBytes = Buffer.from('{"b":1,"a":2}', "utf8");
    await assert.rejects(readComposite(fixture), /not canonical/u);
  });
  await t.test("signature rejection", async () => {
    const fixture = await putComposite();
    await assert.rejects(
      readComposite(
        fixture,
        {},
        {
          assertStrictReceipt: () => {
            throw new Error("strict signature is invalid");
          },
        },
      ),
      /signature is invalid/u,
    );
  });
  await t.test("verification substitution", async () => {
    const fixture = await putComposite();
    await assert.rejects(
      readComposite(
        fixture,
        {},
        {
          assertStrictReceipt: (receipt) => ({
            receipt,
            result: {
              clientKinds: ["browser-tab", "installed-pwa"],
              transitionCount: 3,
              finalBuildId: sourceSha,
            },
            sha256: hash("f"),
          }),
        },
      ),
      /verification differs/u,
    );
  });
});

test("binds strict PWA evidence to stage source, device, deployment, controller, and time", async (t) => {
  const mutatedStageReadback = (fixture, mutate) => async () => {
    const aggregate = aggregateFixture();
    mutate(aggregate);
    return stageSetReadbackFixture(fixture, aggregate);
  };
  for (const [name, mutate, pattern] of [
    [
      "source",
      (aggregate) => (aggregate.document.sourceSha = rollbackSourceSha),
      /source authority differs/u,
    ],
    [
      "device",
      (aggregate) =>
        (aggregate.stages[1].payload.observation.browser.binarySha256 =
          hash("b")),
      /device binding differs/u,
    ],
    [
      "deployment",
      (aggregate) =>
        (aggregate.stages[1].payload.releaseState.activeBinding.bindingId =
          "substituted-binding"),
      /deployment predecessor differs/u,
    ],
    [
      "controller",
      (aggregate) =>
        (aggregate.stages[2].result.clients[1].controllerSha256 = hash("c")),
      /controller predecessor differs/u,
    ],
    [
      "result",
      (aggregate) => (aggregate.document.result.transitionCount = 2),
      /source result differs/u,
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = await putComposite();
      await assert.rejects(
        readComposite(
          fixture,
          {},
          {
            readStageSet: mutatedStageReadback(fixture, mutate),
          },
        ),
        pattern,
      );
    });
  }
  await t.test("observation predecessor", async () => {
    const fixture = await putComposite({
      strictArtifactMutate: (artifact) => {
        const receipt = JSON.parse(artifact.fileBytes.toString("utf8"));
        receipt.payload.observedAt = "2026-08-09T00:01:00.000Z";
        artifact.fileBytes = canonicalJsonBytes(receipt);
      },
    });
    await assert.rejects(readComposite(fixture), /not a predecessor/u);
  });
});
