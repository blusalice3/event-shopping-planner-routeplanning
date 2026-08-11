import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import { buildRawDistManifest } from "../lib/artifact-builder-core.mjs";

const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const preparedMaterializations = new WeakSet();

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const defaultMaterialize = async (options) => {
  const { materializeFoundationBootstrapArtifact } =
    await import("./foundation-bootstrap-recovery.mjs");
  return materializeFoundationBootstrapArtifact(options);
};

const removeTemporaryRoot = async ({ remove, workRoot }) => {
  await remove(workRoot, { recursive: true, force: true });
  try {
    await lstat(workRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Artifact drill bootstrap temporary root still exists");
};

const aggregate = (primary, cleanup, message) => {
  if (cleanup === null) return primary;
  return new AggregateError([primary, cleanup], message);
};

const validateMaterialization = async ({
  materialization,
  p0aPolicy,
  workRoot,
}) => {
  const expectedSourceSha = p0aPolicy?.bootstrapRecovery?.bootstrapSourceSha;
  const expectedRawDistManifestSha256 =
    p0aPolicy?.bootstrapRecovery?.rawDistManifestSha256;
  const receipt = materialization?.receipt;
  const rawDistManifest = materialization?.rawDistManifest;
  const rawDistRoot = path.resolve(materialization?.rawDistRoot ?? "");
  const expectedRoot = path.join(workRoot, "verified-output", "static");
  if (
    !SOURCE_SHA.test(expectedSourceSha ?? "") ||
    !SHA256.test(expectedRawDistManifestSha256 ?? "") ||
    receipt?.schemaVersion !== 1 ||
    receipt.kind !== "foundation-bootstrap-materialization-receipt/v1" ||
    receipt.sourceSha !== expectedSourceSha ||
    receipt.rawDistManifestSha256 !== expectedRawDistManifestSha256 ||
    sha256Bytes(canonicalJsonBytes(rawDistManifest)) !==
      expectedRawDistManifestSha256 ||
    comparablePath(rawDistRoot) !== comparablePath(expectedRoot)
  ) {
    throw new Error(
      "Artifact drill bootstrap materialization is not bound to P0A evidence",
    );
  }
  const metadata = await lstat(rawDistRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      "Artifact drill bootstrap raw dist is not a regular directory",
    );
  }
  if (
    comparablePath(path.resolve(await realpath(rawDistRoot))) !==
    comparablePath(rawDistRoot)
  ) {
    throw new Error(
      "Artifact drill bootstrap raw dist resolves through an alias",
    );
  }
  const rebuilt = await buildRawDistManifest(rawDistRoot);
  if (
    !canonicalJsonBytes(rebuilt).equals(canonicalJsonBytes(rawDistManifest)) ||
    rebuilt.files.some(({ path: filePath }) =>
      /^release-identity(?:\.|$)/u.test(filePath),
    )
  ) {
    throw new Error(
      "Artifact drill bootstrap raw dist differs from immutable P0A evidence",
    );
  }
  return rawDistRoot;
};

export const assertPreparedArtifactDrillBootstrapRawDist = (prepared) => {
  if (
    !preparedMaterializations.has(prepared) ||
    typeof prepared?.rawDistRoot !== "string" ||
    typeof prepared?.cleanup !== "function"
  ) {
    throw new Error(
      "Artifact drill bootstrap raw dist was not prepared from Release State",
    );
  }
  return prepared.rawDistRoot;
};

export const prepareArtifactDrillBootstrapRawDist = async (
  {
    store,
    namespace,
    p0aPolicy,
    providerPolicy,
    bootstrapSourceResolution,
    requiredRoutes,
    stagingParent = os.tmpdir(),
  },
  {
    makeTemporaryDirectory = mkdtemp,
    materialize = defaultMaterialize,
    remove = rm,
  } = {},
) => {
  const workRoot = await makeTemporaryDirectory(
    path.join(path.resolve(stagingParent), "foundation-artifact-bootstrap-"),
  );
  try {
    const materialization = await materialize({
      store,
      namespace,
      p0aPolicy,
      providerPolicy,
      bootstrapSourceResolution,
      requiredRoutes,
      workRoot,
    });
    const rawDistRoot = await validateMaterialization({
      materialization,
      p0aPolicy,
      workRoot,
    });
    let cleaned = false;
    const prepared = {
      rawDistRoot,
      receipt: Object.freeze(structuredClone(materialization.receipt)),
      async cleanup() {
        if (cleaned) {
          throw new Error(
            "Artifact drill bootstrap materialization cleanup replayed",
          );
        }
        cleaned = true;
        preparedMaterializations.delete(prepared);
        await removeTemporaryRoot({ remove, workRoot });
      },
    };
    preparedMaterializations.add(prepared);
    return Object.freeze(prepared);
  } catch (primary) {
    let cleanup = null;
    try {
      await removeTemporaryRoot({ remove, workRoot });
    } catch (error) {
      cleanup = error;
    }
    throw aggregate(
      primary,
      cleanup,
      "Artifact drill bootstrap materialization and cleanup failed",
    );
  }
};
