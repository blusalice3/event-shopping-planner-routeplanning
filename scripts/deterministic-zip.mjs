import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readJsonStrict, sha256Bytes } from "./lib/canonical-json.mjs";
import {
  assertFileManifestEqual,
  assertSafeRelativePath,
  buildFileManifest,
} from "./lib/file-manifest.mjs";

const fixedDosMtime = () => new Date(1980, 0, 1, 0, 0, 0, 0);
const FIXED_POLICY_MTIME = "1980-01-01T00:00:00.000Z";
const FIXED_DOS_DATE_FIELD = 33;
const FIXED_DOS_TIME_FIELD = 0;
const REGULAR_FILE_MODE = 0o100644;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTED_FLAG = 0x0001;
const DIRECTORY_MODE = 0o040000;
const SYMLINK_MODE = 0o120000;
const REGULAR_FILE_TYPE = 0o100000;
const DEFLATE_COMPRESSION_METHOD = 8;

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const assertArchivePolicy = (policy) => {
  const expected = {
    schemaVersion: 1,
    pathFormat: "posix-relative",
    entryOrder: "utf8-byte",
    directoryEntries: false,
    modifiedAt: FIXED_POLICY_MTIME,
    forceDosTimestamp: true,
    compressionLevel: 9,
    fileMode: "0644",
    utf8Flag: true,
    archiveComment: "",
    allowUnknownExtraFields: false,
    allowSymlinks: false,
    allowHardlinks: false,
    allowDeviceFiles: false,
    rejectTraversal: true,
    rejectAbsolutePaths: true,
    rejectDuplicatePaths: true,
    rejectCaseCollisions: true,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (policy?.[key] !== value) {
      throw new Error(`Unsupported deterministic ZIP policy ${key}`);
    }
  }
  return policy;
};

const loadZipLibraries = async () => {
  const [{ default: yazl }, { default: yauzl }] = await Promise.all([
    import("yazl"),
    import("yauzl"),
  ]);
  return { yazl, yauzl };
};

const waitForOutput = async (zipFile, outputPath) => {
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  await pipeline(zipFile.outputStream, output);
};

export const createDeterministicZip = async ({
  sourceDirectory,
  outputPath,
  policy,
}) => {
  assertArchivePolicy(policy);
  const { yazl } = await loadZipLibraries();
  const sourceRoot = path.resolve(sourceDirectory);
  const manifest = await buildFileManifest(sourceRoot);
  const zipFile = new yazl.ZipFile();
  for (const entry of manifest) {
    const bytes = await readFile(
      path.join(sourceRoot, ...entry.path.split("/")),
    );
    zipFile.addBuffer(bytes, entry.path, {
      mtime: fixedDosMtime(),
      mode: REGULAR_FILE_MODE,
      compress: true,
      compressionLevel: policy.compressionLevel,
      forceDosTimestamp: policy.forceDosTimestamp,
    });
  }
  zipFile.end({ forceZip64Format: false });
  await waitForOutput(zipFile, outputPath);
  const archiveBytes = await readFile(outputPath);
  return {
    files: manifest,
    archiveSha256: sha256Bytes(archiveBytes),
    archiveSize: archiveBytes.length,
  };
};

