import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalJsonBytes, readJsonStrict } from "./lib/canonical-json.mjs";
import {
  assertSafeRelativePath,
  buildFileManifest,
} from "./lib/file-manifest.mjs";
import {
  createDeterministicZip,
  verifyDeterministicZip,
} from "./deterministic-zip.mjs";

const policy = await readJsonStrict(
  new URL("../config/artifact-archive-policy.json", import.meta.url),
);

test("creates byte-identical archives from different roots and mtimes", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-deterministic-zip-"),
  );
  try {
    const firstRoot = path.join(temporaryRoot, "first");
    const secondRoot = path.join(temporaryRoot, "second");
    await Promise.all([
      mkdir(path.join(firstRoot, "nested"), { recursive: true }),
      mkdir(path.join(secondRoot, "nested"), { recursive: true }),
    ]);
    for (const root of [firstRoot, secondRoot]) {
      await Promise.all([
        writeFile(path.join(root, "a.txt"), "alpha\n", "utf8"),
        writeFile(path.join(root, "nested", "日本語.txt"), "日本語\n", "utf8"),
      ]);
    }
    await utimes(
      path.join(firstRoot, "a.txt"),
      new Date("2020-01-01T01:02:03Z"),
      new Date("2020-01-01T01:02:03Z"),
    );
    await utimes(
      path.join(secondRoot, "a.txt"),
      new Date("2030-12-31T23:59:58Z"),
      new Date("2030-12-31T23:59:58Z"),
    );

    const firstArchive = path.join(temporaryRoot, "first.zip");
    const secondArchive = path.join(temporaryRoot, "second.zip");
    const [first, second] = await Promise.all([
      createDeterministicZip({
        sourceDirectory: firstRoot,
        outputPath: firstArchive,
        policy,
      }),
      createDeterministicZip({
        sourceDirectory: secondRoot,
        outputPath: secondArchive,
        policy,
      }),
    ]);

    assert.deepEqual(first.files, second.files);
    assert.equal(first.archiveSha256, second.archiveSha256);
    assert.deepEqual(
      await readFile(firstArchive),
      await readFile(secondArchive),
    );
    await verifyDeterministicZip({
      archivePath: firstArchive,
      expectedFiles: await buildFileManifest(firstRoot),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects traversal, absolute, Windows, and ambiguous paths", () => {
  for (const unsafe of [
    "../outside",
    "safe/../outside",
    "/absolute",
    "C:/absolute",
    "windows\\path",
    "./relative",
    "double//separator",
  ]) {
    assert.throws(() => assertSafeRelativePath(unsafe), /Unsafe package path/);
  }
  assert.equal(
    assertSafeRelativePath("nested/日本語.txt"),
    "nested/日本語.txt",
  );
});

test("rejects archive policy drift before reading build output", async () => {
  await assert.rejects(
    createDeterministicZip({
      sourceDirectory: "not-read",
      outputPath: "not-created.zip",
      policy: { ...policy, compressionLevel: 8 },
    }),
    /Unsupported deterministic ZIP policy compressionLevel/,
  );
});

test("CLI output is byte-identical across process timezones", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "foundation-deterministic-zip-timezone-"),
  );
  try {
    const sourceRoot = path.join(temporaryRoot, "source");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "timezone.txt"), "fixed\n", "utf8");
    const manifestPath = path.join(temporaryRoot, "manifest.json");
    await writeFile(
      manifestPath,
      canonicalJsonBytes({
        files: await buildFileManifest(sourceRoot),
      }),
    );
    const scriptPath = fileURLToPath(
      new URL("./deterministic-zip.mjs", import.meta.url),
    );
    const archives = [
      {
        outputPath: path.join(temporaryRoot, "utc.zip"),
        timezone: "UTC",
      },
      {
        outputPath: path.join(temporaryRoot, "tokyo.zip"),
        timezone: "Asia/Tokyo",
      },
    ];
    for (const archive of archives) {
      execFileSync(
        process.execPath,
        [
          scriptPath,
          "--source",
          sourceRoot,
          "--output",
          archive.outputPath,
          "--manifest",
          manifestPath,
        ],
        {
          env: { ...process.env, TZ: archive.timezone },
          stdio: "pipe",
        },
      );
    }
    assert.deepEqual(
      await readFile(archives[0].outputPath),
      await readFile(archives[1].outputPath),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
