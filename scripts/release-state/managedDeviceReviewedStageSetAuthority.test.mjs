import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { MANAGED_DEVICE_STAGE_RECEIPT_MEDIA_TYPE } from "../browser/managed-device-stage-authority.mjs";
import {
  MANAGED_DEVICE_REVIEWED_STAGE_SET_MEDIA_TYPE,
  MANAGED_DEVICE_STAGE_ARTIFACT_NAME_TEMPLATE,
  MANAGED_DEVICE_STAGE_FILE_NAME,
  MANAGED_DEVICE_STAGE_WORKFLOW_PATH,
  putManagedDeviceReviewedStageSetAuthority,
  readManagedDeviceReviewedStageSetAuthority,
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
