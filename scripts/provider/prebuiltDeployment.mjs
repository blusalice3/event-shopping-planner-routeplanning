import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import yauzl from "yauzl";
import {
  assertArtifactManifest,
  assertManifestMatchesOutput,
  assertReleasePackageIndex,
  canonicalArtifactBytes,
} from "../lib/artifact-contract.mjs";
import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
  sha256Json,
} from "../lib/canonical-json.mjs";
import {
  contentAddressedObjectPath,
  parseContentAddressedUri,
  resolveContentAddressedObject,
} from "../lib/content-addressed-store.mjs";
import { assertSafeRelativePath } from "../lib/file-manifest.mjs";
import { verifyReleasePackage } from "../verify-release-artifact.mjs";
import { verifyDeterministicZip } from "../deterministic-zip.mjs";
import { providerConfigurationHash } from "./providerConfiguration.mjs";

export const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ROLE_VALUES = new Set(["standard", "containment"]);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_PROVIDER_DATE_AGE_MS = 5 * 60 * 1000;
const MAX_PROVIDER_DATE_FUTURE_SKEW_MS = 60 * 1000;
const REGULAR_FILE_TYPE = 0o100000;
const SYMLINK_TYPE = 0o120000;

const compareCanonical = (left, right) =>
  canonicalJsonBytes(left).equals(canonicalJsonBytes(right));

const assertRole = (role) => {
  if (!ROLE_VALUES.has(role)) {
    throw new Error("Release role must be standard or containment");
  }
  return role;
};

const assertIdempotencyKey = (value) => {
  if (typeof value !== "string" || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new Error("Deployment idempotency key is invalid");
  }
  return value;
};

const assertCanonicalObject = (bytes, value, label) => {
  if (!bytes.equals(canonicalArtifactBytes(value))) {
    throw new Error(`${label} is not canonical JSON`);
  }
};

const assertObjectSize = async ({
  packageRoot,
  reference,
  expectedKind,
  maximumBytes,
}) => {
  const parsed = parseContentAddressedUri(reference?.uri, expectedKind);
  if (parsed.sha256 !== reference?.sha256) {
    throw new Error(`${expectedKind} URI/hash binding differs`);
  }
  const objectPath = contentAddressedObjectPath(
    packageRoot,
    parsed.sha256,
    parsed.kind,
  );
  const metadata = await lstat(objectPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`${expectedKind} object size/type is forbidden`);
  }
  return objectPath;
};

const selectArtifactReference = (index, role) => {
  const candidates =
    index.packageKind === "source-hardened-pair"
      ? index.artifacts.filter((artifact) => artifact.releaseRole === role)
      : index.packageKind === "legacy-bootstrap-single" &&
          index.artifact.releaseRole === role
        ? [index.artifact]
        : [];
  if (candidates.length !== 1) {
    throw new Error(`Package has no unambiguous ${role} artifact`);
  }
  return candidates[0];
};

const readVerifiedIndexAgain = async ({
  packageRoot,
  verifiedIndex,
  verifiedHash,
}) => {
  const indexPath = path.join(packageRoot, "release-package-index.json");
  const metadata = await lstat(indexPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_INDEX_BYTES
  ) {
    throw new Error("Release package index size/type is forbidden");
  }
  const bytes = await readFile(indexPath);
  const index = parseJsonStrict(bytes.toString("utf8"), indexPath);
  assertCanonicalObject(bytes, index, "Release package index");
  assertReleasePackageIndex(index);
  if (
    sha256Bytes(bytes) !== verifiedHash ||
    !compareCanonical(index, verifiedIndex)
  ) {
    throw new Error(
      "Release package index changed after production verification",
    );
  }
  return { index, bytes };
};

