import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import yazl from "yazl";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE,
  REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
  collectReviewedWorkflowArtifactAuthority,
  readBoundReviewedWorkflowArtifactAuthority,
  readReviewedWorkflowArtifactAuthority,
} from "./reviewedWorkflowArtifactAuthority.mjs";

const namespace = "artifact-authority-test";
const repository = "foundation/example";
const sourceSha = "a".repeat(40);
const runId = "20001";
const runAttempt = "1";
const workflowPath = ".github/workflows/quality.yml";
const artifactId = "40001";
const artifactName = `foundation-phase-exit-quality-${sourceSha}-${runAttempt}`;
const fileName = "quality-run-source.json";
const fileMediaType =
  "application/vnd.event-shopping-planner.phase-exit-quality-run-source+json;version=1";

const createZip = async (entries) => {
  const zip = new yazl.ZipFile();
  const chunks = [];
  zip.outputStream.on("data", (chunk) => chunks.push(chunk));
  for (const [name, bytes] of entries) {
    zip.addBuffer(Buffer.from(bytes), name);
  }
  zip.end();
  await once(zip.outputStream, "end");
  return Buffer.concat(chunks);
};

const makeStore = () => {
  const objects = new Map();
  return {
    namespace,
    objects,
    async putEvidence({ bytes, mediaType }) {
      const input = Buffer.from(bytes);
      const sha256 = sha256Bytes(input);
      const committedAt = "2026-08-09T00:00:00.000Z";
      const replayed = objects.has(sha256);
      objects.set(sha256, { bytes: input, mediaType, committedAt });
      return {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
        mediaType,
        byteLength: input.length,
        committedAt,
        replayed,
      };
    },
    async readEvidence({ sha256 }) {
      const stored = objects.get(sha256);
      return stored === undefined
        ? null
        : { ...stored, bytes: Buffer.from(stored.bytes) };
    },
  };
};

const runResponse = () => ({
  id: Number(runId),
  run_attempt: Number(runAttempt),
  event: "push",
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  head_sha: sourceSha,
  path: workflowPath,
  repository: { full_name: repository },
});

