import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseDeploymentBindingProducerArguments,
  resolveDeploymentBindingProducerPaths,
  runDeploymentBindingProducerCli,
  writeDeploymentBindingCreateOnly,
} from "./produce-deployment-binding.mjs";

const namespace = "deployment-binding-cli-test";
const environment = {
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://role:secret@db.example.test/control?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "test-ca",
};
const baseArgv = [
  "deployment-binding",
  "--namespace",
  namespace,
  "--package",
  "package",
  "--role",
  "standard",
  "--deployment-receipt",
  "deployment-receipt.json",
  "--provider-observation",
  "provider-observation.json",
  "--output",
  "deployment-binding.json",
];

const createTemporaryDirectory = () =>
  mkdtemp(path.join(os.tmpdir(), "deployment-binding-cli-"));

test("parses only the closed deployment binding flag set", () => {
  assert.deepEqual(parseDeploymentBindingProducerArguments(baseArgv), {
    "--namespace": namespace,
    "--package": "package",
    "--role": "standard",
    "--deployment-receipt": "deployment-receipt.json",
    "--provider-observation": "provider-observation.json",
    "--output": "deployment-binding.json",
  });

  const unknownFlag = [...baseArgv];
  unknownFlag[3] = "--release-package";
  assert.throws(
    () => parseDeploymentBindingProducerArguments(unknownFlag),
    /Invalid or duplicate deployment binding producer flag/,
  );

  const duplicateFlag = [...baseArgv];
  duplicateFlag[5] = "--namespace";
  assert.throws(
    () => parseDeploymentBindingProducerArguments(duplicateFlag),
    /Invalid or duplicate deployment binding producer flag/,
  );

  const callerAuthorityFlag = [...baseArgv];
  callerAuthorityFlag[9] = "--provider-assignments";
  assert.throws(
    () => parseDeploymentBindingProducerArguments(callerAuthorityFlag),
    /Invalid or duplicate deployment binding producer flag/,
  );

  assert.throws(
    () =>
      parseDeploymentBindingProducerArguments([
        ...baseArgv,
        "--previous-binding",
        "caller-binding.json",
      ]),
    /Usage: produce-deployment-binding/,
  );
});

