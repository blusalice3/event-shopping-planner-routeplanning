import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const verifier = path.join(
  repositoryRoot,
  "scripts",
  "verify-direct-dependency-usage.mjs",
);

const writeJson = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");

const createFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dependency-usage-"));
  await Promise.all([
    mkdir(path.join(root, "config"), { recursive: true }),
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "node_modules", "foo"), { recursive: true }),
    mkdir(path.join(root, "node_modules", "tool"), { recursive: true }),
  ]);
  await Promise.all([
    writeJson(path.join(root, "package.json"), {
      scripts: { lint: "tool ." },
      dependencies: { foo: "1.0.0" },
      devDependencies: { tool: "2.0.0" },
    }),
    writeJson(path.join(root, "node_modules", "foo", "package.json"), {
      name: "foo",
      version: "1.0.0",
    }),
    writeJson(path.join(root, "node_modules", "tool", "package.json"), {
      name: "tool",
      version: "2.0.0",
      bin: { tool: "bin/tool.js" },
    }),
    writeFile(path.join(root, "src", "app.js"), 'import "foo";\n', "utf8"),
    writeJson(path.join(root, "config", "direct-dependency-usage.json"), {
      schemaVersion: 1,
      graphs: {
        productionRoots: ["src/app.js"],
        buildConfigRoots: [],
        testSetupRoots: [],
      },
      packages: {
        foo: {
          scope: "dependencies",
          evidence: [
            {
              kind: "module-import",
              graph: "production",
              file: "src/app.js",
              specifier: "foo",
            },
          ],
        },
        tool: {
          scope: "devDependencies",
          evidence: [{ kind: "cli", script: "lint", binary: "tool" }],
        },
      },
    }),
  ]);
  return root;
};

const runVerifier = (root) =>
  spawnSync(process.execPath, [verifier, "--root", root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

test("accepts reachable module and package-owned CLI evidence", async () => {
  const root = await createFixture();
  try {
    const result = runVerifier(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 known, 0 unknown, 0 unused/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a direct dependency has no policy entry", async () => {
  const root = await createFixture();
  try {
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.dependencies.bar = "1.0.0";
    await writeJson(packagePath, packageJson);
    const result = runVerifier(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown direct dependencies.*bar/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an import that exists only in an orphan file", async () => {
  const root = await createFixture();
  try {
    await writeFile(
      path.join(root, "src", "orphan.js"),
      'import "foo";\n',
      "utf8",
    );
    const policyPath = path.join(
      root,
      "config",
      "direct-dependency-usage.json",
    );
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.packages.foo.evidence[0].file = "src/orphan.js";
    await writeJson(policyPath, policy);
    const result = runVerifier(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /orphan\.js is not reachable in production/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a CLI claim when the package does not own that binary", async () => {
  const root = await createFixture();
  try {
    await writeJson(path.join(root, "node_modules", "tool", "package.json"), {
      name: "tool",
      version: "2.0.0",
      bin: { other: "bin/other.js" },
    });
    const result = runVerifier(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tool does not own CLI tool/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a direct dependency with empty evidence", async () => {
  const root = await createFixture();
  try {
    const policyPath = path.join(
      root,
      "config",
      "direct-dependency-usage.json",
    );
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    policy.packages.tool.evidence = [];
    await writeJson(policyPath, policy);
    const result = runVerifier(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence must not be empty/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