const fixture = async ({
  digest = null,
  artifacts = null,
  archiveEntries = null,
} = {}) => {
  const store = makeStore();
  const fileBytes = canonicalJsonBytes({
    schemaVersion: 1,
    kind: "phase-exit-quality-run-source/v1",
  });
  const archiveBytes = await createZip(
    archiveEntries ?? [[fileName, fileBytes]],
  );
  const artifact = {
    id: Number(artifactId),
    name: artifactName,
    expired: false,
    size_in_bytes: archiveBytes.length,
    digest: digest ?? `sha256:${sha256Bytes(archiveBytes)}`,
    archive_download_url:
      `https://api.github.com/repos/${repository}/actions/artifacts/` +
      `${artifactId}/zip`,
    workflow_run: { id: Number(runId), head_sha: sourceSha },
  };
  const metadata = {
    total_count: artifacts?.length ?? 1,
    artifacts: artifacts ?? [artifact],
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith(`/actions/runs/${runId}`)) {
      return new Response(JSON.stringify(runResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes(`/actions/runs/${runId}/artifacts?`)) {
      return new Response(JSON.stringify(metadata), {
        status: 200,
        headers: { "content-type": "application/vnd.github+json" },
      });
    }
    if (url.endsWith(`/actions/artifacts/${artifactId}/zip`)) {
      return new Response(archiveBytes, {
        status: 200,
        headers: { "content-type": "application/zip" },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const options = {
    fetchImpl,
    githubToken: "github-token-for-test",
    namespace,
    repository,
    expectedRunId: runId,
    expectedRunAttempt: runAttempt,
    expectedSourceSha: sourceSha,
    expectedWorkflowPath: workflowPath,
    expectedArtifactName: artifactName,
    expectedFileName: fileName,
    expectedFileMediaType: fileMediaType,
    store,
  };
  return { store, fileBytes, archiveBytes, requested, options };
};

test("collects and rereads the exact reviewed workflow artifact chain", async () => {
  const testFixture = await fixture();
  const collected = await collectReviewedWorkflowArtifactAuthority(
    testFixture.options,
  );
  assert.ok(collected.fileBytes.equals(testFixture.fileBytes));
  assert.equal(
    collected.receipt.artifactDigestSha256,
    sha256Bytes(testFixture.archiveBytes),
  );
  assert.equal(
    collected.receipt.artifactFile.sha256,
    sha256Bytes(testFixture.fileBytes),
  );
  assert.equal(testFixture.requested.length, 3);
  const reread = await readReviewedWorkflowArtifactAuthority({
    ...testFixture.options,
    reference: collected.reference,
  });
  assert.ok(reread.fileBytes.equals(testFixture.fileBytes));
  const bound = await readBoundReviewedWorkflowArtifactAuthority({
    namespace,
    repository,
    expectedSourceSha: sourceSha,
    expectedWorkflowPath: workflowPath,
    expectedArtifactNameTemplate: `foundation-phase-exit-quality-${sourceSha}-{runAttempt}`,
    expectedFileName: fileName,
    expectedFileMediaType: fileMediaType,
    reference: collected.reference,
    store: testFixture.store,
  });
  assert.ok(bound.fileBytes.equals(testFixture.fileBytes));
  await assert.rejects(
    readBoundReviewedWorkflowArtifactAuthority({
      namespace,
      repository,
      expectedSourceSha: sourceSha,
      expectedWorkflowPath: workflowPath,
      expectedArtifactNameTemplate: `foundation-phase-exit-quality-${sourceSha}-wrong-{runAttempt}`,
      expectedFileName: fileName,
      expectedFileMediaType: fileMediaType,
      reference: collected.reference,
      store: testFixture.store,
    }),
    /receipt binding differs/u,
  );
});

for (const [name, digest] of [
  ["wrong digest prefix", `SHA256:${"a".repeat(64)}`],
  ["non-hex digest", `sha256:${"z".repeat(64)}`],
  ["bare arbitrary hash", "a".repeat(64)],
]) {
  test(`rejects ${name}`, async () => {
    const testFixture = await fixture({ digest });
    await assert.rejects(
      collectReviewedWorkflowArtifactAuthority(testFixture.options),
      /metadata binding differs/u,
    );
  });
}

test("rejects a duplicate fixed artifact name", async () => {
  const base = await fixture();
  const archiveDigest = sha256Bytes(base.archiveBytes);
  const duplicate = [1, 2].map((ordinal) => ({
    id: Number(artifactId) + ordinal,
    name: artifactName,
    expired: false,
    size_in_bytes: base.archiveBytes.length,
    digest: `sha256:${archiveDigest}`,
    archive_download_url:
      `https://api.github.com/repos/${repository}/actions/artifacts/` +
      `${Number(artifactId) + ordinal}/zip`,
    workflow_run: { id: Number(runId), head_sha: sourceSha },
  }));
  const testFixture = await fixture({ artifacts: duplicate });
  await assert.rejects(
    collectReviewedWorkflowArtifactAuthority(testFixture.options),
    /artifact set is not exact/u,
  );
});

test("rejects an archive with any additional entry", async () => {
  const testFixture = await fixture({
    archiveEntries: [
      [fileName, Buffer.from("{}")],
      ["extra.json", Buffer.from("{}")],
    ],
  });
  await assert.rejects(
    collectReviewedWorkflowArtifactAuthority(testFixture.options),
    /archive file set is not exact/u,
  );
});

test("rejects archive tamper on immutable reread", async () => {
  const testFixture = await fixture();
  const collected = await collectReviewedWorkflowArtifactAuthority(
    testFixture.options,
  );
  testFixture.store.objects.get(
    collected.receipt.artifactArchive.sha256,
  ).bytes = Buffer.from("tampered");
  await assert.rejects(
    readReviewedWorkflowArtifactAuthority({
      ...testFixture.options,
      reference: collected.reference,
    }),
    /immutable object is absent or differs/u,
  );
});

test("rejects an extra receipt key and generic receipt substitution", async () => {
  const testFixture = await fixture();
  const collected = await collectReviewedWorkflowArtifactAuthority(
    testFixture.options,
  );
  const extraBytes = canonicalJsonBytes({
    ...collected.receipt,
    callerApproved: true,
  });
  const extraReference = await testFixture.store.putEvidence({
    bytes: extraBytes,
    mediaType: REVIEWED_WORKFLOW_ARTIFACT_RECEIPT_MEDIA_TYPE,
  });
  await assert.rejects(
    readReviewedWorkflowArtifactAuthority({
      ...testFixture.options,
      reference: { uri: extraReference.uri, sha256: extraReference.sha256 },
    }),
    /receipt binding differs/u,
  );

  await assert.rejects(
    readReviewedWorkflowArtifactAuthority({
      ...testFixture.options,
      reference: collected.receipt.reviewedWorkflowRun,
    }),
    /immutable object is absent or differs/u,
  );
});

test("rejects an arbitrary absent 64-hex reference", async () => {
  const testFixture = await fixture();
  const sha256 = "f".repeat(64);
  await assert.rejects(
    readReviewedWorkflowArtifactAuthority({
      ...testFixture.options,
      reference: {
        uri: `release-state://${namespace}/evidence/${sha256}`,
        sha256,
      },
    }),
    /immutable object is absent or differs/u,
  );
});

test("archive objects use the closed ZIP media type", () => {
  assert.equal(GITHUB_WORKFLOW_ARTIFACT_ARCHIVE_MEDIA_TYPE, "application/zip");
});