const assertManifestBinding = ({
  manifest,
  reference,
  index,
  role,
  releasePolicy,
  providerPolicy,
  providerObservation,
  manifestValidator,
}) => {
  manifestValidator(manifest, releasePolicy);
  if (
    manifest.releaseRole !== role ||
    reference.releaseRole !== role ||
    manifest.variantId !== reference.variantId ||
    manifest.sourceSha !== index.sourceSha ||
    manifest.buildId !== index.buildId ||
    manifest.toolchainPolicyHash !== index.toolchainPolicyHash ||
    manifest.providerConfigurationHash !==
      providerConfigurationHash(providerObservation) ||
    manifest.providerPolicyHash !== sha256Json(providerPolicy) ||
    manifest.releasePolicyHash !== sha256Json(releasePolicy) ||
    !compareCanonical(
      manifest.requiredDbCompatibility,
      index.requiredDbCompatibility,
    )
  ) {
    throw new Error("Selected artifact manifest binding differs");
  }
  if (
    !Array.isArray(manifest.outputFiles) ||
    manifest.outputFiles.length < 1 ||
    manifest.outputFiles.length > 100_000
  ) {
    throw new Error("Selected artifact output inventory is invalid");
  }
  let expandedBytes = 0;
  for (const file of manifest.outputFiles) {
    assertSafeRelativePath(file.path);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !SHA256_PATTERN.test(file.sha256)
    ) {
      throw new Error(`Artifact output entry is invalid: ${file.path}`);
    }
    expandedBytes += file.size;
    if (
      !Number.isSafeInteger(expandedBytes) ||
      expandedBytes > MAX_EXPANDED_BYTES
    ) {
      throw new Error("Artifact expanded size exceeds deployment ceiling");
    }
  }
};

const isNonRegularZipEntry = (entry) => {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0o170000;
  return (
    fileType === SYMLINK_TYPE ||
    (fileType !== 0 && fileType !== REGULAR_FILE_TYPE)
  );
};

export const extractPrebuiltArchive = async ({
  archivePath,
  destination,
  expectedFiles,
}) => {
  const expected = new Map(expectedFiles.map((file) => [file.path, file]));
  const seen = new Set();
  const folded = new Set();
  const openZip = promisify(yauzl.open);
  const archive = await openZip(archivePath, {
    lazyEntries: true,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  let expandedBytes = 0;
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      archive.close();
      reject(error);
    };
    archive.once("error", fail);
    archive.once("end", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    archive.on("entry", (entry) => {
      void (async () => {
        try {
          assertSafeRelativePath(entry.fileName);
          if (entry.fileName.endsWith("/") || isNonRegularZipEntry(entry)) {
            throw new Error(`Non-regular ZIP entry: ${entry.fileName}`);
          }
          const collisionKey = entry.fileName
            .normalize("NFC")
            .toLocaleLowerCase("en-US");
          if (seen.has(entry.fileName) || folded.has(collisionKey)) {
            throw new Error(`ZIP path collision: ${entry.fileName}`);
          }
          const expectedFile = expected.get(entry.fileName);
          if (
            expectedFile === undefined ||
            entry.uncompressedSize !== expectedFile.size
          ) {
            throw new Error(
              `ZIP entry differs from manifest: ${entry.fileName}`,
            );
          }
          expandedBytes += entry.uncompressedSize;
          if (expandedBytes > MAX_EXPANDED_BYTES) {
            throw new Error("ZIP expanded size exceeds deployment ceiling");
          }
          seen.add(entry.fileName);
          folded.add(collisionKey);
          const target = path.join(destination, ...entry.fileName.split("/"));
          const relative = path.relative(destination, target);
          if (
            relative.startsWith(`..${path.sep}`) ||
            relative === ".." ||
            path.isAbsolute(relative)
          ) {
            throw new Error(`ZIP entry escapes output: ${entry.fileName}`);
          }
          await mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise((resolveStream, rejectStream) => {
            archive.openReadStream(entry, (error, value) => {
              if (error) rejectStream(error);
              else resolveStream(value);
            });
          });
          await pipeline(
            stream,
            createWriteStream(target, { flags: "wx", mode: 0o600 }),
          );
          const bytes = await readFile(target);
          if (
            bytes.length !== expectedFile.size ||
            sha256Bytes(bytes) !== expectedFile.sha256
          ) {
            throw new Error(`Extracted entry hash differs: ${entry.fileName}`);
          }
          archive.readEntry();
        } catch (error) {
          fail(error);
        }
      })();
    });
    archive.readEntry();
  });
  if (seen.size !== expected.size) {
    throw new Error("Extracted ZIP file set differs from manifest");
  }
};

const resolvePinnedVercelCli = async ({ root, toolchainPolicy }) => {
  const require = createRequire(path.join(root, "package.json"));
  const manifestPath = require.resolve("vercel/package.json");
  const manifest = parseJsonStrict(
    await readFile(manifestPath, "utf8"),
    manifestPath,
  );
  if (
    manifest.name !== "vercel" ||
    manifest.version !== toolchainPolicy.packages?.vercel ||
    typeof manifest.bin?.vercel !== "string"
  ) {
    throw new Error("Pinned local Vercel CLI identity differs");
  }
  const packageRoot = path.dirname(manifestPath);
  const cliPath = path.resolve(packageRoot, manifest.bin.vercel);
  const relative = path.relative(packageRoot, cliPath);
  const metadata = await lstat(cliPath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error("Pinned Vercel CLI path/type is invalid");
  }
  return { cliPath, version: manifest.version };
};

