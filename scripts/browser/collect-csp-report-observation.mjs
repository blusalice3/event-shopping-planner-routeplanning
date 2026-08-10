import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  parseJsonStrict,
  sha256Bytes,
} from "../lib/canonical-json.mjs";
import {
  describeExactFile,
  readExactRegularFile,
} from "../lib/exact-file-read.mjs";
import { readCurrentReleaseState } from "../release-state/currentReleaseState.mjs";
import {
  assertCspReportObservation,
  assertCspReportObservationProtectedWorkflow,
  collectAndStoreCspReportObservation,
  collectAndStoreCspReportObservationOidcAuthority,
} from "./csp-report-observation.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SOURCE_SHA = /^[0-9a-f]{40}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAXIMUM_INPUT_BYTES = 1024 * 1024;
const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;

const comparablePath = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

const requireEnvironment = (environment, name) => {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CSP report environment is absent: ${name}`);
  }
  return value;
};

export const parseCspReportObservationArguments = (arguments_) => {
  if (!Array.isArray(arguments_) || arguments_.length !== 6) {
    throw new Error(
      "Usage: collect-csp-report-observation.mjs --namespace <namespace> --source-sha <sha> --output <new-file>",
    );
  }
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      !["--namespace", "--output", "--source-sha"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--")
    ) {
      throw new Error("CSP report arguments are invalid");
    }
    values.set(flag, value);
  }
  const namespace = values.get("--namespace");
  const sourceSha = values.get("--source-sha");
  if (!NAMESPACE.test(namespace ?? "") || !SOURCE_SHA.test(sourceSha ?? "")) {
    throw new Error("CSP report namespace or source SHA is invalid");
  }
  return { namespace, sourceSha, outputPath: values.get("--output") };
};

const exactFile = async (filePath, label) => {
  const resolved = path.resolve(filePath);
  const metadata = await lstat(resolved, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-link file`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw new Error(`${label} resolves through a path alias`);
  }
  return { path: resolved, ...describeExactFile(metadata) };
};

const readExactJson = async (filePath, label) => {
  const bytes = await readExactRegularFile({
    description: await exactFile(filePath, label),
    maximumBytes: MAXIMUM_INPUT_BYTES,
    label,
  });
  return parseJsonStrict(bytes.toString("utf8"), label);
};

const createReleaseStateStore = async (options) => {
  const { createPostgresReleaseStateStore } =
    await import("../release-state/postgresStore.mjs");
  return createPostgresReleaseStateStore(options);
};

const createDbClient = async ({ connectionString, ca, authority }) => {
  const parsed = new URL(connectionString);
  const role = decodeURIComponent(parsed.username);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (
    parsed.protocol !== "postgresql:" ||
    !authority.allowedHosts.includes(parsed.hostname.toLowerCase()) ||
    !authority.allowedDatabases.includes(database) ||
    !authority.allowedObserverRoles.includes(role) ||
    sha256Bytes(Buffer.from(ca, "utf8")) !== authority.productionCaSha256
  ) {
    throw new Error("CSP report DB observer connection differs from authority");
  }
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    ssl: { ca, rejectUnauthorized: true },
    application_name: "event-shopping-planner-csp-report-observer",
    connectionTimeoutMillis: authority.connectTimeoutMilliseconds,
    statement_timeout: authority.statementTimeoutMilliseconds,
  });
  await client.connect();
  return { client, role };
};

export const writeCspReportObservationOutput = async (
  outputPath,
  observation,
) => {
  assertCspReportObservation(observation);
  const resolved = path.resolve(outputPath);
  const bytes = canonicalJsonBytes(observation);
  if (bytes.length < 1 || bytes.length > MAXIMUM_OUTPUT_BYTES) {
    throw new Error("CSP report output is empty or oversized");
  }
  try {
    await lstat(resolved);
    throw new Error("CSP report output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const description = {
      path: resolved,
      ...describeExactFile(await handle.stat({ bigint: true })),
    };
    const readback = await readExactRegularFile({
      description,
      maximumBytes: bytes.length,
      label: "CSP report output",
      requireDescriptionTimestamps: false,
    });
    if (!readback.equals(bytes))
      throw new Error("CSP report output readback differs");
  } finally {
    await handle.close();
  }
  return { path: resolved, bytes };
};

