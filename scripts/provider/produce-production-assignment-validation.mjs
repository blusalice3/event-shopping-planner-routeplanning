#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonStrict } from "../lib/canonical-json.mjs";
import { createPostgresReleaseStateStore } from "../release-state/postgresStore.mjs";
import { NAMESPACE_PATTERN } from "../release-state/releaseWorkflowValidation.mjs";
import {
  prepareProductionAssignmentAuthority,
  produceProductionAssignmentValidation,
} from "./productionAssignmentValidation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const MAX_PREPARED_RESULT_BYTES = 4 * 1024 * 1024;
const MAX_PROMOTION_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_ASSIGNMENT_AUTHORITY_BYTES = 64 * 1024;
const ASSIGNMENT_AUTHORITY_FLAGS = [
  "--assignment-authority",
  "--namespace",
  "--prepared-result",
  "--promotion-receipt",
];
const ASSIGNMENT_VALIDATION_FLAGS = [
  "--assignment-authority",
  "--assignment-validation",
  "--namespace",
  "--prepared-result",
  "--production-probe",
  "--promotion-receipt",
];
const COMMAND_FLAGS = new Map([
  ["assignment-authority", ASSIGNMENT_AUTHORITY_FLAGS],
  ["assignment-validation", ASSIGNMENT_VALIDATION_FLAGS],
]);

const comparablePath = (value) => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const fileIdentity = (metadata) => `${metadata.dev}:${metadata.ino}`;

export const parseProductionAssignmentValidationArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length < 1) {
    throw new Error(
      "Usage: produce-production-assignment-validation.mjs <assignment-authority|assignment-validation> [strict flags]",
    );
  }
  const [command, ...tokens] = argv;
  const flags = COMMAND_FLAGS.get(command);
  if (flags === undefined) {
    throw new Error(
      `Invalid production assignment validation command: ${String(command)}`,
    );
  }
  if (tokens.length !== flags.length * 2) {
    throw new Error(
      "Usage: produce-production-assignment-validation.mjs <assignment-authority|assignment-validation> [strict flags]",
    );
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (
      !flags.includes(flag) ||
      Object.hasOwn(values, flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Invalid or duplicate production assignment validation flag: ${String(flag)}`,
      );
    }
    values[flag] = value;
  }
  if (
    Object.keys(values).length !== flags.length ||
    !NAMESPACE_PATTERN.test(values["--namespace"])
  ) {
    throw new Error(
      "Production assignment validation arguments are incomplete or invalid",
    );
  }
  return { command, values };
};

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Required production assignment validation environment is absent: ${name}`,
    );
  }
  return value;
};

const assertUnaliasedPath = async (filePath, expectedType, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved);
  if (
    metadata.isSymbolicLink() ||
    (expectedType === "file" && !metadata.isFile()) ||
    (expectedType === "directory" && !metadata.isDirectory())
  ) {
    throw new Error(`${label} type or path alias is forbidden`);
  }
  const canonical = await realpath(resolved);
  if (comparablePath(canonical) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return {
    path: resolved,
    identity: fileIdentity(metadata),
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  };
};