const defaultCommandRunner = ({
  executable,
  arguments: arguments_,
  cwd,
  environment,
}) =>
  spawnSync(executable, arguments_, {
    cwd,
    env: environment,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  });

const secretValues = (environment) =>
  Object.entries(environment)
    .filter(
      ([name, value]) =>
        typeof value === "string" &&
        value.length >= 8 &&
        /(?:TOKEN|SECRET|PASSWORD|PRIVATE|SERVICE_ROLE|DATABASE_URL|API_KEY)/i.test(
          name,
        ),
    )
    .map(([, value]) => value);

const assertNoSecret = (value, secrets, label) => {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  if (secrets.some((secret) => text.includes(secret))) {
    throw new Error(`${label} contains a secret value`);
  }
};

const parseSingleDeploymentUrl = (stdout) => {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    throw new Error("Vercel CLI output has an ambiguous deployment URL");
  }
  let parsed;
  try {
    parsed = new URL(lines[0]);
  } catch {
    throw new Error("Vercel CLI output is not an HTTPS deployment URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      parsed.hostname,
    )
  ) {
    throw new Error(
      "Vercel CLI deployment URL is not an immutable HTTPS origin",
    );
  }
  return `https://${parsed.hostname.toLowerCase()}`;
};

const readBoundedResponse = async (response) => {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > MAX_PROVIDER_RESPONSE_BYTES)
  ) {
    throw new Error("Provider response exceeds size ceiling");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Provider response size is invalid");
  }
  return bytes;
};

export const resolveAuthoritativeVercelDeployment = async ({
  deploymentUrl,
  expectedTeamId,
  token,
  fetchImpl = globalThis.fetch,
}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Provider fetch implementation is unavailable");
  }
  const hostname = new URL(deploymentUrl).hostname;
  const requestUrl = new URL(
    `/v13/deployments/${encodeURIComponent(hostname)}`,
    "https://api.vercel.com",
  );
  requestUrl.searchParams.set("teamId", expectedTeamId);
  const response = await fetchImpl(requestUrl, {
    method: "GET",
    redirect: "error",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const bytes = await readBoundedResponse(response);
  const date = response.headers.get("date");
  const etag = response.headers.get("etag");
  if (
    response.status !== 200 ||
    typeof date !== "string" ||
    !Number.isFinite(Date.parse(date)) ||
    typeof etag !== "string" ||
    etag.length < 1 ||
    etag.length > 512
  ) {
    throw new Error(
      "Authoritative provider response status/headers are invalid",
    );
  }
  const body = parseJsonStrict(bytes.toString("utf8"), requestUrl.href);
  return {
    request: {
      url: requestUrl.href,
      status: response.status,
      date,
      etag,
      responseSha256: sha256Bytes(bytes),
    },
    deployment: {
      id: body.id,
      url:
        typeof body.url === "string" && !body.url.startsWith("http")
          ? `https://${body.url}`
          : body.url,
      projectId: body.projectId,
      teamId: body.ownerId,
      target: body.target,
      readyState: body.readyState,
    },
  };
};

const assertProviderResolution = ({
  resolution,
  deploymentUrl,
  providerPolicy,
  nowMilliseconds,
}) => {
  const expectedRequest = new URL(
    `/v13/deployments/${encodeURIComponent(new URL(deploymentUrl).hostname)}`,
    "https://api.vercel.com",
  );
  expectedRequest.searchParams.set("teamId", providerPolicy.expectedTeamId);
  const { request, deployment } = resolution ?? {};
  assertExactKeys(
    request,
    ["url", "status", "date", "etag", "responseSha256"],
    "Authoritative provider request",
  );
  assertExactKeys(
    deployment,
    ["id", "url", "projectId", "teamId", "target", "readyState"],
    "Authoritative provider deployment",
  );
  if (
    request?.url !== expectedRequest.href ||
    request.status !== 200 ||
    typeof request.date !== "string" ||
    !Number.isFinite(Date.parse(request.date)) ||
    typeof request.etag !== "string" ||
    request.etag.length < 1 ||
    !SHA256_PATTERN.test(request.responseSha256)
  ) {
    throw new Error("Authoritative provider request evidence is invalid");
  }
  const responseMilliseconds = Date.parse(request.date);
  if (
    responseMilliseconds < nowMilliseconds - MAX_PROVIDER_DATE_AGE_MS ||
    responseMilliseconds > nowMilliseconds + MAX_PROVIDER_DATE_FUTURE_SKEW_MS
  ) {
    throw new Error("Authoritative provider response Date is stale or future");
  }
  if (
    typeof deployment?.id !== "string" ||
    deployment.id.length < 1 ||
    deployment.id.length > 255 ||
    deployment.url !== deploymentUrl ||
    deployment.projectId !== providerPolicy.expectedProjectId ||
    deployment.teamId !== providerPolicy.expectedTeamId ||
    deployment.target !== "production" ||
    deployment.readyState !== "READY"
  ) {
    throw new Error("Authoritative provider deployment binding differs");
  }
  return { request, deployment };
};

const assertExactKeys = (value, expected, label) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")
  ) {
    throw new Error(`${label} fields differ`);
  }
};