const readArchiveEntries = async (archivePath, policy) => {
  assertArchivePolicy(policy);
  const { yauzl } = await loadZipLibraries();
  const openZip = promisify(yauzl.open);
  const zip = await openZip(archivePath, {
    lazyEntries: true,
    decodeStrings: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  if (zip.comment !== policy.archiveComment) {
    zip.close();
    throw new Error("ZIP archive comment differs from policy");
  }
  const entries = [];
  let previousPath = null;
  await new Promise((resolve, reject) => {
    zip.once("error", reject);
    zip.once("end", resolve);
    zip.on("entry", (entry) => {
      try {
        assertSafeRelativePath(entry.fileName);
        if (entry.fileName.endsWith("/")) {
          throw new Error(`Directory entry is forbidden: ${entry.fileName}`);
        }
        if ((entry.generalPurposeBitFlag & ENCRYPTED_FLAG) !== 0) {
          throw new Error(`Encrypted entry is forbidden: ${entry.fileName}`);
        }
        if ((entry.generalPurposeBitFlag & UTF8_FLAG) === 0) {
          throw new Error(`UTF-8 flag is absent: ${entry.fileName}`);
        }
        if (
          (entry.generalPurposeBitFlag &
            ~(UTF8_FLAG | DATA_DESCRIPTOR_FLAG)) !==
          0
        ) {
          throw new Error(`Unknown ZIP flags: ${entry.fileName}`);
        }
        if (entry.compressionMethod !== DEFLATE_COMPRESSION_METHOD) {
          throw new Error(
            `Unexpected ZIP compression method: ${entry.fileName}`,
          );
        }
        if (
          entry.lastModFileDate !== FIXED_DOS_DATE_FIELD ||
          entry.lastModFileTime !== FIXED_DOS_TIME_FIELD
        ) {
          throw new Error(`ZIP mtime differs from policy: ${entry.fileName}`);
        }
        if (entry.versionMadeBy >>> 8 !== 3) {
          throw new Error(
            `ZIP entry is not Unix-mode encoded: ${entry.fileName}`,
          );
        }
        if (entry.fileComment !== "") {
          throw new Error(`ZIP file comment is forbidden: ${entry.fileName}`);
        }
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const fileType = unixMode & 0o170000;
        if (fileType === DIRECTORY_MODE || fileType === SYMLINK_MODE) {
          throw new Error(`Non-regular archive entry: ${entry.fileName}`);
        }
        if (fileType !== REGULAR_FILE_TYPE || unixMode !== REGULAR_FILE_MODE) {
          throw new Error(
            `ZIP file mode differs from policy: ${entry.fileName}`,
          );
        }
        for (const extraField of entry.extraFields ?? []) {
          throw new Error(
            `ZIP extra field ${extraField.id} is forbidden: ${entry.fileName}`,
          );
        }
        if (
          previousPath !== null &&
          compareUtf8(previousPath, entry.fileName) >= 0
        ) {
          throw new Error("ZIP entries are not in strict UTF-8 byte order");
        }
        previousPath = entry.fileName;
      } catch (error) {
        zip.close();
        reject(error);
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.once("error", reject);
        stream.once("end", () => {
          const bytes = Buffer.concat(chunks);
          entries.push({
            path: entry.fileName,
            sha256: sha256Bytes(bytes),
            size: bytes.length,
            compressedSize: entry.compressedSize,
            usesDataDescriptor:
              (entry.generalPurposeBitFlag & DATA_DESCRIPTOR_FLAG) !== 0,
          });
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
  return entries;
};

export const verifyDeterministicZip = async ({
  archivePath,
  expectedFiles,
  policy = null,
}) => {
  const effectivePolicy =
    policy ??
    (await readJsonStrict(
      new URL("../config/artifact-archive-policy.json", import.meta.url),
    ));
  const entries = await readArchiveEntries(archivePath, effectivePolicy);
  entries.sort((left, right) => compareUtf8(left.path, right.path));
  const normalized = entries.map(({ path: filePath, sha256, size }) => ({
    path: filePath,
    sha256,
    size,
  }));
  assertFileManifestEqual(normalized, expectedFiles, "archive");
  const folded = new Set();
  for (const entry of normalized) {
    const key = entry.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new Error(`Case collision: ${entry.path}`);
    folded.add(key);
  }
  return {
    archiveSha256: sha256Bytes(await readFile(archivePath)),
    files: normalized,
  };
};

const runCli = async () => {
  const argument = (name) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : (process.argv[index + 1] ?? null);
  };
  const sourceDirectory = argument("--source");
  const outputPath = argument("--output");
  const manifestPath = argument("--manifest");
  if (!sourceDirectory || !outputPath || !manifestPath) {
    throw new Error(
      "Usage: node scripts/deterministic-zip.mjs --source <dir> --output <zip> --manifest <json>",
    );
  }
  const policy = await readJsonStrict(
    new URL("../config/artifact-archive-policy.json", import.meta.url),
  );
  const expectedManifest = await readJsonStrict(path.resolve(manifestPath));
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-zip-verify-"),
  );
  try {
    const created = await createDeterministicZip({
      sourceDirectory,
      outputPath: path.resolve(outputPath),
      policy,
    });
    assertFileManifestEqual(
      created.files,
      expectedManifest.files,
      "source and manifest",
    );
    await verifyDeterministicZip({
      archivePath: path.resolve(outputPath),
      expectedFiles: expectedManifest.files,
    });
    console.log(
      `PASS deterministic ZIP: ${created.files.length} files; ${created.archiveSha256}.`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await runCli();
}