const assertUnaliasedOutputAncestor = async (outputPath, label) => {
  let candidate = path.dirname(path.resolve(outputPath));
  while (true) {
    try {
      return await assertUnaliasedPath(candidate, "directory", label);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
};

const assertOutputAbsent = async ({
  outputPath,
  inputIdentities = new Set(),
  label,
}) => {
  const resolved = path.resolve(outputPath);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} path alias is forbidden`);
  }
  const canonical = await realpath(resolved);
  if (comparablePath(canonical) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  if (inputIdentities.has(fileIdentity(metadata))) {
    throw new Error(`${label} is a hard-linked input alias`);
  }
  throw new Error(`${label} already exists`);
};

const readBoundedInput = async ({
  description,
  maximumBytes,
  label,
  readFileImpl,
}) => {
  if (description.size < 1 || description.size > maximumBytes) {
    throw new Error(`${label} is empty or oversized`);
  }
  const bytes = await readFileImpl(description.path);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error(`${label} read did not return bytes`);
  }
  const input = Buffer.from(bytes);
  const after = await assertUnaliasedPath(description.path, "file", label);
  if (
    after.identity !== description.identity ||
    after.size !== description.size ||
    after.mtimeMs !== description.mtimeMs ||
    after.ctimeMs !== description.ctimeMs ||
    input.length !== description.size
  ) {
    throw new Error(`${label} changed while read`);
  }
  return input;
};

export const resolveProductionAssignmentValidationPaths = async (
  values,
  cwd,
  suppliedCommand = null,
) => {
  const command =
    suppliedCommand ??
    (Object.hasOwn(values, "--assignment-validation")
      ? "assignment-validation"
      : "assignment-authority");
  const paths = {
    preparedResult: path.resolve(cwd, values["--prepared-result"]),
    promotionReceipt: path.resolve(cwd, values["--promotion-receipt"]),
    ...(typeof values["--assignment-authority"] === "string"
      ? {
          assignmentAuthority: path.resolve(
            cwd,
            values["--assignment-authority"],
          ),
        }
      : {}),
    ...(command === "assignment-validation"
      ? {
          assignmentValidation: path.resolve(
            cwd,
            values["--assignment-validation"],
          ),
          productionProbe: path.resolve(cwd, values["--production-probe"]),
        }
      : {}),
  };
  const comparable = Object.values(paths).map(comparablePath);
  if (new Set(comparable).size !== comparable.length) {
    throw new Error(
      "Production assignment validation input and output paths must be distinct",
    );
  }
  const inputEntries = [
    [
      "preparedResult",
      await assertUnaliasedPath(
        paths.preparedResult,
        "file",
        "Prepared promotion result",
      ),
    ],
    [
      "promotionReceipt",
      await assertUnaliasedPath(
        paths.promotionReceipt,
        "file",
        "Prepared promotion receipt",
      ),
    ],
  ];
  if (
    command === "assignment-validation" &&
    paths.assignmentAuthority !== undefined
  ) {
    inputEntries.push([
      "assignmentAuthority",
      await assertUnaliasedPath(
        paths.assignmentAuthority,
        "file",
        "Production assignment authority",
      ),
    ]);
  }
  const inputIdentities = new Set(
    inputEntries.map(([, description]) => description.identity),
  );
  if (inputIdentities.size !== inputEntries.length) {
    throw new Error("Production assignment inputs must be distinct files");
  }
  const outputEntries =
    command === "assignment-authority"
      ? [
          [
            "assignmentAuthority",
            paths.assignmentAuthority,
            "Assignment authority output",
          ],
        ]
      : [
          [
            "assignmentValidation",
            paths.assignmentValidation,
            "Assignment validation output",
          ],
          ["productionProbe", paths.productionProbe, "Production probe output"],
        ];
  await Promise.all(
    outputEntries.map(([, outputPath, label]) =>
      assertUnaliasedOutputAncestor(outputPath, `${label} ancestor`),
    ),
  );
  await Promise.all(
    outputEntries.map(([, outputPath, label]) =>
      assertOutputAbsent({
        outputPath,
        inputIdentities,
        label,
      }),
    ),
  );
  return {
    ...Object.fromEntries(inputEntries),
    ...Object.fromEntries(
      outputEntries.map(([name, outputPath]) => [name, outputPath]),
    ),
  };
};

const createBoundStore = async ({
  environment,
  namespace,
  storePolicy,
  createStore,
}) => {
  if (
    storePolicy?.databaseUrlEnvironmentName !== "RELEASE_STATE_DATABASE_URL"
  ) {
    throw new Error("Release State database environment binding is invalid");
  }
  return createStore({
    connectionString: requireEnvironment(
      environment,
      storePolicy.databaseUrlEnvironmentName,
    ),
    namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
};

const normalizeOutputBytes = (value, label) => {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${label} bytes are invalid`);
  }
  const bytes = Buffer.from(value);
  if (bytes.length === 0) {
    throw new Error(`${label} bytes are empty`);
  }
  return bytes;
};

const createTemporaryOutput = async ({ outputPath, bytes }) => {
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const metadata = await lstat(temporaryPath);
    return {
      path: temporaryPath,
      identity: fileIdentity(metadata),
      size: metadata.size,
    };
  } catch (error) {
    await unlink(temporaryPath).catch((cleanupError) => {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    });
    throw error;
  }
};