const readReplayReceipt = async ({
  receiptPath,
  expected,
  secrets,
  providerResolver,
  providerPolicy,
  token,
  nowMilliseconds,
}) => {
  let metadata;
  try {
    metadata = await lstat(receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Existing deployment receipt size/type is forbidden");
  }
  const bytes = await readFile(receiptPath);
  for (const secret of secrets) {
    if (bytes.includes(Buffer.from(secret, "utf8"))) {
      throw new Error("Existing deployment receipt contains a secret value");
    }
  }
  const receipt = parseJsonStrict(bytes.toString("utf8"), receiptPath);
  if (!bytes.equals(canonicalJsonBytes(receipt))) {
    throw new Error("Existing deployment receipt is not canonical JSON");
  }
  assertExactKeys(
    receipt,
    [
      "schemaVersion",
      "receiptKind",
      "idempotencyKey",
      "provider",
      "sourceSha",
      "variantId",
      "releaseRole",
      "packageIndexSha256",
      "manifest",
      "archive",
      "productionBinding",
      "deployment",
      "authoritativeRequest",
      "cli",
    ],
    "Existing deployment receipt",
  );
  assertExactKeys(receipt.manifest, ["uri", "sha256"], "Receipt manifest");
  assertExactKeys(
    receipt.archive,
    ["uri", "sha256", "size"],
    "Receipt archive",
  );
  assertExactKeys(
    receipt.productionBinding,
    [
      "verified",
      "providerConfigurationHash",
      "providerObservationSha256",
      "providerPolicySha256",
    ],
    "Receipt production binding",
  );
  assertExactKeys(
    receipt.deployment,
    ["id", "url", "projectId", "teamId", "target", "readyState"],
    "Receipt deployment",
  );
  assertExactKeys(
    receipt.authoritativeRequest,
    ["url", "status", "date", "etag", "responseSha256"],
    "Receipt authoritative request",
  );
  assertExactKeys(
    receipt.cli,
    ["package", "version", "operation"],
    "Receipt CLI",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.receiptKind !== "vercel-prebuilt-deployment-v1" ||
    receipt.provider !== "vercel" ||
    receipt.idempotencyKey !== expected.idempotencyKey ||
    receipt.sourceSha !== expected.sourceSha ||
    receipt.variantId !== expected.variantId ||
    receipt.releaseRole !== expected.releaseRole ||
    receipt.packageIndexSha256 !== expected.packageIndexSha256 ||
    receipt.manifest?.uri !== expected.manifest.uri ||
    receipt.manifest?.sha256 !== expected.manifest.sha256 ||
    receipt.archive?.uri !== expected.archive.uri ||
    receipt.archive?.sha256 !== expected.archive.sha256 ||
    receipt.archive?.size !== expected.archive.size ||
    receipt.productionBinding?.verified !== true ||
    receipt.productionBinding?.providerConfigurationHash !==
      expected.providerConfigurationHash ||
    !SHA256_PATTERN.test(
      receipt.productionBinding?.providerObservationSha256 ?? "",
    ) ||
    receipt.productionBinding?.providerPolicySha256 !==
      expected.providerPolicySha256 ||
    receipt.deployment?.projectId !== providerPolicy.expectedProjectId ||
    receipt.deployment?.teamId !== providerPolicy.expectedTeamId
  ) {
    throw new Error("Existing deployment receipt binding differs");
  }
  const resolution = await providerResolver({
    deploymentUrl: receipt.deployment.url,
    expectedTeamId: providerPolicy.expectedTeamId,
    token,
  });
  const authoritative = assertProviderResolution({
    resolution,
    deploymentUrl: receipt.deployment.url,
    providerPolicy,
    nowMilliseconds,
  });
  if (authoritative.deployment.id !== receipt.deployment.id) {
    throw new Error("Existing deployment receipt ID differs from provider");
  }
  return {
    receipt,
    receiptPath: path.resolve(receiptPath),
    receiptSha256: sha256Bytes(bytes),
    replayed: true,
    replayAuthoritativeRequest: authoritative.request,
  };
};

const atomicWriteCanonical = async (outputPath, value) => {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    await lstat(resolved);
    throw new Error("Deployment receipt output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const bytes = canonicalJsonBytes(value);
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, resolved);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { path: resolved, bytes };
};

export const deployVerifiedPrebuilt = async ({
  packageRoot,
  role,
  providerObservation,
  idempotencyKey,
  receiptPath,
  releasePolicy,
  toolchainPolicy,
  providerPolicy,
  dbContract,
  cspPolicy,
  root = repositoryRoot,
  environment = process.env,
  stagingParent = os.tmpdir(),
  productionVerifier = verifyReleasePackage,
  manifestValidator = assertArtifactManifest,
  commandRunner = defaultCommandRunner,
  providerResolver = resolveAuthoritativeVercelDeployment,
  nowMilliseconds = Date.now(),
}) => {
  const selectedRole = assertRole(role);
  assertIdempotencyKey(idempotencyKey);
  const resolvedPackageRoot = path.resolve(packageRoot);

  // This is deliberately the first I/O-capable operation: nothing is staged or
  // deployed until the complete package has passed production binding checks.
  const verified = await productionVerifier({
    packageRoot: resolvedPackageRoot,
    releasePolicy,
    toolchainPolicy,
    providerPolicy,
    providerObservation,
    dbContract,
    cspPolicy,
    requireProductionBindings: true,
    root,
    environment,
  });
  if (
    verified?.productionEligible !== true ||
    !SHA256_PATTERN.test(verified.packageIndexSha256)
  ) {
    throw new Error("Production binding verifier did not attest the package");
  }

  const { index } = await readVerifiedIndexAgain({
    packageRoot: resolvedPackageRoot,
    verifiedIndex: verified.index,
    verifiedHash: verified.packageIndexSha256,
  });
  const reference = selectArtifactReference(index, selectedRole);
  await Promise.all([
    assertObjectSize({
      packageRoot: resolvedPackageRoot,
      reference: reference.manifest,
      expectedKind: "artifact-manifest.json",
      maximumBytes: MAX_MANIFEST_BYTES,
    }),
    assertObjectSize({
      packageRoot: resolvedPackageRoot,
      reference: reference.archive,
      expectedKind: "artifact.zip",
      maximumBytes: MAX_ARCHIVE_BYTES,
    }),
  ]);
  const [manifestObject, archiveObject] = await Promise.all([
    resolveContentAddressedObject({
      packageRoot: resolvedPackageRoot,
      reference: reference.manifest,
      expectedKind: "artifact-manifest.json",
    }),
    resolveContentAddressedObject({
      packageRoot: resolvedPackageRoot,
      reference: reference.archive,
      expectedKind: "artifact.zip",
    }),
  ]);
  const manifest = parseJsonStrict(
    manifestObject.bytes.toString("utf8"),
    reference.manifest.uri,
  );
  assertCanonicalObject(manifestObject.bytes, manifest, "Artifact manifest");
  assertManifestBinding({
    manifest,
    reference,
    index,
    role: selectedRole,
    releasePolicy,
    providerPolicy,
    providerObservation,
    manifestValidator,
  });
  const zipVerification = await verifyDeterministicZip({
    archivePath: archiveObject.path,
    expectedFiles: manifest.outputFiles,
  });
  if (zipVerification.archiveSha256 !== reference.archive.sha256) {
    throw new Error("Archive hash changed after package verification");
  }

  if (
    providerPolicy.provider !== "vercel" ||
    providerPolicy.bindingStatus !== "configured" ||
    providerObservation?.providerProjectId !==
      providerPolicy.expectedProjectId ||
    providerObservation?.providerTeamId !== providerPolicy.expectedTeamId
  ) {
    throw new Error("Verified provider observation binding differs");
  }
  const token = environment.VERCEL_TOKEN;
  if (
    typeof token !== "string" ||
    token.length < 8 ||
    token.length > 4096 ||
    [...token].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    environment.VERCEL_PROJECT_ID !== providerPolicy.expectedProjectId ||
    environment.VERCEL_ORG_ID !== providerPolicy.expectedTeamId
  ) {
    throw new Error("Vercel deploy environment binding is invalid");
  }
  const secrets = secretValues(environment);
  const replay = await readReplayReceipt({
    receiptPath,
    expected: {
      idempotencyKey,
      sourceSha: index.sourceSha,
      variantId: reference.variantId,
      releaseRole: selectedRole,
      packageIndexSha256: verified.packageIndexSha256,
      manifest: reference.manifest,
      archive: {
        ...reference.archive,
        size: archiveObject.bytes.length,
      },
      providerConfigurationHash: providerConfigurationHash(providerObservation),
      providerPolicySha256: sha256Json(providerPolicy),
    },
    secrets,
    providerResolver,
    providerPolicy,
    token,
    nowMilliseconds,
  });
  if (replay !== null) return replay;
  const { cliPath, version: cliVersion } = await resolvePinnedVercelCli({
    root,
    toolchainPolicy,
  });
  const deployRoot = await mkdtemp(
    path.join(
      path.resolve(stagingParent),
      `foundation-prebuilt-${reference.archive.sha256.slice(0, 12)}-`,
    ),
  );
  const outputRoot = path.join(deployRoot, ".vercel", "output");
  try {
    await mkdir(outputRoot, { recursive: true });
    await extractPrebuiltArchive({
      archivePath: archiveObject.path,
      destination: outputRoot,
      expectedFiles: manifest.outputFiles,
    });
    await assertManifestMatchesOutput(outputRoot, manifest);
    const arguments_ = [
      cliPath,
      "deploy",
      "--prebuilt",
      "--prod",
      "--skip-domain",
      "--yes",
      "--cwd",
      deployRoot,
    ];
    for (const argument of arguments_) {
      assertNoSecret(argument, secrets, "Vercel CLI arguments");
    }
    const result = await commandRunner({
      executable: process.execPath,
      arguments: arguments_,
      cwd: deployRoot,
      environment,
    });
    if (result?.error !== undefined) throw result.error;
    assertNoSecret(result?.stdout ?? "", secrets, "Vercel CLI stdout");
    assertNoSecret(result?.stderr ?? "", secrets, "Vercel CLI stderr");
    if (result?.status !== 0) {
      throw new Error(
        `Pinned Vercel prebuilt deploy failed with status ${String(result?.status)}`,
      );
    }
    const deploymentUrl = parseSingleDeploymentUrl(result.stdout);
    const resolution = await providerResolver({
      deploymentUrl,
      expectedTeamId: providerPolicy.expectedTeamId,
      token,
    });
    const authoritative = assertProviderResolution({
      resolution,
      deploymentUrl,
      providerPolicy,
      nowMilliseconds,
    });
    const receipt = {
      schemaVersion: 1,
      receiptKind: "vercel-prebuilt-deployment-v1",
      idempotencyKey,
      provider: "vercel",
      sourceSha: index.sourceSha,
      variantId: reference.variantId,
      releaseRole: selectedRole,
      packageIndexSha256: verified.packageIndexSha256,
      manifest: reference.manifest,
      archive: {
        ...reference.archive,
        size: archiveObject.bytes.length,
      },
      productionBinding: {
        verified: true,
        providerConfigurationHash:
          providerConfigurationHash(providerObservation),
        providerObservationSha256: sha256Json(providerObservation),
        providerPolicySha256: sha256Json(providerPolicy),
      },
      deployment: authoritative.deployment,
      authoritativeRequest: authoritative.request,
      cli: {
        package: "vercel",
        version: cliVersion,
        operation: "deploy-prebuilt-prod-skip-domain",
      },
    };
    const receiptBytes = canonicalJsonBytes(receipt);
    for (const secret of secrets) {
      if (receiptBytes.includes(Buffer.from(secret, "utf8"))) {
        throw new Error("Deployment receipt contains a secret value");
      }
    }
    const written = await atomicWriteCanonical(receiptPath, receipt);
    return {
      receipt,
      receiptPath: written.path,
      receiptSha256: sha256Bytes(written.bytes),
    };
  } finally {
    await rm(deployRoot, { recursive: true, force: true });
  }
};