export const runCspReportObservationCli = async (
  {
    argv = process.argv.slice(2),
    environment = process.env,
    cwd = process.cwd(),
    stdout = process.stdout,
  } = {},
  {
    loadPolicy = readExactJson,
    createStore = createReleaseStateStore,
    createObserver = createDbClient,
    readState = readCurrentReleaseState,
    assertProtected = assertCspReportObservationProtectedWorkflow,
    collectOidc = collectAndStoreCspReportObservationOidcAuthority,
    collect = collectAndStoreCspReportObservation,
    writeOutput = writeCspReportObservationOutput,
  } = {},
) => {
  const parsed = parseCspReportObservationArguments(argv);
  const [approvalPolicy, storePolicy, cspPolicy, dbContract, providerPolicy] =
    await Promise.all([
      loadPolicy(
        path.join(root, "config", "approval-policy.json"),
        "CSP report approval policy",
      ),
      loadPolicy(
        path.join(root, "config", "release-state-store.json"),
        "CSP report store policy",
      ),
      loadPolicy(
        path.join(root, "config", "csp-policy.json"),
        "CSP report policy",
      ),
      loadPolicy(
        path.join(root, "config", "db-compatibility-contract.json"),
        "CSP report DB contract",
      ),
      loadPolicy(
        path.join(root, "config", "provider-policy.json"),
        "CSP report provider policy",
      ),
    ]);
  const workflow = await assertProtected({
    environment,
    approvalPolicy,
    namespace: parsed.namespace,
    sourceSha: parsed.sourceSha,
  });
  const store = await createStore({
    connectionString: requireEnvironment(
      environment,
      "RELEASE_STATE_DATABASE_URL",
    ),
    namespace: parsed.namespace,
    policy: storePolicy,
    ca: requireEnvironment(environment, "RELEASE_STATE_DATABASE_CA_PEM"),
  });
  let observer;
  try {
    const current = await readState({ store, requireInitialized: true });
    if (
      current.snapshot.currentDbCompatibility.fingerprint !==
      sha256Bytes(canonicalJsonBytes(dbContract))
    ) {
      throw new Error("CSP report DB contract differs from live authority");
    }
    const authority = dbContract.remote.observationAuthority;
    if (authority.bindingStatus !== "configured") {
      throw new Error("CSP report DB observation authority is not configured");
    }
    observer = await createObserver({
      connectionString: requireEnvironment(
        environment,
        authority.databaseUrlEnvironmentName,
      ),
      ca: requireEnvironment(environment, authority.databaseCaEnvironmentName),
      authority,
    });
    const oidc = await collectOidc({
      store,
      namespace: parsed.namespace,
      sourceSha: parsed.sourceSha,
      runId: workflow.runId,
      runAttempt: workflow.runAttempt,
      approvalPolicy,
      environment,
    });
    const observation = await collect(
      {
        current,
        store,
        namespace: parsed.namespace,
        sourceSha: parsed.sourceSha,
        oidcReceipt: oidc.reference,
        oidcAuthority: {
          approvalPolicy,
          runId: workflow.runId,
          runAttempt: workflow.runAttempt,
        },
        cspPolicy,
        providerPolicy,
        providerToken: requireEnvironment(environment, "VERCEL_TOKEN"),
        dbClient: observer.client,
        expectedObserverRole: observer.role,
      },
      {
        readState,
      },
    );
    await writeOutput(path.resolve(cwd, parsed.outputPath), observation);
    stdout.write(
      `PASS CSP report observation: ${observation.rawObservation.sha256}\n`,
    );
    return observation;
  } finally {
    await observer?.client.end();
    await store.close();
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await runCspReportObservationCli();