const removeOwnedOutput = async (outputPath, identity) => {
  try {
    const metadata = await lstat(outputPath);
    if (!metadata.isSymbolicLink() && fileIdentity(metadata) === identity) {
      await unlink(outputPath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
};

const assertLinkedOutput = async ({
  outputPath,
  temporary,
  expectedBytes,
  label,
}) => {
  const metadata = await lstat(outputPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    fileIdentity(metadata) !== temporary.identity ||
    metadata.size !== temporary.size ||
    metadata.size !== expectedBytes.length
  ) {
    throw new Error(`${label} committed file identity differs`);
  }
  const actualBytes = await readFile(outputPath);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`${label} committed bytes differ`);
  }
};

export const writeProductionAssignmentAuthorityCreateOnly = async ({
  assignmentAuthorityPath,
  assignmentAuthorityBytes: suppliedAssignmentAuthorityBytes,
}) => {
  const outputPath = path.resolve(assignmentAuthorityPath);
  const bytes = normalizeOutputBytes(
    suppliedAssignmentAuthorityBytes,
    "Assignment authority output",
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await assertUnaliasedPath(
    path.dirname(outputPath),
    "directory",
    "Assignment authority output directory",
  );
  await assertOutputAbsent({
    outputPath,
    label: "Assignment authority output",
  });
  let temporary = null;
  let committed = false;
  try {
    temporary = await createTemporaryOutput({ outputPath, bytes });
    await assertOutputAbsent({
      outputPath,
      label: "Assignment authority output",
    });
    await link(temporary.path, outputPath);
    committed = true;
    await assertLinkedOutput({
      outputPath,
      temporary,
      expectedBytes: bytes,
      label: "Assignment authority output",
    });
  } catch (error) {
    if (committed && temporary !== null) {
      await removeOwnedOutput(outputPath, temporary.identity);
    }
    throw error;
  } finally {
    if (temporary !== null) {
      await unlink(temporary.path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }
};

export const writeProductionAssignmentValidationPairCreateOnly = async (
  {
    assignmentValidationPath,
    assignmentValidationBytes: suppliedAssignmentValidationBytes,
    productionProbePath,
    productionProbeBytes: suppliedProductionProbeBytes,
  },
  { linkImpl = link } = {},
) => {
  const assignmentPath = path.resolve(assignmentValidationPath);
  const probePath = path.resolve(productionProbePath);
  if (comparablePath(assignmentPath) === comparablePath(probePath)) {
    throw new Error(
      "Assignment validation and production probe outputs must be distinct",
    );
  }
  const assignmentValidationBytes = normalizeOutputBytes(
    suppliedAssignmentValidationBytes,
    "Assignment validation output",
  );
  const productionProbeBytes = normalizeOutputBytes(
    suppliedProductionProbeBytes,
    "Production probe output",
  );
  await Promise.all([
    mkdir(path.dirname(assignmentPath), { recursive: true }),
    mkdir(path.dirname(probePath), { recursive: true }),
  ]);
  await Promise.all([
    assertUnaliasedPath(
      path.dirname(assignmentPath),
      "directory",
      "Assignment validation output directory",
    ),
    assertUnaliasedPath(
      path.dirname(probePath),
      "directory",
      "Production probe output directory",
    ),
  ]);
  await Promise.all([
    assertOutputAbsent({
      outputPath: assignmentPath,
      label: "Assignment validation output",
    }),
    assertOutputAbsent({
      outputPath: probePath,
      label: "Production probe output",
    }),
  ]);

  const temporaries = [];
  const committed = [];
  try {
    const assignmentTemporary = await createTemporaryOutput({
      outputPath: assignmentPath,
      bytes: assignmentValidationBytes,
    });
    temporaries.push(assignmentTemporary);
    const probeTemporary = await createTemporaryOutput({
      outputPath: probePath,
      bytes: productionProbeBytes,
    });
    temporaries.push(probeTemporary);

    await Promise.all([
      assertOutputAbsent({
        outputPath: assignmentPath,
        label: "Assignment validation output",
      }),
      assertOutputAbsent({
        outputPath: probePath,
        label: "Production probe output",
      }),
    ]);

    await linkImpl(probeTemporary.path, probePath);
    committed.push({ path: probePath, identity: probeTemporary.identity });
    await linkImpl(assignmentTemporary.path, assignmentPath);
    committed.push({
      path: assignmentPath,
      identity: assignmentTemporary.identity,
    });

    await Promise.all([
      assertLinkedOutput({
        outputPath: assignmentPath,
        temporary: assignmentTemporary,
        expectedBytes: assignmentValidationBytes,
        label: "Assignment validation output",
      }),
      assertLinkedOutput({
        outputPath: probePath,
        temporary: probeTemporary,
        expectedBytes: productionProbeBytes,
        label: "Production probe output",
      }),
    ]);
  } catch (error) {
    for (const output of [...committed].reverse()) {
      await removeOwnedOutput(output.path, output.identity);
    }
    throw error;
  } finally {
    await Promise.all(
      temporaries.map((temporary) =>
        unlink(temporary.path).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        }),
      ),
    );
  }
};

export const runProductionAssignmentValidationCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadJson = readJsonStrict,
    readFileImpl = readFile,
    createStore = createPostgresReleaseStateStore,
    authorityProducer = prepareProductionAssignmentAuthority,
    producer = produceProductionAssignmentValidation,
    writeAuthority = writeProductionAssignmentAuthorityCreateOnly,
    writeOutputs = writeProductionAssignmentValidationPairCreateOnly,
  } = {},
) => {
  const { command, values } =
    parseProductionAssignmentValidationArguments(argv);
  const namespace = values["--namespace"];
  if (
    requireEnvironment(environment, "RELEASE_STATE_NAMESPACE") !== namespace
  ) {
    throw new Error(
      "Release State namespace differs from assignment validation environment",
    );
  }
  const paths = await resolveProductionAssignmentValidationPaths(
    values,
    cwd,
    command,
  );
  const [
    preparedResultBytes,
    promotionReceiptBytes,
    assignmentAuthorityBytes,
    providerPolicy,
    toolchainPolicy,
    storePolicy,
  ] = await Promise.all([
    readBoundedInput({
      description: paths.preparedResult,
      maximumBytes: MAX_PREPARED_RESULT_BYTES,
      label: "Prepared promotion result",
      readFileImpl,
    }),
    readBoundedInput({
      description: paths.promotionReceipt,
      maximumBytes: MAX_PROMOTION_RECEIPT_BYTES,
      label: "Prepared promotion receipt",
      readFileImpl,
    }),
    command === "assignment-validation"
      ? readBoundedInput({
          description: paths.assignmentAuthority,
          maximumBytes: MAX_ASSIGNMENT_AUTHORITY_BYTES,
          label: "Production assignment authority",
          readFileImpl,
        })
      : Promise.resolve(null),
    loadJson(path.join(root, "config", "provider-policy.json")),
    loadJson(path.join(root, "config", "toolchain-versions.json")),
    loadJson(path.join(root, "config", "release-state-store.json")),
  ]);
  const store = await createBoundStore({
    environment,
    namespace,
    storePolicy,
    createStore,
  });
  try {
    if (command === "assignment-authority") {
      const result = await authorityProducer({
        preparedResultBytes,
        promotionReceiptBytes,
        namespace,
        store,
        providerPolicy,
        toolchainPolicy,
        environment,
      });
      await writeAuthority({
        assignmentAuthorityPath: paths.assignmentAuthority,
        assignmentAuthorityBytes: result.assignmentAuthorityBytes,
      });
      stdout.write(
        `PASS authoritative production assignment authority: ${result.assignmentAuthoritySha256}\n`,
      );
      return result;
    }
    const result = await producer({
      preparedResultBytes,
      promotionReceiptBytes,
      assignmentAuthorityBytes,
      namespace,
      store,
      providerPolicy,
      toolchainPolicy,
      environment,
    });
    await writeOutputs({
      assignmentValidationPath: paths.assignmentValidation,
      assignmentValidationBytes: result.assignmentValidationBytes,
      productionProbePath: paths.productionProbe,
      productionProbeBytes: result.productionProbeBytes,
    });
    stdout.write(
      `PASS authoritative production assignment validation: ${result.assignmentValidationSha256}\n`,
    );
    return result;
  } finally {
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  await runProductionAssignmentValidationCli();
}
