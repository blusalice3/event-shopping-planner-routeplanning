import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { canonicalJsonBytes, sha256Bytes } from "../lib/canonical-json.mjs";
import {
  parseProductionAssignmentValidationArguments,
  resolveProductionAssignmentValidationPaths,
  runProductionAssignmentValidationCli,
  writeProductionAssignmentAuthorityCreateOnly,
  writeProductionAssignmentValidationPairCreateOnly,
} from "./produce-production-assignment-validation.mjs";

const namespace = "assignment-validation-cli-test";
const environment = {
  RELEASE_STATE_NAMESPACE: namespace,
  RELEASE_STATE_DATABASE_URL:
    "postgresql://role:secret@db.example.test/control?sslmode=verify-full",
  RELEASE_STATE_DATABASE_CA_PEM: "test-ca",
};
const baseArgv = [
  "assignment-validation",
  "--namespace",
  namespace,
  "--prepared-result",
  "prepared-result.json",
  "--promotion-receipt",
  "promotion-receipt.json",
  "--assignment-authority",
  "assignment-authority.json",
  "--assignment-validation",
  "assignment-validation.json",
  "--production-probe",
  "production-probe.json",
];

const createTemporaryDirectory = () =>
  mkdtemp(path.join(os.tmpdir(), "assignment-validation-cli-"));

const pathValues = ({
  preparedResult,
  promotionReceipt,
  assignmentValidation,
  productionProbe,
}) => ({
  "--prepared-result": preparedResult,
  "--promotion-receipt": promotionReceipt,
  "--assignment-validation": assignmentValidation,
  "--production-probe": productionProbe,
});

test("parses only the closed production assignment validation command", () => {
  assert.deepEqual(parseProductionAssignmentValidationArguments(baseArgv), {
    command: "assignment-validation",
    values: {
      "--namespace": namespace,
      "--prepared-result": "prepared-result.json",
      "--promotion-receipt": "promotion-receipt.json",
      "--assignment-authority": "assignment-authority.json",
      "--assignment-validation": "assignment-validation.json",
      "--production-probe": "production-probe.json",
    },
  });
  assert.deepEqual(
    parseProductionAssignmentValidationArguments([
      "assignment-authority",
      "--namespace",
      namespace,
      "--prepared-result",
      "prepared-result.json",
      "--promotion-receipt",
      "promotion-receipt.json",
      "--assignment-authority",
      "assignment-authority.json",
    ]),
    {
      command: "assignment-authority",
      values: {
        "--namespace": namespace,
        "--prepared-result": "prepared-result.json",
        "--promotion-receipt": "promotion-receipt.json",
        "--assignment-authority": "assignment-authority.json",
      },
    },
  );

  const unknownFlag = [...baseArgv];
  unknownFlag[unknownFlag.indexOf("--prepared-result")] = "--prepared-event";
  assert.throws(
    () => parseProductionAssignmentValidationArguments(unknownFlag),
    /Invalid or duplicate production assignment validation flag/,
  );

  const duplicateFlag = [...baseArgv];
  duplicateFlag[duplicateFlag.indexOf("--promotion-receipt")] =
    "--prepared-result";
  assert.throws(
    () => parseProductionAssignmentValidationArguments(duplicateFlag),
    /Invalid or duplicate production assignment validation flag/,
  );

  const callerAuthorityFlag = [...baseArgv];
  callerAuthorityFlag[callerAuthorityFlag.indexOf("--assignment-validation")] =
    "--target-deployment";
  assert.throws(
    () => parseProductionAssignmentValidationArguments(callerAuthorityFlag),
    /Invalid or duplicate production assignment validation flag/,
  );

  assert.throws(
    () =>
      parseProductionAssignmentValidationArguments([
        ...baseArgv,
        "--domains",
        "caller.example.test",
      ]),
    /Usage: produce-production-assignment-validation/,
  );
  assert.throws(
    () =>
      parseProductionAssignmentValidationArguments([
        "production-probe",
        ...baseArgv.slice(1),
      ]),
    /Invalid production assignment validation command/,
  );
});