test("runs with verified real inputs and passes only fixed authority to the producer", async () => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const packageRoot = path.join(temporaryRoot, "package");
    const receiptPath = path.join(temporaryRoot, "deployment-receipt.json");
    const observationPath = path.join(
      temporaryRoot,
      "provider-observation.json",
    );
    const outputPath = path.join(temporaryRoot, "deployment-binding.json");
    const deploymentReceiptBytes = canonicalJsonBytes({
      kind: "deployment-receipt",
    });
    const providerObservationBytes = canonicalJsonBytes({
      kind: "provider-observation",
    });
    await mkdir(packageRoot);
    await Promise.all([
      writeFile(receiptPath, deploymentReceiptBytes),
      writeFile(observationPath, providerObservationBytes),
    ]);

    const releasePolicy = { policy: "release" };
    const toolchainPolicy = { policy: "toolchain" };
    const providerPolicy = { policy: "provider" };
    const dbContract = { policy: "db" };
    const cspPolicy = { policy: "csp" };
    const storePolicy = {
      databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
      policy: "store",
    };
    const configurations = new Map([
      ["release-variants.json", releasePolicy],
      ["toolchain-versions.json", toolchainPolicy],
      ["provider-policy.json", providerPolicy],
      ["db-compatibility-contract.json", dbContract],
      ["csp-policy.json", cspPolicy],
      ["release-state-store.json", storePolicy],
    ]);
    const loadedConfigurations = [];
    const stdout = [];
    const written = [];
    const store = {
      closeCalls: 0,
      async close() {
        this.closeCalls += 1;
      },
    };
    let receivedProducerOptions;
    let receivedStoreOptions;
    const bindingBytes = canonicalJsonBytes({ schemaVersion: 1 });
    const bindingSha256 = sha256Bytes(bindingBytes);

    const result = await runDeploymentBindingProducerCli(
      {
        argv: [
          "deployment-binding",
          "--namespace",
          namespace,
          "--package",
          packageRoot,
          "--role",
          "containment",
          "--deployment-receipt",
          receiptPath,
          "--provider-observation",
          observationPath,
          "--output",
          outputPath,
        ],
        environment,
        cwd: temporaryRoot,
        stdout: {
          write(value) {
            stdout.push(value);
          },
        },
      },
      {
        loadJson: async (filePath) => {
          const name = path.basename(filePath);
          loadedConfigurations.push(name);
          assert.equal(configurations.has(name), true);
          return configurations.get(name);
        },
        createStore: async (options) => {
          receivedStoreOptions = options;
          return store;
        },
        producer: async (options) => {
          receivedProducerOptions = options;
          return { bindingBytes, bindingSha256 };
        },
        writeOutput: async (filePath, bytes) => {
          written.push({ filePath, bytes: Buffer.from(bytes) });
        },
      },
    );

    assert.deepEqual(
      [...loadedConfigurations].sort(),
      [...configurations.keys()].sort(),
    );
    assert.deepEqual(receivedStoreOptions, {
      connectionString: environment.RELEASE_STATE_DATABASE_URL,
      namespace,
      policy: storePolicy,
      ca: environment.RELEASE_STATE_DATABASE_CA_PEM,
    });
    assert.deepEqual(
      Object.keys(receivedProducerOptions).sort(),
      [
        "packageRoot",
        "role",
        "deploymentReceiptBytes",
        "providerObservationBytes",
        "namespace",
        "store",
        "releasePolicy",
        "toolchainPolicy",
        "providerPolicy",
        "dbContract",
        "cspPolicy",
        "environment",
      ].sort(),
    );
    assert.equal(receivedProducerOptions.packageRoot, packageRoot);
    assert.equal(receivedProducerOptions.role, "containment");
    assert.ok(
      receivedProducerOptions.deploymentReceiptBytes.equals(
        deploymentReceiptBytes,
      ),
    );
    assert.ok(
      receivedProducerOptions.providerObservationBytes.equals(
        providerObservationBytes,
      ),
    );
    assert.equal(receivedProducerOptions.namespace, namespace);
    assert.equal(receivedProducerOptions.store, store);
    assert.equal(receivedProducerOptions.releasePolicy, releasePolicy);
    assert.equal(receivedProducerOptions.toolchainPolicy, toolchainPolicy);
    assert.equal(receivedProducerOptions.providerPolicy, providerPolicy);
    assert.equal(receivedProducerOptions.dbContract, dbContract);
    assert.equal(receivedProducerOptions.cspPolicy, cspPolicy);
    assert.equal(receivedProducerOptions.environment, environment);
    assert.equal(written.length, 1);
    assert.equal(written[0].filePath, outputPath);
    assert.ok(written[0].bytes.equals(bindingBytes));
    assert.equal(store.closeCalls, 1);
    assert.equal(
      stdout.join(""),
      `PASS authoritative deployment binding: ${bindingSha256}\n`,
    );
    assert.equal(result.bindingSha256, bindingSha256);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("writes a deployment binding exactly once without replacing it", async () => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const outputPath = path.join(temporaryRoot, "nested", "binding.json");
    const firstBytes = canonicalJsonBytes({ binding: "first" });
    const replacementBytes = canonicalJsonBytes({ binding: "replacement" });

    await writeDeploymentBindingCreateOnly(outputPath, firstBytes);
    assert.ok((await readFile(outputPath)).equals(firstBytes));
    await assert.rejects(
      writeDeploymentBindingCreateOnly(outputPath, replacementBytes),
      (error) => error?.code === "EEXIST",
    );
    assert.ok((await readFile(outputPath)).equals(firstBytes));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects hard-linked input aliases and output paths inside the package", async () => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const packageRoot = path.join(temporaryRoot, "package");
    const receiptPath = path.join(temporaryRoot, "receipt.json");
    const observationPath = path.join(temporaryRoot, "observation.json");
    await mkdir(packageRoot);
    await writeFile(receiptPath, canonicalJsonBytes({ receipt: true }));
    await link(receiptPath, observationPath);

    await assert.rejects(
      resolveDeploymentBindingProducerPaths(
        {
          "--package": packageRoot,
          "--deployment-receipt": receiptPath,
          "--provider-observation": observationPath,
          "--output": path.join(temporaryRoot, "binding.json"),
        },
        temporaryRoot,
      ),
      /must be distinct files/,
    );

    await rm(observationPath);
    await writeFile(observationPath, canonicalJsonBytes({ observation: true }));
    await assert.rejects(
      resolveDeploymentBindingProducerPaths(
        {
          "--package": packageRoot,
          "--deployment-receipt": receiptPath,
          "--provider-observation": observationPath,
          "--output": path.join(packageRoot, "binding.json"),
        },
        temporaryRoot,
      ),
      /output must be outside the package/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