test("runs against real inputs, fixed configuration, and a bound closing store", async () => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const preparedResultPath = path.join(temporaryRoot, "prepared-result.json");
    const promotionReceiptPath = path.join(
      temporaryRoot,
      "promotion-receipt.json",
    );
    const assignmentAuthorityPath = path.join(
      temporaryRoot,
      "assignment-authority.json",
    );
    const assignmentValidationPath = path.join(
      temporaryRoot,
      "assignment-validation.json",
    );
    const productionProbePath = path.join(
      temporaryRoot,
      "production-probe.json",
    );
    const preparedResultBytes = canonicalJsonBytes({
      kind: "prepared-result",
    });
    const promotionReceiptBytes = canonicalJsonBytes({
      kind: "promotion-receipt",
    });
    const assignmentAuthorityBytes = canonicalJsonBytes({
      evidenceKind: "production-assignment-authority/v1",
    });
    await Promise.all([
      writeFile(preparedResultPath, preparedResultBytes),
      writeFile(promotionReceiptPath, promotionReceiptBytes),
      writeFile(assignmentAuthorityPath, assignmentAuthorityBytes),
    ]);

    const providerPolicy = { policy: "provider" };
    const toolchainPolicy = { policy: "toolchain" };
    const storePolicy = {
      databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
      policy: "store",
    };
    const configurations = new Map([
      ["provider-policy.json", providerPolicy],
      ["toolchain-versions.json", toolchainPolicy],
      ["release-state-store.json", storePolicy],
    ]);
    const loadedConfigurations = [];
    const stdout = [];
    const writes = [];
    const store = {
      closeCalls: 0,
      async close() {
        this.closeCalls += 1;
      },
    };
    let receivedStoreOptions;
    let receivedProducerOptions;
    const assignmentValidationBytes = canonicalJsonBytes({
      evidenceKind: "assignment-validation",
    });
    const productionProbeBytes = canonicalJsonBytes({
      evidenceKind: "production-assignment-probe/v1",
    });
    const assignmentValidationSha256 = sha256Bytes(assignmentValidationBytes);
    const productionProbeSha256 = sha256Bytes(productionProbeBytes);

    const result = await runProductionAssignmentValidationCli(
      {
        argv: [
          "assignment-validation",
          "--namespace",
          namespace,
          "--prepared-result",
          preparedResultPath,
          "--promotion-receipt",
          promotionReceiptPath,
          "--assignment-authority",
          assignmentAuthorityPath,
          "--assignment-validation",
          assignmentValidationPath,
          "--production-probe",
          productionProbePath,
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
          return {
            assignmentValidationBytes,
            assignmentValidationSha256,
            productionProbeBytes,
            productionProbeSha256,
          };
        },
        writeOutputs: async (options) => {
          writes.push({
            ...options,
            assignmentValidationBytes: Buffer.from(
              options.assignmentValidationBytes,
            ),
            productionProbeBytes: Buffer.from(options.productionProbeBytes),
          });
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
        "preparedResultBytes",
        "promotionReceiptBytes",
        "assignmentAuthorityBytes",
        "namespace",
        "store",
        "providerPolicy",
        "toolchainPolicy",
        "environment",
      ].sort(),
    );
    assert.ok(
      receivedProducerOptions.preparedResultBytes.equals(preparedResultBytes),
    );
    assert.ok(
      receivedProducerOptions.promotionReceiptBytes.equals(
        promotionReceiptBytes,
      ),
    );
    assert.ok(
      receivedProducerOptions.assignmentAuthorityBytes.equals(
        assignmentAuthorityBytes,
      ),
    );
    assert.equal(receivedProducerOptions.namespace, namespace);
    assert.equal(receivedProducerOptions.store, store);
    assert.equal(receivedProducerOptions.providerPolicy, providerPolicy);
    assert.equal(receivedProducerOptions.toolchainPolicy, toolchainPolicy);
    assert.equal(receivedProducerOptions.environment, environment);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].assignmentValidationPath, assignmentValidationPath);
    assert.equal(writes[0].productionProbePath, productionProbePath);
    assert.ok(
      writes[0].assignmentValidationBytes.equals(assignmentValidationBytes),
    );
    assert.ok(writes[0].productionProbeBytes.equals(productionProbeBytes));
    assert.equal(store.closeCalls, 1);
    assert.equal(
      stdout.join(""),
      `PASS authoritative production assignment validation: ${assignmentValidationSha256}\n`,
    );
    assert.equal(result.assignmentValidationSha256, assignmentValidationSha256);
    assert.equal(result.productionProbeSha256, productionProbeSha256);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("writes the staged assignment authority create-only before route validation", async () => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const preparedResultPath = path.join(temporaryRoot, "prepared.json");
    const promotionReceiptPath = path.join(temporaryRoot, "promotion.json");
    const assignmentAuthorityPath = path.join(temporaryRoot, "authority.json");
    const preparedResultBytes = canonicalJsonBytes({ prepared: true });
    const promotionReceiptBytes = canonicalJsonBytes({ promoted: true });
    const assignmentAuthorityBytes = canonicalJsonBytes({
      evidenceKind: "production-assignment-authority/v1",
    });
    await Promise.all([
      writeFile(preparedResultPath, preparedResultBytes),
      writeFile(promotionReceiptPath, promotionReceiptBytes),
    ]);
    const storePolicy = {
      databaseUrlEnvironmentName: "RELEASE_STATE_DATABASE_URL",
    };
    const store = {
      closeCalls: 0,
      async close() {
        this.closeCalls += 1;
      },
    };
    let producerOptions;
    const stdout = [];
    const result = await runProductionAssignmentValidationCli(
      {
        argv: [
          "assignment-authority",
          "--namespace",
          namespace,
          "--prepared-result",
          preparedResultPath,
          "--promotion-receipt",
          promotionReceiptPath,
          "--assignment-authority",
          assignmentAuthorityPath,
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
        loadJson: async (filePath) =>
          path.basename(filePath) === "release-state-store.json"
            ? storePolicy
            : {},
        createStore: async () => store,
        authorityProducer: async (options) => {
          producerOptions = options;
          return {
            assignmentAuthorityBytes,
            assignmentAuthoritySha256: sha256Bytes(assignmentAuthorityBytes),
          };
        },
        writeAuthority: writeProductionAssignmentAuthorityCreateOnly,
      },
    );
    assert.ok(producerOptions.preparedResultBytes.equals(preparedResultBytes));
    assert.ok(
      producerOptions.promotionReceiptBytes.equals(promotionReceiptBytes),
    );
    assert.ok(
      (await readFile(assignmentAuthorityPath)).equals(
        assignmentAuthorityBytes,
      ),
    );
    assert.equal(store.closeCalls, 1);
    assert.equal(
      stdout.join(""),
      `PASS authoritative production assignment authority: ${sha256Bytes(assignmentAuthorityBytes)}\n`,
    );
    assert.equal(
      result.assignmentAuthoritySha256,
      sha256Bytes(assignmentAuthorityBytes),
    );
    await assert.rejects(
      writeProductionAssignmentAuthorityCreateOnly({
        assignmentAuthorityPath,
        assignmentAuthorityBytes,
      }),
      /already exists/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("writes both outputs create-only and never partially overwrites a pair", async () => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const assignmentValidationPath = path.join(
      temporaryRoot,
      "complete",
      "assignment-validation.json",
    );
    const productionProbePath = path.join(
      temporaryRoot,
      "complete",
      "production-probe.json",
    );
    const assignmentValidationBytes = canonicalJsonBytes({
      assignment: "first",
    });
    const productionProbeBytes = canonicalJsonBytes({ probe: "first" });
    await writeProductionAssignmentValidationPairCreateOnly({
      assignmentValidationPath,
      assignmentValidationBytes,
      productionProbePath,
      productionProbeBytes,
    });
    assert.ok(
      (await readFile(assignmentValidationPath)).equals(
        assignmentValidationBytes,
      ),
    );
    assert.ok(
      (await readFile(productionProbePath)).equals(productionProbeBytes),
    );

    await assert.rejects(
      writeProductionAssignmentValidationPairCreateOnly({
        assignmentValidationPath,
        assignmentValidationBytes: canonicalJsonBytes({
          assignment: "replacement",
        }),
        productionProbePath,
        productionProbeBytes: canonicalJsonBytes({ probe: "replacement" }),
      }),
      /already exists/,
    );
    assert.ok(
      (await readFile(assignmentValidationPath)).equals(
        assignmentValidationBytes,
      ),
    );
    assert.ok(
      (await readFile(productionProbePath)).equals(productionProbeBytes),
    );

    const partialAssignmentPath = path.join(
      temporaryRoot,
      "partial",
      "assignment-validation.json",
    );
    const partialProbePath = path.join(
      temporaryRoot,
      "partial",
      "production-probe.json",
    );
    const sentinel = Buffer.from("existing-production-probe", "utf8");
    await mkdir(path.dirname(partialProbePath), { recursive: true });
    await writeFile(partialProbePath, sentinel, { flag: "wx" });
    await assert.rejects(
      writeProductionAssignmentValidationPairCreateOnly({
        assignmentValidationPath: partialAssignmentPath,
        assignmentValidationBytes,
        productionProbePath: partialProbePath,
        productionProbeBytes,
      }),
      /Production probe output already exists/,
    );
    await assert.rejects(
      readFile(partialAssignmentPath),
      (error) => error?.code === "ENOENT",
    );
    assert.ok((await readFile(partialProbePath)).equals(sentinel));
    assert.equal(
      (await readdir(path.dirname(partialProbePath))).some((name) =>
        name.endsWith(".tmp"),
      ),
      false,
    );

    const interruptedAssignmentPath = path.join(
      temporaryRoot,
      "interrupted",
      "assignment-validation.json",
    );
    const interruptedProbePath = path.join(
      temporaryRoot,
      "interrupted",
      "production-probe.json",
    );
    let linkCalls = 0;
    await assert.rejects(
      writeProductionAssignmentValidationPairCreateOnly(
        {
          assignmentValidationPath: interruptedAssignmentPath,
          assignmentValidationBytes,
          productionProbePath: interruptedProbePath,
          productionProbeBytes,
        },
        {
          linkImpl: async (source, destination) => {
            linkCalls += 1;
            if (linkCalls === 1) {
              assert.equal(destination, interruptedProbePath);
              await link(source, destination);
              return;
            }
            assert.equal(destination, interruptedAssignmentPath);
            throw new Error("simulated commit interruption");
          },
        },
      ),
      /simulated commit interruption/,
    );
    assert.equal(linkCalls, 2);
    for (const outputPath of [
      interruptedAssignmentPath,
      interruptedProbePath,
    ]) {
      await assert.rejects(
        readFile(outputPath),
        (error) => error?.code === "ENOENT",
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("rejects hard links, path reuse, and realpath aliases", async (t) => {
  const temporaryRoot = await createTemporaryDirectory();
  try {
    const preparedResultPath = path.join(temporaryRoot, "prepared-result.json");
    const promotionReceiptPath = path.join(
      temporaryRoot,
      "promotion-receipt.json",
    );
    const assignmentValidationPath = path.join(
      temporaryRoot,
      "assignment-validation.json",
    );
    const productionProbePath = path.join(
      temporaryRoot,
      "production-probe.json",
    );
    await writeFile(preparedResultPath, canonicalJsonBytes({ prepared: true }));
    await link(preparedResultPath, promotionReceiptPath);

    await assert.rejects(
      resolveProductionAssignmentValidationPaths(
        pathValues({
          preparedResult: preparedResultPath,
          promotionReceipt: promotionReceiptPath,
          assignmentValidation: assignmentValidationPath,
          productionProbe: productionProbePath,
        }),
        temporaryRoot,
      ),
      /must be distinct files/,
    );

    await unlink(promotionReceiptPath);
    await writeFile(
      promotionReceiptPath,
      canonicalJsonBytes({ receipt: true }),
    );
    await assert.rejects(
      resolveProductionAssignmentValidationPaths(
        pathValues({
          preparedResult: preparedResultPath,
          promotionReceipt: promotionReceiptPath,
          assignmentValidation: preparedResultPath,
          productionProbe: productionProbePath,
        }),
        temporaryRoot,
      ),
      /input and output paths must be distinct/,
    );

    await link(preparedResultPath, assignmentValidationPath);
    await assert.rejects(
      resolveProductionAssignmentValidationPaths(
        pathValues({
          preparedResult: preparedResultPath,
          promotionReceipt: promotionReceiptPath,
          assignmentValidation: assignmentValidationPath,
          productionProbe: productionProbePath,
        }),
        temporaryRoot,
      ),
      /hard-linked input alias/,
    );
    await unlink(assignmentValidationPath);

    const actualOutputDirectory = path.join(temporaryRoot, "actual-output");
    const aliasedOutputDirectory = path.join(temporaryRoot, "aliased-output");
    await mkdir(path.join(actualOutputDirectory, "nested"), {
      recursive: true,
    });
    try {
      await symlink(
        actualOutputDirectory,
        aliasedOutputDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
      t.diagnostic(`symlink assertion skipped: ${error.code}`);
      return;
    }
    await assert.rejects(
      resolveProductionAssignmentValidationPaths(
        pathValues({
          preparedResult: preparedResultPath,
          promotionReceipt: promotionReceiptPath,
          assignmentValidation: path.join(
            aliasedOutputDirectory,
            "nested",
            "assignment-validation.json",
          ),
          productionProbe: productionProbePath,
        }),
        temporaryRoot,
      ),
      /resolves through a path alias/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
